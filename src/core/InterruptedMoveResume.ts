/**
 * InterruptedMoveResume — when a conversation moves to another machine and the move
 * closes the session before it finished its step (SessionDrainRunner
 * `drained-interrupted`), the machine the conversation moved TO picks that step back up.
 *
 * Before this, the forced close sent one notice ("ask me to check it") and nothing else:
 * the person's request was silently dropped (2026-11-14, topic 142440: "check in with
 * Luna" was cut off when the Mama PC session moved its conversation to the Studio, and
 * the notice was filed in the quiet feed).
 *
 * Two halves, both with injected I/O:
 *   - SOURCE (`handOffInterruptedMove`): asks the target to take the step. When the target
 *     does not accept (older version, unreachable, never became owner), the source sends
 *     the "may be incomplete, ask me to check it" notice itself.
 *   - TARGET (`InterruptedMoveResumeReceiver`): waits (bounded) until this machine
 *     really owns the conversation at the moved claim's epoch, answers `accepted`, then in
 *     the background gives the conversation's session a short note that its last step was
 *     cut off — injected into a live session, or a fresh session started with the recent
 *     history — and sends ONE notice whose wording matches what happened (picking it back
 *     up, or "may be incomplete" when the restart failed).
 *
 * Authority: the request carries no ownership. The target acts only on its OWN
 * ownership record (owner == self at or past the claim epoch), so a replayed or stale
 * request does nothing. One resume per (conversation, epoch).
 */

import { plainMachineName } from '../messaging/userNotices.js';

// RULE 3: EXEMPT — receives a signed mesh verb from a sibling; it reads no provider output or terminal state.

export interface InterruptedMoveResumeRequest {
  /** The conversation key (a Telegram topic id as a string). */
  sessionKey: string;
  /** The ownership epoch the move's claim lands at; the target acts only at or past it. */
  claimEpoch: number;
  /** The machine the conversation moved FROM, for the note (a nickname, never an id). */
  fromName?: string | null;
  /** The person's message the cut-off step was serving, so the notice lands in the
   *  conversation (message-loss-notice) instead of the quiet feed. */
  inboundMessageId?: string | null;
}

export type InterruptedMoveResumeOutcome =
  | 'accepted'        // owner confirmed here; the resume and its notice run in the background
  | 'duplicate'       // this (conversation, epoch) was already taken here
  | 'not-owner'       // this machine never became the owner at the claim epoch
  | 'emergency-stop'  // the person stopped work; nothing is restarted
  | 'unsupported';    // not a conversation kind this machine can resume

export interface InterruptedMoveResumeAnswer {
  ok: boolean;
  outcome: InterruptedMoveResumeOutcome;
  reason?: string;
}

/** The note the resumed session reads. Plain words; no ids, no timings (Rule 8). */
export function interruptedMoveResumeNote(fromName?: string | null): string {
  return `[system] This conversation just moved to this machine from ${plainMachineName(fromName)}. `
    + `The session there was closed before it finished what it was doing, so the last request may be unfinished. `
    + `Read the recent messages, work out what the person asked for that is not done yet, `
    + `check what was already done so nothing runs twice, then finish it and tell them the result. `
    + `They have been told you are picking it back up, so always reply: if everything was already done, say so in one short line.`;
}

export function parseInterruptedMoveResume(raw: { sessionKey?: unknown; claimEpoch?: unknown; fromName?: unknown; inboundMessageId?: unknown }): InterruptedMoveResumeRequest | null {
  if (typeof raw.sessionKey !== 'string' || raw.sessionKey.length === 0 || raw.sessionKey.length > 200) return null;
  if (typeof raw.claimEpoch !== 'number' || !Number.isSafeInteger(raw.claimEpoch) || raw.claimEpoch < 0) return null;
  const fromName = typeof raw.fromName === 'string' ? raw.fromName.slice(0, 80) : null;
  const inboundMessageId = typeof raw.inboundMessageId === 'string' && /^[0-9A-Za-z:_-]{1,80}$/.test(raw.inboundMessageId) ? raw.inboundMessageId : null;
  return { sessionKey: raw.sessionKey, claimEpoch: raw.claimEpoch, fromName, inboundMessageId };
}

// ── TARGET side ──────────────────────────────────────────────────────────

export interface InterruptedMoveResumeReceiverDeps {
  selfMachineId: string;
  /** This machine's ownership record for the key (replicated placements). */
  readOwnership: (sessionKey: string) => { ownerMachineId: string; ownershipEpoch: number; status: string } | null;
  emergencyStopActive: () => boolean;
  /** Resume one Telegram topic: inject into its live session, else start one. */
  resumeTopic: (topicId: number, note: string) => Promise<'injected' | 'spawned'>;
  /** ONE notice into the conversation; `resuming` picks the wording. */
  sendNotice: (topicId: number, resuming: boolean, inboundMessageId: string | null) => Promise<unknown>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** How long to wait for the claim to replicate here (it is nudged; usually about a second).
   *  Kept under the mesh request limit so the answer always gets back. */
  ownershipWaitMs?: number;
  pollMs?: number;
  log?: (line: string) => void;
}

export const RESUME_OWNERSHIP_WAIT_MS = 20_000;
export const RESUME_POLL_MS = 500;
const MAX_REMEMBERED = 500;

