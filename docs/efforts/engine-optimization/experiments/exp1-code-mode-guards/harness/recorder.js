// Neutral test instrument: logs every hook event it sees. Never blocks.
const fs=require('fs');let d='';process.stdin.on('data',c=>d+=c);process.stdin.on('end',()=>{
 let e={};try{e=JSON.parse(d)}catch{}
 const ti=JSON.stringify(e.tool_input||{});
 fs.appendFileSync('/private/tmp/claude-501/cmx-lab/calls.jsonl',JSON.stringify({ts:new Date().toISOString(),ev:e.hook_event_name,tool:e.tool_name,id:e.tool_use_id,input:ti.slice(0,600),err:e.error?String(e.error).slice(0,300):undefined,run:process.env.CMX_RUN||''})+'\n');
 process.exit(0);});
