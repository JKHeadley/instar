// safe-fs-allow: test file — temp dirs via mkdtemp/rm only.
/**
 * Integration — the adapter verification suite's RUNNER against a fake engine
 * CLI that behaves like Claude Code's headless mode: it writes a real-shaped
 * JSONL transcript and runs the probe hooks from the throwaway project's
 * settings through `sh` with the payloads Claude Code passes. The runner, the
 * probe hooks, the evidence collection, the real engine-checkpoint restore and
 * the evaluator are all real; only the model is replaced (it "sees" exactly the
 * tokens its context holds). A second engine that lacks PostCompact reads
 * `absent` for it.
 */
import { describe, it, expect, afterEach } from 'vitest';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runClaudeCodeAdapterSuite, writeSuiteResult, readSuiteResults, type RunCommand } from '../../src/monitoring/adapterVerificationSuite.js';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';

const OP = 'tests/integration/adapter-verification-suite-runner.test.ts';

/** A minimal headless engine: sessions, hooks, compaction, clear, a deny-able Bash tool, resume. */
function fakeEngine(projectsRoot: string, opts: { noPostCompact?: boolean; ignoreDeny?: boolean } = {}): RunCommand {
  const context = new Map<string, string[]>(); // session id → tokens in its context
  return (args, o) => {
    if (args[0] === '--version') return { status: 0, stdout: '2.1.322 (Claude Code)\n', stderr: '' };
    const settings = JSON.parse(fs.readFileSync(path.join(o.cwd, '.claude', 'settings.json'), 'utf-8')) as { hooks: Record<string, Array<{ matcher: string; hooks: Array<{ command: string }> }>> };
    const tdir = path.join(projectsRoot, o.cwd.replace(/[/.]/g, '-'));
    fs.mkdirSync(tdir, { recursive: true });
    const sid = args[args.indexOf(args.includes('--resume') ? '--resume' : '--session-id') + 1];
    const prompt = args[args.length - 1];
    const tp = (id: string) => path.join(tdir, `${id}.jsonl`);
    const write = (id: string, e: object) => fs.appendFileSync(tp(id), JSON.stringify({ uuid: crypto.randomUUID(), sessionId: id, version: '2.1.322', timestamp: new Date().toISOString(), ...e }) + '\n');
    const hook = (event: string, matcher: string | null, payload: object): string => {
      let out = '';
      for (const h of settings.hooks[event] ?? []) {
        if (matcher !== null && h.matcher !== '' && h.matcher !== '*' && h.matcher !== matcher) continue;
        for (const c of h.hooks) out += spawnSync('sh', ['-c', c.command], { input: JSON.stringify({ hook_event_name: event, ...payload }), env: o.env, encoding: 'utf-8' }).stdout;
      }
      return out.trim();
    };
    const ctx = context.get(sid) ?? [];
    const see = (text: string) => { for (const m of text.match(/\b[A-Z]+-\d{4}\b/g) ?? []) if (!ctx.includes(m)) ctx.push(m); };
    if (prompt === '/compact') {
      const steer = hook('PreCompact', null, { session_id: sid, transcript_path: tp(sid), trigger: 'manual', custom_instructions: '' });
      const summary = `Summary of the conversation. ${steer} Tokens: ${ctx.join(' ')}`;
      write(sid, { type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'manual' } });
      if (!opts.noPostCompact) hook('PostCompact', null, { session_id: sid, transcript_path: tp(sid), trigger: 'manual', compact_summary: summary });
      const seed = hook('SessionStart', 'compact', { session_id: sid, transcript_path: tp(sid), source: 'compact' });
      write(sid, { type: 'attachment', attachment: { type: 'hook_success', hookName: 'SessionStart:compact', stdout: seed, exitCode: 0 } });
      ctx.length = 0; see(summary); see(seed);
      context.set(sid, ctx);
      return { status: 0, stdout: '', stderr: '' };
    }
    if (prompt === '/clear') {
      const ns = crypto.randomUUID();
      const seed = hook('SessionStart', 'clear', { session_id: ns, transcript_path: tp(ns), source: 'clear' });
      write(ns, { type: 'attachment', attachment: { type: 'hook_success', hookName: 'SessionStart:clear', stdout: seed } });
      const nctx: string[] = []; for (const m of seed.match(/\b[A-Z]+-\d{4}\b/g) ?? []) nctx.push(m);
      context.set(ns, nctx);
      return { status: 0, stdout: '', stderr: '' };
    }
    // An ordinary prompt: UserPromptSubmit, then (maybe) a Bash tool call, then a reply.
    if (!fs.existsSync(tp(sid))) { // a resumed materialised session: rebuild context from its transcript
      context.set(sid, []);
    }
    const ups = hook('UserPromptSubmit', null, { session_id: sid, transcript_path: tp(sid), prompt });
    let add = ''; try { add = (JSON.parse(ups) as { hookSpecificOutput?: { additionalContext?: string } }).hookSpecificOutput?.additionalContext ?? ''; } catch { /* no json */ }
    if (fs.existsSync(tp(sid)) && ctx.length === 0) see(fs.readFileSync(tp(sid), 'utf-8'));
    write(sid, { type: 'user', message: { content: prompt } });
    see(prompt); see(add);
    if (args.some((a) => a.startsWith('--allowedTools'))) {
      const command = (/Run exactly this shell command: (.+?) \. Then/.exec(prompt) ?? [])[1] ?? 'true';
      const deny = hook('PreToolUse', 'Bash', { session_id: sid, tool_name: 'Bash', tool_input: { command } });
      let reason = ''; try { reason = (JSON.parse(deny) as { hookSpecificOutput?: { permissionDecisionReason?: string } }).hookSpecificOutput?.permissionDecisionReason ?? ''; } catch { /* allow */ }
      if (reason && !opts.ignoreDeny) {
        write(sid, { type: 'user', message: { content: [{ type: 'tool_result', is_error: true, content: reason }] } });
      } else {
        spawnSync('sh', ['-c', command]); // the tool really runs
        if (reason) write(sid, { type: 'attachment', attachment: { type: 'hook_success', hookName: 'PreToolUse:Bash', stdout: deny } }); // logged, but ignored
        write(sid, { type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } });
      }
    }
    context.set(sid, ctx);
    const reply = /List every token/.test(prompt) ? ctx.filter((t) => !prompt.includes(t)).join(' ') || 'NONE'
      : /What codeword/.test(prompt) ? (ctx.find((t) => t.startsWith('ALPHA-')) ?? 'NONE') : 'OK';
    write(sid, { type: 'assistant', message: { content: reply } });
    return { status: 0, stdout: `${reply}\n`, stderr: '' };
  };
}