export class InterruptedMoveResumeReceiver {
  private readonly seen = new Map<string, number>();
  private readonly inFlight = new Map<string, Promise<InterruptedMoveResumeAnswer>>();
  /** The background resume of the last accepted request (tests await it). */
  lastResume: Promise<void> | null = null;

  constructor(private readonly d: InterruptedMoveResumeReceiverDeps) {}

  receive(req: InterruptedMoveResumeRequest): Promise<InterruptedMoveResumeAnswer> {
    const key = `${req.sessionKey}@${req.claimEpoch}`;
    if (this.seen.has(key)) return Promise.resolve({ ok: true, outcome: 'duplicate' });
    const running = this.inFlight.get(key);
    if (running) return running.then((a) => (a.ok ? { ok: true, outcome: 'duplicate' } : a));
    const p = this.run(req, key).finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, p);
    return p;
  }

  private async run(req: InterruptedMoveResumeRequest, key: string): Promise<InterruptedMoveResumeAnswer> {
    const d = this.d;
    if (!/^\d+$/.test(req.sessionKey)) return { ok: false, outcome: 'unsupported', reason: 'not-a-telegram-topic' };
    const topicId = Number(req.sessionKey);
    if (!Number.isSafeInteger(topicId)) return { ok: false, outcome: 'unsupported', reason: 'not-a-telegram-topic' };

    const waitMs = d.ownershipWaitMs ?? RESUME_OWNERSHIP_WAIT_MS;
    const pollMs = d.pollMs ?? RESUME_POLL_MS;
    const startedAt = d.now();
    for (;;) {
      const rec = d.readOwnership(req.sessionKey);
      if (rec && rec.status === 'active' && rec.ownerMachineId === d.selfMachineId && rec.ownershipEpoch >= req.claimEpoch) break;
      // Moved on past this claim to another machine: the request is stale.
      if (rec && rec.status === 'active' && rec.ownerMachineId !== d.selfMachineId && rec.ownershipEpoch >= req.claimEpoch) {
        return { ok: false, outcome: 'not-owner', reason: 'moved-on' };
      }
      if (d.now() - startedAt >= waitMs) return { ok: false, outcome: 'not-owner', reason: 'claim-not-seen' };
      await d.sleep(pollMs);
    }
    if (d.emergencyStopActive()) return { ok: false, outcome: 'emergency-stop' };

    this.remember(key);
    this.lastResume = this.resumeInBackground(topicId, req);
    return { ok: true, outcome: 'accepted' };
  }

  /** Never rejects. Exactly one notice, after the outcome is known. */
  private async resumeInBackground(topicId: number, req: InterruptedMoveResumeRequest): Promise<void> {
    const d = this.d;
    let resuming = false;
    try {
      const how = await d.resumeTopic(topicId, interruptedMoveResumeNote(req.fromName));
      resuming = true;
      d.log?.(`[interrupted-move-resume] topic ${topicId} resumed (${how})`);
    } catch (err) {
      d.log?.(`[interrupted-move-resume] topic ${topicId} resume failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    try {
      await d.sendNotice(topicId, resuming, req.inboundMessageId ?? null);
    } catch (err) {
      d.log?.(`[interrupted-move-resume] topic ${topicId} notice failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private remember(key: string): void {
    this.seen.set(key, this.d.now());
    while (this.seen.size > MAX_REMEMBERED) this.seen.delete(this.seen.keys().next().value!);
  }
}

// ── SOURCE side ──────────────────────────────────────────────────────────

export interface InterruptedMoveHandoffDeps {
  /** Ask the target to take the step. Resolves to its answer, or a failure shape; may reject. */
  requestResume: () => Promise<{ ok: boolean; result?: unknown; reason?: string }>;
  /** The "may be incomplete, ask me to check it" notice, sent only when the target did not take it. */
  sendIncompleteNotice: () => Promise<unknown>;
  log?: (line: string) => void;
}

/** True only when the target accepted the step (it then owns the notice too). */
export function resumeAccepted(res: { ok: boolean; result?: unknown } | null | undefined): boolean {
  if (!res || res.ok !== true) return false;
  const r = res.result as { ok?: unknown; outcome?: unknown } | undefined;
  return r?.ok === true && (r.outcome === 'accepted' || r.outcome === 'duplicate');
}

/** Never throws. Exactly one of the two machines sends the notice. */
export async function handOffInterruptedMove(d: InterruptedMoveHandoffDeps): Promise<{ accepted: boolean }> {
  let accepted = false;
  try {
    const res = await d.requestResume();
    accepted = resumeAccepted(res);
    if (!accepted) {
      const r = res?.result as { outcome?: unknown; reason?: unknown } | undefined;
      d.log?.(`[interrupted-move-resume] target did not take the step: ${String(r?.outcome ?? res?.reason ?? 'no-answer')}${r?.reason ? ` (${String(r.reason)})` : ''}`);
    }
  } catch (err) {
    d.log?.(`[interrupted-move-resume] resume request failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (accepted) return { accepted };
  try {
    await d.sendIncompleteNotice();
  } catch (err) {
    d.log?.(`[interrupted-move-resume] notice failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { accepted };
}
