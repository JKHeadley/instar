/**
 * Browser devices (docs/specs/dashboard-conversations-browser-device.md).
 *
 * A browser is set up as its own signed device, like a second phone: a WebCrypto P-256 key that
 * never leaves the browser, approved through the agent's own approval path (§4.2), limited to the
 * conversation routes (§4.4), and marked `client: 'browser'` inside the signed ledger activation
 * row (§4.3). This module holds the setup and status routes, the activation (intent → ledger row →
 * registry → effects), the activation effects and their recovery.
 *
 * Every registry change here is one synchronous read-modify-write (DeviceRegistry), so a decline
 * and an approval of the same record never interleave: whichever writes first wins (§4.1).
 */
import crypto from 'node:crypto';
import type { Request, Response, Router } from 'express';
import { resolveDevAgentGate } from '../core/devAgentGate.js';
import { arrivedOverLocalTls, isLoopbackPeer } from '../core/desktopTransport.js';
import { normalizeRequestHost } from '../core/MobileOwnNames.js';
import {
  BROWSER_NOTIFYING_STUCK_MS, isBrowserDevice, isStrictLowSDer, keyHashOf, parseDevicePublicKey,
  type ApprovedVia, type BrowserEffect, type BrowserEffectKind, type DeviceRecord,
} from '../core/MobileDeviceKeys.js';
import { CHUNK_BYTES, MAX_ATTACHMENTS, MAX_FILE_BYTES, MAX_MESSAGE_BYTES } from '../core/appMediaTypes.js';
import { cleanText } from '../core/MobilePairing.js';
import type { InstarConfig } from '../core/types.js';
import { featureEvidence } from '../monitoring/FeatureEvidenceLog.js';
import type { MobilePairingService } from './mobilePairingRoutes.js';
import { isMobileNativeEnabled, isPairingApproveEnabled, principalOf } from './mobilePairingRoutes.js';

export const BROWSER_FEATURE = 'mobilePairing.browser';
export const ENROLL_PROOF_VERSION = 'instar-browser-enroll-v1';
export const REPLACE_SIG_VERSION = 'instar-browser-replace-v1';
export const DEFAULT_MAX_BROWSERS = 10;
export const DEFAULT_MAX_SETUPS_PER_HOUR = 6;
/** Effects back off from 30 s, doubling, to 1 h; one report after this many attempts (§4.2 step 10). */
export const EFFECT_FIRST_BACKOFF_MS = 30_000;
export const EFFECT_MAX_BACKOFF_MS = 60 * 60_000;
export const EFFECT_REPORT_AFTER = 24;
/** One further report when more records than this carry effects. */
export const EFFECT_RECORDS_REPORT_ABOVE = 20;
const SETUP_TIME_WINDOW_MS = 60_000;

/**
 * When a failed activation effect is next attempted (§4.2 step 10): 30 s doubling to a 1 h ceiling,
 * forever (an identity effect is never dropped). Pure; the self-action convergence ratchet drives it.
 */
export function nextEffectAttemptAt(attempts: number, nowMs: number): number {
  return nowMs + Math.min(EFFECT_FIRST_BACKOFF_MS * 2 ** Math.max(0, attempts - 1), EFFECT_MAX_BACKOFF_MS);
}
const REQUEST_ID_RE = /^\d{13}-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const REFUSAL_KEEP_MS = 10 * 60_000;

/** Header-name prefixes the HTTP modes of the fronts instar configures add (§4.2 step 2, §4.5). */
export const FORWARDING_HEADER_PREFIXES: ReadonlyArray<string> = [
  'x-forwarded-', 'forwarded', 'cf-', 'cdn-loop', 'tailscale-', 'x-real-ip', 'true-client-ip',
];

interface BrowserConfig { enabled?: boolean; maxBrowsers?: number; maxSetupsPerHour?: number }
function browserConfig(config: InstarConfig): BrowserConfig | undefined {
  return (config.mobilePairing as { browser?: BrowserConfig } | undefined)?.browser;
}

/** `mobilePairing.browser.enabled`: omitted ⇒ the development-agent gate; needs native conversations. Read live. */
export function isBrowserDevicesEnabled(config: InstarConfig): boolean {
  return isMobileNativeEnabled(config) && resolveDevAgentGate(browserConfig(config)?.enabled, config);
}

function positiveInt(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= 1000 ? v : fallback;
}
export function browserLimits(config: InstarConfig): { maxBrowsers: number; maxSetupsPerHour: number } {
  const c = browserConfig(config);
  return { maxBrowsers: positiveInt(c?.maxBrowsers, DEFAULT_MAX_BROWSERS), maxSetupsPerHour: positiveInt(c?.maxSetupsPerHour, DEFAULT_MAX_SETUPS_PER_HOUR) };
}

export function hasForwardingHeaders(headers: Record<string, unknown>): boolean {
  return Object.keys(headers).some((name) => {
    const n = name.toLowerCase();
    return FORWARDING_HEADER_PREFIXES.some((p) => n.startsWith(p));
  });
}

