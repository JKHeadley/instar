/**
 * The one Accept step for a Conversations suggestion (docs/specs/conversation-graph-suggestions.md §4,
 * docs/specs/conversation-groups-phone.md §2). The dashboard and the owner's phone both call it with one
 * request; it runs, on the server, exactly the owner changes a manual Create group + Move would:
 *
 *   0. a project suggestion whose own conversation already sits inside something creates nothing;
 *   1. create the group (effort), with the one create request id the server made for this suggestion;
 *   2. name it (skipped when it already has a name);
 *   3. move each conversation in, previewed first (one placed elsewhere since, or no longer movable, is skipped:
 *      the owner's own placement wins);
 *   4. a project's own conversation becomes the group's front door;
 *   5. record the suggestion as accepted.
 *
 * Each step waits for its change to be saved on every machine before the next, because the next names what
 * the last one made. Each call has a time budget, checked before every read, preview and change and raced
 * against every wait: when it runs out the call answers `working`, and the next call resumes. Every request id
 * is DERIVED from the suggestion id, the step and the conversation (acceptRequestId), so a resumed call, another
 * tab, the phone or another machine all send the SAME owner requests and the pipeline's idempotency (which
 * replicates) yields one group.
 *
 * Authority: every change goes through ConversationGraphOwnerChanges with the caller's own request, so the
 * owner proof is the request's (dashboard operator session or owner-phone device signature). This module
 * never accepts on the agent's own initiative and holds no authority of its own.
 */
import type { Request } from 'express';
import { DegradationReporter } from '../monitoring/DegradationReporter.js';
import { nodeKey, validateNodeRef, type ConversationRef, type EffortRef, type NodeRef } from '../core/conversationGraph.js';
import type { ConversationGraphReadModel, GraphViewer } from '../core/conversationGraphRead.js';
import type { ConversationGraphOwnerChanges, GraphChangeReply } from './ConversationGraphOwnerChanges.js';
import { acceptRequestId, type ConversationGraphSuggestionService, type SuggestionAcceptProgress, type SuggestionAcceptTarget } from './ConversationGraphSuggestionService.js';

export type SuggestionAcceptStep = 'checking' | 'creating' | 'naming' | 'moving' | 'front-door' | 'finishing';

export type SuggestionAcceptOutcome =
  | { kind: 'accepted'; group: EffortRef | null; moved: number; skipped: number; placedElsewhere: boolean }
  /** Still going: call again (same request) to continue. Nothing is lost. */
  | { kind: 'working'; step: SuggestionAcceptStep; text: string; waitingMachines: Array<{ machineId: string; name: string }>; agentNotAnswering: boolean }
  /** A change was refused; nothing after it was changed. */
  | { kind: 'refused'; step: SuggestionAcceptStep; code: string; text: string }
  | { kind: 'unknown' }
  | { kind: 'not-owner' };

/** The owner-change calls the accept makes, all with the caller's own request. */
export interface SuggestionAcceptPort {
  viewer(): GraphViewer | null;
  node(ref: NodeRef): { status: number; body: Record<string, unknown> };
  submit(requestId: string, change: Record<string, unknown>): Promise<GraphChangeReply>;
  status(requestId: string): Promise<GraphChangeReply>;
  preview(change: Record<string, unknown>): GraphChangeReply | Promise<GraphChangeReply>;
}

export function suggestionAcceptPort(deps: { model: ConversationGraphReadModel; changes: ConversationGraphOwnerChanges;
  resolveViewer(req: Request, surface: 'dashboard' | 'mobile'): GraphViewer | null }, req: Request, surface: 'dashboard' | 'mobile'): SuggestionAcceptPort {
  return {
    viewer: () => deps.resolveViewer(req, surface),
    node: (ref) => {
      const viewer = deps.resolveViewer(req, surface);
      if (!viewer) return { status: 403, body: { code: 'hierarchy-owner-only' } };
      return deps.model.node(viewer, ref, {}) as { status: number; body: Record<string, unknown> };
    },
    submit: (requestId, change) => deps.changes.submit(req, surface, requestId, change),
    status: (requestId) => deps.changes.statusWithLocal(req, surface, requestId),
    preview: (change) => deps.changes.preview(req, surface, change),
  };
}

