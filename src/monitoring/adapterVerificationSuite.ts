/**
 * The adapter verification suite — Claude Code (context-budget-layered-
 * summaries §9.6: "each declared `supported`, `partial`, `synthesized` or
 * `absent` per engine version, verified by the adapter verification suite (the
 * Phase 0 checks made re-runnable; … on a throwaway headless session, never a
 * channel topic; triggers: adapter build and any change of the retained engine
 * binary version; results … keyed per (machine, engine, version) …; cost bound:
 * one throwaway session per run)").
 *
 * One run: a throwaway project directory with PROBE hooks (they record what the
 * engine hands them and print fresh random tokens), one engine session line
 * driven headlessly (`claude -p`), and the real engine-checkpoint restore. Each
 * capability's state is decided by a PURE evaluator from the collected evidence
 * — never assumed. A capability this suite does not measure is recorded
 * `absent` with the reason (§17: "unmeasured … ⇒ absent until the suite
 * re-runs").
 *
 * The probe hooks measure the ENGINE (does it run the hook, pass its payload,
 * honour its output); Instar's own hook scripts are covered by their slices'
 * tests and L7 runs.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { takeEngineCheckpoint, restoreEngineCheckpoint } from './engineCheckpoint.js';
import { SafeFsExecutor } from '../core/SafeFsExecutor.js';

export type CapabilityState = 'supported' | 'partial' | 'synthesized' | 'absent';

/** The §9.6 table's rows, in order. */
export const ADAPTER_CAPABILITIES = [
  'transcriptRead', 'controlCompact', 'controlClear', 'compactionDetection', 'preCompactionSteering',
  'postCompactSummary', 'seedAfterCompaction', 'seedAfterClear', 'spawnWithInitialContext', 'materialiseResume',
  'compactionWindowSetting', 'perPromptDelta', 'toolPolicy', 'cleanStopSignals', 'costModel', 'frameworkDiscriminator',
] as const;
export type AdapterCapability = typeof ADAPTER_CAPABILITIES[number];

export interface CapabilityResult { state: CapabilityState; evidence: string }

export interface AdapterSuiteResult {
  schema: 'adapter-suite/1';
  engine: 'claude-code';
  version: string;
  machine: string;
  ranAt: number;
  durationMs: number;
  capabilities: Record<AdapterCapability, CapabilityResult>;
  /**
   * True when an engine call failed (or the version was unreadable): the run
   * measured the ENVIRONMENT (a rate limit, a lapsed sign-in), not the engine,
   * so it is never recorded as that version's result.
   */
  inconclusive: boolean;
  errors: string[];
}

/** What one run collected. Every field is optional: a step that failed leaves its fields empty. */
export interface SuiteEvidence {
  version?: string;
  tokens: { alpha: string; steer: string; seed: string; clear: string; delta: string; deny: string };
  firstReply?: string;
  transcriptPath?: string;
  transcriptHasEntries?: boolean;
  preCompactPayload?: Record<string, unknown>;
  postCompactPayload?: Record<string, unknown>;
  sessionStartCompactPayload?: Record<string, unknown>;
  transcriptHasCompactBoundary?: boolean;
  transcriptHasCompactSeedHook?: boolean;
  afterCompactReply?: string;
  sessionStartClearPayload?: Record<string, unknown>;
  afterClearReply?: string;
  frameworkSeenByHook?: string;
  /** The Bash call was refused: an error tool_result carrying the deny token. */
  denyRefusedWithReason?: boolean;
  /** The refused command's marker file exists: the tool RAN despite the deny. */
  denyToolRan?: boolean;
  /** The session id the first prompt ran under (`/clear` must produce a different one). */
  firstSessionId?: string;
  restoreMode?: string;
  restoreReply?: string;
  errors: string[];
}

const UNMEASURED = (why: string): CapabilityResult => ({ state: 'absent', evidence: `unmeasured by this suite: ${why}` });
const has = (s: string | undefined, token: string) => typeof s === 'string' && s.includes(token);