/** The raw Host header, lowercased (the own-name normaliser refuses a port, which loopback hosts carry). */
function rawHost(raw: unknown): string | null {
  return typeof raw === 'string' && raw.length <= 300 ? raw.trim().toLowerCase() : null;
}

export function isLoopbackHost(host: string | undefined | null): boolean {
  return !!host && /^(localhost|127\.0\.0\.1):\d{1,5}$/.test(host);
}

/**
 * The loopback rule (§4.5): a loopback-bound browser is accepted only when its stored host is a
 * loopback host, the request's Host equals it exactly, the peer is loopback, and no forwarding
 * header is present. A phone never matches.
 */
export function loopbackBindingOk(d: Pick<DeviceRecord, 'client' | 'host'>, req: Pick<Request, 'headers' | 'socket'>): boolean {
  if (!isBrowserDevice(d) || !isLoopbackHost(d.host)) return false;
  return isLoopbackPeer(req.socket.remoteAddress)
    && rawHost(req.headers.host) === d.host
    && !hasForwardingHeaders(req.headers as Record<string, unknown>);
}

/**
 * §4.2 step 2: the host a new browser key is bound to, computed before anything else. Either a
 * proven own name over local TLS (with multi-route off, the configured pairing origin host), or
 * exactly `localhost:<port>` / `127.0.0.1:<port>` from a loopback peer with no forwarding header.
 */
export function boundSetupHost(req: Pick<Request, 'headers' | 'socket' | 'secure'>, svc: MobilePairingService): string | null {
  const port = svc.deps.config.port;
  const raw = rawHost(req.headers.host);
  if (raw && isLoopbackPeer(req.socket.remoteAddress) && !hasForwardingHeaders(req.headers as Record<string, unknown>)
    && (raw === `localhost:${port}` || raw === `127.0.0.1:${port}`)) return raw;
  const h = normalizeRequestHost(req.headers.host);
  if (!h) return null;
  if (!arrivedOverLocalTls(req.secure, req.socket.remoteAddress, req.headers['x-forwarded-proto'])) return null;
  if (svc.ownNames) return svc.ownNames.accepts(h) ? h : null;
  const origin = svc.pairingOrigin();
  return origin && origin.host === h ? h : null;
}

export function enrollProofMessage(host: string, publicKey: string, enrollmentId: string, timeMs: string): string {
  return `${ENROLL_PROOF_VERSION}\n${host}\n${publicKey}\n${enrollmentId}\n${timeMs}`;
}
export function replaceMessage(oldDeviceId: string, newPublicKey: string, host: string, newEnrollmentId: string): string {
  return `${REPLACE_SIG_VERSION}\n${oldDeviceId}\n${newPublicKey}\n${host}\n${newEnrollmentId}`;
}

/** A strict low-S DER ECDSA-P256-SHA256 signature by `publicKey` over `message`. */
export function verifyP256(publicKey: string, message: string, sigB64url: unknown): boolean {
  if (typeof sigB64url !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(sigB64url)) return false;
  const key = parseDevicePublicKey(publicKey);
  if (!key) return false;
  const sig = Buffer.from(sigB64url, 'base64url');
  if (!isStrictLowSDer(sig)) return false;
  try { return crypto.verify('sha256', Buffer.from(message), { key, dsaEncoding: 'der' }, sig); } catch { return false; } // @silent-fallback-ok — a malformed signature is invalid
}

export type BrowserActivateResult = 'activated' | 'not-pending' | 'failed';
export type BrowserNoticeRaiser = (item: { key: string; title: string; body: string }, opts: { localOnly: boolean }) => Promise<boolean>;

const APPROVED_HOW: Record<string, string> = {
  'telegram-dm': 'in your private Telegram chat',
  'owner-phone': 'with Face ID on your phone',
  'dashboard-pin': 'with the dashboard PIN',
};

/**
 * Activation, activation effects and recovery for browser records (§4.2 step 10). One instance
 * per pairing service; all state that matters is on the device records.
 */
export class BrowserDeviceController {
  /** In-memory "browser work pending": set by the start-up scan and by any write that leaves work. */
  private workPending = false;
  /** A browser setup is `notifying` somewhere on this machine (so the 30 s sweep has something to do). */
  private notifyingWatch = false;
  private readonly inFlight = new Set<string>();
  private noLedgerReported = false;
  private manyReported = false;
  private readonly refusals = new Map<string, { reason: string; at: number }>();
  private recovered = false;

  constructor(private readonly svc: MobilePairingService, private readonly now: () => number = Date.now) {}

  /** Start-up scan, run by the service constructor (before any expiry): stuck setups go, work is noted. */
  bootScan(): void {
    try {
      for (const d of this.svc.devices.stuckNotifying(0)) this.svc.devices.removeIfStillSettingUp(d.id);
      this.workPending = this.svc.devices.browserWork().length > 0;
    } catch (err) { this.svc.deps.reportDegradation?.('MobilePairing.browserBootScan', err); this.workPending = true; }
  }

