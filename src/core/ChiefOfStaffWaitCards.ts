/**
 * ChiefOfStaffWaitCards — the Chief of Staff's own Work Board cards (docs/specs/work-board-cards-appear.md §1).
 *
 * One card per tracked project, with a fixed id. When the Chief of Staff records that a project waits on the
 * owner, the card is opened (or reopened by a server-owned rewrite); when a later Chief of Staff record clears
 * the wait (a newer verdict that is neither waiting nor unknown, the owner's pause, the binding's close), the card
 * is closed on the agent's own evidence, citing that record. Nothing here reads or writes a binding: a card never
 * advances, finishes or pauses a project.
 *
 * Runs inside the Chief of Staff tick (lease holder only), never on the grace tick after a holder change.
 *
 * Fencing (§1): a card carries `mirror` — the Chief of Staff record it last reflected and that record's HLC. Sync
 * acts on a card only when the project's newest Chief of Staff record has a NEWER HLC than `mirror`, so a holder
 * whose Chief of Staff data is behind the card writes nothing, and person taps (which never touch `mirror`) never
 * delay a close. A close is keyed by the record it rests on, so a retried or raced close is one record.
 *
 * Signal vs. Authority: the card mirrors the Chief of Staff's recorded verdict (itself the authority's output);
 * only a person's tap approves anything on the board, and a card done here is labelled as the agent's own evidence.
 */

import { workCardPlainLanguageIssue } from './WorkCardPlainLanguage.js';
import { createHash } from 'node:crypto';
import type { HlcTimestamp } from './HybridLogicalClock.js';
import { compareHlc, sameValue } from './WorkCardStore.js';
import { foldBindingState, type BindingState, type ProjectCheckState, type UnionEntry, type CosVerdict } from './ChiefOfStaffStore.js';
import type { WorkBoardService, WorkPrincipal } from './WorkBoardService.js';
import type { BriefCheckStatus, CardBrief } from './WorkCardStore.js';

export const WAIT_CARD_ITEM = 'wait-cleared';
/** The server's own writer: no route can build this principal. */
const SERVER: WorkPrincipal = { kind: 'agent', server: true };
/** The Chief of Staff store keeps at most this much of a check note (buildCheckEvent's slice). */
const STORED_NOTE_MAX = 500;
const CARRY_FORWARD_NOTE = 'no new evidence';

export function waitCardId(conversationKey: string): string {
  return 'wc_' + createHash('sha256').update(`cos-wait:${conversationKey}`).digest('hex').slice(0, 16);
}

export function waitCoverKey(conversationKey: string): string { return `cos:waiting:${conversationKey}`; }

export interface WaitCardProject {
  conversationKey: string;
  title: string;
  goal: string;
  doneDefinition: Array<{ id: string; kind: string; text: string }>;
}

export interface WaitCardsDeps {
  enabled: () => boolean;
  board: () => WorkBoardService | null;
  /** Create the card's conversation (idempotent; the key is derived from the card id). */
  ensureConversation?: (cardId: string) => void;
  log?: (event: string, detail: Record<string, unknown>) => void;
}

export interface WaitCardsSyncInput {
  union: UnionEntry[];
  /** Bound, confirmed, not-closed projects (boundProjects); closed bindings are read from the union. */
  projects: WaitCardProject[];
  states: Map<string, ProjectCheckState>;
}

export interface WaitCardsSyncResult { opened: string[]; edited: string[]; reopened: string[]; closed: string[]; skipped: Array<{ cardId: string; reason: string }> }

interface SourceRec { ref: string; hlc: HlcTimestamp; kind: 'check' | 'lifecycle'; at: string; verdict?: CosVerdict; event?: string; by?: string; bindingHlc?: HlcTimestamp; note?: string; askId?: string; complete?: boolean; effective?: boolean }

/**
 * Every Chief of Staff record per project that can open or clear a wait, oldest first by HLC, from one pass over
 * the union. One record per key (a re-emit keeps the newest), as every fold does.
 */
