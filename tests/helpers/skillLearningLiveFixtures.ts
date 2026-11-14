// safe-fs-allow: test fixture cleanup uses SafeFsExecutor.
/**
 * Shared fixtures for the Skill Learning Sentinel slice-2 unit tests (live mode, commit protocol, pending /
 * confirm / reject). An in-memory LedgerReader, stub model families, a tmp agent home, and an in-memory
 * CommitProtocolLike fake that records every call and mirrors the protocol's canonical side effect (the
 * canonical SKILL.md under `.instar/skills/<name>/`) so `status().pending` reads what the protocol wrote.
 * The fake NEVER renders: a pending or active canonical here has no framework rendering, which is exactly the
 * "unrendered" assertion the tests make about the sentinel (rendering is the protocol's, through the reconciler).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
import { SkillLearningSentinel, type SkillLearningSentinelDeps, type SyncReconcileOutcomeLike, type VersionRowLike, type VersionStoreLike } from '../../src/monitoring/SkillLearningSentinel.js';
import type { FamilyProvider } from '../../src/monitoring/skillLearning/Drafter.js';
import type { VersionStoreForReview } from '../../src/monitoring/skillLearning/Reviewer.js';
import type { EffectiveVersionRow, RejectedVersion, VersionAnnotation } from '../../src/monitoring/skillLearning/VersionStore.js';
import { SKILL_LEARNING_DEFAULTS } from '../../src/config/ConfigDefaults.js';
import type {
  CommitOp, CommitProtocolLike, CommitResult, EventRow, LearnedCanonicalState, LedgerReader, LedgerRow, LedgerWriter, OutcomeRow, RequestRow, SkillLearningConfig, VerdictRow,
} from '../../src/monitoring/skillLearning/types.js';

export class FakeLedger implements LedgerReader, LedgerWriter {
  rows: LedgerRow[] = [];
  append(row: LedgerRow): void { this.rows.push(row); }
  requestsForKey(k: string): RequestRow[] {
    return this.rows.filter((r): r is RequestRow => r.kind === 'request' && r.procedureKey === k).sort((a, b) => b.at.localeCompare(a.at));
  }
  outcomesForKey(k: string): OutcomeRow[] {
    const byRun = new Map<string, OutcomeRow>();
    for (const r of this.rows) if (r.kind === 'outcome' && r.procedureKey === k) { const c = byRun.get(r.runId); if (!c || r.revision > c.revision) byRun.set(r.runId, r); }
    return [...byRun.values()];
  }
  verdictsForKey(k: string): VerdictRow[] {
    const latest = new Map<string, VerdictRow>();
    for (const r of this.rows) if (r.kind === 'verdict' && r.procedureKey === k) { const c = latest.get(r.by); if (!c || r.at >= c.at) latest.set(r.by, r); }
    return [...latest.values()];
  }
  eventsForKey(k: string): EventRow[] { return this.rows.filter((r): r is EventRow => r.kind === 'event' && r.procedureKey === k); }
  keys() {
    const m = new Map<string, { procedureKey: string; requests: number; verifiedRequests: number; lastAt: string }>();
    for (const r of this.rows) {
      if (r.kind !== 'request' || !r.procedureKey) continue;
      const e = m.get(r.procedureKey) ?? { procedureKey: r.procedureKey, requests: 0, verifiedRequests: 0, lastAt: '' };
      e.requests++; if (r.identity === 'verified') e.verifiedRequests++; if (r.at > e.lastAt) e.lastAt = r.at;
      m.set(r.procedureKey, e);
    }
    return [...m.values()];
  }
  pendingCount(): number { return 0; }
}

export const NOW = Date.parse('2026-11-06T12:00:00Z');
export const DAY = 86_400_000;
export const KEY = 'ci-health';
export const SKILL_NAME = 'ci-health-report';

export const SKILL_MD = [
  '---',
  `name: ${SKILL_NAME}`,
  'description: "Use when the operator asks for the weekly CI health of the instar repo. Not for deploy status."',
  'metadata:',
  '  short-description: "CI health, weekly"',
  '---',
  '# CI health report',
  '',
  '1. Read the CI health route at /ci/health.',
  '2. Summarise failing jobs and the slowest runs in plain language.',
  '',
].join('\n');

export interface Home { root: string; stateDir: string; transcripts: Map<string, string> }

const homes: string[] = [];
export function cleanupHomes(): void {
  for (const d of homes.splice(0)) SafeFsExecutor.safeRmSync(d, { recursive: true, force: true, operation: 'tests/helpers/skillLearningLiveFixtures.ts' });
}

export function mkHome(): Home {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-live-'));
  homes.push(root);
  const stateDir = path.join(root, '.instar');
  fs.mkdirSync(stateDir, { recursive: true });
  return { root, stateDir, transcripts: new Map() };
}

export function writeTranscript(home: Home, session: string, startMs: number, commands: string[]): void {
  const lines = commands.map((c, i) => JSON.stringify({ type: 'assistant', timestamp: new Date(startMs + 1000 * (i + 1)).toISOString(), message: { role: 'assistant', content: [{ type: 'tool_use', id: `t${i}`, name: 'Bash', input: { command: c } }] } }));
  const file = path.join(home.root, `${session}.jsonl`);
  fs.writeFileSync(file, `${lines.join('\n')}\n`);
  home.transcripts.set(session, file);
}

/** N verified occurrences on N distinct days/sessions with accepted outcomes (3 ⇒ the default rung drafts; 2 ⇒ it waits). */
export function seedHistory(ledger: FakeLedger, home: Home, n: number, opts: { label?: OutcomeRow['label']; key?: string } = {}): void {
  const key = opts.key ?? KEY;
  for (let i = 0; i < n; i++) {
    const at = NOW - (i + 1) * DAY;
    const session = `sess-${key}-${i}`;
    ledger.append({
      kind: 'request', eventId: `req-${key}-${i}`, source: { channel: 'telegram', chatId: '-100', messageId: `${key}-${1180 + i}` }, topicId: '42', sessionName: session,
      at: new Date(at).toISOString(), channel: 'telegram', identity: 'verified', state: 'classified', procedureKey: key,
      paraphrase: 'weekly CI health of the instar repo', repeatable: true, runId: `run-${key}-${i}`, machineId: 'm1',
    });
    ledger.append({
      kind: 'outcome', eventId: `out-${key}-${i}`, runId: `run-${key}-${i}`, revision: 1, procedureKey: key, topicId: '42', sessionName: session,
      label: opts.label ?? 'accepted', provisional: false, windowStart: new Date(at).toISOString(), windowEnd: new Date(at + 3600_000).toISOString(),
      at: new Date(at + 3600_000).toISOString(), machineId: 'm1',
    });
    writeTranscript(home, session, at, ['curl http://localhost:4040/ci/health', 'echo summarise']);
  }
}

