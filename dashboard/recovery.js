'use strict';
const $=id=>document.getElementById(id);let token='',session='';
async function api(path,method='GET'){
 const r=await fetch(path,{method,cache:'no-store',headers:{Authorization:'Bearer '+token,'X-Instar-Operator-Session':session,'Content-Type':'application/json'},...(method==='POST'?{body:'{}'}:{})});const result=await r.json();
 if(!r.ok)throw Error(result.detail||({'recovery-authority-setup-required':'The recovery authority still needs to be commissioned on its host. Your agent can prepare its certificate request; an untrusted local key cannot enable recovery.'})[result.error]||'Recovery setup could not finish. Open the authority and phone setup instructions to complete the missing step.');return result;
}
async function run(fn){for(const b of document.querySelectorAll('button'))b.disabled=true;try{await fn();}catch(e){$('result').textContent=e.message;}finally{for(const b of document.querySelectorAll('button'))b.disabled=false;}}
async function refresh(){
 const r=await api('/recovery/setup'),s=r.setup;
 const reasons={'recovery-release-root-not-installed':'Install the current trusted release before commissioning recovery.','recovery-authority-setup-required':'Commission the recovery authority and enroll your phone using the setup instructions below.','recovery-authority-config-invalid':'Repair the installed authority configuration using the setup instructions below.','target-awaiting-peer-proofs':'Waiting for a paired machine to verify this machine’s two recovery routes.'};
 $('posture').textContent=s?.ready?'Both recovery routes are verified.':reasons[s?.reason]||'Recovery is incomplete. Prepare this machine, approve its paired machines, then finish verification.';
 $('requiredSteps').replaceChildren();if(!s?.ready)for(const step of s?.requiredSteps||[]){const item=document.createElement('li');item.textContent=step;$('requiredSteps').append(item);}
}
$('unlockButton').onclick=()=>run(async()=>{const response=await fetch('/dashboard/unlock',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pin:$('pin').value})});$('pin').value='';const result=await response.json();if(!response.ok||!result.token||!result.operatorSessionToken)throw Error('The dashboard PIN was not accepted.');token=result.token;session=result.operatorSessionToken;await refresh();$('unlock').hidden=true;$('setup').hidden=false;});
$('prepare').onclick=()=>run(async()=>{await api('/recovery/setup/prepare','POST');$('result').textContent='This machine is prepared. Approve access from your enrolled phone next.';await refresh();});
$('approve').onclick=()=>run(async()=>{const result=await api('/recovery/setup/owner-link','POST');const url=new URL(result.url);if(url.protocol!=='https:')throw Error('The phone approval address is not secure.');$('approvalLink').href=url.href;$('approvalLink').hidden=false;$('result').textContent='Open phone approval to review the exact recovery scope. Your private phone key stays on this phone.';});
$('install').onclick=()=>run(async()=>{await api('/recovery/setup/install','POST');$('result').textContent='Recovery services installed. Waiting for fresh proofs from a paired machine.';await refresh();});$('refresh').onclick=()=>run(refresh);
