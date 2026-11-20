/**
 * ConversationGraphSuggestionService — builds, stores and serves the owner's Conversations
 * suggestions (docs/specs/conversation-graph-suggestions.md).
 *
 * Advice only. Nothing here writes a graph event: the owner's Accept runs the ordinary owner
 * changes from the dashboard. This service holds three things in one small state file:
 *   - the last built suggestion list (rebuilt from scratch, never edited by hand);
 *   - the ids the owner rejected (never offered again);
 *   - the ids the owner accepted (so a finished one is not offered again).
 *
 * The owner's decisions (rejected, accepted, an Accept in progress) also reach every machine of the agent
 * (docs/specs/conversation-graph-suggestions-replicated-decisions.md): with a `decisions` store, every
 * decision written here is recorded there and sent, and `load()` overlays the decisions held from other
 * machines. The overlay is never written back to this file, which keeps only this machine's own decisions.
 *
 * Spend is bounded: one model call per build, a build starts automatically at most once per
 * `autoRebuildMs` when the owner opens the list, a manual refresh at most once per
 * `minRebuildMs`, and only one build runs at a time.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { IntelligenceProvider } from '../core/types.js';
import { DegradationReporter } from '../monitoring/DegradationReporter.js';
import { nodeKey, untitledConversationName, type ConversationRef, type ProjectionItem } from '../core/conversationGraph.js';
import {
  buildSuggestionPrompt, parseSuggestionReply, offerableSuggestions, SUGGESTION_LIMITS, projectSuggestionId, suggestionCreateRequestId,
  type GraphSuggestion, type SuggestionInput,
} from '../core/ConversationGraphSuggestions.js';
import type { SuggestionDecisionRow, SuggestionDecisionStore } from '../core/ConversationGraphSuggestionDecisions.js';

export const SUGGESTIONS_STATE_FILE = 'conversation-graph-suggestions.json';
export const SUGGESTIONS_LLM_COMPONENT = 'ConversationGraphSuggestions';

interface StoredMember { key: string; ref: ConversationRef; title: string }
interface StoredSuggestion extends GraphSuggestion { members: StoredMember[] }
interface SuggestionState {
  v: 1;
  builtAt: string | null;
  lastAttemptAt: string | null;
  lastFailure: string | null;
  suggestions: StoredSuggestion[];
  rejected: Record<string, string>;
  accepted: Record<string, string>;
  /**
   * Accepts in progress: one stable create-effort request id per suggestion, so every tab and
   * every reload reuses the same owner request and the server's idempotency yields ONE effort.
   */
  accepting: Record<string, { createRequestId: string; startedAt: string }>;
}

export interface SuggestionViewItem {
  id: string;
  title: string;
  reason: string;
  members: Array<{ ref: ConversationRef; title: string }>;
  /** An Accept was started; Continue resumes it with the same requests. */
  accepting: boolean;
  /** A Chief of Staff project (work-front-doors stage 2b): its conversation becomes the effort's front door. */
  frontDoor?: ConversationRef;
}

/** A project the Chief of Staff tracks, as a ready-made suggestion: its conversation and its sub-conversations. */
export interface ProjectSuggestionSource {
  key: string;
  ref: ConversationRef;
  title: string;
  children: Array<{ key: string; ref: ConversationRef; title: string }>;
}

export interface SuggestionView {
  state: 'ready' | 'building' | 'unavailable';
  builtAt: string | null;
  items: SuggestionViewItem[];
  /** Plain reason when the last build failed (never a raw error). */
  failure?: 'model-unavailable' | 'build-failed';
}