  noteNotifying(): void { this.notifyingWatch = true; }
  noteWork(): void { this.workPending = true; }
  hasWorkPending(): boolean { return this.workPending; }

  /** A recent refusal of this browser on this machine, for the status route's `reason` (§4.6). */
  noteRefusal(deviceId: string, reason: string): void {
    this.refusals.set(deviceId, { reason, at: this.now() });
    if (this.refusals.size > 256) { const first = this.refusals.keys().next().value; if (first) this.refusals.delete(first); }
  }
  recentRefusal(deviceId: string): string | null {
    const r = this.refusals.get(deviceId);
    return r && this.now() - r.at < REFUSAL_KEEP_MS ? r.reason : null;
  }

  /**
   * Activate a browser record (§4.2 step 10): the intent, the ledger row, the registry record
   * active with its effects, then the effects. `ownRequest`: the dashboard path's own record.
   */
  activate(deviceId: string, via: ApprovedVia, opts: { approvedBy?: string; ownRequest?: boolean } = {}): BrowserActivateResult {
    const ledger = this.svc.keyLedger;
    if (!ledger) {
      featureEvidence.record(BROWSER_FEATURE, { kind: 'error', reason: 'activation refused: no device-key ledger', context: { deviceId } });
      return 'failed';
    }
    const before = this.svc.devices.get(deviceId);
    if (!before || !isBrowserDevice(before)) return 'not-pending';
    const effects: BrowserEffectKind[] = [...(before.replaces ? ['revokeReplaced' as const] : []), 'notice'];
    const at = new Date(this.now()).toISOString();
    // 10.1 — the intent. Refused unless still pending, not declined, no intent yet, and awaiting
    // (or the dashboard path's own record). A decline that wrote first wins here.
    if (!this.svc.devices.setActivating(deviceId, { approvedVia: via, at, effects, ...(opts.approvedBy ? { approvedBy: opts.approvedBy } : {}) }, { ownRequest: opts.ownRequest })) {
      featureEvidence.record(BROWSER_FEATURE, { kind: 'held', reason: 'activation refused: not pending', context: { deviceId, approvedVia: via } });
      return 'not-pending';
    }
    this.workPending = true;
    const withIntent = this.svc.devices.get(deviceId)!;
    // 10.2 — the ledger row, with client: 'browser' inside the signed payload.
    try { ledger.recordActivation(withIntent, via, at); } catch (err) {
      // @silent-fallback-ok — not silent: reported through deps.reportDegradation (DegradationReporter in production); the intent stays and recovery expires it
      this.svc.deps.reportDegradation?.('MobilePairing.keyLedger', err);
      featureEvidence.record(BROWSER_FEATURE, { kind: 'error', reason: 'activation failed: key ledger write', context: { deviceId } });
      return 'failed';
    }
    // 10.3 — the registry record active, effects copied from the intent, intent cleared.
    let active: DeviceRecord | null = null;
    try { active = this.svc.devices.activateBrowser(deviceId); } catch (err) {
      this.svc.deps.reportDegradation?.('MobilePairing.registryWrite', err);
    }
    if (!active) {
      featureEvidence.record(BROWSER_FEATURE, { kind: 'error', reason: 'activation failed: registry write (recovery completes it)', context: { deviceId } });
      return 'failed';
    }
    this.svc.afterActivation(deviceId);
    featureEvidence.record(BROWSER_FEATURE, { kind: 'fired', reason: before.replaces ? 'activated (replacing a browser)' : 'activated', context: { deviceId, approvedVia: via } });
    // 10.4 / 10.5 — the effects, at once; failures are retried from leaseTick.
    void this.runEffects(deviceId);
    return 'activated';
  }

  /**
   * Recovery when the key ledger is attached at start-up (§4.2 step 10), and the same pass from
   * leaseTick while work is pending. With no ledger at all nothing is decided: reported once.
   */
  recover(): void {
    let work: DeviceRecord[];
    try { work = this.svc.devices.browserWork(); } catch (err) { this.svc.deps.reportDegradation?.('MobilePairing.browserRecovery', err); return; }
    const ledger = this.svc.keyLedger;
    if (!ledger) {
      if (work.some((d) => d.activating) && !this.noLedgerReported) {
        this.noLedgerReported = true;
        this.svc.deps.reportDegradation?.('MobilePairing.browserRecovery', new Error(`${work.filter((d) => d.activating).length} browser approval(s) cannot be completed: this machine has no device-key ledger (no identity key, or native conversations are off). They are left as they are until it has one.`));
      }
      this.workPending = work.length > 0;
      return;
    }
    for (const d of work) {
      if (!d.activating) continue;
      try {
        if (ledger.hasActivation(d)) {
          // The ledger row is written: finish the activation (steps 3–5), whatever pending/expired says.
          if (this.svc.devices.activateBrowser(d.id)) {
            this.svc.afterActivation(d.id);
            featureEvidence.record(BROWSER_FEATURE, { kind: 'fired', reason: 'activation completed by recovery', context: { deviceId: d.id } });
          }
        } else if (this.svc.devices.abandonActivation(d.id)) {
          // The approval never reached the ledger: it did not complete. The browser is told "not approved".
          featureEvidence.record(BROWSER_FEATURE, { kind: 'held', reason: 'approval did not complete: no ledger row (expired)', context: { deviceId: d.id } });
        }
      } catch (err) { this.svc.deps.reportDegradation?.('MobilePairing.browserRecovery', err); }
    }
    let remaining: DeviceRecord[] = [];
    try { remaining = this.svc.devices.browserWork(); } catch { remaining = []; } // @silent-fallback-ok — reported above when the registry is unreadable
    if (remaining.length > EFFECT_RECORDS_REPORT_ABOVE && !this.manyReported) {
      this.manyReported = true;
      this.svc.deps.reportDegradation?.('MobilePairing.browserEffects', new Error(`${remaining.length} browser records still have activation steps to finish (owner notices or retiring a replaced browser).`));
    }
    for (const d of remaining) if (d.effects?.length) void this.runEffects(d.id);
    this.workPending = remaining.length > 0;
  }

