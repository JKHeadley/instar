/**
 * MemoryPrivacyRecovery — how the owner gets out of the fixed reply.
 * Spec: docs/specs/memory-privacy.md, "Owner recovery".
 *
 * The link is the only credential, so it is long, works once, and expires. Opening it
 * changes nothing, because Slack and other apps fetch links to build previews; only
 * the page's POST spends it. The request carries no input: the server already chose
 * the repair, which can only point this agent at a Claude binary it has run and
 * measured. It never turns memory privacy off and never runs anything unprotected.
 */

import { randomBytes } from 'node:crypto';
import type { MemorySandboxBlocker } from '../core/memorySandboxProbe.js';

export const RECOVERY_LINK_TTL_MS = 30 * 60_000;
/** One private message per this long, however often the owner asks in a channel. */
export const RECOVERY_NOTICE_GAP_MS = 10 * 60_000;

export type MemoryBlocker = MemorySandboxBlocker | 'framework';

export interface RecoveryFacts {
  blocker: MemoryBlocker;
  platform: NodeJS.Platform;
  floor: string;
  /** What the configured binary reports, when it runs at all. */
  haveVersion?: string | null;
  /** A binary on this machine proven at or above the floor. */
  candidate?: string | null;
}

/**
 * The plain cause and what to do about it. The default names paths, so it is for the
 * owner only. `shareable` leaves them out for reports that leave the machine.
 */
export function memoryFixText(facts: RecoveryFacts, shareable = false): string {
  const { blocker, floor, candidate, haveVersion, platform } = facts;
  if (blocker === 'framework') return 'Private memory needs Claude Code, and this agent runs on a different framework. Conversations for more than one person cannot run here until it uses Claude Code.';
  if (blocker === 'sandbox') {
    if (platform === 'linux') return 'The sandbox did not start. Install bubblewrap and socat as an administrator (on Ubuntu 24.04, also the bubblewrap AppArmor profile), then restart the agent.';
    if (platform === 'darwin') return 'The macOS sandbox did not start for this agent. Check that its server is not running inside another sandbox, then restart the agent.';
    return 'This platform has no supported sandbox, so private memory cannot run here.';
  }
  const cause = blocker === 'claude-missing'
    ? 'The Claude Code binary this agent is set to use will not run.'
    : `This agent is set to use Claude Code ${haveVersion ?? 'of an older version'}, and private memory needs ${floor} or newer.`;
  return candidate
    ? `${cause} A working one is on this machine${shareable ? '' : ` at ${candidate}`}.`
    : `${cause} Update Claude Code on this machine to ${floor} or newer, then restart the agent.`;
}

export interface RecoveryDeps {
  facts: () => RecoveryFacts | null;
  /** Switches to the proven binary and re-runs the probe. True when sessions can run. */
  repair: () => Promise<boolean>;
  /** The address of a link path: the tunnel when there is one. Null when there is none. */
  linkFor: (path: string) => string | null;
  now?: () => number;
}

interface LiveLink { token: string; expires: number; blocker?: MemoryBlocker }

export class MemoryPrivacyRecovery {
  private link: LiveLink | null = null;
  private lastNotice = -Infinity;

  constructor(private readonly deps: RecoveryDeps) {}

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private repairable(): boolean {
    const facts = this.deps.facts();
    return !!facts?.candidate && (facts.blocker === 'claude-too-old' || facts.blocker === 'claude-missing');
  }

  private mintUrl(blocker?: MemoryBlocker): string | null {
    if (!this.link || this.link.expires <= this.now() || this.link.blocker !== blocker) {
      this.link = { token: randomBytes(32).toString('base64url'), expires: this.now() + RECOVERY_LINK_TTL_MS, blocker };
    }
    return this.deps.linkFor(`/memory-privacy/fix/${this.link.token}`);
  }

  /** The facts behind a refusal. This channel or framework can be the limit on a healthy sandbox. */
  private factsFor(blocker?: MemoryBlocker): RecoveryFacts | null {
    return blocker ? { blocker, platform: process.platform, floor: '' } : this.deps.facts();
  }

  /** The owner's message: the cause, and a link to the solution whenever it has an address. */
  ownerMessage(blocker?: MemoryBlocker): string {
    const facts = this.factsFor(blocker);
    if (!facts) return "I can't reply yet. Please try again in a minute.";
    const text = `I can't reply yet. ${memoryFixText(facts)}`;
    const url = this.mintUrl(blocker);
    if (url) {
      const minutes = Math.ceil(((this.link?.expires ?? this.now()) - this.now()) / 60_000);
      const span = `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
      return !blocker && this.repairable()
        ? `${text} Fix it here: ${url} (works once, for the next ${span}).`
        : `${text} What to do: ${url} (for the next ${span}).`;
    }
    // No tunnel means no address a phone can reach, and a localhost link would mislead.
    const noLink = 'I have no public address, so I cannot send a link.';
    return !blocker && this.repairable()
      ? `${text} ${noLink} Set sessions.claudePath to that path in .instar/config.json, then restart the agent.`
      : `${text} ${noLink}`;
  }

  /** Whether there is a real cause to tell the owner; during the boot probe there is not yet. */
  hasCause(blocker?: MemoryBlocker): boolean {
    return this.factsFor(blocker) !== null;
  }

  /** One message per gap, so a busy channel does not fill the owner's messages. */
  noticeIsRecent(): boolean {
    return this.now() - this.lastNotice < RECOVERY_NOTICE_GAP_MS;
  }

  /** Only a message that went counts, so a failed send can be tried again. */
  markNoticeSent(): void {
    this.lastNotice = this.now();
  }

  /** Reading a link never spends it. */
  linkIsLive(token: string): boolean {
    return !!this.link && this.link.token === token && this.link.expires > this.now();
  }

  /** What the page for this link says. */
  describe(token?: string): string {
    const blocker = token && this.link?.token === token ? this.link.blocker : undefined;
    const facts = this.factsFor(blocker);
    return facts ? memoryFixText(facts) : 'Private memory is working on this agent.';
  }

  /** True when this link's page can offer the repair, not only explain the fix. */
  canRepair(token: string): boolean {
    return this.linkIsLive(token) && !this.link?.blocker && this.repairable();
  }

  /** Spends the link, then repairs. A second click finds nothing. */
  async redeem(token: string): Promise<'fixed' | 'not-fixed' | 'expired'> {
    if (!this.linkIsLive(token)) return 'expired';
    if (!this.canRepair(token)) return 'not-fixed';
    this.link = null;
    try {
      return (await this.deps.repair()) ? 'fixed' : 'not-fixed';
    } catch (err) {
      // A config that will not write must not take the server down with it.
      console.warn(`[memory-privacy] repair failed: ${err instanceof Error ? err.message : String(err)}`);
      return 'not-fixed';
    }
  }
}