const FINAL_FAIL = ['canceled', 'canceled-local', 'refused-local', 'erased'];
const REQUEST_ID = /^[A-Za-z0-9_.:-]{8,160}$/;
const EVENT_ID = /^[A-Za-z0-9_-]{8,80}$/;
const noAnswer = (status: number): boolean => status === 0 || status === 408 || status >= 500;

interface NodeView {
  path: NodeRef[];
  frontDoor: ConversationRef | null;
  moveEligible: boolean | null;
  replacesPlacementEventIds: string[] | null;
  replacesFrontDoorEventIds: string[] | null;
  headerVersion: number | null;
}

/**
 * Submits still in flight on this machine, by request id. A call that ran out of time leaves its submit running;
 * the next call joins that same promise instead of queueing a second copy behind it in the graph's write queue.
 */
const inflightSubmits = new Map<string, { p: Promise<GraphChangeReply>; at: number }>();
/** A submit older than this is not joined: a fresh one is sent (the pipeline deduplicates it), so a submit that never settles cannot hold an Accept. */
const INFLIGHT_JOIN_MS = 60_000;
function submitOnce(port: SuggestionAcceptPort, requestId: string, change: Record<string, unknown>): Promise<GraphChangeReply> {
  // Keyed by the caller's grant too: a caller never inherits another caller's (possibly revoked) proof.
  const key = `${requestId}\n${port.viewer()?.grantVersion ?? ''}`;
  const running = inflightSubmits.get(key);
  if (running && Date.now() - running.at < INFLIGHT_JOIN_MS) return running.p;
  const p = Promise.resolve().then(() => port.submit(requestId, change));
  const entry = { p, at: Date.now() };
  inflightSubmits.set(key, entry);
  const done = () => { if (inflightSubmits.get(key) === entry) inflightSubmits.delete(key); };
  p.then(done, done);
  return p;
}

const ids = (v: unknown): string[] | null => Array.isArray(v) && v.length <= 32 && v.every((x) => typeof x === 'string' && EVENT_ID.test(x)) ? [...v] as string[] : null;

/** The parts of a node read the accept steps use; null when it is hidden or absent. */
function readNode(r: { status: number; body: Record<string, unknown> }): NodeView | 'unavailable' | 'not-owner' | null {
  if (r.status === 403) return 'not-owner';
  if (r.status === 404) return null;
  if (r.status !== 200) return 'unavailable';
  const body = r.body;
  const path = Array.isArray(body.path) ? (body.path as Array<{ ref?: unknown }>).map((p) => validateNodeRef(p?.ref)).filter((x): x is NodeRef => x !== null) : [];
  const node = body.node as { frontDoor?: unknown } | undefined;
  const fd = node?.frontDoor ? validateNodeRef(node.frontDoor) : null;
  const c = body.correction as Record<string, unknown> | undefined;
  return {
    path,
    frontDoor: fd && fd.kind === 'conversation' ? fd : null,
    moveEligible: c && typeof c.moveEligible === 'boolean' ? c.moveEligible : null,
    replacesPlacementEventIds: c ? ids(c.replacesPlacementEventIds) : null,
    replacesFrontDoorEventIds: c ? ids(c.replacesFrontDoorEventIds) : null,
    headerVersion: c && Number.isSafeInteger(c.headerVersion) && (c.headerVersion as number) >= 0 ? c.headerVersion as number : null,
  };
}

type ChangeResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; refused: string }
  | { ok: false; waiting: true; body: Record<string, unknown>; unreachable: boolean }
  | { ok: false; notOwner: true };

