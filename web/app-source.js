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


// Forecasts have no connection to entry controls or wallet signing.
let forecastController=null,forecastVersion=0,kronosReady=false;
function forecastButtons(){
 $('kronos-generate').disabled=!kronosReady||!!forecastController;
 $('kronos-cancel').hidden=!forecastController;
 evaluationButtons();
}
async function kronosStatus(){
 try{
  const state=await api('kronos/status');kronosReady=state.ready;
  if(!forecastController)$('kronos-message').textContent=state.ready?'Kronos-mini ready on CPU. Generate when you want a fresh scenario.':'Local model unavailable. Run npm run setup:kronos on the host computer.';
 }catch(e){$('kronos-message').textContent=e.message;}
 forecastButtons();
}
function invalidateForecast(){
 forecastVersion++;forecastController?.abort();$('kronos-result').hidden=true;
}
$('kronos-form').addEventListener('input',()=>{invalidateForecast();$('kronos-message').textContent='Settings changed. Generate a new forecast.';});
$('kronos-cancel').onclick=()=>{invalidateForecast();$('kronos-message').textContent='Forecast cancelled.';};
function drawForecast(result){
 const svg=$('kronos-chart');svg.replaceChildren();
 const node=(tag,attrs={},text)=>{
  const el=document.createElementNS('http://www.w3.org/2000/svg',tag);
  for(const [key,value]of Object.entries(attrs))el.setAttribute(key,String(value));
  if(text!==undefined)el.textContent=text;svg.append(el);return el;
 };
 node('title',{id:'kronos-chart-title'},result.asset+' completed closes and Kronos mean forecast');
 const points=[...result.history,...result.forecast],prices=points.map(p=>p.close);
 const minimum=Math.min(...prices),maximum=Math.max(...prices),padding=Math.max((maximum-minimum)*.12,maximum*.001);
 const lo=minimum-padding,hi=maximum+padding;
 const x=i=>80+i/(points.length-1)*780,y=p=>230-(p-lo)/(hi-lo)*205;
 for(let i=0;i<4;i++){
  const value=lo+(hi-lo)*i/3;
  node('line',{x1:80,x2:860,y1:y(value),y2:y(value),class:'forecast-grid'});
  node('text',{x:72,y:y(value)+4,'text-anchor':'end',class:'forecast-label'},money(value));
 }
 const historyEnd=result.history.length-1;
 node('line',{x1:x(historyEnd),x2:x(historyEnd),y1:20,y2:230,class:'forecast-boundary'});
 const path=(list,start)=>list.map((p,i)=>(i?'L':'M')+x(start+i).toFixed(2)+','+y(p.close).toFixed(2)).join(' ');
 node('path',{d:path(result.history,0),class:'forecast-history'});
 node('path',{d:path([result.history.at(-1),...result.forecast],historyEnd),class:'forecast-predicted'});
 for(const [i,anchor]of [[0,'start'],[historyEnd,'middle'],[points.length-1,'end']]){
  node('text',{x:x(i),y:256,'text-anchor':anchor,class:'forecast-label'},new Date(points[i].time).toISOString().slice(11,16)+' UTC');
 }
}
function showForecast(result){
 $('kronos-result').hidden=false;
 $('kronos-summary').textContent=result.asset+' · '+result.interval+' · '+result.horizon+' forecast candles';
 $('kronos-change').textContent=(result.end_change_pct>=0?'+':'')+result.end_change_pct.toFixed(2)+'% at path end';
 $('kronos-details').textContent=result.candle_source+' · Kronos-mini · Generated '+new Date(result.generated_at).toLocaleString()+'. '+result.method+' Turnover input is estimated from volume and mean OHLC. Candle timestamps mark each interval’s start.';
 $('kronos-prices').replaceChildren();
 for(const p of result.forecast){
  const tr=document.createElement('tr'),time=document.createElement('td'),price=document.createElement('td');
  time.textContent=new Date(p.time).toISOString().replace('T',' ').slice(0,16);price.textContent=money(p.close);
  tr.append(time,price);$('kronos-prices').append(tr);
 }
 drawForecast(result);
 $('kronos-message').textContent=result.cached?'Showing the same recent candle forecast from the one-minute cache.':'Forecast ready. Entry reviews and wallet approvals are unchanged.';
}
$('kronos-form').onsubmit=async event=>{
 event.preventDefault();if(forecastController||evaluationController||!kronosReady)return;
 invalidateForecast();const version=forecastVersion,controller=new AbortController();forecastController=controller;forecastButtons();
 $('kronos-message').textContent='Reading completed candles and running Kronos locally… This can take up to two minutes.';
 try{
  const response=await fetch('/wallet/kronos/forecast',{method:'POST',headers:{'Content-Type':'application/json','X-Wallet-Bridge':'1'},
   body:JSON.stringify({asset:$('kronos-asset').value,interval:$('kronos-interval').value,horizon:Number($('kronos-horizon').value)}),signal:controller.signal});
  const result=await response.json();if(!response.ok)throw new Error(result.error||'Forecast failed');
  if(version===forecastVersion)showForecast(result);
 }catch(e){if(version===forecastVersion)$('kronos-message').textContent=e.name==='AbortError'?'Forecast cancelled.':e.message;}
 finally{if(forecastController===controller)forecastController=null;forecastButtons();}
};
void kronosStatus();


