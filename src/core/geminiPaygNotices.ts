/**
 * GeminiPaygNotices — the ONE voice of the Gemini pay-per-use lane, to the approved
 * "💰 Routing & Spend Alerts" path (docs/specs/gemini-payg-metered-lane.md §5 "Notices",
 * §9, "Self-Heal Before Notify — watcher declaration").
 *
 *   pushed:      100% of the month (once per month; held through quiet hours to 07:30
 *                Pacific — the gate has already stopped spending, so nothing is lost);
 *                the provisional-ceiling trip (a Work Board card carrying a prefilled
 *                plan, held through quiet hours); a conflicting designation (security
 *                class — immediate, never held); invoice drift (after one re-read);
 *                a session lowering a limit or disabling a caller (one per action,
 *                coalesced per hour, with the restore link).
 *   not pushed:  50% and 80% — they show on the Spend tab and the caps answer.
 *
 * Dedupe keys are the spec's. State is persisted, so a restart never re-sends a notice
 * already delivered and never loses one held for quiet hours.
 */

import fs from 'node:fs';
import path from 'node:path';

export type GeminiPaygNoticeKind = 'month-full' | 'provisional-ceiling' | 'designation-conflict' | 'invoice-drift' | 'limit-lowered' | 'lane-notice';

export interface GeminiPaygNotice {
  kind: GeminiPaygNoticeKind;
  dedupeKey: string;
  text: string;
  /** Security / money-critical class: delivered at once, never held, on the durable lane. */
  urgent: boolean;
}

export interface WorkCardRequest {
  title: string;
  need: string;
  recommendation: string;
  whyYou: string;
  doneWhen: Array<{ id: string; text: string }>;
  /** The prefilled plan the card carries (rendered on the holder's Spend tab, committed by PIN). */
  plan: Record<string, unknown>;
  link: string | null;
}

export interface GeminiPaygNoticesDeps {
  stateDir: string;
  /** Deliver one notice; resolves true on a confirmed send. */
  deliver: (n: GeminiPaygNotice) => Promise<boolean>;
  /** Open one Work Board card (the provisional-ceiling trip). Returns false when none could be opened. */
  openCard?: (c: WorkCardRequest) => boolean;
  /** Where the restore / plan view lives (the holder's Spend tab), or null. */
  spendTabLink?: () => string | null;
  now?: () => number;
}

interface NoticeState {
  sent: Record<string, string>;
  held: GeminiPaygNotice[];
  heldCards: WorkCardRequest[];
  lastLowerNoticeAt: number;
  suppressedLowers: number;
}

const HOUR_MS = 60 * 60 * 1000;

/** True inside Pacific quiet hours (23:00–07:30). */
export function inPacificQuietHours(ms: number): boolean {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms));
  const h = Number(parts.find((p) => p.type === 'hour')?.value ?? '0');
  const m = Number(parts.find((p) => p.type === 'minute')?.value ?? '0');
  const mins = h * 60 + m;
  return mins >= 23 * 60 || mins < 7 * 60 + 30;
}

