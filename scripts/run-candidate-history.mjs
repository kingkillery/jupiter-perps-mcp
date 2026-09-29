import 'dotenv/config';
import {createHash,randomUUID} from 'node:crypto';
import {mkdir,readFile,rename,writeFile} from 'node:fs/promises';
import {RSI,EMA,ATR} from 'technicalindicators';
import {fetchKrakenCandles} from '../dist/services/candle-feed.js';
import {KronosService} from '../dist/services/kronos.js';
import {candidateDefinitions,rankCandidateState} from '../dist/services/candidate-ranking.js';

const signalController=new AbortController();
process.once('SIGINT',()=>signalController.abort());
const signal=signalController.signal;
const interval=900000,horizon=8,windowCount=6,stride=16;
const root=new URL('../.runtime/candidate-history/',import.meta.url);
const strategy=JSON.parse(await readFile(new URL('../strategy.json',import.meta.url),'utf8'));
const numeric=(values,period,fn)=>{
  const value=fn(values,period).at(-1);
  if(!Number.isFinite(value))throw new Error('Insufficient historical indicators');
  return value;
};
function lane(asset,scale,bars){
  const closes=bars.map(c=>c.close);
  const last=bars.at(-1);
  return {asset,interval:scale,source:'Kraken spot USD historical replay',last_completed_time:last.time,last_completed_close:last.close,
    change_8_bars_pct:(last.close/closes.at(-9)-1)*100,
    rsi_14:numeric(closes,14,(v,p)=>RSI.calculate({values:v,period:p})),
    ema_21:numeric(closes,21,(v,p)=>EMA.calculate({values:v,period:p})),
    atr_14:ATR.calculate({high:bars.map(c=>c.high),low:bars.map(c=>c.low),close:closes,period:14}).at(-1),
    recent_candles:bars.slice(-6),market:null};
}
function knownAt(bars,time,count,step){
  const end=bars.findLastIndex(c=>c.time+step<=time);
  if(end<count-1)throw new Error('Not enough aligned historical candles');
  const result=bars.slice(end-count+1,end+1);
  if(result.some((c,i)=>i&&c.time!==result[i-1].time+step))throw new Error('Historical candles have a gap');
  return result;
}