export interface SuggestionAcceptOptions {
  /** How long one call may keep waiting for saves before it answers `working`. */
  budgetMs?: number;
  /** Gap between two status checks of a change still saving. */
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Runs (or continues) one Accept. Never throws for an owner-path answer; an unexpected error reads as
 * `working` with the agent not answering, because nothing was refused and the next call resumes.
 */
export async function runSuggestionAccept(id: string, service: ConversationGraphSuggestionService, port: SuggestionAcceptPort,
  opts: SuggestionAcceptOptions = {}): Promise<SuggestionAcceptOutcome> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const pollMs = opts.pollMs ?? 1000;
  const deadline = now() + (opts.budgetMs ?? 15_000);
  const outOfTime = (): boolean => now() >= deadline;
  /** A wait raced against the time left: 'late' when the budget ran out first (the request itself goes on; resending it is safe). */
  const inTime = async <T>(p: Promise<T> | T): Promise<T | 'late'> => {
    const left = deadline - now();
    if (left <= 0) return 'late';
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([Promise.resolve(p), new Promise<'late'>((resolve) => { timer = setTimeout(() => resolve('late'), left); })]);
    } finally { if (timer) clearTimeout(timer); }
  };
  if (!port.viewer()) return { kind: 'not-owner' };
  const found = service.acceptTarget(id);
  if (!found) return { kind: 'unknown' };
  if ('finished' in found) return { kind: 'accepted', ...found.finished };
  const s: SuggestionAcceptTarget = found.target;

  let step: SuggestionAcceptStep = 'checking';
  let text = '';
  let progressRef: SuggestionAcceptProgress | null = null;
  const working = (extra: { body?: Record<string, unknown>; unreachable?: boolean } = {}): SuggestionAcceptOutcome => {
    // Brake: no step has finished for 5 minutes. Say so plainly instead of "still working" for ever; progress is
    // kept, so Continue later resumes exactly where it stopped.
    const last = progressRef?.lastProgressAt ? Date.parse(progressRef.lastProgressAt) : NaN;
    if (Number.isFinite(last) && now() - last >= 5 * 60_000) {
      return { kind: 'refused', step, code: 'still-saving', text: 'No step has finished in the last 5 minutes of trying (a machine may be offline). Nothing is lost: tap Continue later and it picks up where it stopped.' };
    }
    const waitingMachines = Array.isArray(extra.body?.waitingMachines)
      ? (extra.body!.waitingMachines as Array<{ machineId?: unknown; name?: unknown }>)
        .filter((m) => typeof m?.machineId === 'string').map((m) => ({ machineId: String(m.machineId), name: typeof m.name === 'string' ? m.name : 'Agent machine' }))
      : [];
    const waits = extra.unreachable ? 'The agent is not answering yet.'
      : extra.body?.code === 'subject-change-pending' ? 'An earlier change to this conversation is still being saved on your machines.'
        : waitingMachines.length ? `Saved here. Waiting for ${waitingMachines.map((m) => m.name).join(', ')} to confirm.` : '';
    return { kind: 'working', step, text: [text, waits].filter(Boolean).join(' '), waitingMachines, agentNotAnswering: Boolean(extra.unreachable) };
  };
  const say = (next: SuggestionAcceptStep, words: string) => { step = next; text = words; };
  const refused = (code: string): SuggestionAcceptOutcome => ({ kind: 'refused', step, code, text: step === 'creating' ? 'The group could not be made, so nothing was changed. Tap Reject to drop this suggestion, or Accept again later.'
    : `${({ naming: 'The group could not be named', 'front-door': 'Its conversation could not be made the front door' } as Record<string, string>)[step] ?? 'This step could not be done'}, so nothing after it was changed. Open the group to check it, or tap Continue later.` });

  /** One owner change, sent once and then checked until it is saved everywhere or the budget runs out. */
  const runChange = async (requestId: string, change: Record<string, unknown>): Promise<ChangeResult> => {
    if (outOfTime()) return { ok: false, waiting: true, body: {}, unreachable: false };
    const first = await inTime(submitOnce(port, requestId, change));
    if (first === 'late') return { ok: false, waiting: true, body: {}, unreachable: false };
    let r = first;
    for (;;) {
      if (r.status === 403) return { ok: false, notOwner: true };
      const data = r.body ?? {};
      if (data.state === 'committed') return { ok: true, body: data };
      if (FINAL_FAIL.includes(String(data.state))) return { ok: false, refused: String(data.reason ?? data.state) };
      if (r.status >= 400 && r.status !== 409 && data.requestState === 'not-recorded') return { ok: false, refused: String(data.code ?? 'refused') };
      if (r.status === 409 && typeof data.code === 'string' && data.code !== 'subject-change-pending') return { ok: false, refused: data.code };
      if (r.status === 400) return { ok: false, refused: String(data.code ?? 'invalid-change') };
      const unreachable = noAnswer(r.status);
      if (now() + pollMs > deadline) return { ok: false, waiting: true, body: data, unreachable };
      await sleep(pollMs);
      const next = await inTime(port.status(requestId));
      if (next === 'late') return { ok: false, waiting: true, body: data, unreachable };
      r = next;
    }
  };
  const stop = (r: Exclude<ChangeResult, { ok: true }>): SuggestionAcceptOutcome =>
    'notOwner' in r ? { kind: 'not-owner' } : 'waiting' in r ? working({ body: r.body, unreachable: r.unreachable }) : refused(r.refused);
  const node = (ref: NodeRef) => readNode(port.node(ref));
  /** An answer the pipeline should never give: reported, and after 3 the owner gets the decision back. */
  const unexpected = (p: SuggestionAcceptProgress, what: string, unreachable = false): SuggestionAcceptOutcome => {
    p.unexpected = (p.unexpected ?? 0) + 1; service.saveAcceptProgress(id, p);
    if (p.unexpected < 3) return working({ unreachable });
    DegradationReporter.getInstance().report({ feature: 'Conversations.suggestionAccept', primary: 'Group the suggested conversations in one step',
      fallback: 'Give the decision back to the owner', reason: `accept-unexpected-answer: ${what}`, impact: 'The owner is asked to check their groups and Accept again or Reject', internalOnly: true });
    service.dropAccept(id);
    return { kind: 'refused', step, code: 'unexpected-answer', text: 'Something unexpected came back while making the group. Open your groups to check, then Accept again or Reject (a group already made stays in your groups).' };
  };
  /** The group was removed (or hidden) before the Accept finished: final, and the suggestion is closed. */
  const groupGone = async (p: SuggestionAcceptProgress): Promise<SuggestionAcceptOutcome> => {
    // A missing group read is a symbol, not proof: the read may lag, or be partial. Only the pipeline's own record
    // of the create saying `erased` (the owner erased the group) closes the suggestion.
    const st = await inTime(port.status(p.createRequestId));
    if (st !== 'late' && st.status === 403) return { kind: 'not-owner' };
    if (st !== 'late' && String(st.body?.state) === 'erased') {
      service.closeAccept(id);
      return { kind: 'refused', step, code: 'group-gone', text: 'The group for this suggestion was removed, so this suggestion is closed. Nothing else was changed.' };
    }
    // Otherwise wait; after at least 3 misses spanning 30 s, hand the decision to the owner, closing nothing.
    p.missedReads = (p.missedReads ?? 0) + 1;
    p.firstMissAt = p.firstMissAt ?? new Date(now()).toISOString();
    service.saveAcceptProgress(id, p);
    if (p.missedReads < 3 || now() - Date.parse(p.firstMissAt) < 30_000) return working();
    service.dropAccept(id);
    return { kind: 'refused', step, code: 'group-not-found', text: 'The group cannot be found on this machine right now. Tap Accept again later, or Reject to drop this suggestion (a group already made stays in your groups).' };
  };

  try {
    // 0. A project whose own conversation is already inside something: create nothing.
    if (s.frontDoor && !found.started) {
      say('checking', 'Checking where its conversation is…');
      const front = node(s.frontDoor);
      if (front === 'not-owner') return { kind: 'not-owner' };
      if (front === 'unavailable') return working({ unreachable: true });
      if (front && front.path.length) {
        // Inside something: is it the group THIS suggestion's Accept made (another machine got that far)? The
        // derived create request answers; only a different parent means it was placed elsewhere.
        const parent = front.path[front.path.length - 1];
        const created = await inTime(port.status(acceptRequestId(id, 'create')));
        if (created === 'late') return working();
        if (created.status === 403) return { kind: 'not-owner' };
        if (noAnswer(created.status)) return working({ unreachable: true });
        const state = String(created.body?.state ?? '');
        const made = created.status === 200 && state === 'committed' ? validateNodeRef(created.body.effort) : null;
        // Only a certain answer closes it as placed elsewhere: the create never happened (404 not recorded), or it
        // made a different group. Anything still pending or unclear is a wait.
        const neverCreated = created.status === 404;
        const elsewhere = neverCreated || (made !== null && nodeKey(made) !== nodeKey(parent));
        if (!elsewhere && !(made && nodeKey(made) === nodeKey(parent))) return working();
        if (elsewhere) {
          const result = { group: null, moved: 0, skipped: s.members.length, placedElsewhere: true };
          service.accepted(id, result);
          return { kind: 'accepted', ...result };
        }
      }
    }
    const started = service.beginAccept(id);
    if (!started) return { kind: 'unknown' };
    const p: SuggestionAcceptProgress = service.acceptProgress(id) ?? { createRequestId: started.createRequestId, startedAt: new Date(now()).toISOString() };
    if (outOfTime()) return working();
    progressRef = p;
    // The brake counts time while calls keep arriving: after an absence longer than a minute (the owner came back
    // and tapped Continue), the clock starts again instead of counting the time away.
    const at = new Date(now()).toISOString();
    const away = p.lastCallAt ? now() - Date.parse(p.lastCallAt) > 60_000 : true;
    if (!p.lastProgressAt || away) p.lastProgressAt = at;
    p.lastCallAt = at;
    service.saveAcceptProgress(id, p);
    /** Saves bookkeeping (request ids) without counting it as a finished step. */
    const save = () => { service.saveAcceptProgress(id, p); };
    /** A step finished or was deliberately skipped: the brake clock and the unexpected-answer count start again. */
    const advance = () => { p.lastProgressAt = new Date(now()).toISOString(); p.unexpected = 0; service.saveAcceptProgress(id, p); };
    // 1. The group.
    if (!p.effort) {
      say('creating', 'Creating the group…');
      if (!REQUEST_ID.test(p.createRequestId)) return { kind: 'unknown' };
      const r = await runChange(p.createRequestId, { kind: 'create-effort', projectScope: [] });
      if (!r.ok && 'refused' in r) {
        // The derived create id names a group the owner erased: this suggestion's group is gone.
        if (r.refused === 'erased') { service.closeAccept(id); return { kind: 'refused', step, code: 'group-gone', text: 'The group for this suggestion was removed, so this suggestion is closed. Nothing else was changed.' }; }
        // Nothing was made: Reject works again.
        service.dropAccept(id);
        return refused(r.refused);
      }
      if (!r.ok) return stop(r);
      const effort = validateNodeRef(r.body.effort);
      if (effort?.kind !== 'effort') return unexpected(p, 'create-without-group');
      p.effort = effort; advance();
    }
    const effortRef = p.effort;
    // 2. Its name.
    if (!p.named) {
      say('naming', 'Naming it…');
      if (outOfTime()) return working();
      const effort = node(effortRef);
      if (effort === 'not-owner') return { kind: 'not-owner' };
      if (effort === 'unavailable') return working({ unreachable: true });
      if (!effort) return await groupGone(p);
      if (!p.effortSeen || p.missedReads) { p.effortSeen = true; p.missedReads = 0; delete p.firstMissAt; save(); }
      if (effort.headerVersion === null) return unexpected(p, 'group-without-header');
      // Named already (another tab, the phone, another machine, or before a reload): keep that name.
      if (effort.headerVersion === 0) {
        p.nameId = acceptRequestId(id, 'name', s.title); save();
        const r = await runChange(p.nameId, { kind: 'set-effort-title', effort: effortRef, baseVersion: 0, title: s.title });
        if (!r.ok && 'refused' in r) {
          // Refused can mean someone named it first (a different title elsewhere): a name is a name.
          if (outOfTime()) return working();
          const after = node(effortRef);
          if (after === 'not-owner') return { kind: 'not-owner' };
          if (after === 'unavailable') return working({ unreachable: true });
          // Still unnamed: a name is not worth stranding the group over. Go on; the owner can name it.
          if (!(after && typeof after === 'object' && after.headerVersion !== null && after.headerVersion > 0)) p.nameRefused = true;
        } else if (!r.ok) return stop(r);
      }
      p.named = true; advance();
    }
    // Every call re-checks that the group is still there before moving anything into it.
    if (outOfTime()) return working();
    const groupNow = node(effortRef);
    if (groupNow === 'not-owner') return { kind: 'not-owner' };
    if (groupNow === 'unavailable') return working({ unreachable: true });
    if (!groupNow) return await groupGone(p);
    // A group read again resets the miss count: the 3-misses-over-30-s rule counts misses in a row.
    if (!p.effortSeen || p.missedReads) { p.effortSeen = true; p.missedReads = 0; delete p.firstMissAt; save(); }
    // 3. Each conversation, previewed first.
    p.moved = Array.isArray(p.moved) ? p.moved : [];
    p.skipped = Array.isArray(p.skipped) ? p.skipped : [];
    p.moveIds = p.moveIds && typeof p.moveIds === 'object' ? p.moveIds : {};
    const effortKey = nodeKey(effortRef);
    for (const [i, m] of s.members.entries()) {
      if (p.moved.includes(m.key) || p.skipped.includes(m.key)) continue;
      if (outOfTime()) return working();
      say('moving', `Moving conversation ${i + 1} of ${s.members.length}…`);
      const current = node(m.ref);
      if (current === 'not-owner') return { kind: 'not-owner' };
      if (current === 'unavailable') return working({ unreachable: true });
      if (!current) { p.skipped.push(m.key); advance(); continue; }
      const parent = current.path.length ? current.path[current.path.length - 1] : null;
      if (parent && nodeKey(parent) === effortKey) { p.moved.push(m.key); advance(); continue; }
      // Placed somewhere else since the suggestion was made: the owner's own placement wins.
      if (parent) { p.skipped.push(m.key); advance(); continue; }
      if (current.moveEligible !== true || !current.replacesPlacementEventIds) { p.skipped.push(m.key); advance(); continue; }
      const change = { kind: 'set-primary-placement', subject: m.ref, parent: effortRef, replacesPlacementEventIds: current.replacesPlacementEventIds };
      // The id carries the placement it replaces: the same move from any caller is one request, and a move after
      // the conversation was placed and taken out again is a new one (never a replay conflict).
      const moveId = acceptRequestId(id, 'move', `${m.key}\n${current.replacesPlacementEventIds.join(',')}`);
      if (p.moveIds[m.key] !== moveId) {
        if (outOfTime()) return working();
        const previewed = await inTime(port.preview(change));
        if (previewed === 'late') return working();
        const preview = previewed;
        if (preview.status === 403) return { kind: 'not-owner' };
        if (noAnswer(preview.status)) return working({ unreachable: true });
        if (preview.status !== 200 || preview.body?.eligible !== true) { p.skipped.push(m.key); advance(); continue; }
        p.moveIds[m.key] = moveId; save();
      }
      const r = await runChange(p.moveIds[m.key], change);
      if (!r.ok && 'refused' in r) {
        // Refused can mean another path already put it in this group: re-read before calling it skipped.
        if (outOfTime()) return working();
        const after = node(m.ref);
        if (after === 'not-owner') return { kind: 'not-owner' };
        if (after === 'unavailable') return working({ unreachable: true });
        const afterParent = after && typeof after === 'object' && after.path.length ? after.path[after.path.length - 1] : null;
        if (afterParent && nodeKey(afterParent) === effortKey) p.moved.push(m.key); else p.skipped.push(m.key);
        advance(); continue;
      }
      if (!r.ok) return stop(r);
      p.moved.push(m.key); advance();
    }
    // 4. A project's own conversation becomes the group's front door, once it sits in the group.
    if (s.frontDoor && !p.frontDoorSet) {
      const frontKey = nodeKey(s.frontDoor);
      if (p.moved.includes(frontKey)) {
        say('front-door', 'Making its conversation the front door…');
        if (outOfTime()) return working();
        const effort = node(effortRef);
        if (outOfTime()) return working();
        const conv = node(s.frontDoor);
        if (effort === 'not-owner' || conv === 'not-owner') return { kind: 'not-owner' };
        if (effort === 'unavailable' || conv === 'unavailable') return working({ unreachable: true });
        if (!effort) return await groupGone(p);
        // Its conversation must still sit in the group; a front door the owner chose since is kept (owner wins).
        const convParent = conv && conv.path.length ? conv.path[conv.path.length - 1] : null;
        const stillHere = Boolean(conv && conv.replacesPlacementEventIds && convParent && nodeKey(convParent) === effortKey);
        if (stillHere && effort.frontDoor === null && conv && conv.replacesPlacementEventIds) {
          p.frontDoorId = acceptRequestId(id, 'front-door', `${(effort.replacesFrontDoorEventIds ?? []).join(',')}\n${conv.replacesPlacementEventIds.join(',')}`); save();
          const r = await runChange(p.frontDoorId, { kind: 'set-front-door', effort: effortRef, conversation: s.frontDoor,
            replacesFrontDoorEventIds: effort.replacesFrontDoorEventIds ?? [], observedPlacementEventIds: conv.replacesPlacementEventIds });
          // A refused front door is skipped: the group and its conversations stay, the owner can set it.
          if (!r.ok && !('refused' in r)) return stop(r);
        }
      }
      p.frontDoorSet = true; advance();
    }
    // 5. Done: the suggestion is not offered again.
    say('finishing', 'Finishing…');
    const result = { group: effortRef, moved: p.moved.length, skipped: p.skipped.length, placedElsewhere: false };
    service.accepted(id, result);
    return { kind: 'accepted', ...result };
  } catch (err) {
    // @silent-fallback-ok: not silent: reported here; nothing was refused, so the owner is told to try again and the next call resumes.
    DegradationReporter.getInstance().report({ feature: 'Conversations.suggestionAccept', primary: 'Group the suggested conversations in one step',
      fallback: 'Answer working; the next call resumes', reason: `accept-step-error: ${err instanceof Error ? err.message.slice(0, 200) : 'unknown'}`,
      impact: 'The owner sees the group still being made and taps Continue', internalOnly: true });
    // Bounded like any unexpected answer: the third in a row hands the decision back to the owner.
    try {
      const prog = service.acceptProgress(id);
      if (prog) return unexpected(prog, 'exception', true);
    } catch { /* @silent-fallback-ok: the state file itself failed (already reported above); the owner is told to try again */ }
    return working({ unreachable: true });
  }
}