export interface SuggestionServiceDeps {
  stateDir: string;
  intelligence: IntelligenceProvider | null;
  /** What a conversation has been about, and its bound project. Bounded by the caller. */
  evidence(ref: ConversationRef): { project: string | null; text: string };
  /**
   * The Chief of Staff's bound projects (work-front-doors stage 2b). Each is offered as a deterministic
   * suggestion (no model call); the owner's Accept makes it an effort with the project conversation as
   * its front door. Absent ⇒ no project suggestions.
   */
  projects?: () => ProjectSuggestionSource[];
  now?: () => Date;
  /** Minimum gap between two builds the owner asks for. */
  minRebuildMs?: number;
  /** A build starts by itself when the list is opened and the last one is older than this. */
  autoRebuildMs?: number;
  /**
   * The owner's decisions shared with the agent's other machines (replicated-decisions spec). Absent ⇒
   * decisions stay on this machine (single machine, journal off, or the kill switch).
   */
  decisions?: SuggestionDecisionStore | null;
}

/** What `load()` added from other machines' decisions, so `save()` can leave it out of the local file. */
interface Overlay {
  rejected: Map<string, string>;
  accepted: Map<string, string>;
  /** The overlay entry, and the local entry it stood in for (absent when there was none). */
  accepting: Map<string, { shown: SuggestionState['accepting'][string]; local?: SuggestionState['accepting'][string] }>;
  /** The overlay suggestion object, and the local one it stood in for (absent when there was none). */
  suggestions: Map<string, { shown: StoredSuggestion; local?: StoredSuggestion }>;
}

const empty = (): SuggestionState => ({ v: 1, builtAt: null, lastAttemptAt: null, lastFailure: null, suggestions: [], rejected: {}, accepted: {}, accepting: {} });

function validState(raw: unknown): SuggestionState | null {
  const s = raw as Partial<SuggestionState> | null;
  if (!s || s.v !== 1 || !Array.isArray(s.suggestions) || typeof s.rejected !== 'object' || typeof s.accepted !== 'object') return null;
  const out = { ...empty(), ...s } as SuggestionState;
  if (!out.accepting || typeof out.accepting !== 'object') out.accepting = {};
  return out;
}

export class ConversationGraphSuggestionService {
  private building: Promise<void> | null = null;
  private readonly file: string;
  private readonly now: () => Date;
  private readonly minRebuildMs: number;
  private readonly autoRebuildMs: number;
  private readonly overlays = new WeakMap<SuggestionState, Overlay>();
  private backfilled = false;

  constructor(private readonly deps: SuggestionServiceDeps) {
    this.file = path.join(deps.stateDir, SUGGESTIONS_STATE_FILE);
    this.now = deps.now ?? (() => new Date());
    this.minRebuildMs = deps.minRebuildMs ?? 10 * 60_000;
    this.autoRebuildMs = deps.autoRebuildMs ?? 24 * 60 * 60_000;
  }

  // E2E-PAIRING: EXEMPT — this commit only adds degradation reporting to two catches; the route behavior is unchanged and covered by tests/e2e/conversation-graph-suggestions-alive.test.ts.
  /** This machine's file overlaid with the decisions held from every machine (the replicated-decisions spec). */
  private load(): SuggestionState {
    const state = this.loadLocal();
    const store = this.deps.decisions;
    if (!store) return state;
    if (!this.backfilled) { this.backfilled = true; this.backfill(state); }
    const folded = store.fold();
    const overlay: Overlay = { rejected: new Map(), accepted: new Map(), accepting: new Map(), suggestions: new Map() };
    const iso = (ms: number) => new Date(ms).toISOString();
    for (const [id, row] of folded.rejected) if (!state.rejected[id]) { state.rejected[id] = iso(row.atMs); overlay.rejected.set(id, state.rejected[id]); }
    for (const [id, row] of folded.accepted) if (!state.accepted[id]) { state.accepted[id] = iso(row.atMs); overlay.accepted.set(id, state.accepted[id]); }
    for (const [id, row] of folded.accepting) {
      if (state.rejected[id] || state.accepted[id] || !row.createRequestId || !row.snapshot) continue;
      const local = state.accepting[id];
      if (!local || local.createRequestId !== row.createRequestId) {
        // Local progress belongs to the local request; a different winning request starts from its own id.
        const shownEntry = { createRequestId: row.createRequestId, startedAt: iso(row.atMs) };
        state.accepting[id] = shownEntry;
        overlay.accepting.set(id, { shown: shownEntry, ...(local ? { local } : {}) });
      }
      // The winning snapshot governs the suggestion an Accept works on, on every machine.
      const shown = snapshotSuggestion(id, row);
      const i = state.suggestions.findIndex((s) => s.id === id);
      const current = i >= 0 ? state.suggestions[i] : undefined;
      if (current && sameWork(current, shown)) continue;
      if (current) state.suggestions[i] = shown; else state.suggestions.push(shown);
      overlay.suggestions.set(id, { shown, ...(current ? { local: current } : {}) });
    }
    this.overlays.set(state, overlay);
    return state;
  }

