import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {mkdir,readFile,writeFile,rename} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';

// Standalone research run. No wallet, server, key, or transaction access.
const root=fileURLToPath(new URL('..',import.meta.url));
const outputDir=join(root,'.runtime','kronos-long-history');
const datasetPath=join(outputDir,'coinbase-sol-usd-15m-20260816-20260915.json');
const start=Date.parse('2026-08-16T00:00:00Z');
const end=Date.parse('2026-09-15T00:00:00Z');
const step=900000,horizon=8,perPhase=12,chunk=288;
const profiles=[{id:'default-128',lookback:128},{id:'short-64',lookback:64}];
const manifest=JSON.parse(await readFile(join(root,'kronos','manifest.json'),'utf8'));
const worker=join(root,'kronos','forecast.py');
const python=join(root,'.runtime','kronos-venv',process.platform==='win32'?'Scripts/python.exe':'bin/python');
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const iso=time=>new Date(time).toISOString();
const finite=n=>typeof n==='number'&&Number.isFinite(n);
const must=(ok,message)=>{if(!ok)throw new Error(message);};

function validateCandles(candles){
  must(Array.isArray(candles)&&(end-start)/step===candles.length,'Incomplete 30-day candle history');
  for(let i=0;i<candles.length;i++){
    const c=candles[i];
    must(c.time===start+i*step,'Candle gap, duplicate, or incorrect boundary at '+i);
    must(['open','high','low','close'].every(k=>finite(c[k])&&c[k]>0)&&finite(c.volume)&&c.volume>=0,'Invalid OHLCV at '+i);
    must(c.high>=Math.max(c.open,c.close)&&c.low<=Math.min(c.open,c.close)&&c.low<=c.high,'Invalid price range at '+i);
  }
}

async function candlesFromCoinbase(){
  const byTime=new Map();
  for(let from=start;from<end;from+=chunk*step){
    const until=Math.min(end,from+chunk*step);
    const url=new URL('https://api.exchange.coinbase.com/products/SOL-USD/candles');
    url.searchParams.set('start',iso(from));url.searchParams.set('end',iso(until));url.searchParams.set('granularity','900');
    const response=await fetch(url,{headers:{Accept:'application/json'},signal:AbortSignal.timeout(20000)});
    must(response.ok,'Coinbase candles returned HTTP '+response.status+' for '+iso(from));
    const rows=await response.json();
    must(Array.isArray(rows),'Coinbase candles response was not an array');
    for(const row of rows){
      must(Array.isArray(row)&&row.length>=6&&row.every((n,i)=>i>=6||finite(n)),'Invalid Coinbase candle row');
      const [seconds,low,high,open,close,volume]=row;
      const time=seconds*1000;
      if(time<from||time>=until)continue; // API may return bars before requested start.
      must(!byTime.has(time),'Duplicate Coinbase candle at '+iso(time));
      byTime.set(time,{time,open,high,low,close,volume});
    }
    console.log('Fetched through '+iso(until)+' ('+byTime.size+' candles)');
  }
  return [...byTime.values()].sort((a,b)=>a.time-b.time);
}

async function loadDataset(){
  await mkdir(outputDir,{recursive:true});
  try{
    const saved=JSON.parse(await readFile(datasetPath,'utf8'));
    must(saved.source==='Coinbase Exchange SOL-USD spot'&&saved.start===start&&saved.end===end,'Cached dataset metadata mismatch');
    validateCandles(saved.candles);
    must(hash(saved.candles)===saved.sha256,'Cached dataset hash mismatch');
    return saved;
  }catch(error){if(error.code!=='ENOENT')throw error;}
  const candles=await candlesFromCoinbase();
  validateCandles(candles);
  const saved={source:'Coinbase Exchange SOL-USD spot',fetched_at:iso(Date.now()),start,end,interval_ms:step,
    sha256:hash(candles),candles};
  await writeFile(datasetPath,JSON.stringify(saved),{flag:'wx'});
  return saved;
}

async function infer(requests){
  must(existsSync(python),'Local Kronos runtime is missing');
  const environment={HF_HUB_OFFLINE:'1',HF_HUB_DISABLE_TELEMETRY:'1',OMP_NUM_THREADS:'4',MKL_NUM_THREADS:'4'};
  for(const name of ['SystemRoot','WINDIR','TEMP','TMP'])if(process.env[name])environment[name]=process.env[name];
  return await new Promise((resolve,reject)=>{
    const child=spawn(python,['-I',worker],{cwd:root,env:environment,shell:false,windowsHide:true,stdio:['pipe','pipe','pipe']});
    let stdout='',stderr='';
    const timer=setTimeout(()=>child.kill(),600000);
    child.stdout.on('data',data=>{stdout+=data;if(stdout.length>1048576)child.kill();});
    child.stderr.on('data',data=>{stderr=(stderr+data).slice(-3000);});
    child.on('error',error=>{clearTimeout(timer);reject(error);});
    child.on('close',code=>{
      clearTimeout(timer);
      if(code!==0)return reject(new Error('Kronos inference failed: '+stderr));
      try{resolve(JSON.parse(stdout));}catch{reject(new Error('Kronos returned invalid JSON'));}
    });
    child.stdin.end(JSON.stringify({requests}));
  });
}

