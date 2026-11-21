// Proves each check rejects the untouched repo, so a do-nothing run can never count as success.
import fs from 'node:fs'; import { tasks } from './tasks.mjs';
const t=JSON.parse(fs.readFileSync('truth.json','utf8')); const d='/private/tmp/claude-501/e2cm/validate';
fs.rmSync(d,{recursive:true,force:true}); fs.cpSync('/private/tmp/claude-501/e2cm/template',d,{recursive:true});
for (const k of tasks){ let r; try{r=!!k.check(d,t)}catch{r=false} console.log(k.id, r?'WRONGLY PASSES':'rejects untouched repo'); }
fs.rmSync(d,{recursive:true,force:true});