  /** Once at ledger attach. */
  recoverOnLedgerAttach(): void { this.recovered = true; this.recover(); }

  /**
   * From the pairing service's 5 s leaseTick, before its lease-holder early return, whatever the
   * browser switch says (it only finishes recorded work). Does nothing when no work is pending.
   */
  tick(): void {
    if (this.notifyingWatch) {
      try {
        const stuck = this.svc.devices.stuckNotifying(BROWSER_NOTIFYING_STUCK_MS);
        for (const d of stuck) {
          if (this.svc.devices.removeIfStillSettingUp(d.id)) {
            this.svc.dropSetupSecrets(d.id);
            featureEvidence.record(BROWSER_FEATURE, { kind: 'held', reason: 'setup removed: approval message never finished sending', context: { deviceId: d.id } });
          }
        }
        this.notifyingWatch = this.svc.devices.list().some((d) => isBrowserDevice(d) && d.status === 'pending' && d.setupState === 'notifying');
      } catch (err) { this.svc.deps.reportDegradation?.('MobilePairing.browserStuckSweep', err); }
    }
    if (!this.workPending) return;
    // Until the ledger attach has run, leave intents to it (it may still be on its way at boot).
    if (!this.recovered && this.svc.keyLedger) return;
    this.recover();
  }

  /** Run every due effect of one record; one attempt in flight per record. */
  /* @self-action-controller: browser-activation-effect-retry */
  async runEffects(deviceId: string): Promise<void> {
    if (this.inFlight.has(deviceId)) return;
    this.inFlight.add(deviceId);
    try {
      const d = this.svc.devices.get(deviceId);
      if (!d?.effects?.length) return;
      const t = this.now();
      const next: BrowserEffect[] = [];
      for (const e0 of d.effects) {
        const e: BrowserEffect = { ...e0 };
        if (Date.parse(e.nextAt) > t) { next.push(e); continue; }
        let ok = false;
        let why = '';
        try {
          ok = e.kind === 'revokeReplaced' ? this.revokeReplaced(d) : await this.raiseNotice(d, e);
        } catch (err) { why = err instanceof Error ? err.message : String(err); ok = false; }
        if (ok) continue;
        e.attempts += 1;
        e.nextAt = new Date(nextEffectAttemptAt(e.attempts, t)).toISOString();
        if (e.attempts >= EFFECT_REPORT_AFTER && !e.reportedAt) {
          e.reportedAt = new Date(t).toISOString();
          const leaseNote = e.kind === 'notice' && !this.svc.holdsLease() ? ' This machine does not hold the serving lease, which is likely why the Telegram notice fails.' : '';
          this.svc.deps.reportDegradation?.('MobilePairing.browserEffects', new Error(`Browser ${d.deviceName ?? d.id} (key ${d.fingerprint ?? 'unknown'}): "${e.kind}" has failed ${e.attempts} times${why ? ` (${why})` : ''}. It keeps retrying hourly and at every start-up.${leaseNote}`));
        }
        if (e.kind === 'notice' && e.attempts >= EFFECT_REPORT_AFTER && !e.fallbackRaisedAt) {
          // One local attention item with one push, so the owner hears while the Telegram item keeps failing.
          const raised = await this.raiseNoticeVia(d, { localOnly: true }).catch(() => false);
          if (raised) e.fallbackRaisedAt = new Date(t).toISOString();
        }
        featureEvidence.record(BROWSER_FEATURE, { kind: 'error', reason: `activation effect failed: ${e.kind}`, context: { deviceId, attempts: e.attempts } });
        next.push(e);
      }
      this.svc.devices.setEffects(deviceId, next);
      if (next.length) this.workPending = true;
    } catch (err) {
      this.svc.deps.reportDegradation?.('MobilePairing.browserEffects', err);
      this.workPending = true;
    } finally { this.inFlight.delete(deviceId); }
  }

