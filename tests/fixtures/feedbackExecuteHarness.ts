// safe-fs-allow: test fixture — SafeFsExecutor used for tmpdir cleanup.
/**
 * Shared harness for feedback executor tests (docs/specs/feedback-triage-and-execution.md §4):
 * the real triage harness (drain store, triage store, InitiativeTracker) plus the real execute
 * store and FeedbackExecutorService; only the external boundaries (trusted git, GitHub, the
 * sandbox runtime, the dependency cache and confined sessions) are scripted fakes.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createHarness, type Harness } from './feedbackTriageHarness.js';
import { FeedbackExecuteStore } from '../../src/feedback-factory/execute/FeedbackExecuteStore.js';
import { FeedbackExecutorService, type ConfinedSessionPort } from '../../src/feedback-factory/execute/FeedbackExecutorService.js';
import { RESULT_FILE, type ExecuteLiveConfig } from '../../src/feedback-factory/execute/executePolicy.js';
import type { ConfinedCommand, ConfinedResult, ConfinedRunner } from '../../src/feedback-factory/execute/ConfinedRunner.js';
import type { AttemptGit, GitHubGateway } from '../../src/feedback-factory/execute/executorPorts.js';
import type { DepsCachePort } from '../../src/feedback-factory/execute/depsCache.js';
import type { PrReview, RepoInfo } from '../../src/feedback-factory/execute/reviewGate.js';
import type { AttentionInput } from '../../src/feedback-factory/triage/FeedbackTriageService.js';

export const BASE_SHA = 'a'.repeat(40);
export const HEAD_SHA = 'b'.repeat(40);

export interface PushRecord { branch: string; message: string; remoteUrl: string; files: Record<string, string>; credentialHelper: string | null }

export interface ExecHarness extends Harness {
  exec: FeedbackExecutorService;
  execStore: FeedbackExecuteStore;
  agentHome: string;
  sourceRepo: string;
  cfg: ExecuteLiveConfig;
  enabled: { value: boolean };
  epoch: { value: number };
  repo: { info: RepoInfo | null; viewer: string | null; accounts: string[] | null };
  identity: { profileAccounts: Array<{ service: string; identity: string; vaultRefs: string[] }>; ownedIdentities: Array<{ service: string; identity: string }>; vaultNames: string[] | null };
  admission: { saturated: boolean; shedding: boolean; updatePending: boolean };
  pushes: PushRecord[];
  prs: Map<number, { state: string; mergedAt: string | null; headRefOid: string; mergeCommit: string | null; author: string | null; headRefName: string; labels: string[]; title: string; body: string }>;
  reviews: Map<number, PrReview[]>;
  disarmed: number[];
  merges: Array<{ pr: number; sha: string }>;
  safeMergeExit: { code: number | null; stdout: string };
  release: { value: { tag: string; taggedAt: number } | 'none' | null };
  runs: ConfinedCommand[];
  runScript: { fn: (cmd: ConfinedCommand) => Partial<ConfinedResult> | null };
  runnerAvailable: { value: boolean };
  deps: { ok: boolean; ensureCalls: number };
  sessions: { alive: Set<string>; spawned: Array<{ name: string; prompt: string; cwd: string; settingsPath?: string; trusted: boolean }>; behavior: { fn: (workspace: string, prompt: string) => void }; stopped: string[]; remoteStops: Array<{ machine: string; name: string }>; canaryReport: { fn: ((reportPath: string, workspace: string, prompt: string) => void) | null };
    /** The canary session's transcript lines (default: one tool result per step plus the report, no nonce). */
    canaryTranscript: { fn: ((prompt: string) => string[] | null) | null }; claudeHome: string };
  attentionExec: AttentionInput[];
  /** Make a triage work item ready for the executor. */
  workItem(id: string, opts?: { reports?: number; needsSpec?: boolean; userFacing?: boolean }): Promise<string>;
  /** A finished build session that fixed the problem with the given files. */
  fixWith(files: Record<string, string>, result?: Record<string, unknown>): void;
}

/** True when a confined run's tree is the (a) base-check clone: the base source plus only the changed tests. */
export function isBaseState(cwd: string): boolean {
  if (!/-base$/.test(cwd)) return false;
  try { return fs.readFileSync(path.join(cwd, 'src', 'thing.ts'), 'utf8') === 'export const thing = 1;\n' && !fs.existsSync(path.join(cwd, 'src', 'newfn.ts')); } catch { return false; }
}

