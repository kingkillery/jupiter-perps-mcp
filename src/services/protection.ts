import { BorshInstructionCoder } from "@coral-xyz/anchor";
import { Connection, PublicKey, TransactionMessage, VersionedTransaction, ComputeBudgetProgram } from "@solana/web3.js";
import { ASSOCIATED_TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { TransactionSigner } from "../utils/transactions.js";
import { initializeProgram, JUPITER_PERPETUALS_PROGRAM_ID } from "../utils/program.js";
import { IDL } from "../idl/jupiter-perpetuals-idl.js";
import { TOKENS } from "../constants.js";

const BASE="https://perps-api.jup.ag/v2";
const positionProperty={type:"string",description:"Position public key owned by the connected wallet"};
const dryRunProperty={type:"boolean",default:true,description:"Defaults to true: prepare and simulate without requesting a signature. False requires explicit approval in the browser wallet."};
export const PROTECTION_TOOLS: Tool[]=[
 {name:"get_protective_orders",description:"List the connected wallet's SOL positions and native stop-loss/take-profit requests. Does not place orders.",inputSchema:{type:"object",properties:{}}},
 {name:"set_protective_stop",description:"Prepare or update one native stop-loss covering the entire remaining SOL position. Defaults to preview; browser approval required to submit.",inputSchema:{type:"object",properties:{position:positionProperty,stop_price_usd:{type:"number",exclusiveMinimum:0},dry_run:dryRunProperty},required:["position","stop_price_usd"]}},
 {name:"set_take_profit_ladder",description:"Prepare three native take-profit orders, each covering one third of the current SOL position's original size (last order receives rounding remainder). Rejects existing TP orders to avoid duplicates. Defaults to preview.",inputSchema:{type:"object",properties:{position:positionProperty,target_prices_usd:{type:"array",items:{type:"number",exclusiveMinimum:0},minItems:3,maxItems:3},dry_run:dryRunProperty},required:["position","target_prices_usd"]}},
 {name:"close_position_partial",description:"Prepare a bounded-slippage partial SOL close by explicit USD notional, not collateral. Size must be less than the position. Rejects active TP orders because their absolute sizes would become stale. Defaults to preview.",inputSchema:{type:"object",properties:{position:positionProperty,size_usd:{type:"number",exclusiveMinimum:0},dry_run:dryRunProperty},required:["position","size_usd"]}},
];
type Context={address:string;connection:Connection;slippageBps:number;priorityFee:number;signal?:AbortSignal;signer:(summary:string)=>TransactionSigner;browserMode:boolean};
type Expected={kind:"sl"|"tp"|"partial";trigger?:string;size:string;entire:boolean;request?:string};
function micro(value:unknown,label:string):string {
 if(typeof value!=="number"||!Number.isFinite(value)||value<=0||!Number.isSafeInteger(Math.round(value*1e6)))throw new Error(`${label} must be a finite positive amount`);
 const result=Math.round(value*1e6);if(result<=0)throw new Error(`${label} is below one micro-dollar`);return String(result);
}
async function api(path:string,signal?:AbortSignal,method="GET",body?:unknown):Promise<any>{
 const response=await fetch(BASE+path,{method,headers:{"Content-Type":"application/json","x-client-platform":"jupiter-perps-mcp"},body:body===undefined?undefined:JSON.stringify(body),signal:signal?AbortSignal.any([signal,AbortSignal.timeout(15_000)]):AbortSignal.timeout(15_000)});
 if(!response.ok)throw new Error(`Jupiter v2 returned HTTP ${response.status}`);
 return await response.json();
}

async function validateTransaction(tx:VersionedTransaction,ctx:Context,position:any,expected:Expected[]):Promise<void>{
 const wallet=new PublicKey(ctx.address);
 if(!tx.message.staticAccountKeys.slice(0,tx.message.header.numRequiredSignatures).some(key=>key.equals(wallet)))throw new Error("Prepared transaction does not require the connected wallet signature");
 const tables=await Promise.all(tx.message.addressTableLookups.map(async lookup=>{
  const result=await ctx.connection.getAddressLookupTable(lookup.accountKey);if(!result.value)throw new Error("Transaction lookup table unavailable");return result.value;
 }));
 const message=TransactionMessage.decompile(tx.message,{addressLookupTableAccounts:tables});
 const coder=new BorshInstructionCoder(IDL);
 const remaining=[...expected];
 for(const ix of message.instructions){
  if(ix.programId.equals(ComputeBudgetProgram.programId)) {
   const tag=ix.data[0];
   if(tag===3 && (ix.data.length!==9 || ix.data.readBigUInt64LE(1)>BigInt(ctx.priorityFee))) throw new Error("Prepared priority fee exceeds your configured maximum");
   if(tag===2 && (ix.data.length!==5 || ix.data.readUInt32LE(1)>1_400_000)) throw new Error("Invalid prepared compute limit");
   if(![1,2,3,4].includes(tag)) throw new Error("Unsupported compute-budget instruction");
   continue;
  }
  // Allow only idempotent ATA creation for this wallet and the position's collateral.
  if(ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)){
   const mint=new PublicKey(position.collateralMint);
   if(ix.data.length!==1||ix.data[0]!==1||!ix.keys[1]?.pubkey.equals(getAssociatedTokenAddressSync(mint,wallet))||!ix.keys[2]?.pubkey.equals(wallet)||!ix.keys[3]?.pubkey.equals(mint))throw new Error("Unexpected associated token account instruction");
   continue;
  }
  if(!ix.programId.equals(JUPITER_PERPETUALS_PROGRAM_ID))throw new Error("Unexpected program in prepared protection transaction");
  const decoded=coder.decode(ix.data);if(!decoded)throw new Error("Unknown Jupiter instruction");
  const definition=IDL.instructions.find(def=>def.name===decoded.name);
  const accounts=new Map((definition?.accounts||[]).map((account,index)=>[account.name,ix.keys[index]?.pubkey?.toBase58()]));
  if(accounts.get("owner")!==ctx.address||accounts.get("position")!==position.positionPubkey)throw new Error("Prepared order targets a different wallet or position");
  const params=(decoded.data as any).params;
  const isCreate=["instantCreateTpsl","createDecreasePositionRequest2"].includes(decoded.name);
  if(decoded.name==="createDecreasePositionRequest2" && params.requestType?.trigger === undefined) throw new Error("Prepared protection must be a trigger order, not a market order");
  const isUpdate=["instantUpdateTpsl","updateDecreasePositionRequest2"].includes(decoded.name);
  const isPartial=["instantDecreasePosition","createDecreasePositionMarketRequest"].includes(decoded.name);
  if(!isCreate&&!isUpdate&&!isPartial)throw new Error("Unexpected Jupiter action in prepared protection transaction");
  const index=remaining.findIndex(item=>{
   if(isPartial)return item.kind==="partial"&&params.sizeUsdDelta?.toString()===item.size&&params.entirePosition!==true;
   if(item.kind==="partial"||params.triggerPrice?.toString()!==item.trigger)return false;
   if(isUpdate)return item.request===accounts.get("positionRequest");
   const above=(position.side==="long")===(item.kind==="tp");
   return !item.request&&params.triggerAboveThreshold===above&&params.entirePosition===item.entire&&(item.entire||params.sizeUsdDelta?.toString()===item.size);
  });
  if(index<0)throw new Error("Prepared trigger, direction, or size differs from the reviewed request");
  if(isPartial){
   const bound=BigInt(params.priceSlippage?.toString()||"0"),mark=BigInt(position.markPriceUsd);
   const tolerance=BigInt(ctx.slippageBps);
   if(position.side==="long"?(bound<mark*(10000n-tolerance)/10000n):(bound>mark*(10000n+tolerance)/10000n||bound===0n))throw new Error("Prepared partial-close slippage exceeds the configured bound");
  }
  if(accounts.has("desiredMint")&&accounts.get("desiredMint")!==position.collateralMint)throw new Error("Unexpected receiving token");
  if(accounts.has("receivingAccount")&&accounts.get("receivingAccount")!==getAssociatedTokenAddressSync(new PublicKey(position.collateralMint),wallet).toBase58())throw new Error("Unexpected receiving account");
  remaining.splice(index,1);
 }
 if(remaining.length)throw new Error("Prepared transaction is missing requested protection instructions");
}