  /** Records, once, this machine's decisions made before the store existed (idempotent: the store's comparator keeps held rows). */
  private backfill(state: SuggestionState): void {
    backfillFromState(state, this.deps.decisions!, this.now().getTime());
  }

  /** The `accepting` row for a stored suggestion, or null when it is not stored. */
  private acceptingRow(state: SuggestionState, id: string, createRequestId: string, atMs: number): SuggestionDecisionRow | null {
    return acceptingRowFor(state, id, createRequestId, atMs);
  }

  /** The owner tapped here: a value the overlay brought in becomes this machine's own, so `save()` keeps it. */
  private claimLocal(state: SuggestionState, field: 'rejected' | 'accepted', id: string): void {
    this.overlays.get(state)?.[field].delete(id);
  }

  /** A stored ISO time as the row's `atMs`, so backfill later rebuilds the identical row (same record key). */
  private atMsOf(iso: string): number { return isoMs(iso, this.now().getTime()); }

  /** Hands a decision to the store; a refused row is reported (the decision still holds on this machine). */
  private recordDecision(row: SuggestionDecisionRow): 'recorded' | 'held' | 'invalid' | 'off' {
    const store = this.deps.decisions;
    if (!store) return 'off';
    let out: 'recorded' | 'held' | 'invalid' = 'invalid';
    try { out = store.record(row); } catch { out = 'invalid'; }
    if (out === 'invalid') {
      DegradationReporter.getInstance().report({ feature: 'ConversationGraphSuggestions.replication', primary: 'Share the owner\'s suggestion decision with the agent\'s other machines',
        fallback: 'The decision holds on this machine only', reason: `suggestion-decision-refused:${row.decision}`, impact: 'Another machine may offer this suggestion again', internalOnly: true });
    }
    return out;
  }

  private loadLocal(): SuggestionState {
    if (!fs.existsSync(this.file)) return empty();
    try { return validState(JSON.parse(fs.readFileSync(this.file, 'utf8'))) ?? empty(); } catch {
      // A damaged file would forget rejections, so it is reported, never silently replaced.
      DegradationReporter.getInstance().report({ feature: 'Conversations.suggestions', primary: 'Saved suggestions and rejections',
        fallback: 'Start from an empty suggestion list', reason: 'suggestion-state-unreadable', impact: 'Rejected suggestions may be offered again', internalOnly: true });
      return empty();
    }
  }

