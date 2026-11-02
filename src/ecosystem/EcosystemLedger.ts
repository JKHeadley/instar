/**
 * The pipeline's ledger (docs/specs/ecosystem-idea-pipeline.md §4, Multi-machine posture).
 *
 * An append-only event log: state is derived, and a revision never rewrites an earlier one.
 * Events are immutable and keyed by eventId, so replication has no conflicts: a peer's event
 * lands once, re-validated here. Writes carry the lease epoch and are refused when a newer
 * epoch has been recorded, so an old holder that keeps running cannot write.
 *
 * Decisions bind to a record hash, so a later sighting can never inherit one.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { scrubForStore } from '../core/durableSecretScrub.js';
import {
  EpochFencedError, REPO_NAME_RE, type Decision, type EffectClass, type GapRead, type GoalReview, type Idea, type IdeaStage,
  type ProjectCursor, type RunRow, type Sighting, type WatchEntry, type WatchProposal,
} from './types.js';

export type LedgerEventKind =
  | 'watchlist-add' | 'watchlist-proposal' | 'cursor' | 'run' | 'sighting' | 'split' | 'stage' | 'gap-read' | 'goal-review'
  | 'decision' | 'launch-intent' | 'launch-attempt' | 'launch-recorded' | 'launch-cancelled' | 'adoption' | 'outcome' | 'audit';

export interface LedgerEvent {
  eventId: string;
  kind: LedgerEventKind;
  /** A Lamport clock: one past the highest seen, so state derives in causal order whatever the clocks say. */
  seq: number;
  at: string;
  epoch: number;
  machineId: string;
  data: Record<string, unknown>;
}

const KINDS: ReadonlySet<string> = new Set<LedgerEventKind>([
  'watchlist-add', 'watchlist-proposal', 'cursor', 'run', 'sighting', 'split', 'stage', 'gap-read', 'goal-review',
  'decision', 'launch-intent', 'launch-attempt', 'launch-recorded', 'launch-cancelled', 'adoption', 'outcome', 'audit',
]);
const MAX_EVENT_BYTES = 64 * 1024;

/** Stable id for an idea: the first claim's normalized text within its project. */
export function ideaIdFor(project: string, claim: string): string {
  const norm = claim.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return `idea-${crypto.createHash('sha256').update(`${project}\u0000${norm}`).digest('hex').slice(0, 16)}`;
}

/** What a decision or proof binds to: the idea's latest revision. */
export function recordHash(idea: Pick<Idea, 'id' | 'sightings'>): string {
  const latest = idea.sightings[idea.sightings.length - 1];
  const body = JSON.stringify({ id: idea.id, claim: latest?.claim ?? '', commit: latest?.commit ?? '', evidence: latest?.evidence ?? [] });
  return crypto.createHash('sha256').update(body).digest('hex').slice(0, 32);
}

/** Every string a model or a project wrote is scrubbed before it is saved. */
function scrubDeep(value: unknown): unknown {
  if (typeof value === 'string') return scrubForStore(value).text;
  if (Array.isArray(value)) return value.map(scrubDeep);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubDeep(v)]));
  return value;
}

const isStr = (v: unknown): v is string => typeof v === 'string';
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function validSighting(v: unknown): boolean {
  if (!isObj(v) || !isStr(v.sightingId) || !isStr(v.project) || !isStr(v.commit) || !isStr(v.claim) || !isStr(v.at)) return false;
  if (!Array.isArray(v.evidence) || !Array.isArray(v.excerpts)) return false;
  return v.evidence.every((r) => isObj(r) && isStr(r.path)) && v.excerpts.every((x) => isObj(x) && isStr(x.path) && isStr(x.text));
}

const isOneOf = (v: unknown, allowed: readonly string[]): boolean => isStr(v) && allowed.includes(v);
const GAP_VERDICTS = ['gap', 'partial', 'have-it', 'not-for-us', 'unverified'];
const EFFECT_CLASSES = ['additive-dark', 'behaviour-changing', 'reduces-capability'];
const isStrings = (v: unknown): boolean => Array.isArray(v) && v.every(isStr);