function sourcesByProject(union: UnionEntry[]): Map<string, SourceRec[]> {
  const byRef = new Map<string, SourceRec & { ck: string }>();
  for (const e of union) {
    const d = e.data;
    if (typeof d.conversationKey !== 'string' || typeof d.recordKey !== 'string' || !isHlc(d.hlc)) continue;
    let rec: (SourceRec & { ck: string }) | null = null;
    if (d.recordType === 'check-event') rec = { ck: d.conversationKey, ref: d.recordKey, hlc: d.hlc, kind: 'check', at: String(d.at ?? ''), verdict: d.verdict as CosVerdict, note: typeof d.note === 'string' ? d.note : undefined };
    else if (d.recordType === 'binding-lifecycle') rec = { ck: d.conversationKey, ref: d.recordKey, hlc: d.hlc, kind: 'lifecycle', at: String(d.at ?? ''), event: String(d.event ?? ''), by: String(d.by ?? ''), ...(isHlc(d.bindingHlc) ? { bindingHlc: d.bindingHlc } : {}),
      ...(typeof d.askId === 'string' ? { askId: d.askId } : {}), complete: typeof d.who === 'string' && typeof d.quote === 'string' && typeof d.messageRef === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(String(d.at ?? '')) };
    if (!rec) continue;
    const cur = byRef.get(rec.ref);
    if (!cur || compareHlc(rec.hlc, cur.hlc) > 0) byRef.set(rec.ref, rec);
  }
  const out = new Map<string, SourceRec[]>();
  for (const r of byRef.values()) (out.get(r.ck) ?? out.set(r.ck, []).get(r.ck)!).push(r);
  for (const list of out.values()) {
    list.sort((a, b) => compareHlc(a.hlc, b.hlc));
    // An owner pause or resume takes effect as foldBindingState decides: an owner tap, one decision per ask
    // (a redelivered callback is ignored), and a pause only with its who / when / quote / message.
    const seenAsks = new Set<string>();
    for (const r of list) {
      if (r.kind !== 'lifecycle' || (r.event !== 'owner-pause' && r.event !== 'owner-resume')) continue;
      if (r.by !== 'owner-tap' || !r.askId || seenAsks.has(r.askId)) { r.effective = false; continue; }
      seenAsks.add(r.askId);
      r.effective = r.event === 'owner-resume' || r.complete === true;
    }
  }
  return out;
}

function isHlc(v: unknown): v is HlcTimestamp {
  const h = v as Record<string, unknown> | null;
  return !!h && typeof h === 'object' && Number.isFinite(h.physical) && Number.isInteger(h.logical) && typeof h.node === 'string';
}

/**
 * A clearing record, read as foldBindingState reads it: a check verdict that is neither waiting nor unknown; an
 * owner pause written by the owner's own tap; a close of the CURRENT binding (an older binding's close does not count).
 */
function clears(s: SourceRec, bindingHlc: HlcTimestamp | null): boolean {
  if (s.kind === 'check') return !!s.verdict && s.verdict !== 'waiting-on-user' && s.verdict !== 'unknown';
  if (s.event === 'owner-pause') return s.effective === true;
  if (s.event === 'closed') return !!bindingHlc && !!s.bindingHlc && compareHlc(s.bindingHlc, bindingHlc) === 0;
  return false;
}

const VERDICT_WORDS: Record<string, string> = {
  moving: 'moving', stalled: 'stalled', drifting: 'drifting', 'claims-done': 'says it is done', 'done-verified': 'finished and verified',
};

/**
 * Where the current wait started: the first `waiting-on-user` check after the newest record that ended the last
 * one (a clearing record, or an owner resume). Its note: the newest real note among the waiting checks since.
 */