let evaluationController=null,evaluationVersion=0;
function evaluationButtons(){
 $('kronos-evaluate').disabled=!kronosReady||!!forecastController||!!evaluationController;
 $('kronos-eval-cancel').hidden=!evaluationController;
 $('kronos-generate').disabled=!kronosReady||!!forecastController||!!evaluationController;
}
function invalidateEvaluation(){
 evaluationVersion++;evaluationController?.abort();$('kronos-eval-result').hidden=true;
}
$('kronos-form').addEventListener('input',()=>{
 invalidateEvaluation();$('kronos-eval-message').textContent='Settings changed. Run a new evaluation.';
});
$('kronos-eval-cancel').onclick=()=>{
 invalidateEvaluation();$('kronos-eval-message').textContent='Evaluation cancelled. No settings were changed.';
};
function showEvaluation(report){
 $('kronos-eval-result').hidden=false;
 $('kronos-eval-conclusion').textContent=report.conclusion;
 const date=t=>new Date(t).toISOString().replace('T',' ').slice(0,16)+' UTC';
 $('kronos-eval-meta').textContent=report.asset+' · '+report.interval+' · '+report.horizon+'-candle forecasts · '+report.candle_count+' completed candles. '+date(report.start_time)+' to '+date(report.end_time)+'. Selected on earlier data: '+report.selected_profile+'. Data ID: '+report.dataset_hash.slice(0,12)+'.';
 $('kronos-eval-scores').replaceChildren();
 for(const [phase,rows]of [['Selection',report.tuning],['Holdout',[...report.holdout,report.baseline]]]){
  for(const row of rows){
   const tr=document.createElement('tr');
   for(const value of [phase,row.id+(row.id===report.selected_profile?' (selected)':''),money(row.mae_usd),money(row.rmse_usd),row.mape_pct.toFixed(3)+'%',row.direction_correct+'/'+row.direction_total+' ('+row.direction_accuracy_pct.toFixed(1)+'%)']){
    const td=document.createElement('td');td.textContent=value;tr.append(td);
   }
   $('kronos-eval-scores').append(tr);
  }
 }
 $('kronos-eval-snippets').replaceChildren();
 for(const row of report.rows.filter(r=>r.phase==='holdout'&&r.profile===report.selected_profile)){
  const details=document.createElement('details'),summary=document.createElement('summary'),table=document.createElement('table');
  summary.textContent='Snippet '+(row.window-report.selection_windows+1)+' · context ends '+date(row.context_end)+' · starting close '+money(row.origin_close);
  table.className='forecast-table';const header=document.createElement('tr');
  for(const label of ['Candle starts (UTC)','Predicted close','Actual close','Absolute error']){const th=document.createElement('th');th.textContent=label;header.append(th);}
  table.append(header);
  row.actual.forEach((p,i)=>{
   const tr=document.createElement('tr');
   for(const value of [date(p.time),money(row.predicted[i].close),money(p.close),money(Math.abs(row.predicted[i].close-p.close))]){
    const td=document.createElement('td');td.textContent=value;tr.append(td);
   }
   table.append(tr);
  });
  const scroll=document.createElement('div');scroll.className='table-scroll';scroll.append(table);
  details.append(summary,scroll);$('kronos-eval-snippets').append(details);
 }
 $('kronos-eval-message').textContent='Evaluation saved locally. No live settings, model weights or wallet permissions were changed.';
}
$('kronos-evaluate').onclick=async()=>{
 if(evaluationController||forecastController||!kronosReady)return;
 invalidateEvaluation();const version=evaluationVersion,controller=new AbortController();evaluationController=controller;evaluationButtons();
 $('kronos-eval-message').textContent='Replaying historical snippets locally, then scoring the held-out period… Allow up to eight minutes.';
 try{
  const response=await fetch('/wallet/kronos/evaluate',{method:'POST',headers:{'Content-Type':'application/json','X-Wallet-Bridge':'1'},
   body:JSON.stringify({asset:$('kronos-asset').value,interval:$('kronos-interval').value,horizon:Number($('kronos-horizon').value)}),signal:controller.signal});
  const result=await response.json();if(!response.ok)throw new Error(result.error||'Evaluation failed');
  if(version===evaluationVersion)showEvaluation(result);
 }catch(e){if(version===evaluationVersion)$('kronos-eval-message').textContent=e.name==='AbortError'?'Evaluation cancelled.':e.message;}
 finally{if(evaluationController===controller)evaluationController=null;evaluationButtons();}
};
const initialEvaluationVersion=evaluationVersion;
api('kronos/evaluation/latest').then(report=>{
 if(report&&initialEvaluationVersion===evaluationVersion&&!evaluationController)showEvaluation(report);
}).catch(e=>{$('kronos-eval-message').textContent=e.message;});


