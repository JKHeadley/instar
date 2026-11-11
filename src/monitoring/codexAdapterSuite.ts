/**
 * The adapter verification suite — Codex (context-budget-layered-summaries
 * §9.6: every capability row "declared `supported`, `partial`, `synthesized`
 * or `absent` per engine version, verified by the adapter verification suite
 * (… on a throwaway headless session, never a channel topic; triggers: adapter
 * build and any change of the retained engine binary version; results … keyed
 * per (machine, engine, version) …; cost bound: one throwaway session per
 * run)"; §16 Phase 1: "Ends when the Codex suite has a recorded result").
 *
 * The Claude Code suite's machinery, reused: the same capability rows
 * (`ADAPTER_CAPABILITIES`), result schema, writer and store
 * (`state/context-budget/adapter-suite/<engine>-<version>.json`), and the same
 * rule that a run which measured the ENVIRONMENT (an engine call failed, the
 * version was unreadable) is `inconclusive` and never recorded.
 *
 * One run: a throwaway git project (outside any agent home, refused when the
 * target looks like a channel topic), PROBE hooks in its `.codex/hooks.json`
 * that record what the engine hands them and print fresh random tokens, and
 * ONE engine thread driven headlessly (`codex exec`, then `codex exec resume`
 * on the same thread). The probe hooks are authored by the suite itself, so
 * the run passes `--dangerously-bypass-hook-trust` (Codex runs a project hook
 * only once its hash is trusted; there is no non-interactive trust step), and
 * refuses to run at all when the account home carries user-level hooks the
 * bypass would also run. A real compaction is pressed by lowering
 * `model_auto_compact_token_limit` for one resume. What the MODEL received is
 * judged from the rollout (Codex records hook output as developer messages).
 * Each capability's state is decided by a PURE evaluator from the evidence —
 * never assumed; a row this suite does not measure is `absent` with the reason
 * (§17: "unmeasured … ⇒ absent until the suite re-runs").
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ADAPTER_CAPABILITIES, type AdapterCapability, type AdapterSuiteResult, type CapabilityResult, type CommandResult, type RunCommand,
} from './adapterVerificationSuite.js';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';

export const CODEX_ENGINE = 'codex-cli' as const;

/** Environment keys that bind a process to a channel topic: the suite refuses to run under any of them. */
export const CHANNEL_TOPIC_ENV = ['INSTAR_TELEGRAM_TOPIC', 'INSTAR_SLACK_CHANNEL', 'INSTAR_TOPIC_ID', 'INSTAR_SESSION_ID', 'INSTAR_TMUX_SESSION'] as const;

/** Size of the UserPromptSubmit probe's output: it measures whether a standing-packet-sized delta reaches the model whole. */
export const DELTA_PROBE_CHARS = 7_000;

export interface CodexSuiteEvidence {
  version?: string;
  tokens: { alpha: string; steer: string; seed: string; delta: string; deny: string };
  threadId?: string;
  rolloutPath?: string;
  rolloutHasEntries?: boolean;
  /** `token_count` carried `cached_input_tokens` (a cache-read counter). */
  cacheCountersSeen?: boolean;
  frameworkSeenByHook?: string;
  /** The UserPromptSubmit output (DELTA_PROBE_CHARS long, token last) reached the model, whole. */
  deltaDeliveredWhole?: boolean;
  /** The UserPromptSubmit hook ran at all. */
  deltaHookRan?: boolean;
  denyHookRan?: boolean;
  denyReasonInRollout?: boolean;
  denyToolRan?: boolean;
  /** `/compact` as an exec prompt produced a `compacted` entry. */
  controlCompacted?: boolean;
  /** Lowering model_auto_compact_token_limit for one resume produced a `compacted` entry. */
  forcedCompacted?: boolean;
  compactWindowId?: string;
  preCompactPayload?: Record<string, unknown>;
  postCompactPayload?: Record<string, unknown>;
  sessionStartCompactPayload?: Record<string, unknown>;
  /** The SessionStart(compact) probe's seed token is in the model's input after the compaction (a developer message in the rollout). */
  seedDeliveredAfterCompaction?: boolean;
  /** The UserPromptSubmit probe's token is in the model's input after the compaction (the next-prompt carrier). */
  deltaDeliveredAfterCompaction?: boolean;
  /** The model's reply after the compaction, asked to list every token in its context (behavioural corroboration only). */
  afterCompactReply?: string;
  /** The new `compacted` entry carried a `window_id` (the context-epoch key). */
  compactWindowIdPresent?: boolean;
  /** The PreCompact probe's steering token appears anywhere in the rollout after the compaction began. */
  steerTokenInRollout?: boolean;
  restoreMode?: 'materialised' | 'refused' | 'not-taken';
  restoreReply?: string;
  errors: string[];
}