export type Responder = (prompt: string) => string;
export function fam(family: string, framework: string, respond: Responder, calls: string[] = []): FamilyProvider & { calls: string[]; prompts: string[] } {
  const prompts: string[] = [];
  return { family, framework, calls, prompts, evaluate: async (prompt) => { calls.push(family); prompts.push(prompt); return respond(prompt); } };
}
export const ARBITER = (verdict = 'draft') => `{"verdict":"${verdict}","reason":"strong recurrence"}`;
export const DRAFT = (md = SKILL_MD) => `NEW\n${md}`;
export const REVIEW_OK = '{"follows":true,"lines":{},"reason":"grounded"}';
export function responder(parts: { arbiter?: string; draft?: string; review?: string }): Responder {
  return (prompt) => {
    if (prompt.startsWith('You are the skill-learning arbiter')) return parts.arbiter ?? ARBITER();
    if (prompt.startsWith('You are drafting a reusable skill')) return parts.draft ?? DRAFT();
    if (prompt.startsWith('You are the independent reviewer')) return parts.review ?? REVIEW_OK;
    throw new Error(`unexpected prompt: ${prompt.slice(0, 60)}`);
  };
}

export function cfg(over: Partial<SkillLearningConfig> = {}): SkillLearningConfig {
  return { ...(structuredClone(SKILL_LEARNING_DEFAULTS) as unknown as SkillLearningConfig), enabled: true, ...over };
}

export const sha256 = (s: string): string => crypto.createHash('sha256').update(s, 'utf-8').digest('hex');

export interface ProtocolCall { op: CommitOp; name: string; newRaw: string; ctx: { expectedPrevHash: string | null; reason?: string; authorFamily?: string; reviewerFamily?: string } }

const bodyOf = (raw: string): string => raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
const stateOf = (raw: string): LearnedCanonicalState => (raw.match(/instar-learned-state:\s*"?([a-z-]+)"?/)?.[1] as LearnedCanonicalState | undefined) ?? 'active';