/** Decide every capability from the evidence. Pure. */
export function evaluateSuite(e: SuiteEvidence): Record<AdapterCapability, CapabilityResult> {
  const t = e.tokens;
  const r = {} as Record<AdapterCapability, CapabilityResult>;
  r.transcriptRead = e.transcriptHasEntries
    ? { state: 'supported', evidence: `session transcript at a known path with entries and ids (${e.transcriptPath ?? '?'})` }
    : { state: 'absent', evidence: 'no readable session transcript was found' };
  const compacted = !!e.postCompactPayload || !!e.transcriptHasCompactBoundary;
  r.controlCompact = compacted && e.preCompactPayload?.trigger === 'manual'
    ? { state: 'supported', evidence: '`/compact` as a prompt compacted the session (manual trigger)' }
    : { state: 'absent', evidence: 'a `/compact` prompt did not produce a manual compaction' };
  const clearedSid = typeof e.sessionStartClearPayload?.session_id === 'string' && e.sessionStartClearPayload.session_id !== e.firstSessionId;
  r.controlClear = clearedSid
    ? { state: 'supported', evidence: '`/clear` as a prompt started a fresh session (SessionStart source=clear)' }
    : { state: 'absent', evidence: 'a `/clear` prompt did not start a fresh session' };
  r.compactionDetection = e.preCompactPayload && e.transcriptHasCompactBoundary
    ? { state: 'supported', evidence: 'native PreCompact hook fired AND the transcript carries a compact-boundary entry' }
    : e.transcriptHasCompactBoundary
      ? { state: 'partial', evidence: 'transcript compact-boundary entry only; the PreCompact hook did not fire' }
      : { state: 'absent', evidence: 'no compaction was detected on either channel' };
  const summary = typeof e.postCompactPayload?.compact_summary === 'string' ? e.postCompactPayload.compact_summary : undefined;
  r.preCompactionSteering = has(summary, t.steer)
    ? { state: 'supported', evidence: 'PreCompact stdout reached the compaction: the steering token is in the summary' }
    : e.preCompactPayload
      ? { state: 'partial', evidence: 'the PreCompact hook ran but its steering token is not in the summary' }
      : { state: 'absent', evidence: 'the PreCompact hook did not run' };
  r.postCompactSummary = summary && summary.length > 0
    ? { state: 'supported', evidence: `PostCompact hook received compact_summary (${summary.length} chars)` }
    : e.postCompactPayload
      ? { state: 'partial', evidence: 'PostCompact fired without a summary' }
      : { state: 'absent', evidence: 'the PostCompact hook did not run' };
  const seedFired = e.sessionStartCompactPayload?.source === 'compact';
  r.seedAfterCompaction = seedFired && has(e.afterCompactReply, t.seed)
    ? { state: 'supported', evidence: 'SessionStart(compact) fired and the model saw its seed token after compaction' }
    : seedFired
      ? { state: 'partial', evidence: 'SessionStart(compact) fired but its seed token was not visible to the model' }
      : { state: 'absent', evidence: 'SessionStart(compact) did not fire' };
  r.seedAfterClear = clearedSid && has(e.afterClearReply, t.clear) && !has(e.afterClearReply, t.alpha)
    ? { state: 'supported', evidence: 'after `/clear` the model saw the clear seed and NOT the pre-clear codeword' }
    : clearedSid && has(e.afterClearReply, t.alpha)
      ? { state: 'partial', evidence: 'the clear seed fired but the pre-clear context was still visible' }
      : clearedSid
        ? { state: 'partial', evidence: 'SessionStart(clear) fired but its seed token was not visible to the model' }
        : { state: 'absent', evidence: 'SessionStart(clear) did not fire' };
  r.spawnWithInitialContext = UNMEASURED('rung 2 uses Instar\'s own spawn path (formatContextForSession), covered by its tests');
  r.materialiseResume = e.restoreMode === 'materialised' && has(e.restoreReply, t.alpha)
    ? { state: 'supported', evidence: 'a checkpoint materialised as a new session id resumed and recalled the pre-fold codeword' }
    : e.restoreMode
      ? { state: 'partial', evidence: `restore mode ${e.restoreMode}; the resumed session did not recall the codeword` }
      : { state: 'absent', evidence: 'the checkpoint could not be taken or restored' };
  r.compactionWindowSetting = UNMEASURED('needs a full context fill; recorded for the Phase 2 backstop work');
  r.perPromptDelta = has(e.afterCompactReply, t.delta) || has(e.firstReply, t.delta) || has(e.afterClearReply, t.delta)
    ? { state: 'supported', evidence: 'UserPromptSubmit additionalContext reached the model' }
    : { state: 'absent', evidence: 'the UserPromptSubmit additionalContext was not visible to the model' };
  r.toolPolicy = e.denyRefusedWithReason && e.denyToolRan === false
    ? { state: 'supported', evidence: 'a PreToolUse(*) deny refused the Bash call (error tool_result carrying the reason) and the command never ran' }
    : e.denyToolRan
      ? { state: 'absent', evidence: 'the denied command RAN (its marker file exists)' }
      : { state: 'absent', evidence: 'no refused tool_result carried the deny reason' };
  r.cleanStopSignals = UNMEASURED('pane pattern, SubagentTracker and child processes are Instar-side signals, not engine capabilities');
  r.costModel = UNMEASURED('first-party pricing table; no engine probe');
  r.frameworkDiscriminator = e.frameworkSeenByHook === 'claude-code'
    ? { state: 'supported', evidence: 'INSTAR_FRAMEWORK reached the hook environment' }
    : { state: 'absent', evidence: 'INSTAR_FRAMEWORK was not visible to hooks' };
  return r;
}

