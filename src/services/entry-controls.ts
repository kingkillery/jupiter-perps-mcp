import { randomBytes } from "node:crypto";
import { Connection, PublicKey, VersionedTransaction } from "@solana/web3.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { TOKENS, USDC_MINT_ADDRESS, CANDLES_API } from "../constants.js";
import type { TransactionSigner } from "../utils/transactions.js";
import { validateEntryTransaction } from "./entry-validation.js";

const BASE="https://perps-api.jup.ag/v2", TTL=60_000;
export const ENTRY_TOOLS: Tool[]=[{
 name:"preview_strategy_entry",
 description:"Read-only SOL risk preview using live quotes, balances, fees and completed candles. Never signs or submits. Review requests are available only on the local wallet page.",
 inputSchema:{type:"object",additionalProperties:false,properties:{
  side:{type:"string",enum:["long","short"]},collateral_usdc:{type:"number",minimum:10},
  leverage:{type:"number",minimum:1.1,maximum:7,default:1.1},
  slippage_bps:{type:"integer",minimum:1,maximum:200},
  holding_hours:{type:"number",minimum:1,maximum:24,default:1}
 },required:["side","collateral_usdc"]}
}];
export type EntryInput={side:"long"|"short";collateral_usdc:number;leverage:number;slippage_bps:number;holding_hours:number};
export type EntryContext={connection:Connection;strategy:any;slippageBps:number;priorityFee:number;address:()=>string|null;cancelApproval:()=>void;signer:(summary:string,signal:AbortSignal)=>TransactionSigner};
type Preview={address:string;epoch:number;expires:number;input:EntryInput;view:any};
export const micro=(n:number)=>BigInt(Math.floor(n*1e6+1e-7));
function finite(v:unknown,label:string,min=0,max=Number.MAX_SAFE_INTEGER):number {
 if(typeof v!=="number"||!Number.isFinite(v)||v<min||v>max)throw new Error(label+" is outside its allowed range");return v;
}
function amount(v:unknown,label:string,min=0):number {
 if((typeof v!=="string"&&typeof v!=="number")||String(v).trim()==="")throw new Error("Missing "+label);
 return finite(Number(v),label,min);
}
async function api(url:string,signal:AbortSignal,body?:unknown):Promise<any>{
 const r=await fetch(url,{method:body===undefined?"GET":"POST",headers:{"Content-Type":"application/json","x-client-platform":"jupiter-perps-mcp"},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.any([signal,AbortSignal.timeout(15000)])});
 if(!r.ok)throw new Error("Live data or preparation unavailable (HTTP "+r.status+"); no entry submitted");
 return r.json();
}
const up=(n:number)=>Math.ceil(n*1e6)/1e6;