if(!process.env.OPENROUTER_API_KEY)throw new Error('Save the OpenRouter key on Wallet controls before running the replay');
console.log('Fetching completed Kraken spot candles for six historical decisions…');
const [sol,eth,btc,solHour]=await Promise.all([
  fetchKrakenCandles('SOL','15m',320,signal),fetchKrakenCandles('ETH','15m',320,signal),
  fetchKrakenCandles('BTC','15m',320,signal),fetchKrakenCandles('SOL','1h',128,signal)
]);
const origins=Array.from({length:windowCount},(_,i)=>sol.result.length-horizon-1-(windowCount-i-1)*stride);
const contexts=origins.map(index=>sol.result.slice(index-127,index+1));
if(contexts.some(c=>c.length!==128))throw new Error('Insufficient SOL history for replay');
const kronos=new KronosService();
console.log('Generating local Kronos forecasts from past-only candle windows…');
const forecasts=await kronos.forecastHistorical(contexts,signal);
const datasetHash=createHash('sha256').update(JSON.stringify({sol:sol.result,eth:eth.result,btc:btc.result,solHour:solHour.result})).digest('hex');
const rows=[];
for(let i=0;i<origins.length;i++){
  signal.throwIfAborted();
  const origin=origins[i],at=sol.result[origin].time+interval;
  const lanes=[
    lane('SOL','15m',sol.result.slice(origin-63,origin+1)),
    lane('SOL','1h',knownAt(solHour.result,at,64,3600000)),
    lane('ETH','15m',knownAt(eth.result,at,64,interval)),
    lane('BTC','15m',knownAt(btc.result,at,64,interval))
  ];
  const forecast=forecasts[i],endChange=(forecast.at(-1).close/sol.result[origin].close-1)*100;
  const state={mode:'historical_replay',time:at,as_of_rule:'Judge evidence as it stood at this timestamp. The timestamp is intentionally historical, not stale live data.',
    lanes,kronos:{last_close:sol.result[origin].close,end_change_pct:endChange,generated_at:at,method:'Past-only local Kronos forecast of eight 15-minute closes'},
    evaluation:null,plan:{long:strategy.long,short:strategy.short},
    candidates:candidateDefinitions.map(c=>({id:c.id,description:c.description})),
    warnings:['Historical Jupiter market liquidity and account state unavailable; this replay uses Kraken spot candles only.']};
  console.log(`Asking Jev for historical decision ${i+1}/${windowCount}…`);
  const decision=await rankCandidateState(state,signal);
  const future=sol.result.slice(origin+1,origin+1+horizon);
  if(future.length!==horizon||future[0].time!==at||future.at(-1).time!==at+(horizon-1)*interval)throw new Error('Incomplete future scoring window');
  const change=(future.at(-1).close/sol.result[origin].close-1)*100;
  const review=decision.id!=='none'&&decision.confidence>=0.5&&decision.evidence_consistent>=0.5;
  const selectedDirection=review&&decision.id==='sol_long'?'long':review&&decision.id==='sol_short'?'short':null;
  const directionMatched=selectedDirection==='long'?change>0:selectedDirection==='short'?change<0:null;
  const pastChange=(sol.result[origin].close/sol.result[origin-8].close-1)*100;
  rows.push({index:i+1,as_of:at,origin_close:sol.result[origin].close,forecast_end_change_pct:endChange,
    decision,review_routed:review,selected_direction:selectedDirection,future_close:future.at(-1).close,
    future_change_pct:change,direction_matched:directionMatched,
    momentum_baseline_direction_matched:pastChange===0?null:Math.sign(pastChange)===Math.sign(change),
    state,forecast,future_candles:future});
}
const solRows=rows.filter(r=>r.selected_direction),momentumRows=rows.filter(r=>r.momentum_baseline_direction_matched!==null);
const report={id:randomUUID(),created_at:Date.now(),source:'Kraken spot USD',dataset_hash:datasetHash,
  start_as_of:rows[0].as_of,end_as_of:rows.at(-1).as_of,windows:rows.length,horizon_candles:horizon,
  step_minutes:15,spacing_candles:stride,model:'typesafe/jev-1.13',
  summary:{review_routed:rows.filter(r=>r.review_routed).length,sol_direction_calls:solRows.length,
    sol_direction_matched:solRows.filter(r=>r.direction_matched).length,
    momentum_direction_matched:momentumRows.filter(r=>r.momentum_baseline_direction_matched).length,
    momentum_direction_total:momentumRows.length,choices:Object.fromEntries(candidateDefinitions.map(c=>[c.id,rows.filter(r=>r.decision.id===c.id).length]).concat([['none',rows.filter(r=>r.decision.id==='none').length]]))},
  limitations:[
    'Six recent, non-overlapping 8-candle outcomes are a pilot, not a reliable win-rate estimate.',
    'Scoring uses SOL spot close-to-close direction. It is not a simulated fill, realized PnL or proof of the saved entry sequence.',
    'Historical Jupiter liquidity, fees, funding and wallet state were unavailable; all lanes use Kraken spot candles.',
    'The saved SOL plan was set before this replay run, but may have been chosen after some historical periods. This is not a pristine out-of-sample test.',
    'Pretrained model training overlap with the historical period cannot be excluded.',
    'No wallet calls, transaction preparation, signing, or submission occur.'
  ],rows,read_only:true,submitted:false};
await mkdir(root,{recursive:true});
const content=JSON.stringify(report,null,2),temp=new URL(report.id+'.tmp',root);
await writeFile(new URL(report.id+'.json',root),content,{flag:'wx'});
await writeFile(temp,content,{flag:'wx'});
await rename(temp,new URL('latest.json',root));
console.log(JSON.stringify({report:new URL('latest.json',root).pathname,dataset_hash:datasetHash.slice(0,12),summary:report.summary,limitations:report.limitations},null,2));