/** A fake row: the real store's effective row shape (slice-3A fields included) so the reviewer/reverter read it unchanged. */
export type FakeRow = EffectiveVersionRow;
type FakeRowInput = Omit<VersionRowLike, 'txId' | 'version' | 'at'> & Partial<Pick<VersionRowLike, 'txId' | 'version' | 'at'>> & Partial<Pick<FakeRow, 'op' | 'state' | 'fence' | 'authorFamily' | 'reviewerFamily' | 'reason' | 'citedCorrections' | 'rejectedBodyHash' | 'revertOf' | 'uncertainty'>>;

/**
 * In-memory VersionStoreLike + VersionStoreForReview: version rows per name (what the fake protocol appends), the
 * chain hash, a scriptable `reconcileAfterSync` (default: no rows ⇒ no-rows; on-disk = last live row ⇒ in-sync;
 * else unknown-hash), and — slice 3A — in-memory bodies, annotations folded straight into the row, reverts and
 * rejected versions (the real store's semantics over a Map).
 */
export class FakeVersionStore implements VersionStoreLike, VersionStoreForReview {
  readonly byName = new Map<string, FakeRow[]>();
  /** Scripted post-sync outcomes per name (the versions-phase tests); absent ⇒ the default classification. */
  readonly scripted = new Map<string, (onDiskFileHash: string | null) => SyncReconcileOutcomeLike>();
  reconcileCalls: Array<{ name: string; onDiskFileHash: string | null }> = [];
  /** `<name>/<fileHash>` → raw document (the real store keeps these as files). */
  readonly bodies = new Map<string, string>();
  annotations: Array<{ name: string; txId: string; patch: VersionAnnotation }> = [];
  /** Advance to make rows distinguishable in time (the real store orders by `(epoch, at)`). */
  clock = NOW;
  rows(name: string): ReadonlyArray<FakeRow> { return this.byName.get(name) ?? []; }
  live(name: string): FakeRow[] { return this.rows(name).filter((r) => !r.void && !r.superseded); }
  lastRow(name: string): FakeRow | null { const l = this.live(name); return l.length ? l[l.length - 1] : null; }
  expectedPrevHash(name: string): string | null { return this.lastRow(name)?.fileHash ?? null; }
  append(name: string, row: FakeRowInput): FakeRow {
    const list = this.byName.get(name) ?? [];
    const version = row.version ?? list.filter((r) => !r.void).reduce((m, r) => Math.max(m, r.version), 0) + 1;
    const full: FakeRow = {
      kind: 'version', txId: row.txId ?? `tx-${name}-${version}`, version, at: row.at ?? new Date(this.clock).toISOString(),
      fence: row.fence ?? 'local', op: row.op ?? 'create', state: row.state ?? 'active', citedCorrections: row.citedCorrections ?? [],
      ...row, void: row.void === true, superseded: row.superseded === true,
    };
    list.push(full);
    this.byName.set(name, list);
    return full;
  }
  annotate(name: string, txId: string, patch: VersionAnnotation): void {
    this.annotations.push({ name, txId, patch });
    const row = this.rows(name).find((r) => r.txId === txId);
    if (!row) throw new Error(`FakeVersionStore.annotate: no row ${txId} for ${name}`);
    if (patch.rejectedBodyHash) row.rejectedBodyHash = patch.rejectedBodyHash;
    if (patch.citedCorrections) row.citedCorrections = [...patch.citedCorrections];
    if (patch.revertOf) row.revertOf = patch.revertOf;
    if (patch.uncertainty) row.uncertainty = { ...patch.uncertainty };
    if (patch.reviewerFamily) row.reviewerFamily = patch.reviewerFamily;
  }
  storeBody(name: string, fileHash: string, raw: string): { stored: boolean; movedToCas: string[] } {
    const k = `${name}/${fileHash}`;
    const stored = !this.bodies.has(k);
    if (stored) this.bodies.set(k, raw);
    return { stored, movedToCas: [] };
  }
  readBody(name: string, fileHash: string): string | null { return this.bodies.get(`${name}/${fileHash}`) ?? null; }
  reverts(name: string): FakeRow[] { return this.live(name).filter((r) => r.op === 'revert'); }
  revertsSince(name: string, sinceMs: number): FakeRow[] { return this.reverts(name).filter((r) => Date.parse(r.at) >= sinceMs); }
  rejectedVersions(name: string): RejectedVersion[] {
    const rows = this.rows(name);
    const out: RejectedVersion[] = [];
    for (const rv of rows) {
      if (rv.void || rv.op !== 'revert') continue;
      const target = rv.revertOf ? rows.find((r) => r.txId === rv.revertOf) ?? null : null;
      const before = target ?? [...rows].reverse().find((r) => !r.void && !r.superseded && rows.indexOf(r) < rows.indexOf(rv) && r.bodyHash !== rv.bodyHash) ?? null;
      const bodyHash = rv.rejectedBodyHash ?? before?.bodyHash ?? null;
      if (!bodyHash) continue;
      out.push({ txId: before?.txId ?? null, bodyHash, citedCorrections: before?.citedCorrections ?? [], revertTxId: rv.txId, at: rv.at });
    }
    return out;
  }
  reconcileAfterSync(name: string, onDiskFileHash: string | null): SyncReconcileOutcomeLike {
    this.reconcileCalls.push({ name, onDiskFileHash });
    const scripted = this.scripted.get(name);
    if (scripted) return scripted(onDiskFileHash);
    const winner = this.lastRow(name);
    if (!winner) return { kind: 'no-rows' };
    if (onDiskFileHash === winner.fileHash) return { kind: 'in-sync', winner };
    return { kind: 'unknown-hash', winner, onDiskFileHash: onDiskFileHash ?? '' };
  }
}