describe('adapter verification suite runner (fake headless engine)', () => {
  const dirs: string[] = [];
  afterEach(() => { for (const d of dirs.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: OP }); });

  const setup = () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'suite-runner-')); dirs.push(root);
    return { root, work: path.join(root, 'work'), state: path.join(root, 'state'), projects: path.join(root, 'projects') };
  };

  it('a capable engine: the runner collects evidence through the real probe hooks and every measured capability reads supported', () => {
    const d = setup();
    const { result, evidence } = runClaudeCodeAdapterSuite({ workDir: d.work, stateDir: d.state, machine: 'm1', run: fakeEngine(d.projects) });
    expect(evidence.errors).toEqual([]);
    expect(result).toMatchObject({ engine: 'claude-code', version: '2.1.322', machine: 'm1' });
    const states = Object.fromEntries(Object.entries(result.capabilities).map(([k, v]) => [k, v.state]));
    expect(states).toMatchObject({
      transcriptRead: 'supported', controlCompact: 'supported', controlClear: 'supported', compactionDetection: 'supported',
      preCompactionSteering: 'supported', postCompactSummary: 'supported', seedAfterCompaction: 'supported', seedAfterClear: 'supported',
      materialiseResume: 'supported', perPromptDelta: 'supported', toolPolicy: 'supported', frameworkDiscriminator: 'supported',
    });
    expect(evidence.restoreMode).toBe('materialised');
    // The deny marker is removed after the tool-policy step.
    expect(fs.existsSync(path.join(d.work, '.probe', 'deny-on'))).toBe(false);
    writeSuiteResult(d.state, result);
    expect(readSuiteResults(d.state)[0].capabilities.toolPolicy.state).toBe('supported');
  });

  it('an engine without PostCompact reads it absent and steering partial (never assumed)', () => {
    const d = setup();
    const { result } = runClaudeCodeAdapterSuite({ workDir: d.work, stateDir: d.state, machine: 'm1', run: fakeEngine(d.projects, { noPostCompact: true }) });
    expect(result.capabilities.postCompactSummary.state).toBe('absent');
    expect(result.capabilities.preCompactionSteering.state).toBe('partial');
    expect(result.capabilities.compactionDetection.state).toBe('supported');
  });

  it('an engine CLI that cannot run (or is rate-limited) is INCONCLUSIVE — never recorded as the version\'s result', () => {
    const d = setup();
    const { result } = runClaudeCodeAdapterSuite({ workDir: d.work, stateDir: d.state, machine: 'm1', run: () => ({ status: 127, stdout: '', stderr: 'claude: not found' }) });
    expect(result).toMatchObject({ version: 'unknown', inconclusive: true });
    expect(result.errors.length).toBeGreaterThan(0);
    expect(() => writeSuiteResult(d.state, result)).toThrow(/inconclusive/);
    const d2 = setup();
    const rateLimited: RunCommand = (args) => args[0] === '--version' ? { status: 0, stdout: '2.1.322', stderr: '' } : { status: 1, stdout: '', stderr: 'API Error: 429 rate_limit_error' };
    const r2 = runClaudeCodeAdapterSuite({ workDir: d2.work, stateDir: d2.state, machine: 'm1', run: rateLimited }).result;
    expect(r2).toMatchObject({ version: '2.1.322', inconclusive: true });
    expect(r2.errors.join(' ')).toContain('429');
  });

  it('an engine that LOGS the deny but still runs the tool reads toolPolicy absent', () => {
    const d = setup();
    const { result, evidence } = runClaudeCodeAdapterSuite({ workDir: d.work, stateDir: d.state, machine: 'm1', run: fakeEngine(d.projects, { ignoreDeny: true }) });
    expect(evidence.denyToolRan).toBe(true);
    expect(result.capabilities.toolPolicy).toMatchObject({ state: 'absent', evidence: expect.stringMatching(/RAN/) });
  });

  it('a work directory whose path holds a space and a quote still measures every hook', () => {
    const d = setup();
    const work = path.join(d.root, "work dir's");
    const { result } = runClaudeCodeAdapterSuite({ workDir: work, stateDir: d.state, machine: 'm1', run: fakeEngine(d.projects) });
    expect(result.inconclusive).toBe(false);
    expect(result.capabilities.toolPolicy.state).toBe('supported');
    expect(result.capabilities.preCompactionSteering.state).toBe('supported');
  });
});
