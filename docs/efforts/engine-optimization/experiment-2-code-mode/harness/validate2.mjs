import fs from 'node:fs'; import path from 'node:path'; import { execSync } from 'node:child_process'; import { tasks } from './tasks.mjs';
const t=JSON.parse(fs.readFileSync('truth.json','utf8')); const d='/private/tmp/claude-501/e2cm/validate';
fs.rmSync(d,{recursive:true,force:true}); fs.cpSync('/private/tmp/claude-501/e2cm/template',d,{recursive:true}); fs.mkdirSync(d+'/out');
const w=(f,s)=>fs.writeFileSync(path.join(d,f),s), r=f=>fs.readFileSync(path.join(d,f),'utf8');
// Reference solution for every task, to prove each check CAN pass.
w('src/lib/pagination.js', r('src/lib/pagination.js').replace('page * size','(page - 1) * size'));
for (const f of fs.readdirSync(d+'/src/services')) w('src/services/'+f, r('src/services/'+f).replace(/\blegacyFetch\b/g,'safeFetch'));
w('src/net/client.js', r('src/net/client.js').replace(/\blegacyFetch\b/g,'safeFetch'));
for (const f of fs.readdirSync(d+'/src/jobs')) { const s=r('src/jobs/'+f); if(!s.includes('timeoutMs')) w('src/jobs/'+f, s.replace("};","  timeoutMs: 30000,\n};")); }
w('src/lib/num.js', r('src/lib/num.js')+"\nexport function clamp(v,a,b){ if(a>b) throw new RangeError('x'); if(Number.isNaN(v)) return NaN; return Math.min(b,Math.max(a,v)); }\n");
w('tests/num.test.js',"import test from 'node:test';import assert from 'node:assert/strict';import {clamp} from '../src/lib/num.js';test('c',()=>assert.equal(clamp(5,1,3),3));\n");
w('out/top-error.json',JSON.stringify(t.topError)); w('out/top3.json',JSON.stringify(t.top3)); w('out/broken.json',JSON.stringify(t.broken)); w('out/todos.csv',t.todos.join('\n')+'\n'); w('out/commit.txt',t.magicCommit+'\n'); w('out/dead.json',JSON.stringify(t.dead)); w('out/incident.json',JSON.stringify(t.incident));
w('docs/API.md','# API\n\n| Method | Path |\n| --- | --- |\n'+t.routes.map(x=>`| ${x.method} | ${x.path} |`).join('\n')+'\n');
let bad=0; for (const k of tasks){ let ok=false,e=''; try{ok=!!k.check(d,t)}catch(x){e=String(x).slice(0,120)} if(!ok)bad++; console.log(k.id, ok?'passes reference':'FAILS reference '+e); }
console.log('todo sample',t.todos.slice(0,2)); console.log('reference failures',bad); fs.rmSync(d,{recursive:true,force:true});
