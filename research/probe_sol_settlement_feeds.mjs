// Read-only settlement-source probe. Saves raw responses under the ignored research runtime.
// Does not read wallet variables, inspect market outcomes, or place orders.
import {createHash,createHmac,createPrivateKey,sign,constants} from 'node:crypto';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import dotenv from 'dotenv';

dotenv.config({path:new URL('../.env',import.meta.url),quiet:true});
const out=new URL('../.runtime/sol-reference-data/',import.meta.url);
await mkdir(out,{recursive:true});
const digest=data=>createHash('sha256').update(data).digest('hex');
const status={research_only:true,checked_at:new Date().toISOString(),kalshi:{},chainlink:{}};

async function checkedGet(url,headers){
  const response=await fetch(url,{headers:{Accept:'application/json',...headers},signal:AbortSignal.timeout(30000)});
  const body=await response.text();
  if(!response.ok)return {http_status:response.status};
  let data;
  try{data=JSON.parse(body);}catch{return {http_status:response.status,parse_error:true};}
  return {http_status:response.status,data,sha256:digest(body),bytes:Buffer.byteLength(body)};
}

function kalshiHeaders(path,key){
  const timestamp=String(Date.now());
  const privateKey=createPrivateKey(key);
  const message=Buffer.from(`${timestamp}GET${path}`);
  const signature=privateKey.asymmetricKeyType==='ed25519'?
    sign(null,message,privateKey):
    sign('sha256',message,{key:privateKey,padding:constants.RSA_PKCS1_PSS_PADDING,saltLength:constants.RSA_PSS_SALTLEN_DIGEST});
  return {'KALSHI-ACCESS-KEY':process.env.KALSHI_API_KEY_ID,
    'KALSHI-ACCESS-TIMESTAMP':timestamp,'KALSHI-ACCESS-SIGNATURE':signature.toString('base64')};
}

async function probeKalshi(){
  if(!process.env.KALSHI_API_KEY_ID||!process.env.KALSHI_PRIVATE_KEY_PATH){status.kalshi.state='credentials_missing';return;}
  let key;
  try{key=await readFile(process.env.KALSHI_PRIVATE_KEY_PATH);}catch{status.kalshi.state='private_key_file_unreadable';return;}
  const path='/trade-api/v2/cfbenchmarks/history/values';
  const url=new URL(`https://external-api.kalshi.com${path}`);
  url.searchParams.set('id','SOLUSD_RTI');
  url.searchParams.set('timespan','HOUR');
  url.searchParams.set('timestamp','2026-09-07T12:15:00.000Z');
  const response=await checkedGet(url,kalshiHeaders(path,key));
  status.kalshi={index_id:'SOLUSD_RTI',requested_timestamp:'2026-09-07T12:15:00.000Z',
    http_status:response.http_status};
  if(response.data){
    await writeFile(new URL('kalshi-cf-solusd-rti-probe.json',out),JSON.stringify({source_url:url.toString(),retrieved_at:new Date().toISOString(),payload:response.data}));
    status.kalshi.state='raw_history_archived';
    status.kalshi.sha256=response.sha256;
    status.kalshi.bytes=response.bytes;
    status.kalshi.payload_keys=Object.keys(response.data);
  }else status.kalshi.state=response.parse_error?'non_json_response':'unavailable';
}

function chainlinkHeaders(path){
  const timestamp=String(Date.now());
  const bodyHash=digest('');
  const message=`GET ${path} ${bodyHash} ${process.env.CHAINLINK_API_KEY} ${timestamp}`;
  const signature=createHmac('sha256',process.env.CHAINLINK_USER_SECRET).update(message).digest('hex');
  return {Authorization:process.env.CHAINLINK_API_KEY,
    'X-Authorization-Timestamp':timestamp,'X-Authorization-Signature-SHA256':signature};
}

async function probeChainlink(){
  if(!process.env.CHAINLINK_API_KEY||!process.env.CHAINLINK_USER_SECRET){status.chainlink.state='credentials_missing';return;}
  const path='/api/v1/discovery?base_asset=SOL&quote_asset=USD&hidden=true';
  const url=`https://api.dataengine.chain.link${path}`;
  const response=await checkedGet(url,chainlinkHeaders(path));
  status.chainlink={http_status:response.http_status};
  if(response.data){
    const feeds=Array.isArray(response.data.feeds)?response.data.feeds:[];
    const metadata=feeds.map(f=>({feed_id:f.feedId,name:f.name,attribute_type:f.attributeType,
      status:f.status,schema_version:f.schemaVersion}));
    await writeFile(new URL('chainlink-sol-discovery-probe.json',out),JSON.stringify({source_url:url,retrieved_at:new Date().toISOString(),feeds:metadata}));
    status.chainlink.state='catalog_archived';
    status.chainlink.feed_count=metadata.length;
    status.chainlink.twap_candidates=metadata.filter(f=>/twap/i.test(`${f.name} ${f.attribute_type}`));
  }else status.chainlink.state=response.parse_error?'non_json_response':'unavailable';
}

try{await probeKalshi();}catch(error){status.kalshi={state:'probe_failed',error_code:error.cause?.code||error.code||error.name};}
try{await probeChainlink();}catch(error){status.chainlink={state:'probe_failed',error_code:error.cause?.code||error.code||error.name};}
await writeFile(new URL('settlement-feed-probe-status.json',out),JSON.stringify(status,null,2));
console.log(JSON.stringify(status,null,2));