const UNMEASURED = (why: string): CapabilityResult => ({ state: 'absent', evidence: `unmeasured by this suite: ${why}` });
const has = (s: string | undefined, token: string) => typeof s === 'string' && s.includes(token);

/** Decide every capability from the evidence. Pure. */
export function evaluateCodexSuite(e: CodexSuiteEvidence): Record<AdapterCapability, CapabilityResult> {
  const t = e.tokens;
  const r = {} as Record<AdapterCapability, CapabilityResult>;
  r.transcriptRead = e.rolloutHasEntries
    ? { state: 'supported', evidence: `the rollout at a known path carries entries and the session id (${e.rolloutPath ?? '?'})${e.cacheCountersSeen ? '; token_count carries cached_input_tokens' : '; no cache counters seen'}` }
    : { state: 'absent', evidence: 'no readable rollout was found for the throwaway thread' };
  r.controlCompact = e.controlCompacted
    ? { state: 'supported', evidence: '`/compact` as a headless prompt compacted the thread' }
    : { state: 'absent', evidence: '`/compact` as a headless prompt did not produce a `compacted` entry' };
  r.controlClear = UNMEASURED('`codex exec` has no clear command; the TUI\'s new-thread command is not driven headlessly');
  const compacted = !!e.forcedCompacted || !!e.controlCompacted;
  r.compactionDetection = compacted && e.compactWindowIdPresent === false
    ? { state: 'partial', evidence: 'a `compacted` entry was written WITHOUT a window_id: compactions are seen, but the context-epoch key the seed and the canary use is gone' }
    : compacted && e.preCompactPayload
      ? { state: 'supported', evidence: `the rollout's \`compacted\` entry (window_id ${e.compactWindowId ?? '?'}) AND a native PreCompact hook (trigger ${String(e.preCompactPayload.trigger ?? '?')}); a forked rollout's inherited copies were not exercised` }
      : compacted
        ? { state: 'supported', evidence: 'the rollout\'s engine-written `compacted` entry; no PreCompact hook fired' }
        : { state: 'absent', evidence: 'no compaction could be pressed or seen' };
  r.preCompactionSteering = e.preCompactPayload && e.steerTokenInRollout
    ? { state: 'supported', evidence: 'the PreCompact hook ran and its steering token reached the compacted history' }
    : e.preCompactPayload
      ? { state: 'partial', evidence: 'the PreCompact hook runs, but its output does not reach the compaction (its token appears nowhere in the rollout; Codex exposes no summary to steer)' }
      : { state: 'absent', evidence: 'the PreCompact hook did not run' };
  const summary = ['compact_summary', 'summary'].map((k) => e.postCompactPayload?.[k]).find((v) => typeof v === 'string' && v.length > 0) as string | undefined;
  r.postCompactSummary = summary
    ? { state: 'supported', evidence: `the PostCompact hook received a summary (${summary.length} chars)` }
    : e.postCompactPayload
      ? { state: 'partial', evidence: 'the PostCompact hook fires after a compaction, but without a summary (the rollout\'s `compacted` message is empty too)' }
      : { state: 'absent', evidence: 'the PostCompact hook did not run' };
  const ssCompact = e.sessionStartCompactPayload?.source === 'compact';
  const echoed = (tok: string) => has(e.afterCompactReply, tok) ? 'the model echoed it when asked' : 'the model did not echo it when asked to list its tokens';
  r.seedAfterCompaction = ssCompact && e.seedDeliveredAfterCompaction
    ? { state: 'supported', evidence: `SessionStart(source=compact) fired and its seed is in the model's input after the compaction (a developer message in the rollout; ${echoed(t.seed)})${e.deltaDeliveredAfterCompaction ? '; the UserPromptSubmit next-prompt carrier is in the input after it too' : ''}` }
    : ssCompact
      ? { state: 'partial', evidence: 'SessionStart(source=compact) fired but its seed is not in the model\'s input' }
      : e.deltaDeliveredAfterCompaction
        ? { state: 'synthesized', evidence: `no compaction seed hook; Instar delivers the seed on the next prompt (UserPromptSubmit), which is in the model's input after the compaction (${echoed(t.delta)})` }
        : { state: 'absent', evidence: 'neither a compaction seed hook nor the next-prompt carrier is in the model\'s input after the compaction' };
  r.seedAfterClear = UNMEASURED('no headless clear command (see controlClear)');
  r.spawnWithInitialContext = UNMEASURED('rung 2 uses Instar\'s own spawn path (formatContextForSession), covered by its tests');
  r.materialiseResume = e.restoreMode === 'materialised' && has(e.restoreReply, t.alpha)
    ? { state: 'supported', evidence: 'a pre-compaction copy of the rollout under a new thread id resumed and recalled the codeword' }
    : e.restoreMode === 'materialised'
      ? { state: 'partial', evidence: 'the copied rollout resumed, but the resumed thread did not recall the codeword' }
      : e.restoreMode === 'refused'
        ? { state: 'absent', evidence: 'the engine refused to resume a copied rollout under a new thread id' }
        : { state: 'absent', evidence: 'no pre-compaction rollout copy could be taken' };
  r.compactionWindowSetting = e.forcedCompacted
    ? { state: 'supported', evidence: '`-c model_auto_compact_token_limit=<n>` pressed a real auto compaction at the configured size' }
    : { state: 'absent', evidence: 'lowering model_auto_compact_token_limit did not produce a compaction' };
  r.perPromptDelta = e.deltaDeliveredWhole
    ? { state: 'supported', evidence: `UserPromptSubmit output is in the model's input as a developer message, byte-whole at ${DELTA_PROBE_CHARS} chars` }
    : e.deltaHookRan
      ? { state: 'partial', evidence: `the UserPromptSubmit hook ran but its ${DELTA_PROBE_CHARS}-char output did not reach the model whole` }
      : { state: 'absent', evidence: 'the UserPromptSubmit hook did not run' };
  r.toolPolicy = e.denyReasonInRollout && e.denyToolRan === false
    ? { state: 'supported', evidence: 'a PreToolUse(.*) deny refused the shell call (its reason reached the rollout) and the command never ran' }
    : e.denyToolRan
      ? { state: 'absent', evidence: 'the denied command RAN (its marker file exists)' }
      : e.denyHookRan
        ? { state: 'partial', evidence: 'the PreToolUse hook ran and the command did not run, but the deny reason never reached the rollout' }
        : { state: 'absent', evidence: 'the PreToolUse hook did not run (the model may not have attempted the call)' };
  r.cleanStopSignals = UNMEASURED('pane pattern and child processes are Instar-side signals, not engine capabilities');
  r.costModel = e.cacheCountersSeen
    ? { state: 'partial', evidence: 'token_count exposes cache-read counters (cached_input_tokens); the engine gives no cache pricing or TTL' }
    : { state: 'absent', evidence: 'no cache accounting in the rollout' };
  r.frameworkDiscriminator = e.frameworkSeenByHook === CODEX_ENGINE
    ? { state: 'supported', evidence: 'INSTAR_FRAMEWORK reached the hook environment' }
    : { state: 'absent', evidence: 'INSTAR_FRAMEWORK was not visible to hooks' };
  for (const k of ADAPTER_CAPABILITIES) if (!r[k]) r[k] = UNMEASURED('no evaluator');
  return r;
}