let candidateController=null,candidateScan=null;
const candidateTime=t=>new Date(t).toLocaleString();
function candidateControls(){
 $('candidate-scan').disabled=!!candidateController;
 $('candidate-cancel').hidden=!candidateController;
}
function showCandidate(scan){
 candidateScan=scan;$('candidate-result').hidden=false;
 const choice=scan.decision?.id;
 $('candidate-summary').textContent=scan.status==='unconfigured'?'Snapshot collected. Configure the Jev gateway key to rank candidates.':
  scan.status==='watch'?'Jev found no candidate ready for a review route.':
  choice?'Jev selected '+scan.snapshot.candidates.find(c=>c.id===choice)?.label+' for deeper review.':'Candidate scan completed without a ranking.';
 $('candidate-meta').textContent='Collected '+candidateTime(scan.created_at)+' · Expires '+candidateTime(scan.snapshot.expires_at)+' · Snapshot '+scan.snapshot_hash.slice(0,12)+
  (scan.decision?' · '+scan.decision.model:'');
 $('candidate-outcome').textContent=scan.outcome?.status==='observed'?'Observed SOL move: '+scan.outcome.realized_change_pct.toFixed(2)+'% over eight candles.'+(scan.outcome.selected_direction_matched===null?'':' Selected direction '+(scan.outcome.selected_direction_matched?'matched.':'did not match.')):'Outcome pending until eight future SOL candles complete.';
 $('candidate-list').replaceChildren();
 const list=scan.ranked.length?scan.ranked:scan.snapshot.candidates;
 for(const c of list){
  const card=document.createElement('article'),title=document.createElement('h3'),desc=document.createElement('p'),badge=document.createElement('span');
  title.textContent=c.label;desc.textContent=c.description;
  badge.textContent=c.selection_share===undefined?'Unranked':(c.selection_share*100).toFixed(1)+'% review share';
  badge.className='tag';card.append(title,badge,desc);
  if(c.id===choice&&scan.status==='review_candidates'&&c.execution_scope==='saved_SOL_plan'){
   const button=document.createElement('button');button.type='button';button.textContent='Review in entry controls';
   button.disabled=Date.now()>=scan.snapshot.expires_at;
   button.onclick=()=>{
    if(Date.now()>=scan.snapshot.expires_at){$('candidate-message').textContent='This scan expired. Scan again before reviewing.';return;}
    $('entry-side').value=c.side;$('entry-side').dispatchEvent(new Event('input',{bubbles:true}));
    $('entry-form').scrollIntoView({behavior:'smooth',block:'start'});
    if(account)$('entry-form').requestSubmit();
    else $('candidate-message').textContent='Connect Jupiter Wallet, then preview this selected SOL setup in Entry controls.';
   };
   card.append(button);
  }
  $('candidate-list').append(card);
 }
 $('candidate-evidence').replaceChildren();
 for(const lane of scan.snapshot.lanes){
  const block=document.createElement('div'),heading=document.createElement('h4'),p=document.createElement('p');
  heading.textContent=lane.asset+' · '+lane.interval;
  p.textContent='Completed '+candidateTime(lane.last_completed_time)+' · Close '+money(lane.last_completed_close)+
   ' · 8-bar change '+lane.change_8_bars_pct.toFixed(2)+'% · RSI '+lane.rsi_14.toFixed(1)+
   ' · EMA '+money(lane.ema_21)+' · ATR '+money(lane.atr_14)+
   (lane.market?' · Jupiter mark '+money(lane.market.index_price)+' · 24h '+lane.market.stats_24h.change_pct.toFixed(2)+'%':' · Jupiter market unavailable');
  block.append(heading,p);$('candidate-evidence').append(block);
 }
 const more=document.createElement('p');
 more.textContent='Kronos: '+(scan.snapshot.forecast?scan.snapshot.forecast.end_change_pct.toFixed(2)+'% at the 8-candle path end':'unavailable')+
  '. Warnings: '+(scan.snapshot.warnings.length?scan.snapshot.warnings.join('; '):'none')+
  '. Wallet: '+(scan.snapshot.wallet_connected?'connected at scan time':'not connected at scan time')+'.';
 $('candidate-evidence').append(more);
 $('candidate-message').textContent=scan.status==='review_candidates'?'Review the highlighted setup and run a fresh server preview.':
  scan.status==='watch'?'Keep watching or examine the evidence. No candidate was sent to entry review.':'Snapshot saved locally; Jev ranking awaits its key.';
}
$('candidate-cancel').onclick=()=>{candidateController?.abort();$('candidate-message').textContent='Scan cancelled.';};
$('candidate-outcome-button').onclick=async()=>{try{const result=await api('candidates/outcome',{});$('candidate-outcome').textContent=result.status==='observed'?'Observed SOL move: '+result.realized_change_pct.toFixed(2)+'% over eight candles.'+(result.selected_direction_matched===null?'':' Selected direction '+(result.selected_direction_matched?'matched.':'did not match.')):result.reason;}catch(e){$('candidate-outcome').textContent=e.message;}};
$('candidate-scan').onclick=async()=>{
 if(candidateController)return;const controller=new AbortController();candidateController=controller;candidateControls();
 $('candidate-message').textContent='Collecting market evidence and asking Jev to rank review options…';
 try{
  const response=await fetch('/wallet/candidates/scan',{method:'POST',headers:{'Content-Type':'application/json','X-Wallet-Bridge':'1'},body:'{}',signal:controller.signal});
  const result=await response.json();if(!response.ok)throw new Error(result.error||'Candidate scan failed');
  showCandidate(result);
 }catch(e){$('candidate-message').textContent=e.name==='AbortError'?'Scan cancelled.':e.message;}
 finally{if(candidateController===controller)candidateController=null;candidateControls();}
};
api('candidates/status').then(status=>{
 $('candidate-provider').textContent=status.configured?'Jev · Key stored':'Jev · Key needed';
}).catch(e=>{$('candidate-provider').textContent='Jev · Offline';$('candidate-message').textContent=e.message;});
api('candidates/latest').then(scan=>{if(scan&&!candidateController)showCandidate(scan);else if(!scan)$('candidate-message').textContent='No scan yet. Click Scan candidates.';}).catch(e=>{$('candidate-message').textContent=e.message;});