  private save(state: SuggestionState): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.withoutOverlay(state), null, 1), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  /** The state as this machine's own file holds it: whatever `load()` added from other machines and the caller left unchanged is dropped. */
  private withoutOverlay(state: SuggestionState): SuggestionState {
    const overlay = this.overlays.get(state);
    if (!overlay) return state;
    const out: SuggestionState = { ...state, rejected: { ...state.rejected }, accepted: { ...state.accepted }, accepting: { ...state.accepting } };
    for (const [id, v] of overlay.rejected) if (out.rejected[id] === v) delete out.rejected[id];
    for (const [id, v] of overlay.accepted) if (out.accepted[id] === v) delete out.accepted[id];
    for (const [id, o] of overlay.accepting) {
      if (out.accepting[id] !== o.shown) continue;
      if (o.local) out.accepting[id] = o.local; else delete out.accepting[id];
    }
    out.suggestions = state.suggestions.flatMap((s) => {
      const o = overlay.suggestions.get(s.id);
      if (!o || o.shown !== s) return [s];
      return o.local ? [o.local] : [];
    });
    return out;
  }

  /** True while a build is running (tests and the route read it). */
  isBuilding(): boolean { return this.building !== null; }

  /**
   * The suggestions still worth offering, given the owner's CURRENT unassigned conversations.
   * Opening the list starts a build when there has never been one, or the last is stale.
   */
  view(unassigned: readonly ProjectionItem[]): SuggestionView {
    this.syncProjects();
    const state = this.load();
    const stale = !state.lastAttemptAt || this.now().getTime() - Date.parse(state.lastAttemptAt) >= this.autoRebuildMs;
    if (stale && this.deps.intelligence) this.start(unassigned);
    const visible = new Map<string, ProjectionItem>();
    for (const item of unassigned) if (item.kind === 'conversation') visible.set(nodeKey(item.ref), item);
    const rejected = new Set(Object.keys(state.rejected)), accepted = new Set(Object.keys(state.accepted));
    const fresh = new Set(offerableSuggestions(state.suggestions, { unassigned: new Set(visible.keys()), rejected, accepted }).map((s) => s.id));
    // A started Accept stays offered while its members move in, so Continue can finish it.
    const offered = state.suggestions.filter((s) => fresh.has(s.id) || (state.accepting[s.id] && !rejected.has(s.id) && !accepted.has(s.id)));
    const byId = new Map(state.suggestions.map((s) => [s.id, s]));
    const items = offered.map((s) => {
      const stored = byId.get(s.id);
      // A project offers only its members still unassigned, until an Accept starts; from then on it keeps every
      // member and its front door, so Continue (even after a reload) finishes the same steps.
      const inProgress = Boolean(state.accepting[s.id]);
      const members = (stored?.members ?? []).filter((m) => !s.frontDoorKey || inProgress || visible.has(m.key));
      const front = s.frontDoorKey ? members.find((m) => m.key === s.frontDoorKey) : undefined;
      return {
        id: s.id, title: s.title, reason: s.reason,
        // Titles come from the current authorized projection, not the stored copy.
        members: members.map((m) => ({ ref: m.ref, title: visible.get(m.key)?.title ?? m.title })),
        accepting: Boolean(state.accepting[s.id]),
        ...(front ? { frontDoor: front.ref } : {}),
      };
    });
    const view: SuggestionView = {
      state: this.building ? 'building' : this.deps.intelligence ? 'ready' : 'unavailable',
      builtAt: state.builtAt, items,
    };
    if (!this.deps.intelligence) view.failure = 'model-unavailable';
    else if (state.lastFailure && !this.building) view.failure = 'build-failed';
    return view;
  }

  /** The owner asked for fresh suggestions. Refused while one runs or one ran very recently. */
  refresh(unassigned: readonly ProjectionItem[]): { started: boolean; reason?: 'model-unavailable' | 'already-building' | 'too-soon' } {
    if (!this.deps.intelligence) return { started: false, reason: 'model-unavailable' };
    if (this.building) return { started: false, reason: 'already-building' };
    this.syncProjects(); // so the model never groups a project's own conversations
    const last = this.load().lastAttemptAt;
    if (last && this.now().getTime() - Date.parse(last) < this.minRebuildMs) return { started: false, reason: 'too-soon' };
    this.start(unassigned);
    return { started: true };
  }

  /** Waits for the running build, if any (tests; route callers never wait). */
  async settled(): Promise<void> { await this.building; }

  /**
   * The owner tapped Accept: the one create-effort request id for this suggestion, made once and
   * then returned to every caller (another tab, a reload, another try). Null for an unknown,
   * rejected or finished suggestion.
   */
  beginAccept(id: string): { createRequestId: string } | null {
    const state = this.load();
    if (!state.suggestions.some((s) => s.id === id) || state.rejected[id] || state.accepted[id]) return null;
    if (!state.accepting[id]) {
      // Derived from the suggestion id, so every tab and every machine sends the same create request.
      const at = this.now();
      state.accepting[id] = { createRequestId: suggestionCreateRequestId(id), startedAt: at.toISOString() };
      this.save(state);
      const row = this.acceptingRow(state, id, state.accepting[id].createRequestId, at.getTime());
      if (row) this.recordDecision(row);
    }
    return { createRequestId: state.accepting[id].createRequestId };
  }

  reject(id: string): boolean {
    const state = this.load();
    if (!state.suggestions.some((s) => s.id === id) && !state.rejected[id]) return false;
    this.claimLocal(state, 'rejected', id);
    state.rejected[id] = state.rejected[id] ?? this.now().toISOString();
    this.save(state);
    this.recordDecision({ suggestionId: id, decision: 'rejected', atMs: this.atMsOf(state.rejected[id]) });
    return true;
  }

  /** Recorded after the dashboard finished every owner change of an Accept. */
  accepted(id: string): boolean {
    const state = this.load();
    if (!state.suggestions.some((s) => s.id === id) && !state.accepted[id]) return false;
    this.claimLocal(state, 'accepted', id);
    state.accepted[id] = state.accepted[id] ?? this.now().toISOString();
    delete state.accepting[id];
    this.save(state);
    this.recordDecision({ suggestionId: id, decision: 'accepted', atMs: this.atMsOf(state.accepted[id]) });
    return true;
  }

  private start(unassigned: readonly ProjectionItem[]): void {
    if (this.building || !this.deps.intelligence) return;
    const current = this.load();
    const busy = new Set(current.suggestions.filter((s) => activeAccept(current, s.id) || s.frontDoorKey).flatMap((s) => s.memberKeys));
    const inputs = this.inputs(unassigned).filter((i) => !busy.has(i.key));
    const startedAt = this.now().toISOString();
    const before = this.load();
    before.lastAttemptAt = startedAt;
    this.save(before);
    this.building = this.build(inputs, startedAt).finally(() => { this.building = null; });
  }

  private inputs(unassigned: readonly ProjectionItem[]): SuggestionInput[] {
    const rows = unassigned
      .filter((item) => item.kind === 'conversation' && item.ref.kind === 'conversation' && item.state !== 'unavailable')
      .sort((a, b) => (b.sourceFreshness ?? '').localeCompare(a.sourceFreshness ?? ''))
      .slice(0, SUGGESTION_LIMITS.maxInputs);
    return rows.map((item) => {
      const ref = item.ref as ConversationRef;
      let ev: { project: string | null; text: string } = { project: null, text: '' };
      try { ev = this.deps.evidence(ref); } catch {
        DegradationReporter.getInstance().report({ feature: 'Conversations.suggestions', primary: 'Topic summary, goals and project as suggestion evidence',
          fallback: 'Suggest from the conversation title alone', reason: 'suggestion-evidence-unreadable', impact: 'That conversation is grouped by its title only', internalOnly: true });
      }
      return { key: nodeKey(ref), ref, title: item.title, project: ev.project, evidence: ev.text };
    });
  }

  /**
   * Keeps one stored suggestion per Chief of Staff project, its members refreshed from the project's
   * current sub-conversations. The id is per project, so a rejection or an accept holds as children change;
   * a project mid-Accept keeps its members until that Accept finishes.
   */
  private syncProjects(): void {
    if (!this.deps.projects) return;
    let projects: ProjectSuggestionSource[];
    try { projects = this.deps.projects(); } catch {
      DegradationReporter.getInstance().report({ feature: 'Conversations.suggestions', primary: 'Chief of Staff projects offered as suggestions',
        fallback: 'Offer only the model-built suggestions', reason: 'project-suggestions-unreadable', impact: 'The Chief of Staff projects are not offered to organize this time', internalOnly: true });
      return;
    }
    const state = this.load();
    let changed = false;
    // A project the Chief of Staff no longer tracks is no longer offered (unless its Accept is in progress).
    const current = new Set(projects.slice(0, 100).map((p) => projectSuggestionId(p.key)));
    const before = state.suggestions.length;
    state.suggestions = state.suggestions.filter((s) => !s.frontDoorKey || current.has(s.id) || activeAccept(state, s.id));
    if (state.suggestions.length !== before) changed = true;
    for (const p of projects.slice(0, 100)) {
      const id = projectSuggestionId(p.key);
      const seen = new Set<string>([p.key]);
      const members = [{ key: p.key, ref: p.ref, title: p.title }, ...p.children.filter((c) => !seen.has(c.key) && (seen.add(c.key), true)).slice(0, SUGGESTION_LIMITS.maxMembers - 1)];
      const memberKeys = members.map((m) => m.key);
      const next = { id, title: `Project: ${p.title}`.slice(0, SUGGESTION_LIMITS.maxEffortNameChars), reason: 'A project the Chief of Staff tracks. Its conversation becomes the project\'s front door.', memberKeys, frontDoorKey: p.key, members };
      const i = state.suggestions.findIndex((s) => s.id === id);
      if (i < 0) { state.suggestions.push(next); changed = true; continue; }
      if (activeAccept(state, id)) continue;
      if (JSON.stringify(state.suggestions[i]) !== JSON.stringify(next)) { state.suggestions[i] = next; changed = true; }
    }
    if (changed) this.save(state);
  }

  private async build(inputs: SuggestionInput[], startedAt: string): Promise<void> {
    let groups: GraphSuggestion[] = [];
    let failure: string | null = null;
    if (inputs.length >= SUGGESTION_LIMITS.minMembers) {
      try {
        const reply = await this.deps.intelligence!.evaluate(buildSuggestionPrompt(inputs), {
          model: 'balanced', maxTokens: 2000, temperature: 0, timeoutMs: 180_000,
          attribution: { component: 'ConversationGraphSuggestions' },
        });
        groups = parseSuggestionReply(reply, inputs, { rejected: new Set(Object.keys(this.load().rejected)) });
      } catch {
        // @silent-fallback-ok: the failure is stored and shown to the owner on the suggestions page ("did not finish, tap Refresh").
        failure = 'build-failed';
      }
    }
    const state = this.load();
    state.lastAttemptAt = startedAt;
    state.lastFailure = failure;
    if (!failure) {
      const byKey = new Map(inputs.map((i) => [i.key, i]));
      state.builtAt = this.now().toISOString();
      // Project suggestions are not the model's: a rebuild keeps them as they are.
      const kept = state.suggestions.filter((s) => s.frontDoorKey || (state.accepting[s.id] && !state.accepted[s.id] && !state.rejected[s.id]));
      const keptIds = new Set(kept.map((s) => s.id));
      // A started Accept (here or on another machine, which may have landed while the model ran) keeps its members out.
      const busy = new Set(kept.filter((s) => activeAccept(state, s.id)).flatMap((s) => s.memberKeys));
      state.suggestions = [...kept, ...groups.filter((g) => !keptIds.has(g.id) && !g.memberKeys.some((k) => busy.has(k))).map((g) => ({ ...g, members: g.memberKeys.map((k) => ({ key: k, ref: byKey.get(k)!.ref, title: byKey.get(k)!.title })) }))];
    }
    this.save(state);
  }
}