function waitStart(sources: SourceRec[], bindingHlc: HlcTimestamp | null, after: HlcTimestamp | null = null): { rec: SourceRec; note: string | null } | null {
  let from = 0;
  for (let i = sources.length - 1; i >= 0; i--) {
    const s = sources[i];
    // A boundary: a clearing record, an owner resume, an owner unpark, or (after a close) the record the card was closed at.
    const boundary = clears(s, bindingHlc) || (s.event === 'owner-resume' && s.effective) || (s.event === 'unpark' && s.by === 'owner-tap') || (after !== null && compareHlc(s.hlc, after) <= 0);
    if (boundary) { from = i + 1; break; }
  }
  const waiting = sources.slice(from).filter((s) => s.kind === 'check' && s.verdict === 'waiting-on-user');
  if (!waiting.length) return null;
  const real = [...waiting].reverse().find((s) => s.note && s.note !== CARRY_FORWARD_NOTE);
  return { rec: waiting[0], note: real?.note ?? null };
}

/** The evidence a close rests on, in words, from the clearing record itself (so a retry writes the same text). */
function clearingText(kind: 'closed' | 'paused' | 'parked' | 'verdict', rec: SourceRec): string {
  const day = rec.at.slice(0, 10) || 'a recorded date';
  if (kind === 'closed') return `The project was closed on ${day}.`;
  if (kind === 'paused') return `You paused this project on ${day}.`;
  if (kind === 'parked') return 'The Chief of Staff parked this project; its own line in Needs you asks you to unpark it.';
  return `The Chief of Staff's check at ${minuteUtc(rec.at)} no longer marks it waiting on you (it reads ${VERDICT_WORDS[String(rec.verdict)] ?? String(rec.verdict)}).`;
}

/**
 * Plain text with no Markdown escapes, safe to show as typed. Whitespace collapses; the few sequences that would make
 * a Markdown renderer show a link, an image or an HTML tag are broken with a space (`](` and `![`) or a look-alike
 * angle bracket before a tag, so a note that quotes a link reads as text without any backslash showing.
 */