function validRead(v: unknown): boolean {
  return isObj(v) && isStr(v.framework) && isOneOf(v.verdict, GAP_VERDICTS)
    && isOneOf(v.effectClass, EFFECT_CLASSES) && isOneOf(v.searchMode, ['hybrid', 'word-only'])
    && typeof v.singleFamily === 'boolean' && isStrings(v.terms) && isStrings(v.citations);
}

function validGoal(v: unknown): boolean {
  const effect = (o: unknown) => isObj(o) && isOneOf(o.effect, ['helps', 'harms', 'neutral']);
  return isObj(v) && effect(v.coherence) && effect(v.trust) && isObj(v.unhindered) && typeof v.unhindered.addsLimit === 'boolean'
    && isObj(v.instar2) && isOneOf(v.instar2.status, ['in-design', 'conflict', 'absent', 'unknown'])
    && isOneOf(v.goalFit, ['clear', 'some', 'none']) && isOneOf(v.gapSize, ['large', 'medium', 'small']) && isOneOf(v.effort, ['s', 'm', 'l']) && isOneOf(v.evidenceCost, ['available', 'cheap', 'costly']);
}

const CURSOR_STRINGS = ['targetCommit', 'reviewedCommit', 'nextAttemptAt', 'cycleStartedAt', 'lastError', 'lastCheckedAt', 'lastRunAt', 'lastRemoteHead', 'nextDueAt', 'cycleExhaustedUntil'];
function validCursor(v: unknown): boolean {
  if (!isObj(v)) return false;
  for (const [k, value] of Object.entries(v)) {
    if (CURSOR_STRINGS.includes(k)) { if (value !== null && !isStr(value)) return false; }
    else if (k === 'filesDone') { if (!isStrings(value)) return false; }
    else if (k === 'attempt' || k === 'failedCycles') { if (typeof value !== 'number' || !Number.isFinite(value)) return false; }
    else return false;
  }
  return true;
}

/** Each kind's whole payload, checked on write, on load and on receipt, so reduction can trust it. */
function validPayload(kind: LedgerEventKind, d: Record<string, unknown>): boolean {
  switch (kind) {
    case 'watchlist-add': case 'watchlist-proposal': return isStr(d.repo);
    case 'cursor': return isStr(d.project) && validCursor(d.cursor);
    case 'run': return isObj(d.run) && isStr(d.run.runId) && isStr(d.run.at) && Array.isArray(d.run.projects);
    case 'sighting': return isStr(d.ideaId) && validSighting(d.sighting);
    case 'split': return isStr(d.ideaId) && isStr(d.sightingId) && isStr(d.newIdeaId);
    case 'stage': return isStr(d.ideaId) && isStr(d.revision) && ['candidate', 'gap-first', 'gap-second', 'goal', 'done'].includes(d.stage as string);
    case 'gap-read':
      return isStr(d.ideaId) && isStr(d.revision) && (d.which === 'first' || d.which === 'second') && validRead(d.read)
        && (d.verdict === undefined || isOneOf(d.verdict, GAP_VERDICTS)) && (d.effectClass === undefined || isOneOf(d.effectClass, EFFECT_CLASSES));
    case 'goal-review': return isStr(d.ideaId) && isStr(d.revision) && validGoal(d.review);
    case 'decision': return isStr(d.ideaId) && isObj(d.decision) && isStr(d.decision.action) && isStr(d.decision.recordHash) && isStr(d.decision.at);
    case 'launch-intent': case 'launch-attempt': case 'launch-recorded': case 'launch-cancelled': return isStr(d.ideaId) && isStr(d.sessionName);
    case 'adoption': return isStr(d.ideaId) && isStr(d.prediction) && isStr(d.checkAt);
    case 'outcome': return isStr(d.ideaId) && ['helped', 'no-change', 'harmed', 'unknown'].includes(d.result as string);
    case 'audit': return isStr(d.ideaId) && isStr(d.verdict);
    default: return false;
  }
}

