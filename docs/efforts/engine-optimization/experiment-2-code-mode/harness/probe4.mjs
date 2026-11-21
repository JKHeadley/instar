import { query } from '@anthropic-ai/claude-agent-sdk';
const CLI=process.env.CLAUDE_CODE_EXECPATH;
const base={...process.env}; for (const k of ['CLAUDECODE','CLAUDE_CODE_ENTRYPOINT','CLAUDE_CODE_CHILD_SESSION','CLAUDE_CODE_SESSION_ATTENDED','CLAUDE_CODE_SESSION_ID','CLAUDE_PID','CLAUDE_CODE_MESSAGING_SOCKET','CLAUDE_CODE_MESSAGING_TOKEN']) delete base[k];
for (const arm of ['off','on']) {
  const v=arm==='on'?'1':'0'; const env={...base, CLAUDE_CODE_EXPERIMENTAL_CODE_MODE:v};
  const settings=JSON.stringify({env:{CLAUDE_CODE_EXPERIMENTAL_CODE_MODE:v}}); const ev=[]; let res, first;
  for await (const m of query({ prompt:'In this folder, read a.txt and b.txt, count the lines of each with a shell command, and report the shared line and both counts. Before acting, state in one short sentence the exact name of the tool you are about to call.',
    options:{ env, cwd:'/private/tmp/claude-501/e2cm/smoke', model:'claude-sonnet-5-5', settingSources:[], persistSession:false, maxTurns:10, permissionMode:'bypassPermissions', allowDangerouslySkipPermissions:true, pathToClaudeCodeExecutable:CLI, extraArgs:{settings} } })) {
    if (m.type==='assistant') { first??=m.message.usage; for (const b of m.message.content) { if (b.type==='tool_use') ev.push({tool:b.name, keys:Object.keys(b).filter(k=>!['type','id','name','input'].includes(k)), parent:m.parent_tool_use_id??null, input:JSON.stringify(b.input).slice(0,110)}); if (b.type==='text') ev.push({text:b.text.slice(0,120)}); } }
    if (m.type==='result') res=m;
  }
  console.log('\n###',arm,'firstCtx',(first.input_tokens+(first.cache_read_input_tokens||0)+(first.cache_creation_input_tokens||0)),'turns',res.num_turns,'cost',res.total_cost_usd,'ok',res.subtype);
  for (const e of ev) console.log(JSON.stringify(e));
}