export interface CommandResult { status: number | null; stdout: string; stderr: string }
export type RunCommand = (args: string[], opts: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }) => CommandResult;

/** Where the suite records results: `state/context-budget/adapter-suite/<engine>-<version>.json`. */
export function adapterSuiteDir(stateDir: string): string { return path.join(stateDir, 'state', 'context-budget', 'adapter-suite'); }

export function writeSuiteResult(stateDir: string, r: AdapterSuiteResult): string {
  if (r.inconclusive) throw new Error('an inconclusive suite run is never recorded as a result');
  const dir = adapterSuiteDir(stateDir);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const safeVersion = r.version.replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 64) || 'unknown';
  const f = path.join(dir, `${r.engine}-${safeVersion}.json`);
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(r, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, f);
  return f;
}

/** Every recorded result on this machine, newest first. */
export function readSuiteResults(stateDir: string): AdapterSuiteResult[] {
  let files: string[] = [];
  try { files = fs.readdirSync(adapterSuiteDir(stateDir)).filter((f) => f.endsWith('.json')); } catch { return []; } // @silent-fallback-ok — no suite has run here yet
  const out: AdapterSuiteResult[] = [];
  for (const f of files) {
    try { const v = JSON.parse(fs.readFileSync(path.join(adapterSuiteDir(stateDir), f), 'utf-8')) as AdapterSuiteResult; if (v?.schema === 'adapter-suite/1' && v.inconclusive !== true && v.capabilities) out.push(v); } catch { /* @silent-fallback-ok — a torn result file is skipped; the next run rewrites it */ }
  }
  return out.sort((a, b) => b.ranAt - a.ranAt);
}

function token(prefix: string): string { return `${prefix}-${crypto.randomInt(1000, 9999)}`; }

function readJson(p: string): Record<string, unknown> | undefined {
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')) as Record<string, unknown>; } catch { return undefined; } // @silent-fallback-ok — an absent probe file is the evidence that the hook did not run
}

/** Is there an error tool_result whose content carries `token` (a refused tool call)? */
function hasRefusedToolResult(text: string, token: string): boolean {
  for (const line of text.split('\n')) {
    if (!line.includes(token)) continue;
    let e: { type?: unknown; message?: { content?: unknown } };
    try { e = JSON.parse(line) as typeof e; } catch { continue; }
    const content = Array.isArray(e.message?.content) ? e.message.content as Array<Record<string, unknown>> : [];
    if (content.some((c) => c.type === 'tool_result' && c.is_error === true && JSON.stringify(c.content ?? '').includes(token))) return true;
  }
  return false;
}

function transcriptFacts(p: string | undefined): { entries: boolean; boundary: boolean; seedHook: boolean; text: string } {
  if (!p) return { entries: false, boundary: false, seedHook: false, text: '' };
  let text = '';
  try { text = fs.readFileSync(p, 'utf-8'); } catch { return { entries: false, boundary: false, seedHook: false, text: '' }; } // @silent-fallback-ok — no transcript is the evidence
  let entries = false; let boundary = false; let seedHook = false;
  for (const line of text.split('\n')) {
    if (!line) continue;
    let e: Record<string, unknown>;
    try { e = JSON.parse(line) as Record<string, unknown>; } catch { continue; }
    if (typeof e.uuid === 'string') entries = true;
    if (e.type === 'system' && e.subtype === 'compact_boundary') boundary = true;
    const a = e.attachment as { type?: unknown; hookName?: unknown } | undefined;
    if (e.type === 'attachment' && a?.type === 'hook_success' && a.hookName === 'SessionStart:compact') seedHook = true;
  }
  return { entries, boundary, seedHook, text };
}

