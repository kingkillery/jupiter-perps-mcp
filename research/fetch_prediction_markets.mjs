// Read-only, fixed-session market metadata and timestamped quotes for the range replay.
import {readFile,writeFile} from 'node:fs/promises';

const root=new URL('../.runtime/kronos-market-ranges/',import.meta.url);
const replay=JSON.parse(await readFile(new URL('latest.json',root),'utf8'));
const origins=[...new Set(replay.rows.map(r=>r.origin_time))].sort((a,b)=>a-b);
if(origins.length!==8||origins.some((t,i)=>t!==Date.parse(`2026-09-${String(i+7).padStart(2,'0')}T12:00:00Z`)))
  throw new Error('Unexpected replay sessions');
const byTime=new Map(replay.rows.filter(r=>r.interval==='15m').map(r=>[r.origin_time,r]));

async function get(url){
  for(let attempt=0;attempt<4;attempt++){
    const response=await fetch(url,{headers:{Accept:'application/json'},signal:AbortSignal.timeout(20000)});
    if(response.status===429&&attempt<3){
      await new Promise(resolve=>setTimeout(resolve,4000*(attempt+1)));
      continue;
    }
    if(!response.ok)throw new Error(`${response.status} ${url.pathname}`);
    return response.json();
  }
}
const array=value=>typeof value==='string'?JSON.parse(value):value;
const endpoint='https://external-api.kalshi.com/trade-api/v2';

async function polymarket(origin,interval){
  const second=origin/1000;
  const day=new Date(origin).getUTCDate();
  const slug=interval==='15m'?`sol-updown-15m-${second}`:
    `solana-up-or-down-september-${day}-2026-8am-et`;
  const event=await get(new URL(`/events/slug/${slug}`,'https://gamma-api.polymarket.com'));
  const market=event.markets?.[0];
  if(!market||!market.closed)throw new Error(`No settled Polymarket market ${slug}`);
  const outcomes=array(market.outcomes),tokens=array(market.clobTokenIds),prices=array(market.outcomePrices);
  const up=outcomes.indexOf('Up');
  if(up<0||tokens.length!==2||prices.length!==2)throw new Error(`Unexpected outcomes ${slug}`);
  const url=new URL('/prices-history','https://clob.polymarket.com');
  url.searchParams.set('market',tokens[up]);
  url.searchParams.set('startTs',String(second-3600));
  url.searchParams.set('endTs',String(second+60));
  url.searchParams.set('fidelity','1');
  const history=(await get(url)).history||[];
  const before=history.filter(p=>p.t<=second).at(-1)||null;
  return {slug,market_url:`https://polymarket.com/event/${slug}`,resolution_source:market.description,
    event_start_time:market.eventStartTime,end_time:market.endDate,
    resolved_up:Number(prices[up])===1,volume_usd:Number(market.volume),
    quote_before_start:before?{time:before.t*1000,up_price:before.p,age_seconds:second-before.t}:null,
    price_points:history.length};
}