export function validateEvent(raw: unknown): LedgerEvent | null {
  if (!raw || typeof raw !== 'object') return null;
  const e = raw as Record<string, unknown>;
  if (typeof e.eventId !== 'string' || e.eventId.length > 80) return null;
  if (typeof e.kind !== 'string' || !KINDS.has(e.kind)) return null;
  if (typeof e.seq !== 'number' || !Number.isSafeInteger(e.seq) || e.seq < 0) return null;
  if (typeof e.at !== 'string' || !Number.isFinite(Date.parse(e.at))) return null;
  if (typeof e.epoch !== 'number' || !Number.isFinite(e.epoch)) return null;
  if (typeof e.machineId !== 'string' || e.machineId.length > 120) return null;
  if (!e.data || typeof e.data !== 'object' || Array.isArray(e.data)) return null;
  if (JSON.stringify(e.data).length > MAX_EVENT_BYTES) return null;
  if (!validPayload(e.kind as LedgerEventKind, e.data as Record<string, unknown>)) return null;
  return { eventId: e.eventId, kind: e.kind as LedgerEventKind, seq: e.seq, at: e.at, epoch: e.epoch, machineId: e.machineId, data: e.data as Record<string, unknown> };
}

export interface LedgerState {
  watchlist: Map<string, WatchEntry>;
  proposals: Map<string, WatchProposal>;
  cursors: Map<string, ProjectCursor>;
  ideas: Map<string, Idea>;
  runs: RunRow[];
}

export function emptyCursor(): ProjectCursor {
  return { targetCommit: null, reviewedCommit: null, filesDone: [], attempt: 0, nextAttemptAt: null, failedCycles: 0, cycleStartedAt: null, lastError: null, lastCheckedAt: null, lastRunAt: null, lastRemoteHead: null, nextDueAt: null, cycleExhaustedUntil: null };
}

