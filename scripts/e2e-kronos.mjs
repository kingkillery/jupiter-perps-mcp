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
 env:{...process.env,WALLET_MODE:'browser',WALLET_PRIVATE_KEY:'',MCP_MODE:'http',MCP_PORT:String(port)},
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
 const state=(await request('status')).body;
 assert.equal(state.connected,false);assert.equal(state.pending,null);assert.equal(state.entry_controls.locked,true);
 assert(!logs.includes('BROADCAST'),'No transaction submission path used');
 console.log('PASS: installed Kronos-mini inference through wallet HTTP and MCP, completed candles, bounded input, session/Origin checks, cache, concurrency, worker cancellation, and unchanged locked trading controls. No trades submitted.');
}catch(error){console.error(logs.slice(-4000));throw error;}
finally{
 await client?.close();
 if(child.exitCode===null&&child.signalCode===null){const stopped=once(child,'exit');child.kill();await stopped;}
}