async function kalshi(origin,interval){
  const second=origin/1000;
  const duration=interval==='15m'?900:3600;
  const series=interval==='15m'?'KXSOL15M':'KXSOLD';
  const url=new URL('/trade-api/v2/markets',endpoint);
  url.searchParams.set('series_ticker',series);
  url.searchParams.set('status','settled');
  url.searchParams.set('min_close_ts',String(second+duration-30));
  url.searchParams.set('max_close_ts',String(second+duration+30));
  url.searchParams.set('limit',interval==='15m'?'20':'1000');
  const response=await get(url);
  const markets=response.markets.filter(m=>Date.parse(m.open_time)===origin&&Date.parse(m.close_time)===origin+duration*1000);
  if(!markets.length)throw new Error(`No Kalshi ${interval} market at ${new Date(origin).toISOString()}`);
  let market;
  let strike=null;
  if(interval==='15m'){
    if(markets.length!==1)throw new Error('Ambiguous Kalshi 15m market');
    market=markets[0];
    strike=Number(market.yes_sub_title?.match(/\$([0-9.]+)/)?.[1]);
  }else{
    // Freeze a contract by the known, prior Coinbase close. Do not select by eventual volume/result.
    const known=byTime.get(origin).context_close;
    const candidates=markets.map(m=>({market:m,threshold:Number(m.yes_sub_title?.match(/\$([0-9.]+)/)?.[1])}))
      .filter(x=>Number.isFinite(x.threshold));
    candidates.sort((a,b)=>Math.abs(a.threshold-known)-Math.abs(b.threshold-known));
    if(!candidates.length)throw new Error('No hourly threshold contract');
    market=candidates[0].market;
    strike=candidates[0].threshold;
  }
  const candlesUrl=new URL(`/trade-api/v2/series/${series}/markets/${market.ticker}/candlesticks`,endpoint);
  candlesUrl.searchParams.set('start_ts',String(second));
  candlesUrl.searchParams.set('end_ts',String(second+60));
  candlesUrl.searchParams.set('period_interval','1');
  let candles=[];
  try{candles=(await get(candlesUrl)).candlesticks||[];}catch(error){
    if(!String(error).includes('404'))throw error;
  }
  const first=candles.find(c=>c.end_period_ts>=second&&c.end_period_ts<=second+60);
  const bid=Number(first?.yes_bid?.close_dollars),ask=Number(first?.yes_ask?.close_dollars);
  return {ticker:market.ticker,market_url:`https://kalshi.com/markets/${series.toLowerCase()}/${market.ticker.toLowerCase()}`,
    title:market.title,rule:market.rules_primary,result:market.result,strike,
    volume_contracts:Number(market.volume_fp),quote_first_minute:
      Number.isFinite(bid)&&Number.isFinite(ask)&&bid>0&&ask>0&&bid<=ask?
        {time:first.end_period_ts*1000,yes_bid:bid,yes_ask:ask,yes_mid:(bid+ask)/2}:null,
    candle_count:candles.length,market_count:markets.length};
}

const rows=[];
let prior=[];
try{prior=JSON.parse(await readFile(new URL('markets.json',root),'utf8')).rows;}catch(error){if(error.code!=='ENOENT')throw error;}
for(const origin of origins){
  for(const interval of ['15m','1h']){
    const cached=prior.find(r=>r.origin_time===origin&&r.interval===interval);
    const results=await Promise.allSettled([
      cached?.polymarket&&!cached.polymarket.error?cached.polymarket:polymarket(origin,interval),
      cached?.kalshi&&!cached.kalshi.error?cached.kalshi:kalshi(origin,interval)
    ]);
    rows.push({origin_time:origin,interval,
      polymarket:results[0].status==='fulfilled'?results[0].value:{error:String(results[0].reason)},
      kalshi:results[1].status==='fulfilled'?results[1].value:{error:String(results[1].reason)}});
  }
  console.log(`Read prediction markets for ${new Date(origin).toISOString()}`);
}
const output={retrieved_at:new Date().toISOString(),research_only:true,
  session_rule:'Sep 7-14 2026 at 12:00 UTC each day; one 15m and one 1h market',
  limitations:['Polymarket quote is last sampled price at/before session start, not an executable order-book snapshot.',
    'Kalshi first-minute quote sees up to one minute of the outcome window; it is not time-matched to model issuance.',
    'Settlement sources differ from Coinbase spot, and up/down or threshold payouts are not candle high/low events.'],rows};
await writeFile(new URL('markets.json',root),JSON.stringify(output,null,2));
console.log(JSON.stringify({rows:rows.length,polymarket_quotes:rows.filter(r=>r.polymarket.quote_before_start).length,
  kalshi_quotes:rows.filter(r=>r.kalshi.quote_first_minute).length,
  errors:rows.filter(r=>r.polymarket.error||r.kalshi.error).map(r=>({date:new Date(r.origin_time).toISOString(),interval:r.interval,polymarket:r.polymarket.error,kalshi:r.kalshi.error}))},null,2));
