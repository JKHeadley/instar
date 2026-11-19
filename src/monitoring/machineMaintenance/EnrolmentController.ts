/**
 * Machine enrolment: the owner's one tap (docs/specs/machine-self-maintenance.md, Part C).
 * CMT-1200, second slice.
 *
 * The capability is on by default, and nothing can restart until the machine's owner has
 * tapped once for that machine. This controller:
 *
 *  - offers the tap ONE time per machine: a message in the owner's conversation, the spec's
 *    card text, an Approve button and a "Not this machine" button, bound to a single-use
 *    nonce that expires in 24 hours. It offers again only on new facts (a readiness change).
 *  - on the owner's Approve: the Telegram adapter has already checked the tap came from the
 *    verified owner (`mc:` taps are owner-only, P-class). Here: the nonce is live and for this
 *    machine, the lifeline ingress guard is armed (so forging the press takes reading a
 *    protected file, not just the API token), and the refusal table still clears. Then the
 *    reboot rule is installed (exactly the restart lines, nothing else, validated by visudo,
 *    root-owned 0440, byte-compared and listed by `sudo -n -l`) and the enrolment record is
 *    written: `proving` when the machine reads unattended-ready, else `attended`.
 *  - on "Not this machine": writes the host do-not-maintain marker, so no agent on this
 *    login offers it again.
 *
 * Instar never handles a machine password. This build installs the rule only where
 * passwordless sudo already works (the Studio); elsewhere the record says `ruleInstalled:
 * false` and the reply names the one step that needs a person, per the spec.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { atomicWriteFileSync } from '../../core/hostSemaphoreCore.js';
import { SafeFsExecutor } from '../../core/SafeFsExecutor.js';
import type { EnrolmentRecord, EnrolmentStatus, ReadinessPlatform } from './enrolmentReadiness.js';
import { sudoersLines } from './RestartActuator.js';

export const ENROL_OFFER_TTL_MS = 24 * 60 * 60_000;
export const SUDOERS_RULE_PATH = '/etc/sudoers.d/instar-reboot';

export interface EnrolOffer { nonce: string; machineId: string; offeredAt: number; expiresAt: number; readinessMode: string; used: boolean }

export interface EnrolmentControllerDeps {
  hostDir: string;
  agent: string;
  user: string;
  platform: ReadinessPlatform;
  machineId: () => string | null;
  machineLabel: () => string;
  status: () => Promise<EnrolmentStatus>;
  /** The lifeline ingress guard is armed (taps without the lifeline secret are refused). */
  ingressArmed: () => boolean;
  /** Sends the offer with its two buttons; resolves to a message id, or null when not delivered. */
  sendOffer: (text: string, buttons: Array<{ text: string; data: string }>) => Promise<number | null>;
  /** Names of non-Instar apps open now, for the card. Null: unread. */
  openApps: () => Promise<string[] | null>;
  /** Runs one command, no shell; resolves to {code, stdout}. */
  run: (command: string, args: string[]) => Promise<{ code: number | null; stdout: string }>;
  /** Agents on this login, named on the card. */
  coResident?: () => string[];
  now?: () => number;
  log?: (line: string) => void;
}

export function cardText(machine: string, apps: string[] | null, coResident: string[]): string {
  const lines = [
    `Keep ${machine} healthy by itself?`,
    '',
    'I will restart this machine about once a week in the small hours, and if it wedges. Running work pauses first and picks up afterward. If something can\'t pause, I\'ll ask you before it is ended, and if you don\'t answer, the restart goes ahead. This interrupts everyone using it. I can\'t see unsaved changes in ordinary apps, so anything left open and unsaved here may be lost.',
  ];
  if (apps && apps.length) lines.push('', `Open on it now: ${apps.slice(0, 8).join(', ')}${apps.length > 8 ? ` and ${apps.length - 8} more` : ''}.`);
  if (coResident.length > 1) lines.push('', `Agents on this machine: ${coResident.join(', ')}.`);
  return lines.join('\n');
}

export class EnrolmentController {
  private readonly now: () => number;
  constructor(private readonly deps: EnrolmentControllerDeps) { this.now = deps.now ?? Date.now; }

  private get offersPath(): string { return path.join(this.deps.hostDir, 'enrol-offers.json'); }
  private get recordPath(): string { return path.join(this.deps.hostDir, 'enrolment.json'); }
  private get markerPath(): string { return path.join(this.deps.hostDir, 'do-not-maintain.json'); }

  private readOffers(): EnrolOffer[] {
    try { const v = JSON.parse(fs.readFileSync(this.offersPath, 'utf-8')); return Array.isArray(v) ? v : []; } catch { return []; } // @silent-fallback-ok — no offers yet
  }
  private writeJson(file: string, value: unknown, mode = 0o644): void {
    fs.mkdirSync(this.deps.hostDir, { recursive: true });
    atomicWriteFileSync(file, JSON.stringify(value, null, 2), { mode, operation: 'EnrolmentController.write' });
  }