/** Default scripted confined runs: canary must-fail probes fail, must-succeed probes and gates pass, the base check fails with an assertion. */
export function defaultRun(cmd: ConfinedCommand): Partial<ConfinedResult> {
  const c = cmd.command;
  if (/better-sqlite3/.test(c)) return { exitCode: 0, stdout: 'sqlite-ok' };
  if (/^git /.test(c)) return { exitCode: 0 };
  if (/^(cat |ls |echo |security |ln )/.test(c) || /^node -e/.test(c)) return { exitCode: 1, stderr: 'Operation not permitted' };
  if (/vitest run/.test(c) && isBaseState(cmd.cwd)) return { exitCode: 1, stdout: ' FAIL  tests/fix.test.ts > fixes it\nAssertionError: expected 1 to be 2\n Test Files  1 failed (1)' };
  return { exitCode: 0, stdout: 'ok' };
}

export async function createExecHarness(opts: { config?: Partial<ExecuteLiveConfig> } = {}): Promise<ExecHarness> {
  const base = await createHarness();
  const h = base as ExecHarness;
  h.agentHome = path.join(base.dir, 'agent');
  h.sourceRepo = path.join(base.dir, 'source');
  fs.mkdirSync(path.join(h.agentHome, '.instar'), { recursive: true });
  fs.mkdirSync(path.join(h.agentHome, '.worktrees'), { recursive: true });
  fs.writeFileSync(path.join(h.agentHome, '.instar', 'config.json'), JSON.stringify({ authToken: 'real-token-never-read' }));
  fs.mkdirSync(path.join(h.sourceRepo, '.git'), { recursive: true });
  fs.mkdirSync(path.join(h.sourceRepo, 'src'), { recursive: true });
  fs.mkdirSync(path.join(h.sourceRepo, 'tests'), { recursive: true });
  fs.mkdirSync(path.join(h.sourceRepo, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(h.sourceRepo, 'package.json'), '{"name":"fixture"}\n');
  fs.writeFileSync(path.join(h.sourceRepo, 'src', 'thing.ts'), 'export const thing = 1;\n');
  fs.writeFileSync(path.join(h.sourceRepo, '.claude', 'settings.json'), '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"evil"}]}]}}');
  h.cfg = { dryRun: false, sourceRepoPath: h.sourceRepo, maxConcurrent: 2, maxStartsPerDay: 6, maxOpenPrs: 4, lintCommand: 'npm run lint', baseSmokeTests: ['tests/unit/smoke.test.ts'], maxDurationMinutes: 300, publishRepo: 'agent-bot/repo', ...(opts.config ?? {}) };
  h.enabled = { value: true };
  h.epoch = { value: 1 };
  h.repo = { info: { ownerLogin: 'Owner', ownerType: 'User', allowAutoMerge: true }, viewer: 'agent-bot', accounts: ['agent-bot'] };
  h.identity = { profileAccounts: [], ownedIdentities: [], vaultNames: [] };
  h.admission = { saturated: false, shedding: false, updatePending: false };
  h.pushes = [];
  h.prs = new Map();
  h.reviews = new Map();
  h.disarmed = [];
  h.merges = [];
  h.safeMergeExit = { code: 5, stdout: 'safe-merge-result: {"result":"armed"}' };
  h.release = { value: 'none' };
  h.runs = [];
  h.runScript = { fn: () => null };
  h.runnerAvailable = { value: true };
  h.deps = { ok: true, ensureCalls: 0 };
  h.attentionExec = [];
  h.sessions = { alive: new Set(), spawned: [], behavior: { fn: () => {} }, stopped: [], remoteStops: [], canaryReport: { fn: null }, canaryTranscript: { fn: null }, claudeHome: path.join(base.dir, 'claude-home') };

  const git: AttemptGit = {
    fetchBase: async () => BASE_SHA,
    createClone: async (src, dest) => {
      if (fs.existsSync(dest)) throw new Error('clone destination exists');
      fs.cpSync(src, dest, { recursive: true });
      fs.mkdirSync(path.join(dest, '.git'), { recursive: true });
      fs.writeFileSync(path.join(dest, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n');
    },
    commitAndPush: async (clone, input) => {
      const files: Record<string, string> = {};
      const walk = (dir: string, rel = '') => {
        for (const name of fs.readdirSync(dir)) {
          if (!rel && (name === '.git' || name === 'node_modules')) continue;
          const full = path.join(dir, name);
          const r = rel ? `${rel}/${name}` : name;
          if (fs.lstatSync(full).isDirectory()) walk(full, r); else files[r] = fs.readFileSync(full, 'utf8');
        }
      };
      walk(clone);
      h.pushes.push({ branch: input.branch, message: input.message, remoteUrl: input.remoteUrl, files, credentialHelper: input.credentialHelper });
      return HEAD_SHA;
    },
    githubRemote: async () => ({ slug: 'owner/repo', url: 'https://github.com/owner/repo.git' }),
    firstReleaseContaining: async () => h.release.value,
  };
  let nextPr = 100;
  const github: GitHubGateway = {
    repoInfo: async () => h.repo.info,
    viewerLogin: async () => h.repo.viewer,
    authAccounts: async () => h.repo.accounts,
    createPr: async (input) => {
      const number = nextPr++;
      h.prs.set(number, { state: 'OPEN', mergedAt: null, headRefOid: HEAD_SHA, mergeCommit: null, author: 'agent-bot', headRefName: input.head, labels: [input.label], title: input.title, body: input.body });
      return { number };
    },
    prState: async (_slug, pr) => { const p = h.prs.get(pr); return p ? { ...p } : null; },
    reviews: async (_slug, pr) => h.reviews.get(pr) ?? [],
    removeLabel: async (_slug, pr, label) => { const p = h.prs.get(pr); if (p) p.labels = p.labels.filter((l) => l !== label); return true; },
    disableAuto: async (_slug, pr) => { h.disarmed.push(pr); return true; },
    safeMerge: async (_slug, pr, sha) => { h.merges.push({ pr, sha }); return { exitCode: h.safeMergeExit.code, stdout: h.safeMergeExit.stdout }; },
  };
  const runner: ConfinedRunner = {
    available: () => (h.runnerAvailable.value ? { ok: true, version: '0.0.77' } : { ok: false, reason: 'sandbox-runtime-not-installed' }),
    run: async (cmd) => {
      h.runs.push(cmd);
      const scripted = h.runScript.fn(cmd) ?? defaultRun(cmd);
      return { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, outputCapped: false, ...scripted };
    },
  };
  const depsPort: DepsCachePort = {
    ensure: async () => {
      h.deps.ensureCalls++;
      if (!h.deps.ok) return { ok: false, reason: 'deps-install-failed: registry down' };
      const dir = path.join(h.agentHome, '.worktrees', '.feedback-deps', 'abcdefabcdefabcdefab');
      fs.mkdirSync(path.join(dir, 'node_modules'), { recursive: true });
      return { ok: true, dir, hash: 'abcdefabcdefabcdefab' };
    },
    evict: () => 0,
    sizeBytes: () => 1234,
  };
  const sessions: ConfinedSessionPort = {
    spawnConfined: async (input) => {
      h.sessions.spawned.push({ name: input.name, prompt: input.prompt, cwd: input.cwd, settingsPath: input.settingsPath, trusted: false });
      if (input.name.startsWith('feedback-canary-')) {
        const reportPath = /write (\S+canary-report-[0-9a-f]+\.json) as JSON/.exec(input.prompt)?.[1];
        if (h.sessions.canaryReport.fn) h.sessions.canaryReport.fn(reportPath!, input.cwd, input.prompt);
        else {
          const okFile = /create (\S+\.feedback-canary-ok-[0-9a-f]+)/.exec(input.prompt)![1];
          const bashFile = /echo ok > (\S+\.feedback-canary-bash-[0-9a-f]+)/.exec(input.prompt)![1];
          fs.writeFileSync(okFile, 'ok');
          fs.writeFileSync(bashFile, 'ok');
          fs.writeFileSync(reportPath!, JSON.stringify({ attempted: CANARY_STEPS, outputs: { 1: 'Operation not permitted', 8: 'Operation not permitted', 9: 'exit 0: ?? node_modules' } }));
        }
        const sessionUuid = canaryUuid(input.name);
        const lines = h.sessions.canaryTranscript.fn ? h.sessions.canaryTranscript.fn(input.prompt) : defaultCanaryTranscript(input.prompt);
        if (lines) {
          const dir = path.join(h.sessions.claudeHome, 'projects', input.cwd.replace(/[/.]/g, '-'));
          fs.mkdirSync(dir, { recursive: true });
          fs.writeFileSync(path.join(dir, `${sessionUuid}.jsonl`), `${lines.join('\n')}\n`);
        }
        return { sessionName: `tmux-${input.name}`, sessionId: `uuid-${input.name}`, transcript: { configHome: h.sessions.claudeHome, sessionUuid } };
      }
      h.sessions.alive.add(`tmux-${input.name}`);
      h.sessions.behavior.fn(input.cwd, input.prompt);
      return { sessionName: `tmux-${input.name}`, sessionId: `uuid-${input.name}` };
    },
    spawnTrusted: async (input) => {
      h.sessions.spawned.push({ name: input.name, prompt: input.prompt, cwd: '', trusted: true });
      h.sessions.alive.add(`tmux-${input.name}`);
      return { sessionName: `tmux-${input.name}`, sessionId: `uuid-${input.name}` };
    },
    isAlive: (name) => h.sessions.alive.has(name),
    stop: async (name) => { h.sessions.stopped.push(name); h.sessions.alive.delete(name); return true; },
    remoteStop: async (machine, name) => { h.sessions.remoteStops.push({ machine, name }); return true; },
    frameworkVersion: async () => '2.1.295 (Claude Code)',
  };
  h.execStore = new FeedbackExecuteStore(h.drain, h.store, { clock: () => h.now.value });
  h.exec = new FeedbackExecutorService({
    triageStore: h.store, store: h.execStore, audit: h.audit,
    processing: { activeClusters: () => [...h.clusters.values()], feedbackByCluster: () => new Map([...h.reports].map(([k, v]) => [k, v.map((r) => ({ ...r }))])) },
    initiatives: h.tracker, git, github, runner, deps: depsPort, sessions,
    admission: { spawnLimiterSaturated: () => h.admission.saturated, quotaShedding: () => h.admission.shedding, updatePending: () => h.admission.updatePending },
    identityFacts: () => ({ profileAccounts: h.identity.profileAccounts, ownedIdentities: h.identity.ownedIdentities, vaultNames: h.identity.vaultNames }),
    rankedWork: () => h.service.queue().map((i) => ({ initiativeId: String(i.initiativeId), clusterId: String(i.clusterId) })),
    enabled: () => h.enabled.value,
    config: () => h.cfg,
    paths: { agentHome: h.agentHome, stateDir: path.join(h.agentHome, '.instar'), configPath: path.join(h.agentHome, '.instar', 'config.json'), testRunnerHoldersFile: path.join(base.dir, 'holders.json'), homeDir: base.dir },
    selfMachineId: 'm1', ownerMachineId: () => 'm1', ownerEpoch: () => h.epoch.value, isCanonicalOwner: () => true,
    commitIdentity: () => ({ name: 'Echo', email: 'echo@example.com' }),
    ghCredentialHelper: '!gh auth git-credential',
    raiseAttention: async (item) => { h.attentionExec.push(item); },
    reportDegradation: (event) => { h.degradations.push(event.feature); },
    dashboardLink: () => 'https://agent.example/dashboard?tab=feedback-drain',
    sleep: async () => {}, sessionWaitMs: 1_000,
    clock: () => h.now.value,
  });
  h.service.attachExecutor({ status: () => h.exec.status(), executionStateFor: (id) => h.exec.executionStateFor(id), actionItems: () => h.exec.actionItems(), holdsItem: (id) => h.exec.holdsItem(id) });
  h.workItem = async (id, o = {}) => {
    const initiativeId = await h.addItem(id, { reports: o.reports ?? 2 });
    const prev = h.decide.fn;
    h.decide.fn = (packets) => packets.map((p) => ({ clusterId: p.clusterId, disposition: 'work', reason: 'actionable', duplicateOf: null, fixedBy: null, severity: 'high', effort: 'm',
      needsSpec: o.needsSpec === true, userFacing: o.userFacing === true, priority: 80, confidence: 0.95, summary: `summary for ${p.clusterId}`,
      brief: { component: 'scheduler', symptom: 'crash', expected: 'no crash', reproduction: 'run the job' } }));
    h.now.value += 60_000;
    await h.service.tick();
    h.decide.fn = prev;
    return initiativeId;
  };
  h.fixWith = (files, result = {}) => {
    h.sessions.behavior.fn = (workspace) => {
      for (const [rel, text] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(path.join(workspace, rel)), { recursive: true });
        fs.writeFileSync(path.join(workspace, rel), text);
      }
      fs.writeFileSync(path.join(workspace, RESULT_FILE), JSON.stringify({ outcome: 'fixed', testFiles: ['tests/fix.test.ts'], testName: 'fixes it', notes: 'fixed the crash', ...result }));
    };
  };
  return h;
}

export const CANARY_STEPS = Array.from({ length: 16 }, (_, i) => i + 1);

/** A stable uuid-shaped id per canary session name. */
export function canaryUuid(name: string): string {
  const hex = Buffer.from(name).toString('hex').padEnd(32, '0').slice(-32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** A Read tool call and its (refused) result, in the shape Claude Code writes them. */
export function readCallLines(id: string, filePath: string, result = 'File is in a directory that is denied by your permission settings.'): string[] {
  return [
    JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: filePath } }] } }),
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content: result, is_error: true }] } }),
  ];
}

/** Every Read the canary prompt asks for, each attempted and refused. */
export function defaultCanaryTranscript(prompt: string): string[] {
  const targets = [...prompt.matchAll(/Use the Read tool to read (\S+)/g)].map((m) => m[1]);
  return targets.flatMap((t, i) => readCallLines(`toolu_${i}`, t));
}

/** End the running build session (as if claude -p exited). */
export function finishSessions(h: ExecHarness): void { h.sessions.alive.clear(); }
