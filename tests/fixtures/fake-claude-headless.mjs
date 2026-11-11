#!/usr/bin/env node
// A minimal stand-in for Claude Code's headless mode (adapter verification suite e2e):
// sessions in a real-shaped JSONL transcript, the project's hooks run through `sh` with
// Claude Code's payloads, `/compact` and `/clear`, a deny-able Bash call, resume.
// The "model" sees exactly the WORD-1234 tokens its context holds. State persists in
// FAKE_CLAUDE_STATE between invocations.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
if (args[0] === '--version') { process.stdout.write('2.1.322 (Claude Code)\n'); process.exit(0); }
const root = process.env.FAKE_CLAUDE_HOME;
// Which credential each engine call arrived with (the suite must pass the configured key).
fs.appendFileSync(path.join(root, 'auth-seen'), `${process.env.CLAUDE_CODE_OAUTH_TOKEN ?? '(none)'}\n`);
const ctxFile = path.join(root, 'contexts.json');
const contexts = fs.existsSync(ctxFile) ? JSON.parse(fs.readFileSync(ctxFile, 'utf-8')) : {};
const cwd = process.cwd();
const settings = JSON.parse(fs.readFileSync(path.join(cwd, '.claude', 'settings.json'), 'utf-8'));
const tdir = path.join(root, 'projects', cwd.replace(/[/.]/g, '-'));
fs.mkdirSync(tdir, { recursive: true });
const sid = args[args.indexOf(args.includes('--resume') ? '--resume' : '--session-id') + 1];
const prompt = args[args.length - 1];
const tp = (id) => path.join(tdir, `${id}.jsonl`);
const write = (id, e) => fs.appendFileSync(tp(id), JSON.stringify({ uuid: crypto.randomUUID(), sessionId: id, version: '2.1.322', timestamp: new Date().toISOString(), ...e }) + '\n');
const hook = (event, matcher, payload) => {
  let out = '';
  for (const h of settings.hooks[event] ?? []) {
    if (matcher !== null && h.matcher !== '' && h.matcher !== '*' && h.matcher !== matcher) continue;
    for (const c of h.hooks) out += spawnSync('sh', ['-c', c.command], { input: JSON.stringify({ hook_event_name: event, ...payload }), encoding: 'utf-8' }).stdout;
  }
  return out.trim();
};
const tokens = (t) => t.match(/\b[A-Z]+-\d{4}\b/g) ?? [];
const save = () => fs.writeFileSync(ctxFile, JSON.stringify(contexts));
let ctx = contexts[sid] ?? null;
if (ctx === null) ctx = fs.existsSync(tp(sid)) ? [...new Set(tokens(fs.readFileSync(tp(sid), 'utf-8')))] : [];
const see = (t) => { for (const m of tokens(t)) if (!ctx.includes(m)) ctx.push(m); };
if (prompt === '/compact') {
  const steer = hook('PreCompact', null, { session_id: sid, transcript_path: tp(sid), trigger: 'manual', custom_instructions: '' });
  const summary = `Summary. ${steer} Tokens: ${ctx.join(' ')}`;
  write(sid, { type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'manual' } });
  hook('PostCompact', null, { session_id: sid, transcript_path: tp(sid), trigger: 'manual', compact_summary: summary });
  const seed = hook('SessionStart', 'compact', { session_id: sid, transcript_path: tp(sid), source: 'compact' });
  write(sid, { type: 'attachment', attachment: { type: 'hook_success', hookName: 'SessionStart:compact', stdout: seed, exitCode: 0 } });
  ctx = []; see(summary); see(seed); contexts[sid] = ctx; save(); process.exit(0);
}
if (prompt === '/clear') {
  const ns = crypto.randomUUID();
  const seed = hook('SessionStart', 'clear', { session_id: ns, transcript_path: tp(ns), source: 'clear' });
  write(ns, { type: 'attachment', attachment: { type: 'hook_success', hookName: 'SessionStart:clear', stdout: seed } });
  contexts[ns] = [...tokens(seed)]; save(); process.exit(0);
}
const ups = hook('UserPromptSubmit', null, { session_id: sid, transcript_path: tp(sid), prompt });
let add = ''; try { add = JSON.parse(ups).hookSpecificOutput?.additionalContext ?? ''; } catch { /* none */ }
write(sid, { type: 'user', message: { content: prompt } });
see(prompt); see(add);
if (args.some((a) => a.startsWith('--allowedTools'))) {
  const command = (/Run exactly this shell command: (.+?) \. Then/.exec(prompt) ?? [])[1] ?? 'true';
  const deny = hook('PreToolUse', 'Bash', { session_id: sid, tool_name: 'Bash', tool_input: { command } });
  let reason = ''; try { reason = JSON.parse(deny).hookSpecificOutput?.permissionDecisionReason ?? ''; } catch { /* allow */ }
  if (reason) write(sid, { type: 'user', message: { content: [{ type: 'tool_result', is_error: true, content: reason }] } });
  else { spawnSync('sh', ['-c', command]); write(sid, { type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } }); }
}
const reply = /List every token/.test(prompt) ? (ctx.filter((t) => !prompt.includes(t)).join(' ') || 'NONE')
  : /What codeword/.test(prompt) ? (ctx.find((t) => t.startsWith('ALPHA-')) ?? 'NONE') : 'OK';
write(sid, { type: 'assistant', message: { content: reply } });
contexts[sid] = ctx; save();
process.stdout.write(`${reply}\n`);
