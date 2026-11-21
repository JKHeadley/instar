// Usage: node runner.mjs <firstTaskIndex> <lastTaskIndexExclusive>
// Appends one row per run to results.jsonl and skips runs already recorded, so it can resume.
import fs from 'node:fs';
import path from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { tasks } from './tasks.mjs';

const H = '/private/tmp/claude-501/e2cm';
const CLI = '/Users/dabombstudio/.instar/agents/echo/.instar/state/claude-bin/2.1.330/claude';
const MODEL = 'claude-sonnet-5-5';
const OUT = `${H}/harness/results.jsonl`;
const CONCURRENCY = 3, RUN_TIMEOUT_MS = 8 * 60_000, MAX_TURNS = 40, RUN_BUDGET_USD = 3, TOTAL_CAP_USD = 60;
const truth = JSON.parse(fs.readFileSync(`${H}/harness/truth.json`, 'utf8'));
const [from, to] = [Number(process.argv[2] ?? 0), Number(process.argv[3] ?? tasks.length)];
const DENY = ['CronCreate', 'CronDelete', 'RemoteTrigger', 'PushNotification', 'SendMessage', 'ScheduleWakeup', 'WebSearch', 'WebFetch', 'Workflow', 'DesignSync', 'Task', 'EnterWorktree', 'ExitWorktree', 'ListAgents', 'Monitor'];
const baseEnv = { ...process.env };
for (const k of ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_PID', 'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'INSTAR_AUTH_TOKEN']) delete baseEnv[k];

const rows = fs.existsSync(OUT) ? fs.readFileSync(OUT, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
const done = new Set(rows.map((r) => `${r.task}|${r.arm}|${r.rep}`));
let spent = rows.reduce((s, r) => s + (r.cost || 0), 0);

async function once(task, arm, rep) {
  const v = arm === 'on' ? '1' : '0';
  const dir = `${H}/agent/runs/${task.id}-${arm}-${rep}`;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.cpSync(`${H}/template`, dir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'out'), { recursive: true });
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), RUN_TIMEOUT_MS);
  const started = Date.now();
  let res, direct = 0, marked = 0, unmarked = 0, error = null;
  try {
    for await (const m of query({
      prompt: `${task.prompt}\n\nWork only inside the current folder. Do not ask questions; finish the task.`,
      options: { abortController: ac, env: { ...baseEnv, CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: v }, cwd: dir, model: MODEL, settingSources: [], persistSession: false, maxTurns: MAX_TURNS, maxBudgetUsd: RUN_BUDGET_USD, disallowedTools: DENY, permissionMode: 'bypassPermissions', allowDangerouslySkipPermissions: true, pathToClaudeCodeExecutable: CLI, extraArgs: { settings: JSON.stringify({ env: { CLAUDE_CODE_EXPERIMENTAL_CODE_MODE: v } }) } },
    })) {
      if (m.type === 'assistant') for (const b of m.message.content) if (b.type === 'tool_use') { direct++; if ('caller' in b) marked++; else unmarked++; }
      if (m.type === 'result') res = m;
    }
  } catch (e) { error = String(e).slice(0, 200); }
  clearTimeout(timer);
  let success = false, checkError = null;
  if (res) { try { success = !!task.check(dir, truth); } catch (e) { checkError = String(e).slice(0, 160); } }
  const armOk = direct === 0 ? null : (arm === 'on' ? marked === 0 : unmarked === 0);
  const u = res?.usage || {};
  fs.rmSync(dir, { recursive: true, force: true });
  return { task: task.id, arm, rep, success, armOk, subtype: res?.subtype ?? 'none', error, checkError, cost: res?.total_cost_usd ?? 0, turns: res?.num_turns ?? 0, toolCalls: direct, input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0, cacheWrite: u.cache_creation_input_tokens ?? 0, ms: Date.now() - started, at: new Date().toISOString() };
}

const queue = [];
tasks.slice(from, to).forEach((task, ti) => { for (let rep = 0; rep < 3; rep++) { const order = (ti + rep) % 2 === 0 ? ['off', 'on'] : ['on', 'off']; for (const arm of order) if (!done.has(`${task.id}|${arm}|${rep}`)) queue.push({ task, arm, rep }); } });
console.log(`queued ${queue.length} runs, spent so far $${spent.toFixed(2)}`);

async function worker() {
  while (queue.length) {
    if (spent >= TOTAL_CAP_USD) { console.log('SPEND CAP REACHED'); queue.length = 0; return; }
    const { task, arm, rep } = queue.shift();
    let r = await once(task, arm, rep);
    if (!r.subtype || r.subtype === 'none') { spent += r.cost; r = { ...(await once(task, arm, rep)), retried: true }; }
    spent += r.cost;
    fs.appendFileSync(OUT, JSON.stringify(r) + '\n');
    console.log(`${r.task} ${r.arm} #${r.rep} ok=${r.success} armOk=${r.armOk} $${r.cost.toFixed(3)} turns=${r.turns} ${r.subtype}${r.error ? ' ERR ' + r.error : ''}${r.checkError ? ' CHECK ' + r.checkError : ''}`);
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, worker));
console.log(`finished, total $${spent.toFixed(2)}`);