  /**
   * Offers the tap when the status allows it and no live offer exists for these facts.
   * Returns what happened, for the audit and the caller.
   */
  async offer(input: { coResident: string[] } = { coResident: this.deps.coResident?.() ?? [] }): Promise<'offered' | 'already-offered' | 'not-offerable' | 'no-machine-id' | 'not-delivered'> {
    const machineId = this.deps.machineId();
    if (!machineId) return 'no-machine-id';
    const st = await this.deps.status();
    if (!st.offerable) return 'not-offerable';
    const now = this.now();
    const offers = this.readOffers();
    // One offer per machine; again only on a new fact (a readiness change) or after it expired unused.
    const live = offers.find((o) => o.machineId === machineId && !o.used && now < o.expiresAt && o.readinessMode === st.readiness.mode);
    const sameFacts = offers.find((o) => o.machineId === machineId && o.readinessMode === st.readiness.mode);
    if (live || sameFacts) return 'already-offered';
    const nonce = crypto.randomBytes(12).toString('hex');
    const text = cardText(this.deps.machineLabel(), await this.deps.openApps().catch(() => null), input.coResident)
      + (st.readiness.mode === 'attended' && st.readiness.ownerStep ? `\n\n${st.readiness.ownerStep}` : '');
    const id = await this.deps.sendOffer(text, [
      { text: 'Yes, keep it healthy', data: `mc:enrol:${nonce}` },
      { text: 'Not this machine', data: `mc:dnm:${nonce}` },
    ]);
    if (id === null) return 'not-delivered';
    this.writeJson(this.offersPath, [...offers.filter((o) => now < o.expiresAt + 7 * ENROL_OFFER_TTL_MS), { nonce, machineId, offeredAt: now, expiresAt: now + ENROL_OFFER_TTL_MS, readinessMode: st.readiness.mode, used: false }]);
    return 'offered';
  }

  /** The owner's tap. `fromIsOwner` is the adapter's check; anything else is refused here. */
  async onTap(tap: { data: string; fromIsOwner: boolean; fromUserId: number }): Promise<string> {
    const m = /^mc:(enrol|dnm):([0-9a-f]{24})$/.exec(tap.data);
    if (!m) return 'That button is no longer active.';
    if (!tap.fromIsOwner) return 'Only the owner can choose this.';
    const [, action, nonce] = m;
    const offers = this.readOffers();
    const offer = offers.find((o) => o.nonce === nonce);
    const machineId = this.deps.machineId();
    if (!offer || offer.used || this.now() >= offer.expiresAt || offer.machineId !== machineId) return 'That offer has expired. I\'ll ask again if anything changes.';
    const markUsed = () => this.writeJson(this.offersPath, offers.map((o) => (o.nonce === nonce ? { ...o, used: true } : o)));

    if (action === 'dnm') {
      markUsed();
      this.writeJson(this.markerPath, { by: `telegram:${tap.fromUserId}`, at: this.now(), machineId });
      this.deps.log?.(`machine marked do-not-maintain by the owner (${machineId})`);
      return 'Got it. I won\'t restart this machine, and won\'t ask again.';
    }

    if (!this.deps.ingressArmed()) return 'I can\'t accept this tap safely yet (my message line hasn\'t proved itself since it started). Try again in a minute.';
    const st = await this.deps.status();
    if (st.refusal) return st.refusal === 'other-user-active' ? 'Someone else is using this machine right now, so I can\'t enrol it yet.' : 'This machine can\'t be enrolled.';
    if (st.enrolled) { markUsed(); return 'This machine is already enrolled.'; }

    const rule = await this.installRule();
    const record: EnrolmentRecord & { proofOfTap: string; readiness: string; acknowledgedAgents: string[] } = {
      machineId: machineId!,
      maintainerAgent: this.deps.agent,
      mode: st.readiness.mode === 'unattended' && rule.ok ? 'proving' : 'attended',
      enrolledAt: this.now(),
      principal: `telegram:${tap.fromUserId}`,
      ruleInstalled: rule.ok,
      proofOfTap: nonce,
      readiness: st.readiness.mode,
      acknowledgedAgents: [],
    };
    this.writeJson(this.recordPath, record);
    markUsed();
    this.deps.log?.(`machine enrolled by the owner: mode ${record.mode}, rule ${rule.ok ? 'installed' : `not installed (${rule.reason})`}`);
    if (record.mode === 'proving') return 'Enrolled. The first restart is a proving one; I\'ll tell you before it happens and when it\'s back.';
    if (!rule.ok && rule.reason === 'needs-admin') return 'Enrolled, but I need an administrator step on this machine before I can restart it. I\'ll remind you to restart it instead for now.';
    return 'Enrolled. This machine can\'t come back by itself after a restart, so I\'ll remind you to restart it instead.';
  }