/**
 * §9.6: the suite runs on a throwaway headless session, NEVER a channel topic.
 * Refused when the process carries a topic binding, when the work directory
 * sits inside an Instar agent's project (an `.instar/config.json` in it or
 * above it), or when the account home has user-level hooks the trust bypass would run.
 */
export function throwawayTargetProblem(o: { workDir: string; env: NodeJS.ProcessEnv; codexHome: string }): string | null {
  for (const k of CHANNEL_TOPIC_ENV) if (o.env[k]) return `the target is bound to a channel topic (${k} is set)`;
  let d = path.resolve(o.workDir);
  for (;;) {
    if (fs.existsSync(path.join(d, '.instar', 'config.json'))) return `the work directory is inside an agent project (${d})`;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  if (fs.existsSync(path.join(o.codexHome, 'hooks.json'))) return `the account home has user-level hooks (${path.join(o.codexHome, 'hooks.json')}) that the trust bypass would also run`;
  // Inline hook definitions in the user config (the `[hooks.state]` trust table is not a hook).
  let cfg = '';
  try { cfg = fs.readFileSync(path.join(o.codexHome, 'config.toml'), 'utf-8'); } catch { cfg = ''; } // @silent-fallback-ok — no user config: no inline hooks
  if (cfg.split('\n').some((l) => /^\s*\[\[?\s*hooks\.(?!state[\]."])/.test(l))) return `the account home's config.toml defines user-level hooks that the trust bypass would also run`;
  return null;
}

function token(prefix: string): string { return `${prefix}-${crypto.randomInt(1000, 9999)}`; }
function readJson(p: string): Record<string, unknown> | undefined {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')) as Record<string, unknown>; } catch { return undefined; } // @silent-fallback-ok — an absent probe file is the evidence that the hook did not run
}
/** The newest probe payload for an event (files `<EVENT>-<n>.json`), optionally filtered. */
function latestProbe(dir: string, event: string, pick?: (p: Record<string, unknown>) => boolean): Record<string, unknown> | undefined {
  let files: string[] = [];
  try { files = fs.readdirSync(dir).filter((f) => f.startsWith(`${event}-`) && f.endsWith('.json')); } catch { return undefined; } // @silent-fallback-ok — no probe directory: no hook ran
  const all = files.map((f) => ({ n: Number(f.slice(event.length + 1, -5)), p: readJson(path.join(dir, f)) })).filter((x) => Number.isFinite(x.n) && x.p).sort((a, b) => a.n - b.n);
  const hit = all.filter((x) => !pick || pick(x.p!)).pop();
  return hit?.p;
}

interface RolloutFacts { entries: boolean; cache: boolean; compactedIdx: number[]; windowIds: string[]; lines: string[] }
function rolloutFacts(p: string | undefined): RolloutFacts {
  const out: RolloutFacts = { entries: false, cache: false, compactedIdx: [], windowIds: [], lines: [] };
  if (!p) return out;
  let text = '';
  try { text = fs.readFileSync(p, 'utf-8'); } catch { return out; } // @silent-fallback-ok — no rollout is the evidence
  out.lines = text.split('\n');
  out.lines.forEach((line, i) => {
    if (!line) return;
    let e: { type?: unknown; payload?: Record<string, unknown> };
    try { e = JSON.parse(line) as typeof e; } catch { return; } // @silent-fallback-ok — a torn rollout line carries no evidence
    if (e.type === 'session_meta' && typeof e.payload?.['id'] === 'string') out.entries = true;
    if (e.type === 'event_msg' && e.payload?.['type'] === 'token_count' && line.includes('"cached_input_tokens"')) out.cache = true;
    if (e.type === 'compacted') { out.compactedIdx.push(i); if (typeof e.payload?.['window_id'] === 'string') out.windowIds.push(e.payload['window_id'] as string); }
  });
  return out;
}
/** Does a developer message after line `from` carry `tok`? (What the model received.) */
function developerMessageAfter(lines: string[], from: number, tok: string): boolean {
  for (let i = from + 1; i < lines.length; i++) {
    const line = lines[i];
    if (!line.includes(tok) || !line.includes('"role":"developer"')) continue;
    try { const e = JSON.parse(line) as { type?: unknown; payload?: Record<string, unknown> }; if (e.type === 'response_item' && e.payload?.['role'] === 'developer') return true; } catch { /* @silent-fallback-ok — a torn line is not the message */ }
  }
  return false;
}
function lastInputTokens(lines: string[]): number | null {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i].includes('"token_count"')) continue;
    try {
      const e = JSON.parse(lines[i]) as { payload?: { info?: { last_token_usage?: { input_tokens?: unknown } } } };
      const n = Number(e.payload?.info?.last_token_usage?.input_tokens);
      if (Number.isFinite(n) && n > 0) return n;
    } catch { /* @silent-fallback-ok — a torn usage line: keep looking */ }
  }
  return null;
}
function lastAgentMessage(stdout: string): string {
  let msg = '';
  for (const line of stdout.split('\n')) {
    if (!line.includes('agent_message')) continue;
    try { const e = JSON.parse(line) as { item?: { type?: unknown; text?: unknown } }; if (e.item?.type === 'agent_message' && typeof e.item.text === 'string') msg = e.item.text; } catch { /* @silent-fallback-ok — a non-JSON output line */ }
  }
  return msg;
}

/**
 * Run the suite once, headlessly, in `workDir` (a fresh throwaway directory).
 * `run` executes the engine CLI. Never touches a channel topic: refused (and
 * recorded inconclusive with the reason) when the target looks like one.
 */
export function runCodexAdapterSuite(o: {
  workDir: string;
  machine: string;
  run: RunCommand;
  /** CODEX_HOME for the engine calls (the account the run spends; default the process's). */
  codexHome?: string;
  /** The environment the engine runs under (default: this process's). */
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  timeoutMs?: number;
}): { result: AdapterSuiteResult; evidence: CodexSuiteEvidence } {
  const now = o.now ?? Date.now;
  const started = now();
  // Six engine calls must fit inside the CLI's 10-minute kill.
  const timeoutMs = o.timeoutMs ?? 90_000;
  const W = path.resolve(o.workDir);
  const ev = path.join(W, '.probe');
  const codexHome = o.codexHome ?? o.env?.CODEX_HOME ?? process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  const tk = { alpha: token('ALPHA'), steer: token('STEER'), seed: token('SEED'), delta: token('DELTA'), deny: token('DENY') };
  const e: CodexSuiteEvidence = { tokens: tk, errors: [] };
  // The caller's environment (default: this process's), judged as a whole: a topic binding anywhere in it refuses the run.
  const baseEnv: NodeJS.ProcessEnv = { ...(o.env ?? process.env) };
  const finish = (): { result: AdapterSuiteResult; evidence: CodexSuiteEvidence } => {
    if ((e.version ?? 'unknown') === 'unknown' && !e.errors.some((x) => x.startsWith('refused'))) e.errors.push('engine version unreadable');
    return {
      result: {
        schema: 'adapter-suite/1', engine: CODEX_ENGINE, version: e.version ?? 'unknown', machine: o.machine,
        ranAt: started, durationMs: now() - started, capabilities: evaluateCodexSuite(e),
        inconclusive: e.errors.length > 0, errors: e.errors,
      },
      evidence: e,
    };
  };
  const refusal = throwawayTargetProblem({ workDir: W, env: baseEnv, codexHome });
  if (refusal) { e.errors.push(`refused: ${refusal}`); return finish(); }

  fs.mkdirSync(path.join(W, '.codex'), { recursive: true });
  fs.mkdirSync(ev, { recursive: true });
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  // One probe script per event: save the payload (numbered), then print the event's output.
  const probe = (event: string, body: string) => {
    const f = path.join(ev, `${event}.sh`);
    fs.writeFileSync(f, `#!/bin/sh\nD=${q(ev)}\nn=$(ls "$D" | grep -c "^${event}-[0-9]*\\.json$")\ncat > "$D/${event}-$n.json"\nprintf '%s' "$INSTAR_FRAMEWORK" > "$D/framework.txt"\n${body}\nexit 0\n`, { mode: 0o755 });
    return f;
  };
  const pad = 'x'.repeat(Math.max(0, DELTA_PROBE_CHARS - 40));
  const hooks = {
    hooks: {
      SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: probe('SessionStart', `if grep -q '"source":"compact"' "$D/SessionStart-$n.json"; then echo ${q(`Session note: the seed token is ${tk.seed}.`)}; fi`) }] }],
      UserPromptSubmit: [{ matcher: '', hooks: [{ type: 'command', command: probe('UserPromptSubmit', `echo ${q(`Delta note ${pad} the delta token is ${tk.delta}.`)}`) }] }],
      PreCompact: [{ matcher: '', hooks: [{ type: 'command', command: probe('PreCompact', `echo ${q(`Keep the token ${tk.steer} verbatim in the summary.`)}`) }] }],
      PostCompact: [{ matcher: '', hooks: [{ type: 'command', command: probe('PostCompact', '') }] }],
      PreToolUse: [{ matcher: '.*', hooks: [{ type: 'command', command: probe('PreToolUse', `if [ -f "$D/deny-on" ]; then echo ${q(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `adapter-suite: tool refused (${tk.deny})` } }))}; fi`) }] }],
    },
  };
  fs.writeFileSync(path.join(W, '.codex', 'hooks.json'), JSON.stringify(hooks, null, 2));
  // A git root of its own: Codex discovers project hooks from the repository root down to cwd.
  fs.mkdirSync(path.join(W, '.git'), { recursive: true });
  for (const [f, body] of [['HEAD', 'ref: refs/heads/main\n'], ['config', '[core]\n\trepositoryformatversion = 0\n\tbare = false\n']] as const) fs.writeFileSync(path.join(W, '.git', f), body);
  for (const d of ['objects', 'refs/heads']) fs.mkdirSync(path.join(W, '.git', d), { recursive: true });

  const env: NodeJS.ProcessEnv = { ...baseEnv, INSTAR_FRAMEWORK: CODEX_ENGINE, CODEX_HOME: codexHome };
  delete env.INSTAR_ADAPTER_SUITE_CLI;
  const common = ['--json', '--dangerously-bypass-hook-trust', '-s', 'workspace-write', '-c', `projects."${W}".trust_level="trusted"`];
  const codex = (args: string[], label: string): CommandResult => {
    const r = o.run(args, { cwd: W, env, timeoutMs });
    if (r.status !== 0) e.errors.push(`codex ${label}: exit ${r.status}: ${(r.stderr || r.stdout).slice(-200)}`);
    return r;
  };
  const resume = (prompt: string, label: string, extra: string[] = []) => codex(['exec', ...common, ...extra, 'resume', e.threadId!, prompt], label);

  const v = o.run(['--version'], { cwd: W, env, timeoutMs: 30_000 });
  e.version = (/(\d+\.\d+\.\d+)/.exec(v.stdout) ?? [])[1] ?? 'unknown';
  if (e.version === 'unknown') return finish();

  // 1. A throwaway thread learns a codeword (SessionStart startup, UserPromptSubmit, the rollout).
  const r1 = codex(['exec', ...common, `Remember the codeword ${tk.alpha}. Reply with just OK.`], 'first-prompt');
  for (const line of r1.stdout.split('\n')) {
    try { const x = JSON.parse(line) as { type?: unknown; thread_id?: unknown }; if (x.type === 'thread.started' && typeof x.thread_id === 'string') { e.threadId = x.thread_id; break; } } catch { /* @silent-fallback-ok — a non-JSON output line */ }
  }
  if (!e.threadId) { e.errors.push('no thread id in the first call\'s output'); return finish(); }
  const ups = latestProbe(ev, 'UserPromptSubmit');
  e.deltaHookRan = !!ups;
  e.rolloutPath = typeof ups?.['transcript_path'] === 'string' ? ups['transcript_path'] as string : undefined;
  e.frameworkSeenByHook = (() => { try { return fs.readFileSync(path.join(ev, 'framework.txt'), 'utf-8').trim(); } catch { return undefined; } })(); // @silent-fallback-ok — absent ⇒ not visible
  let f = rolloutFacts(e.rolloutPath);
  e.rolloutHasEntries = f.entries;
  e.cacheCountersSeen = f.cache;
  const deltaText = `Delta note ${pad} the delta token is ${tk.delta}.`;
  e.deltaDeliveredWhole = developerMessageAfter(f.lines, -1, tk.delta) && f.lines.some((l) => l.includes('"role":"developer"') && l.includes(deltaText));

  // 2. The pre-compaction copy (the restore target), taken now.
  let snapshot: string | null = null;
  if (e.rolloutPath) { try { snapshot = fs.readFileSync(e.rolloutPath, 'utf-8'); } catch { snapshot = null; } } // @silent-fallback-ok — no copy ⇒ restore not-taken

  // 3. Tool policy: a PreToolUse(.*) deny.
  fs.writeFileSync(path.join(ev, 'deny-on'), '1');
  const ranMarker = path.join(W, 'tool-ran.txt');
  resume(`Run exactly this shell command now: touch ${ranMarker} . Then say exactly what happened, including any refusal text.`, 'tool-policy');
  SafeFsExecutor.safeRmSync(path.join(ev, 'deny-on'), { force: true, operation: 'src/monitoring/codexAdapterSuite.ts:deny-off' });
  e.denyHookRan = !!latestProbe(ev, 'PreToolUse');
  e.denyToolRan = fs.existsSync(ranMarker);
  f = rolloutFacts(e.rolloutPath);
  // The refusal must reach the model as the TOOL'S OUTPUT (not merely be echoed by it).
  e.denyReasonInRollout = f.lines.some((l) => l.includes(tk.deny) && /"type":"(custom_tool_call_output|function_call_output)"/.test(l));

  // 4. `/compact` as a headless prompt.
  const before = f.compactedIdx.length;
  resume('/compact', 'control-compact');
  f = rolloutFacts(e.rolloutPath);
  e.controlCompacted = f.compactedIdx.length > before;

  // 5. A real auto compaction, pressed by lowering the window for one resume.
  const base = lastInputTokens(f.lines) ?? 16_000;
  const limit = Math.max(2_000, Math.floor(base * 0.75));
  const beforeForced = f.compactedIdx.length;
  const r5 = resume('What codeword did I ask you to remember? Then list every token shaped like WORD-1234 in your context (developer notes included). Reply with the tokens only.', 'forced-compaction', ['-c', `model_auto_compact_token_limit=${limit}`]);
  f = rolloutFacts(e.rolloutPath);
  e.forcedCompacted = f.compactedIdx.length > beforeForced;
  if (f.compactedIdx.length > 0) {
    const at = f.compactedIdx[f.compactedIdx.length - 1];
    e.compactWindowId = f.windowIds[f.windowIds.length - 1];
    e.compactWindowIdPresent = f.windowIds.length === f.compactedIdx.length;
    e.seedDeliveredAfterCompaction = developerMessageAfter(f.lines, at, tk.seed);
    e.deltaDeliveredAfterCompaction = developerMessageAfter(f.lines, at, tk.delta);
    e.steerTokenInRollout = f.lines.slice(Math.max(0, at - 5)).some((l) => l.includes(tk.steer));
  }
  e.preCompactPayload = latestProbe(ev, 'PreCompact');
  e.postCompactPayload = latestProbe(ev, 'PostCompact');
  e.sessionStartCompactPayload = latestProbe(ev, 'SessionStart', (p) => p['source'] === 'compact');
  e.afterCompactReply = lastAgentMessage(r5.stdout);

  // 6. Materialise the pre-compaction copy under a new thread id and resume it.
  if (snapshot && e.rolloutPath) {
    const newId = crypto.randomUUID();
    const lines = snapshot.split('\n');
    try {
      const meta = JSON.parse(lines[0]) as { type?: unknown; payload?: Record<string, unknown> };
      if (meta.type === 'session_meta' && meta.payload) { meta.payload['id'] = newId; lines[0] = JSON.stringify(meta); }
      const dest = path.join(path.dirname(e.rolloutPath), path.basename(e.rolloutPath).replace(e.threadId, newId));
      fs.writeFileSync(dest, lines.join('\n'), { mode: 0o600 });
      const rr = o.run(['exec', ...common, 'resume', newId, 'What codeword did I ask you to remember? Reply with just the codeword.'], { cwd: W, env, timeoutMs });
      if (rr.status === 0) { e.restoreMode = 'materialised'; e.restoreReply = lastAgentMessage(rr.stdout); }
      else if (/not found|no (such )?(session|thread|rollout)/i.test(rr.stderr + rr.stdout)) e.restoreMode = 'refused';
      else e.errors.push(`codex restore-resume: exit ${rr.status}: ${(rr.stderr || rr.stdout).slice(-200)}`); // an environment failure is inconclusive, never a capability verdict
    } catch { e.restoreMode = 'not-taken'; } // @silent-fallback-ok — a malformed copy is recorded as not-taken
  } else e.restoreMode = 'not-taken';

  return finish();
}