/** A stored suggestion built from a winning `accepting` row's snapshot (another machine may never have built it). */
function snapshotSuggestion(id: string, row: SuggestionDecisionRow): StoredSuggestion {
  const snap = row.snapshot!;
  const members = snap.members.map((ref) => ({ key: nodeKey(ref), ref, title: untitledConversationName(ref) }));
  return {
    id, title: snap.title, reason: 'Started on another of your machines.',
    memberKeys: members.map((m) => m.key), members,
    ...(snap.frontDoor ? { frontDoorKey: nodeKey(snap.frontDoor) } : {}),
  };
}

/** The name as a row carries it: the model names' normalization (a project name is sliced but may carry control characters). */
function snapshotTitle(title: string): string {
  const flat = title.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, SUGGESTION_LIMITS.maxEffortNameChars).trim();
  return flat || 'Group';
}

/** Same name (as a row carries it), members and front door: the local suggestion already is the winning snapshot. */
function sameWork(a: StoredSuggestion, b: StoredSuggestion): boolean {
  return snapshotTitle(a.title) === snapshotTitle(b.title) && (a.frontDoorKey ?? '') === (b.frontDoorKey ?? '')
    && a.memberKeys.length === b.memberKeys.length && [...a.memberKeys].sort().join('\n') === [...b.memberKeys].sort().join('\n');
}

