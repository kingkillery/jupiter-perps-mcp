// Recompute exploratory range and contract-outcome scores from the saved inputs.
import {readFile,writeFile} from 'node:fs/promises';

const root=new URL('../.runtime/kronos-market-ranges/',import.meta.url);
const model=JSON.parse(await readFile(new URL('latest.json',root),'utf8'));
const markets=JSON.parse(await readFile(new URL('markets.json',root),'utf8'));
const must=(condition,message)=>{if(!condition)throw new Error(message);};
must(model.research_only&&markets.research_only&&model.rows.length===16&&markets.rows.length===16,'Incomplete research archives');
const byKey=new Map(markets.rows.map(r=>[`${r.interval}:${r.origin_time}`,r]));
must(byKey.size===16,'Duplicate market sessions');
const rows=[];
for(const r of model.rows){
  const m=byKey.get(`${r.interval}:${r.origin_time}`);
  must(m&&!m.polymarket.error&&!m.kalshi.error,'Missing market session');
  const step=r.interval==='15m'?900_000:3_600_000;
  must(Date.parse(m.polymarket.event_start_time)===r.origin_time&&Date.parse(m.polymarket.end_time)===r.origin_time+step,'Polymarket session mismatch');
  must(m.polymarket.quote_before_start?.time<=r.origin_time&&m.polymarket.quote_before_start.age_seconds<=60,'Stale Polymarket quote');
  must(m.kalshi.quote_first_minute?.time===r.origin_time+60_000,'Kalshi first-minute quote mismatch');
  must(['yes','no'].includes(m.kalshi.result),'Unsettled Kalshi contract');
  const modelUp=r.predicted.close>=r.context_close;
  const modelKalshiYes=r.predicted.close>=m.kalshi.strike;
  const polyp=m.polymarket.quote_before_start.up_price;
  const kalship=m.kalshi.quote_first_minute.yes_mid;
  rows.push({interval:r.interval,origin_time:r.origin_time,
    model_low:r.predicted.low,model_high:r.predicted.high,actual_low:r.actual.low,actual_high:r.actual.high,
    prior_low:r.previous.low,prior_high:r.previous.high,
    range_high_error:Math.abs(r.predicted.high-r.actual.high),range_low_error:Math.abs(r.predicted.low-r.actual.low),
    prior_high_error:Math.abs(r.previous.high-r.actual.high),prior_low_error:Math.abs(r.previous.low-r.actual.low),
    full_bar_covered:r.predicted.low<=r.actual.low&&r.predicted.high>=r.actual.high,
    close_covered:r.predicted.low<=r.actual.close&&r.predicted.high>=r.actual.close,
    model_up:modelUp,polymarket_up:m.polymarket.resolved_up,polymarket_p_up:polyp,
    polymarket_quote_age_seconds:m.polymarket.quote_before_start.age_seconds,
    model_kalshi_yes:modelKalshiYes,kalshi_yes:m.kalshi.result==='yes',kalshi_p_yes:kalship,
    range_implied_kalshi_yes:r.predicted.low>m.kalshi.strike?true:r.predicted.high<m.kalshi.strike?false:null,
    kalshi_strike:m.kalshi.strike,kalshi_quote_after_seconds:60,
    kalshi_volume_contracts:m.kalshi.volume_contracts,
    polymarket_market_url:m.polymarket.market_url,kalshi_market_url:m.kalshi.market_url});
}
const mean=values=>values.reduce((a,b)=>a+b,0)/values.length;
const score=interval=>{
  const subset=rows.filter(r=>r.interval===interval);
  const q=key=>mean(subset.map(r=>r[key]));
  const polyDecisions=subset.filter(r=>r.polymarket_p_up!==0.5);
  const kalshiDecisions=subset.filter(r=>r.kalshi_p_yes!==0.5);
  const rangeDecisions=subset.filter(r=>r.range_implied_kalshi_yes!==null);
  return {sessions:subset.length,
    high_mae_usd:q('range_high_error'),low_mae_usd:q('range_low_error'),
    mean_high_low_mae_usd:(q('range_high_error')+q('range_low_error'))/2,
    prior_candle_mean_high_low_mae_usd:(q('prior_high_error')+q('prior_low_error'))/2,
    full_bar_covered:subset.filter(r=>r.full_bar_covered).length,
    close_covered:subset.filter(r=>r.close_covered).length,
    polymarket_model_direction_correct:subset.filter(r=>r.model_up===r.polymarket_up).length,
    polymarket_quote_direction_correct:polyDecisions.filter(r=>(r.polymarket_p_up>0.5)===r.polymarket_up).length,
    polymarket_quote_non_tie_count:polyDecisions.length,
    polymarket_quote_brier:mean(subset.map(r=>(r.polymarket_p_up-Number(r.polymarket_up))**2)),
    kalshi_model_threshold_correct:subset.filter(r=>r.model_kalshi_yes===r.kalshi_yes).length,
    kalshi_range_decisions:rangeDecisions.length,
    kalshi_range_decisions_correct:rangeDecisions.filter(r=>r.range_implied_kalshi_yes===r.kalshi_yes).length,
    kalshi_first_minute_direction_correct:kalshiDecisions.filter(r=>(r.kalshi_p_yes>0.5)===r.kalshi_yes).length,
    kalshi_first_minute_non_tie_count:kalshiDecisions.length,
    kalshi_first_minute_brier:mean(subset.map(r=>(r.kalshi_p_yes-Number(r.kalshi_yes))**2))};
};
const report={research_only:true,source_sha256:model.source_sha256,
  warning:'Already inspected historical period; only eight sessions per timeframe; no tradable edge claim.',
  timing:'Kronos as of session start; Polymarket quote 41-50 seconds before start; Kalshi quote 60 seconds after start.',
  settlement:'Coinbase spot labels for OHLC; Polymarket and Kalshi own settlement outcomes for contracts.',
  scores:{'15m':score('15m'),'1h':score('1h')},rows};
await writeFile(new URL('score.json',root),JSON.stringify(report,null,2));
console.log(JSON.stringify(report.scores,null,2));