/**
 * In-memory CommitProtocolLike over a FakeVersionStore. Fences every write on the CHAIN (the store's last live
 * row, spec §3.5 step 3), never on the file: a mismatch mirrors the real protocol — the on-disk canonical is
 * locked `operator-owned` with a `lock` version row and `user-edit-conflict` is returned. `create` writes the
 * canonical, `confirm`/`lock` replace it, `reject` removes it; every success appends a version row.
 * `refuse` makes every write fail with that reason before any of this.
 */
export class FakeCommitProtocol implements CommitProtocolLike {
  calls: ProtocolCall[] = [];
  moves: Array<{ op: 'retire' | 'restore'; name: string; from: string; to: string }> = [];
  refuse: Extract<CommitResult, { ok: false }>['reason'] | null = null;
  readonly versions: FakeVersionStore;
  epoch = 1;
  machineId = 'm1';
  constructor(private readonly projectDir: string, versions = new FakeVersionStore()) { this.versions = versions; }
  private canonical(name: string): string { return path.join(this.projectDir, '.instar', 'skills', name, 'SKILL.md'); }
  get version(): number { return [...this.versions.byName.values()].reduce((n, l) => n + l.length, 0); }
  async write(op: CommitOp, name: string, newRaw: string, ctx: { expectedPrevHash: string | null; reason?: string; authorFamily?: string; reviewerFamily?: string }): Promise<CommitResult> {
    this.calls.push({ op, name, newRaw, ctx });
    if (this.refuse) return { ok: false, reason: this.refuse, detail: 'fake refusal' };
    const file = this.canonical(name);
    const chain = this.versions.expectedPrevHash(name);
    // A caller fencing on anything but the chain is a wrong fence (the sentinel must pass the version row's hash).
    if (ctx.expectedPrevHash !== chain) return { ok: false, reason: 'invalid', detail: `expectedPrevHash ${ctx.expectedPrevHash} is not the chain's ${chain}` };
    if (op === 'create' && chain !== null) return { ok: false, reason: 'invalid', detail: 'create carries no expectedPrevHash' };
    const onDisk = fs.existsSync(file) ? sha256(fs.readFileSync(file, 'utf-8')) : null;
    if (onDisk !== ctx.expectedPrevHash) {
      // The real protocol's step 3 (on-disk whole-file hash vs the chain): lock the on-disk canonical operator-owned, row it, refuse.
      if (fs.existsSync(file)) {
        const raw = fs.readFileSync(file, 'utf-8');
        const locked = raw.includes('instar-learned-state: "operator-owned"') ? raw : raw.replace(/instar-learned-state: "?[a-z-]+"?/, 'instar-learned-state: "operator-owned"').replace(/instar-learned-locked: "?(true|false)"?/, 'instar-learned-locked: "true"');
        fs.writeFileSync(file, locked);
        this.versions.append(name, { fileHash: sha256(locked), bodyHash: sha256(bodyOf(locked)), epoch: this.epoch, machineId: this.machineId, void: false, superseded: false, op: 'lock', state: 'operator-owned' });
      }
      return { ok: false, reason: onDisk === null && ctx.expectedPrevHash !== null ? 'unknown-provenance' : 'user-edit-conflict', detail: `on disk ${onDisk} differs from the last version row ${ctx.expectedPrevHash}` };
    }
    if (op === 'reject') {
      SafeFsExecutor.safeRmSync(path.dirname(file), { recursive: true, force: true, operation: 'tests/helpers/skillLearningLiveFixtures.ts:reject' });
    } else {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, newRaw);
    }
    const row = this.versions.append(name, {
      fileHash: sha256(newRaw), bodyHash: sha256(bodyOf(newRaw)), epoch: this.epoch, machineId: this.machineId, void: false, superseded: false,
      op, state: op === 'reject' ? 'proposal' : stateOf(newRaw), ...(ctx.authorFamily ? { authorFamily: ctx.authorFamily } : {}), ...(ctx.reviewerFamily ? { reviewerFamily: ctx.reviewerFamily } : {}), ...(ctx.reason ? { reason: ctx.reason } : {}),
    });
    return { ok: true, txId: row.txId, fileHash: row.fileHash, version: row.version, epoch: this.epoch, fence: 'local' };
  }
  async move(op: 'retire' | 'restore', name: string, fromAbs: string, toAbs: string): Promise<CommitResult> {
    this.moves.push({ op, name, from: fromAbs, to: toAbs });
    return { ok: true, txId: 'mv', fileHash: '', version: this.version, epoch: 1, fence: 'local' };
  }
  async recoverOwnJournal(): Promise<{ finished: number; voided: number; locked: number; foreignDangling: number }> {
    return { finished: 0, voided: 0, locked: 0, foreignDangling: 0 };
  }
}

