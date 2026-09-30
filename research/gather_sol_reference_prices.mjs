// Research-only public SOL price archive. Never reads wallet or API credentials.
import {createHash} from 'node:crypto';
import {mkdir,readFile,rename,writeFile} from 'node:fs/promises';

const output=new URL('../.runtime/sol-reference-data/',import.meta.url);
const minute=60_000;
const start=Date.parse('2026-09-12T00:00:00Z');
const end=Date.parse('2026-09-29T00:00:00Z');
const replayStart=Date.parse('2026-09-07T00:00:00Z');
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const must=(condition,message)=>{if(!condition)throw new Error(message);};
const pause=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const finite=n=>typeof n==='number'&&Number.isFinite(n);

async function get(url){
  for(let attempt=0;attempt<5;attempt++){
    const response=await fetch(url,{headers:{Accept:'application/json'},signal:AbortSignal.timeout(25000)});
    if((response.status===429||response.status>=500)&&attempt<4){
      await pause(2000*(attempt+1));
      continue;
    }
    must(response.ok,`${response.status} from ${url.origin}${url.pathname}`);
    return response.json();
  }
}

function validate(bars,from,to,step){
  must(Array.isArray(bars)&&bars.length===(to-from)/step,'Incomplete archive');
  for(let i=0;i<bars.length;i++){
    const c=bars[i];
    must(c.time===from+i*step,`Gap or duplicate at ${new Date(from+i*step).toISOString()}`);
    must(['open','high','low','close','volume'].every(k=>finite(c[k]))&&c.volume>=0&&c.low>0&&c.high>=Math.max(c.open,c.close)&&c.low<=Math.min(c.open,c.close),'Invalid OHLCV');
  }
}

async function cached(name,from,to,step,source,fetcher){
  const path=new URL(name,output);
  try{
    const saved=JSON.parse(await readFile(path,'utf8'));
    must(saved.source===source&&saved.start===from&&saved.end===to&&saved.step_ms===step,'Cached metadata mismatch');
    validate(saved.bars,from,to,step);
    must(hash(saved.bars)===saved.sha256,'Cached hash mismatch');
    return {path:name,source,bars:saved.bars.length,sha256:saved.sha256,cached:true};
  }catch(error){if(error.code!=='ENOENT')throw error;}
  const bars=await fetcher();
  validate(bars,from,to,step);
  const saved={source,source_url:source==='Coinbase Exchange SOL-USD spot'?
    'https://api.exchange.coinbase.com/products/SOL-USD/candles':
    'https://data-api.binance.vision/api/v3/klines',start:from,end:to,step_ms:step,
    fetched_at:new Date().toISOString(),sha256:hash(bars),bars};
  const temporary=new URL(`${name}.tmp`,output);
  await writeFile(temporary,JSON.stringify(saved));
  await rename(temporary,path);
  return {path:name,source,bars:bars.length,sha256:saved.sha256,cached:false};
}

async function coinbase(fromStart,toEnd){
  const byTime=new Map();
  const chunk=250;
  for(let from=fromStart;from<toEnd;from+=chunk*minute){
    const until=Math.min(toEnd,from+chunk*minute);
    const url=new URL('https://api.exchange.coinbase.com/products/SOL-USD/candles');
    url.searchParams.set('start',new Date(from).toISOString());
    url.searchParams.set('end',new Date(until).toISOString());
    url.searchParams.set('granularity','60');
    const data=await get(url);
    must(Array.isArray(data),'Unexpected Coinbase response');
    for(const row of data){
      must(Array.isArray(row)&&row.length>=6,'Invalid Coinbase candle');
      const [seconds,low,high,open,close,volume]=row;
      const time=seconds*1000;
      if(time<from||time>=until)continue;
      must(!byTime.has(time),'Duplicate Coinbase candle');
      byTime.set(time,{time,open,high,low,close,volume});
    }
    await pause(150);
  }
  return [...byTime.values()].sort((a,b)=>a.time-b.time);
}

async function binance(from,to,step,interval){
  const byTime=new Map();
  for(let cursor=from;cursor<to;cursor+=1000*step){
    const until=Math.min(to,cursor+1000*step);
    const url=new URL('https://data-api.binance.vision/api/v3/klines');
    url.searchParams.set('symbol','SOLUSDT');
    url.searchParams.set('interval',interval);
    url.searchParams.set('startTime',String(cursor));
    url.searchParams.set('endTime',String(until-1));
    url.searchParams.set('limit','1000');
    const data=await get(url);
    must(Array.isArray(data),'Unexpected Binance response');
    for(const row of data){
      must(Array.isArray(row)&&row.length>=6,'Invalid Binance candle');
      const time=row[0];
      if(time<cursor||time>=until)continue;
      must(!byTime.has(time),'Duplicate Binance candle');
      byTime.set(time,{time,open:Number(row[1]),high:Number(row[2]),low:Number(row[3]),
        close:Number(row[4]),volume:Number(row[5])});
    }
    await pause(150);
  }
  return [...byTime.values()].sort((a,b)=>a.time-b.time);
}

await mkdir(output,{recursive:true});
const entries=[];
entries.push(await cached('binance-solusdt-1h-replay.json',replayStart,start,3_600_000,
  'Binance SOL/USDT spot',()=>binance(replayStart,start,3_600_000,'1h')));
console.log(`Archived replay-hour Binance prices: ${entries.at(-1).bars} bars`);
entries.push(await cached('binance-solusdt-1m-replay.json',replayStart,start,minute,
  'Binance SOL/USDT spot',()=>binance(replayStart,start,minute,'1m')));
console.log(`Archived replay-minute Binance prices: ${entries.at(-1).bars} bars`);
entries.push(await cached('coinbase-solusd-1m-replay.json',replayStart,start,minute,
  'Coinbase Exchange SOL-USD spot',()=>coinbase(replayStart,start)));
console.log(`Archived replay-minute Coinbase prices: ${entries.at(-1).bars} bars`);
entries.push(await cached('binance-solusdt-1m-new.json',start,end,minute,
  'Binance SOL/USDT spot',()=>binance(start,end,minute,'1m')));
console.log(`Archived new Binance minute prices: ${entries.at(-1).bars} bars`);
entries.push(await cached('coinbase-solusd-1m-new.json',start,end,minute,
  'Coinbase Exchange SOL-USD spot',()=>coinbase(start,end)));
console.log(`Archived new Coinbase minute prices: ${entries.at(-1).bars} bars`);
const manifest={created_at:new Date().toISOString(),research_only:true,
  start:new Date(start).toISOString(),end_exclusive:new Date(end).toISOString(),
  sealed_for_future_scoring:true,entries};
await writeFile(new URL('manifest.json',output),JSON.stringify(manifest,null,2));
console.log(JSON.stringify(manifest,null,2));
