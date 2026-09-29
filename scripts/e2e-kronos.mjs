import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import net from 'node:net';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// Full HTTP/MCP server and installed Kronos model; external candles are fixtures.
// No wallet connection, trade preparation, signing, or broadcast.
const probe=net.createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');
const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
const base='http://127.0.0.1:'+port;
const child=spawn(process.execPath,['--import','./scripts/e2e-upstream.mjs','dist/index.js'],{
 cwd:new URL('..',import.meta.url),windowsHide:true,
 env:{...process.env,NODE_ENV:'test',KRONOS_E2E_SERIES:'1',WALLET_MODE:'browser',WALLET_PRIVATE_KEY:'',MCP_MODE:'http',MCP_PORT:String(port)},
 stdio:['ignore','pipe','pipe']});
let logs='',client;child.stdout.on('data',x=>{logs+=x;});child.stderr.on('data',x=>{logs+=x;});
try{
 let ready=false;
 for(let i=0;i<150;i++){
  if(child.exitCode!==null)throw Error(logs);
  try{ready=(await fetch(base+'/health')).ok;if(ready)break;}catch{}
  await delay(100);
 }
 assert(ready,'Server started');
 assert.equal((await fetch(base+'/wallet/kronos/status')).status,401);
 const page=await fetch(base+'/wallet'),html=await page.text();
 assert.match(html,/id="kronos-generate"/);assert.match(html,/id="kronos-chart"/);
 const cookie=page.headers.get('set-cookie').split(';')[0];
 const request=async(path,body,extra={})=>{
  const response=await fetch(base+'/wallet/'+path,{method:body===undefined?'GET':'POST',
   headers:{Cookie:cookie,...(body===undefined?{}:{Origin:base,'Content-Type':'application/json','X-Wallet-Bridge':'1'}),...extra},
   body:body===undefined?undefined:JSON.stringify(body)});
  return {status:response.status,body:await response.json()};
 };
 assert.equal((await request('kronos/status')).body.ready,true,'Run npm run setup:kronos first');
 assert.equal((await request('kronos/forecast',{}, {Origin:'https://attacker.invalid'})).status,403);
 assert.equal((await request('kronos/forecast',{}, {'X-Wallet-Bridge':''})).status,403);
 for(const args of [{asset:'DOGE'},{interval:'1s'},{horizon:25},{horizon:0},{horizon:1.5},{horizon:'8'},{wallet_key:'never-accepted'}]){
  assert.equal((await request('kronos/forecast',args)).status,400);
 }
 const forecastPromise=request('kronos/forecast',{});
 let running=false;
 for(let i=0;i<100;i++){running=(await request('kronos/status')).body.busy;if(running)break;await delay(20);}
 assert(running,'Forecast work is visible while running');
 assert.equal((await request('kronos/forecast',{})).status,400,'Only one concurrent model job');
 const outcome=await forecastPromise;
 assert.equal(outcome.status,200,JSON.stringify(outcome.body)+'\n'+logs);
 const result=outcome.body;
 assert.equal(result.model,'NeoQuasar/Kronos-mini');assert.equal(result.asset,'SOL');
 assert.equal(result.interval,'15m');assert.equal(result.horizon,8);assert.equal(result.lookback,128);
 assert.equal(result.forecast.length,8);assert.equal(result.history.length,32);
 assert.equal(result.read_only,true);assert.equal(result.submitted,false);assert.equal(result.samples,3);
 assert(result.last_completed_candle_time+900000<=Date.now(),'Input excludes unfinished row');
 result.forecast.forEach((p,i)=>{
  assert.equal(p.time,result.last_completed_candle_time+(i+1)*900000);
  assert(Number.isFinite(p.close)&&p.close>0,'Real model produces finite positive closes');
 });
 client=new Client({name:'kronos-e2e',version:'1'});
 await client.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp')));
 assert((await client.listTools()).tools.some(t=>t.name==='get_kronos_forecast'));
 const mcp=await client.callTool({name:'get_kronos_forecast',arguments:{}},undefined,{timeout:130000});
 assert(!mcp.isError,JSON.stringify(mcp));const cached=JSON.parse(mcp.content[0].text);
 assert.equal(cached.cached,true);assert.deepEqual(cached.forecast,result.forecast);
 assert.equal((await client.callTool({name:'get_kronos_forecast',arguments:{horizon:999}})).isError,true);
 // Cancel a different input (cache miss), then prove the server releases its worker.
 const cancel=new AbortController();
 const aborted=fetch(base+'/wallet/kronos/forecast',{method:'POST',
  headers:{Cookie:cookie,Origin:base,'Content-Type':'application/json','X-Wallet-Bridge':'1'},
  body:JSON.stringify({interval:'5m',horizon:24}),signal:cancel.signal}).then(()=>false,()=>true);
 for(let i=0;i<100;i++){if((await request('kronos/status')).body.busy)break;await delay(20);}
 await delay(100);cancel.abort();assert(await aborted,'Client cancelled request');
 let idle=false;
 for(let i=0;i<150;i++){idle=!(await request('kronos/status')).body.busy;if(idle)break;await delay(50);}
 assert(idle,'Cancelled worker exits and releases capacity');

 // Historical evaluation uses real model inference; independently recompute its scores.
 for(const args of [{horizon:25},{interval:'1s'},{lookback:999}]){
  assert.equal((await request('kronos/evaluate',args)).status,400);
 }
 assert.equal((await request('kronos/evaluate',{}, {Origin:'https://attacker.invalid'})).status,403);
 assert.equal((await fetch(base+'/wallet/kronos/evaluation/latest')).status,401);
 const evaluated=await client.callTool({name:'evaluate_kronos',arguments:{horizon:2}},undefined,{timeout:480000});
 assert(!evaluated.isError,JSON.stringify(evaluated)+'\n'+logs);
 const report=JSON.parse(evaluated.content[0].text);
 assert.equal(report.candle_count,152);assert.equal(report.selection_windows,6);assert.equal(report.holdout_windows,6);
 assert.equal(report.live_settings_changed,false);assert.equal(report.submitted,false);
 assert.equal(report.end_time+900000<=Date.now(),true);
 assert(report.rows.every(row=>row.actual.every(p=>p.close<200)),'Unfinished fixture price is excluded');
 const choice=report.tuning.reduce((best,next)=>next.mae_usd<best.mae_usd?next:best);
 assert.equal(report.selected_profile,choice.id,'Selection uses earlier-window MAE');
 for(const row of report.rows){
  assert.equal(row.actual[0].time,row.context_end+900000);
  assert.equal(row.predicted.length,2);
  row.predicted.forEach((p,i)=>assert.equal(p.time,row.actual[i].time));
  if(row.phase==='selection')assert(row.actual.at(-1).time<report.holdout_start);
  else assert(row.actual[0].time>=report.holdout_start);
 }
 const endpoints=report.rows.filter(r=>r.phase==='holdout'&&r.profile===report.selected_profile);
 assert.equal(new Set(endpoints.flatMap(r=>r.actual.map(p=>p.time))).size,12,'Holdout labels do not overlap');
 const near=(actual,expected)=>assert(Math.abs(actual-expected)<1e-8,actual+' != '+expected);
 for(const [phase,scores]of [['selection',report.tuning],['holdout',[...report.holdout,report.baseline]]]){
  for(const score of scores){
   const rows=report.rows.filter(r=>r.phase===phase&&r.profile===score.id);
   const errors=rows.flatMap(r=>r.actual.map((p,i)=>({delta:r.predicted[i].close-p.close,price:p.close})));
   near(score.mae_usd,errors.reduce((n,e)=>n+Math.abs(e.delta),0)/errors.length);
   near(score.rmse_usd,Math.sqrt(errors.reduce((n,e)=>n+e.delta**2,0)/errors.length));
   near(score.mape_pct,errors.reduce((n,e)=>n+Math.abs(e.delta)/e.price,0)/errors.length*100);
   assert.equal(score.direction_total,6);
  }
 }
 const saved=await request('kronos/evaluation/latest');
 assert.equal(saved.body.id,report.id,'Report persists for page reload');
 const archive=JSON.parse(await (await import('node:fs/promises')).readFile(new URL('../.runtime/kronos-evaluations-e2e/'+report.id+'.json',import.meta.url),'utf8'));
 assert.equal(archive.candles.length,152,'Exact numerical snippets retained for reproducibility');
 const checkHash=(await import('node:crypto')).createHash('sha256').update(JSON.stringify(archive.candles)).digest('hex');
 assert.equal(checkHash,report.dataset_hash);
 const cancelEval=new AbortController();
 const evalAbort=fetch(base+'/wallet/kronos/evaluate',{method:'POST',
  headers:{Cookie:cookie,Origin:base,'Content-Type':'application/json','X-Wallet-Bridge':'1'},
  body:JSON.stringify({horizon:24}),signal:cancelEval.signal}).then(()=>false,()=>true);
 for(let i=0;i<100;i++){if((await request('kronos/status')).body.busy)break;await delay(20);}
 cancelEval.abort();assert(await evalAbort);
 for(let i=0;i<150;i++){if(!(await request('kronos/status')).body.busy)break;await delay(50);}
 assert.equal((await request('kronos/status')).body.busy,false);
 assert.equal((await request('kronos/evaluation/latest')).body.id,report.id,'Cancellation must not replace the completed report');
 console.log('PASS: chronological snippet evaluation, real model context selection, non-overlapping holdout labels, independently recomputed MAE/RMSE/MAPE, unchanged-price baseline, reproducible archive, authenticated report access, cancellation and no live-setting changes.');

 const state=(await request('status')).body;
 assert.equal(state.connected,false);assert.equal(state.pending,null);assert.equal(state.entry_controls.locked,true);
 assert(!logs.includes('BROADCAST'),'No transaction submission path used');
 console.log('PASS: installed Kronos-mini inference through wallet HTTP and MCP, completed candles, bounded input, session/Origin checks, cache, concurrency, worker cancellation, and unchanged locked trading controls. No trades submitted.');
}catch(error){console.error(logs.slice(-4000));throw error;}
finally{
 await client?.close();
 if(child.exitCode===null&&child.signalCode===null){const stopped=once(child,'exit');child.kill();await stopped;}
}
