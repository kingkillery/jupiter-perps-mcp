// End-to-end external-service fixtures; never broadcast transactions.
import Module from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
const nativeLoader=Module._extensions['.node'];
Module._extensions['.node']=function(module,filename){if(filename.includes('bigint_buffer')){console.error('UNSAFE_NATIVE_BIGINT_ATTEMPT');throw new Error('Native bigint blocked');}return nativeLoader(module,filename);};
let modules;
async function setup(){
 if(!modules) modules=Promise.all([import('@solana/web3.js'),import('@coral-xyz/anchor'),import('@solana/spl-token'),import('../dist/idl/jupiter-perpetuals-idl.js'),import('../dist/constants.js')]);
 const [web3,anchor,spl,{IDL},{TOKENS}]=await modules;
 return {web3,anchor,spl,IDL,TOKENS};
}
let address;
const positionIds=[];
async function positions(wallet){
 const {web3}=await setup();address=wallet;
 if(!positionIds.length)for(const n of [7,8,9])positionIds.push(new web3.PublicKey(new Uint8Array(32).fill(n)).toBase58());
 return positionIds.map((positionPubkey,i)=>({positionPubkey,asset:'SOL',assetMint:'So11111111111111111111111111111111111111112',collateralToken:'USDC',collateralMint:'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',side:i===2?'short':'long',sizeUsd:'999000001',markPriceUsd:'119200000',entryPriceUsd:'119200000',liquidationPriceUsd:i===2?'130000000':'100000000',tpslRequests:i===1?[{requestType:'sl',entirePosition:true,positionRequestPubkey:new web3.PublicKey(new Uint8Array(32).fill(10)).toBase58(),triggerPriceUsd:'118600000'}]:[]}));
}
async function transaction(body,path,method){
 const {web3,anchor,spl,IDL}=await setup();
 const wallet=new web3.PublicKey(address),position=new web3.PublicKey(body.positionPubkey||positionIds[1]);
 const coder=new anchor.BorshInstructionCoder(IDL),BN=(await import('bn.js')).default;
 const definitions=path.endsWith('/positions/decrease')?[{kind:'partial',size:body.sizeUsdDelta}]:method==='PATCH'?[{kind:'update',triggerPrice:body.triggerPrice}]:body.tpsl;
 const instructions=definitions.map(item=>{
  const name=item.kind==='partial'?'instantDecreasePosition':item.kind==='update'?'instantUpdateTpsl':'instantCreateTpsl';
  const side=body.positionPubkey===positionIds[2]?'short':'long';
  const params=item.kind==='partial'?{collateralUsdDelta:new BN(0),sizeUsdDelta:new BN(item.size),priceSlippage:new BN(side==='long'?'116816000':'121584000'),entirePosition:false,requestTime:new BN(0)}:item.kind==='update'?{sizeUsdDelta:new BN(0),triggerPrice:new BN(item.triggerPrice),requestTime:new BN(0)}:{collateralUsdDelta:new BN(0),sizeUsdDelta:new BN(item.sizeUsdDelta||'0'),triggerPrice:new BN(item.triggerPrice),triggerAboveThreshold:(side==='long')===(item.requestType==='tp'),entirePosition:item.entirePosition,counter:new BN(1),requestTime:new BN(0)};
  const mint=new web3.PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
  const keys=IDL.instructions.find(ix=>ix.name===name).accounts.map(account=>({isSigner:account.isSigner,isWritable:account.isMut,pubkey:account.name==='owner'||account.isSigner?wallet:account.name==='position'?position:account.name==='positionRequest'&&body.positionRequestPubkey?new web3.PublicKey(body.positionRequestPubkey):account.name==='desiredMint'?mint:account.name==='receivingAccount'?spl.getAssociatedTokenAddressSync(mint,wallet):web3.SystemProgram.programId}));
  return new web3.TransactionInstruction({programId:new web3.PublicKey('PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu'),keys,data:coder.encode(name,{params})});
 });
 const tx=new web3.VersionedTransaction(new web3.TransactionMessage({payerKey:wallet,recentBlockhash:web3.SystemProgram.programId.toBase58(),instructions}).compileToV0Message());
 return {serializedTxBase64:Buffer.from(tx.serialize()).toString('base64'),requireKeeperSignature:true,txMetadata:{}};
}
globalThis.fetch=async(input,init={})=>{
 const url=new URL(String(input));await delay(35);
 if(url.origin==='https://ultra-api.jup.ag'&&url.pathname.startsWith('/holdings/'))return Response.json({tokens:{EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v:[{uiAmount:12.5}]}});
 if(url.origin==='https://api.kraken.com'&&url.pathname==='/0/public/OHLC'){
  const pair=url.searchParams.get('pair'),interval=Number(url.searchParams.get('interval'));
  if(!['SOLUSD','ETHUSD','XBTUSD'].includes(pair)||![5,15,60,240,1440,10080].includes(interval))throw Error('Invalid fixture candle request');
  const ms=interval*60000,current=Math.floor(Date.now()/ms)*ms;
  const rows=Array.from({length:161},(_,i)=>[Math.floor((current-(160-i)*ms)/1000),'118.5','119','118','118.6','118.5','10',10]);
  return Response.json({error:[],result:{[pair]:rows,last:current/1000}});
 } if(url.origin==='https://perps-api.jup.ag'){
  if(url.pathname==='/v1/positions')return Response.json({dataList:[],count:0});
  if(url.pathname==='/v2/positions')return Response.json({dataList:await positions(url.searchParams.get('walletAddress')),count:3});
  if(url.pathname==='/v2/transaction/execute')throw new Error('BROADCAST_FORBIDDEN_BY_E2E');
  if(['/v2/tpsl','/v2/positions/decrease'].includes(url.pathname))return Response.json(await transaction(JSON.parse(init.body),url.pathname,init.method));
 }
 if(url.origin==='https://api.mainnet-beta.solana.com'){
  const request=JSON.parse(init.body);const {web3,anchor,IDL,TOKENS}=await setup();let result;
  if(request.method==='getAccountInfo'){
   const index=positionIds.indexOf(request.params[0]);if(index<0)throw new Error('Unknown fixture account');
   const BN=(await import('bn.js')).default;
   const data=await new anchor.BorshAccountsCoder(IDL).encode('position',{owner:new web3.PublicKey(address),pool:web3.SystemProgram.programId,custody:TOKENS.SOL.custodyAccount,collateralCustody:TOKENS.USDC.custodyAccount,openTime:new BN(0),updateTime:new BN(0),side:index===2?{short:{}}:{long:{}},price:new BN('119200000'),sizeUsd:new BN('999000001'),collateralUsd:new BN('900000000'),realisedPnlUsd:new BN(0),cumulativeInterestSnapshot:new BN(0),lockedAmount:new BN(0),bump:1});
   result={context:{slot:1},value:{owner:'PERPHjGBqRHArX4DySjwM6UJHiR3sWAatqfdBS2qQJu',data:[data.toString('base64'),'base64'],executable:false,lamports:1000000,rentEpoch:0}};
  }else if(request.method==='simulateTransaction')result={context:{slot:1},value:{err:null,logs:[],unitsConsumed:100000}};
  else throw new Error(`RPC method blocked in E2E: ${request.method}`);
  return Response.json({jsonrpc:'2.0',id:request.id,result});
 }
 throw new Error('Unexpected external request blocked by end-to-end harness');
};
