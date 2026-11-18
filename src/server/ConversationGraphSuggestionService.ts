/**
 * ConversationGraphSuggestionService — builds, stores and serves the owner's Conversations
 * suggestions (docs/specs/conversation-graph-suggestions.md).
 *
 * Advice only. Nothing here writes a graph event: the owner's Accept runs the ordinary owner
 * changes (ConversationGraphSuggestionAccept.ts, one server step both the dashboard and the phone call). This service holds three things in one small state file:
 *   - the last built suggestion list (rebuilt from scratch, never edited by hand);
 *   - the ids the owner rejected (never offered again);
 *   - the ids the owner accepted (so a finished one is not offered again).
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
import { nodeKey, type ConversationRef, type EffortRef, type ProjectionItem } from '../core/conversationGraph.js';
import {
  buildSuggestionPrompt, parseSuggestionReply, offerableSuggestions, SUGGESTION_LIMITS, projectSuggestionId, suggestionCreateRequestId,
  type GraphSuggestion, type SuggestionInput,
} from '../core/ConversationGraphSuggestions.js';

export const SUGGESTIONS_STATE_FILE = 'conversation-graph-suggestions.json';
export const SUGGESTIONS_LLM_COMPONENT = 'ConversationGraphSuggestions';

interface StoredMember { key: string; ref: ConversationRef; title: string }
interface StoredSuggestion extends GraphSuggestion { members: StoredMember[] }

/**
 * Where one Accept has got to: a per-machine cache of progress, never the source of truth. The request ids are
 * derived (acceptRequestId), so another machine without this file re-sends the same requests and finds each
 * step already done. Only opaque ids and refs, never conversation text.
 */
/**
 * The owner request id for one Accept step, derived from the suggestion id (conversation-groups-phone §2):
 * every caller on every machine sends the same request for the same step, so the owner pipeline's replicated
 * idempotency makes one group, never two.
 */
export function acceptRequestId(suggestionId: string, step: 'create' | 'name' | 'move' | 'front-door', memberKey = ''): string {
  // The create id is the shared one (#3345 / CMT-1650 derives the same value); the others follow the same formula.
  if (step === 'create' && !memberKey) return suggestionCreateRequestId(suggestionId);
  return `sga-${crypto.createHash('sha256').update(`conversation-group-accept\n${suggestionId}\n${step}\n${memberKey}`).digest('hex').slice(0, 40)}`;
}

export interface SuggestionAcceptProgress {
  createRequestId: string;
  startedAt: string;
  /** The group (effort) the create step made. */
  effort?: EffortRef;
  /** The group has been read back at least once (so a later missing read means removed, not lagging). */
  effortSeen?: boolean;
  /** Reads that found no group before it was ever seen (bounded: the third means removed). */
  missedReads?: number;
  firstMissAt?: string;
  /** Answers the pipeline should never give (bounded: the third hands the decision back to the owner). */
  unexpected?: number;
  /** When a step last finished (the 5-minute no-progress brake). */
  lastProgressAt?: string;
  /** When the last call for this Accept arrived (an absence restarts the brake clock). */
  lastCallAt?: string;
  /** The name was refused and the group is still unnamed (the Accept went on without it). */
  nameRefused?: boolean;
  named?: boolean;
  nameId?: string;
  moved?: string[];
  skipped?: string[];
  moveIds?: Record<string, string>;
  frontDoorId?: string;
  frontDoorSet?: boolean;
}

/** What a finished Accept did, so a repeated Accept answers the same instead of "unknown". */
export interface SuggestionAcceptResult { group: EffortRef | null; moved: number; skipped: number; placedElsewhere: boolean }

/** One suggestion as the accept step needs it: the stored members (every one, not only the unassigned). */
export interface SuggestionAcceptTarget {
  id: string;
  title: string;
  members: StoredMember[];
  frontDoor?: ConversationRef;
}
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
  accepting: Record<string, SuggestionAcceptProgress>;
  /** What each finished Accept did (absent for ones finished before this was kept). */
  acceptResults?: Record<string, SuggestionAcceptResult>;
  /** Accepts handed back to the owner (Accept again or Reject both work); cleared when the owner Accepts again. */
  handedBack?: Record<string, string>;
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
}

const empty = (): SuggestionState => ({ v: 1, builtAt: null, lastAttemptAt: null, lastFailure: null, suggestions: [], rejected: {}, accepted: {}, accepting: {}, acceptResults: {} });

function validState(raw: unknown): SuggestionState | null {
  const s = raw as Partial<SuggestionState> | null;
  if (!s || s.v !== 1 || !Array.isArray(s.suggestions) || typeof s.rejected !== 'object' || typeof s.accepted !== 'object') return null;
  const out = { ...empty(), ...s } as SuggestionState;
  if (!out.accepting || typeof out.accepting !== 'object') out.accepting = {};
  if (!out.acceptResults || typeof out.acceptResults !== 'object') out.acceptResults = {};
  return out;
}

export class ConversationGraphSuggestionService {
  private building: Promise<void> | null = null;
  private readonly file: string;
  private readonly now: () => Date;
  private readonly minRebuildMs: number;
  private readonly autoRebuildMs: number;

  constructor(private readonly deps: SuggestionServiceDeps) {
    this.file = path.join(deps.stateDir, SUGGESTIONS_STATE_FILE);
    this.now = deps.now ?? (() => new Date());
    this.minRebuildMs = deps.minRebuildMs ?? 10 * 60_000;
    this.autoRebuildMs = deps.autoRebuildMs ?? 24 * 60 * 60_000;
  }