/** An Accept still running: started, and neither rejected nor finished on any machine (a raw local entry can outlive both). */
function activeAccept(state: SuggestionState, id: string): boolean {
  return Boolean(state.accepting[id]) && !state.rejected[id] && !state.accepted[id];
}

function isoMs(iso: string, fallback: number): number {
  const ms = Date.parse(iso);
  return Number.isFinite(ms) && ms >= 0 ? ms : fallback;
}

/** The `accepting` row for a stored suggestion, or null when it is not stored. */
function acceptingRowFor(state: SuggestionState, id: string, createRequestId: string, atMs: number): SuggestionDecisionRow | null {
  const s = state.suggestions.find((x) => x.id === id);
  if (!s) return null;
  const members = (s.members ?? []).map((m) => m.ref);
  const front = s.frontDoorKey ? s.members.find((m) => m.key === s.frontDoorKey)?.ref : undefined;
  return { suggestionId: id, decision: 'accepting', atMs, createRequestId, snapshot: { title: snapshotTitle(s.title), members, ...(front ? { frontDoor: front } : {}) } };
}

/**
 * Hands every local decision to the store's comparator as one batch: a held earlier or identical row keeps it a
 * no-op, and an earlier local row (a pre-upgrade start whose create may have committed) wins over a later one that
 * landed first. An `accepting` entry whose id is also rejected or accepted here is skipped (the fold drops it anyway).
 */
