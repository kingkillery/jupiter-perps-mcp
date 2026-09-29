import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import net from 'node:net';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';

const probe=net.createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');
const port=probe.address().port;await new Promise(done=>probe.close(done));
const base='http://127.0.0.1:'+port;
const child=spawn(process.execPath,['--import','./scripts/e2e-upstream.mjs','dist/index.js'],{
 cwd:new URL('..',import.meta.url),windowsHide:true,
 env:{...process.env,NODE_ENV:'test',E2E_CANDIDATES:'1',OPENROUTER_API_KEY:'e2e-synthetic',WALLET_PRIVATE_KEY:'',WALLET_MODE:'browser',MCP_MODE:'http',MCP_PORT:String(port)},
 stdio:['ignore','pipe','pipe']});
let logs='',client;child.stderr.on('data',chunk=>{logs+=chunk;});
try{
 let started=false;
 for(let i=0;i<120;i++){if(child.exitCode!==null)throw Error(logs);try{started=(await fetch(base+'/health')).ok;if(started)break;}catch{}await delay(100);}
 assert(started,'candidate server started');
 assert.equal((await fetch(base+'/wallet/candidates/latest')).status,401);
 const page=await fetch(base+'/wallet'),html=await page.text();
 assert.match(html,/id="candidate-scan"/);assert.match(html,/id="candidate-list"/);
 assert.match(html,/<details class="research-panel">/);
 const bundle=await (await fetch(base+'/wallet/app.js')).text();
 assert(!bundle.includes('Review in entry controls'),'research UI has no entry-review action');
 assert.match(html,/id="candidate-history"/);
 assert.match(html,/id="candidate-key"[^>]*type="password"/);
 const cookie=page.headers.get('set-cookie').split(';')[0];
 const request=async(path,body,headers={})=>{
  const response=await fetch(base+'/wallet/candidates/'+path,{method:body===undefined?'GET':'POST',
   headers:{Cookie:cookie,...(body===undefined?{}:{Origin:base,'Content-Type':'application/json','X-Wallet-Bridge':'1'}),...headers},
   body:body===undefined?undefined:JSON.stringify(body)});
  return {status:response.status,body:await response.json()};
 };
 assert.equal((await request('status')).body.configured,true);
 assert.equal((await request('history/latest')).status,404);
 assert.equal((await request('key',{key:'sk-or-v1-'+('a'.repeat(40))},{Origin:'https://evil.invalid'})).status,403);
 assert.equal((await request('key',{key:'short'})).status,400);
 const savedKey=await request('key',{key:'sk-or-v1-'+('a'.repeat(40))});
 assert.deepEqual(savedKey,{status:200,body:{configured:true}});
 assert(!JSON.stringify(savedKey).includes('sk-or-v1-'));
 assert.equal((await request('scan',{}, {Origin:'https://evil.invalid'})).status,403);
 assert.equal((await request('scan',{wallet_key:'x'})).status,400);
 const scanPromise=request('scan',{});
 let busy=false;
 for(let i=0;i<100;i++){busy=(await request('status')).body.busy;if(busy)break;await delay(30);}
 assert(busy);assert.equal((await request('scan',{})).status,400,'overlapping scan rejected');
 const outcome=await scanPromise;
 assert.equal(outcome.status,200,JSON.stringify(outcome.body)+'\n'+logs);
 const scan=outcome.body;
 assert.equal(scan.status,'research_flagged');
 assert.equal(scan.decision.id,'sol_short');assert.equal(scan.decision.provider,'openrouter');
 assert.equal(scan.decision.model,'typesafe/jev-1.13-fixture');
 assert.equal(scan.ranked[0].id,'sol_short');
 assert.equal(scan.ranked[0].selection_share,.82);
 assert.equal(scan.submitted,false);assert.equal(scan.read_only,true);
 assert(scan.snapshot.lanes.length===4);
 assert(scan.snapshot.lanes.every(l=>l.recent_candles.length===12));
 assert(scan.snapshot.lanes.every(l=>l.last_completed_time+({'15m':900000,'1h':3600000}[l.interval])<=Date.now()));
 assert(scan.snapshot.forecast?.forecast.length===8);
 assert(scan.snapshot.evaluation===null || Array.isArray(scan.snapshot.evaluation.holdout));
 assert(scan.snapshot.candidates.every(c=>c.execution_scope==='analysis_only'));
 assert.equal((await request('latest')).body.id,scan.id);
 const outcomeCheck=await request('outcome',{});
 assert.equal(outcomeCheck.body.status,'pending');
 client=new Client({name:'candidate-e2e',version:'1'});
 await client.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp')));
 const tools=(await client.listTools()).tools.map(t=>t.name);
 assert(tools.includes('scan_trade_candidates')&&tools.includes('get_candidate_inbox'));
 const saved=await client.callTool({name:'get_candidate_inbox',arguments:{}});
 assert(!saved.isError);assert.equal(JSON.parse(saved.content[0].text).id,scan.id);
 const statusResponse=await fetch(base+'/wallet/status',{headers:{Cookie:cookie}});
 const status=await statusResponse.json();
 assert.equal(status.connected,false);assert.equal(status.pending,null);
 assert.equal(status.entry_controls.locked,true);
 assert(!logs.includes('BROADCAST_FORBIDDEN_BY_E2E'));
 console.log('PASS: full candidate scan with real market/candle/Kronos fan-out, typed Jev routing fixture, archived evidence, authenticated UI, MCP access, overlapping-scan rejection, and locked wallet controls. No trades submitted.');
}catch(error){console.error(logs.slice(-4000));throw error;}
finally{await client?.close();if(child.exitCode===null&&child.signalCode===null){const stopped=once(child,'exit');child.kill();await stopped;}}