export class EntryControls {
 private locked=true;
 private epoch=0;
 private previews=new Map<string,Preview>();
 private active:AbortController|null=null;
 private submission:string|null=null;
 constructor(private ctx:EntryContext){}
 status(){return {locked:this.locked,busy:!!this.active,submission:this.submission,max_planned_loss_usd:Math.min(5,this.ctx.strategy.risk.max_planned_loss_usd),minimum_leverage:1.1,max_leverage:Math.min(7,this.ctx.strategy.risk.max_leverage),default_slippage_bps:this.ctx.slippageBps,default_collateral_usdc:10,default_holding_hours:1,auto_entry:false};}
 lock(){this.locked=true;this.epoch++;this.previews.clear();this.active?.abort();this.ctx.cancelApproval();return this.status();}
 unlock(){if(!this.ctx.address())throw new Error("Connect Jupiter Wallet first");if(this.active||this.submission)throw new Error("A previous entry needs verification");this.locked=false;return this.status();}
 private input(args:any):EntryInput{
  if(!args||typeof args!=="object"||!["long","short"].includes(args.side))throw new Error("Choose long or short");
  if(Object.keys(args).some(k=>!["side","collateral_usdc","leverage","slippage_bps","holding_hours"].includes(k)))throw new Error("Unsupported entry setting");
  const input:EntryInput={side:args.side,collateral_usdc:finite(args.collateral_usdc,"Collateral",10,1e6),leverage:finite(args.leverage??1.1,"Leverage",1.1,this.status().max_leverage),slippage_bps:finite(args.slippage_bps??this.ctx.slippageBps,"Slippage",1,Math.min(200,this.ctx.slippageBps)),holding_hours:finite(args.holding_hours??1,"Holding allowance",1,24)};
  if(!Number.isInteger(input.slippage_bps))throw new Error("Slippage must be whole basis points");
  if(Math.abs(Number(micro(input.collateral_usdc))/1e6-input.collateral_usdc)>1e-9)throw new Error("Collateral supports six decimal places");
  return input;
 }
 private async inspect(input:EntryInput,address:string,signal:AbortSignal){
  const wallet=new PublicKey(address),now=Date.now(),plan=this.ctx.strategy[input.side];
  const [market,pool,balances,nativeBalance,positions,quoteResponse,candles]=await Promise.all([
   api(BASE+"/market-stats?mint="+TOKENS.SOL.mint,signal),
   api("https://perps-api.jup.ag/v1/pool-info?mint="+TOKENS.SOL.mint,signal),
   this.ctx.connection.getParsedTokenAccountsByOwner(wallet,{mint:TOKENS.USDC.mint},"confirmed"),
   this.ctx.connection.getBalance(wallet,"confirmed"),
   api(BASE+"/positions?walletAddress="+address,signal),
   api("https://perps-api.jup.ag/v1/positions/increase",signal,{walletAddress:address,marketMint:TOKENS.SOL.mint.toBase58(),inputMint:USDC_MINT_ADDRESS,collateralMint:input.side==="long"?TOKENS.SOL.mint.toBase58():USDC_MINT_ADDRESS,side:input.side,leverage:String(input.leverage),maxSlippageBps:String(input.slippage_bps),collateralTokenDelta:micro(input.collateral_usdc).toString(),includeSerializedTx:false,tpsl:[]}),
   api(CANDLES_API.BASE_URL+"?feed=SOLUSD&type=15&from="+(now-8*900000)+"&till="+now,signal).catch(()=>({result:[],unavailable:true}))
  ]);
  signal.throwIfAborted();
  const q=quoteResponse.quote;
  if(!q||!Array.isArray(positions.dataList)||!Array.isArray(candles.result))throw new Error("Incomplete quote, position or candle data");
  const mark=amount(market.price,"mark",1e-6),entry=amount(q.entryPriceUsd,"entry",1e-6),size=amount(q.positionSizeUsd,"size",1e-6),lev=amount(q.leverage,"leverage",1e-6),liq=amount(q.liquidationPriceUsd,"liquidation",1e-6),collateral=amount(q.positionCollateralSizeUsd,"collateral",1e-6);
  if(lev>Math.min(this.status().max_leverage,input.leverage)||size>input.collateral_usdc*input.leverage*1.001)throw new Error("Quote exceeds reviewed leverage or size");
  const balance=balances.value.reduce((sum,item)=>{
   const info=item.account.data.parsed?.info;
   if(info?.owner!==address||info?.mint!==USDC_MINT_ADDRESS||info?.tokenAmount?.decimals!==6)throw new Error("Invalid USDC account response");
   return sum+amount(info.tokenAmount.amount,"USDC balance")/1e6;
  },0);
  const slip=input.slippage_bps/10000;
  const adverseEntry=entry*(input.side==="long"?1+slip:1-slip),adverseStop=plan.stop*(input.side==="long"?1-slip:1+slip);
  const units=size/entry,priceLoss=(size/adverseEntry)*Math.abs(adverseEntry-adverseStop);
  const entryFees=[q.openFeeUsd,q.priceImpactFeeUsd,q.outstandingBorrowFeeUsd].reduce((s,v)=>s+amount(v,"entry fee"),0);
  const exitFees=size*(amount(pool.openFeePercent,"base fee")+amount(pool.maxPriceImpactFeePercent,"impact allowance"))/100;
  const borrow=size*amount(input.side==="long"?pool.longBorrowRatePercent:pool.shortBorrowRatePercent,"borrow rate")/100*input.holding_hours;
  // Conservative planning reserve for account rent and multiple transactions; not a fee quote.
  const networkReserveSol=0.03,networkReserve=networkReserveSol*mark;
  const conversion=Math.max(0,input.collateral_usdc-collateral-entryFees);
  const plannedLoss=up(priceLoss+entryFees+exitFees+borrow+networkReserve+conversion);
  const blockers:string[]=[];
  if(candles.unavailable)blockers.push("The candle feed is unavailable; entry review is blocked until completed candles can be verified");
  if(balance+1e-6<input.collateral_usdc)blockers.push("Insufficient USDC for the reviewed collateral");
  if(nativeBalance/1e9<networkReserveSol)blockers.push("SOL balance is below the 0.03 SOL account and transaction allowance");
  if(positions.dataList.some((p:any)=>p.asset==="SOL"))blockers.push("An existing SOL position must be reviewed first; adding to positions is disabled");
  if(plannedLoss>this.status().max_planned_loss_usd)blockers.push("Planned loss including allowances exceeds $5; reduce collateral or slippage");
  if(input.slippage_bps>=Math.abs(entry-plan.stop)/entry*10000)blockers.push("Slippage must be narrower than the entry-to-stop distance");
  if(input.side==="long"?!(plan.stop<Math.min(entry,mark)&&plan.stop>liq&&adverseEntry<plan.targets[0]):!(plan.stop>Math.max(entry,mark)&&plan.stop<liq&&adverseEntry>plan.targets[0]))blockers.push("Stop, liquidation or first target is incompatible with the current entry");
  if(input.side==="long"?mark<plan.retest_zone[0]||mark>=119.8:mark<plan.retest_zone[0]||mark>plan.retest_zone[1])blockers.push("Current price is outside the saved entry window");
  const bars=candles.result.filter((b:any)=>typeof b.time==="number"&&b.time+900000<=now).sort((a:any,b:any)=>a.time-b.time);
  for(let i=0;i<bars.length;i++){
   const b=bars[i];
   if(![b.open,b.high,b.low,b.close].every(v=>typeof v==="number"&&Number.isFinite(v)&&v>0)||b.high<Math.max(b.open,b.close)||b.low>Math.min(b.open,b.close)||(i>0&&b.time-bars[i-1].time!==900000))throw new Error("Invalid or discontinuous completed candle data");
  }
  const last=bars.at(-1);
  if(!last||now-(last.time+900000)>900000+120000)blockers.push("Fresh completed 15-minute candles are unavailable");
  const sequence=last&&bars.slice(0,-1).some((b:any,index:number)=> {
   if(input.side==="long")return b.close>119.2&&bars.slice(index+1).every((later:any)=>later.high<119.8&&later.low>plan.stop);
   const rejected=bars.slice(0,index).some((prior:any)=>prior.high>=119&&prior.high<plan.stop&&prior.close<119.2);
   return rejected&&b.close<118.6&&bars.slice(index+1).every((later:any)=>later.low>117.9&&later.high<plan.stop);
  })&&(input.side==="long"?last.low>=plan.retest_zone[0]&&last.low<=plan.retest_zone[1]&&last.close>last.open&&last.close>119.2:last.high>=plan.retest_zone[0]&&last.high<=plan.retest_zone[1]&&last.close<last.open&&last.close<118.7);
  if(!sequence)blockers.push("Completed confirmation and later retest sequence is not present");
  if(input.side==="long")blockers.push("The USDC-to-SOL entry conversion route still needs transaction validation; long entries remain blocked");
  const total=micro(size),third=total/3n;if(third<=0n)throw new Error("Position too small for three exits");
  return {asset:"SOL",side:input.side,input,mark_price:mark,entry_price:entry,adverse_entry_price:adverseEntry,stop_price:plan.stop,size_usd:size,units_sol:units,leverage:lev,collateral_usdc:input.collateral_usdc,usdc_balance:balance,sol_balance:nativeBalance/1e9,
   targets:plan.targets.map((price:number,i:number)=>({price,size_usd:Number(i===2?total-2n*third:third)/1e6})),
   risk:{planned_loss_usd:plannedLoss,max_planned_loss_usd:this.status().max_planned_loss_usd,price_loss_with_slippage_usd:up(priceLoss),entry_fees_usd:entryFees,exit_fee_allowance_usd:up(exitFees),borrow_allowance_usd:up(borrow),network_and_account_allowance_usd:up(networkReserve),collateral_conversion_allowance_usd:up(conversion),holding_hours:input.holding_hours,exit_slippage_is_an_allowance_not_a_guarantee:true},
   latest_completed_candle:last?{time:last.time,close:last.close}:null,blockers,eligible_for_preparation:blockers.length===0,transaction_verified:false,submitted:false};
 }
 async preview(args:any,signal=new AbortController().signal){
  const address=this.ctx.address();if(!address)throw new Error("Connect Jupiter Wallet first");
  const input=this.input(args),epoch=this.epoch,view=await this.inspect(input,address,signal);
  if(address!==this.ctx.address()||epoch!==this.epoch)throw new Error("Wallet or controls changed; preview again");
  for(const [id,p]of this.previews)if(p.expires<Date.now())this.previews.delete(id);
  if(this.previews.size>=16)this.previews.delete(this.previews.keys().next().value!);
  const id=randomBytes(24).toString("hex"),expires=Date.now()+TTL;
  this.previews.set(id,{address,epoch,expires,input,view});
  return {...view,preview_id:id,expires_at:expires,entry_locked:this.locked};
 }
 async review(id:unknown,confirmed:unknown){
  if(this.locked)throw new Error("Entries are locked; enable reviews on the wallet page first");
  if(this.active||this.submission)throw new Error("Another entry is in progress or needs verification");
  if(confirmed!==true)throw new Error("Confirm the retest and structural stop on the wallet page");
  const p=typeof id==="string"?this.previews.get(id):undefined;
  if(!p||p.expires<Date.now()||p.address!==this.ctx.address()||p.epoch!==this.epoch)throw new Error("Preview expired or wallet changed; preview again");
  this.previews.delete(id as string);this.active=new AbortController();const signal=this.active.signal;
  try{
   const view=await this.inspect(p.input,p.address,signal);
   if(view.blockers.length)throw new Error(view.blockers.join("; "));
   if(Math.abs(view.entry_price/p.view.entry_price-1)>p.input.slippage_bps/10000||view.risk.planned_loss_usd>p.view.risk.planned_loss_usd+0.01)throw new Error("Price or risk changed; preview again");
   const orders=[{receiveToken:"USDC",triggerPrice:micro(view.stop_price).toString(),requestType:"sl",entirePosition:true,sizeUsdDelta:"0"},...view.targets.map((t:any)=>({receiveToken:"USDC",triggerPrice:micro(t.price).toString(),requestType:"tp",entirePosition:false,sizeUsdDelta:micro(t.size_usd).toString()}))];
   const prepared=await api(BASE+"/positions/increase",signal,{asset:"SOL",side:p.input.side,inputToken:"USDC",inputTokenAmount:micro(p.input.collateral_usdc).toString(),sizeUsdDelta:micro(view.size_usd).toString(),walletAddress:p.address,maxSlippageBps:String(p.input.slippage_bps),tpsl:orders});
   if(typeof prepared.serializedTxBase64!=="string"||prepared.serializedTxBase64.length>20000)throw new Error("No supported entry transaction returned");
   const tx=VersionedTransaction.deserialize(Buffer.from(prepared.serializedTxBase64,"base64"));
   await validateEntryTransaction(tx,prepared,this.ctx,p.address,p.input,view,orders);
   const simulation=await this.ctx.connection.simulateTransaction(tx,{sigVerify:false,replaceRecentBlockhash:true,commitment:"confirmed"});
   if(simulation.value.err)throw new Error("Entry and protection simulation failed");
   const check=()=>{signal.throwIfAborted();if(this.locked||p.epoch!==this.epoch||p.address!==this.ctx.address()||Date.now()>p.expires)throw new Error("Preview expired or controls changed; preview again");};check();
   const summary=["SOL SHORT — ENTRY WITH PROTECTION","$"+p.input.collateral_usdc+" USDC collateral · "+view.leverage+"× leverage · $"+view.size_usd+" position","Planned loss including allowances: $"+view.risk.planned_loss_usd.toFixed(2)+" / $5. Actual loss can exceed the plan.","Stop: $"+view.stop_price+" for the entire remaining position.",...view.targets.map((t:any)=>"Take profit: $"+t.price+", close $"+t.size_usd+" notional (one third)."),"Slippage: "+p.input.slippage_bps/100+"%. Borrow allowance: "+p.input.holding_hours+" hour(s).","Stop and all three targets are in this transaction. Native triggers execute later without another wallet popup.","Verify the submitted position and all protection in Jupiter."].join("\n");
   const signed=await this.ctx.signer(summary,signal).signTransaction(tx);check();
   // Latch before dispatch: timeout or disconnect must never cause a retry.
   this.submission="submission_attempted_verification_required";this.locked=true;this.previews.clear();
   const result=await api(BASE+"/transaction/execute",signal,{action:"increase-position",serializedTxBase64:Buffer.from(signed.serialize()).toString("base64")});
   if(typeof result.txid!=="string")throw new Error("Submission status unknown; verify in Jupiter before retrying");
   this.submission=result.txid;
   return {status:"submitted_not_yet_verified",submitted:true,signature:result.txid,entry_locked:true,next_step:"Verify the position, stop and three targets in Jupiter. Further entries are locked."};
  }finally{this.active=null;}
 }
}