function score(rows){
  const errors=rows.flatMap(r=>r.actual.map((p,i)=>Math.abs(r.predicted[i].close-p.close)));
  must(errors.length===rows.length*horizon,'Incomplete forecast score');
  return {windows:rows.length,points:errors.length,mae_usd:errors.reduce((a,b)=>a+b,0)/errors.length,
    endpoint_direction_correct:rows.filter(r=>Math.sign(r.predicted.at(-1).close-r.origin_close)===Math.sign(r.actual.at(-1).close-r.origin_close)).length};
}

const dataset=await loadDataset();
const candles=dataset.candles;
const stride=Math.floor((candles.length-128-horizon)/(perPhase*2));
must(stride>=horizon,'Outcome windows overlap');
const origins=Array.from({length:perPhase*2},(_,i)=>128+i*stride);
must(origins.at(-1)+horizon<=candles.length,'Final outcome is incomplete');
const rows=[];
let selection,selected;
for(const [phase,indices] of [['selection',origins.slice(0,perPhase)],['holdout',origins.slice(perPhase)]]){
  const jobs=indices.flatMap((origin,i)=>profiles.map(profile=>({window:(phase==='selection'?0:perPhase)+i,origin,profile})));
  console.log('Running '+phase+' forecasts: '+jobs.length+' fixed model requests');
  const result=await infer(jobs.map(j=>({candles:candles.slice(j.origin-j.profile.lookback,j.origin),horizon,interval_ms:step})));
  must(result?.results?.length===jobs.length,'Kronos returned incomplete batch');
  for(let j=0;j<jobs.length;j++){
    const job=jobs[j],forecast=result.results[j].forecast;
    const actual=candles.slice(job.origin,job.origin+horizon).map(c=>({time:c.time,close:c.close}));
    must(Array.isArray(forecast)&&forecast.length===horizon,'Kronos forecast length mismatch');
    must(forecast.every((p,i)=>p.time===actual[i].time&&finite(p.close)&&p.close>0),'Kronos forecast time or price mismatch');
    rows.push({phase,window:job.window,profile:job.profile.id,context_start:iso(candles[job.origin-job.profile.lookback].time),
      context_end:iso(candles[job.origin-1].time),as_of:iso(actual[0].time),origin_close:candles[job.origin-1].close,
      actual,predicted:forecast});
  }
  if(phase==='selection'){
    selection=Object.fromEntries(profiles.map(p=>[p.id,score(rows.filter(r=>r.phase==='selection'&&r.profile===p.id))]));
    selected=selection['short-64'].mae_usd<selection['default-128'].mae_usd?'short-64':'default-128';
    console.log('Frozen selection before holdout inference: '+selected);
  }
}
const holdout=Object.fromEntries(profiles.map(p=>[p.id,score(rows.filter(r=>r.phase==='holdout'&&r.profile===p.id))]));
const baselineRows=rows.filter(r=>r.phase==='holdout'&&r.profile===selected).map(r=>({...r,predicted:r.actual.map(p=>({time:p.time,close:r.origin_close}))}));
const baseline=score(baselineRows);
const report={created_at:iso(Date.now()),declaration_commit:'66bedff',research_only:true,submitted:false,live_settings_changed:false,
  source:dataset.source,source_documentation:'https://docs.cdp.coinbase.com/api-reference/exchange-api/rest-api/products/get-product-candles',
  source_sha256:dataset.sha256,source_start:iso(start),source_end_exclusive:iso(end),candles:candles.length,
  model:manifest.model,tokenizer:manifest.tokenizer,source_revision:manifest.source_revision,
  sampling:{seed:42,temperature:1,top_p:0.9,sample_count:3},interval:'15m',horizon,
  selection_windows:perPhase,holdout_windows:perPhase,stride_candles:stride,profiles,
  selection,selected_profile:selected,holdout,unchanged_price_holdout:baseline,
  selected_beats_unchanged_price:holdout[selected].mae_usd<baseline.mae_usd,
  limitations:['Historical holdout, not prospective confirmation or evidence of trading profitability.',
    'Coinbase SOL-USD spot differs from Kraken spot and Jupiter Perps execution prices.',
    'Model pretraining overlap and prior human exposure cannot be excluded.',
    'No fees, fills, funding, liquidation, slippage, or live settings are evaluated.'],rows};
const archive=join(outputDir,'report-'+dataset.sha256.slice(0,12)+'.json');
await writeFile(archive,JSON.stringify(report,null,2),{flag:'wx'});
const temporary=join(outputDir,'latest.tmp');
await writeFile(temporary,JSON.stringify(report,null,2),{flag:'wx'});
await rename(temporary,join(outputDir,'latest.json'));
console.log(JSON.stringify({report:archive,source_sha256:dataset.sha256,selection,selected_profile:selected,holdout,
  unchanged_price_holdout:baseline,selected_beats_unchanged_price:report.selected_beats_unchanged_price},null,2));
