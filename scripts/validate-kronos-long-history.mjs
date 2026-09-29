import {createHash} from 'node:crypto';
import {readFile} from 'node:fs/promises';

// Offline end-to-end archive validation; no model, provider, wallet, or server calls.
const base=new URL('../.runtime/kronos-long-history/',import.meta.url);
const dataset=JSON.parse(await readFile(new URL('coinbase-sol-usd-15m-20260816-20260915.json',base),'utf8'));
const report=JSON.parse(await readFile(new URL('latest.json',base),'utf8'));
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const near=(a,b)=>Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<=1e-9*Math.max(1,Math.abs(a),Math.abs(b));
const check=(ok,message)=>{if(!ok)throw new Error(message);};
const step=900000,horizon=8,perPhase=12,start=Date.parse('2026-08-16T00:00:00Z'),end=Date.parse('2026-09-15T00:00:00Z');
const profiles=['default-128','short-64'];
const candles=dataset.candles;
check(candles.length===(end-start)/step,'Dataset candle count');
check(hash(candles)===dataset.sha256&&report.source_sha256===dataset.sha256,'Dataset hash');
check(report.source_start===new Date(start).toISOString()&&report.source_end_exclusive===new Date(end).toISOString(),'Dataset span');
check(candles.every((c,i)=>c.time===start+i*step&&c.open>0&&c.close>0&&c.high>=Math.max(c.open,c.close)&&c.low<=Math.min(c.open,c.close)&&c.volume>=0),'Dataset continuity or OHLCV');
check(report.rows.length===perPhase*2*profiles.length,'Forecast trial count');
check(report.sampling.seed===42&&report.sampling.temperature===1&&report.sampling.top_p===0.9&&report.sampling.sample_count===3,'Sampling settings');
const stride=Math.floor((candles.length-128-horizon)/(perPhase*2));
check(report.stride_candles===stride&&stride>=horizon,'Window spacing');
const seen=new Set();
for(const row of report.rows){
  check(Number.isInteger(row.window)&&row.window>=0&&row.window<perPhase*2,'Window number');
  const phase=row.window<perPhase?'selection':'holdout';
  check(row.phase===phase&&profiles.includes(row.profile),'Phase or profile');
  const key=row.window+':'+row.profile;check(!seen.has(key),'Duplicate forecast '+key);seen.add(key);
  const origin=128+row.window*stride,lookback=row.profile==='short-64'?64:128;
  check(row.context_start===new Date(candles[origin-lookback].time).toISOString(),'Context start '+key);
  check(row.context_end===new Date(candles[origin-1].time).toISOString(),'Context end '+key);
  check(row.as_of===new Date(candles[origin].time).toISOString(),'Decision time '+key);
  check(near(row.origin_close,candles[origin-1].close),'Origin close '+key);
  check(row.actual.length===horizon&&row.predicted.length===horizon,'Forecast horizon '+key);
  for(let i=0;i<horizon;i++){
    check(row.actual[i].time===candles[origin+i].time&&near(row.actual[i].close,candles[origin+i].close),'Outcome label '+key+':'+i);
    check(row.predicted[i].time===row.actual[i].time&&Number.isFinite(row.predicted[i].close)&&row.predicted[i].close>0,'Prediction '+key+':'+i);
  }
}
const rows=(phase,profile)=>report.rows.filter(r=>r.phase===phase&&r.profile===profile);
const mae=items=>items.flatMap(r=>r.actual.map((p,i)=>Math.abs(p.close-r.predicted[i].close))).reduce((a,b)=>a+b,0)/(items.length*horizon);
for(const phase of ['selection','holdout'])for(const profile of profiles){
  const items=rows(phase,profile),stored=report[phase][profile];
  check(items.length===perPhase&&stored.windows===perPhase&&stored.points===perPhase*horizon,'Metric denominator '+phase+'/'+profile);
  check(near(mae(items),stored.mae_usd),'MAE '+phase+'/'+profile);
  const correct=items.filter(r=>Math.sign(r.predicted.at(-1).close-r.origin_close)===Math.sign(r.actual.at(-1).close-r.origin_close)).length;
  check(correct===stored.endpoint_direction_correct,'Direction count '+phase+'/'+profile);
}
const chosen=report.selection['short-64'].mae_usd<report.selection['default-128'].mae_usd?'short-64':'default-128';
check(report.selected_profile===chosen,'Selection rule');
const baselineRows=rows('holdout',chosen).map(r=>({...r,predicted:r.actual.map(p=>({time:p.time,close:r.origin_close}))}));
check(near(mae(baselineRows),report.unchanged_price_holdout.mae_usd),'Unchanged-price baseline');
check(report.selected_beats_unchanged_price===(report.holdout[chosen].mae_usd<report.unchanged_price_holdout.mae_usd),'Baseline verdict');
const selectedRows=rows('holdout',chosen);
const pairedWins=selectedRows.filter((r,i)=>mae([r])<mae([baselineRows[i]])).length;
console.log(JSON.stringify({result:'PASS',candles:candles.length,forecasts:report.rows.length,
  selection:report.selection,selected:chosen,holdout:report.holdout,baseline:report.unchanged_price_holdout,
  selected_beats_unchanged_price:report.selected_beats_unchanged_price,selected_window_wins_vs_baseline:pairedWins,
  selected_window_total:perPhase},null,2));
