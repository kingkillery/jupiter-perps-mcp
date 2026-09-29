import {getWallets} from '@wallet-standard/app';
const $=id=>document.getElementById(id);
const registry=getWallets();
let wallet,account,unsubscribe,pending,busy=false;
const notice=text=>{$('notice').textContent=text;};
async function api(path,body){
 const response=await fetch(`/wallet/${path}`,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json','X-Wallet-Bridge':'1'},body:JSON.stringify(body)});
 const result=await response.json();if(!response.ok)throw new Error(result.error||'Connection failed');return result;
}
function candidates(){return registry.get().filter(w=>/jupiter/i.test(w.name)&&w.features['standard:connect']);}
function refresh(){if(!account)notice(candidates().length?'Jupiter Wallet detected. Connect to choose your account.':'Open in Comet with Jupiter Wallet enabled, then unlock the extension.');}
registry.on('register',refresh);registry.on('unregister',refresh);refresh();
async function disconnect(){invalidateEntry();unsubscribe?.();unsubscribe=null;account=null;pending=null;await api('disconnect',{});$('address').textContent='';$('connect').hidden=false;$('disconnect').hidden=true;$('approval').hidden=true;$('wallet-state').textContent='Wallet not connected';}
$('connect').onclick=async()=>{
 $('connect').disabled=true;
 try{
  const matches=candidates();if(matches.length!==1)throw new Error(matches.length?'Multiple Jupiter wallets detected; keep one enabled in this profile.':'Jupiter Wallet was not detected. Open this page in Comet and unlock it.');
  wallet=matches[0];const response=await wallet.features['standard:connect'].connect();
  const accounts=response.accounts.filter(a=>a.chains.includes('solana:mainnet')||a.chains.includes('solana:mainnet-beta'));
  if(accounts.length!==1)throw new Error('Select exactly one Solana account in Jupiter Wallet and reconnect.');
  account=accounts[0];await api('connect',{address:account.address});
  unsubscribe=wallet.features['standard:events']?.on('change',()=>{void disconnect().catch(e=>notice(e.message));notice('Wallet changed. Reconnect to confirm the account.');});
  $('address').textContent=account.address;$('connect').hidden=true;$('disconnect').hidden=false;
  $('wallet-state').textContent='Jupiter Wallet connected';notice('Connected. Each transaction still needs your explicit approval.');
 }catch(e){account=null;notice(e.message);}finally{$('connect').disabled=false;}
};
$('disconnect').onclick=()=>disconnect().catch(e=>notice(e.message));
$('reject').onclick=async()=>{if(!pending)return;try{await api('approval',{id:pending.id,reject:true});pending=null;$('approval').hidden=true;}catch(e){notice(e.message);}};
$('approve').onclick=async()=>{
 if(!pending||!account||busy)return;const request=pending;busy=true;$('approve').disabled=true;
 try{
  const feature=wallet.features['solana:signTransaction'];if(!feature)throw new Error('This wallet does not support signing transactions through Wallet Standard.');
  if(Date.now()>=request.expires)throw new Error('Approval expired. Request a fresh transaction.');
  const result=await feature.signTransaction({account,chain:'solana:mainnet',transaction:Uint8Array.from(atob(request.transaction),c=>c.charCodeAt(0))});
  const signed=result[0]?.signedTransaction;if(!signed)throw new Error('The wallet did not return a signed transaction.');
  await api('approval',{id:request.id,signedTransaction:btoa(String.fromCharCode(...signed))});
  notice('Wallet approved. Check the MCP result for submission and verification status.');
 }catch(e){notice(e.message);await api('approval',{id:request.id,reject:true}).catch(()=>{});}finally{busy=false;$('approve').disabled=false;}
};
async function poll(){
 try{const state=await api('status');updateEntryStatus(state.entry_controls);
  if(!account&&state.connected){await api("disconnect",{});notice("Reconnect Jupiter Wallet after reloading this page.");}
  if(account&&!state.connected){await disconnect();notice('Connection expired. Reconnect Jupiter Wallet.');}
  pending=state.pending;$('approval').hidden=!pending;
  if(pending){$('transaction-summary').textContent=pending.summary;$('expires').textContent=`Approval expires in ${Math.max(0,Math.ceil((pending.expires-Date.now())/1000))} seconds.`;}
  $('execution-status').textContent=state.trading_blocker||'Native protective orders and partial exits require your approval. Strategy entries remain unarmed.';
 }catch(e){notice(e.message);}finally{setTimeout(poll,1500);}
}setTimeout(poll,0);


// Entry controls use server-owned previews; editing a field invalidates the current review.
let entryPreview=null,entryStatus=null,entryVersion=0,entryWorking=false,defaultsLoaded=false;
const money=n=>new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',maximumFractionDigits:4}).format(n);
function invalidateEntry(){entryVersion++;entryPreview=null;$('entry-result').hidden=true;$('entry-confirm').checked=false;refreshEntryButtons();}
function refreshEntryButtons(){
 const valid=entryPreview&&Date.now()<entryPreview.expires_at;
 $('entry-preview-button').disabled=!account||entryWorking;
 $('entry-unlock').disabled=!account||!entryStatus?.locked||entryWorking||!!entryStatus?.submission;
 $('entry-lock').disabled=!account;
 $('entry-review').disabled=!account||!valid||entryWorking||entryStatus?.locked!==false||!entryPreview?.eligible_for_preparation||!$('entry-confirm').checked;
 $('entry-lock-state').textContent=entryStatus?.submission?'Entry submitted — verification required':entryStatus?.locked===false?'Entry reviews enabled':'Entry reviews locked';
 if(entryPreview)$('entry-expiry').textContent=valid?'Preview expires in '+Math.ceil((entryPreview.expires_at-Date.now())/1000)+' seconds.':'Preview expired. Preview again before review.';
}
function updateEntryStatus(status){
 entryStatus=status;
 if(!defaultsLoaded&&status){$('entry-slippage').value=String(status.default_slippage_bps/100);$('entry-slippage').max=String(status.default_slippage_bps/100);defaultsLoaded=true;}
 refreshEntryButtons();
}
function entryInput(){return {side:$('entry-side').value,collateral_usdc:Number($('entry-collateral').value),leverage:Number($('entry-leverage').value),slippage_bps:Math.round(Number($('entry-slippage').value)*100),holding_hours:Number($('entry-hours').value)};}
function showEntry(p){
 $('entry-result').hidden=false;$('entry-risk-total').textContent=money(p.risk.planned_loss_usd)+' / $5';
 const rows=[
 ['Position / leverage',money(p.size_usd)+' / '+p.leverage+'×'],
 ['USDC available',money(p.usdc_balance)],['Current entry quote',money(p.entry_price)],
 ['Full-position stop',money(p.stop_price)],
 ['Three equal-third targets',p.targets.map(t=>money(t.price)+' → '+money(t.size_usd)+' notional').join(' · ')],
 ['Price loss including slippage',money(p.risk.price_loss_with_slippage_usd)],
 ['Entry fees',money(p.risk.entry_fees_usd)],['Exit fee allowance',money(p.risk.exit_fee_allowance_usd)],
 ['Borrow allowance',money(p.risk.borrow_allowance_usd)],['Account + transaction reserve',money(p.risk.network_and_account_allowance_usd)],
 ['Collateral conversion allowance',money(p.risk.collateral_conversion_allowance_usd)]
 ];
 $('entry-breakdown').replaceChildren();
 for(const [label,value]of rows){const dt=document.createElement('dt'),dd=document.createElement('dd');dt.textContent=label;dd.textContent=value;$('entry-breakdown').append(dt,dd);}
 $('entry-blockers').replaceChildren();
 for(const text of p.blockers){const li=document.createElement('li');li.textContent=text;$('entry-blockers').append(li);}
 $('entry-message').textContent=p.blockers.length?'Entry blocked. Resolve the items below, then preview again.':'Risk checks passed. The transaction still needs validation and your wallet approval.';
}
$('entry-form').addEventListener('input',invalidateEntry);
$('entry-confirm').addEventListener('change',refreshEntryButtons);
$('entry-form').onsubmit=async event=>{
 event.preventDefault();invalidateEntry();const version=entryVersion;entryWorking=true;refreshEntryButtons();$('entry-message').textContent='Checking current prices, balances, fees and completed candles…';
 try{const p=await api('entry/preview',entryInput());if(version!==entryVersion)return;entryPreview=p;showEntry(p);}
 catch(e){$('entry-message').textContent=e.message;}finally{entryWorking=false;refreshEntryButtons();}
};
$('entry-unlock').onclick=async()=>{try{updateEntryStatus(await api('entry/unlock',{}));$('entry-message').textContent='Reviews enabled. Preview, confirm the setup, then review in your wallet.';}catch(e){$('entry-message').textContent=e.message;}};
$('entry-lock').onclick=async()=>{invalidateEntry();try{updateEntryStatus(await api('entry/lock',{}));$('entry-message').textContent='Entries locked. Any pending wallet request has been cancelled. Submitted orders are not cancelled.';}catch(e){$('entry-message').textContent=e.message;}};
$('entry-review').onclick=async()=>{
 if($('entry-review').disabled||!entryPreview)return;
 const id=entryPreview.preview_id;entryWorking=true;entryPreview=null;refreshEntryButtons();
 $('entry-message').textContent='Refreshing checks and validating entry, stop and targets. A valid request will appear in the wallet review area.';
 try{const result=await api('entry/review',{preview_id:id,signal_confirmed:$('entry-confirm').checked});$('entry-message').textContent=result.next_step||result.status;}
 catch(e){$('entry-message').textContent=e.message;}
 finally{entryWorking=false;$('entry-confirm').checked=false;refreshEntryButtons();}
};
setInterval(refreshEntryButtons,1000);
api('controls').then(updateEntryStatus).catch(e=>{$('entry-message').textContent=e.message;});
