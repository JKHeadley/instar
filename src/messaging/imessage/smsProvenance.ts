/**
 * identity-security-piece1eb: an SMS that claims to be a contact is not that contact.
 * Spec: docs/specs/identity-security-piece1eb-imessage-sms.md
 *
 * Only a row whose `service` is iMessage proves its sender (an iMessage handle is bound to an Apple
 * account). SMS, RCS, empty and unknown services are unproven: their sender number is set by the
 * sending network and can be spoofed. (Replies always go out as iMessage, so an SMS-only contact
 * cannot hold a conversation with the agent today either; an owner-controlled per-number list is
 * piece 4, with the owner's own device surface.)
 */

/** Whether a Messages row's service proves its sender. */
export function serviceProvesSender(service: string | null | undefined): boolean {
  return typeof service === 'string' && service.trim().toLowerCase() === 'imessage';
}

/** Whether a row may act as the contact it names. */
export function rowMayActAsContact(row: { service?: string | null }): boolean {
  return serviceProvesSender(row.service);
}

/** What the history route shows instead of an unproven row's text. */
export const UNPROVEN_TEXT_PLACEHOLDER = "(text message not shown: it can't prove who sent it; it's in the owner's Messages app)";

export const UNPROVEN_NUMBERS_SHOWN = 10;
export const UNPROVEN_REFRESH_MS = 10 * 60_000;

/**
 * The owner's daily notice: how many unproven texts were set aside today and which numbers they
 * claimed (masked). Never the text. Raised on the first one of a day; refreshed when the count grows,
 * at most every 10 minutes. The count is always exact; only the shown numbers are capped.
 */
export class UnprovenTextNotice {
  private day = '';
  private count = 0;
  private numbers: string[] = [];
  private lastRaisedAt = 0;
  private lastRaisedCount = 0;

  constructor(private readonly now: () => number = Date.now) {}

  /** Record one set-aside text. Returns the notice to raise or refresh, or null when throttled. */
  note(maskedNumber: string): { title: string; body: string } | null {
    const t = this.now();
    const at = new Date(t);
    const d = `${at.getFullYear()}-${at.getMonth() + 1}-${at.getDate()}`; // the owner's local day
    if (d !== this.day) { this.day = d; this.count = 0; this.numbers = []; this.lastRaisedAt = 0; this.lastRaisedCount = 0; }
    this.count++;
    if (!this.numbers.includes(maskedNumber)) this.numbers.push(maskedNumber);
    const first = this.lastRaisedCount === 0;
    if (!first && t - this.lastRaisedAt < UNPROVEN_REFRESH_MS) return null;
    this.lastRaisedAt = t;
    this.lastRaisedCount = this.count;
    return this.render();
  }

  /** Whether a held-back refresh is owed, and when (ms from now); the adapter schedules one flush. */
  pendingRefreshInMs(): number | null {
    if (this.count === this.lastRaisedCount || this.lastRaisedCount === 0) return null;
    return Math.max(0, UNPROVEN_REFRESH_MS - (this.now() - this.lastRaisedAt));
  }

  /** The owed refresh: the current exact count. */
  flush(): { title: string; body: string } | null {
    if (this.count === this.lastRaisedCount) return null;
    this.lastRaisedAt = this.now();
    this.lastRaisedCount = this.count;
    return this.render();
  }

  render(): { title: string; body: string } {
    const shown = this.numbers.slice(0, UNPROVEN_NUMBERS_SHOWN).join(', ');
    const more = this.numbers.length > UNPROVEN_NUMBERS_SHOWN ? ` and ${this.numbers.length - UNPROVEN_NUMBERS_SHOWN} more` : '';
    return {
      title: 'Text messages your agent did not act on',
      body: `${this.count} message(s) that were not iMessages (SMS or similar) claimed to come from your contacts today (${shown}${more}). `
        + "Your agent didn't act on them, because a text message can't prove who sent it. They're in your Messages app. "
        + "If one was you, send it again as an iMessage, or reach your agent another way (its dashboard or your chat with it) if iMessage isn't working.",
    };
  }
}
