/**
 * inboundCredentialNotice — SEC-164 part 1 §3.5 and §4.5, the server side of masking a new incoming
 * message: one call masks the text, decides whether the sender is on the agent's team, and (for a
 * team member only) sends the fixed notice with a fresh one-tap Secret Drop link, once per message.
 *
 * Nothing here ever keeps a key: the value is replaced before the caller stores anything, and the
 * only record is the kinds and a count.
 */
import {
  maskInbound, isTeamSender, teamMemberNotice, sessionRemovedKeyNote,
  type InboundMaskResult, type TeamSenderInput,
} from '../messaging/inboundCredentialMask.js';
import type { OwnCredentialMatcher } from '../messaging/outbound-credential-guard.js';

export interface InboundCredentialDeps {
  /** Read live for every message (`security.credentialScrub.enabled`, dev-gated). */
  enabled: () => boolean;
  /** The agent's own configured keys (bot, API and tunnel tokens), matched by exact value. Absent ⇒ patterns only. */
  ownCredentials?: () => OwnCredentialMatcher | null;
  /** Mints a Secret Drop request for the conversation (`target` is the Telegram topic id or the Slack channel id) and returns its link, or null if it cannot. */
  mintResendLink: (input: { target: string; channel: TeamSenderInput['channel'] }) => string | null;
  /** Sends the fixed notice into the same conversation. Server-written text, never a session's. */
  sendNotice: (input: { target: string; channel: TeamSenderInput['channel']; text: string }) => Promise<unknown> | unknown;
  /** One report per failure, never given text. */
  reportFailure: (reason: string) => void;
  /** How many message keys to remember so a re-forwarded message is not noticed twice. */
  dedupeLimit?: number;
}

export interface MaskedInbound extends InboundMaskResult {
  /** True when a key was removed (masked or fallback). */
  removed: boolean;
  /** True when the sender counts as a team member, so the notice is due. */
  team: boolean;
}

export class InboundCredentialNotice {
  private readonly noticed = new Set<string>();
  private readonly limit: number;

  constructor(private readonly deps: InboundCredentialDeps) {
    this.limit = Math.max(16, deps.dedupeLimit ?? 2000);
  }

  /** Mask one message. `sender` is only consulted when a key was removed. Never throws. */
  mask(text: string, sender: TeamSenderInput): MaskedInbound {
    let enabled = false;
    try { enabled = this.deps.enabled(); } catch { enabled = false; } // @silent-fallback-ok — an unreadable switch is off, as before this change
    let own: OwnCredentialMatcher | null = null;
    try { own = this.deps.ownCredentials?.() ?? null; } catch { own = null; } // @silent-fallback-ok — patterns alone still mask every wall kind
    const r = maskInbound(text, { enabled, ownCredentials: own, onFailure: (reason) => this.safeReport(reason) });
    const removed = r.outcome === 'masked' || r.outcome === 'fallback';
    let team = false;
    if (removed) {
      try { team = isTeamSender(sender); } catch { team = false; } // @silent-fallback-ok — unknown means no notice; nothing is saved either way
    }
    return { ...r, removed, team };
  }

  /** The text the receiving session sees: the masked text plus the one-line note. */
  sessionText(maskedText: string, result: MaskedInbound): string {
    if (!result.removed) return maskedText;
    return `${maskedText}\n\n${sessionRemovedKeyNote(result.team)}`;
  }

  /**
   * Send the team-member notice once for this message. `messageKey` is the channel's own message id,
   * so a re-forward or replay of the same message never sends a second notice from this process.
   */
  async notify(input: { target: string; messageKey: string; channel: TeamSenderInput['channel']; result: MaskedInbound }): Promise<'sent' | 'skipped' | 'failed'> {
    if (!input.result.removed || !input.result.team) return 'skipped';
    // A message with no id is never deduped: an empty key would silence every later notice there.
    if (input.messageKey) {
      const key = `${input.channel}:${input.target}:${input.messageKey}`;
      if (this.noticed.has(key)) return 'skipped';
      this.noticed.add(key);
      if (this.noticed.size > this.limit) {
        const oldest = this.noticed.values().next().value;
        if (oldest !== undefined) this.noticed.delete(oldest);
      }
    }
    let link: string | null = null;
    try { link = this.deps.mintResendLink({ target: input.target, channel: input.channel }); } catch {
      this.safeReport('resend link could not be made');
      link = null;
    }
    try {
      await this.deps.sendNotice({ target: input.target, channel: input.channel, text: teamMemberNotice(link) });
      return 'sent';
    } catch {
      this.safeReport('team notice could not be sent');
      return 'failed';
    }
  }

  private safeReport(reason: string): void {
    try { this.deps.reportFailure(reason); } catch { /* @silent-fallback-ok — reporting must never block a message */ }
  }
}