/**
 * Remove the `[projects."<dir>"]` trust table Codex persists for the throwaway
 * directory (only that exact table; everything else in config.toml is left
 * byte-for-byte). Returns whether anything was removed.
 */
export function removeThrowawayProjectTrust(codexHome: string, dir: string): boolean {
  let real: string;
  let before: fs.Stats;
  let body: string;
  try {
    // A symlinked config is edited at its target (the link stays a link).
    real = fs.realpathSync(path.join(codexHome, 'config.toml'));
    before = fs.statSync(real);
    body = fs.readFileSync(real, 'utf-8');
  } catch { return false; } // @silent-fallback-ok — no config: nothing persisted
  const header = `[projects."${dir}"]`;
  const lines = body.split('\n');
  const i = lines.findIndex((l) => l.trim() === header);
  if (i < 0) return false;
  let j = i + 1;
  // The table and its own trailing blank lines (the blank line before it stays as the separator).
  while (j < lines.length && !/^\s*\[/.test(lines[j])) j++;
  const out = [...lines.slice(0, i), ...lines.slice(j)].join('\n');
  const tmp = `${real}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, out, { mode: before.mode & 0o777 });
  // Only if nothing rewrote it meanwhile (Codex writes this file too): a changed file is left alone.
  const now = fs.statSync(real);
  if (now.mtimeMs !== before.mtimeMs || now.size !== before.size) {
    SafeFsExecutor.safeRmSync(tmp, { force: true, operation: 'src/monitoring/codexAdapterSuite.ts:trust-cleanup-raced' });
    return false;
  }
  fs.renameSync(tmp, real);
  return true;
}
