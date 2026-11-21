import { query } from '@anthropic-ai/claude-agent-sdk';
const CLI='/Users/dabombstudio/.instar/agents/echo/.instar/state/claude-bin/2.1.330/claude';
for (const arm of ['off','on']) {
  const settings = JSON.stringify({ env: { CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: arm==='on'?'1':'0' } });
  const tools=[]; let init, res;
  try {
    for await (const m of query({ prompt:'Read a.txt and b.txt in the current folder, then tell me which line appears in both. Answer with just the word.',
      options:{ cwd:'/private/tmp/claude-501/e2cm/smoke', model:'claude-sonnet-5-5', settingSources:[], persistSession:false, maxTurns:12,
        permissionMode:'bypassPermissions', allowDangerouslySkipPermissions:true, pathToClaudeCodeExecutable:CLI, extraArgs:{ settings } } })) {
      if (m.type==='system'&&m.subtype==='init') init=m;
      if (m.type==='assistant') for (const b of m.message.content) if (b.type==='tool_use') tools.push(b.name);
      if (m.type==='result') res=m;
    }
  } catch(e){ console.log(arm,'ERROR',String(e).slice(0,400)); continue; }
  console.log(JSON.stringify({arm, model:init?.model, version:init?.claude_code_version, nTools:init?.tools?.length, hasRepl:(init?.tools||[]).filter(t=>/repl|code/i.test(t)), used:tools, result:res?.result, subtype:res?.subtype, turns:res?.num_turns, cost:res?.total_cost_usd, usage:res?.usage&&{i:res.usage.input_tokens,o:res.usage.output_tokens,cr:res.usage.cache_read_input_tokens,cw:res.usage.cache_creation_input_tokens}}));
}
