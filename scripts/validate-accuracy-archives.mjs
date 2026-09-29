import {createHash} from 'node:crypto';
import {readdir,readFile,mkdir,writeFile} from 'node:fs/promises';

// Offline archive audit. No provider, model, wallet, or server calls.
const root=new URL('../.runtime/',import.meta.url);
const out=new URL('accuracy-validation/',root);
const sha=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const close=(a,b)=>Number.isFinite(a)&&Number.isFinite(b)&&Math.abs(a-b)<=1e-8*Math.max(1,Math.abs(a),Math.abs(b));
const date=t=>new Date(t).toISOString();
const issues=[];
const check=(condition,message)=>{if(!condition)issues.push(message);};
const sign=x=>Math.abs(x)<1e-10?0:Math.sign(x);
const metric=rows=>{
  const errors=rows.flatMap(r=>r.actual.map((p,i)=>({error:r.predicted[i].close-p.close,actual:p.close})));
  return {windows:rows.length,points:errors.length,
    mae_usd:errors.reduce((s,p)=>s+Math.abs(p.error),0)/errors.length,
    rmse_usd:Math.sqrt(errors.reduce((s,p)=>s+p.error**2,0)/errors.length),
    mape_pct:errors.reduce((s,p)=>s+Math.abs(p.error)/p.actual,0)/errors.length*100,
    direction_correct:rows.filter(r=>sign(r.predicted.at(-1).close-r.origin_close)===sign(r.actual.at(-1).close-r.origin_close)).length};
};

const candidate=JSON.parse(await readFile(new URL('candidate-history/latest.json',root)));
const cStep=candidate.step_minutes*60000,cHorizon=candidate.horizon_candles;
const cTimes=new Set();
let selected=0,abstained=0,momentumCorrect=0,momentumEligible=0;
const candidateForecastRows=[];
for(const row of candidate.rows){
  check(!cTimes.has(row.as_of),`candidate duplicate decision ${date(row.as_of)}`);cTimes.add(row.as_of);
  check(row.state.time===row.as_of,`candidate ${row.index} state time mismatch`);
  check(row.future_candles.length===cHorizon,`candidate ${row.index} future length`);
  check(row.future_candles.every((c,i)=>c.time===row.as_of+i*cStep),`candidate ${row.index} future alignment`);
  check(row.state.lanes.every(l=>l.recent_candles.every(c=>c.time+({ '15m':900000,'1h':3600000}[l.interval])<=row.as_of)),`candidate ${row.index} incomplete input candle`);
  check(row.state.lanes.every(l=>l.last_completed_time===l.recent_candles.at(-1).time && close(l.last_completed_close,l.recent_candles.at(-1).close)),`candidate ${row.index} lane close mismatch`);
  check(row.state.evaluation===null,`candidate ${row.index} evaluation present in model input`);
  check(row.state.kronos.generated_at===row.as_of,`candidate ${row.index} forecast timestamp`);
  check(row.forecast.length===cHorizon&&row.forecast.every((p,i)=>p.time===row.as_of+i*cStep),`candidate ${row.index} forecast alignment`);
  check(close(row.forecast_end_change_pct,(row.forecast.at(-1).close/row.origin_close-1)*100),`candidate ${row.index} forecast change mismatch`);
  check(close(row.origin_close,row.state.lanes[0].last_completed_close),`candidate ${row.index} origin mismatch`);
  candidateForecastRows.push({origin_close:row.origin_close,
    actual:row.future_candles.map(c=>({time:c.time,close:c.close})),
    predicted:row.forecast.map(p=>({time:p.time,close:p.close}))});
  const change=(row.future_candles.at(-1).close/row.origin_close-1)*100;
  check(close(row.future_close,row.future_candles.at(-1).close)&&close(row.future_change_pct,change),`candidate ${row.index} outcome mismatch`);
  const routed=row.decision.id!=='none'&&row.decision.confidence>=0.5&&row.decision.evidence_consistent>=0.5;
  check(row.review_routed===routed,`candidate ${row.index} routing mismatch`);
  const direction=routed&&row.decision.id==='sol_long'?'long':routed&&row.decision.id==='sol_short'?'short':null;
  check(row.selected_direction===direction,`candidate ${row.index} direction mismatch`);
  check(row.direction_matched===(direction==='long'?change>0:direction==='short'?change<0:null),`candidate ${row.index} direction score mismatch`);
  if(direction)selected++;
  if(row.decision.id==='none')abstained++;
  // The archived state contains a rounded 8-bar change; its sign is sufficient for this baseline.
  const pastSign=sign(row.state.lanes[0].change_8_bars_pct),actualSign=sign(change);
  const baseline=pastSign===0?null:pastSign===actualSign;
  check(row.momentum_baseline_direction_matched===baseline,`candidate ${row.index} momentum baseline mismatch`);
  if(baseline!==null){momentumEligible++;if(baseline)momentumCorrect++;}
}
check(candidate.rows.length===candidate.windows,'candidate window count');
check(candidate.summary.sol_direction_calls===selected&&candidate.summary.choices.none===abstained,'candidate saved summary counts');
for(let i=1;i<candidate.rows.length;i++)check(candidate.rows[i].as_of-candidate.rows[i-1].as_of>=cHorizon*cStep,'candidate outcomes overlap');
const candidateForecastMetric=metric(candidateForecastRows);
const candidateUnchangedMetric=metric(candidateForecastRows.map(r=>({...r,predicted:r.actual.map(p=>({time:p.time,close:r.origin_close}))})));
const selectedRows=candidate.rows.filter(r=>r.selected_direction);
const matchedMomentumRows=selectedRows.filter(r=>r.momentum_baseline_direction_matched!==null);