  /**
   * Retire the replaced browser: this machine writes the ledger revocation row itself (from the
   * key in that device's ledger activation row); every machine's authenticator refuses a key with
   * a revocation row once it replicates. `forwardRevoke` is only an extra, best-effort, once.
   */
  private revokeReplaced(d: DeviceRecord): boolean {
    const r = d.replaces;
    if (!r) return true;
    const ledger = this.svc.keyLedger;
    if (!ledger) return false;
    const act = ledger.activationFor(r.deviceId);
    if (!act || act.keyHash !== r.keyHash) throw new Error('the replaced browser has no matching ledger activation row');
    const at = new Date(this.now()).toISOString();
    ledger.recordRevocation({ id: r.deviceId, publicKey: act.publicKey }, at); // null when already there: complete
    try { this.svc.devices.revoke(r.deviceId, at); } catch (err) { this.svc.deps.reportDegradation?.('MobilePairing.registryWrite', err); }
    this.svc.forwardRevokeOnce(r.deviceId);
    featureEvidence.record(BROWSER_FEATURE, { kind: 'fired', reason: 'replaced browser retired', context: { deviceId: d.id, replaced: r.deviceId } });
    return true;
  }

  private noticeText(d: DeviceRecord): { key: string; title: string; body: string } {
    const name = d.deviceName ?? 'A browser';
    const how = APPROVED_HOW[d.approvedVia ?? ''] ?? 'by the owner';
    const where = 'People > Phones in the dashboard';
    const body = d.status === 'revoked'
      ? `A browser was set up and has since been removed: ${name} (key ${d.fingerprint ?? 'unknown'}), approved ${how}. If that wasn't you, someone could set one up again; check ${where}.`
      : `${name} (key ${d.fingerprint ?? 'unknown'}) was approved ${how} and can now send messages in your conversations from the dashboard. If this wasn't you, remove it in ${where}.`;
    return { key: `mobile-pairing:browser:${d.id}`, title: 'A browser can now send messages as you', body };
  }

  private raiseNoticeVia(d: DeviceRecord, opts: { localOnly: boolean }): Promise<boolean> {
    const raise = this.svc.deps.raiseBrowserNotice;
    // No notice surface wired (a test service): nothing to retry.
    if (!raise) return Promise.resolve(true);
    return raise(this.noticeText(d), opts);
  }

  private async raiseNotice(d: DeviceRecord, e: BrowserEffect): Promise<boolean> {
    // After the one-time local fallback, retries attempt only the Telegram item (§4.2 step 10).
    const ok = await this.raiseNoticeVia(d, { localOnly: false });
    if (ok) featureEvidence.record(BROWSER_FEATURE, { kind: 'fired', reason: 'owner notice raised', context: { deviceId: d.id, attempts: e.attempts } });
    return ok;
  }
}

/** The owner's private message for a browser setup (§4.2 step 9). */
export function browserApprovalText(agent: string, d: DeviceRecord, codeLine: string, canApprove: boolean): string {
  return (canApprove ? [
    `A browser is asking to use your conversations with ${agent}. Approve only if you are setting up a browser right now and this key matches the one it shows.`,
    `Browser key: ${d.fingerprint ?? 'unknown'}\nBrowser name: ${d.deviceName ?? '(none given)'} (the browser chose this name)`,
    `If you did not start this, tap Decline.`,
    `If the browser asks for a code instead: ${codeLine} Don't send or show this message to anyone, including me.`,
  ] : [
    codeLine,
    `Type it into the browser only if you are setting up a browser right now. If you did not start this, tap Decline. Don't send or show this message to anyone, including me.`,
    `Browser key: ${d.fingerprint ?? 'unknown'}\nBrowser name: ${d.deviceName ?? '(none given)'}`,
  ]).join('\n\n');
}

/**
 * A paired owner iPhone that can approve this browser with Face ID right now. When there is one it is the
 * first way shown, ahead of the private Telegram message (operator 2026-11-09: "Why can't the iphone app
 * be used for this approval flow?"); Telegram stays as the backup route.
 */
function phoneApproves(svc: MobilePairingService, d: DeviceRecord): boolean {
  return isPairingApproveEnabled(svc.deps.config) && svc.approvable(d) && svc.ownerPhoneCanApprove();
}

function setupView(d: DeviceRecord, svc: MobilePairingService, host: string, telegramBackup?: boolean): Record<string, unknown> {
  const phone = svc.approvalPath() === 'telegram' && phoneApproves(svc, d);
  return {
    deviceId: d.id, machineId: svc.deps.selfMachineId ?? null, host, status: d.status,
    approval: phone ? 'owner-phone' : svc.approvalPath(), fingerprint: d.fingerprint ?? null,
    ...(phone ? { telegramBackup: telegramBackup ?? true } : {}),
    ...(d.status === 'pending' && d.expiresAt ? { expiresAt: d.expiresAt } : {}),
  };
}

