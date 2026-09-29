// External-service fixtures for real HTTP entry-control end-to-end tests. Never broadcast.
import './e2e-upstream.mjs';
const originalFetch=globalThis.fetch;
const scenario=process.env.E2E_ENTRY_SCENARIO||'safe';
let modules;
async function load(){
 if(!modules)modules=Promise.all([import('@solana/web3.js'),import('@coral-xyz/anchor'),import('@solana/spl-token'),import('../dist/idl/jupiter-perpetuals-idl.js'),import('../dist/constants.js'),import('../dist/utils/program.js'),import('bn.js')]);
 const [web3,anchor,spl,{IDL},{TOKENS},program,{default:BN}]=await modules;
 return {web3,anchor,spl,IDL,TOKENS,program,BN};
}
let address;
function quote(body,raw=false){
 const collateral=Number(body.collateralTokenDelta||body.inputTokenAmount)/1e6;
 const size=body.sizeUsdDelta?Number(body.sizeUsdDelta)/1e6:collateral*Number(body.leverage);
 const scalar=raw?1e6:1;
 return {entryPriceUsd:'118.7',averagePriceUsd:'118700000',positionSizeUsd:String(size*scalar),sizeUsdDelta:String(Math.round(size*1e6)),positionCollateralSizeUsd:String(collateral),positionCollateralUsd:String(Math.round(collateral*1e6)),leverage:String(size/collateral),liquidationPriceUsd:String(210*scalar),openFeeUsd:String(size*.0006*scalar),priceImpactFeeUsd:String(size*.0001*scalar),outstandingBorrowFeeUsd:'0'};
}
async function prepared(body){
 const {web3,anchor,spl,IDL,TOKENS,program,BN}=await load();
 const wallet=new web3.PublicKey(body.walletAddress),PROGRAM=program.JUPITER_PERPETUALS_PROGRAM_ID;
 const position=program.generatePositionPda({walletAddress:wallet,custody:TOKENS.SOL.custodyAccount,collateralCustody:TOKENS.USDC.custodyAccount,side:'short'}).position;
 const perpetuals=web3.PublicKey.findProgramAddressSync([Buffer.from('perpetuals')],PROGRAM)[0];
 const eventAuthority=web3.PublicKey.findProgramAddressSync([Buffer.from('__event_authority')],PROGRAM)[0];
 const coder=new anchor.BorshInstructionCoder(IDL);
 const definitions=[{name:'instantIncreasePosition',params:{collateralTokenDelta:new BN(body.inputTokenAmount),sizeUsdDelta:new BN(body.sizeUsdDelta),side:{short:{}},priceSlippage:new BN(scenario==='excess_slippage'?'1':String(Math.floor(118700000*(1-Number(body.maxSlippageBps)/10000)))),requestTime:new BN(0)}}];
 for(let i=0;i<body.tpsl.length;i++){const o=body.tpsl[i];if(scenario==='missing_target'&&i===3)continue;definitions.push({name:'instantCreateTpsl',params:{collateralUsdDelta:new BN(0),sizeUsdDelta:new BN(o.sizeUsdDelta),triggerPrice:new BN(o.triggerPrice),triggerAboveThreshold:o.requestType==='sl',entirePosition:o.entirePosition,counter:new BN(i+1),requestTime:new BN(0)}});}
 const instructions=definitions.map(({name,params})=>{
  const request=params.counter?web3.PublicKey.findProgramAddressSync([Buffer.from('position_request'),position.toBuffer(),params.counter.toArrayLike(Buffer,'le',8),Buffer.from([2])],PROGRAM)[0]:web3.SystemProgram.programId;
  const expected={owner:wallet,perpetuals,eventAuthority,fundingAccount:spl.getAssociatedTokenAddressSync(TOKENS.USDC.mint,wallet),position,pool:program.JLP_POOL_ACCOUNT_PUBKEY,custody:TOKENS.SOL.custodyAccount,collateralCustody:TOKENS.USDC.custodyAccount,tokenProgram:spl.TOKEN_PROGRAM_ID,associatedTokenProgram:spl.ASSOCIATED_TOKEN_PROGRAM_ID,systemProgram:web3.SystemProgram.programId,program:PROGRAM,referral:PROGRAM,tokenLedger:PROGRAM,desiredMint:TOKENS.USDC.mint,receivingAccount:spl.getAssociatedTokenAddressSync(TOKENS.USDC.mint,wallet),positionRequest:request,positionRequestAta:spl.getAssociatedTokenAddressSync(TOKENS.USDC.mint,request,true)};
  if(scenario==='wrong_market')expected.perpetuals=web3.SystemProgram.programId;
  if(scenario==='keeper_change'&&params.counter?.eq(new BN(1)))expected.keeper=new web3.PublicKey(new Uint8Array(32).fill(42));
  if(scenario==='wrong_destination'&&params.counter?.eq(new BN(1)))expected.receivingAccount=web3.SystemProgram.programId;
  const keys=IDL.instructions.find(i=>i.name===name).accounts.map(a=>({pubkey:expected[a.name]||web3.SystemProgram.programId,isSigner:a.isSigner||(scenario==='extra_signer'&&a.name==='eventAuthority'),isWritable:a.isMut}));
  return new web3.TransactionInstruction({programId:PROGRAM,keys,data:coder.encode(name,{params})});
 });
 const tx=new web3.VersionedTransaction(new web3.TransactionMessage({payerKey:wallet,recentBlockhash:web3.SystemProgram.programId.toBase58(),instructions}).compileToV0Message());
 return {positionPubkey:position.toBase58(),quote:quote(body,true),serializedTxBase64:Buffer.from(tx.serialize()).toString('base64')};
}
globalThis.fetch=async(input,init={})=>{
 const url=new URL(String(input));
 if(url.origin==='https://perps-api.jup.ag'){
  if(url.pathname==='/v2/positions')return Response.json({dataList:[],count:0});
  if(url.pathname==='/v2/market-stats')return Response.json({price:'118.7'});
  if(url.pathname==='/v1/pool-info')return Response.json({openFeePercent:'0.06',maxPriceImpactFeePercent:'0.1',shortBorrowRatePercent:'0.001',longBorrowRatePercent:'0.001'});
  if(url.pathname==='/v1/positions/increase'){const b=JSON.parse(init.body);address=b.walletAddress;return Response.json({quote:quote(b)});}
  if(url.pathname==='/v2/positions/increase')return Response.json(await prepared(JSON.parse(init.body)));
 }
 if(url.origin==='https://api.kraken.com'&&url.pathname==='/0/public/OHLC'){
  if(scenario==='missing_feed')throw Error('Candle host unavailable');
  const current=Math.floor(Date.now()/900000)*900000-(scenario==='stale_candles'?3600000:0);
  const candles=Array.from({length:8},(_,i)=>[Math.floor((current-(8-i)*900000)/1000),i===0?'119':i===7?'118.75':'118.6',i===0?'119.1':i===7?'118.78':'118.65',i===0?'118.9':'118.4',i===0?'119.05':i===7?'118.68':'118.55','118.7','10',10]);
  candles.push([Math.floor(current/1000),'118.7',scenario==='divergent_price'?'119.6':'118.75','118.65',scenario==='divergent_price'?'119.5':'118.7','118.7','2',2]);
  return Response.json({error:[],result:{SOLUSD:candles,last:current/1000}});
 } if(url.origin==='https://api.mainnet-beta.solana.com'){
  const r=JSON.parse(init.body);let result;
  if(r.method==='getBalance')result={context:{slot:1},value:1000000000};
  else if(r.method==='getTokenAccountsByOwner'){
   const {web3,spl,TOKENS}=await load();const wallet=new web3.PublicKey(r.params[0]);
   result={context:{slot:1},value:[{pubkey:spl.getAssociatedTokenAddressSync(TOKENS.USDC.mint,wallet).toBase58(),account:{owner:spl.TOKEN_PROGRAM_ID.toBase58(),lamports:2039280,executable:false,rentEpoch:0,data:{program:'spl-token',space:165,parsed:{type:'account',info:{owner:r.params[0],mint:TOKENS.USDC.mint.toBase58(),tokenAmount:{amount:'1000000000',decimals:6,uiAmount:1000,uiAmountString:'1000'}}}}}}]};
  }else if(r.method==='getAccountInfo')result={context:{slot:1},value:null};
  if(result)return Response.json({jsonrpc:'2.0',id:r.id,result});
 }
 return originalFetch(input,init);
};