// A malformed hosted choice must never enter the review route or replace a valid saved scan.
const badProbe=net.createServer();badProbe.listen(0,'127.0.0.1');await once(badProbe,'listening');
const badPort=badProbe.address().port;await new Promise(done=>badProbe.close(done));
const badBase='http://127.0.0.1:'+badPort;
const bad=spawn(process.execPath,['--import','./scripts/e2e-upstream.mjs','dist/index.js'],{
 cwd:new URL('..',import.meta.url),windowsHide:true,
 env:{...process.env,NODE_ENV:'test',E2E_CANDIDATES:'1',E2E_BAD_JEV:'1',OPENROUTER_API_KEY:'e2e-synthetic',WALLET_PRIVATE_KEY:'',WALLET_MODE:'browser',MCP_MODE:'http',MCP_PORT:String(badPort)},
 stdio:['ignore','pipe','pipe']});
let badLogs='';bad.stderr.on('data',x=>{badLogs+=x;});
try{
 let ready=false;
 for(let i=0;i<120;i++){if(bad.exitCode!==null)throw Error(badLogs);try{ready=(await fetch(badBase+'/health')).ok;if(ready)break;}catch{}await delay(100);}
 assert(ready);
 const page=await fetch(badBase+'/wallet'),cookie=page.headers.get('set-cookie').split(';')[0];
 const response=await fetch(badBase+'/wallet/candidates/scan',{method:'POST',headers:{Cookie:cookie,Origin:badBase,'Content-Type':'application/json','X-Wallet-Bridge':'1'},body:'{}'});
 assert.equal(response.status,400);
 assert.match((await response.json()).error,/invalid choice/i);
 const saved=await fetch(badBase+'/wallet/candidates/latest',{headers:{Cookie:cookie}});
 assert.equal((await saved.json()).decision.id,'sol_short');
 console.log('PASS: a malformed Jev choice fails closed and preserves the last valid candidate scan.');
}finally{if(bad.exitCode===null&&bad.signalCode===null){const stopped=once(bad,'exit');bad.kill();await stopped;}}
