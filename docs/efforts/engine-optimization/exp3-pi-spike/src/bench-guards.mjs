import { spawnSync } from 'node:child_process';
const HOME='/private/tmp/e3pi', G=HOME+'/.instar/hooks/instar';
const env={...process.env,CLAUDE_PROJECT_DIR:HOME}; delete env.INSTAR_SESSION_ID; delete env.INSTAR_AUTH_TOKEN;
const time=(f,n=20)=>{const t=[];for(let i=0;i<n;i++){const a=performance.now();f();t.push(performance.now()-a);}t.sort((x,y)=>x-y);return {median:Math.round(t[n>>1]),p90:Math.round(t[Math.floor(n*0.9)])};};
console.log(JSON.stringify({
 commandGuard_allowed: time(()=>spawnSync('bash',[G+'/dangerous-command-guard.sh','ls -la'],{env})),
 externalGate_write: time(()=>spawnSync('node',[G+'/external-operation-gate.js'],{env,input:JSON.stringify({tool_name:'mcp__extsvc__send_message',tool_input:{to:'a'}})})),
 externalGate_read: time(()=>spawnSync('node',[G+'/external-operation-gate.js'],{env,input:JSON.stringify({tool_name:'mcp__extsvc__list_records',tool_input:{}})})),
}));