function backfillFromState(state: SuggestionState, store: SuggestionDecisionStore, nowMs: number): void {
  const rows: SuggestionDecisionRow[] = [];
  let skipped = 0;
  for (const [id, when] of Object.entries(state.rejected)) rows.push({ suggestionId: id, decision: 'rejected', atMs: isoMs(when, nowMs) });
  for (const [id, when] of Object.entries(state.accepted)) rows.push({ suggestionId: id, decision: 'accepted', atMs: isoMs(when, nowMs) });
  for (const [id, entry] of Object.entries(state.accepting)) {
    if (state.rejected[id] || state.accepted[id]) continue;
    const row = acceptingRowFor(state, id, entry.createRequestId, isoMs(entry.startedAt, nowMs));
    if (row) rows.push(row); else skipped++;
  }
  let invalid = 0;
  try { invalid = store.recordMany(rows).invalid; } catch { invalid = rows.length; }
  if (skipped + invalid > 0) console.warn(`  [suggestion-decisions] ${skipped + invalid} decision(s) made before the upgrade could not be shared (no stored suggestion, or an unknown request id)`);
}

/**
 * Boot: share this machine's decisions made before the store existed, without waiting for a suggestions request
 * (the graph surface may never be served from this machine). Reads the local file; an unreadable file shares nothing.
 */
export function backfillSuggestionDecisions(stateDir: string, store: SuggestionDecisionStore, nowMs = Date.now()): void {
  const file = path.join(stateDir, SUGGESTIONS_STATE_FILE);
  let state: SuggestionState | null = null;
  try { state = fs.existsSync(file) ? validState(JSON.parse(fs.readFileSync(file, 'utf8'))) : null; } catch { state = null; } // @silent-fallback-ok — the service reports an unreadable file when it loads it
  if (state) backfillFromState(state, store, nowMs);
}