/**
 * Run the suite once, headlessly, in `workDir` (a throwaway project directory,
 * created fresh). `run` executes the engine CLI; `stateDir` receives the engine
 * checkpoint used by the restore check. Never touches a channel topic.
 */
export function runClaudeCodeAdapterSuite(o: {
  workDir: string;
  stateDir: string;
  machine: string;
  run: RunCommand;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  timeoutMs?: number;
}): { result: AdapterSuiteResult; evidence: SuiteEvidence } {
  const now = o.now ?? Date.now;
  const started = now();
  const timeoutMs = o.timeoutMs ?? 240_000;
  const W = path.resolve(o.workDir);
  const ev = path.join(W, '.probe');
  fs.mkdirSync(path.join(W, '.claude'), { recursive: true });
  fs.mkdirSync(ev, { recursive: true });
  const tk = { alpha: token('ALPHA'), steer: token('STEER'), seed: token('SEED'), clear: token('CLEAR'), delta: token('DELTA'), deny: token('DENY') };
  const e: SuiteEvidence = { tokens: tk, errors: [] };
  const q = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
  const save = (name: string) => `cat > ${q(path.join(ev, name))}`;
  const denyScript = path.join(ev, 'deny.sh');
  fs.writeFileSync(denyScript, `#!/bin/sh\ncat > /dev/null\nif [ -f ${q(path.join(ev, 'deny-on'))} ]; then echo '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"adapter-suite: tool refused (${tk.deny})"}}'; fi\nexit 0\n`, { mode: 0o755 });
  const settings = {
    hooks: {
      PreCompact: [{ matcher: '', hooks: [{ type: 'command', command: `${save('precompact.json')}; echo ${q(`Keep the token ${tk.steer} verbatim in the summary.`)}` }] }],
      PostCompact: [{ matcher: '', hooks: [{ type: 'command', command: save('postcompact.json') }] }],
      SessionStart: [
        { matcher: 'compact', hooks: [{ type: 'command', command: `${save('ss-compact.json')}; echo ${q(`Session note: the seed token is ${tk.seed}.`)}` }] },
        { matcher: 'clear', hooks: [{ type: 'command', command: `${save('ss-clear.json')}; echo ${q(`Clear note: ${tk.clear}.`)}` }] },
      ],
      UserPromptSubmit: [{ matcher: '', hooks: [{ type: 'command', command: `${save('ups.json')}; printf '%s' "$INSTAR_FRAMEWORK" > ${q(path.join(ev, 'framework.txt'))}; echo ${q(JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: `Delta note: ${tk.delta}.` } }))}` }] }],
      PreToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: q(denyScript) }] }],
    },
  };
  fs.writeFileSync(path.join(W, '.claude', 'settings.json'), JSON.stringify(settings, null, 2));
  const env: NodeJS.ProcessEnv = { ...process.env, ...(o.env ?? {}), INSTAR_FRAMEWORK: 'claude-code' };
  delete env.INSTAR_ADAPTER_SUITE_CLI; // the suite's own process flag never reaches the engine or its hooks
  /** Every step but the tool-policy one runs with tools off: a probe session never writes memory or files, nor reads the probe's own files for its tokens. */
  const NO_TOOLS = '--disallowedTools=Bash,Write,Edit,MultiEdit,NotebookEdit,WebFetch,WebSearch,Task,Read,Grep,Glob';
  const claude = (args: string[]): CommandResult => {
    const r = o.run(args, { cwd: W, env, timeoutMs });
    if (r.status !== 0) e.errors.push(`claude ${args.filter((a) => !a.startsWith('--')).slice(-1)[0]?.slice(0, 40) ?? ''}: exit ${r.status}: ${r.stderr.slice(0, 200)}`);
    return r;
  };
  const LIST = 'List every token you can see that looks like WORD-1234 (codeword, seed, note, steer). Reply with just the tokens, space-separated, or NONE.';

  const v = o.run(['--version'], { cwd: W, env, timeoutMs: 30_000 });
  e.version = (/(\d+\.\d+\.\d+)/.exec(v.stdout) ?? [])[1] ?? 'unknown';

  // 1. A session learns a codeword.
  const s1 = crypto.randomUUID();
  e.firstSessionId = s1;
  e.firstReply = claude(['-p', NO_TOOLS, '--session-id', s1, `Remember the codeword ${tk.alpha}. Reply with just OK.`]).stdout;
  const ups = readJson(path.join(ev, 'ups.json'));
  e.transcriptPath = typeof ups?.transcript_path === 'string' ? ups.transcript_path : undefined;
  e.frameworkSeenByHook = (() => { try { return fs.readFileSync(path.join(ev, 'framework.txt'), 'utf-8').trim(); } catch { return undefined; } })(); // @silent-fallback-ok — absent ⇒ not visible
  e.transcriptHasEntries = transcriptFacts(e.transcriptPath).entries;

  // 2. The engine checkpoint before the compaction (the restore target).
  let checkpoint: ReturnType<typeof takeEngineCheckpoint> | null = null;
  // (in the suite's own throwaway state dir, never the agent's context archive)
  if (e.transcriptPath) checkpoint = takeEngineCheckpoint(o.stateDir, { topicKey: 'adapter-suite', foldId: `suite${started}`, sessionId: s1, transcriptPath: e.transcriptPath });

  // 3. `/compact` as a prompt; 4. what the model sees afterwards.
  claude(['-p', NO_TOOLS, '--resume', s1, '/compact']);
  e.preCompactPayload = readJson(path.join(ev, 'precompact.json'));
  e.postCompactPayload = readJson(path.join(ev, 'postcompact.json'));
  e.sessionStartCompactPayload = readJson(path.join(ev, 'ss-compact.json'));
  const f = transcriptFacts(e.transcriptPath);
  e.transcriptHasCompactBoundary = f.boundary;
  e.transcriptHasCompactSeedHook = f.seedHook;
  e.afterCompactReply = claude(['-p', NO_TOOLS, '--resume', s1, LIST]).stdout;

  // 5. `/clear` as a prompt; 6. the fresh session sees the clear seed, not the codeword.
  claude(['-p', NO_TOOLS, '--resume', s1, '/clear']);
  e.sessionStartClearPayload = readJson(path.join(ev, 'ss-clear.json'));
  const s2 = typeof e.sessionStartClearPayload?.session_id === 'string' ? e.sessionStartClearPayload.session_id : undefined;
  if (s2) e.afterClearReply = claude(['-p', NO_TOOLS, '--resume', s2, LIST]).stdout;

  // 7. Tool policy: a PreToolUse(*) deny on a fresh session.
  fs.writeFileSync(path.join(ev, 'deny-on'), '1');
  const s3 = crypto.randomUUID();
  const ranMarker = path.join(ev, 'tool-ran');
  claude(['-p', '--session-id', s3, '--allowedTools=Bash', `Run exactly this shell command: touch ${q(ranMarker)} . Then say exactly what happened, including any refusal text.`]);
  const s3Transcript = e.transcriptPath ? path.join(path.dirname(e.transcriptPath), `${s3}.jsonl`) : undefined;
  e.denyRefusedWithReason = hasRefusedToolResult(transcriptFacts(s3Transcript).text, tk.deny);
  e.denyToolRan = fs.existsSync(ranMarker);
  SafeFsExecutor.safeRmSync(path.join(ev, 'deny-on'), { force: true, operation: 'src/monitoring/adapterVerificationSuite.ts:deny-off' });

  // 8. Materialise the checkpoint as a new session and resume it.
  if (checkpoint?.ok && e.transcriptPath) {
    const restored = restoreEngineCheckpoint(o.stateDir, checkpoint.checkpoint, { currentTranscriptPath: e.transcriptPath, engineTranscriptDir: path.dirname(e.transcriptPath), newSessionId: () => crypto.randomUUID() });
    e.restoreMode = restored.mode;
    if (restored.mode === 'materialised') e.restoreReply = claude(['-p', NO_TOOLS, '--resume', restored.sessionId, 'What codeword did I ask you to remember? Reply with just the codeword.']).stdout;
  } else if (checkpoint && !checkpoint.ok) e.errors.push(`checkpoint: ${checkpoint.reason}`);

  if (e.version === 'unknown') e.errors.push('engine version unreadable');
  const result: AdapterSuiteResult = {
    schema: 'adapter-suite/1', engine: 'claude-code', version: e.version, machine: o.machine,
    ranAt: started, durationMs: now() - started, capabilities: evaluateSuite(e),
    inconclusive: e.errors.length > 0, errors: e.errors,
  };
  return { result, evidence: e };
}