function sessionHash(token: string): string { return crypto.createHash('sha256').update(token).digest('hex'); }

function machineNickname(svc: MobilePairingService, machineId: string | null | undefined): string | null {
  if (!machineId) return null;
  try { return svc.deps.siblings?.().find((m) => m.machineId === machineId)?.name ?? null; } catch { return null; } // @silent-fallback-ok — a display name only
}

/** The browser key's state for the status route, in the §4.6 precedence. */
export function browserKeyState(svc: MobilePairingService, keyHash: string): Record<string, unknown> {
  const ledger = svc.keyLedger;
  if (!ledger) return { state: 'unknown' };
  let rows: ReturnType<NonNullable<typeof ledger>['rows']>;
  try { rows = ledger.rows(); } catch { return { state: 'unknown' }; } // @silent-fallback-ok — "couldn't check" is the answer; the page keeps its key
  if (rows.some((r) => r.type === 'revocation' && r.keyHash === keyHash)) return { state: 'revoked' };
  const local = svc.devices.list().find((d) => isBrowserDevice(d) && d.browserPublicKey && keyHashOf(d.browserPublicKey) === keyHash);
  if (local) {
    const reason = svc.browser.recentRefusal(local.id);
    const state = local.status === 'legacy-token' ? 'not-found' : local.status;
    return { state, deviceId: local.id, ...(reason ? { reason } : {}) };
  }
  const self = svc.deps.selfMachineId ?? null;
  const act = rows.find((r) => r.type === 'activation' && r.keyHash === keyHash && r.machineId !== self);
  if (act) return { state: 'elsewhere', machineId: act.machineId, nickname: machineNickname(svc, act.machineId) };
  return { state: 'not-found' };
}