export async function runProtectionTool(name:string,args:any,ctx:Context):Promise<any>{
 const response=await api(`/positions?walletAddress=${encodeURIComponent(ctx.address)}`,ctx.signal);
 if(!Array.isArray(response.dataList))throw new Error("Invalid positions response");
 if(name==="get_protective_orders")return {positions:response.dataList.filter((p:any)=>p.asset==="SOL"),verification:"Read from Jupiter v2; inspect trigger order status before relying on protection"};
 if(!args||typeof args!=="object")throw new Error("Arguments are required");
 if(args.dry_run!==undefined&&typeof args.dry_run!=="boolean")throw new Error("dry_run must be boolean");
 const dryRun=args.dry_run!==false;
 const key=new PublicKey(args.position).toBase58();
 const position=response.dataList.find((p:any)=>p.positionPubkey===key);
 if(!position||position.asset!=="SOL"||!["long","short"].includes(position.side))throw new Error("Owned SOL position not found");
 const program=initializeProgram(ctx.connection);
 const onchain=await program.account.position.fetch(new PublicKey(key));
 if(!onchain.owner.equals(new PublicKey(ctx.address))||!onchain.custody.equals(TOKENS.SOL.custodyAccount))throw new Error("On-chain position ownership or asset mismatch");
 if((onchain.side.long !== undefined ? "long" : "short") !== position.side) throw new Error("On-chain position side mismatch");
 if(onchain.sizeUsd.toString()!==position.sizeUsd)throw new Error("Position size changed; refresh before preparing an order");
 const size=BigInt(position.sizeUsd),mark=BigInt(position.markPriceUsd),liquidation=BigInt(position.liquidationPriceUsd);
 if(size<=0n||mark<=0n||!Array.isArray(position.tpslRequests))throw new Error("Invalid position size, mark, or order list");
 let expected:Expected[]=[],payload:any,action:string,path:string,method="POST";
 if(name==="set_protective_stop"){
  const trigger=micro(args.stop_price_usd,"Stop price"),price=BigInt(trigger);
  if(position.side==="long"?(price>=mark||price<=liquidation):(price<=mark||price>=liquidation))throw new Error("Stop must be between the current mark and liquidation price on the loss side");
  const existing=position.tpslRequests.filter((order:any)=>order.requestType==="sl");
  if(existing.length>1||existing.some((order:any)=>!order.entirePosition))throw new Error("Existing stop structure is ambiguous or partial; review it in Jupiter first");
  expected=[{kind:"sl",trigger,size:"0",entire:true,request:existing[0]?.positionRequestPubkey}];
  action=existing.length?"update-tpsl":"create-tpsl";path="/tpsl";
  if(existing.length){method="PATCH";payload={positionRequestPubkey:existing[0].positionRequestPubkey,triggerPrice:trigger};}
  else payload={walletAddress:ctx.address,positionPubkey:key,tpsl:[{receiveToken:position.collateralToken,triggerPrice:trigger,requestType:"sl",entirePosition:true}]};
 }else if(name==="set_take_profit_ladder"){
  if(!Array.isArray(args.target_prices_usd)||args.target_prices_usd.length!==3)throw new Error("Exactly three targets are required");
  if(position.tpslRequests.some((order:any)=>order.requestType==="tp"))throw new Error("Existing take-profit orders must be reviewed before adding another ladder");
  if(!position.tpslRequests.some((order:any)=>order.requestType==="sl"&&order.entirePosition))throw new Error("Install and verify the full remaining-position protective stop first");
  const prices=args.target_prices_usd.map((value:unknown)=>micro(value,"Target"));
  prices.forEach((value:string,index:number)=>{const previous=index?BigInt(prices[index-1]):mark;if(position.side==="long"?BigInt(value)<=previous:BigInt(value)>=previous)throw new Error("Targets must be ordered away from the current mark on the profit side");});
  const third=size/3n;if(third<=0n)throw new Error("Position too small for three exits");
  expected=prices.map((trigger:string,index:number)=>({kind:"tp",trigger,size:(index===2?size-2n*third:third).toString(),entire:false}));
  action="create-tpsl";path="/tpsl";payload={walletAddress:ctx.address,positionPubkey:key,tpsl:expected.map(item=>({receiveToken:position.collateralToken,triggerPrice:item.trigger,requestType:"tp",entirePosition:false,sizeUsdDelta:item.size}))};
 }else if(name==="close_position_partial"){
  const amount=micro(args.size_usd,"Close size");if(BigInt(amount)>=size)throw new Error("Partial-close size must be less than the current position size");
  if(position.tpslRequests.some((order:any)=>order.requestType==="tp"))throw new Error("Active fixed-size take-profit orders would become stale after a partial close; review them in Jupiter first");
  if(!Number.isInteger(ctx.slippageBps)||ctx.slippageBps<1||ctx.slippageBps>500)throw new Error("Partial-close slippage must be 1–500 bps");
  expected=[{kind:"partial",size:amount,entire:false}];action="decrease-position";path="/positions/decrease";
  payload={positionPubkey:key,receiveToken:position.collateralToken,sizeUsdDelta:amount,entirePosition:false,maxSlippageBps:String(ctx.slippageBps)};
 }else throw new Error("Unknown protection tool");
 const prepared=await api(path,ctx.signal,method,payload);
 if(typeof prepared.serializedTxBase64!=="string"||prepared.serializedTxBase64.length>20000)throw new Error("Invalid prepared transaction");
 const tx=VersionedTransaction.deserialize(Buffer.from(prepared.serializedTxBase64,"base64"));
 await validateTransaction(tx,ctx,position,expected);
 const simulation=await ctx.connection.simulateTransaction(tx,{sigVerify:false,replaceRecentBlockhash:true,commitment:"confirmed"});
 if(simulation.value.err)throw new Error(`Protection transaction simulation failed: ${JSON.stringify(simulation.value.err)}`);
 const plan={action,position:key,asset:"SOL",side:position.side,receive_token:position.collateralToken,orders:expected,simulation:"passed",dry_run:dryRun,units:"Trigger prices and sizes above are integer micro-USD",native_triggers_execute_without_a_future_wallet_popup:true};
 if(dryRun)return {...plan,status:"preview_only",submitted:false};
 if(!ctx.browserMode)throw new Error("Live protection changes require the browser wallet approval flow");
 ctx.signal?.throwIfAborted();
 const summary = [
  action === "decrease-position" ? "PARTIAL CLOSE" : "NATIVE PROTECTIVE ORDERS",
  `SOL ${position.side.toUpperCase()} · position ${key}`,
  ...expected.map(item => item.kind === "partial"
    ? `Close ${Number(item.size)/1e6} of position notional.`
    : `${item.kind === "sl" ? "Stop loss" : "Take profit"} at ${Number(item.trigger)/1e6}: ${item.entire ? "entire remaining position" : "$" + Number(item.size)/1e6 + " of position notional"}.`),
  `Receive: ${position.collateralToken}. Simulation passed.`,
  "Native stop/target orders execute automatically when triggered; no future wallet popup.",
  "Submission does not guarantee that the order is confirmed or active. Verify after signing."
].join("\n");
 const signed=await ctx.signer(summary).signTransaction(tx);
 ctx.signal?.throwIfAborted();
 const executed=await api("/transaction/execute",ctx.signal,"POST",{action,serializedTxBase64:Buffer.from(signed.serialize()).toString("base64")});
 if(typeof executed.txid!=="string")throw new Error("Submission returned no transaction signature; verify in Jupiter before retrying");
 return {...plan,status:"submitted_not_yet_verified",submitted:true,signature:executed.txid,next_step:"Check transaction confirmation and get_protective_orders; a submitted request is not proof that protection is active."};
}