  // E2E-PAIRING: EXEMPT — this commit only adds degradation reporting to two catches; the route behavior is unchanged and covered by tests/e2e/conversation-graph-suggestions-alive.test.ts.
  private load(): SuggestionState {
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
    fs.writeFileSync(tmp, JSON.stringify(state, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
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
    } else if (state.handedBack?.[id]) {
      // Accept again after a hand-back: the Accept is live again, so Reject is refused again.
      delete state.handedBack[id];
      this.save(state);
    }
    return { createRequestId: state.accepting[id].createRequestId };
  }

  /**
   * The suggestion an Accept works on, with every stored member, and whether an Accept had already
   * started before this call. Null for an unknown or rejected suggestion. A finished one answers its result.
   */
  acceptTarget(id: string): { target: SuggestionAcceptTarget; started: boolean } | { finished: SuggestionAcceptResult } | null {
    const state = this.load();
    if (state.rejected[id]) return null;
    if (state.accepted[id]) return { finished: state.acceptResults?.[id] ?? { group: null, moved: 0, skipped: 0, placedElsewhere: false } };
    const stored = state.suggestions.find((s) => s.id === id);
    if (!stored) return null;
    const members = (stored.members ?? []).filter((m) => m && typeof m.key === 'string' && m.ref);
    const front = stored.frontDoorKey ? members.find((m) => m.key === stored.frontDoorKey) : undefined;
    return { target: { id, title: stored.title, members, ...(front ? { frontDoor: front.ref } : {}) }, started: Boolean(state.accepting[id]) };
  }

  /** The progress of a started Accept, or null. */
  acceptProgress(id: string): SuggestionAcceptProgress | null {
    const p = this.load().accepting[id];
    return p ? { ...p } : null;
  }

  /** Saves a started Accept's progress (never starts one: beginAccept does). */
  saveAcceptProgress(id: string, progress: SuggestionAcceptProgress): boolean {
    const state = this.load();
    if (!state.accepting[id] || state.accepting[id].createRequestId !== progress.createRequestId) return false;
    state.accepting[id] = { ...progress };
    this.save(state);
    return true;
  }

  /** True once an Accept has sent its create (and was not handed back): from then on Reject could strand a half-made group. */
  acceptStarted(id: string): boolean {
    const state = this.load();
    return Boolean(state.accepting[id]) && !state.handedBack?.[id];
  }

  /**
   * The Accept hands the decision back to the owner (nothing known was made, or the group cannot be found): its
   * progress is dropped and Reject works again. Recorded as a local `handedBack` mark, so an Accept row another
   * machine shares (the replicated decisions of CMT-1650) cannot quietly make Reject refuse again.
   */
  dropAccept(id: string): void {
    const state = this.load();
    delete state.accepting[id];
    state.handedBack = { ...(state.handedBack ?? {}), [id]: this.now().toISOString() };
    this.save(state);
  }

  /** The group an Accept made is gone: close the suggestion (never offered again) and drop its progress. */
  closeAccept(id: string): void {
    const state = this.load();
    state.rejected[id] = state.rejected[id] ?? this.now().toISOString();
    delete state.accepting[id];
    this.save(state);
  }

  reject(id: string): boolean {
    const state = this.load();
    if (!state.suggestions.some((s) => s.id === id) && !state.rejected[id]) return false;
    state.rejected[id] = state.rejected[id] ?? this.now().toISOString();
    this.save(state);
    return true;
  }

  /** Recorded after every owner change of an Accept finished (the server's accept step, or an older dashboard). */
  accepted(id: string, result?: SuggestionAcceptResult): boolean {
    const state = this.load();
    if (!state.suggestions.some((s) => s.id === id) && !state.accepted[id]) return false;
    state.accepted[id] = state.accepted[id] ?? this.now().toISOString();
    if (result) state.acceptResults = { ...(state.acceptResults ?? {}), [id]: result };
    delete state.accepting[id];
    this.save(state);
    return true;
  }

  private start(unassigned: readonly ProjectionItem[]): void {
    if (this.building || !this.deps.intelligence) return;
    const current = this.load();
    const busy = new Set(current.suggestions.filter((s) => current.accepting[s.id] || s.frontDoorKey).flatMap((s) => s.memberKeys));
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
    state.suggestions = state.suggestions.filter((s) => !s.frontDoorKey || current.has(s.id) || state.accepting[s.id]);
    if (state.suggestions.length !== before) changed = true;
    for (const p of projects.slice(0, 100)) {
      const id = projectSuggestionId(p.key);
      const seen = new Set<string>([p.key]);
      const members = [{ key: p.key, ref: p.ref, title: p.title }, ...p.children.filter((c) => !seen.has(c.key) && (seen.add(c.key), true)).slice(0, SUGGESTION_LIMITS.maxMembers - 1)];
      const memberKeys = members.map((m) => m.key);
      const next = { id, title: `Project: ${p.title}`.slice(0, SUGGESTION_LIMITS.maxEffortNameChars), reason: 'A project the Chief of Staff tracks. Its conversation becomes the project\'s front door.', memberKeys, frontDoorKey: p.key, members };
      const i = state.suggestions.findIndex((s) => s.id === id);
      if (i < 0) { state.suggestions.push(next); changed = true; continue; }
      if (state.accepting[id]) continue;
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
      state.suggestions = [...kept, ...groups.filter((g) => !keptIds.has(g.id)).map((g) => ({ ...g, members: g.memberKeys.map((k) => ({ key: k, ref: byKey.get(k)!.ref, title: byKey.get(k)!.title })) }))];
    }
    this.save(state);
  }
}
