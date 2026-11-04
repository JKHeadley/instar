// Shared Jev client. Reads the key from the vault; never logs it.
import * as path from 'node:path';
import { createRequire } from 'node:module';
const AGENT='/Users/dabombstudio/.instar/agents/echo';
const require=createRequire(import.meta.url);
const { SecretStore } = require(path.join(AGENT,'.instar/shadow-install/node_modules/instar/dist/core/SecretStore.js'));
const store=new SecretStore({stateDir:path.join(AGENT,'.instar')}); store.read();
const KEY=store.get('typesafe_api_key');
if(!KEY) { console.error('no typesafe_api_key in vault'); process.exit(2); }

export async function ask(state, questions, model='jev-latest'){
  const t0=performance.now();
  const r=await fetch('https://api.typesafe.ai/v1/systemone',{
    method:'POST',
    headers:{'Authorization':`Bearer ${KEY}`,'Content-Type':'application/json'},
    body:JSON.stringify({state,model,questions}),
  });
  const ms=performance.now()-t0;
  const text=await r.text();
  let json=null; try{ json=JSON.parse(text); }catch{}
  return { ok:r.ok, status:r.status, ms, json, raw: r.ok?null:text.slice(0,300) };
}
