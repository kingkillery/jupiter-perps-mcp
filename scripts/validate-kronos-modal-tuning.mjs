import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';

// Offline end-to-end archive audit. No Modal, market, model, or wallet calls.
const dataset=JSON.parse(await readFile(new URL('../.runtime/kronos-long-history/coinbase-sol-usd-15m-20260816-20260915.json',import.meta.url),'utf8'));
const report=JSON.parse(await readFile(new URL('../.runtime/kronos-modal-tuning/latest.json',import.meta.url),'utf8'));
const sha=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const check=(ok,message)=>{if(!ok)throw new Error(message);};
const near=(a,b)=>Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<=1e-8*Math.max(1,Math.abs(a),Math.abs(b));
const expected=[
  {candidate:'current_sampling',temperature:1,top_p:.9,sample_count:3},
  {candidate:'lower_temperature',temperature:.7,top_p:.9,sample_count:3},
  {candidate:'wider_nucleus',temperature:1,top_p:1,sample_count:3},
  {candidate:'more_paths',temperature:1,top_p:.9,sample_count:5}
];
const candles=dataset.candles,step=900000,horizon=8,lookback=64,perPhase=12;
check(sha(candles)===dataset.sha256&&report.source_sha256===dataset.sha256,'Source hash');
check(candles.length===2880&&report.source_start===dataset.start&&report.source_end===dataset.end,'Source span');
check(report.phase==='previously_inspected_development_windows'&&report.research_only===true,'Research boundary');
check(report.lookback===lookback&&report.horizon===horizon&&report.scores.length===expected.length,'Trial configuration');
check(report.rows.length===expected.length*perPhase&&report.gpu.includes('L4'),'GPU trial count');
const stride=Math.floor((candles.length-128-horizon)/(perPhase*2));
check(report.stride_candles===stride,'Window stride');
const seen=new Set();
for(const row of report.rows){
  check(expected.some(x=>x.candidate===row.candidate),'Unknown setting');
  check(Number.isInteger(row.window)&&row.window>=0&&row.window<perPhase,'Non-development window');
  const key=row.candidate+':'+row.window;
  check(!seen.has(key),'Duplicate model run '+key);seen.add(key);
  const origin=128+row.window*stride;
  check(row.origin_time===candles[origin-1].time&&near(row.origin_close,candles[origin-1].close),'Origin '+key);
  check(row.future_times.length===horizon&&row.actual.length===horizon&&row.predicted.length===horizon,'Horizon '+key);
  for(let i=0;i<horizon;i++){
    check(row.future_times[i]===row.origin_time+(i+1)*step&&row.future_times[i]===candles[origin+i].time,'Prediction time '+key);
    check(near(row.actual[i],candles[origin+i].close)&&Number.isFinite(row.predicted[i])&&row.predicted[i]>0,'Outcome or forecast '+key);
  }
}
for(const setting of expected){
  const score=report.scores.find(x=>x.candidate===setting.candidate);
  check(score&&score.temperature===setting.temperature&&score.top_p===setting.top_p&&score.sample_count===setting.sample_count,'Settings mismatch');
  const rows=report.rows.filter(x=>x.candidate===setting.candidate);
  check(rows.length===perPhase&&score.windows===perPhase&&score.points===perPhase*horizon,'Score denominator');
  for(const alpha of [0,.5,1]){
    const errors=rows.flatMap(row=>row.actual.map((actual,i)=>Math.abs(row.origin_close+alpha*(row.predicted[i]-row.origin_close)-actual)));
    const mae=errors.reduce((a,b)=>a+b,0)/errors.length;
    check(near(mae,score.mae_by_alpha[alpha.toFixed(1)]),'MAE mismatch '+setting.candidate+'/'+alpha);
  }
}
console.log(JSON.stringify({result:'PASS',source_sha256:dataset.sha256,gpu:report.gpu,settings:expected.length,
  development_windows:perPhase,forecasts:report.rows.length,scores:report.scores},null,2));
