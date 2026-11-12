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
 * Spend is bounded: one model call per build, a build starts automatically at most once per
 * `autoRebuildMs` when the owner opens the list, a manual refresh at most once per
 * `minRebuildMs`, and only one build runs at a time.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { IntelligenceProvider } from '../core/types.js';
import { nodeKey, type ConversationRef, type ProjectionItem } from '../core/conversationGraph.js';
import {
  buildSuggestionPrompt, parseSuggestionReply, offerableSuggestions, SUGGESTION_LIMITS,
  type GraphSuggestion, type SuggestionInput,
} from '../core/ConversationGraphSuggestions.js';

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
  now?: () => Date;
  /** Minimum gap between two builds the owner asks for. */
  minRebuildMs?: number;
  /** A build starts by itself when the list is opened and the last one is older than this. */
  autoRebuildMs?: number;
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

  constructor(private readonly deps: SuggestionServiceDeps) {
    this.file = path.join(deps.stateDir, SUGGESTIONS_STATE_FILE);
    this.now = deps.now ?? (() => new Date());
    this.minRebuildMs = deps.minRebuildMs ?? 10 * 60_000;
    this.autoRebuildMs = deps.autoRebuildMs ?? 24 * 60 * 60_000;
  }

  private load(): SuggestionState {
    try { return validState(JSON.parse(fs.readFileSync(this.file, 'utf8'))) ?? empty(); } catch { return empty(); }
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
    const items = offered.map((s) => ({
      id: s.id, title: s.title, reason: s.reason,
      // Titles come from the current authorized projection, not the stored copy.
      members: (byId.get(s.id)?.members ?? []).map((m) => ({ ref: m.ref, title: visible.get(m.key)?.title ?? m.title })),
      accepting: Boolean(state.accepting[s.id]),
    }));
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
      state.accepting[id] = { createRequestId: `suggestion-${crypto.randomUUID()}`, startedAt: this.now().toISOString() };
      this.save(state);
    }
    return { createRequestId: state.accepting[id].createRequestId };
  }

  reject(id: string): boolean {
    const state = this.load();
    if (!state.suggestions.some((s) => s.id === id) && !state.rejected[id]) return false;
    state.rejected[id] = state.rejected[id] ?? this.now().toISOString();
    this.save(state);
    return true;
  }

  /** Recorded after the dashboard finished every owner change of an Accept. */
  accepted(id: string): boolean {
    const state = this.load();
    if (!state.suggestions.some((s) => s.id === id) && !state.accepted[id]) return false;
    state.accepted[id] = state.accepted[id] ?? this.now().toISOString();
    delete state.accepting[id];
    this.save(state);
    return true;
  }

  private start(unassigned: readonly ProjectionItem[]): void {
    if (this.building || !this.deps.intelligence) return;
    const current = this.load();
    const busy = new Set(current.suggestions.filter((s) => current.accepting[s.id]).flatMap((s) => s.memberKeys));
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
      try { ev = this.deps.evidence(ref); } catch { /* no evidence for this one: title only */ }
      return { key: nodeKey(ref), ref, title: item.title, project: ev.project, evidence: ev.text };
    });
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
        failure = 'build-failed';
      }
    }
    const state = this.load();
    state.lastAttemptAt = startedAt;
    state.lastFailure = failure;
    if (!failure) {
      const byKey = new Map(inputs.map((i) => [i.key, i]));
      state.builtAt = this.now().toISOString();
      const kept = state.suggestions.filter((s) => state.accepting[s.id] && !state.accepted[s.id] && !state.rejected[s.id]);
      const keptIds = new Set(kept.map((s) => s.id));
      state.suggestions = [...kept, ...groups.filter((g) => !keptIds.has(g.id)).map((g) => ({ ...g, members: g.memberKeys.map((k) => ({ key: k, ref: byKey.get(k)!.ref, title: byKey.get(k)!.title })) }))];
    }
    this.save(state);
  }
}