export function inertText(text: string): string {
  return String(text ?? '').replace(/\s+/g, ' ').trim()
    .replace(/!\[/g, '! [')
    .replace(/\]\(/g, '] (')
    .replace(/<(?=[A-Za-z/!?])/g, '\u2039');
}

/** The close evidence keeps its original wording: a retried close under the same record key writes the same text. */
function minuteUtc(iso: string): string {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? `${new Date(t).toISOString().slice(0, 16).replace('T', ' ')} UTC` : iso;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * A time as a person reads it ("Nov 17, 2026, 10:15 PM UTC"). Always UTC and named so: every machine that holds the
 * lease writes the same words (a card's text is material; a machine-local zone would make holders rewrite each other).
 * Clients format `brief.waitingSince` in the reader's own zone.
 */
export function humanTimeUtc(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'a recorded time';
  const d = new Date(t);
  const h = d.getUTCHours();
  const mm = String(d.getUTCMinutes()).padStart(2, '0');
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}, ${h % 12 === 0 ? 12 : h % 12}:${mm} ${h < 12 ? 'AM' : 'PM'} UTC`;
}

/** A short id of the Chief of Staff record that started a wait (logs and internal metadata only; never card text). */
export function waitIdOf(ref: string): string { return createHash('sha256').update(ref).digest('hex').slice(0, 8); }

export type WaitKind = 'answer' | 'confirm';
export type WaitCardBrief = CardBrief;

const ASK_MAX = 300;
const BRIEF_ITEMS_MAX = 30;
const BRIEF_GOAL_MAX = 2000;

/**
 * The one sentence a wait card asks of the owner. When the Chief of Staff's own note names a decision for the owner
 * ("waiting for the owner to choose whether to …", "needs your decision on …"), that clause becomes the ask; otherwise
 * a fixed sentence for the kind of wait. Display only: nothing decides on it.
 */
export function waitAsk(kind: WaitKind, note: string | null): string {
  if (kind === 'confirm') return 'Confirm this project is done.';
  const text = note ? inertText(note) : '';
  const sentence = (verb: string, rest: string) => {
    const body = `${verb.charAt(0).toUpperCase()}${verb.slice(1).toLowerCase()} ${rest.trim().replace(/[,;:\s]+$/, '')}`;
    return body.length + 1 <= ASK_MAX ? `${body}.` : null;
  };
  if (text) {
    const who = '(?:the owner|the operator|the user|the person|you)';
    const direct = new RegExp(`\\b${who}\\s+(?:to\\s+)?(choose|decide|pick|select|approve|confirm)\\b\\s+([^.?!]{3,})`, 'i').exec(text);
    if (direct) { const s = sentence(direct[1], direct[2]); if (s) return s; }
    const decision = new RegExp(`\\b(?:${who}'s|your)\\s+(?:choice|decision|answer)\\s+((?:on|about|of|whether|between)\\b[^.?!]{3,})`, 'i').exec(text);
    if (decision) { const s = sentence('decide', decision[1]); if (s) return s; }
  }
  return 'Answer what the project needs next.';
}

/** The card's text, a pure function of the wait (no clock time beyond the wait's own start). */
export function composeWaitCard(p: WaitCardProject, kind: WaitKind, doneItems: Record<string, 'pass' | 'fail' | 'unknown'> | null, note: string | null, waitSince: string, _waitRef: string, limits: { need: number; title: number } = { need: 4000, title: 300 }, opts: { again?: boolean } = {}): { title: string; need: string; recommendation: string; whyYou: string; brief: WaitCardBrief } {
  const titleName = workCardPlainLanguageIssue({ title: p.title }) ? 'This project' : p.title;
  const fullTitle = kind === 'confirm' ? `${titleName} looks done and needs your OK` : `${titleName} is waiting on you`;
  const title = fullTitle.length <= limits.title ? fullTitle : (kind === 'confirm' ? 'A project looks done and needs your OK' : 'A project is waiting on you').slice(0, limits.title);
  const status = (d: { id: string; kind: string }): BriefCheckStatus => {
    if (d.kind === 'judgment') return 'needs-you';
    const v = doneItems?.[d.id];
    return v === 'pass' ? 'passes' : v === 'fail' ? 'fails' : 'unknown';
  };
  const STATUS_WORDS: Record<BriefCheckStatus, string> = { passes: 'passes', fails: 'fails', unknown: 'not checked yet', 'needs-you': 'needs your judgment' };
  const items = p.doneDefinition.filter((d) => d && d.id && d.text);
  const ITEM_MAX = 200;
  const itemText = (d: { text: string }) => { const text = String(d.text);
    const raw = inertText(workCardPlainLanguageIssue({ need: text }) ? 'See the project conversation for this completion check.' : text); return raw.length > ITEM_MAX ? `${raw.slice(0, ITEM_MAX - 1)}…` : raw; };
  const itemLine = (d: { id: string; kind: string; text: string }) => `- ${itemText(d)} (${STATUS_WORDS[status(d)]})`;
  const goal = p.goal.trim() ? inertText(workCardPlainLanguageIssue({ need: p.goal }) ? 'See the project conversation for its goal.' : p.goal) : '';
  const noteNeedsRewrite = note && workCardPlainLanguageIssue({ need: note });
  const said = note && note.trim() && !noteNeedsRewrite ? inertText(note) : '';
  const lines: string[] = [];
  lines.push(kind === 'confirm'
    ? 'Every automatic check of this project passes. The items below that need your judgment are yours to check.'
    : 'The Chief of Staff marks this project waiting on you.');
  if (goal) lines.push(`Goal: ${goal}`);
  const checklistAt = lines.length;
  if (items.length) lines.push(['Done when:', ...items.map(itemLine)].join('\n'));
  if (said) {
    const cut = note!.length >= STORED_NOTE_MAX;
    lines.push(`The Chief of Staff's check said: "${said}"${cut ? ' (shortened; the project conversation has the rest)' : ''}`);
  }
  if (noteNeedsRewrite) lines.push('Open the project conversation to read the request and reply there.');
  lines.push(`Waiting on you${opts.again ? ' again' : ''} since ${humanTimeUtc(waitSince)}.`);
  // Within the owner-set need limit (work-board-asks, Fixed limits; a write over it is refused, never cut): drop
  // checklist items from the end, saying how many and where the whole list is, then shorten the goal.
  const fits = () => lines.join('\n\n').length <= limits.need;
  if (!fits() && items.length) {
    for (let keep = items.length - 1; keep >= 0 && !fits(); keep--) {
      lines[checklistAt] = ['Done when:', ...items.slice(0, keep).map(itemLine), `- and ${items.length - keep} more item${items.length - keep === 1 ? '' : 's'} on the project's own page`].join('\n');
    }
  }
  if (!fits() && goal) lines[1] = 'Goal: see the project conversation.';
  if (!fits()) { const i = lines.findIndex((l) => l.startsWith('The Chief of Staff\'s check said')); if (i >= 0) lines[i] = 'The Chief of Staff\'s check left a note too long to show here; the project conversation has it.'; }
  const recommendation = kind === 'confirm'
    ? 'Check the items that need your judgment. If they hold, use Confirm done on the Chief of Staff; if something is missing, say what in the project\'s conversation.'
    : 'Reply in the project\'s conversation with your decision on what the check names; its next check picks it up.';
  const whyYou = kind === 'confirm'
    ? 'Finishing a project you judge is your sign-off. The Chief of Staff checks the automatic items but never closes such a project itself.'
    : 'The Chief of Staff marks a project waiting on you only when its next step needs your answer. It does not decide for you.';
  const since = Date.parse(waitSince);
  const brief: WaitCardBrief = {
    ask: noteNeedsRewrite ? (kind === 'confirm' ? 'Review the completion checks in the project conversation.' : 'Read the decision in the project conversation and reply there.') : waitAsk(kind, note),
    ...(goal ? { goal: goal.length > BRIEF_GOAL_MAX ? `${goal.slice(0, BRIEF_GOAL_MAX - 1)}…` : goal } : {}),
    ...(items.length ? { checks: items.slice(0, BRIEF_ITEMS_MAX).map((d) => ({ text: itemText(d), status: status(d) })) } : {}),
    ...(said ? { chiefSaid: said } : {}),
    ...(Number.isFinite(since) ? { waitingSince: new Date(since).toISOString() } : {}),
  };
  return { title, need: lines.join('\n\n'), recommendation, whyYou, brief };
}

function sameBrief(a: CardBrief | null | undefined, b: CardBrief): boolean { return sameValue(a ?? null, b); }

export class ChiefOfStaffWaitCards {
  /** Refusals already logged, so a standing refusal is one log line per project and reason (machine-local, logging only). */
  private logged = new Set<string>();
  /** The Chief of Staff record a create was refused at, per project (machine-local brake: retried on a newer record only). */
  private refusedAt = new Map<string, string>();

  constructor(private readonly d: WaitCardsDeps) {}

  private once(key: string, event: string, detail: Record<string, unknown>): void {
    if (this.logged.has(key)) return;
    this.logged.add(key);
    if (this.logged.size > 2000) this.logged.delete(this.logged.values().next().value as string);
    this.d.log?.(event, detail);
  }

  sync(input: WaitCardsSyncInput): WaitCardsSyncResult {
    const out: WaitCardsSyncResult = { opened: [], edited: [], reopened: [], closed: [], skipped: [] };
    if (!this.d.enabled()) return out;
    const svc = this.d.board();
    if (!svc) return out;
    const bindings = foldBindingState(input.union);
    const sources = sourcesByProject(input.union);
    const byKey = new Map(input.projects.map((p) => [p.conversationKey, p]));
    for (const [ck, bs] of bindings) {
      if (!bs.confirmed || !bs.binding) continue;
      try { this.syncOne(svc, ck, bs, byKey.get(ck) ?? null, sources.get(ck) ?? [], input, out); }
      catch (err) { /* @silent-fallback-ok: one project's failure is logged and retried next tick; it never stops the others or the tick */
        this.once(`${ck}:threw`, 'cos-wait-card-failed', { conversationKey: ck, error: (err as Error)?.message });
      }
    }
    return out;
  }

  private syncOne(svc: WorkBoardService, ck: string, bs: BindingState, project: WaitCardProject | null, sources: SourceRec[], input: WaitCardsSyncInput, out: WaitCardsSyncResult): void {
    const cardId = waitCardId(ck);
    const newest = sources[sources.length - 1];
    if (!newest) return; // nothing recorded yet: nothing to mirror
    const st = input.states.get(ck) ?? null;
    // What the newest record says. `unknown`, or a project this read cannot see, changes nothing (absence is not evidence).
    let wait: { kind: WaitKind } | null = null;
    let clearing: 'closed' | 'paused' | 'parked' | 'verdict' | null = null;
    if (bs.closed) clearing = 'closed';
    else if (bs.pausedBy) clearing = 'paused';
    else if (!project || !st || !st.lastVerdict || st.lastVerdict === 'unknown') return;
    else if (st.parked || st.breakerTripped) clearing = 'parked';
    else if (st.lastVerdict === 'waiting-on-user') {
      const det = project.doneDefinition.filter((i) => i.kind === 'deterministic');
      const allPass = det.length === 0 || (st.lastDoneItems !== null && det.every((i) => st.lastDoneItems![i.id] === 'pass'));
      wait = { kind: allPass && project.doneDefinition.some((i) => i.kind === 'judgment') ? 'confirm' : 'answer' };
    } else clearing = 'verdict';

    const v = svc.view(cardId);
    const exists = svc.recordsOf(cardId).length > 0;
    const card = v?.card;
    // Its conversation, every sync (idempotent, an existence check): a crash between the create and this step heals here, not only at boot.
    if (card?.created && !card.redacted) { try { this.d.ensureConversation?.(cardId); } catch { /* @silent-fallback-ok: retried next sync and at boot */ } }
    // Fence: act only on a Chief of Staff record newer than the one the card last reflected. One repair passes it:
    // a card closed on a clearing record (cleared mirror) that reads open with no claim (a competing `created` with
    // other material voided its claim) is closed again; after an owner's reopen that waits for a newer clearing record.
    const repair = !!card?.created && card.mirror?.cleared === true && !card.done && !card.currentClaim && !!clearing;
    if (card?.created && card.mirror && compareHlc(newest.hlc, card.mirror.hlc) <= 0 && !repair) return;
    if (card && (card.redacted || card.archives.length || card.holds.length)) return; // a person's word wins

    if (wait && project) {
      // The record that started this wait (not merely the newest record) and the newest real note since.
      // After a close the new wait starts after the record the card was closed at (a park leaves no record of its own).
      const start = waitStart(sources, bs.bindingHlc, card?.mirror?.cleared ? card.mirror.hlc : null) ?? { rec: newest, note: null };
      const realNote = start.note;
      const mirrorOf = { ref: newest.ref, hlc: newest.hlc };
      if (!exists) {
        if (this.refusedAt.get(ck) === newest.ref) { out.skipped.push({ cardId, reason: 'waiting-for-a-newer-record' }); return; }
        if (svc.atSoftBudget()) {
          this.refusedAt.set(ck, newest.ref); this.once(`${ck}:soft-budget`, 'cos-wait-card-not-opened', { conversationKey: ck, reason: 'soft-open-cards' }); out.skipped.push({ cardId, reason: 'soft-open-cards' }); return; }
        const since = start.rec.at || newest.at;
        const text = composeWaitCard(project, wait.kind, st?.lastDoneItems ?? null, realNote, since, start.rec.ref, svc.limits());
        const r = svc.createCard(SERVER, {
          ...text, doneWhen: [{ id: WAIT_CARD_ITEM, text: 'The Chief of Staff no longer marks this project waiting on you.', certify: 'agent-may-certify' }],
          carrier: 'owner', outward: false, links: [], projectKey: ck, covers: [waitCoverKey(ck)],
          mirror: { ...mirrorOf, waitSince: since, waitRef: start.rec.ref, ...(realNote ? { note: realNote } : {}) },
        }, { cardId, counted: true });
        if (!r.ok) {
          // Brake: a capacity refusal (the daily ceiling) is tried again only once a newer Chief of Staff record arrives
          // (its check cadence), never every tick. Other refusals (no owner wired yet, the store briefly unavailable) retry next tick.
          if (r.error === 'daily-card-ceiling') this.refusedAt.set(ck, newest.ref);
          this.once(`${ck}:${r.error}`, 'cos-wait-card-not-opened', { conversationKey: ck, reason: r.error }); out.skipped.push({ cardId, reason: r.error }); return;
        }
        try { this.d.ensureConversation?.(cardId); } catch (err) { /* @silent-fallback-ok: the card exists; its chat is created at the next write or boot (the key is derived) */ this.d.log?.('cos-wait-card-conversation-failed', { cardId, error: (err as Error)?.message }); }
        out.opened.push(cardId);
        return;
      }
      if (!card?.created) return; // records exist but no readable `created` yet (still replicating): wait
      // A new wait episode: the card finished (or waits on a confirm) for an earlier wait, or a clearing record
      // lies between the record the card reflects and now (a wait that cleared and came back between syncs).
      const finished = card.done || !!card.currentClaim;
      const clearedBetween = !!card.mirror && sources.some((s) => clears(s, bs.bindingHlc) && compareHlc(s.hlc, card.mirror!.hlc) > 0);
      // A card the person finished while the project still waits stays finished until a genuinely new wait starts.
      const newEpisode = clearedBetween || !card.mirror || card.mirror.cleared === true || (finished && start.rec.ref !== card.mirror.waitRef);
      if (finished && !newEpisode) {
        // The brief is not material: refreshing it on a finished card voids nothing and reopens nothing. Written only
        // when it differs, so a card carries the brief from the first newer check after an upgrade, then stays quiet.
        const keepText = composeWaitCard(project, wait.kind, st?.lastDoneItems ?? null, card.mirror?.note ?? realNote, card.mirror?.waitSince ?? start.rec.at, card.mirror?.waitRef ?? start.rec.ref, svc.limits());
        if (!sameBrief(card.brief, keepText.brief)) {
          const b = svc.edit(SERVER, cardId, { brief: keepText.brief });
          if (!b.ok) this.once(`${ck}:brief:${b.error}`, 'cos-wait-card-edit-refused', { conversationKey: ck, step: 'brief', reason: b.error });
          else out.edited.push(cardId);
        }
        return;
      }
      const since = newEpisode ? (start.rec.at || newest.at) : (card.mirror?.waitSince ?? start.rec.at);
      const waitRef = newEpisode ? start.rec.ref : (card.mirror?.waitRef ?? start.rec.ref);
      const note = newEpisode ? realNote : (card.mirror?.note ?? realNote);
      let text = composeWaitCard(project, wait.kind, st?.lastDoneItems ?? null, note, since, waitRef, svc.limits());
      // A new wait on a finished card must change its material, so the earlier finish stops counting. The text no
      // longer carries a wait id, so when the new wait reads word for word like the old one, say "again".
      if (newEpisode && finished && text.need === card.need) text = composeWaitCard(project, wait.kind, st?.lastDoneItems ?? null, note, since, waitRef, svc.limits(), { again: !card.need.includes('Waiting on you again since') });
      const changed = text.title !== card.title || text.need !== card.need || text.recommendation !== card.recommendation || text.whyYou !== card.whyYou || !sameBrief(card.brief, text.brief);
      if (!changed && !newEpisode) return;
      const r = svc.edit(SERVER, cardId, { ...text, mirror: { ...mirrorOf, waitSince: since, waitRef, ...(note ? { note } : {}) } }, { serverOwnedRewrite: finished });
      if (!r.ok) { this.once(`${ck}:edit:${r.error}`, 'cos-wait-card-edit-refused', { conversationKey: ck, reason: r.error }); out.skipped.push({ cardId, reason: r.error }); return; }
      (newEpisode && finished ? out.reopened : out.edited).push(cardId);
      return;
    }

    // The wait cleared: close the card once, on the FIRST clearing record after the one the card reflects (and,
    // after an owner's reopen, after that reopen). Evidence and claim keys and the evidence text derive from that
    // record and the card's reopen generation, so a retry after a crash between the writes, or a second holder,
    // writes the same records. `mirror` then moves to the NEWEST record, marked `cleared`, so the fence holds again
    // and a holder that lacks these records cannot read a later waiting check as a new wait.
    if (!clearing || !card?.created) return;
    if (!card.done && !card.currentClaim) {
      const lastReopen = card.taps.filter((t) => t.action === 'reopen').map((t) => t.hlc).sort(compareHlc).pop() ?? null;
      // The close rests on a clearing record after the wait it ends: after `mirror` while the card reflects that
      // wait, or after the wait's own start once the mirror already moved past the close; and after any reopen.
      const startHlc = card.mirror?.cleared ? (sources.find((s) => s.ref === card.mirror!.waitRef)?.hlc ?? card.mirror.hlc) : (card.mirror?.hlc ?? null);
      const after = (h: HlcTimestamp) => (!startHlc || compareHlc(h, startHlc) > 0) && (!lastReopen || compareHlc(h, lastReopen) > 0);
      const clearRec = clearing === 'parked'
        ? (after(newest.hlc) ? newest : null)
        : sources.find((s) => clears(s, bs.bindingHlc) && after(s.hlc)) ?? null;
      if (!clearRec) return; // nothing newer than the reopen yet: the next clearing record closes it
      const tag = createHash('sha256').update(`${clearRec.ref}|${card.reopens.join(',')}`).digest('hex').slice(0, 16);
      const counting = card.evidence.some((e) => e.itemId === WAIT_CARD_ITEM && e.counts);
      if (!counting) {
        const e = svc.addEvidence(SERVER, cardId, { itemId: WAIT_CARD_ITEM, text: clearingText(clearing, clearRec) }, { recordKey: `wc:${cardId}:v:cos-${tag}` });
        if (!e.ok) { this.once(`${ck}:evidence:${e.error}`, 'cos-wait-card-close-refused', { conversationKey: ck, step: 'evidence', reason: e.error }); out.skipped.push({ cardId, reason: e.error }); return; }
      }
      const c = svc.claimDone(SERVER, cardId, { recordKey: `wc:${cardId}:c:cos-${tag}` });
      if (!c.ok) { this.once(`${ck}:claim:${c.error}`, 'cos-wait-card-close-refused', { conversationKey: ck, step: 'claim', reason: c.error }); out.skipped.push({ cardId, reason: c.error }); return; }
      out.closed.push(cardId);
    }
    if (card.mirror?.cleared !== true) {
      // Non-material: it voids nothing, and is allowed on a finished card. Written once per close, never per later check.
      const m = svc.edit(SERVER, cardId, { mirror: { ref: newest.ref, hlc: newest.hlc, cleared: true, ...(card.mirror?.waitSince ? { waitSince: card.mirror.waitSince } : {}), ...(card.mirror?.waitRef ? { waitRef: card.mirror.waitRef } : {}), ...(card.mirror?.note ? { note: card.mirror.note } : {}) } });
      if (!m.ok) this.once(`${ck}:mirror:${m.error}`, 'cos-wait-card-close-refused', { conversationKey: ck, step: 'mirror', reason: m.error });
    }
  }
}
