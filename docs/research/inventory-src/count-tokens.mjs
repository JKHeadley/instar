// Usage: TOK=<Anthropic API key or OAuth token> node count-tokens.mjs <units.json from segment.mjs> <out token-counts.json> <CLAUDE.md>
// Uses POST /v1/messages/count_tokens (free; spends no quota). With an OAuth token the oauth-2025-04-20 beta header is required.
import fs from 'fs';
const [unitsF, outF, srcF] = process.argv.slice(2);
const T = process.env.TOK; const MODEL='claude-opus-5-5';
async function count(text){ for(let a=0;a<6;a++){ const r=await fetch('https://api.anthropic.com/v1/messages/count_tokens',{method:'POST',headers:{'Authorization':'Bearer '+T,'anthropic-version':'2023-06-01','anthropic-beta':'oauth-2025-04-20','content-type':'application/json'},body:JSON.stringify({model:MODEL,messages:[{role:'user',content:text}]})}); if(r.ok) return (await r.json()).input_tokens; await new Promise(s=>setTimeout(s,2000*(a+1))); } throw new Error('count failed'); }
const units=JSON.parse(fs.readFileSync(unitsF,'utf8'));
const base = await count('a') - 1; // message framing overhead
const out={model:MODEL,overhead:base,blocks:{}};
for(const u of units){ out.blocks[u.id]=(await count(u.text))-base; }
out.wholeFile=(await count(fs.readFileSync(srcF,'utf8')))-base;
fs.writeFileSync(outF,JSON.stringify(out,null,1));
console.log('overhead',base,'sumBlocks',Object.values(out.blocks).reduce((a,b)=>a+b,0),'whole',out.wholeFile);