function reduce(events: LedgerEvent[]): LedgerState {
  const s: LedgerState = { watchlist: new Map(), proposals: new Map(), cursors: new Map(), ideas: new Map(), runs: [] };
  const sorted = [...events].sort((a, b) => a.seq - b.seq || a.machineId.localeCompare(b.machineId) || a.eventId.localeCompare(b.eventId));
  // An old holder's write that arrives after a newer epoch is left out of state, wherever it came from.
  let epochSeen = 0;
  for (const e of sorted) {
    if (e.epoch < epochSeen) continue;
    epochSeen = e.epoch;
    const d = e.data;
    switch (e.kind) {
      case 'watchlist-add': {
        const repo = String(d.repo ?? '');
        if (!REPO_NAME_RE.test(repo)) break;
        if (!s.watchlist.has(repo)) s.watchlist.set(repo, { id: repo, repo, addedBy: String(d.addedBy ?? ''), addedAt: e.at, reason: String(d.reason ?? '') });
        s.proposals.delete(repo);
        break;
      }
      case 'watchlist-proposal': {
        const repo = String(d.repo ?? '');
        if (!REPO_NAME_RE.test(repo) || s.watchlist.has(repo)) break;
        s.proposals.set(repo, { repo, reason: String(d.reason ?? ''), at: e.at, fromIdea: typeof d.fromIdea === 'string' ? d.fromIdea : null });
        break;
      }
      case 'cursor': {
        const repo = String(d.project ?? '');
        s.cursors.set(repo, { ...emptyCursor(), ...(s.cursors.get(repo) ?? {}), ...(d.cursor as Partial<ProjectCursor>) });
        break;
      }
      case 'run': {
        const row = d.run as RunRow;
        const at = s.runs.findIndex((r) => r.runId === row.runId);
        if (at >= 0) s.runs[at] = row; else s.runs.push(row);
        break;
      }
      case 'sighting': {
        const ideaId = String(d.ideaId ?? '');
        const sighting = d.sighting as Sighting;
        const existing = s.ideas.get(ideaId);
        if (existing) {
          if (!existing.sightings.some((x) => x.sightingId === sighting.sightingId)) {
            existing.sightings.push(sighting);
            // A new revision earns its judgments again: nothing about the old evidence carries over.
            Object.assign(existing, { stage: 'candidate', firstRead: null, secondRead: null, verdict: null, effectClass: null, classLoweredTo: null, goal: null });
          }
          existing.updatedAt = e.at;
        } else {
          s.ideas.set(ideaId, {
            id: ideaId, project: sighting.project, sightings: [sighting], stage: 'candidate', firstRead: null, secondRead: null,
            verdict: null, effectClass: null, classLoweredTo: null, goal: null, decisions: [], launchIntent: null, adoption: null,
            outcome: null, audit: null, firstSeenAt: e.at, updatedAt: e.at,
          });
        }
        break;
      }
      case 'split': {
        // A wrong merge: the sighting leaves its idea and becomes its own. Both revisions stay in the log.
        const from = s.ideas.get(String(d.ideaId ?? ''));
        const sightingId = String(d.sightingId ?? '');
        const moved = from?.sightings.find((x) => x.sightingId === sightingId);
        if (!from || !moved || from.sightings.length < 2) break;
        from.sightings = from.sightings.filter((x) => x.sightingId !== sightingId);
        // If the latest evidence left, what remains is a different revision and earns its judgments again.
        Object.assign(from, { stage: 'candidate', firstRead: null, secondRead: null, verdict: null, effectClass: null, classLoweredTo: null, goal: null });
        const newId = String(d.newIdeaId ?? '');
        s.ideas.set(newId, {
          id: newId, project: moved.project, sightings: [moved], stage: 'candidate', firstRead: null, secondRead: null, verdict: null,
          effectClass: null, classLoweredTo: null, goal: null, decisions: [], launchIntent: null, adoption: null, outcome: null, audit: null,
          firstSeenAt: e.at, updatedAt: e.at,
        });
        break;
      }
      default: {
        const idea = s.ideas.get(String(d.ideaId ?? ''));
        if (!idea) break;
        // A review answer belongs to the revision it read. One that finished after new evidence, or a split, is dropped.
        if ((e.kind === 'stage' || e.kind === 'gap-read' || e.kind === 'goal-review') && d.revision !== recordHash(idea)) break;
        idea.updatedAt = e.at;
        if (e.kind === 'stage') idea.stage = d.stage as IdeaStage;
        if (e.kind === 'gap-read') {
          if (d.which === 'first') idea.firstRead = d.read as GapRead; else idea.secondRead = d.read as GapRead;
          if (typeof d.verdict === 'string') idea.verdict = d.verdict as Idea['verdict'];
          if (typeof d.effectClass === 'string') idea.effectClass = d.effectClass as EffectClass;
        }
        if (e.kind === 'goal-review') idea.goal = d.review as GoalReview;
        if (e.kind === 'decision') {
          const dec = d.decision as Decision;
          idea.decisions.push(dec);
          if (dec.action === 'lower-class' && dec.effectClass) idea.classLoweredTo = dec.effectClass;
        }
        if (e.kind === 'launch-intent') idea.launchIntent = { sessionName: String(d.sessionName), at: e.at, reason: String(d.reason ?? ''), revision: isStr(d.revision) ? d.revision : null, attemptedAt: null, recorded: false };
        if (e.kind === 'launch-cancelled') idea.launchIntent = null;
        if (e.kind === 'launch-attempt' && idea.launchIntent) idea.launchIntent.attemptedAt = e.at;
        if (e.kind === 'launch-recorded' && idea.launchIntent) idea.launchIntent.recorded = true;
        if (e.kind === 'adoption') idea.adoption = { prediction: String(d.prediction ?? ''), checkAt: String(d.checkAt ?? ''), at: e.at, ref: String(d.ref ?? '') };
        if (e.kind === 'outcome') idea.outcome = { result: d.result as NonNullable<Idea['outcome']>['result'], evidence: String(d.evidence ?? ''), at: e.at };
        if (e.kind === 'audit') idea.audit = { at: e.at, verdict: d.verdict as Idea['verdict'] & string, overturned: d.overturned === true };
      }
    }
  }
  return s;
}