export class GeminiPaygNotices {
  private readonly file: string;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly d: GeminiPaygNoticesDeps) {
    this.file = path.join(d.stateDir, 'state', 'gemini-payg-notices.json');
    this.now = d.now ?? (() => Date.now());
  }

  private load(): NoticeState {
    try {
      const v = JSON.parse(fs.readFileSync(this.file, 'utf-8')) as Partial<NoticeState>;
      return { sent: v.sent ?? {}, held: v.held ?? [], heldCards: v.heldCards ?? [], lastLowerNoticeAt: v.lastLowerNoticeAt ?? 0, suppressedLowers: v.suppressedLowers ?? 0 };
    } catch {
      return { sent: {}, held: [], heldCards: [], lastLowerNoticeAt: 0, suppressedLowers: 0 }; // @silent-fallback-ok — no notice state yet
    }
  }

  private save(s: NoticeState): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(s), { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error(`[instar] gemini-payg notices: state could not be saved: ${String(err)}`);
    }
  }

  private async send(n: GeminiPaygNotice, s: NoticeState): Promise<'sent' | 'held' | 'duplicate' | 'failed'> {
    if (s.sent[n.dedupeKey]) return 'duplicate';
    if (!n.urgent && inPacificQuietHours(this.now())) {
      if (!s.held.some((h) => h.dedupeKey === n.dedupeKey)) s.held.push(n);
      this.save(s);
      return 'held';
    }
    let ok = false;
    try { ok = await this.d.deliver(n); } catch { ok = false; } // @silent-fallback-ok — a failed send stays eligible (not latched)
    if (ok) {
      s.sent[n.dedupeKey] = new Date(this.now()).toISOString();
      this.save(s);
      return 'sent';
    }
    return 'failed';
  }

  /** 100% of the month — once per month (dedupe `spend-cap:<keyRef>:month:100:<monthEpoch>`). */
  async monthFull(keyRef: string, monthEpoch: string, capUsd: number, resetsAt: string | null): Promise<string> {
    const s = this.load();
    return this.send({
      kind: 'month-full',
      dedupeKey: `spend-cap:${keyRef}:month:100:${monthEpoch}`,
      text: `Gemini pay-per-use has reached its $${capUsd.toFixed(2)} limit for ${monthEpoch}, so it has stopped spending. Reviews and second opinions use the other models until ${resetsAt ? `the month resets (${resetsAt})` : 'the month resets'}. Nothing is needed from you unless you want to raise the limit.`,
      urgent: false,
    }, s);
  }

  /** A backed conflicting designation froze this holder — security class, immediate. */
  async designationConflict(keyRef: string, epoch: number, text: string): Promise<string> {
    const s = this.load();
    return this.send({ kind: 'designation-conflict', dedupeKey: `designation-conflict:${keyRef}:${epoch}`, text, urgent: true }, s);
  }

  /** Invoice drift after the one re-read (dedupe `drift:gemini-api:<monthEpoch>`). */
  async invoiceDrift(month: string, figureUsd: number, committedUsd: number, driftPct: number): Promise<string> {
    const s = this.load();
    return this.send({
      kind: 'invoice-drift',
      dedupeKey: `drift:gemini-api:${month}`,
      text: `Google's bill for Gemini in ${month} is $${figureUsd.toFixed(2)}, but my own books say $${committedUsd.toFixed(2)} (${driftPct}% apart, checked twice six hours apart). This is reporting only; spending limits are unchanged. I am looking into why.`,
      urgent: false,
    }, s);
  }

  /** A plain lane notice (key in plain config, a failed apply, a too-short failover threshold). */
  async laneNotice(dedupeKey: string, text: string, urgent = false): Promise<string> {
    const s = this.load();
    return this.send({ kind: 'lane-notice', dedupeKey, text, urgent }, s);
  }

  /**
   * A session lowered a limit or disabled a caller (§9): one notice per action, coalesced
   * per hour — a second action within the hour is folded into the next notice — each
   * naming who did it and where to restore it, so a confused session cannot quietly
   * leave the lane down.
   */
  async limitLowered(actor: string, what: string): Promise<string> {
    const s = this.load();
    const now = this.now();
    if (now - s.lastLowerNoticeAt < HOUR_MS) {
      s.suppressedLowers += 1;
      this.save(s);
      return 'coalesced';
    }
    const more = s.suppressedLowers > 0 ? ` (plus ${s.suppressedLowers} more change${s.suppressedLowers === 1 ? '' : 's'} in the last hour)` : '';
    const link = this.d.spendTabLink?.() ?? null;
    const r = await this.send({
      kind: 'limit-lowered',
      dedupeKey: `limit-lowered:${now}`,
      text: `Gemini spending was reduced by ${actor}: ${what}${more}. Raising it back needs your approval${link ? `; the restore plan is on the Spend tab: ${link}` : ' on the Spend tab'}.`,
      urgent: false,
    }, s);
    if (r === 'sent' || r === 'held') {
      s.lastLowerNoticeAt = now;
      s.suppressedLowers = 0;
      this.save(s);
    }
    return r;
  }

  /** The provisional-ceiling trip: one Work Board card with the prefilled plan (dedupe `provisional:gemini-api:<monthEpoch>`). */
  provisionalCeiling(monthEpoch: string, card: WorkCardRequest): string {
    const s = this.load();
    const key = `provisional:gemini-api:${monthEpoch}`;
    if (s.sent[key]) return 'duplicate';
    if (inPacificQuietHours(this.now())) {
      if (!s.heldCards.some((c) => c.title === card.title)) s.heldCards.push(card);
      s.sent[`${key}:held`] = new Date(this.now()).toISOString();
      this.save(s);
      return 'held';
    }
    const ok = this.d.openCard?.(card) ?? false;
    if (ok) {
      s.sent[key] = new Date(this.now()).toISOString();
      this.save(s);
      return 'sent';
    }
    return 'failed';
  }

  /** Flush what quiet hours held (called on a timer and at boot). */
  async flushHeld(): Promise<number> {
    if (inPacificQuietHours(this.now())) return 0;
    const s = this.load();
    const held = s.held;
    const cards = s.heldCards;
    s.held = [];
    s.heldCards = [];
    this.save(s);
    let n = 0;
    for (const h of held) {
      const r = await this.send({ ...h, urgent: true }, this.load());
      if (r === 'sent') n++;
      else if (r === 'failed') { const s2 = this.load(); s2.held.push(h); this.save(s2); }
    }
    for (const c of cards) {
      const ok = this.d.openCard?.(c) ?? false;
      if (ok) { n++; const s2 = this.load(); s2.sent[`provisional:gemini-api:${c.plan.monthEpoch ?? 'held'}`] = new Date(this.now()).toISOString(); this.save(s2); }
      else { const s2 = this.load(); s2.heldCards.push(c); this.save(s2); }
    }
    return n;
  }

  start(intervalMs = 10 * 60 * 1000): void {
    if (this.timer) return;
    void this.flushHeld().catch(() => undefined);
    this.timer = setInterval(() => { void this.flushHeld().catch(() => undefined); }, intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
