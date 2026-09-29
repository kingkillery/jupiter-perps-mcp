import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import net from 'node:net';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { Keypair } from '@solana/web3.js';
import bs58 from 'bs58';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

// End-to-end HTTP checks use an ephemeral unfunded wallet. No trading calls.
const probe = net.createServer();
probe.listen(0, '127.0.0.1');
await once(probe, 'listening');
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const wallet = Keypair.generate();
const child = spawn(process.execPath, ['--import', './scripts/e2e-upstream.mjs', 'dist/index.js'], {
  cwd: new URL('..', import.meta.url), windowsHide: true,
  env: {...process.env, WALLET_PRIVATE_KEY: bs58.encode(wallet.secretKey),
    WALLET_MODE: 'keypair', MCP_MODE: 'http', MCP_PORT: String(port), RPC_URL: 'https://api.mainnet-beta.solana.com'},
  stdio: ['ignore','pipe','pipe'],
});
let logs = '';
child.stdout.on('data', chunk => { logs += chunk; });
child.stderr.on('data', chunk => { logs += chunk; });
const base = `http://127.0.0.1:${port}`;
const clients = [];
try {
  let health;
  for (let i=0; i<100; i++) {
    if (child.exitCode !== null) throw new Error(`Server exited: ${logs}`);
    try { health = await fetch(`${base}/health`, {signal: AbortSignal.timeout(1000)}); break; }
    catch { await delay(100); }
  }
  assert(health, 'Server must start');
  assert.equal(health.status,200);
  assert.equal((await health.json()).wallet,wallet.publicKey.toBase58());
  for (const headers of [{Host:'attacker.invalid'}, {Origin:'https://attacker.invalid'}, {Origin:'null'}]) {
    const status = await new Promise((resolve,reject) => {
      const req=http.get(`${base}/health`,{headers},res=>{res.resume();resolve(res.statusCode);});
      req.on('error',reject);
    });
    assert.equal(status,403,`Untrusted Host/Origin must be rejected: ${JSON.stringify(headers)}`);
  }
  const tooBig=await fetch(`${base}/mcp`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({data:'x'.repeat(70000)})});
  assert.equal(tooBig.status,413,'Oversized requests must be rejected');
  for (let i=0;i<2;i++) {
    const client=new Client({name:'setup-e2e',version:'1.0.0'});
    await client.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`)));
    clients.push(client);
  }
  const listings=await Promise.all(clients.flatMap(client => Array.from({length:5},()=>client.listTools())));
  for (const listing of listings) assert.equal(listing.tools.length,19);
  const portfolios=await Promise.all(clients.flatMap(client => Array.from({length:2},()=>client.callTool({name:'get_account_portfolio',arguments:{}}))));
  for(const result of portfolios) {
    assert(!result.isError,JSON.stringify(result));
    const portfolio=JSON.parse(result.content[0].text);
    assert.equal(portfolio.usdc_balance,12.5);
    assert.equal(portfolio.total_equity,12.5);
    assert.deepEqual(portfolio.positions,[]);
  }
  assert(!logs.includes('UNSAFE_NATIVE_BIGINT_ATTEMPT'),'Native bigint addon must never be attempted');
  const invoke=async(name,args={})=>{
    const result=await clients[0].callTool({name,arguments:args});
    assert(!result.isError,JSON.stringify(result));return JSON.parse(result.content[0].text);
  };
  const records=await invoke('get_protective_orders');
  assert.equal(records.positions.length,3);
  const [long,protectedLong,short]=records.positions;
  const stop=await invoke('set_protective_stop',{position:long.positionPubkey,stop_price_usd:118.6});
  assert.equal(stop.status,'preview_only');assert.equal(stop.orders[0].entire,true);
  const shortStop=await invoke('set_protective_stop',{position:short.positionPubkey,stop_price_usd:119.3});
  assert.equal(shortStop.orders[0].trigger,'119300000');
  const updated=await invoke('set_protective_stop',{position:protectedLong.positionPubkey,stop_price_usd:118.6});
  assert.equal(updated.action,'update-tpsl');
  const ladder=await invoke('set_take_profit_ladder',{position:protectedLong.positionPubkey,target_prices_usd:[119.9,120.6,121]});
  assert.deepEqual(ladder.orders.map(order=>order.size),['333000000','333000000','333000001']);
  const partial=await invoke('close_position_partial',{position:long.positionPubkey,size_usd:333});
  assert.equal(partial.orders[0].size,'333000000');assert.equal(partial.submitted,false);
  for(const [name,args] of [
    ['set_protective_stop',{position:long.positionPubkey,stop_price_usd:120}],
    ['set_take_profit_ladder',{position:long.positionPubkey,target_prices_usd:[119.9,120.6,121]}],
    ['close_position_partial',{position:long.positionPubkey,size_usd:1000}],
    ['open_position',{asset:'SOL',side:'Long',collateral_amount:10,leverage:1.1}]
  ])assert.equal((await clients[0].callTool({name,arguments:args})).isError,true,name+' must fail closed');
  const candles=await invoke('get_candles',{asset:'SOL',interval:'15m',limit:10});
  assert.equal(candles.source,'Kraken spot USD');assert.equal(candles.data.length,10);
  assert(candles.data.at(-1).time*1000+900000<=Date.now(),'The unfinished Kraken row must be omitted');  const rejected=await clients[0].callTool({name:'get_candles',arguments:{asset:'INVALID',interval:'1h',limit:10}});
  assert.equal(rejected.isError,true);
  assert.match(rejected.content[0].text,/Invalid asset/);
  assert(!logs.includes('bigint: Failed to load bindings'));
  console.log('PASS: HTTP health, wallet loading, MCP handshake, 10 concurrent tool listings, 4 overlapping portfolios (external API fixtures), native-addon guard, input rejection, Host/Origin rejection, body limit, native long/short stops, stop updates, exact-third ladder, partial close previews, risk rejection. No trades submitted.');
} finally {
  await Promise.allSettled(clients.map(client=>client.close()));
  if (child.exitCode === null && child.signalCode === null) {
    const stopped = once(child, 'exit');
    child.kill();
    await stopped;
  }
}
