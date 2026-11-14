/** Persistent finite restart budget, distinct from the main server supervisor. */
import fs from 'node:fs';
import path from 'node:path';
import { recoveryDigest } from './RecoveryProtocol.js';
interface Budget { cause:string; starts:number[]; cycles:number[]; cooldownUntil:number; exhausted:boolean }
export function admitRecoverySupervisor(stateDir:string,cause:unknown,now=Date.now()): {admitted:boolean;retryAt:number;exhausted:boolean} {
  fs.mkdirSync(stateDir,{recursive:true,mode:0o700});
  const directory=fs.lstatSync(stateDir);
  if(!directory.isDirectory()||directory.isSymbolicLink()||directory.uid!==process.getuid?.()||(directory.mode&0o077))throw new Error('recovery-supervisor-state-invalid');
  const file=path.join(stateDir,'sidecar-supervisor.json');const digest=recoveryDigest(cause);
  let budget:Budget={cause:digest,starts:[],cycles:[],cooldownUntil:0,exhausted:false};
  if(fs.existsSync(file)) {
    const st=fs.lstatSync(file);
    if(!st.isFile()||st.isSymbolicLink()||st.size>16_384||st.uid!==process.getuid?.()||(st.mode&0o077))throw new Error('recovery-supervisor-state-invalid');
    const stored=JSON.parse(fs.readFileSync(file,'utf8')) as Budget;
    if(!Array.isArray(stored.starts)||!Array.isArray(stored.cycles)||stored.starts.length>3||stored.cycles.length>2
      || [...stored.starts,...stored.cycles,stored.cooldownUntil].some(value=>!Number.isSafeInteger(value)||value<0)
      || typeof stored.exhausted!=='boolean'||typeof stored.cause!=='string')throw new Error('recovery-supervisor-state-invalid');
    if(stored.cause===digest)budget=stored;
  }
  if(budget.exhausted)return {admitted:false,retryAt:0,exhausted:true};
  if(now<budget.cooldownUntil)return {admitted:false,retryAt:budget.cooldownUntil,exhausted:false};
  budget.starts=budget.starts.filter(at=>at>now-120_000);budget.cycles=budget.cycles.filter(at=>at>now-60*60_000);
  let admitted=true;
  if(budget.starts.length>=3) {
    admitted=false;budget.cycles.push(now);budget.cooldownUntil=now+15*60_000;budget.starts=[];
    if(budget.cycles.length>=2)budget.exhausted=true;
  } else budget.starts.push(now);
  const tmp=`${file}.${process.pid}.tmp`;fs.writeFileSync(tmp,JSON.stringify(budget),{mode:0o600});fs.renameSync(tmp,file);
  const log=path.join(stateDir,'supervisor-events.jsonl');
  for(const candidate of [log,log+'.previous']) {
    try {
      const st=fs.lstatSync(candidate);
      if(!st.isFile()||st.isSymbolicLink()||st.uid!==process.getuid?.()||(st.mode&0o077))throw new Error('recovery-supervisor-state-invalid');
    } catch(error) {if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  }
  if(fs.existsSync(log)&&fs.statSync(log).size>262_144)fs.renameSync(log,log+'.previous');
  fs.appendFileSync(log,JSON.stringify({at:now,event:admitted?'start':'breaker',pid:process.pid,cooldownUntil:budget.cooldownUntil,exhausted:budget.exhausted})+'\n',{mode:0o600});
  return {admitted,retryAt:budget.cooldownUntil,exhausted:budget.exhausted};
}