const dir=new URL('kronos-evaluations/',root);
const names=(await readdir(dir)).filter(n=>n.endsWith('.json')&&n!=='latest.json').sort();
const kronos=[];const keys=new Map();
for(const name of names){
  const {report:r,candles}=JSON.parse(await readFile(new URL(name,dir)));
  const tag=`kronos ${name}`,step={'5m':300000,'15m':900000,'1h':3600000}[r.interval];
  check(sha(candles)===r.dataset_hash,`${tag} source hash mismatch`);
  check(candles.length===r.candle_count&&candles[0].time===r.start_time&&candles.at(-1).time===r.end_time,`${tag} candle metadata mismatch`);
  check(candles.every((c,i)=>!i||c.time===candles[i-1].time+step),`${tag} candle gap`);
  const rowKeys=new Set();
  for(const row of r.rows){
    const key=`${row.window}:${row.profile}:${row.phase}`;
    check(!rowKeys.has(key),`${tag} duplicate row ${key}`);rowKeys.add(key);
    const origin=128+row.window*r.horizon;
    const lookback=row.profile==='short-64'?64:128;
    const context=candles.slice(origin-lookback,origin),actual=candles.slice(origin,origin+r.horizon);
    check(row.context_start===context[0].time&&row.context_end===context.at(-1).time&&row.context_end+step===actual[0].time,`${tag} context alignment ${key}`);
    check(close(row.origin_close,context.at(-1).close),`${tag} origin price ${key}`);
    check(row.actual.length===r.horizon&&row.actual.every((p,i)=>p.time===actual[i].time&&close(p.close,actual[i].close)),`${tag} actual mismatch ${key}`);
    check(row.predicted.length===r.horizon&&row.predicted.every((p,i)=>p.time===actual[i].time&&Number.isFinite(p.close)),`${tag} prediction alignment ${key}`);
    if(row.profile==='unchanged-price')check(row.predicted.every(p=>close(p.close,row.origin_close)),`${tag} unchanged baseline ${key}`);
    const globalKey=`${r.asset}:${r.interval}:${r.horizon}:${actual[0].time}`;
    if(row.phase==='holdout'&&row.profile===r.selected_profile){
      const existing=keys.get(globalKey)??[];existing.push(r.id);keys.set(globalKey,existing);
    }
  }
  for(const group of [...r.tuning,...r.holdout,r.baseline]){
    const phase=r.tuning.includes(group)?'selection':'holdout';
    const m=metric(r.rows.filter(x=>x.phase===phase&&x.profile===group.id));
    for(const key of ['windows','points','mae_usd','rmse_usd','mape_pct','direction_correct'])check(close(m[key],group[key]),`${tag} ${phase}/${group.id} ${key} mismatch`);
    check(group.direction_total===m.windows&&close(group.direction_accuracy_pct,100*m.direction_correct/m.windows),`${tag} ${phase}/${group.id} direction denominator`);
  }
  const picked=[...r.tuning].sort((a,b)=>a.mae_usd-b.mae_usd)[0].id;
  check(picked===r.selected_profile,`${tag} selection mismatch`);
  kronos.push({file:name,id:r.id,created_at:date(r.created_at),asset:r.asset,interval:r.interval,horizon:r.horizon,
    source_hash:r.dataset_hash,model:r.model,source_revision:r.source_revision,sampling:r.sampling,
    start:date(r.start_time),end:date(r.end_time),selected:r.selected_profile,
    selection_windows:r.selection_windows,holdout_windows:r.holdout_windows,
    selected_holdout:r.holdout.find(x=>x.id===r.selected_profile),baseline:r.baseline});
}
const duplicateHoldout=[...keys].filter(([,ids])=>ids.length>1).map(([key,ids])=>({key,ids}));
const result={generated_at:new Date().toISOString(),audit:'offline archive audit; no fresh forecast/model trial',
  candidate:{id:candidate.id,created_at:date(candidate.created_at),source:candidate.source,source_hash:candidate.dataset_hash,
    source_hash_reproducible:false,model:candidate.model,decision_models:[...new Set(candidate.rows.map(r=>r.decision.model))],
    start_as_of:date(candidate.start_as_of),end_as_of:date(candidate.end_as_of),interval:'15m',horizon:cHorizon,
    unique_decisions:cTimes.size,choices:candidate.summary.choices,abstentions:abstained,selected_sol: selected,
    selective_coverage:{numerator:selected,denominator:cTimes.size},
    sol_direction_accuracy:{correct:selectedRows.filter(r=>r.direction_matched).length,total:selected,
      value:selected?selectedRows.filter(r=>r.direction_matched).length/selected:null},
    momentum_all_decisions:{correct:momentumCorrect,total:momentumEligible},
    momentum_matched_selected:{correct:matchedMomentumRows.filter(r=>r.momentum_baseline_direction_matched).length,total:matchedMomentumRows.length},
    kronos_forecast_same_decisions:{...candidateForecastMetric,direction_total:cTimes.size},
    unchanged_price_same_decisions:{...candidateUnchangedMetric,direction_total:cTimes.size},
    state_has_static_plan:true,full_source_candles_archived:false},
  kronos:{archive_count:kronos.length,archives:kronos,distinct_selected_holdout_keys:keys.size,duplicate_selected_holdout_keys:duplicateHoldout},
  issues};
await mkdir(out,{recursive:true});
await writeFile(new URL('latest.json',out),JSON.stringify(result,null,2));
console.log(JSON.stringify({candidate:result.candidate,kronos_archives:kronos.length,distinct_selected_holdout_keys:keys.size,duplicate_selected_holdout_keys:duplicateHoldout.length,issues},null,2));
if(issues.length)process.exitCode=1;