/** Bearer routes for browser setup (§4.2) and status (§4.6). */
export function mountBrowserDeviceRoutes(
  router: Router, svc: MobilePairingService,
  opts: { verifyOperatorSession?: (token: string | undefined) => boolean; telegramConfigured?: () => boolean; approvalChat?: () => Promise<{ name: string; username: string | null } | null> },
): void {
  router.get('/mobile/browser-devices/status', async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!svc.browserOn()) { res.status(503).json({ error: 'browser-devices-off', detail: 'Conversations in the dashboard are switched off on this agent.' }); return; }
    if (principalOf(req).kind !== 'token') { res.status(403).json({ error: 'bearer-required' }); return; }
    const machineId = svc.deps.selfMachineId ?? null;
    const kh = typeof req.query.keyHash === 'string' ? req.query.keyHash.toLowerCase() : null;
    if (kh !== null && !/^[0-9a-f]{64}$/.test(kh)) { res.status(400).json({ error: 'bad-key-hash' }); return; }
    // Which private chat the approval message arrives in, by the bot's own name, so a missed message is found.
    const approvalChat = svc.approvalPath() === 'telegram' && opts.approvalChat
      ? await Promise.race([opts.approvalChat().catch(() => null), new Promise<null>((r) => setTimeout(() => r(null), 1500).unref?.())])
      : null;
    res.json({
      enabled: true, machineId, nickname: machineNickname(svc, machineId) ?? svc.deps.config.projectName ?? null, approvalChat,
      serverTime: Date.now(), approvalPath: svc.approvalPath(), approveEnabled: isPairingApproveEnabled(svc.deps.config),
      ownerPhoneApproves: isPairingApproveEnabled(svc.deps.config) && svc.ownerPhoneCanApprove(),
      // Sending into Telegram from the app speaks as the Telegram owner and needs the serving lease.
      telegramSend: !!opts.telegramConfigured?.() && svc.holdsLease() && (svc.deps.telegramOwnerPresent ? svc.deps.telegramOwnerPresent() : true),
      limits: { maxFiles: MAX_ATTACHMENTS, maxMessageBytes: MAX_MESSAGE_BYTES, maxFileBytes: MAX_FILE_BYTES, chunkBytes: CHUNK_BYTES },
      ...(kh ? { key: browserKeyState(svc, kh) } : {}),
    });
  });

  router.post('/mobile/browser-devices', async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    const held = (status: number, error: string, extra: Record<string, unknown> = {}): void => {
      featureEvidence.recordAtMostEvery(BROWSER_FEATURE, `setup|${error}`, 60_000, { kind: 'held', reason: `setup refused: ${error}` });
      res.status(status).json({ error, ...extra });
    };
    // 1. Switches.
    if (!svc.browserOn()) { held(503, 'browser-devices-off', { detail: 'Conversations in the dashboard are switched off on this agent.' }); return; }
    // A browser is recorded in the device-key ledger before it is active; without one nothing could
    // be approved, so the setup is refused before anything is charged (second-pass review).
    if (!svc.keyLedger) { held(503, 'ledger-unavailable', { detail: 'This machine cannot record new devices right now (it has no device-key record). Try again after it restarts.' }); return; }
    if (svc.devices.pairingPaused()) { held(429, 'pairing-paused', { detail: 'Too many wrong codes were typed recently, so setting up new devices is paused for now.' }); return; }
    // 2. The bound host, before anything else and without the session.
    const host = boundSetupHost(req, svc);
    if (!host) { held(403, 'not-secure-address', { detail: 'Open the dashboard at this agent\'s secure address (or at localhost on this computer) to set up this browser.' }); return; }
    // 3. The key and its possession proof.
    const body = (req.body ?? {}) as Record<string, unknown>;
    const publicKey = typeof body.publicKey === 'string' ? body.publicKey : '';
    const enrollmentId = typeof body.enrollmentId === 'string' ? body.enrollmentId : '';
    const timeMs = typeof body.timeMs === 'string' ? body.timeMs : typeof body.timeMs === 'number' ? String(body.timeMs) : '';
    if (!parseDevicePublicKey(publicKey) || !REQUEST_ID_RE.test(enrollmentId) || !/^\d{10,16}$/.test(timeMs)
      || Math.abs(Date.now() - Number(timeMs)) > SETUP_TIME_WINDOW_MS
      || !verifyP256(publicKey, enrollProofMessage(host, publicKey, enrollmentId, timeMs), body.proof)) {
      held(400, 'browser-proof-invalid', { detail: 'The browser\'s setup request could not be checked. Reload the page and try again; if it keeps happening, check this computer\'s clock.' });
      return;
    }
    // ── Steps 4 to 8 run in one synchronous step: no await until the record is written. ──
    // 4. A retry of the same setup is answered here, before anything is charged.
    const existing = svc.devices.findBrowserByKey(publicKey);
    if (existing) {
      if (existing.host === host && existing.enrollmentId === enrollmentId) {
        if (existing.status === 'pending' && existing.setupState === 'notifying' && !existing.activating) {
          if (Date.now() - Date.parse(existing.notifyingSince ?? existing.pairedAt) > BROWSER_NOTIFYING_STUCK_MS) {
            if (svc.devices.removeIfStillSettingUp(existing.id)) svc.dropSetupSecrets(existing.id);
            held(409, 'approval-unavailable', { detail: 'The approval message could not be sent. Try again.' });
            return;
          }
          res.status(202).json({ state: 'notifying' });
          return;
        }
        res.status(200).json(setupView(existing, svc, host));
        return;
      }
      held(409, 'duplicate-key');
      return;
    }
    const kh = keyHashOf(publicKey);
    let ledgerHasKey = false;
    try { ledgerHasKey = !!svc.keyLedger && svc.keyLedger.rows().some((r) => r.keyHash === kh); } catch (err) {
      // @silent-fallback-ok — not silent: reported through deps.reportDegradation (DegradationReporter in production), and the setup is refused 503
      svc.deps.reportDegradation?.('MobilePairing.keyLedger', err);
      res.status(503).json({ error: 'ledger-unreadable', detail: 'This agent could not read its device-key record. Try again shortly.' });
      return;
    }
    if (ledgerHasKey || svc.devices.holdsKey(publicKey) || svc.devices.list().some((d) => isBrowserDevice(d) && d.enrollmentId === enrollmentId)) {
      held(409, 'duplicate-key');
      return;
    }
    // 5. The operator session (a fresh PIN unlock), never reused for a second record.
    const session = req.get('X-Instar-Operator-Session');
    if (principalOf(req).kind !== 'token' || !session || !opts.verifyOperatorSession?.(session)) {
      held(403, 'operator-session-required', { detail: 'Unlock the dashboard with your PIN to set up this browser.' });
      return;
    }
    // 7. `replaces`, checked against the ledger activation row of the old device (any machine).
    let replaces: { deviceId: string; keyHash: string } | null = null;
    if (body.replaces !== undefined && body.replaces !== null) {
      const r = body.replaces as Record<string, unknown>;
      const oldId = typeof r.deviceId === 'string' ? r.deviceId : '';
      const act = oldId && svc.keyLedger ? svc.keyLedger.activationFor(oldId) : null;
      const pendingNamesIt = svc.devices.list().some((d) => d.status === 'pending' && d.replaces?.deviceId === oldId);
      if (!act || act.client !== 'browser' || svc.keyLedger!.keyRevoked(act.keyHash) || pendingNamesIt
        || !verifyP256(act.publicKey, replaceMessage(oldId, publicKey, host, enrollmentId), r.sig)) {
        held(400, 'replaces-invalid', { detail: 'The browser this setup replaces could not be confirmed. Set up this browser without replacing the old one, then remove the old one in People > Phones.' });
        return;
      }
      replaces = { deviceId: oldId, keyHash: act.keyHash };
    }
    // 6 + 8. Limits and the record, in one registry write (the setup slot is reserved with it).
    const limits = browserLimits(svc.deps.config);
    let revokedKeys: Set<string> | undefined;
    try { revokedKeys = svc.keyLedger?.revokedKeyHashes(); } catch { revokedKeys = undefined; } // @silent-fallback-ok — counting without the ledger is the stricter count
    const deviceName = cleanText(body.deviceName)?.slice(0, 60) || 'Browser';
    let created: ReturnType<typeof svc.devices.createPendingBrowser>;
    try {
      created = svc.devices.createPendingBrowser({
        browserPublicKey: publicKey, host, deviceName, enrollmentId, replaces, session: sessionHash(session),
        maxBrowsers: limits.maxBrowsers, maxSetupsPerHour: limits.maxSetupsPerHour, ledgerRevokedKeyHashes: revokedKeys,
      });
    } catch (err) {
      svc.deps.reportDegradation?.('MobilePairing.registryWrite', err);
      featureEvidence.record(BROWSER_FEATURE, { kind: 'error', reason: 'setup failed: registry write' });
      res.status(500).json({ error: 'Could not record this browser. Try again.' });
      return;
    }
    if (!created.ok) {
      if (created.reason === 'too-many-browsers') {
        held(429, 'too-many-browsers', { detail: `This machine already has ${limits.maxBrowsers} browsers set up. Remove one in People > Phones first.`,
          browsers: created.browsers.sort((a, b) => String(b.lastSeenAt ?? b.pairedAt).localeCompare(String(a.lastSeenAt ?? a.pairedAt)))
            .map((d) => ({ deviceId: d.id, deviceName: d.deviceName, status: d.status, lastSeenAt: d.lastSeenAt ?? null })) });
      } else if (created.reason === 'too-many-setups') {
        held(429, 'too-many-setups', { nextAt: new Date(created.nextAt).toISOString(), nextAllowedAt: new Date(created.nextAt).toISOString(), detail: `Too many browsers were set up in the last hour. The next one can be set up at ${new Date(created.nextAt).toISOString()}.` });
      } else if (created.reason === 'session-used') {
        held(403, 'operator-session-required', { detail: 'Unlock the dashboard with your PIN again to set up this browser.' });
      } else if (created.reason === 'duplicate-key') {
        held(409, 'duplicate-key');
      } else {
        held(429, 'pairing-paused');
      }
      return;
    }
    const device = created.device;
    featureEvidence.record(BROWSER_FEATURE, { kind: 'fired', reason: 'setup created', context: { deviceId: device.id, replacing: !!replaces, loopback: isLoopbackHost(host) } });
    // 9. Approval, by the agent's own approval path.
    const path = svc.approvalPath();
    if (path === null || (path === 'telegram' && !svc.holdsLease())) {
      if (svc.devices.removeIfStillSettingUp(device.id)) svc.dropSetupSecrets(device.id);
      held(409, 'approval-unavailable', { detail: path === null
        ? 'This agent has no way to approve a new browser right now.'
        : 'Set up this browser from the machine serving Telegram: that is where the approval message comes from.' });
      return;
    }
    if (path === 'dashboard') {
      // No Telegram owner: the live operator session approves in this request (dashboard-pin).
      const r = svc.browser.activate(device.id, 'dashboard-pin', { ownRequest: true });
      if (r !== 'activated') {
        // Nothing was approved: the setup goes and its slot comes back (a record with an intent stays for recovery).
        if (svc.devices.removeIfStillSettingUp(device.id)) svc.dropSetupSecrets(device.id);
        res.status(r === 'not-pending' ? 409 : 500).json({ error: r === 'not-pending' ? 'not-pending' : 'Could not finish setting up this browser. Try again.' });
        return;
      }
      res.status(201).json(setupView(svc.devices.get(device.id) ?? device, svc, host));
      return;
    }
    svc.browser.noteNotifying();
    const sent = await svc.sendBrowserApproval(device);
    if (!sent && phoneApproves(svc, device)) {
      // The Telegram copy did not go out, but the owner's iPhone can approve: keep the setup and say so.
      featureEvidence.record(BROWSER_FEATURE, { kind: 'fired', reason: 'setup kept: phone approves, Telegram copy not delivered', context: { deviceId: device.id } });
    } else if (!sent) {
      if (svc.devices.removeIfStillSettingUp(device.id)) svc.dropSetupSecrets(device.id);
      featureEvidence.record(BROWSER_FEATURE, { kind: 'error', reason: 'setup failed: approval message not delivered', context: { deviceId: device.id } });
      res.status(409).json({ error: 'approval-unavailable', detail: 'I could not send you the approval message in Telegram. Open a private chat with the bot and send it any message, then try again.' });
      return;
    }
    // The stuck-setup sweep may have removed it while the message was still sending (over 30 s):
    // then the message's buttons answer "ended", and this answer says so too.
    if (!svc.devices.setSetupState(device.id, 'awaiting', 'notifying')) {
      svc.dropSetupSecrets(device.id);
      res.status(409).json({ error: 'approval-unavailable', detail: 'The approval message took too long to send. Try again.' });
      return;
    }
    const now = svc.devices.get(device.id) ?? device;
    svc.notifyOwnerPhones(now);
    res.status(201).json({ ...setupView(now, svc, host, !!sent), codeFormat: 'word' });
  });
}

