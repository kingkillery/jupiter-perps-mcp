import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import net from 'node:net';
import {Keypair,VersionedTransaction} from '@solana/web3.js';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const probe=net.createServer();probe.listen(0,'127.0.0.1');await once(probe,'listening');const port=probe.address().port;await new Promise(resolve=>probe.close(resolve));
const base=`http://127.0.0.1:${port}`,wallet=Keypair.generate();
const child=spawn(process.execPath,['--import','./scripts/e2e-upstream.mjs','dist/index.js'],{cwd:new URL('..',import.meta.url),windowsHide:true,env:{...process.env,WALLET_MODE:'browser',WALLET_PRIVATE_KEY:'',MCP_MODE:'http',MCP_PORT:String(port),RPC_URL:'https://api.mainnet-beta.solana.com'},stdio:['ignore','pipe','pipe']});
let logs='';child.stderr.on('data',data=>{logs+=data;});
let client;
try{
 for(let i=0;i<100;i++){if(child.exitCode!==null)throw new Error(logs);try{await fetch(base+'/health');break;}catch{await delay(100);}}
 assert.equal((await fetch(base+'/wallet/status')).status,401);
 const page=await fetch(base+'/wallet');assert.equal(page.status,200);assert((await page.text()).includes('Connect Jupiter Wallet'));
 assert.match(page.headers.get('content-security-policy'),/frame-ancestors 'none'/);
 const cookie=page.headers.get('set-cookie').split(';')[0];
 const request=async(path,body,headers={})=>{
  const response=await fetch(base+'/wallet/'+path,{method:body===undefined?'GET':'POST',headers:{Cookie:cookie,...(body===undefined?{}:{Origin:base,'Content-Type':'application/json','X-Wallet-Bridge':'1'}),...headers},body:body===undefined?undefined:JSON.stringify(body)});
  return {status:response.status,body:await response.json()};
 };
 assert.equal((await request('connect',{address:wallet.publicKey.toBase58()},{Origin:'https://attacker.invalid'})).status,403);
 assert.equal((await request('connect',{address:wallet.publicKey.toBase58()},{'X-Wallet-Bridge':''})).status,403);
 assert.equal((await request('connect',{address:wallet.publicKey.toBase58()})).status,200);
 assert.equal((await request('status')).body.address,wallet.publicKey.toBase58());
 client=new Client({name:'wallet-e2e',version:'1'});await client.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp')));
 const records=await client.callTool({name:'get_protective_orders',arguments:{}});
 assert(!records.isError);const position=JSON.parse(records.content[0].text).positions[0].positionPubkey;
 async function pending(){for(let i=0;i<100;i++){const state=await request('status');if(state.body.pending)return state.body.pending;await delay(30);}throw new Error('Approval not queued');}
 const rejectCall=client.callTool({name:'set_protective_stop',arguments:{position,stop_price_usd:118.6,dry_run:false}});
 const rejectJob=await pending();assert.equal((await request('approval',{id:rejectJob.id,reject:true})).status,200);
 assert.equal((await rejectCall).isError,true);
 assert.equal((await request('approval',{id:rejectJob.id,reject:true})).status,409);
 const invalidCall=client.callTool({name:'set_protective_stop',arguments:{position,stop_price_usd:118.6,dry_run:false}});
 const invalidJob=await pending();
 const unsigned=VersionedTransaction.deserialize(Buffer.from(invalidJob.transaction,'base64'));
 assert.equal((await request('approval',{id:invalidJob.id,signedTransaction:Buffer.from(unsigned.serialize()).toString('base64')})).status,400);
 assert.equal((await invalidCall).isError,true);
 const signCall=client.callTool({name:'set_protective_stop',arguments:{position,stop_price_usd:118.6,dry_run:false}});
 const signJob=await pending();const signed=VersionedTransaction.deserialize(Buffer.from(signJob.transaction,'base64'));signed.sign([wallet]);
 assert.equal((await request('approval',{id:signJob.id,signedTransaction:Buffer.from(signed.serialize()).toString('base64')})).status,200);
 const stopped=await signCall;assert.equal(stopped.isError,true);assert.match(stopped.content[0].text,/BROADCAST_FORBIDDEN_BY_E2E/);
 const disconnectCall=client.callTool({name:'set_protective_stop',arguments:{position,stop_price_usd:118.6,dry_run:false}});
 await pending();await request('disconnect',{});assert.equal((await disconnectCall).isError,true);
 assert.equal((await request('status')).body.connected,false);
 console.log('PASS: browser-mode startup without private key, CSP/session/Origin checks, wallet connection, rejected/replayed/unsigned approval rejection, valid ephemeral signature verification, disconnect cancellation. All network access and broadcast mocked/blocked.');
}finally{
 await client?.close();
 if(child.exitCode===null&&child.signalCode===null){const stopped=once(child,'exit');child.kill();await stopped;}
}
