import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import net from 'node:net';
import {Keypair,VersionedTransaction} from '@solana/web3.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';

async function run(scenario){
 const probe=net.createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(r=>probe.close(r));
 const base='http://127.0.0.1:'+port,wallet=Keypair.generate();
 const child=spawn(process.execPath,['--import','./scripts/e2e-entry-upstream.mjs','dist/index.js'],{cwd:new URL('..',import.meta.url),windowsHide:true,env:{...process.env,E2E_ENTRY_SCENARIO:scenario,WALLET_MODE:'browser',WALLET_PRIVATE_KEY:'',MCP_MODE:'http',MCP_PORT:String(port)},stdio:['ignore','pipe','pipe']});
 let logs='',client;child.stderr.on('data',b=>logs+=b);
 try{
  for(let i=0;i<100;i++){if(child.exitCode!==null)throw Error(logs);try{await fetch(base+'/health');break;}catch{await delay(100);}}
  const page=await fetch(base+'/wallet');assert.match(await page.text(),/Entry controls/);
  const cookie=page.headers.get('set-cookie').split(';')[0];
  async function req(path,body,overrides={}){
   const r=await fetch(base+'/wallet/'+path,{method:body===undefined?'GET':'POST',headers:{Cookie:cookie,...(body===undefined?{}:{Origin:base,'X-Wallet-Bridge':'1','Content-Type':'application/json'}),...overrides},body:body===undefined?undefined:JSON.stringify(body)});
   return {status:r.status,body:await r.json()};
  }
  assert.equal((await req('entry/unlock',{})).status,403);
  await req('connect',{address:wallet.publicKey.toBase58()});
  assert.equal((await req('controls')).body.locked,true);
  const args={side:'short',collateral_usdc:10,leverage:1.1,slippage_bps:10,holding_hours:1};
  const p=await req('entry/preview',args);assert.equal(p.status,200,JSON.stringify(p.body));
  assert.equal(p.body.submitted,false);assert.equal(p.body.targets.length,3);
  assert.equal(p.body.targets.reduce((sum,t)=>sum+Math.round(t.size_usd*1e6),0),Math.round(p.body.size_usd*1e6));
  if(scenario==='missing_feed'){assert(p.body.blockers.some(b=>/candle feed is unavailable/.test(b)));assert(p.body.risk.planned_loss_usd>0);return;}
  if(scenario==='stale_candles'){assert(p.body.blockers.some(b=>/candle feed is unavailable/.test(b)));return;}
  if(scenario==='divergent_price'){assert(p.body.blockers.some(b=>/spot candle price differs/.test(b)));return;}
  assert(p.body.eligible_for_preparation,JSON.stringify(p.body));
  assert(p.body.risk.planned_loss_usd<=5);
  assert.equal((await req('entry/review',{preview_id:p.body.preview_id,signal_confirmed:true})).status,400);
  await req('entry/unlock',{});
  assert.equal((await req('entry/review',{preview_id:p.body.preview_id,signal_confirmed:false})).status,400);
  if(scenario!=='safe'){
   const rejected=await req('entry/review',{preview_id:p.body.preview_id,signal_confirmed:true});
   assert.equal(rejected.status,400);const rejection={missing_target:/missing.*target/i,excess_slippage:/slippage/i,wrong_market:/perpetuals/i,keeper_change:/Keeper signers changed/i,wrong_destination:/receiving account/i,extra_signer:/Unexpected required transaction signer/i};
   assert.match(rejected.body.error,rejection[scenario]);
   assert.equal((await req('status')).body.pending,null);return;
  }
  for(const patch of [{leverage:7.1},{slippage_bps:201},{collateral_usdc:-1},{holding_hours:0},{max_planned_loss_usd:50}]){
   assert.equal((await req('entry/preview',{...args,...patch})).status,400,JSON.stringify(patch));
  }
  const wide=await req('entry/preview',{...args,slippage_bps:200});assert(wide.body.blockers.some(b=>/Slippage must/.test(b)));
  const big=await req('entry/preview',{...args,collateral_usdc:900,leverage:7});assert(big.body.blockers.some(b=>/exceeds \$5/.test(b)));
  const insufficient=await req('entry/preview',{...args,collateral_usdc:1001});assert(insufficient.body.blockers.some(b=>/Insufficient USDC/.test(b)));
  assert.equal((await req('entry/unlock',{}, {Origin:'https://attacker.invalid'})).status,403);
  client=new Client({name:'entry-controls-e2e',version:'1'});await client.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp')));
  const viaMcp=await client.callTool({name:'preview_strategy_entry',arguments:args});assert(!viaMcp.isError);
  assert.equal((await client.callTool({name:'open_position',arguments:{asset:'SOL',side:'Short',collateral_amount:10,leverage:1.1}})).isError,true);
  const pending=async()=>{for(let i=0;i<100;i++){const s=(await req('status')).body;if(s.pending)return s.pending;await delay(30);}throw Error('No approval queued');};
  const first=await req('entry/preview',args);
  const review=req('entry/review',{preview_id:first.body.preview_id,signal_confirmed:true});
  await pending();
  await req('entry/lock',{});
  assert.equal((await review).status,400);assert.equal((await req('status')).body.pending,null);
  await req('entry/unlock',{});
  assert.equal((await req('entry/review',{preview_id:first.body.preview_id,signal_confirmed:true})).status,400);
  const fresh=await req('entry/preview',args);
  const signCall=req('entry/review',{preview_id:fresh.body.preview_id,signal_confirmed:true});
  const job=await pending();assert.match(job.summary,/all three targets/);
  const tx=VersionedTransaction.deserialize(Buffer.from(job.transaction,'base64'));tx.sign([wallet]);
  assert.equal((await req('approval',{id:job.id,signedTransaction:Buffer.from(tx.serialize()).toString('base64')})).status,200);
  const result=await signCall;assert.equal(result.status,400);assert.match(result.body.error,/BROADCAST_FORBIDDEN_BY_E2E/);
  assert.equal((await req('controls')).body.locked,true);
  assert.equal((await req('entry/unlock',{})).status,400,'Ambiguous submission must latch against duplicates');
  assert.equal((await req('approval',{id:job.id,reject:true})).status,409);
 }finally{await client?.close();if(child.exitCode===null&&child.signalCode===null){const stopped=once(child,'exit');child.kill();await stopped;}}
}
for(const scenario of ['safe','missing_target','excess_slippage','stale_candles','missing_feed','divergent_price','wrong_market','keeper_change','wrong_destination','extra_signer']){await run(scenario);console.log('PASS entry controls: '+scenario);}
console.log('PASS: real HTTP/MCP risk controls, mandatory defaults, server caps, quote costs, exact thirds, balance/sequence/slippage rejection, atomic-protection validation, wallet-only review, lock/cancellation, valid synthetic approval, and duplicate-submission latch. No live transactions.');