export interface Harness { sentinel: SkillLearningSentinel; ledger: FakeLedger; home: Home; attention: unknown[]; degradations: unknown[]; evidence: Array<{ kind: string; reason?: string; context?: Record<string, unknown> }>; clock: { now: number }; protocol: FakeCommitProtocol }

export function harness(home: Home, ledger: FakeLedger, families: FamilyProvider[], over: Partial<SkillLearningSentinelDeps> = {}, config = cfg()): Harness {
  const attention: unknown[] = [];
  const degradations: unknown[] = [];
  const evidence: Harness['evidence'] = [];
  const clock = { now: NOW };
  const protocol = new FakeCommitProtocol(home.root);
  const sentinel = new SkillLearningSentinel({
    config, stateDir: home.stateDir, projectDir: home.root, machineId: 'm1', ledger,
    families: () => families,
    transcriptPath: (run) => (run.sessionName && home.transcripts.get(run.sessionName)) ?? null,
    operatorMessage: (src) => `Can you give me the weekly CI health of the instar repo? (msg ${src.messageId})`,
    provenance: { recordDecision: () => 'jp-1', isRecordingLive: () => true },
    createAttentionItem: (item) => { attention.push(item); },
    degradation: { report: (e) => { degradations.push(e); } },
    evidence: { record: (_f, input) => { evidence.push({ kind: input.kind, reason: input.reason, context: input.context as Record<string, unknown> | undefined }); return 'ev'; } },
    commitProtocol: protocol,
    versionStore: protocol.versions,
    mode: () => config.mode,
    rungTwoProven: () => false,
    now: () => clock.now,
    ...over,
  });
  return { sentinel, ledger, home, attention, degradations, evidence, clock, protocol };
}

export const readLog = (home: Home): Array<Record<string, unknown>> => fs.existsSync(path.join(home.stateDir, 'logs', 'skill-learning.jsonl'))
  ? fs.readFileSync(path.join(home.stateDir, 'logs', 'skill-learning.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>)
  : [];
export const proposalDirs = (home: Home): string[] => { const d = path.join(home.stateDir, 'skill-learning', 'proposals'); return fs.existsSync(d) ? fs.readdirSync(d) : []; };
export const canonicalPath = (home: Home, name = SKILL_NAME): string => path.join(home.root, '.instar', 'skills', name, 'SKILL.md');
export const renderedPaths = (home: Home, name = SKILL_NAME): string[] => [path.join(home.root, '.claude', 'skills', name), path.join(home.root, '.agents', 'skills', name)];

/** A proposal with a labelled disagreement and an operator verdict — the §3.4 shadow sample. */
export function writeSampledProposal(home: Home, name: string, disagreement: 'arbiter-only' | 'default-only', verdict: 'agree' | 'disagree'): void {
  const dir = path.join(home.stateDir, 'skill-learning', 'proposals', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'SKILL.md'), SKILL_MD.replace(SKILL_NAME, name));
  fs.writeFileSync(path.join(dir, 'proposal.json'), JSON.stringify({
    name, key: `key-${name}`, arbiterOnly: disagreement === 'arbiter-only', disagreement, createdAt: new Date(NOW - 10 * DAY).toISOString(),
    evidence: { sources: [], runIds: [] }, draftKind: 'new', description: 'x', paraphrases: [],
    verdict: { by: 'operator', verdict, at: new Date(NOW - 9 * DAY).toISOString() },
  }, null, 2));
}