  /**
   * Off (Part F, the card's Remove): this machine is no longer signed up. The record is kept
   * aside as `enrolment.removed.json` (never deleted), the offers for this machine are cleared
   * so the owner can sign it up again from the page, and the reboot rule is taken out where
   * passwordless sudo works. Without the record every restart path refuses: Restart now at
   * offer and tap, and a countdown already running at its in-lock check. Safe direction only.
   */
  async remove(by: string): Promise<{ ok: true; wasEnrolled: boolean; ruleRemoved: boolean; reason?: string }> {
    const machineId = this.deps.machineId();
    let record: unknown = null;
    try { record = JSON.parse(fs.readFileSync(this.recordPath, 'utf-8')); } catch { record = null; } // @silent-fallback-ok — no record: not enrolled
    if (record !== null) {
      this.writeJson(path.join(this.deps.hostDir, 'enrolment.removed.json'), { record, removedAt: this.now(), by });
      SafeFsExecutor.safeUnlinkSync(this.recordPath, { operation: 'EnrolmentController.remove' });
    }
    this.writeJson(this.offersPath, this.readOffers().filter((o) => o.machineId !== machineId));
    const rule = await this.removeRule();
    this.deps.log?.(`machine care turned off by ${by}: ${record !== null ? 'enrolment removed' : 'was not enrolled'}, rule ${rule.ok ? 'removed' : `left (${rule.reason})`}`);
    return { ok: true, wasEnrolled: record !== null, ruleRemoved: rule.ok, ...(rule.ok ? {} : { reason: rule.reason }) };
  }

  /** Takes the reboot rule out in one root step where passwordless sudo works; nothing else. */
  async removeRule(): Promise<{ ok: boolean; reason?: string }> {
    if (this.deps.platform !== 'darwin' && this.deps.platform !== 'linux') return { ok: true };
    const probe = await this.deps.run('sudo', ['-n', 'true']);
    if (probe.code !== 0) return { ok: false, reason: 'needs-admin' };
    const res = await this.deps.run('sudo', ['-n', 'rm', '-f', SUDOERS_RULE_PATH]);
    await this.deps.run('sudo', ['-k']);
    return res.code === 0 ? { ok: true } : { ok: false, reason: 'remove-failed' };
  }

  /**
   * Installs the exact reboot rule in one root step, only where passwordless sudo already
   * works. Validated with visudo, root-owned 0440, renamed into place, then byte-compared and
   * listed. WSL needs no rule (Windows shutdown privilege).
   */
  async installRule(): Promise<{ ok: boolean; reason?: string }> {
    if (this.deps.platform === 'wsl') return { ok: true };
    if (this.deps.platform !== 'darwin' && this.deps.platform !== 'linux') return { ok: false, reason: 'not-covered' };
    const lines = sudoersLines(this.deps.platform);
    if (!/^[a-z_][a-z0-9_.-]*$/i.test(this.deps.user)) return { ok: false, reason: 'user-name' };
    const rule = `${this.deps.user} ALL=(root) NOPASSWD: ${lines.join(', ')}\n`;
    const probe = await this.deps.run('sudo', ['-n', 'true']);
    if (probe.code !== 0) return { ok: false, reason: 'needs-admin' };
    const script = 'set -e; d=$(mktemp -d /etc/sudoers.d/.instar-reboot.XXXXXX); printf "%s" "$1" > "$d/r"; visudo -cf "$d/r" >/dev/null; chown root:0 "$d/r"; chmod 0440 "$d/r"; mv "$d/r" "$2"; rmdir "$d"';
    const res = await this.deps.run('sudo', ['-n', 'sh', '-c', script, '_', rule, SUDOERS_RULE_PATH]);
    await this.deps.run('sudo', ['-k']);
    if (res.code !== 0) return { ok: false, reason: 'install-failed' };
    const back = await this.deps.run('sudo', ['-n', 'cat', SUDOERS_RULE_PATH]);
    if (back.code !== 0 || back.stdout !== rule) return { ok: false, reason: 'byte-compare-failed' };
    const list = await this.deps.run('sudo', ['-n', '-l']);
    if (!lines.every((l) => list.stdout.includes(l))) return { ok: false, reason: 'not-listed' };
    return { ok: true };
  }
}

let activeController: EnrolmentController | null = null;
export function setActiveEnrolmentController(c: EnrolmentController | null): void { activeController = c; }
export function getActiveEnrolmentController(): EnrolmentController | null { return activeController; }

/** The lifeline ingress guard's tapsProvable(), published by routes.ts where the guard lives. */
let tapsProvableReader: (() => boolean) | null = null;
export function setEnrolmentTapsProvable(fn: (() => boolean) | null): void { tapsProvableReader = fn; }
/** False until the guard publishes itself: an unknown guard never reads as armed. */
export function enrolmentTapsProvable(): boolean { try { return tapsProvableReader?.() === true; } catch { return false; } } // @silent-fallback-ok — a throwing guard reads as not provable