export interface EcosystemLedgerOptions {
  /** `<stateDir>/state/ecosystem`: git sync already excludes it. */
  dir: string;
  machineId: () => string;
  clock?: () => number;
}

export class EcosystemLedger {
  private events = new Map<string, LedgerEvent>();
  private highEpoch = 0;
  private highSeq = 0;
  private cached: LedgerState | null = null;
  private replicationHook: ((event: LedgerEvent) => void) | null = null;
  private readonly file: string;
  private readonly clock: () => number;
  corruptLines = 0;

  constructor(private readonly opts: EcosystemLedgerOptions) {
    fs.mkdirSync(opts.dir, { recursive: true });
    this.file = path.join(opts.dir, 'events.jsonl');
    this.clock = opts.clock ?? Date.now;
    this.load();
  }

  private load(): void {
    if (!fs.existsSync(this.file)) return;
    for (const line of fs.readFileSync(this.file, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      let parsed: unknown = null;
      try { parsed = JSON.parse(line); } catch { /* @silent-fallback-ok: counted in corruptLines and shown on the status route */ }
      const e = validateEvent(parsed);
      if (!e) { this.corruptLines++; continue; }
      this.events.set(e.eventId, e);
      this.highEpoch = Math.max(this.highEpoch, e.epoch);
      this.highSeq = Math.max(this.highSeq, e.seq);
    }
  }

  setReplicationHook(hook: ((event: LedgerEvent) => void) | null): void { this.replicationHook = hook; }

  /** Author one event. Refused when a newer lease epoch has been recorded. */
  append(kind: LedgerEventKind, data: Record<string, unknown>, epoch: number): LedgerEvent {
    if (epoch < this.highEpoch) throw new EpochFencedError(epoch, this.highEpoch);
    const scrubbed = scrubDeep(data) as Record<string, unknown>;
    const event: LedgerEvent = {
      eventId: `ev-${crypto.randomUUID()}`, kind, seq: this.highSeq + 1, at: new Date(this.clock()).toISOString(), epoch,
      machineId: this.opts.machineId(), data: scrubbed,
    };
    const valid = validateEvent(event);
    if (!valid) throw new Error(`ecosystem ledger: refusing an invalid ${kind} event`);
    this.persist(valid);
    try { this.replicationHook?.(valid); } catch { /* @silent-fallback-ok: the event is durable locally and peers re-read the stream at boot */ }
    return valid;
  }

  private persist(event: LedgerEvent): void {
    fs.appendFileSync(this.file, `${JSON.stringify(event)}\n`, { mode: 0o600 }); /* state-registry: ecosystem-ideas */
    this.events.set(event.eventId, event);
    this.highEpoch = Math.max(this.highEpoch, event.epoch);
    this.highSeq = Math.max(this.highSeq, event.seq);
    this.cached = null;
  }

  /** Land a peer's event: re-validated, once. A peer's row is data from the agent's own machine. */
  ingestReplicated(raw: unknown): 'landed' | 'duplicate' | 'invalid' {
    const event = validateEvent(raw);
    if (!event) return 'invalid';
    if (this.events.has(event.eventId)) return 'duplicate';
    this.persist(event);
    return 'landed';
  }

  state(): LedgerState {
    if (!this.cached) this.cached = reduce([...this.events.values()]);
    return this.cached;
  }

  highestEpoch(): number { return this.highEpoch; }
  eventCount(): number { return this.events.size; }
  lastEventAt(): string | null {
    let last: string | null = null;
    for (const e of this.events.values()) if (!last || e.at > last) last = e.at;
    return last;
  }
}
