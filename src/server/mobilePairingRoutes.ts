import type { AccessStamp } from '../core/TeamAccessMerge.js';
import type { TeamAccessPuller } from '../core/TeamAccessSync.js';
import type { TeamSwitchLine } from '../core/TeamSwitches.js';
import type { TeamActionKind } from './mobilePermissionsRoutes.js';
import { storageErrorResponse } from '../core/storageMachineName.js';
import { verifiedInboundMirrorEnvelope, isQuietReceipt, QuietRecordedError } from '../messaging/NotificationSelectivityGate.js';
import { notificationStamper, withNotificationEnvelope } from '../messaging/notificationStampers.js';
const stampNotification = notificationStamper('src/server/mobilePairingRoutes.ts');
/**
 * Mobile pairing links (docs/specs/mobile-pairing-link.md).
 *
 * Device keys (docs/specs/mobile-device-keys.md): redeem registers the phone's Secure Enclave
 * public key as a PENDING device and sends a 6-digit code only to the owner's private Telegram
 * chat — or, with no Telegram owner (mobile-native-conversations §4.4), shows it only to a
 * dashboard PIN session (GET /mobile/pairing-approvals); the phone confirms with that code
 * (device-signed) and from then on signs allowlisted requests. Redeem never returns the API token.
 *
 * Public (registered before the bearer gate, each by an exact path+method):
 *   POST /mobile/pairing-codes/redeem   one-time code + device public key → a pending device
 *   GET  /mobile/pairing-codes/ping     self-probe answer: sha256(processSecret + nonce)
 * Bearer:
 *   POST /mobile/pairing-codes          mint a code + the v1 instar.sh link
 *   GET  /mobile/devices                the paired-phones log (scope=pool merges machines)
 *
 * Every route answers 503 while the feature gate (mobilePairing.enabled, dev-agent gated)
 * resolves off; the gate is read live from config.
 *
 * Multi-route (docs/specs/mobile-multi-route.md, mobilePairing.multiRoute.enabled, dev-agent
 * gated, read at boot): a device signature is accepted on any of this machine's proven own
 * names (src/core/MobileOwnNames.ts) when the request arrived through its local TLS front, and
 * GET /mobile/routes (device-signed) lists those names for the app.
 */
import { codePageUrlForDevice, codePageUrlForOrigin } from './dashboardPaths.js';
import crypto from 'node:crypto';
import { Router, type Request, type Response, type Application } from 'express';
import { resolveDevAgentGate } from '../core/devAgentGate.js';
import { arrivedOverLocalTls } from '../core/desktopTransport.js';
import {
  PairingCodeStore, NONCE_PATTERN, buildPairLink, cleanText, codeTtlMs, pingAnswer, stableOrigin,
  type MobilePairingConfig,
} from '../core/MobilePairing.js';
import type { InstarConfig } from '../core/types.js';
import { featureEvidence } from '../monitoring/FeatureEvidenceLog.js';
import {
  ConfirmationCodes, DeviceRegistry, displayCode, type ApprovedVia, type CodeFormat, ReplayGuard, parseDevicePublicKey, verifyDeviceRequest,
  type DeviceRecord, type DeviceStatus, deviceKeyOf, isBrowserDevice, keyHashOf,
} from '../core/MobileDeviceKeys.js';
import { mirrorPrefix, requestDeviceClient } from '../core/deviceClientWording.js';
import {
  BrowserDeviceController, browserApprovalText, isBrowserDevicesEnabled, isLoopbackHost, loopbackBindingOk, mountBrowserDeviceRoutes,
  type BrowserNoticeRaiser,
} from './mobileBrowserDevices.js';
import { isPeerUrlAllowedForCredentials } from './peerUrlGuard.js';
import { poolPeerFetch } from './poolPeerFetch.js';
import type { RouteContext } from './routes.js';
import { MobileOwnNames, normalizeRequestHost, type TailscaleExec } from '../core/MobileOwnNames.js';
import { MobileChatRequestStore, payloadHash, requestIdAgeOk, requestIdTime } from '../core/MobileChatRequests.js';
import type { MobilePushService, PushTrigger } from '../core/MobilePush.js';
import { detectOutboundCredential } from '../messaging/outbound-credential-guard.js';
import { PairingInviteTelegram } from '../threadline/PairingInviteTelegram.js';
import { APP_CONVERSATION_KEY_PATTERN, derivedEventId, hideCredentialSpans, removeAuthorityTokens } from '../core/appConversationText.js';
import type { MobileDeviceKeyLedger } from '../core/MobileDeviceKeyLedger.js';
import { deviceKeyHashOf, identityKeyLookup, loadMachineSigner } from '../core/AppRecordSignatures.js';
import { TeamAccessLog, rowSignedByKnownMachine, verifyTeamAccessRow } from '../core/TeamAccessLog.js';
import { TeamConfinement } from '../users/TeamConfinement.js';
import { attentionForNonOwner, tierAtLeast, tierOfRole, type ConversationOp, type Tier } from '../permissions/TeamAccess.js';
import { buildSignedOrigin } from './mobileConversationRoutes.js';
import { activeOwnerPhone, mountConsoleTicketDeviceRoutes } from './mobileConsoleTicket.js';
import { mountPairingApprovalDeviceRoutes } from './mobilePairingApproval.js';
import { mountIntroducerRoutes, mountIntroductionRedeemRoute, ownerIntroducers, type Introducer } from './mobilePairingIntroducer.js';
import {
  checkSignedFiles, claimMediaUploads, mediaRecordTooLarge, mirrorMediaToTelegram, preflightMediaAttachments, publishMediaMessage, signedFileHashParts,
  type SignedAttachment, type TelegramMediaMirrorTarget,
} from './mobileMediaSend.js';
import { isExactStopMessage } from '../core/MessageSentinel.js';
import type { AppAttachment } from '../core/appMediaTypes.js';
import type { MediaMessageEvent, MessageEvent } from '../core/AppConversationStore.js';
import { UserManager } from '../users/UserManager.js';
import { MspGrantStore } from '../core/MobileMspGrants.js';
import {
  choosePerson, devicePerson, isOwnerPerson, mayUseConversation, personLabel,
  type ConversationOwner, type DevicePerson, type OwnerIdentity, type PeopleLookup, type PersonProfile, type ResolvedPerson, type TeamStanding,
} from '../core/MobilePeople.js';
import { parseReaderKey } from '../core/ConversationReadMarkers.js';
import { MEDIA_OFF_ACTION } from './mobileMediaOff.js';

export const MOBILE_REDEEM_PATH = '/mobile/pairing-codes/redeem';
export const MOBILE_PING_PATH = '/mobile/pairing-codes/ping';
const PROBES = 8;
const PROBE_TIMEOUT_MS = 4000;
const PING_LIMIT_PER_MIN = 60;
const SELF_NONCE_TTL_MS = 60_000;

/** The slice of the tunnel manager these routes read. */
export interface PairingTunnelView {
  lifecycleState: { lastState: string; activeProvider: string | null };
}

/** Another machine of this agent, from the machine registry. */
export interface PairingSiblingView { machineId: string; name?: string; status?: string; lastKnownUrl?: string }

export interface MobilePairingDeps {
  config: InstarConfig;
  /** Whether team phones may work right now (§3.6, §4.1). Absent refuses them. */
  teamGate?: () => 'ok' | 'memory-privacy-required';
  stateDir: string;
  tunnel?: () => PairingTunnelView | undefined;
  selfMachineId?: string | null;
  siblings?: () => PairingSiblingView[];
  /** Probe our own stable origin; injectable for tests. */
  fetchFn?: typeof fetch;
  /**
   * Send the owner's private chat a message, with a Decline button and (mobile-pairing-approve §3.2)
   * an Approve button when their data is given; resolves to the Telegram message id, or null.
   */
  ownerDM?: (text: string, declineData: string, approveData?: string) => Promise<number | null>;
  /**
   * Whether a Telegram owner is known (mobile-native-conversations §4.4): with one, the code goes
   * to the owner's private chat; without one (and native conversations on), the dashboard path.
   * Absent ⇒ `ownerDM` presence decides, as before.
   */
  telegramOwnerPresent?: () => boolean;
  /** Whether this machine holds the serving lease (single machine: true). */
  holdsLease?: () => boolean;
  /** Raise one attention item (pairing paused by wrong codes). */
  raiseAttention?: (title: string, body: string) => void;
  reportDegradation?: (what: string, err: unknown) => void;
  /** Multi-route: runs the Tailscale CLI; null/absent ⇒ no Tailscale candidate is read. */
  tailscaleExec?: TailscaleExec | null;
  /** Multi-route: this process runs under WSL (Tailscale is the Windows side, tailscale.exe). */
  isWsl?: boolean;
  /**
   * People and roles (docs/specs/mobile-app-people-and-roles.md): the agent's user registry, read
   * only. Absent ⇒ read `users.json` under the state dir (plus `config.users`) on each lookup.
   */
  people?: () => PeopleLookup | null;
  /** The Telegram owner's numeric id, when the agent has one. */
  telegramOwnerId?: () => number | null;
  /**
   * The id that namespaces stored person references: the SAME id the app conversation store
   * stamps on its events (`meshSelfId ?? coordinator id ?? 'local'`). Absent ⇒ `selfMachineId`.
   */
  peopleMachineId?: () => string;
  /** This agent's own identity key, for vouching for its owner's phones (mobile-pairing-introducer §3.2). */
  readIdentity?: () => { publicKey: Buffer; privateKey: Buffer } | null;
  /**
   * Raise the owner's security notice for a new browser (dashboard-conversations-browser-device
   * §4.2 step 10): a Telegram attention item when Telegram is configured, else the local attention
   * list plus a push to owner phones; `localOnly` forces the local item and its one push.
   * Resolves true once raised.
   */
  raiseBrowserNotice?: BrowserNoticeRaiser;
}

/** The default people lookup: the registry on disk (read-only, no writes) plus `config.users`. */
export function registryPeople(stateDir: string, configUsers: PersonProfile[] | undefined): PeopleLookup {
  const byId = new Map<string, PersonProfile>();
  for (const u of configUsers ?? []) if (u && typeof u.id === 'string') byId.set(u.id, u);
  try {
    for (const u of UserManager.readProfilesFromDisk(stateDir).profiles) byId.set(u.id, u);
  } catch { /* @silent-fallback-ok — an unreadable users.json resolves no MSP person: their phones are refused person-unknown (fail closed), owner phones are unaffected */ }
  return { getUser: (id) => byId.get(id) ?? null };
}

type PoolCtx = Pick<RouteContext, 'config' | 'resolvePeerUrls' | 'recordRopeResult'> & Partial<Pick<RouteContext, 'mobileInbound' | 'telegram' | 'localAttention' | 'appConversations' | 'verifyDashboardOperatorSession'>>;
const PEER_TIMEOUT_MS = 5000;
const MAX_PEER_BYTES = 128 * 1024;

/** Re-validate a peer's device row: fixed fields only, text re-cleaned, untrusted data. */
function sanitizePeerDevice(raw: unknown, machineId: string): Record<string, unknown> | null {
  if (!raw || typeof raw !== 'object') return null;
  const d = raw as Record<string, unknown>;
  if (typeof d.id !== 'string' || typeof d.pairedAt !== 'string' || Number.isNaN(Date.parse(d.pairedAt))) return null;
  return {
    id: d.id.slice(0, 64), deviceName: cleanText(d.deviceName), pairedAt: new Date(Date.parse(d.pairedAt)).toISOString(), label: cleanText(d.label), machine: machineId,
    // People and roles: a peer's person fields, re-validated (an unknown role reads as unassigned).
    role: d.role === 'msp' || d.role === 'team' ? d.role : 'owner', personName: cleanText(d.personName),
    ...(d.unassigned === true || (d.role !== undefined && d.role !== 'owner' && d.role !== 'msp' && d.role !== 'team') ? { unassigned: true } : {}),
  };
}

async function fetchPoolDevices(ctx: PoolCtx): Promise<{ rows: Array<Record<string, unknown>>; failed: Array<{ machineId: string; reason: string }> }> {
  const rows: Array<Record<string, unknown>> = [];
  const failed: Array<{ machineId: string; reason: string }> = [];
  const peers = (ctx.resolvePeerUrls?.() ?? []).slice(0, 16);
  const allow = (ctx.config.multiMachine as { peerUrlAllowlist?: string[] } | undefined)?.peerUrlAllowlist;
  await Promise.all(peers.map(async (p) => {
    if (!isPeerUrlAllowedForCredentials({ url: p.url, kind: p.kind }, allow).ok) { failed.push({ machineId: p.machineId, reason: 'omitted-cap' }); return; }
    try {
      const r = await poolPeerFetch(ctx.recordRopeResult ?? undefined, p, '/mobile/devices', {
        headers: { Authorization: `Bearer ${ctx.config.authToken}` }, signal: AbortSignal.timeout(PEER_TIMEOUT_MS),
      });
      if (!r.ok) { failed.push({ machineId: p.machineId, reason: r.status === 503 ? 'off' : `http-${r.status}` }); return; }
      const text = await r.text();
      if (Buffer.byteLength(text) > MAX_PEER_BYTES) { failed.push({ machineId: p.machineId, reason: 'too-large' }); return; }
      const body = JSON.parse(text) as { devices?: unknown };
      for (const raw of Array.isArray(body.devices) ? body.devices.slice(0, 200) : []) {
        const row = sanitizePeerDevice(raw, p.machineId);
        if (row) rows.push(row);
      }
    } catch (err) { // @silent-fallback-ok — the failure is a visible pool.failed row naming the machine
      failed.push({ machineId: p.machineId, reason: err instanceof Error && err.name === 'TimeoutError' ? 'deadline' : 'unreachable' });
    }
  }));
  return { rows, failed };
}

export function isMobilePairingEnabled(config: InstarConfig): boolean {
  return resolveDevAgentGate(config.mobilePairing?.enabled, config);
}

/**
 * `mobilePairing.multiRoute.enabled`, omitted ⇒ live on a development agent. Read at boot.
 * Multi-route is part of phone pairing: it is on only while pairing is on at boot (so the
 * tailscale-serve step and the probes never run for a feature that is off).
 */
export function isMobileMultiRouteEnabled(config: InstarConfig): boolean {
  return isMobilePairingEnabled(config) && resolveDevAgentGate(config.mobilePairing?.multiRoute?.enabled, config);
}

/** `mobilePairing.push.enabled`, omitted ⇒ follows mobilePairing. Read live. */
export function isMobilePushEnabled(config: InstarConfig): boolean {
  if (!isMobilePairingEnabled(config)) return false;
  return config.mobilePairing?.push?.enabled !== false;
}

/** `mobilePairing.chat.enabled`, omitted ⇒ follows mobilePairing. Read live. */
export function isMobileChatEnabled(config: InstarConfig): boolean {
  if (!isMobilePairingEnabled(config)) return false;
  return config.mobilePairing?.chat?.enabled !== false;
}

/**
 * `mobilePairing.native.enabled` (docs/specs/mobile-native-conversations.md): omitted ⇒ the
 * development-agent gate; requires mobilePairing itself. Read ONCE at boot by AgentServer.
 */
/** Media in app conversations (mobile-native-chat-media): dev-gated, needs native conversations. */
export function isMobileMediaEnabled(config: InstarConfig): boolean {
  return isMobileNativeEnabled(config) && resolveDevAgentGate(config.mobilePairing?.native?.media?.enabled, config);
}

export function isMobileNativeEnabled(config: InstarConfig): boolean {
  if (!isMobilePairingEnabled(config)) return false;
  return resolveDevAgentGate(config.mobilePairing?.native?.enabled, config);
}

/**
 * Unread counts, read reports and the app badge (docs/specs/mobile-unread-messages.md §3.5):
 * `mobilePairing.native.unread.enabled`, true when absent, so unread can be switched off alone;
 * needs native conversations. Read live.
 */
export function isMobileUnreadEnabled(config: InstarConfig): boolean {
  return isMobileNativeEnabled(config) && config.mobilePairing?.native?.unread?.enabled !== false;
}

/** `mobilePairing.approve.enabled` (docs/specs/mobile-pairing-approve.md §3.6): omitted ⇒ on wherever pairing is on. Read live. */
export function isPairingApproveEnabled(config: InstarConfig): boolean {
  return isMobilePairingEnabled(config) && config.mobilePairing?.approve?.enabled !== false;
}

/** What an approval attempt came to (spec §3.1). */
export type ApproveOutcome = 'approved' | 'ended' | 'paused' | 'moved' | 'another-phone-waiting' | 'contested' | 'code-only' | 'failed' | 'off';

/** One plain sentence per refusal, shared by every surface (spec §3.1). */
export const APPROVE_REFUSAL: Record<Exclude<ApproveOutcome, 'approved'>, { status: number; error: string; detail: string }> = {
  ended: { status: 409, error: 'pairing-ended', detail: 'That phone is no longer waiting: it was paired, declined, or its link expired.' },
  paused: { status: 429, error: 'pairing-paused', detail: 'Phone pairing is paused because too many wrong codes were typed, so nothing was approved.' },
  moved: { status: 409, error: 'approval-moved', detail: 'This pairing moved to another machine, so nothing was approved. Ask for a new link.' },
  'another-phone-waiting': { status: 409, error: 'another-phone-waiting', detail: 'Another phone is also waiting to pair, so nothing was approved. Decline the one that is not yours, then approve again.' },
  contested: { status: 409, error: 'pairing-contested', detail: 'More than one phone tried to pair at once, so this one cannot be approved with a tap. If it is yours, type its code into the app. If not, decline it.' },
  'code-only': { status: 409, error: 'code-required', detail: 'This phone is for someone else, so it pairs with the code: give it to them only if you want them to use the app with this agent.' },
  failed: { status: 500, error: 'approve-failed', detail: 'I could not record that, so nothing was approved. Try again.' },
  off: { status: 503, error: 'pairing-approve-off', detail: 'Approving phones is turned off on this agent. Use the code.' },
};

/** Answer an approval route from its outcome. */
export function approveAnswer(res: Response, outcome: ApproveOutcome, deviceId: string): void {
  if (outcome === 'approved') { res.json({ status: 'active', deviceId }); return; }
  const r = APPROVE_REFUSAL[outcome];
  res.status(r.status).json(outcome === 'failed' ? storageErrorResponse({ error: r.error, detail: r.detail }, res.app?.locals?.stateDir) : { error: r.error, detail: r.detail });
}

export class MobilePairingService {
  /** Native app conversations resolved on at boot (set by AgentServer). Gates the send-route rate move. */
  nativeOn = false;
  /**
   * The device-key ledger (mobile-native-conversations §4.6), set by AgentServer when native
   * conversations are on. Activation and revocation write their ledger row FIRST, then the
   * registry; boot reconciliation repairs a crash between the two in either direction.
   */
  keyLedger: MobileDeviceKeyLedger | null = null;
  private teamLogInstance: TeamAccessLog | null = null;
  readonly codes: PairingCodeStore;
  readonly devices: DeviceRegistry;
  readonly confirm: ConfirmationCodes;
  readonly replay: ReplayGuard;
  /** Decline-button nonce → device id (process memory). */
  readonly declineNonces = new Map<string, string>();
  /**
   * Dashboard-path pending devices (mobile-native-conversations §4.4): device id → the plaintext
   * confirmation code, in process memory ONLY, never on disk, for the pending device's life. Shown
   * only to a dashboard operator session; a restart loses it (the device expires at boot).
   */
  private readonly dashboardCodes = new Map<string, { code: string; expiresAt: number }>();
  private selfNonces = new Map<string, number>();
  private pingTimes: number[] = [];
  private deviceRate = new Map<string, number[]>();
  private deviceBucket = new Map<string, number[]>();
  /** This machine's own names; null when multi-route is off (read at boot). */
  readonly ownNames: MobileOwnNames | null;
  /** Mobile push (docs/specs/mobile-push.md), wired by AgentServer; null when not built. */
  push: MobilePushService | null = null;
  /** Peer resolution for the push fan-out, set once the route context exists. */
  pushPoolCtx: PoolCtx | null = null;
  /** Browser devices (dashboard-conversations-browser-device): activation, effects, recovery. */
  readonly browser: BrowserDeviceController;

  constructor(readonly deps: MobilePairingDeps, now: () => number = Date.now) {
    this.codes = new PairingCodeStore(now);
    this.devices = new DeviceRegistry(deps.stateDir, now);
    this.grants = new MspGrantStore(deps.stateDir, now);
    this.confirm = new ConfirmationCodes(now);
    this.replay = new ReplayGuard(now);
    this.now = now;
    this.ownNames = isMobileMultiRouteEnabled(deps.config) ? new MobileOwnNames({
      stateDir: deps.stateDir,
      port: deps.config.port,
      tunnelHost: () => { const o = this.origin(); return o ? new URL(o).host : null; },
      activeDeviceHosts: () => { try { return this.devices.list().filter((d) => d.status === 'active' && d.host).map((d) => d.host!); } catch { return []; } }, // @silent-fallback-ok — an unreadable registry seeds nothing; the probe loop proves the name instead
      issueNonce: () => this.issueSelfNonce(),
      expectedAnswer: pingAnswer,
      siblingClaims: (host) => this.siblingClaiming(host) !== null,
      pingPath: MOBILE_PING_PATH,
      active: () => this.enabled(),
      exec: deps.tailscaleExec ?? null,
      isWsl: deps.isWsl,
      fetchFn: deps.fetchFn,
      reportDegradation: deps.reportDegradation,
      now,
    }) : null;
    // Browser setups stuck sending their approval message are removed (their hourly slot comes
    // back), and recorded browser work is noted, before the boot expiry below (which skips
    // records carrying an activation intent; recovery runs when the key ledger is attached).
    this.browser = new BrowserDeviceController(this, now);
    this.browser.bootScan();
    // The confirmation-code key is per process: any device still pending from before
    // this boot can never be confirmed, so it is expired now (spec 2.2, Restarts).
    try { this.devices.expireAllPending(); } catch (err) { deps.reportDegradation?.('MobilePairing.bootExpiry', err); } // @silent-fallback-ok — reported through DegradationReporter
    // Lease watch (spec 2.2, Lease changes): the moment this machine is seen without the
    // serving lease, every live code is voided and pending devices expire, so a code issued
    // before a lease move can never confirm after the lease comes back.
    this.leaseTimer = setInterval(() => this.leaseTick(), 5_000);
    this.leaseTimer.unref?.();
  }
  private leaseTimer: ReturnType<typeof setInterval> | null = null;

  leaseTick(): void {
    this.confirm.prune();
    for (const [n, id] of this.declineNonces) { const d = this.devices.get(id); if (!d || d.status !== 'pending') this.declineNonces.delete(n); }
    this.pruneDashboardCodes();
    const t = this.now();
    for (const [h, e] of this.takenCodes) if (e.expiresAt <= t) this.takenCodes.delete(h);
    for (const id of this.contested) { const d = this.devices.get(id); if (!d || d.status !== 'pending') this.contested.delete(id); }
    // Browser work (stuck setups, activation intents, effects) runs whatever the lease or the
    // browser switch says: it only finishes recorded work. Nothing is read when none is pending.
    this.browser.tick();
    if (!this.enabled() || this.holdsLease()) return;
    // The Telegram path's code travels through the lease holder's adapter, so a lease move voids
    // it. A dashboard-path device has no such dependency and survives a lease move (§4.4).
    const keep = this.dashboardPendingIds();
    this.confirm.clearAll(keep);
    this.declineNonces.clear();
    try { this.devices.expireAllPending(keep); } catch (err) { this.deps.reportDegradation?.('MobilePairing.leaseExpiry', err); } // @silent-fallback-ok — reported through DegradationReporter
  }

  /**
   * How the next redeem's confirmation code reaches the operator (§4.4): `telegram` (the owner's
   * private chat) when a Telegram owner is present; otherwise `dashboard` (shown only to a
   * dashboard PIN session) when native conversations are on; otherwise null (the old refusal).
   */
  approvalPath(): 'telegram' | 'dashboard' | null {
    // A Telegram owner chat must really exist: `ownerDM` is wired even with no adapter, so it alone
    // proves nothing (fb-cceb7986-efa; mobile-pairing-introducer §3.5).
    const owner = this.deps.telegramOwnerPresent ? this.deps.telegramOwnerPresent() : true;
    if (this.deps.ownerDM && owner) return 'telegram';
    // No Telegram owner: the code is held for the pairing page when native conversations are on,
    // or when an owner introducer can finish the pairing (the code stays the fallback).
    if (this.nativeOn || this.introducers().length > 0) return 'dashboard';
    return null;
  }

  /**
   * The pairing page (or the legacy Phones tab) is open and unlocked right now: it polled the
   * approvals list with an operator session within the last 25 s (both pages poll every 10 s).
   * A display signal only (mobile-pairing-introducer §3.4); it grants nothing.
   */
  private pairingPageSeenAt = 0;
  notePairingPageSeen(): void { this.pairingPageSeenAt = this.now(); }
  pairingPageOpen(): boolean { return this.pairingPageSeenAt > 0 && this.now() - this.pairingPageSeenAt <= 25_000; }

  /** Owner introducers this agent's creator configured (mobile-pairing-introducer §3.1), from the running config: a file edit applies at the next restart. */
  introducers(): Introducer[] {
    return ownerIntroducers(this.deps.config, (err) => this.deps.reportDegradation?.('MobileIntroducer.config', err));
  }

  /** A pairing approved on an introducer's word: the record in the owner's private chat, when there is one. */
  tellOwnerIntroduced(introducerName: string, d: DeviceRecord): void {
    const text = `A phone was added to ${this.deps.config.projectName} with Face ID, vouched for by ${introducerName}: ${d.deviceName ?? 'unnamed'} (key ${d.fingerprint ?? 'unknown'}). If that was not you, remove it on the Phones page.`;
    void Promise.resolve(this.deps.ownerDM?.(text, '')).catch(() => { /* @silent-fallback-ok — a courtesy record; the activation already happened and shows on the Phones page */ });
  }

  /** Record a dashboard-path pending device's code (memory only). */
  holdDashboardCode(deviceId: string, code: string, expiresAt: number): void { this.dashboardCodes.set(deviceId, { code, expiresAt }); }
  isDashboardPending(deviceId: string): boolean { this.pruneDashboardCodes(); return this.dashboardCodes.has(deviceId); }
  dropDashboardCode(deviceId: string): void { this.dashboardCodes.delete(deviceId); }
  dashboardPendingIds(): Set<string> { this.pruneDashboardCodes(); return new Set(this.dashboardCodes.keys()); }

  /** Pending dashboard-path devices with their codes — for the operator-session route ONLY. */
  dashboardApprovals(): Array<{ device: DeviceRecord; code: string; expiresAt: number }> {
    this.pruneDashboardCodes();
    const out: Array<{ device: DeviceRecord; code: string; expiresAt: number }> = [];
    for (const [id, e] of this.dashboardCodes) {
      const d = this.devices.get(id);
      if (d && d.status === 'pending') out.push({ device: d, code: e.code, expiresAt: e.expiresAt });
    }
    return out;
  }

  private pruneDashboardCodes(): void {
    const t = this.now();
    for (const [id, e] of this.dashboardCodes) {
      if (e.expiresAt <= t) { this.dashboardCodes.delete(id); continue; }
      let d: DeviceRecord | null = null;
      try { d = this.devices.get(id); } catch { d = null; } // @silent-fallback-ok — an unreadable registry drops the code (fail closed: it is never shown, and never confirmable)
      if (!d || d.status !== 'pending') {
        // Drop BOTH copies: a dashboard code that is no longer shown must also never confirm, so a
        // decline whose registry write failed (or an unreadable registry) leaves nothing live.
        this.dashboardCodes.delete(id);
        this.confirm.drop(id);
      }
    }
  }

  stop(): void { if (this.leaseTimer) clearInterval(this.leaseTimer); this.leaseTimer = null; this.ownNames?.stop(); }

  // ── People and roles (docs/specs/mobile-app-people-and-roles.md) ──

  /**
   * The app conversation owner lookup (`CreatedEvent.ownerPerson`), set by AgentServer when the app
   * conversation store exists. `undefined` ⇒ no such conversation; `null` ⇒ an owner conversation.
   */
  appConversationOwner: ((key: string) => ConversationOwner | null | undefined) | null = null;

  /** Owner grants for MSP persons (§3.5), off by default. */
  readonly grants: MspGrantStore;

  /** Wire the app conversation store as the owner lookup (AgentServer; tests use the same call). */
  useAppConversationStore(store: { getConversation(key: string): { ownerPerson: ConversationOwner | null } | null; getMessageEvent?(key: string, messageId: string): object | null }): void {
    this.storedMessage = (key, id) => (store.getMessageEvent?.(key, id) ?? null) as StampedRow | null;
    this.appConversationOwner = (key) => {
      const c = store.getConversation(key);
      return c ? c.ownerPerson : undefined;
    };
  }

  /** This machine's id, the namespace of every stored person reference. */
  machineId(): string { return this.deps.peopleMachineId?.() ?? this.deps.selfMachineId ?? 'local'; }

  ownerIdentity(): OwnerIdentity {
    let telegramOwnerId: number | null = null;
    try { telegramOwnerId = this.deps.telegramOwnerId?.() ?? null; } catch { telegramOwnerId = null; } // @silent-fallback-ok — no Telegram owner id only means no profile matches by it
    const slackOwner = (this.deps.config.mobilePairing as { slackOwnerUserId?: unknown } | undefined)?.slackOwnerUserId;
    return {
      ownerName: cleanText(this.deps.config.threadline?.ownerName) ?? '', telegramOwnerId: typeof telegramOwnerId === 'number' ? telegramOwnerId : null,
      slackOwnerUserId: typeof slackOwner === 'string' && slackOwner ? slackOwner : null,
    };
  }

  people(): PeopleLookup | null {
    if (this.deps.people) return this.deps.people();
    return registryPeople(this.deps.stateDir, this.deps.config.users as PersonProfile[] | undefined);
  }

  /** Resolve a device record to its person (absent role ⇒ owner; a removed MSP person ⇒ person-unknown). */
  personOfDevice(d: DeviceRecord): DevicePerson {
    // The registry is read only for an MSP phone or an owner phone with a named profile.
    const needsRegistry = d.role === 'msp' || (d.role !== 'team' && !!d.userId);
    return devicePerson(d, needsRegistry ? this.people() : null, this.ownerIdentity(), (id) => this.grants.get(id), (key) => this.teamStanding(key));
  }

  /** The signed access log, opened once the key ledger exists; null while it does not. */
  teamLog(): TeamAccessLog | null {
    if (this.teamLogInstance) return this.teamLogInstance;
    const ledger = this.keyLedger;
    if (!ledger) return null;
    const { stateDir } = this.deps;
    const lookup = identityKeyLookup(stateDir);
    this.teamLogInstance = new TeamAccessLog({
      stateDir, signer: loadMachineSigner(stateDir),
      verify: (row) => verifyTeamAccessRow(row, ledger.view(), lookup),
      machineSigned: (row) => rowSignedByKnownMachine(row, lookup),
    });
    try {
      this.teamLogInstance.backfillConfineRows();
      this.bindTeamPhones();
    } catch (err) { this.deps.reportDegradation?.('TeamAccess.backfill', err); } // @silent-fallback-ok — reported; retried at the next boot
    return this.teamLogInstance;
  }

  /** A team person's standing, from the log alone. No log, an unreadable log or no person: no access. */
  teamStanding(personKey: string): TeamStanding | null {
    const log = this.teamLog();
    if (!log || log.healthState() !== 'ok') return null;
    const p = log.state().people.get(personKey);
    if (!p || !log.state().on) return null;
    const tier = tierOfRole(p.role);
    return tier === 'owner' ? null : { name: p.name, tier };
  }

  /** Why a team phone is refused right now, or null. Memory privacy is required, and stays required (§3.6). */
  teamRefusal(): 'memory-privacy-required' | 'access-being-checked' | null {
    const gate = this.deps.teamGate?.() ?? 'memory-privacy-required';
    if (gate !== 'ok') return gate;
    // A lost narrowing could have named anyone, so a gap holds everyone (Step 2b).
    return this.teamLog()?.gaps().length || (this.teamOn() && this.teamPuller?.refusing()) ? 'access-being-checked' : null;
  }

  /** A one-time link for a team person. Their phone's standing comes from the log, never the link. */
  mintTeamLink(personKey: string, label: string | null): { ok: true; link: string; expiresAt: string } | { ok: false; status: number; error: string } {
    const chosen = this.pairingOrigin();
    if (!chosen) return { ok: false, status: 503, error: 'no-pairing-origin' };
    const origin = `https://${chosen.host}`;
    const m = this.codes.mint(codeTtlMs(this.deps.config.mobilePairing), cleanText(label), this.deps.config.authToken ?? '', { host: chosen.host, kind: chosen.kind }, { userId: personKey, role: 'team' });
    if (!m.ok) return { ok: false, status: 429, error: m.reason };
    return { ok: true, link: buildPairLink(origin, m.code, this.deps.config.projectName), expiresAt: new Date(m.expiresAt).toISOString() };
  }

  /**
   * A conversation a team person creates is theirs, and confined from its first moment: its audience
   * is that person for good, whoever sends into it later (§3.5). Throws if the list cannot be read.
   */
  confineOwnConversation(ref: string, personKey: string): void {
    const log = this.teamLog();
    if (!log) throw new Error('team-access-unavailable');
    log.ensureConfinedFile();
    log.confine({ ref, placeKey: `app:${ref}`, personKey });
    log.appendMachineEvents([{ type: 'conversation-own', ref, personKey }]);
  }

  /** A removed person's phones stop being phones, so re-adding the key could never revive them (§3.4). */
  revokePersonPhones(personKey: string | null): void {
    for (const d of this.devices.list()) {
      if (d.role !== 'team' || d.status === 'revoked' || (personKey !== null && d.userId !== personKey)) continue;
      const at = new Date().toISOString();
      try { this.keyLedger?.recordRevocation(d, at); } catch (err) { this.deps.reportDegradation?.('MobilePairing.keyLedger', err); } // @silent-fallback-ok — reported; a failed ledger write never blocks a revocation
      this.devices.revoke(d.id, at);
      this.confirm.drop(d.id);
    }
  }

  /** A team phone's key, in the log, so every machine can tell whose it is (Step 2b). */
  bindTeamPhones(): void {
    const log = this.teamLog();
    if (!log || log.healthState() !== 'ok') return;
    for (const d of this.devices.list()) {
      if (d.role !== 'team' || d.status !== 'active' || !d.publicKey || !d.userId) continue;
      const keyHash = deviceKeyHashOf(d.publicKey);
      if (log.state().bindings.get(keyHash) !== d.userId) log.appendMachineEvents([{ type: 'phone-bind', keyHash, deviceId: d.id, boundTo: d.userId }]);
    }
  }

  /** A removal can arrive from another machine: this machine then revokes its own phones for that person. */
  reconcileTeamPhones(): void {
    const log = this.teamLog();
    if (!log || log.healthState() !== 'ok') return;
    this.teamGrantCheck?.();
    for (const d of this.devices.list()) {
      if (d.role !== 'team' || d.status === 'revoked' || !d.userId) continue;
      // Only a verified removal revokes: a phone can pair before its person's row arrives, and a revoked key is gone for good.
      if (log.wasRemoved(d.userId) && !this.teamStanding(d.userId)) this.revokePersonPhones(d.userId);
    }
  }

  reportTeamFault(feature: string, err: unknown): void { this.deps.reportDegradation?.(feature, err); }

  private storedMessage: (key: string, messageId: string) => StampedRow | null = () => null;

  /** The person's key, if a team phone is reading; everyone else reads by the existing rules. */
  private teamReaderKey(person: ResolvedPerson | null): string | null {
    return person?.role === 'team' && person.userId ? person.userId : null;
  }

  /** May this reader see this stored message? Rows with no stamp predate the rule, and every grant opens them. */
  mayReadStored(person: ResolvedPerson | null, ref: string, row: StampedRow): boolean {
    const key = this.teamReaderKey(person);
    if (!key || !row.accessStamp) return true;
    const log = this.teamLog();
    return !!log && log.mayRead(key, ref, row.accessStamp, row.senderPerson?.userId ?? null);
  }

  /** May this reader see the message with this id? One not held here yet is not shown. Telegram cannot be held. */
  mayReadMessageId(person: ResolvedPerson | null, ref: string, messageId: string): boolean {
    if (!this.teamReaderKey(person) || ref.startsWith('telegram:')) return true;
    const row = this.storedMessage(ref, messageId);
    return !!row && this.mayReadStored(person, ref, row);
  }

  /** The current readers a message is held from, by name, for the owner's view. */
  heldFrom(ref: string, row: StampedRow): string[] {
    const log = this.teamLog();
    if (!log || !row.accessStamp || !log.state().on) return [];
    const s = log.state();
    const readers = new Set<string>([...s.grants].filter(([, refs]) => refs.has(ref)).map(([key]) => key));
    const owner = s.owned.get(ref);
    if (owner) readers.add(owner);
    return [...readers].filter((key) => !log.mayRead(key, ref, row.accessStamp!, row.senderPerson?.userId ?? null)).map((key) => s.people.get(key)?.name ?? key);
  }

  /** Set by the team router: voids a grant from another machine that this machine would have refused. */
  teamGrantCheck: (() => void) | null = null;

  /** May this team person send here, on this machine's own knowledge? */
  teamMayDeliver(personKey: string, ref: string): boolean {
    const log = this.teamLog();
    if (!log || !this.teamStanding(personKey) || this.teamRefusal()) return false;
    return log.state().owned.get(ref) === personKey || log.grantOf(personKey, ref) === 'use';
  }

  /** The exchange with peers; absent on an agent with no machine identity. */
  teamPuller: TeamAccessPuller | null = null;

  /**
   * Set by the team router: the read-only settings summary the owner's phone shows, one line per setting
   * (team-switches-agent-wide). The agent reads it through GET /team/people; nothing here turns a setting on.
   */
  teamSwitchesSummary: (() => TeamSwitchLine[]) | null = null;

  /** Set by the team router: the Face ID team actions (§3.6, §4.1). */
  teamActionRunner: ((kind: TeamActionKind, req: Request, deviceId: string, target?: string) => Promise<{ status: number; body: unknown }>) | null = null;

  /** Tell a team phone's readers about a reply in a Telegram topic they hold. */
  teamTopicReply(topicId: number): void {
    const log = this.teamLog();
    const ref = `telegram:${topicId}`;
    if (!log || !log.state().on) return;
    if (![...log.state().grants.values()].some((g) => g.has(ref))) return;
    this.push?.onAppReply(ref, `topic-${topicId}-${Date.now()}`);
  }

  /** A machine that does not understand a team must not join one (Step 2b). */
  teamJoinBlocked(): boolean {
    const log = this.teamLog();
    if (log && this.teamOn()) return true;
    const entries = new TeamConfinement(this.deps.stateDir).entries();
    return entries === null || entries.size > 0;
  }

  /** Is team access on? An unreadable log counts as on, the strict direction (§3.3). */
  teamOn(): boolean {
    const log = this.teamLog();
    // No log can open, for example native switched off after a team existed: strict, not empty.
    if (!log) return new TeamConfinement(this.deps.stateDir).signsOfTeamUse();
    return log.healthState() === 'unreadable' || log.state().on;
  }

  /**
   * While team access is on, a send into a session with owner reach is refused for any non-owner,
   * or they could ask that session for a member's private folder (§3.2). Their own conversations and
   * confined ones have no owner reach.
   */
  sendReachesOwner(person: ResolvedPerson, ref: string): boolean {
    if (isOwnerPerson(person) || !this.teamOn()) return false;
    const key = ref.startsWith('app:') ? ref.slice(4) : ref;
    const own = this.appConversationOwner?.(key);
    if (own && own.machineId === this.machineId() && own.userId === person.userId) return false;
    return this.teamLog()?.isConfined(key) !== true;
  }

  /** May this phone's person do this to this conversation? (one shared check, spec §3.5) */
  mayUse(person: ResolvedPerson, ref: string, op: ConversationOp = 'read'): boolean {
    return mayUseConversation(person, ref, this.machineId(), this.appConversationOwner, op, (key, r) => {
      const log = this.teamLog();
      return { own: log?.ownerOf(r) === key, grant: log?.grantOf(key, r) ?? null };
    });
  }

  /** The shared check by device id (push recipients): an unknown device or person ⇒ no. */
  deviceMayUseConversation(deviceId: string, ref: string): boolean {
    const d = this.devices.get(deviceId);
    if (!d) return false;
    const p = this.personOfDevice(d);
    return p.ok && this.mayUse(p, ref);
  }

  /** May this phone be told about this message? With no id named, the conversation decides. */
  deviceMayReadMessage(deviceId: string, ref: string, messageId: string | undefined): boolean {
    const d = this.devices.get(deviceId);
    if (!d) return false;
    const p = this.personOfDevice(d);
    if (!p.ok) return false;
    // A push carries no text, and a peer's fan-out usually arrives before its row, so that one goes out.
    if (messageId === undefined || !this.storedMessage(ref, messageId)) return true;
    return this.mayReadMessageId(p, ref, messageId);
  }

  /** Validate a requested person for a pairing link or a reassignment (spec §3.2). */
  choosePerson(userId: unknown, role: unknown): ReturnType<typeof choosePerson> {
    const needsRegistry = (userId !== undefined && userId !== null);
    return choosePerson(userId, role, needsRegistry ? this.people() : null, this.ownerIdentity());
  }

  holdsLease(): boolean { return this.deps.holdsLease?.() ?? true; }

  /**
   * The ONE request-id store for every app mutation on this machine (Telegram chat route and the
   * native conversation routes share it: two instances over the same file would overwrite each
   * other's records). Lazily created; `useChatRequests` installs one constructed elsewhere.
   */
  private chatRequestStore: MobileChatRequestStore | null = null;
  private chatRequestStoreError = false;
  chatRequests(): MobileChatRequestStore | null {
    if (this.chatRequestStore || this.chatRequestStoreError) return this.chatRequestStore;
    try { this.chatRequestStore = new MobileChatRequestStore(this.deps.stateDir); } catch (err) {
      this.chatRequestStoreError = true;
      this.deps.reportDegradation?.('MobileChat.requestStore', err);
    }
    return this.chatRequestStore;
  }
  useChatRequests(store: MobileChatRequestStore): void { this.chatRequestStore = store; this.chatRequestStoreError = false; }

  /** 120 device requests per minute per device. */
  deviceRateOk(deviceId: string): boolean {
    const t = this.now();
    const arr = (this.deviceRate.get(deviceId) ?? []).filter((x) => t - x < 60_000);
    if (arr.length >= 120) { this.deviceRate.set(deviceId, arr); return false; }
    arr.push(t); this.deviceRate.set(deviceId, arr);
    return true;
  }

  /**
   * A rule's own per-minute bucket, independent of the read allowance. Each named bucket counts
   * separately (media chunks use 'default'; the session screen has its own two), and a key whose
   * window has emptied is deleted, so the map holds only devices active in the last minute.
   */
  deviceBucketOk(deviceId: string, perMinute: number, bucket = 'default'): boolean {
    const t = this.now();
    const key = bucket === 'default' ? deviceId : `${deviceId}\u0000${bucket}`;
    const arr = (this.deviceBucket.get(key) ?? []).filter((x) => t - x < 60_000);
    if (arr.length >= perMinute) { this.deviceBucket.set(key, arr); return false; }
    arr.push(t); this.deviceBucket.set(key, arr);
    if (this.deviceBucket.size > 64) {
      for (const [k, v] of this.deviceBucket) if (!v.some((x) => t - x < 60_000)) this.deviceBucket.delete(k);
    }
    return true;
  }

  /** Inbound Telegram text: void any pending device whose live code appears in it. */
  scanInbound(text: unknown): string[] {
    if (typeof text !== 'string' || !this.enabled()) return [];
    const hits = this.confirm.leakedIn(text);
    for (const id of hits) {
      this.confirm.drop(id);
      this.dashboardCodes.delete(id);
      let outcome: string = 'declined';
      try { outcome = this.devices.decline(id); } catch (err) { this.deps.reportDegradation?.('MobilePairing.leakDecline', err); }
      // An approval that already wrote first stands; the owner is not told it was cancelled.
      if (outcome === 'already-approved') continue;
      void this.deps.ownerDM?.('A pairing code was sent in a conversation, so I cancelled that pairing. Codes only go into the Instar app. Ask me for a new link if you were pairing a phone.', '');
    }
    return hits;
  }

  private browserSetupPause = 0;
  /**
   * Until when new browser setups are refused because the owner declined one (in memory; a restart
   * clears it). The owner's one-tap stop for unwanted approval requests (browser-setup-no-second-pin).
   */
  browserSetupsPausedUntil(): number { return this.browserSetupPause; }
  private noteDeclined(id: string): void {
    let browser = false;
    try { browser = isBrowserDevice(this.devices.get(id)); } catch { browser = false; } // @silent-fallback-ok — no pause is the old behaviour
    if (browser) this.browserSetupPause = Date.now() + 60 * 60_000;
  }

  /** The owner's Decline button. */
  declineByNonce(nonce: string): 'declined' | 'unknown' | 'already-approved' {
    const id = this.declineNonces.get(nonce);
    if (!id) return 'unknown';
    this.declineNonces.delete(nonce);
    this.confirm.drop(id);
    this.noteDeclined(id);
    try {
      // An approval that wrote first wins (dashboard-conversations-browser-device §4.1).
      if (this.devices.decline(id) === 'already-approved') return 'already-approved';
    } catch (err) { // @silent-fallback-ok — reported through DegradationReporter
      // The code is already gone, so the device can never confirm; it expires on its own.
      this.deps.reportDegradation?.('MobilePairing.declineWrite', err);
    }
    return 'declined';
  }
  private now: () => number;

  // ── Approve instead of a code (docs/specs/mobile-pairing-approve.md) ──

  /**
   * Phones that may no longer be approved with a tap (spec §4): a link used by two phones, or a phone
   * left waiting beside one that was just activated. Code and Decline still work. Memory only: a
   * restart expires every pending phone anyway.
   */
  private readonly contested = new Set<string>();
  /** sha256(link code) → the phone that took it and until when, so a second use of that link is seen. */
  private readonly takenCodes = new Map<string, { deviceId: string; publicKey: string; expiresAt: number }>();

  /** A phone took this link (spec §4). */
  noteLinkTaken(code: string, device: DeviceRecord): void {
    if (!isPairingApproveEnabled(this.deps.config)) return;
    this.takenCodes.set(crypto.createHash('sha256').update(code).digest('hex'), { deviceId: device.id, publicKey: device.publicKey ?? '', expiresAt: Date.parse(device.expiresAt!) });
  }

  /** A redeem found its code gone: if another key already took this link, its phone is contested. */
  noteLinkReused(code: unknown, publicKey: string): void {
    if (typeof code !== 'string' || !isPairingApproveEnabled(this.deps.config)) return;
    const hash = crypto.createHash('sha256').update(code).digest('hex');
    const t = this.takenCodes.get(hash);
    if (!t || t.expiresAt <= this.now() || t.publicKey === publicKey) return;
    // One notice per link: whoever holds it can repeat this request as often as they like.
    this.takenCodes.delete(hash);
    const d = this.devices.get(t.deviceId);
    if (!d) return;
    if (d.status === 'pending') this.contested.add(t.deviceId);
    featureEvidence.record('mobilePairing', { kind: 'held', reason: 'pairing link used by two phones', context: { deviceId: t.deviceId, status: d.status } });
    const text = d.status === 'active'
      ? `Two phones tried to use the same pairing link, and the first is now paired: ${d.deviceName ?? 'unnamed'} (key ${d.fingerprint ?? 'unknown'}). If that is not your phone, remove it on the Phones page now.`
      : d.status === 'pending'
        ? 'Two phones tried to use the same pairing link, so that pairing now needs its code. If you did not expect this, decline it and ask me for a new link.'
        : null;
    if (text) void Promise.resolve(this.deps.ownerDM?.(text, '')).catch(() => { /* @silent-fallback-ok — a courtesy notice; the tap is already refused */ });
  }

  /** A phone was just activated: anything still waiting beside it stays code-or-decline (spec §4). */
  private contestOthers(activated: string): void {
    for (const d of this.waitingPhones()) if (d.id !== activated) this.contested.add(d.id);
  }
  /** Called by the code path after an activation. */
  noteActivated(deviceId: string): void { this.contestOthers(deviceId); }

  /** Can a tap approve this phone, as far as its own row goes? */
  approvable(d: DeviceRecord): boolean { return (d.role === undefined || d.role === 'owner') && !this.contested.has(d.id); }

  /** Phones waiting on this machine. */
  waitingPhones(): DeviceRecord[] {
    // A pending browser is a waiting device only once its approval message was delivered
    // (`awaiting`) and until an approval recorded its intent (dashboard-conversations-browser-device §4.1).
    return this.devices.list().filter((d) => d.status === 'pending'
      && (isBrowserDevice(d) ? !!d.browserPublicKey && d.setupState === 'awaiting' && !d.activating : !!d.publicKey));
  }

  /**
   * The one approval funnel (spec §3.1). Synchronous from the read to the registry write, so two
   * answers never interleave. An approval names one device id, whose row is pending exactly once.
   */
  approvePending(deviceId: string, via: ApprovedVia, opts: { approvedBy?: string } = {}): ApproveOutcome {
    const outcome = this.approveOutcome(deviceId, via, opts);
    featureEvidence.record('mobilePairing', outcome === 'approved'
      ? { kind: 'fired', reason: 'approved without a code', context: { deviceId, approvedVia: via, ...(opts.approvedBy ? { approvedBy: opts.approvedBy } : {}) } }
      : { kind: outcome === 'failed' ? 'error' : 'held', reason: `approve refused: ${outcome}`, context: { deviceId, approvedVia: via } });
    return outcome;
  }

  private approveOutcome(deviceId: string, via: ApprovedVia, opts: { approvedBy?: string }): ApproveOutcome {
    if (!isPairingApproveEnabled(this.deps.config)) return 'off';
    const waiting = this.waitingPhones();
    const d = waiting.find((x) => x.id === deviceId);
    if (!d) return 'ended';
    // An MSP's phone is not in the owner's hand: handing over the code is what binds it to that person.
    if (d.role !== undefined && d.role !== 'owner') return 'code-only';
    if (this.contested.has(deviceId)) return 'contested';
    if (this.devices.pairingPaused()) return 'paused';
    // A Telegram-path pairing belongs to the lease holder (the same rule as confirm); a lease move voids it.
    if (!this.isDashboardPending(deviceId) && !this.holdsLease()) return 'moved';
    // A reflex tap must not pick between two phones: the code still works, and Decline is one tap (§4).
    if (waiting.length > 1) return 'another-phone-waiting';
    if (isBrowserDevice(d)) {
      const r = this.browser.activate(deviceId, via, opts);
      return r === 'activated' ? 'approved' : r === 'not-pending' ? 'ended' : 'failed';
    }
    const approvedAt = new Date(this.now()).toISOString();
    try {
      // Ledger row first (the durable intent), registry second, as confirm does; nothing is consumed on failure.
      this.keyLedger?.recordActivation(d, via, approvedAt);
      const after = this.devices.applyConfirm(deviceId, { ok: true, approvedVia: via, approvedAt, ...(opts.approvedBy ? { approvedBy: opts.approvedBy } : {}) });
      if (after?.status !== 'active') return 'failed';
    } catch (err) {
      this.deps.reportDegradation?.('MobilePairing.registryWrite', err);
      return 'failed';
    }
    this.confirm.drop(deviceId);
    this.dropDashboardCode(deviceId);
    for (const [n, id] of this.declineNonces) if (id === deviceId) this.declineNonces.delete(n);
    return 'approved';
  }

  /** The owner's Approve button in Telegram (spec §3.2): the same nonce as that message's Decline. */
  approveByNonce(nonce: string): ApproveOutcome {
    const id = this.declineNonces.get(nonce);
    return id ? this.approvePending(id, 'telegram-dm') : 'ended';
  }

  /**
   * Decline one waiting phone, from any surface. Returns what the registry did: a record an
   * approval already claimed answers 'already-approved' and is left alone.
   */
  declinePending(deviceId: string): 'declined' | 'already-approved' | 'not-pending' | 'failed' {
    this.noteDeclined(deviceId);
    this.confirm.drop(deviceId);
    this.dropDashboardCode(deviceId);
    for (const [n, id] of this.declineNonces) if (id === deviceId) this.declineNonces.delete(n);
    try { return this.devices.decline(deviceId); } catch (err) { // @silent-fallback-ok — the code is gone, so the device can never confirm; reported
      this.deps.reportDegradation?.('MobilePairing.declineWrite', err);
      return 'failed';
    }
  }

  // ── Browser devices (docs/specs/dashboard-conversations-browser-device.md) ──

  /** The browser switch, read live: `mobilePairing.browser.enabled` with pairing and native conversations on. */
  browserOn(): boolean { return this.enabled() && isBrowserDevicesEnabled(this.deps.config); }

  /** After any activation of a browser record: its code, nonces and dashboard code are gone; others stay code-only. */
  afterActivation(deviceId: string): void {
    this.confirm.drop(deviceId);
    this.dropDashboardCode(deviceId);
    for (const [n, id] of this.declineNonces) if (id === deviceId) this.declineNonces.delete(n);
    this.contestOthers(deviceId);
  }

  /** The kind of device a Telegram button's nonce names (for the tap's wording); phone when unknown. */
  nonceClient(nonce: string): 'phone' | 'browser' {
    const id = this.declineNonces.get(nonce);
    try { return id && isBrowserDevice(this.devices.get(id)) ? 'browser' : 'phone'; } catch { return 'phone'; } // @silent-fallback-ok — wording only
  }

  /** A browser setup removed before approval: its code and decline nonces go with it. */
  dropSetupSecrets(deviceId: string): void {
    this.confirm.drop(deviceId);
    this.dropDashboardCode(deviceId);
    for (const [n, id] of this.declineNonces) if (id === deviceId) this.declineNonces.delete(n);
  }

  private forwardedRevokes = new Set<string>();
  /** The best-effort extra after a replaced browser's ledger revocation row: once per device id. */
  forwardRevokeOnce(deviceId: string): void {
    if (this.forwardedRevokes.has(deviceId) || !this.pushPoolCtx) return;
    this.forwardedRevokes.add(deviceId);
    void forwardRevoke(this.pushPoolCtx, deviceId).catch(() => { /* @silent-fallback-ok — the ledger revocation row is what retires the key; this only makes it sooner */ });
  }

  /**
   * The owner's private message for a pending browser (§4.2 step 9), through the same delivery
   * helper as a phone's: the code, a decline nonce, and Approve when the tap may approve it.
   */
  async sendBrowserApproval(device: DeviceRecord): Promise<boolean> {
    if (!this.deps.ownerDM) return false;
    const code = this.confirm.issue(device.id, Date.parse(device.expiresAt!), 'word');
    const nonce = crypto.randomBytes(12).toString('hex');
    this.declineNonces.set(nonce, device.id);
    const canApprove = isPairingApproveEnabled(this.deps.config) && this.approvable(device);
    const codeLine = `Your code to set up a browser with ${this.deps.config.projectName} is ${displayCode(code)}.`;
    const delivered = await deliverOwnerDM(this, browserApprovalText(this.deps.config.projectName, device, codeLine, canApprove), nonce, canApprove);
    if (!delivered) { this.confirm.drop(device.id); this.declineNonces.delete(nonce); }
    return !!delivered;
  }

  /** An owner phone able to answer on this machine right now: active, owner, presence key on file. */
  ownerPhoneCanApprove(): boolean {
    return this.devices.list().some((d) => !!d.presenceKey && activeOwnerPhone(this, d.id));
  }

  /** What a waiting phone is told (spec §3.5); nothing when the feature is off. */
  waitingFields(d: DeviceRecord): Record<string, unknown> {
    if (!isPairingApproveEnabled(this.deps.config)) return {};
    // Only ways that can work now, easiest first (mobile-pairing-introducer §3.4).
    const introducers = this.introducers();
    const dashboardPending = this.isDashboardPending(d.id);
    const live = this.pairingPageOpen();
    const confirmWith = this.approvable(d) ? [
      ...(introducers.length > 0 ? ['paired-agent'] : []),
      ...(this.ownerPhoneCanApprove() ? ['owner-phone'] : []),
      ...(dashboardPending ? (live ? ['dashboard'] : []) : ['telegram']),
      'code',
    ] : ['code'];
    return {
      confirmWith, fingerprint: d.fingerprint ?? null, expiresAt: d.expiresAt ?? null,
      ...(introducers.length > 0 && this.approvable(d) ? { introducers: introducers.map((i) => ({ name: i.name, keyId: i.keyId })) } : {}),
      // Where the code is, when it is held for the pairing page (the code fallback names it).
      ...(dashboardPending && d.host && d.role !== 'team' ? { codeAt: 'pairing-page', codePageUrl: codePageUrlForDevice(d.host, d.id) } : {}),
    };
  }

  /** One contentless push so an owner phone can answer; only this machine's phones can (spec §6). */
  notifyOwnerPhones(d: DeviceRecord): void {
    if (!isPairingApproveEnabled(this.deps.config) || !this.approvable(d) || !this.ownerPhoneCanApprove()) return;
    this.push?.notifyHere({ kind: 'notice', subject: isBrowserDevice(d) ? 'browser-approval' : 'phone-approval', dedupeKey: `pairing-request:${d.id}` });
  }

  /** The record of who approved, in the owner's private chat when there is one (spec §3.4). */
  tellOwnerPhoneApproved(approverId: string, d: DeviceRecord): void {
    const approver = this.devices.get(approverId);
    const text = isBrowserDevice(d)
      ? `${approver?.deviceName ?? 'Your paired phone'} approved a new browser with Face ID: ${d.deviceName ?? 'unnamed'} (key ${d.fingerprint ?? 'unknown'}). If that was not you, remove the browser and that phone on the Phones page.`
      : `${approver?.deviceName ?? 'Your paired phone'} approved a new phone with Face ID: ${d.deviceName ?? 'unnamed'} (key ${d.fingerprint ?? 'unknown'}). If that was not you, remove both phones on the Phones page.`;
    void Promise.resolve(this.deps.ownerDM?.(text, '')).catch(() => { /* @silent-fallback-ok — a courtesy record; the activation already happened and shows on the Phones page */ });
  }

  enabled(): boolean { return isMobilePairingEnabled(this.deps.config); }
  private cfg(): MobilePairingConfig | undefined { return this.deps.config.mobilePairing; }
  origin(): string | null { return stableOrigin(this.deps.config.tunnel as { type?: string; hostname?: string } | undefined); }

  /**
   * The origin a new pairing link carries (mobile-pairing-tailscale-origin §3.1): the running
   * Cloudflare named tunnel when there is one (preferred, unchanged); otherwise a Tailscale own
   * name this machine's own configuration still names (`ownNames.accepts`). Probe health is a
   * preference among several, never a gate; mint's self-check decides. Chosen only from local
   * configuration and proven names, never from anything a request carries. Null → mint 409.
   */
  pairingOrigin(): { origin: string; host: string; kind: 'cloudflare' | 'tailscale' } | null {
    const named = this.origin();
    if (named && this.namedTunnelActive()) return { origin: named, host: new URL(named).host, kind: 'cloudflare' };
    if (!this.ownNames) return null;
    const own = this.ownNames;
    const ts = own.routes()
      .filter((r) => r.kind === 'tailscale' && own.accepts(new URL(r.origin).host))
      .sort((a, b) => (Number(b.lastProbeOk === true) - Number(a.lastProbeOk === true))
        || String(b.lastProbeAt ?? '').localeCompare(String(a.lastProbeAt ?? ''))
        || a.firstVerifiedAt.localeCompare(b.firstVerifiedAt))[0];
    return ts ? { origin: ts.origin, host: new URL(ts.origin).host, kind: 'tailscale' } : null;
  }

  /** A consent-gated backup relay is, or may still be, carrying traffic (§3.1 relay check). */
  relayMayBeActive(): boolean {
    const l = this.deps.tunnel?.()?.lifecycleState;
    return !!l && (l.lastState === 'relay-active' || l.lastState === 'self-healing');
  }

  /**
   * §3.2 step 1: is this request Host one a pairing link can currently be redeemed on? The
   * configured named-tunnel host while that tunnel runs, or a Tailscale own name this machine
   * still names while no relay may be carrying traffic. Never outbound probe health.
   */
  redeemHostEligible(host: string | null): { kind: 'cloudflare' | 'tailscale' } | null {
    if (!host) return null;
    const named = this.origin();
    if (named && new URL(named).host === host && this.namedTunnelActive()) return { kind: 'cloudflare' };
    if (!this.ownNames || this.relayMayBeActive()) return null;
    const isTailscale = this.ownNames.listed().some((n) => n.kind === 'tailscale' && n.host === host);
    return isTailscale && this.ownNames.accepts(host) ? { kind: 'tailscale' } : null;
  }

  namedTunnelActive(): boolean {
    const t = this.deps.tunnel?.();
    if (!t) return false;
    const l = t.lifecycleState;
    return l.lastState === 'active' && l.activeProvider === 'cloudflare-named';
  }

  /** A self-issued ping nonce: it bypasses the public ping budget (60 s). */
  issueSelfNonce(): string {
    const nonce = crypto.randomBytes(18).toString('base64url');
    this.selfNonces.set(nonce, this.now());
    return nonce;
  }

  /** The sibling-registry check: the name of another active machine of this agent claiming `host`. */
  siblingClaiming(host: string): string | null {
    for (const m of this.deps.siblings?.() ?? []) {
      if (m.machineId === this.deps.selfMachineId || (m.status && m.status !== 'active') || !m.lastKnownUrl) continue;
      try {
        if (new URL(m.lastKnownUrl).host.toLowerCase() === host.toLowerCase()) return m.name ?? 'unnamed';
      } catch { /* @silent-fallback-ok — an unparseable registry URL cannot match our host */ }
    }
    return null;
  }

  /** Answer a ping. Self-issued nonces bypass the public budget. */
  ping(nonce: unknown): { status: number; body: Record<string, unknown> } {
    if (typeof nonce !== 'string' || !NONCE_PATTERN.test(nonce)) return { status: 400, body: { error: 'bad nonce' } };
    const t = this.now();
    for (const [n, at] of this.selfNonces) if (t - at > SELF_NONCE_TTL_MS) this.selfNonces.delete(n);
    if (this.selfNonces.has(nonce)) {
      this.selfNonces.delete(nonce);
    } else {
      this.pingTimes = this.pingTimes.filter((p) => t - p < 60_000);
      if (this.pingTimes.length >= PING_LIMIT_PER_MIN) return { status: 429, body: { error: 'too-many-requests' } };
      this.pingTimes.push(t);
    }
    return { status: 200, body: { h: pingAnswer(nonce) } };
  }

  /** The deterministic registry check, then eight self-probes. */
  async verifySoleServer(origin: string): Promise<{ ok: true } | { ok: false; error: string; detail: string }> {
    const host = new URL(origin).host;
    const sibling = this.siblingClaiming(host);
    if (sibling !== null) {
      return { ok: false, error: 'not-the-tunnel-machine', detail: `Another of this agent's machines (${sibling}) also uses ${host}. Pairing needs that address served by one machine.` };
    }
    const f = this.deps.fetchFn ?? fetch;
    for (let i = 0; i < PROBES; i++) {
      const nonce = this.issueSelfNonce();
      let answer: unknown;
      try {
        const r = await f(`${origin}${MOBILE_PING_PATH}?n=${nonce}`, { signal: AbortSignal.timeout(PROBE_TIMEOUT_MS), cache: 'no-store' } as RequestInit);
        if (!r.ok) return { ok: false, error: 'address-unverified', detail: `Checking ${host} got an HTTP ${r.status} answer, so I could not confirm this machine serves it.` };
        answer = ((await r.json()) as { h?: unknown }).h;
      } catch (err) { // @silent-fallback-ok — not silent: the mint is refused 409 naming the unreachable address
        return { ok: false, error: 'address-unverified', detail: `Could not reach ${host} to confirm this machine serves it (${err instanceof Error ? err.name : 'error'}).` };
      }
      if (answer !== pingAnswer(nonce)) {
        return { ok: false, error: 'not-the-tunnel-machine', detail: `Another process answered on ${host}. Pairing needs that address served by this machine alone.` };
      }
    }
    return { ok: true };
  }
}

/** Send a push trigger to every other online machine (mobile-push §2.3): 5 s, no retry. */
export function fanOutPushTrigger(ctx: PoolCtx | null, t: PushTrigger, onResult?: (machineId: string, ok: boolean) => void): void {
  if (!ctx) return;
  const allow = (ctx.config.multiMachine as { peerUrlAllowlist?: string[] } | undefined)?.peerUrlAllowlist;
  for (const p of (ctx.resolvePeerUrls?.() ?? []).slice(0, 16)) {
    if (!isPeerUrlAllowedForCredentials({ url: p.url, kind: p.kind }, allow).ok) { onResult?.(p.machineId, false); continue; }
    void poolPeerFetch(ctx.recordRopeResult ?? undefined, p, '/mobile/push/notify', {
      method: 'POST', headers: { Authorization: `Bearer ${ctx.config.authToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(t), signal: AbortSignal.timeout(PEER_TIMEOUT_MS),
    }).then((r) => onResult?.(p.machineId, r.ok)).catch(() => onResult?.(p.machineId, false)); // @silent-fallback-ok — an offline machine misses this notification (spec 4)
  }
}

const json503 = (res: Response) => res.status(503).json({ error: 'Mobile pairing is turned off on this agent.' });

/** Public routes: registered on the app BEFORE the bearer middleware. */
export function mountPublicMobilePairingRoutes(app: Application, svc: MobilePairingService): void {
  app.get(MOBILE_PING_PATH, (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    // Multi-route proves own names with this same ping, so it answers whenever multi-route is on.
    if (!svc.enabled() && !svc.ownNames) { json503(res); return; }
    const r = svc.ping(req.query.n);
    // Extended answer (mobile-multi-route §4.1): the Host this server saw, echoed back, and
    // whether the request arrived through this machine's own local TLS front.
    const body = r.status === 200 && svc.ownNames ? {
      ...r.body,
      host: normalizeRequestHost(req.headers.host),
      arrival: arrivedOverLocalTls(req.secure, req.socket.remoteAddress, req.headers['x-forwarded-proto']) ? 'local-tls' : 'other',
    } : r.body;
    res.status(r.status).json(body);
  });

  app.post(MOBILE_REDEEM_PATH, async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!svc.enabled()) { json503(res); return; }
    const token = svc.deps.config.authToken;
    if (!token) { res.status(503).json({ error: 'Pairing is not available yet. Try again shortly.' }); return; }
    // §3.2 step 1 (before the code is taken, so a stray request cannot burn a real link): the
    // request arrived over local TLS on a host a link can currently be redeemed on. Step 3 below
    // then requires it to be the very host the code was minted for.
    const reqHost = normalizeRequestHost(req.headers.host);
    const eligible = svc.redeemHostEligible(reqHost);
    if (!arrivedOverLocalTls(req.secure, req.socket.remoteAddress, req.headers['x-forwarded-proto']) || !eligible) {
      featureEvidence.recordAtMostEvery('mobilePairing', 'redeem|not-secure-address', 60_000, { kind: 'held', reason: 'redeem refused: not-secure-address' });
      res.status(403).json({ error: 'Pairing only works over this agent\'s secure address.' });
      return;
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const publicKey = typeof body.devicePublicKey === 'string' ? body.devicePublicKey : '';
    if (!parseDevicePublicKey(publicKey)) { featureEvidence.recordAtMostEvery('mobilePairing', 'redeem|bad-device-key', 60_000, { kind: 'held', reason: 'redeem refused: bad-device-key' }); res.status(400).json({ error: 'A valid device public key is required.' }); return; }
    // Which way the confirmation code reaches the operator (mobile-native-conversations §4.4):
    // the Telegram owner's private chat (needs the serving lease: the code travels through the
    // lease holder's adapter), or — with no Telegram owner — the dashboard, shown only to a PIN
    // session, which needs no lease.
    const approval = svc.approvalPath();
    if (!approval || (approval === 'telegram' && !svc.holdsLease())) {
      featureEvidence.recordAtMostEvery('mobilePairing', 'redeem|approval-unavailable', 60_000, { kind: 'held', reason: 'redeem refused: approval-unavailable' });
      res.status(409).json({ error: 'approval-unavailable', detail: 'This agent cannot send you the confirmation code right now (no Telegram owner chat on this machine).' });
      return;
    }
    // A team invite needs an app that reads its standing, and a person still in the log (§3.4). Peeked,
    // so an old app does not burn the link.
    const invited = svc.codes.peekPerson(body.code);
    if (invited?.role === 'team') {
      if (!Array.isArray(body.appCaps) || !body.appCaps.includes('standing')) { res.status(426).json({ error: 'app-update-required', detail: 'Update the Instar app, then open this link again.' }); return; }
      if (!invited.userId || !svc.teamStanding(invited.userId)) { res.status(403).json({ error: 'That link has expired or was already used.' }); return; }
    }
    if (svc.devices.pairingPaused()) { featureEvidence.recordAtMostEvery('mobilePairing', 'redeem|pairing-paused', 60_000, { kind: 'held', reason: 'redeem refused: pairing-paused' }); res.status(429).json({ error: 'pairing-paused' }); return; }
    // Take-and-delete happens synchronously inside redeem(), before any async work.
    const r = svc.codes.redeem(body.code, token);
    if (!r.ok) {
      // mobile-pairing-approve §4: the same link from a second key proves it got out.
      svc.noteLinkReused(body.code, publicKey);
      featureEvidence.recordAtMostEvery('mobilePairing', `redeem|${r.reason}`, 60_000, { kind: 'held', reason: `redeem refused: ${r.reason}` });
      if (r.reason === 'too-many-attempts') { res.status(429).json({ error: 'too-many-attempts' }); return; }
      res.status(403).json({ error: 'That link has expired or was already used.' });
      return;
    }
    // §3.2 step 3: an honest phone sends to the link's own origin. A code with no bound origin
    // (minted before this change, in this process) keeps the old rule: the eligible host.
    if (r.bound && (r.bound.host !== reqHost || r.bound.kind !== eligible.kind)) {
      featureEvidence.recordAtMostEvery('mobilePairing', 'redeem|wrong-origin', 60_000, { kind: 'held', reason: 'redeem refused: wrong-origin' });
      res.status(403).json({ error: 'That link has expired or was already used.' });
      return;
    }
    let created: ReturnType<DeviceRegistry['createPending']>;
    try {
      created = svc.devices.createPending({ deviceName: cleanText(body.deviceName), label: r.label, publicKey, host: reqHost!, userId: r.person?.userId ?? null, role: r.person?.role ?? 'owner' });
    } catch (err) {
      svc.deps.reportDegradation?.('MobilePairing.registryWrite', err);
      featureEvidence.record('mobilePairing', { kind: 'error', reason: 'redeem failed: registry write', context: { routeKind: eligible.kind } });
      res.status(500).json(storageErrorResponse({ error: 'Could not record the device. Ask for a new link.' }, svc.deps.stateDir));
      return;
    }
    if (!created.ok) {
      const status = created.reason === 'duplicate-key' ? 409 : 429;
      featureEvidence.record('mobilePairing', { kind: 'held', reason: `redeem refused: ${created.reason}`, context: { routeKind: eligible.kind, status } });
      res.status(status).json({ error: created.reason });
      return;
    }
    const device = created.device;
    svc.noteLinkTaken(body.code as string, device);
    // mobile-pairing-word-code §3.2: only an app that asks for it gets a WORD-NNNN code; builds
    // already on phones send digits only, so everything else keeps today's 6-digit code.
    const codeFormat: CodeFormat = Array.isArray(body.codeFormats) && body.codeFormats.length <= 8 && body.codeFormats.includes('word') ? 'word' : 'digits';
    const code = svc.confirm.issue(device.id, Date.parse(device.expiresAt!), codeFormat);
    if (approval === 'dashboard' || device.role === 'team') {
      // A team phone's code is held for the owner's People screen (§3.4), whatever the owner's channel.
      // No DM to wait for: the code (plaintext, memory only) is shown on the dashboard's Phones
      // card to an operator session; the phone shows "confirm on your dashboard".
      svc.holdDashboardCode(device.id, code, Date.parse(device.expiresAt!));
      // dashboard-console-default-and-pair-page §3.3: the code page on the host this phone just
      // redeemed on (already checked above: local TLS, an eligible host, the code's bound host).
      featureEvidence.record('mobilePairing', { kind: 'fired', reason: 'redeemed: code held on dashboard', context: { deviceId: device.id, approval: 'dashboard', role: device.role ?? 'owner', routeKind: eligible.kind, codeFormat } });
      svc.notifyOwnerPhones(device);
      if (device.role === 'team') {
        // The code is on the inviter's phone, not a page this person could open.
        res.json({ deviceId: device.id, agentName: svc.deps.config.projectName, status: 'pending', approval: 'inviter', codeFormat, ...svc.waitingFields(device) });
        return;
      }
      res.json({ deviceId: device.id, agentName: svc.deps.config.projectName, status: 'pending', approval: 'dashboard', codeFormat,
        codePageUrl: codePageUrlForDevice(reqHost!, device.id), ...svc.waitingFields(device) });
      return;
    }
    const nonce = crypto.randomBytes(12).toString('hex');
    svc.declineNonces.set(nonce, device.id);
    const pretty = displayCode(code);
    // People and roles §3.2: the owner approves every phone, so the message says whose phone it is.
    const forWhom = device.role !== undefined && device.role !== 'owner' ? svc.personOfDevice(device) : null;
    const forWhomName = forWhom ? (forWhom.ok ? personLabel(forWhom.name, forWhom.role) : 'someone no longer in your user list') : null;
    // An MSP's phone stays code-only (mobile-pairing-approve §4): handing over the code is the binding.
    const canApprove = isPairingApproveEnabled(svc.deps.config) && svc.approvable(device);
    const codeLine = forWhomName
      ? `Your code to pair a phone for ${forWhomName} with ${svc.deps.config.projectName} is ${pretty}. Give it to them only if you want them to use the Instar app with this agent.`
      : `Your code to pair a phone with ${svc.deps.config.projectName} is ${pretty}.`;
    // mobile-pairing-approve §3.2: the decision first, the code kept as the fallback for older apps.
    const text = (canApprove ? [
      `A phone is asking to pair with ${svc.deps.config.projectName}. Approve only if you are pairing a phone right now and this key matches the one the app shows.`,
      `Phone key: ${device.fingerprint ?? 'unknown'}\nPhone name: ${device.deviceName ?? '(none given)'} (the phone chose this name, so don't rely on it)`,
      `If you did not start this, tap Decline.`,
      `If the app asks for a code instead: ${codeLine} Don't send or show this message to anyone, including me.`,
    ] : [
      codeLine,
      `Type it into the Instar app only if you are pairing a phone right now. If you did not start this, tap Decline. Don't send or show this message to anyone, including me.`,
      `Phone name: ${device.deviceName ?? '(none given)'}`,
    ]).join('\n\n');
    const delivered = await deliverOwnerDM(svc, text, nonce, canApprove);
    if (!delivered || !svc.deps.ownerDM) {
      // An owner phone may have approved during the wait (mobile-pairing-approve §3.4): that stands.
      const now = svc.devices.get(device.id);
      if (now?.status === 'active') { res.json({ deviceId: device.id, agentName: svc.deps.config.projectName, status: 'active', approval: 'telegram', codeFormat }); return; }
      svc.confirm.drop(device.id);
      svc.declineNonces.delete(nonce);
      try { svc.devices.remove(device.id); } catch (err) { svc.deps.reportDegradation?.('MobilePairing.registryWrite', err); } // @silent-fallback-ok — reported through deps.reportDegradation (DegradationReporter in production); the pending device expires on its own
      featureEvidence.record('mobilePairing', { kind: 'error', reason: 'redeem failed: confirmation code not delivered', context: { deviceId: device.id, routeKind: eligible.kind } });
      res.status(409).json({ error: 'approval-unavailable', detail: 'I could not send you the confirmation code in Telegram. Open a private chat with the bot and send it any message, then ask me for a new link.' });
      return;
    }
    featureEvidence.record('mobilePairing', { kind: 'fired', reason: 'redeemed: code sent by Telegram', context: { deviceId: device.id, approval: 'telegram', role: device.role ?? 'owner', routeKind: eligible.kind, codeFormat } });
    svc.notifyOwnerPhones(device);
    res.json({ deviceId: device.id, agentName: svc.deps.config.projectName, status: 'pending', approval: 'telegram', codeFormat, ...svc.waitingFields(device) });
  });
}

/**
 * The owner's private approval message, delivered within 10 s or not at all (shared by phone
 * redeem and browser setup). Resolves to the Telegram message id, or null when not delivered.
 */
async function deliverOwnerDM(svc: MobilePairingService, text: string, nonce: string, canApprove: boolean): Promise<number | null> {
  if (!svc.deps.ownerDM) return null;
  try {
    return await Promise.race([
      svc.deps.ownerDM(text, `md:d:${nonce}`, ...(canApprove ? [`md:a:${nonce}`] : [])),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 10_000)),
    ]);
  } catch { return null; } // @silent-fallback-ok — treated as not delivered: the pending device is removed and the caller gets 409
}

/** Bearer routes: mounted on the authenticated router. */
export function createMobilePairingRouter(svc: MobilePairingService, deps: MobilePairingDeps, poolCtx?: PoolCtx): Router {
  const router = Router();

  // Browser devices (docs/specs/dashboard-conversations-browser-device.md §4.2, §4.6): Bearer routes.
  mountBrowserDeviceRoutes(router, svc, {
    verifyOperatorSession: (token) => poolCtx?.verifyDashboardOperatorSession?.(token) === true,
    telegramConfigured: () => !!poolCtx?.telegram,
    approvalChat: async () => (poolCtx?.telegram?.botIdentity ? poolCtx.telegram.botIdentity() : null),
  });

  router.post('/mobile/pairing-codes', async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!svc.enabled()) { json503(res); return; }
    const mintBody = (req.body ?? {}) as Record<string, unknown>;
    // People and roles §3.2: whose phone this link is for (neither field ⇒ the owner, as before).
    const chosenPerson = svc.choosePerson(mintBody.userId, mintBody.role);
    if (!chosenPerson.ok) { res.status(400).json({ error: chosenPerson.error, detail: chosenPerson.detail }); return; }
    const chosen = svc.pairingOrigin();
    if (!chosen) {
      const t = deps.config.tunnel as { type?: string; hostname?: string } | undefined;
      const detail = t?.type === 'named' && !t.hostname
        ? 'The named tunnel has no configured hostname, and this machine has no Tailscale HTTPS name served by `tailscale serve`.'
        : 'The phone app needs a permanent address on this machine: a running Cloudflare named tunnel, or this machine\'s Tailscale HTTPS name served by `tailscale serve`.';
      res.status(409).json({ error: 'stable-address-required', detail });
      return;
    }
    // §3.1: before this change only the named-tunnel machine could mint; with a Tailscale fallback
    // any machine can, so refuse here (not after the operator opened the link) when this machine
    // cannot deliver the confirmation code.
    const approval = svc.approvalPath();
    if (!approval) {
      res.status(409).json({ error: 'approval-unavailable', detail: 'This agent has no way to confirm a new phone yet: it has no Telegram chat with its owner, phone pairing without Telegram is not turned on, and no other agent of the owner is set up to vouch for phones. Connect Telegram, or have the agent that created this one add itself as an introducer, then make a new link.' });
      return;
    }
    if (approval === 'telegram' && !svc.holdsLease()) {
      res.status(409).json({ error: 'approval-unavailable', detail: 'This machine cannot send the confirmation code. Make the link from the machine serving Telegram.' });
      return;
    }
    if (chosen.kind === 'tailscale' && svc.relayMayBeActive()) {
      res.status(409).json({ error: 'address-unverified', detail: 'A backup relay is carrying this agent\'s traffic; pairing over Tailscale waits until it ends.' });
      return;
    }
    const origin = chosen.origin;
    const sole = await svc.verifySoleServer(origin);
    if (!sole.ok) { res.status(409).json({ error: sole.error, detail: sole.detail }); return; }
    // Multi-route: prove the tunnel name as an own name now, so the phone paired on it is
    // accepted at once (bounded: one probe, 3 s). A failure only leaves it to the probe loop.
    if (svc.ownNames) {
      try { await svc.ownNames.proveNow(new URL(origin).host); } catch (err) { deps.reportDegradation?.('MobileRoutes.probe', err); }
    }
    const label = cleanText(mintBody.label);
    const m = svc.codes.mint(codeTtlMs(deps.config.mobilePairing), label, deps.config.authToken ?? '', { host: chosen.host, kind: chosen.kind },
      { userId: chosenPerson.userId, role: chosenPerson.role });
    if (!m.ok) { res.status(429).json({ error: m.reason }); return; }
    // originKind lets the agent tell the operator a Tailscale link opens only with Tailscale on.
    res.json({ code: m.code, expiresAt: new Date(m.expiresAt).toISOString(), link: buildPairLink(origin, m.code, deps.config.projectName), originKind: chosen.kind,
      person: { name: chosenPerson.name, role: chosenPerson.role, userId: chosenPerson.userId },
      // Where the operator will read the code when it is shown on the dashboard (no Telegram owner).
      ...(approval === 'dashboard' ? { codePageUrl: codePageUrlForOrigin(origin) } : {}) });
  });

  router.get('/mobile/devices', async (req: Request, res: Response) => {
    if (!svc.enabled()) { json503(res); return; }
    const machine = deps.selfMachineId ?? null;
    // People and roles §3.4: an MSP phone sees only its own phone (local and pool).
    if (isMspRequest(req)) {
      const own = principalOf(req).kind === 'device' ? svc.devices.get((principalOf(req) as { deviceId: string }).deviceId) : null;
      res.json({ devices: own ? [publicDeviceView(own, machine, svc)] : [] });
      return;
    }
    const local = svc.devices.list().map((d) => publicDeviceView(d, machine, svc));
    if (req.query.scope !== 'pool' || !poolCtx) { res.json({ devices: local }); return; }
    const pool = await fetchPoolDevices(poolCtx);
    const devices = [...local, ...pool.rows].sort((a, b) => String(b.pairedAt).localeCompare(String(a.pairedAt)));
    res.json({ devices, pool: { failed: pool.failed } });
  });

  // ── Dashboard pairing approval (mobile-native-conversations §4.4) ──
  // A dashboard-path pending phone's fingerprint and confirmation code, ONLY to a dashboard
  // operator session (a fresh PIN unlock, X-Instar-Operator-Session). The Bearer token alone, and
  // any device, are refused: the code proves the phone's holder could unlock the dashboard.
  const operatorOnly = (req: Request, res: Response): boolean => {
    res.setHeader('Cache-Control', 'no-store');
    if (!svc.enabled()) { json503(res); return false; }
    if (principalOf(req).kind !== 'token') { res.status(403).json({ error: 'operator-session-required' }); return false; }
    const session = req.get('X-Instar-Operator-Session');
    if (!poolCtx?.verifyDashboardOperatorSession?.(session)) {
      res.status(403).json({ error: 'operator-session-required', detail: 'Unlock the dashboard with your PIN to see pairing codes.' });
      return false;
    }
    return true;
  };

  router.get('/mobile/pairing-approvals', (req: Request, res: Response) => {
    if (!operatorOnly(req, res)) return;
    // A waiting phone may now be told "tap Approve on the pairing page" (mobile-pairing-introducer §3.4).
    svc.notePairingPageSeen();
    const approvals = svc.dashboardApprovals().map(({ device, code, expiresAt }) => ({
      deviceId: device.id, deviceName: device.deviceName, label: device.label, fingerprint: device.fingerprint ?? null, ...personFields(device, svc),
      // Display form for both formats (mobile-pairing-word-code §3.4): `KITE-4172` or `123 456`.
      code: displayCode(code), codeFormat: /^\d{6}$/.test(code) ? 'digits' : 'word', pairedAt: device.pairedAt, expiresAt: new Date(expiresAt).toISOString(),
      // mobile-pairing-approve §3.3: whether this card may offer Approve (never on a Telegram-owner agent).
      canApprove: isPairingApproveEnabled(deps.config) && svc.approvalPath() === 'dashboard' && svc.approvable(device),
    }));
    res.json({ approval: svc.approvalPath(), approvals });
  });

  // Approve from the same card, behind the same access that shows the code (mobile-pairing-approve
  // §3.3). Only a dashboard-path phone: the PIN never approves a phone on an agent with a Telegram
  // owner. Refusals are never 403, which the pages read as "the session is gone".
  router.post('/mobile/pairing-approvals/:id/approve', (req: Request, res: Response) => {
    if (!operatorOnly(req, res)) return;
    if (!isPairingApproveEnabled(deps.config)) { approveAnswer(res, 'off', ''); return; }
    const id = String(req.params.id);
    if (!svc.isDashboardPending(id)) { res.status(404).json({ error: 'not-pending', detail: APPROVE_REFUSAL.ended.detail }); return; }
    if (svc.approvalPath() !== 'dashboard') {
      featureEvidence.record('mobilePairing', { kind: 'held', reason: 'approve refused: approval-moved', context: { deviceId: id } });
      res.status(409).json({ error: 'approval-moved', detail: 'This agent now approves phones through your private Telegram chat. Use the message there.' });
      return;
    }
    approveAnswer(res, svc.approvePending(id, 'dashboard-pin'), id);
  });

  // "Not me": the operator declines a dashboard-path pairing from the same card.
  router.post('/mobile/pairing-approvals/:id/decline', (req: Request, res: Response) => {
    if (!operatorOnly(req, res)) return;
    const id = String(req.params.id);
    if (!svc.isDashboardPending(id)) { res.status(404).json({ error: 'not-pending' }); return; }
    svc.confirm.drop(id);
    svc.dropDashboardCode(id);
    let outcome: string = 'declined';
    try { outcome = svc.devices.decline(id); } catch (err) { // @silent-fallback-ok — the code is gone, so the device can never confirm; reported
      deps.reportDegradation?.('MobilePairing.declineWrite', err);
    }
    if (outcome === 'already-approved') { res.status(409).json({ error: 'already-approved', detail: 'This device was already approved. Remove it on the Phones page if this wasn\'t you.' }); return; }
    res.json({ declined: true });
  });

  // Routes to this machine (mobile-multi-route §4.3; device-signed, active only).
  router.get('/mobile/routes', (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!svc.enabled()) { json503(res); return; }
    const p = principalOf(req);
    if (p.kind !== 'device') { res.status(403).json({ error: 'device-signature-required' }); return; }
    const machineId = deps.selfMachineId ?? null;
    if (svc.ownNames) { res.json({ machineId, version: svc.ownNames.version, routes: svc.ownNames.routes() }); return; }
    // Multi-route off: only the host this phone paired with.
    const d = svc.devices.get(p.deviceId);
    const routes = d?.host ? [{ kind: 'cloudflare', origin: `https://${d.host}`, firstVerifiedAt: d.approvedAt ?? d.pairedAt, lastProbeOk: null, lastProbeAt: null }] : [];
    res.json({ machineId, version: 0, routes });
  });

  // Device's own status (device-signed; any non-revoked status).
  router.get('/mobile/device', (req: Request, res: Response) => {
    if (!svc.enabled()) { json503(res); return; }
    const p = principalOf(req);
    if (p.kind !== 'device') { res.status(403).json({ error: 'device-signature-required' }); return; }
    const d = svc.devices.get(p.deviceId);
    if (!d) { res.status(404).json({ error: 'unknown-device' }); return; }
    res.json({
      status: d.status, deviceName: d.deviceName, approvedAt: d.approvedAt ?? null,
      // A pending dashboard-path phone (§4.4) tells the operator where the code is.
      ...(d.status === 'pending' && svc.isDashboardPending(d.id) ? { approval: d.role === 'team' ? 'inviter' : 'dashboard' } : {}),
      // Approve instead of a code (mobile-pairing-approve §3.5): this route is the waiting phone's status poll.
      ...(d.status === 'pending' ? svc.waitingFields(d) : {}),
      ...(d.approvedVia ? { approvedVia: d.approvedVia } : {}),
      // A browser's setup page (dashboard-conversations-browser-device §4.2): its kind, fingerprint and window.
      ...(isBrowserDevice(d) ? { client: 'browser', fingerprint: d.fingerprint ?? null, ...(d.status === 'pending' && d.expiresAt ? { expiresAt: d.expiresAt } : {}), ...(d.setupState ? { setupState: d.setupState } : {}), ...(d.activating ? { approving: true } : {}) } : {}),
      // People and roles §3.1: whose phone this is (`unassigned` when the person was removed).
      person: personView(svc.personOfDevice(d)),
      ...standingView(svc, d),
    });
  });

  // ── Owner grants for MSP persons (people and roles §3.5) ──
  // Only an OWNER phone may change a grant: its device signature proves the owner (the owner alone
  // received its pairing code). The Bearer token is refused, so nothing that talks to the agent —
  // including an MSP asking the agent — can open the owner's chats or Slack.
  const ownerPhone = (req: Request, res: Response): string | null => {
    res.setHeader('Cache-Control', 'no-store');
    if (!svc.enabled()) { json503(res); return null; }
    const p = principalOf(req);
    const person = devicePersonOf(req);
    if (p.kind !== 'device' || !person || person.role !== 'owner') {
      res.status(403).json({ error: 'owner-phone-required', detail: 'Only the owner\'s phone can change what an MSP may use.' });
      return null;
    }
    return p.deviceId;
  };
  /** MSP persons with at least one phone on this machine, and what the owner opened to each. */
  const mspPeople = (): Array<Record<string, unknown>> => {
    const byUser = new Map<string, { name: string; phones: number }>();
    for (const d of svc.devices.list()) {
      if (d.role !== 'msp' || !d.userId || d.status === 'revoked') continue;
      const p = svc.personOfDevice(d);
      const cur = byUser.get(d.userId) ?? { name: p.ok ? p.name : d.userId, phones: 0 };
      cur.phones++;
      byUser.set(d.userId, cur);
    }
    return [...byUser.entries()].map(([userId, v]) => ({ userId, name: v.name, role: 'msp', phones: v.phones, grants: svc.grants.get(userId) }));
  };
  router.get('/mobile/people', (req: Request, res: Response) => {
    if (principalOf(req).kind === 'token') {
      // The agent may READ the switches (to answer "can my MSP see my chats?"); never change them.
      res.setHeader('Cache-Control', 'no-store');
      if (!svc.enabled()) { json503(res); return; }
      res.json({ people: mspPeople() });
      return;
    }
    if (!ownerPhone(req, res)) return;
    res.json({ people: mspPeople() });
  });
  router.post('/mobile/people/:userId/grants', (req: Request, res: Response) => {
    const deviceId = ownerPhone(req, res); if (!deviceId) return;
    const userId = String(req.params.userId);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const change: { ownerConversations?: boolean; slack?: boolean } = {};
    for (const k of ['ownerConversations', 'slack'] as const) {
      if (b[k] === undefined) continue;
      if (typeof b[k] !== 'boolean') { res.status(400).json({ error: 'bad-grant', detail: `${k} must be true or false.` }); return; }
      change[k] = b[k] as boolean;
    }
    if (Object.keys(change).length === 0) { res.status(400).json({ error: 'bad-grant', detail: 'Send ownerConversations and/or slack.' }); return; }
    // Only a registered MSP person (not the owner) can hold a grant.
    const choice = svc.choosePerson(userId, 'msp');
    if (!choice.ok) { res.status(400).json({ error: choice.error, detail: choice.detail }); return; }
    let g: ReturnType<typeof svc.grants.set>;
    try { g = svc.grants.set(userId, change, deviceId); } catch (err) {
      deps.reportDegradation?.('MobilePeople.grantWrite', err);
      res.status(500).json(storageErrorResponse({ error: 'Could not record the change. Try again.' }, svc.deps.stateDir));
      return;
    }
    res.json({ userId, name: choice.name, grants: { ownerConversations: g.ownerConversations, slack: g.slack } });
  });

  // Assign a phone to a person (people and roles §3.2): bearer only, MSP only — a phone is raised
  // to owner only by being paired again as one (the owner alone receives that code).
  router.post('/mobile/devices/:id/person', (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!svc.enabled()) { json503(res); return; }
    if (principalOf(req).kind !== 'token') { res.status(403).json({ error: 'bearer-required' }); return; }
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (b.role === 'owner') { res.status(400).json({ error: 'owner-needs-pairing', detail: 'A phone becomes an owner phone only by pairing it again as the owner\'s phone.' }); return; }
    if (b.role !== 'msp') { res.status(400).json({ error: 'bad-role', detail: 'role must be "msp".' }); return; }
    const choice = svc.choosePerson(b.userId, 'msp');
    if (!choice.ok) { res.status(400).json({ error: choice.error, detail: choice.detail }); return; }
    // Only a true lowering: an OWNER phone may become an MSP's. An MSP (or unassigned) phone is never
    // moved to another person by the bearer token — that person may hold owner grants (§3.5), so
    // the move could raise access without the owner. Pair the phone again for the new person.
    const current = svc.devices.get(String(req.params.id));
    if (current && current.role !== undefined && current.role !== 'owner') {
      res.status(409).json({ error: 'repair-needed', detail: 'This phone already belongs to an MSP. To give it to someone else, revoke it and pair it again for them.' });
      return;
    }
    let d: DeviceRecord | null;
    try { d = svc.devices.setPerson(String(req.params.id), { userId: choice.userId, role: 'msp' }); } catch (err) {
      deps.reportDegradation?.('MobilePairing.registryWrite', err);
      res.status(500).json(storageErrorResponse({ error: 'Could not record the assignment. Try again.' }, svc.deps.stateDir));
      return;
    }
    if (!d) { res.status(404).json({ error: 'unknown-device' }); return; }
    res.json({ deviceId: d.id, person: personView(svc.personOfDevice(d)) });
  });

  // Confirm with the code from the owner's private chat (device-signed; pending or active).
  router.post('/mobile/device/confirm', (req: Request, res: Response) => {
    if (!svc.enabled()) { json503(res); return; }
    const p = principalOf(req);
    if (p.kind !== 'device') { res.status(403).json({ error: 'device-signature-required' }); return; }
    const d = svc.devices.get(p.deviceId);
    if (!d) { res.status(404).json({ error: 'unknown-device' }); return; }
    if (d.status === 'active') { res.json({ status: 'active' }); return; }
    if (d.status !== 'pending') { res.status(409).json({ error: d.status }); return; }
    // A dashboard-path device (§4.4) needs no lease: its code never travelled through Telegram.
    const viaDashboard = svc.isDashboardPending(d.id);
    const approvedVia = viaDashboard ? 'dashboard-pin' as const : 'telegram-dm' as const;
    if (!viaDashboard && !svc.holdsLease()) {
      try { svc.devices.expireAllPending(svc.dashboardPendingIds()); } catch (err) { deps.reportDegradation?.('MobilePairing.registryWrite', err); }
      featureEvidence.record('mobilePairing', { kind: 'held', reason: 'confirm refused: approval-moved', context: { deviceId: d.id } });
      res.status(409).json({ error: 'approval-moved', detail: 'This pairing moved machines. Ask for a new link.' });
      return;
    }
    if (svc.devices.pairingPaused()) { featureEvidence.record('mobilePairing', { kind: 'held', reason: 'confirm refused: pairing-paused', context: { deviceId: d.id } }); res.status(429).json({ error: 'pairing-paused' }); return; }
    const check = svc.confirm.check(d.id, (req.body as Record<string, unknown> | undefined)?.code);
    if (check.result === 'none') { featureEvidence.record('mobilePairing', { kind: 'held', reason: 'confirm refused: expired', context: { deviceId: d.id } }); res.status(409).json({ error: 'expired' }); return; }
    if (check.result === 'wrong-format') {
      // mobile-pairing-word-code §3.3: a shape that can never match costs no strike.
      res.status(422).json({ error: 'wrong-format', detail: 'That is not the pairing code. The code looks like KITE-4172: a word, then four digits.' });
      return;
    }
    if (check.result === 'ok' && isBrowserDevice(d)) {
      // A browser (dashboard-conversations-browser-device §4.2 step 10): intent → ledger row →
      // registry → effects. Refused when a decline (or another approval) wrote first.
      const r = svc.browser.activate(d.id, 'telegram-dm');
      if (r === 'activated') { res.json({ status: 'active' }); return; }
      if (r === 'not-pending') { res.status(409).json({ error: 'not-pending', detail: 'This setup was already decided. Reload the page.' }); return; }
      res.status(500).json({ error: 'Could not record the confirmation. Try again.' });
      return;
    }
    let after: DeviceRecord | null;
    const approvedAt = new Date().toISOString();
    if (check.result === 'ok' && svc.keyLedger) {
      // Ledger row first (the durable intent), registry second; reconciliation repairs a crash between.
      try { svc.keyLedger.recordActivation(d, approvedVia, approvedAt); } catch (err) {
        deps.reportDegradation?.('MobilePairing.keyLedger', err);
        featureEvidence.record('mobilePairing', { kind: 'error', reason: 'confirm failed: key ledger write', context: { deviceId: d.id, approvedVia } });
        res.status(500).json(storageErrorResponse({ error: 'Could not record the confirmation. Try again.' }, svc.deps.stateDir));
        return;
      }
    }
    try {
      after = svc.devices.applyConfirm(d.id, check.result === 'ok' ? { ok: true, approvedVia, approvedAt } : { ok: false, wrongHmac: check.hmac });
    } catch (err) {
      deps.reportDegradation?.('MobilePairing.registryWrite', err);
      featureEvidence.record('mobilePairing', { kind: 'error', reason: 'confirm failed: registry write', context: { deviceId: d.id, approvedVia } });
      res.status(500).json(storageErrorResponse({ error: 'Could not record the confirmation. Try again.' }, svc.deps.stateDir));
      return;
    }
    if (check.result === 'ok') {
      svc.confirm.drop(d.id); // consumed only after the activation was written
      svc.dropDashboardCode(d.id);
      svc.noteActivated(d.id);
      for (const [n, id] of svc.declineNonces) if (id === d.id) svc.declineNonces.delete(n);
      try { if (d.role === 'team') svc.bindTeamPhones(); } catch (err) { deps.reportDegradation?.('TeamAccess.bind', err); } // @silent-fallback-ok — reported; bound at the next boot
      featureEvidence.record('mobilePairing', { kind: 'fired', reason: 'confirmed', context: { deviceId: d.id, approvedVia, role: d.role ?? 'owner' } });
      res.json({ status: 'active' });
      return;
    }
    featureEvidence.record('mobilePairing', { kind: 'held', reason: 'confirm refused: wrong code', context: { deviceId: d.id, nowDeclined: after?.status === 'declined', pairingPaused: svc.devices.pairingPaused() } });
    if (svc.devices.pairingPaused()) {
      deps.raiseAttention?.(isBrowserDevice(d) ? 'Phone and browser setup paused' : 'Phone pairing paused', isBrowserDevice(d)
        ? 'Ten wrong codes were entered in the last 24 hours, so setting up phones and browsers is paused for now. If you were not setting up a browser or a phone, someone may be guessing.'
        : 'Ten wrong pairing codes were entered in the last 24 hours, so phone pairing is paused for now. If you were not pairing a phone, someone may be guessing.');
    }
    if (after?.status === 'declined') {
      svc.confirm.drop(d.id);
      svc.dropDashboardCode(d.id);
      void deps.ownerDM?.(isBrowserDevice(d)
        ? 'Three wrong codes were typed for a browser setup, so I cancelled it. If that was you, set the browser up again from the dashboard. If not, someone may be trying to add a browser.'
        : 'Three wrong codes were typed for a phone pairing, so I cancelled it. If that was you, ask me for a new link. If not, someone may have your pairing link.', '');
      res.status(409).json({ error: 'declined' });
      return;
    }
    res.status(403).json({ error: 'wrong-code' });
  });

  // Console sign-in from an owner phone (docs/specs/mobile-console-device-signin.md).
  mountConsoleTicketDeviceRoutes(router, svc);

  // Approve a waiting phone from an owner phone, with Face ID (mobile-pairing-approve §3.4).
  mountPairingApprovalDeviceRoutes(router, svc);

  // Add a new agent from a phone you already use (docs/specs/mobile-pairing-introducer.md): this
  // agent vouching for its owner phone, and this agent taking another agent's word.
  mountIntroducerRoutes(router, svc, { readIdentity: () => deps.readIdentity?.() ?? null });
  mountIntroductionRedeemRoute(router, svc);

  // Revoke: bearer may revoke any device; a device itself; an ACTIVE OWNER phone any device held on
  // this machine (docs/specs/mobile-native-phones-messages.md §3.3 — what the console's Phones panel
  // already lets the owner do). The allowlist also admits pending/declined/expired devices on this
  // path, so the requester's status is read from the registry here, never inferred from the rule.
  router.post('/mobile/devices/:id/revoke', async (req: Request, res: Response) => {
    if (!svc.enabled()) { json503(res); return; }
    const id = String(req.params.id);
    const p = principalOf(req);
    const requestedBy = p.kind === 'device' ? p.deviceId : null;
    // A browser may remove only itself (dashboard-conversations-browser-device §4.4).
    if (p.kind === 'device' && p.deviceId !== id && isBrowserDevice(svc.devices.get(p.deviceId))) {
      res.status(403).json({ error: 'own-device-only', detail: 'A browser can only remove itself.' });
      return;
    }
    if (p.kind === 'device' && p.deviceId !== id) {
      const requester = svc.devices.get(p.deviceId);
      const person = devicePersonOf(req);
      if (!requester || requester.status !== 'active' || !person || person.role !== 'owner') {
        res.status(403).json({ error: 'owner-phone-required', detail: 'Only the owner\'s phone can remove another phone.' });
        return;
      }
    }
    let held: boolean;
    const revokedAt = new Date().toISOString();
    const existing = svc.keyLedger ? svc.devices.get(id) : null;
    if (existing && existing.status !== 'revoked' && svc.keyLedger) {
      // Ledger row first. A failed ledger write never blocks a revocation: the registry still
      // revokes, and boot reconciliation backfills the missing revocation row.
      try { svc.keyLedger.recordRevocation(existing, revokedAt); } catch (err) { deps.reportDegradation?.('MobilePairing.keyLedger', err); }
    }
    try {
      // The ledger row (if written) already records this revocation; one retry keeps the registry
      // from lagging it, so the device stops being accepted now rather than at the next boot.
      try { held = svc.devices.revoke(id, revokedAt); } catch { held = svc.devices.revoke(id, revokedAt); } // @silent-fallback-ok — a second failure is reported below
    } catch (err) {
      deps.reportDegradation?.('MobilePairing.registryWrite', err);
      featureEvidence.record('mobilePairing', { kind: 'error', reason: 'revoke failed: registry write', context: { deviceId: id, by: p.kind } });
      res.status(500).json(storageErrorResponse({ error: 'Could not record the revocation. Try again.' }, svc.deps.stateDir));
      return;
    }
    if (held) { svc.confirm.drop(id); featureEvidence.record('mobilePairing', { kind: 'fired', reason: 'revoked here', context: { deviceId: id, by: p.kind, heldHere: true, ...(requestedBy && requestedBy !== id ? { requestedBy } : {}) } }); res.json({ revoked: true, machine: deps.selfMachineId ?? null }); return; }
    if (p.kind === 'device' || !poolCtx) { res.status(404).json({ error: 'unknown-device' }); return; }
    const r = await forwardRevoke(poolCtx, id);
    if (r.confirmedBy) { featureEvidence.record('mobilePairing', { kind: 'fired', reason: 'revoked by a peer', context: { deviceId: id, by: p.kind, heldHere: false } }); res.json({ revoked: true, machine: r.confirmedBy }); return; }
    featureEvidence.record('mobilePairing', { kind: 'error', reason: 'revoke unconfirmed: no machine holding this phone answered', context: { deviceId: id, by: p.kind } });
    res.status(202).json({ pending: true, detail: 'No machine holding this phone confirmed yet. Until one does, the phone may still have access. Revoke it on the machine that serves its address for an immediate effect.' });
  });

  // ── Mobile push (docs/specs/mobile-push.md) ──
  router.post('/mobile/device/push', (req: Request, res: Response) => {
    if (!svc.enabled()) { json503(res); return; }
    const p = principalOf(req);
    if (p.kind !== 'device') { res.status(403).json({ error: 'device-signature-required' }); return; }
    const b = (req.body ?? {}) as Record<string, unknown>;
    const revision = b.revision;
    if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) { res.status(400).json({ error: 'bad-revision' }); return; }
    let reg: Parameters<typeof svc.devices.setPush>[1];
    if (b.token === null) reg = { token: null, revision };
    else {
      if (typeof b.token !== 'string' || !/^[0-9a-f]{64,200}$/.test(b.token)) { res.status(400).json({ error: 'bad-token' }); return; }
      if (b.environment !== 'sandbox' && b.environment !== 'production') { res.status(400).json({ error: 'bad-environment' }); return; }
      if (typeof b.notifyTokenHash !== 'string' || !/^[0-9a-f]{64}$/.test(b.notifyTokenHash)) { res.status(400).json({ error: 'bad-notify-token-hash' }); return; }
      reg = { token: b.token, environment: b.environment, notifyTokenHash: b.notifyTokenHash, revision };
    }
    let r: ReturnType<typeof svc.devices.setPush>;
    try { r = svc.devices.setPush(p.deviceId, reg); } catch (err) {
      deps.reportDegradation?.('MobilePush.registryWrite', err);
      res.status(500).json(storageErrorResponse({ error: 'Could not record the registration. Try again.' }, svc.deps.stateDir));
      return;
    }
    if (!r.ok) { res.status(r.reason === 'not-active' ? 403 : 409).json({ error: r.reason }); return; }
    res.json({ ok: true, revision: r.revision });
  });

  router.get('/mobile/attention/:id', async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!svc.enabled()) { json503(res); return; }
    const p = principalOf(req);
    if (p.kind !== 'device' && p.kind !== 'device-notify') { res.status(403).json({ error: 'device-required' }); return; }
    const id = String(req.params.id);
    const machine = typeof req.query.machine === 'string' ? req.query.machine : deps.selfMachineId ?? null;
    const view = (item: unknown) => {
      const it = (item ?? {}) as { title?: unknown; priority?: unknown };
      return { title: cleanText(it.title, 160) ?? '', priority: typeof it.priority === 'string' ? it.priority : null };
    };
    if (!machine || machine === deps.selfMachineId) {
      const raw = poolCtx?.telegram?.getAttentionItem?.(id) ?? poolCtx?.localAttention?.get(id);
      const item = raw ? filterAttentionForPhone(svc, req, [raw])[0] : undefined;
      if (!item) { res.status(404).json({ error: 'not-found' }); return; }
      res.json(view(item));
      return;
    }
    const peer = (poolCtx?.resolvePeerUrls?.() ?? []).find((x) => x.machineId === machine);
    const allow = (deps.config.multiMachine as { peerUrlAllowlist?: string[] } | undefined)?.peerUrlAllowlist;
    if (!peer || !poolCtx || !isPeerUrlAllowedForCredentials({ url: peer.url, kind: peer.kind }, allow).ok) { res.status(404).json({ error: 'not-found' }); return; }
    try {
      const r = await poolPeerFetch(poolCtx.recordRopeResult ?? undefined, peer, `/attention/${encodeURIComponent(id)}`, {
        headers: { Authorization: `Bearer ${deps.config.authToken}` }, signal: AbortSignal.timeout(PEER_TIMEOUT_MS),
      });
      if (!r.ok) { res.status(404).json({ error: 'not-found' }); return; }
      const text = await r.text();
      if (Buffer.byteLength(text) > MAX_PEER_BYTES) { res.status(404).json({ error: 'not-found' }); return; }
      res.json(view(JSON.parse(text)));
    } catch { res.status(404).json({ error: 'not-found' }); } // @silent-fallback-ok — the phone keeps the generic text
  });

  const notifyTimes: number[] = [];
  router.post('/mobile/push/notify', (req: Request, res: Response) => {
    if (!svc.enabled() || !svc.push || !isMobilePushEnabled(deps.config)) { json503(res); return; }
    if (principalOf(req).kind !== 'token') { res.status(403).json({ error: 'token-required' }); return; }
    const t = Date.now();
    while (notifyTimes.length && t - notifyTimes[0]! > 60 * 60_000) notifyTimes.shift();
    if (notifyTimes.length >= 120) { svc.push.noteRefused(); res.status(429).json({ error: 'too-many-requests' }); return; }
    notifyTimes.push(t);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const kind = b.kind === 'notice' ? 'notice' : b.kind === 'item' ? 'item' : b.kind === 'reply' ? 'reply' : null;
    const dedupeKey = typeof b.dedupeKey === 'string' ? b.dedupeKey.slice(0, 200) : '';
    const sourceMachine = typeof b.sourceMachine === 'string' ? b.sourceMachine.slice(0, 80) : '';
    if (!kind || !dedupeKey || !sourceMachine) { res.status(400).json({ error: 'bad-trigger' }); return; }
    // A reply trigger (mobile-native-conversations §4.7) names its app conversation by strict UUID only.
    const conversationKey = kind === 'reply' && typeof b.conversationKey === 'string' && new RegExp(`^${APP_CONVERSATION_KEY_PATTERN}$`).test(b.conversationKey) ? b.conversationKey : null;
    if (kind === 'reply' && !conversationKey) { res.status(400).json({ error: 'bad-trigger' }); return; }
    const trig: PushTrigger = {
      kind, dedupeKey, sourceMachine,
      ...(kind === 'item' && typeof b.itemId === 'string' ? { itemId: b.itemId.slice(0, 120) } : {}),
      ...(conversationKey ? { conversationKey } : {}),
      ...(conversationKey && typeof b.messageId === 'string' && /^[a-z0-9._:-]{1,128}$/.test(b.messageId) ? { messageId: b.messageId } : {}),
      ...(typeof b.priority === 'string' ? { priority: b.priority.slice(0, 20) } : {}),
    };
    res.status(202).json({ accepted: true });
    void svc.push.receive(trig, true).catch((err) => deps.reportDegradation?.('MobilePush.receive', err)); // @silent-fallback-ok — reported through DegradationReporter
  });

  router.get('/mobile/push', (_req: Request, res: Response) => {
    if (!svc.enabled()) { json503(res); return; }
    if (!svc.push) { res.json({ enabled: false, keyConfigured: false, devices: [], reason: 'not-built' }); return; }
    res.json(svc.push.status());
  });

  // ── Native operator chat (docs/specs/mobile-operator-chat.md) ──
  // Order: authenticate → look up → preflight → reserve → core → mirror.
  const chatRate = new Map<string, number[]>();
  const chatStoreOf = (): MobileChatRequestStore | null => svc.chatRequests();
  router.post('/mobile/chat/:topicId', async (req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store');
    if (!svc.enabled()) { json503(res); return; }
    const p = principalOf(req);
    if (p.kind !== 'device') { res.status(403).json({ error: 'operator-device-required' }); return; }
    const sender = devicePersonOf(req);
    if (!sender) { res.status(403).json({ error: 'person-unknown' }); return; }
    const senderPerson = !isOwnerPerson(sender) && sender.userId ? { machineId: svc.machineId(), userId: sender.userId } : null;
    const senderTrust = { role: sender.role, ...(senderPerson ? { person: senderPerson } : {}) };
    const body = (req.body ?? {}) as Record<string, unknown>;
    const topicId = Number(req.params.topicId);
    const text = typeof body.text === 'string' ? body.text.trim() : '';
    const requestId = body.requestId;
    if (!Number.isSafeInteger(topicId) || topicId <= 0) { res.status(400).json({ error: 'bad-topic' }); return; }
    // Files (mobile-native-chat-media §4.3, §4.9): with media on (which needs native conversations
    // and their store), a body with attachments becomes a `media-message` stored under
    // `telegram:<topicId>`. With media off, a body with files is refused as before: a message is
    // never stored without its files. An exact emergency stop never waits on its files.
    const mediaOn = svc.nativeOn && isMobileMediaEnabled(deps.config) && !!poolCtx?.appConversations;
    if (body.attachments !== undefined && !mediaOn) { res.status(400).json(isMobileMediaEnabled(deps.config) ? { error: 'media-target-unsupported', detail: 'Files can be sent in app conversations. Sending them into a Telegram topic is not available yet.' } : { error: 'media-target-unsupported', detail: 'Files are turned off on this agent.', action: MEDIA_OFF_ACTION }); return; }
    let signedFiles: SignedAttachment[] | null = null;
    if (body.attachments !== undefined && !isExactStopMessage(text)) {
      const checked = checkSignedFiles(body.attachments);
      if ('status' in checked) { res.status(checked.status).json(checked.body); return; }
      signedFiles = checked.files;
    }
    if ((text.length < 1 && !signedFiles) || text.length > 4000) { res.status(400).json({ error: 'text must be 1-4000 characters' }); return; }
    if (typeof requestId !== 'string' || requestIdTime(requestId) === null) { res.status(400).json({ error: 'bad-request-id' }); return; }
    const store = chatStoreOf();
    if (!store) { res.status(503).json({ error: 'chat-unavailable', detail: 'The message record could not be read right now.' }); return; }
    // The idempotency hash covers the text and, with files, each file's signed fields (§4.3).
    const hash = signedFiles ? payloadHash(topicId, ['\u0000media', text, ...signedFileHashParts(signedFiles)].join('\n')) : payloadHash(topicId, text);
    const answer = (l: ReturnType<MobileChatRequestStore['lookup']>): boolean => {
      if (l.kind === 'done') { res.status(l.status).json(l.body); return true; }
      if (l.kind === 'in-progress') { res.status(202).json({ state: 'in-progress' }); return true; }
      if (l.kind === 'outcome-unknown') { res.status(409).json({ error: 'outcome-unknown', detail: 'This message may or may not have reached the agent. Check the conversation.' }); return true; }
      if (l.kind === 'request-id-reused') { res.status(409).json({ error: 'request-id-reused' }); return true; }
      return false;
    };
    // A request already on record gets its recorded answer, whatever the checks below say now.
    if (answer(store.lookup(p.deviceId, requestId, hash))) return;

    // Preflight: no effect on any session or history.
    if (!isMobileChatEnabled(deps.config)) { res.status(503).json({ error: 'Chat from the app is turned off on this agent.' }); return; }
    const tg = poolCtx?.telegram;
    const ingest = poolCtx?.mobileInbound?.ingest;
    // The owner the app speaks as: the configured owner, else the one verified operator (the same
    // answer authority-bearing buttons use). An agent set up without ownerUserId still has an owner.
    const ownerId = tg?.getVerifiedOwner?.() ?? tg?.getOwnerUserId?.();
    if (!tg || !ingest || !ownerId) { res.status(503).json({ error: 'chat-unavailable', detail: 'This agent has no Telegram owner to speak as.' }); return; }
    if (!svc.holdsLease()) { res.status(409).json({ error: 'not-serving', detail: 'Messages aren\'t being received right now. Try again shortly or use Telegram.' }); return; }
    const t = Date.now();
    const recent = (chatRate.get(p.deviceId) ?? []).filter((x) => t - x < 60_000);
    if (recent.length >= 20) { chatRate.set(p.deviceId, recent); res.status(429).json({ error: 'too-many-requests' }); return; }
    recent.push(t); chatRate.set(p.deviceId, recent);
    if (!tg.getAllTopicMappings().some((m) => m.topicId === topicId)) { res.status(404).json({ error: 'unknown-topic' }); return; }
    if (!requestIdAgeOk(requestId, t)) { res.status(400).json({ error: 'request-id-too-old' }); return; }
    svc.scanInbound(text); // may cancel a pending pairing; never refuses the message
    // With native conversations on (mobile-native-conversations §4.2, §4.9) no content check
    // refuses the message: exact authority tokens (pairing invites, desktop codes) are REMOVED and
    // the rest is delivered (`redacted: true`), and credential-shaped text is the operator's call,
    // made in the app — the server only signals it (`credentialShaped: true`). Off: unchanged.
    let delivered = text;
    let removedKinds: string[] = [];
    let credentialShaped = false;
    if (svc.nativeOn) {
      const removed = removeAuthorityTokens(text);
      delivered = removed.text;
      removedKinds = removed.kinds;
      credentialShaped = detectOutboundCredential(text).detected;
    } else {
      if (PairingInviteTelegram.carriesInvite(text) || /^\/desktop(?:\s|$)/i.test(text)) { res.status(422).json({ error: 'not-from-the-app' }); return; }
      if (detectOutboundCredential(text).detected) {
        res.status(422).json({ error: 'credential-refused', detail: 'This looks like a password or key, so it was not sent. Use a Secret Drop link for secrets.' });
        return;
      }
    }
    // Signed records (mobile-native-conversations §4.9): with native conversations on, the message
    // is ALSO kept in the app conversation store under `telegram:<topicId>` with its signed origin
    // and this machine's receipt, persisted BEFORE dispatch; the Telegram history row carries the
    // same eventId, so a device's history read can join to it and return `originVerified`.
    const app = svc.nativeOn ? poolCtx?.appConversations ?? null : null;
    // The signed path must name the stored conversation exactly (`/mobile/chat/7`, never `/007`).
    if (app && String(req.params.topicId) !== String(topicId)) { res.status(400).json({ error: 'bad-topic' }); return; }
    const storeKey = `telegram:${topicId}`;
    // The payload hash is part of the seed: an early refusal releases the request id, and a retry
    // with the same id but different text must be a different stored message, never the old one.
    const seed = `${p.deviceId}\u0000${requestId}\u0000${hash}`;
    const storeMessageId = derivedEventId('msg', seed);
    const storeEventId = derivedEventId('op', seed);

    // Media preflight (chat-media §4.3, §4.9): each named upload is this device's finished upload
    // for THIS topic, with exactly the signed fields; filenames and transcripts get the caption's
    // treatment. Transcripts join the text for the credential signal, as in app conversations.
    let uploadIds: string[] = [];
    let stored: AppAttachment[] = [];
    // A retry of a request the inbound core refused early (its id was released AFTER the message
    // and its files were saved): the uploads are already sent into THIS message, so the saved
    // record is reused as it is, never claimed or written twice.
    const saved = signedFiles && app ? app.store.getEvent(storeKey, storeEventId) : null;
    const resent = saved?.kind === 'media-message' && saved.messageId === storeMessageId ? saved : null;
    if (resent) {
      stored = resent.attachments;
      for (const k of resent.origin?.redaction?.kinds ?? []) if (!removedKinds.includes(k)) removedKinds = [...removedKinds, k];
      credentialShaped = detectOutboundCredential([text, ...signedFiles!.map((a) => a.transcript ?? '')].join('\n')).detected;
    } else if (signedFiles && app) {
      const pre = preflightMediaAttachments(app, { deviceId: p.deviceId, conversationRef: storeKey, messageId: storeMessageId, files: signedFiles, scanInbound: (x) => svc.scanInbound(x) });
      if (!pre.ok) { res.status(pre.status).json(pre.body); return; }
      uploadIds = pre.uploadIds;
      stored = pre.stored;
      for (const k of pre.removedKinds) if (!removedKinds.includes(k)) removedKinds = [...removedKinds, k];
      credentialShaped = detectOutboundCredential([text, ...signedFiles.map((a) => a.transcript ?? '')].join('\n')).detected;
    }
    const extras = {
      ...(removedKinds.length > 0 ? { redacted: true, removed: removedKinds } : {}),
      ...(credentialShaped ? { credentialShaped: true } : {}),
    };

    // The record, built before the reservation so a media record that would not fit is refused
    // before any upload is claimed (chat-media §4.1). Signing has no side effect.
    let record: MessageEvent | MediaMessageEvent | null = null;
    if (app) {
      const receivedAt = new Date(deviceAdmittedAt(req) ?? Date.now()).toISOString();
      const signed = buildSignedOrigin(req, svc, p.deviceId, delivered, removedKinds, app.deps.signer ?? null, receivedAt,
        (detail) => app.deps.reportDegradation?.('MobileChat.sign', detail), stored.length > 0 ? stored : undefined);
      const base = {
        eventId: storeEventId, conversationKey: storeKey, messageId: storeMessageId, role: 'operator' as const, text: delivered,
        at: receivedAt, machineId: app.deps.machineId(), receivedAt,
        senderName: sender.name, senderRole: sender.role, ...(senderPerson ? { senderPerson } : {}),
        ...(signed.origin ? { origin: signed.origin } : {}), ...(signed.receipt ? { receipt: signed.receipt } : {}),
      };
      record = stored.length > 0 ? { ...base, kind: 'media-message', attachments: stored } : { ...base, kind: 'message' };
      if (record.kind === 'media-message' && mediaRecordTooLarge(record, signed.origin, app.deps.machineId())) {
        res.status(413).json({ error: 'message-too-large', detail: 'This message is too long to store. Shorten the text or send fewer files.' });
        return;
      }
    }

    // Reserve (synchronous with the decisive lookup).
    let r: ReturnType<MobileChatRequestStore['reserve']>;
    try { r = store.reserve(p.deviceId, requestId, hash, topicId, app ? { op: 'send', conversationKey: storeKey, messageId: storeMessageId } : undefined); } catch (err) {
      deps.reportDegradation?.('MobileChat.requestStore', err);
      res.status(503).json(storageErrorResponse({ error: 'chat-unavailable', detail: 'The message could not be recorded, so it was not sent. Try again.' }, svc.deps.stateDir));
      return;
    }
    if (r.kind === 'full') { res.status(429).json({ error: 'too-many-requests' }); return; }
    if (r.kind !== 'reserved') { answer(r); return; }

    if (app && record && !resent) {
      // Media: claim every upload at once and make the bytes durable before the event (§4.3).
      if (record.kind === 'media-message') {
        const refused = await claimMediaUploads(app, uploadIds, storeMessageId, (detail) => app.deps.reportDegradation?.('AppMedia.publish', detail));
        if (refused) { store.release(p.deviceId, requestId); res.status(refused.status).json(refused.body); return; }
      }
      try {
        if (record.kind === 'media-message') publishMediaMessage(app, uploadIds, record);
        else app.store.append(record);
      } catch (err) {
        store.release(p.deviceId, requestId);
        deps.reportDegradation?.('MobileChat.persist', err);
        res.status(503).json(storageErrorResponse({ error: 'chat-unavailable', detail: 'The message could not be saved, so it was not sent. Try again.' }, svc.deps.stateDir));
        return;
      }
    }
    const delivery = (state: 'delivered' | 'refused' | 'intercepted' | 'unknown'): void => {
      if (!app) return;
      try { app.appendDelivery(storeKey, storeMessageId, state, seed); } catch (err) { deps.reportDegradation?.('MobileChat.delivery', err); }
    };

    // Core: the same inbound steps a Telegram message takes.
    const eventId = app ? storeEventId : `mobile:${p.deviceId}:${requestId}`;
    // People and roles §3.3: the message carries the phone's person. Only an owner phone speaks with
    // the owner's Telegram id; an MSP phone carries NO Telegram id (the device path is senderTrusted,
    // so any id would count as proven Telegram authority) and is named in the sender tag only.
    const senderName = sender.name;
    const captured: { status: number; body: Record<string, unknown> } = { status: 200, body: {} };
    const fakeRes = {
      status(code: number) { captured.status = code; return fakeRes; },
      json(b: unknown) { captured.body = (b && typeof b === 'object' ? b : {}) as Record<string, unknown>; return fakeRes; },
      setHeader() { return fakeRes; },
    };
    // Files (chat-media §4.5): one line per file before the caption, in Telegram's forms, with a
    // server-chosen path to a private copy (the blobs were just published on this machine).
    let sessionText = delivered;
    if (app && stored.length > 0) {
      const lines = await app.sessionLinesFor(storeKey, storeMessageId, stored, delivered);
      sessionText = [...lines, ...(delivered ? [delivered] : [])].join('\n');
    }
    const fakeReq = {
      headers: {},
      body: {
        topicId, text: sessionText, messageId: 2 ** 52 + crypto.randomInt(0, 2 ** 47), timestamp: new Date(t).toISOString(),
        ...(sender.role === 'owner' ? { fromUserId: ownerId } : {}), fromFirstName: senderName, forwarded: false,
      },
    };
    try {
      await ingest(fakeReq, fakeRes, { deviceId: p.deviceId, eventId, sender: senderTrust });
    } catch (err) {
      delivery('unknown');
      store.markUnknown(p.deviceId, requestId);
      deps.reportDegradation?.('MobileChat.deliver', err);
      res.status(409).json({ error: 'outcome-unknown', eventId, detail: 'This message may or may not have reached the agent. Check the conversation.' });
      return;
    }
    const b = captured.body;
    // Only the core's early refusals (missing fields, the app refusal, the boot window) come before
    // any effect; those release the id. Any other failure answer is uncertain, never a refusal.
    const earlyRefusal = captured.status === 400 || captured.status === 422 || (captured.status === 503 && b.reason === 'server-boot-incomplete');
    if (earlyRefusal) {
      delivery('refused');
      store.release(p.deviceId, requestId);
      res.status(captured.status).json(b);
      return;
    }
    if (captured.status >= 400 || b.ok === false) {
      delivery('unknown');
      store.markUnknown(p.deviceId, requestId);
      deps.reportDegradation?.('MobileChat.deliver', new Error(`inbound core answered ${captured.status} ${String(b.error ?? b.reason ?? '')}`));
      res.status(409).json({ error: 'outcome-unknown', eventId, detail: 'This message may or may not have reached the agent. Check the conversation.' });
      return;
    }
    const outcome = b.sentinel === 'emergency-stop' ? 'sentinel-kill'
      : b.sentinel === 'pause' ? 'sentinel-pause'
      : b.deduped ? 'deduped'
      : b.agentMessage ? 'a2a-handled'
      : 'delivered';
    delivery(outcome === 'sentinel-kill' || outcome === 'sentinel-pause' ? 'intercepted' : 'delivered');

    // Mirror: best-effort, never decides delivery.
    let mirrored = false;
    let mirrorRecorded: { quietId: string; deliveredParts: number } | undefined;
    try {
      // The mirror is a copy for people reading the topic: credential-shaped spans always show
      // as "[credential hidden]", even when the operator sent them as written (§4.9).
      const mirrorText = svc.nativeOn ? hideCredentialSpans(delivered) : text;
      // Only this authenticated, accepted ingress creates these closures. The shared helper
      // keeps its routine default; each physical mirror call gets this verified conversation scope.
      const sendMirrorText: TelegramMediaMirrorTarget['sendToTopic'] = (id, value, options) =>
        withNotificationEnvelope(verifiedInboundMirrorEnvelope('verified-mobile-ingress-mirror'), () => tg.sendToTopic(id, value, options));
      const mirrorTarget: TelegramMediaMirrorTarget = {
        sendToTopic: sendMirrorText,
        sendMediaToTopic: (id, files, value, options) => withNotificationEnvelope(verifiedInboundMirrorEnvelope('verified-mobile-ingress-mirror'),
          () => (tg as unknown as TelegramMediaMirrorTarget).sendMediaToTopic(id, files, value, options)),
      };
      if (app && stored.length > 0) {
        const result = await mirrorMediaToTelegram(mirrorTarget, topicId, senderName, stored, mirrorText, (sha) => app.media.locateBlob(sha), requestDeviceClient(req));
        if (result.delivery.outcome === 'recorded') mirrorRecorded = { quietId: result.delivery.receipt.quietId, deliveredParts: result.delivery.deliveredParts };
        else mirrored = true;
      } else {
        // 💻 "(from the dashboard)" for a browser device (dashboard-conversations-browser-device §4.7).
        const result = await sendMirrorText(topicId, `${mirrorPrefix(requestDeviceClient(req), senderName)}: ${mirrorText}`, { silent: true, skipStallClear: true, operatorMirror: true });
        if (isQuietReceipt(result)) mirrorRecorded = { quietId: result.quietId, deliveredParts: 0 };
        else mirrored = true;
      }
    } catch (err) {
      if (err instanceof QuietRecordedError) mirrorRecorded = { quietId: err.receipt.quietId, deliveredParts: 0 };
      else deps.reportDegradation?.('MobileChat.mirror', err);
    }
    const response = {
      ok: true, outcome, eventId, mirrored,
      ...(mirrorRecorded ? { mirror: 'recorded', mirrorQuietId: mirrorRecorded.quietId, partiallyMirrored: mirrorRecorded.deliveredParts > 0 } : {}),
      ...(stored.length > 0 ? { ...(mirrorRecorded ? {} : { mirror: mirrored ? 'sent' : 'failed' }), messageId: storeMessageId } : {}), ...extras,
      ...(b.killed !== undefined ? { stopped: b.killed } : {}),
      ...(b.paused !== undefined ? { paused: b.paused } : {}),
    };
    if (!store.finish(p.deviceId, requestId, { status: 200, body: response })) {
      deps.reportDegradation?.('MobileChat.requestStore', new Error('could not record the finished request'));
    }
    res.json(response);
  });

  return router;
}

type Principal = { kind: 'device'; deviceId: string } | { kind: 'device-notify'; deviceId: string } | { kind: 'token' };
export function principalOf(req: Request): Principal {
  return ((req as unknown as { instarPrincipal?: Principal }).instarPrincipal) ?? { kind: 'token' };
}

/** `{ name, role }` for a resolved person; `{ role, unassigned: true }` for a removed one. */
/** What each tier's tabs are (§3.4, §3.8). The server still enforces every route. */
const TIER_SCREENS: Readonly<Record<string, readonly string[]>> = {
  guest: ['chat', 'my-access'],
  member: ['chat', 'composer', 'new-conversation', 'my-access'],
};

/** A team phone's standing, from the log. Only a team phone has one. */
function standingView(svc: MobilePairingService, d: DeviceRecord): Record<string, unknown> {
  if (d.role !== 'team' || !d.userId) return {};
  const s = svc.teamStanding(d.userId);
  return s ? { standing: { tier: s.tier, screens: TIER_SCREENS[s.tier] ?? TIER_SCREENS.guest } } : {};
}

/** The plain reason behind a gate refusal, for the phone to show (a machine code alone says nothing). */
const REFUSAL_DETAIL: Readonly<Record<string, string>> = {
  'tier-required': 'You do not have access to this.',
  'person-unknown': 'This phone is no longer linked to anyone on this agent. Ask the owner for a new invite.',
  'memory-privacy-required': 'Team access needs memory privacy, which is off right now. The owner can turn it back on.',
  'team-needs-one-machine': 'Team members work on agents running on one machine for now. Support for several machines is the next step.',
  'read-only-owner-reach': 'You can read this conversation but not send to it, because its session has the owner\'s full access.',
  'owner-phone-required': 'Only the owner\'s phone can do this.',
  'unknown-conversation': 'This conversation is not available to you.',
};

function personView(p: DevicePerson): Record<string, unknown> {
  return p.ok ? { name: p.name, role: p.role } : { role: p.role, unassigned: true };
}

/** The person fields of a device row (people and roles §3.2). */
export function personFields(d: DeviceRecord, svc: MobilePairingService): Record<string, unknown> {
  const p = svc.personOfDevice(d);
  return { role: p.role, personName: p.ok ? p.name : null, ...(p.ok ? {} : { unassigned: true }) };
}

function publicDeviceView(d: DeviceRecord, machine: string | null, svc?: MobilePairingService): Record<string, unknown> {
  // A ledger revocation row wins for a browser at once, everywhere (dashboard-conversations-browser-device §4.6).
  let status: DeviceRecord['status'] = d.status;
  if (isBrowserDevice(d) && status !== 'revoked' && svc?.keyLedger && d.browserPublicKey) {
    try { if (svc.keyLedger.keyRevoked(keyHashOf(d.browserPublicKey))) status = 'revoked'; } catch { /* @silent-fallback-ok — the registry status is shown when the ledger cannot be read */ }
  }
  const showFingerprint = status === 'active' || status === 'revoked';
  return {
    id: d.id, deviceName: d.deviceName, label: d.label, pairedAt: d.pairedAt, status, ...(svc ? personFields(d, svc) : {}),
    ...(isBrowserDevice(d) ? { client: 'browser', lastSeenAt: d.lastSeenAt ?? null, ...(svc && !svc.browserOn() ? { switchedOff: true } : {}) } : {}),
    ...(showFingerprint && d.fingerprint ? { fingerprint: d.fingerprint } : {}),
    ...(d.approvedAt ? { approvedAt: d.approvedAt } : {}), ...(d.revokedAt ? { revokedAt: d.revokedAt } : {}),
    machine,
  };
}

async function forwardRevoke(ctx: PoolCtx, id: string): Promise<{ confirmedBy: string | null }> {
  const peers = (ctx.resolvePeerUrls?.() ?? []).slice(0, 16);
  const allow = (ctx.config.multiMachine as { peerUrlAllowlist?: string[] } | undefined)?.peerUrlAllowlist;
  let confirmedBy: string | null = null;
  await Promise.all(peers.map(async (p) => {
    if (!isPeerUrlAllowedForCredentials({ url: p.url, kind: p.kind }, allow).ok) return;
    try {
      const r = await poolPeerFetch(ctx.recordRopeResult ?? undefined, p, `/mobile/devices/${encodeURIComponent(id)}/revoke`, {
        method: 'POST', headers: { Authorization: `Bearer ${ctx.config.authToken}`, 'Content-Type': 'application/json' }, body: '{}',
        signal: AbortSignal.timeout(PEER_TIMEOUT_MS),
      });
      if (r.ok) confirmedBy = p.machineId;
    } catch { /* @silent-fallback-ok — an unreachable peer is reported by the 202 pending answer */ }
  }));
  return { confirmedBy };
}

// ── Device authentication (wired into authMiddleware) ───────────────────────────────

/** Exact routes a device principal may use (spec 2.3); path lowercased, trailing slash removed. */
// `sendRoute`: a send route (Telegram, app, Slack). Its authentication-time device rate limit is skipped
// when native conversations are on: sends have their own limit in preflight, so the app's read
// polling can never use up the allowance an emergency stop needs (mobile-native-conversations §4.2).
const UUID = APP_CONVERSATION_KEY_PATTERN;
// `body`: the request body this rule accepts ('json' when absent, as for every older rule, which
// also allows no body). `ownBucket`: requests per minute in the rule's own bucket instead of the
// shared read allowance (media chunks, mobile-native-chat-media §4.10).
// `unassignedOk`: the route answers a phone whose person is no longer in the registry (people and
// roles §3.4): only its own status, confirm and self-revoke. `conversationRef`: the route names a
// conversation, so it must call the shared `mayUse` check (the coverage test reads this flag).
// `ownerOnly`: only a phone whose person is the owner (403 owner-phone-required otherwise).
// `bucket`: the name of the rule's own bucket (rules sharing a name share a count).
// `browser`: a browser device may use the route (dashboard-conversations-browser-device §4.4). Closed
// by default: a route opens to browsers only by being named in BROWSER_ROUTES below.
export interface DeviceRule { method: string; re: RegExp; statuses: ReadonlySet<DeviceStatus>; sendRoute?: boolean; body?: 'json' | 'octet' | 'none'; ownBucket?: number; bucket?: string; unassignedOk?: boolean; conversationRef?: boolean; ownerOnly?: boolean; tier?: Tier; browser?: true }

/**
 * The routes a browser device may call (dashboard-conversations-browser-device §4.4): its own
 * status, confirm and self-revoke, and the conversation and media routes. Everything else —
 * presence keys, console tickets, permissions, desktop, the dashboard PIN, team, people, pairing
 * approval, introducers, session control, push, attention — stays closed to browsers.
 */
const BROWSER_ROUTES: ReadonlyArray<[string, string]> = [
  ['GET', /^\/mobile\/device$/.source],
  ['POST', /^\/mobile\/device\/confirm$/.source],
  ['POST', /^\/mobile\/devices\/[^/]+\/revoke$/.source],
  ['GET', /^\/mobile\/conversations$/.source],
  // Keyword search over conversations (conversation-search): the same visibility as the list.
  ['GET', /^\/mobile\/conversations\/search$/.source],
  // Reading in the dashboard clears the count the phone sees (dashboard-read-markers): the same per-person marker.
  ['POST', /^\/mobile\/conversations\/read$/.source],
  ['POST', /^\/mobile\/conversations$/.source],
  ['PATCH', new RegExp(`^/mobile/conversations/${APP_CONVERSATION_KEY_PATTERN}$`).source],
  ['DELETE', new RegExp(`^/mobile/conversations/${APP_CONVERSATION_KEY_PATTERN}$`).source],
  ['POST', new RegExp(`^/mobile/chat/app/${APP_CONVERSATION_KEY_PATTERN}$`).source],
  ['GET', new RegExp(`^/mobile/chat/app/${APP_CONVERSATION_KEY_PATTERN}/messages$`).source],
  ['GET', new RegExp(`^/mobile/chat/app/${APP_CONVERSATION_KEY_PATTERN}/events$`).source],
  ['GET', /^\/telegram\/topics$/.source],
  ['GET', /^\/topic\/list$/.source],
  ['GET', /^\/telegram\/topics\/[^/]+\/messages$/.source],
  ['POST', /^\/mobile\/chat\/\d+$/.source],
  ['GET', /^\/mobile\/chat\/slack\/-[1-9][0-9]{0,17}\/messages$/.source],
  ['POST', /^\/mobile\/chat\/slack\/-[1-9][0-9]{0,17}$/.source],
  // Pinned messages (conversation-pinned-messages).
  ['GET', new RegExp(`^/mobile/chat/app/${APP_CONVERSATION_KEY_PATTERN}/pins$`).source],
  ['POST', new RegExp(`^/mobile/chat/app/${APP_CONVERSATION_KEY_PATTERN}/pins$`).source],
  ['GET', /^\/mobile\/chat\/[1-9][0-9]{0,15}\/pins$/.source],
  ['POST', /^\/mobile\/chat\/[1-9][0-9]{0,15}\/pins$/.source],
  ['GET', /^\/mobile\/chat\/slack\/-[1-9][0-9]{0,17}\/pins$/.source],
  ['POST', /^\/mobile\/chat\/slack\/-[1-9][0-9]{0,17}\/pins$/.source],
  ['POST', /^\/mobile\/media\/uploads$/.source],
  ['PUT', new RegExp(`^/mobile/media/uploads/${APP_CONVERSATION_KEY_PATTERN}/chunks/(0|[1-9][0-9]{0,5})$`).source],
  ['GET', new RegExp(`^/mobile/media/uploads/${APP_CONVERSATION_KEY_PATTERN}$`).source],
  ['GET', /^\/mobile\/media\/[0-9a-f]{64}$/.source],
];

/**
 * The routes a team phone may reach, and the lowest tier for each (team-roles-and-access §3.7). This
 * list opens routes: anything not named reads `admin` or `owner`, so a route added later stays closed
 * to members and guests until someone decides otherwise. `msp` and owner phones do not read tiers.
 */
const TEAM_ROUTE_TIERS: ReadonlyArray<[string, RegExp, Tier]> = [
  ['GET', /^\/health$/, 'guest'],
  ['GET', /^\/mobile\/routes$/, 'guest'],
  ['GET', /^\/mobile\/device$/, 'guest'],
  ['POST', /^\/mobile\/device\/confirm$/, 'guest'],
  ['POST', /^\/mobile\/device\/push$/, 'guest'],
  ['POST', /^\/mobile\/device\/presence-key$/, 'guest'],
  ['POST', /^\/mobile\/devices\/[^/]+\/revoke$/, 'guest'],
  ['GET', /^\/mobile\/devices$/, 'guest'],
  ['GET', /^\/topic\/list$/, 'guest'],
  ['GET', /^\/telegram\/topics$/, 'guest'],
  ['GET', /^\/telegram\/topics\/[^/]+\/messages$/, 'guest'],
  ['GET', /^\/attention$/, 'admin'],
  ['GET', /^\/sessions$/, 'admin'],
  ['GET', /^\/mobile\/conversations$/, 'guest'],
  // Searching is reading (conversation-search): only conversations and messages this person may read.
  ['GET', /^\/mobile\/conversations\/search$/, 'guest'],
  // Reading is guest (mobile-unread-messages §3.5): a read report names what this person has seen.
  ['POST', /^\/mobile\/conversations\/read$/, 'guest'],
  ['GET', /^\/mobile\/team\/people$/, 'guest'],
  ['GET', new RegExp(`^/mobile/chat/app/${UUID}/messages$`), 'guest'],
  ['GET', new RegExp(`^/mobile/chat/app/${UUID}/events$`), 'guest'],
  ['GET', new RegExp(`^/mobile/chat/app/${UUID}/preview/[a-z0-9._:-]{1,128}$`), 'guest'],
  ['GET', /^\/mobile\/media\/[0-9a-f]{64}$/, 'guest'],
  ['POST', /^\/mobile\/conversations$/, 'member'],
  ['PATCH', new RegExp(`^/mobile/conversations/${UUID}$`), 'member'],
  ['DELETE', new RegExp(`^/mobile/conversations/${UUID}$`), 'member'],
  ['POST', /^\/mobile\/chat\/\d+$/, 'member'],
  ['POST', new RegExp(`^/mobile/chat/app/${UUID}$`), 'member'],
  ['POST', /^\/mobile\/media\/uploads$/, 'member'],
  ['PUT', new RegExp(`^/mobile/media/uploads/${UUID}/chunks/(0|[1-9][0-9]{0,5})$`), 'member'],
  ['GET', new RegExp(`^/mobile/media/uploads/${UUID}$`), 'member'],
  ['POST', /^\/mobile\/media\/purge$/, 'member'],
  // Pinned messages (conversation-pinned-messages): seeing pins is reading, changing them is using the conversation.
  ['GET', new RegExp(`^/mobile/chat/app/${UUID}/pins$`), 'guest'],
  ['POST', new RegExp(`^/mobile/chat/app/${UUID}/pins$`), 'member'],
  ['GET', /^\/mobile\/chat\/[1-9][0-9]{0,15}\/pins$/, 'guest'],
  ['POST', /^\/mobile\/chat\/[1-9][0-9]{0,15}\/pins$/, 'member'],
];

/** The conversation and operation a team phone's request acts on, read from its path. */
export function teamConversationTarget(method: string, pathNorm: string): { ref: string; op: ConversationOp } | null {
  let m = /^\/mobile\/chat\/(\d+)$/.exec(pathNorm);
  // By number, as the handler reads it: `01` is topic 1, whatever the address says.
  if (m && method === 'POST') return { ref: `telegram:${Number(m[1])}`, op: 'send' };
  // Matches everything the allow rule does. A topic that is not plain digits names no grant, so it is
  // refused here; the handler would parseInt it into a real topic.
  m = /^\/telegram\/topics\/([^/]+)\/messages$/.exec(pathNorm);
  if (m && method === 'GET') return { ref: `telegram:${m[1]}`, op: 'read' };
  // Pinned messages: seeing pins is a read, pinning or unpinning is a send (conversation-pinned-messages).
  m = /^\/mobile\/chat\/([1-9][0-9]{0,15})\/pins$/.exec(pathNorm);
  if (m) return { ref: `telegram:${Number(m[1])}`, op: method === 'POST' ? 'send' : 'read' };
  m = /^\/mobile\/chat\/slack\/(-?\d+)\/pins$/.exec(pathNorm);
  if (m) return { ref: `slack:${m[1]}`, op: method === 'POST' ? 'send' : 'read' };
  m = /^\/mobile\/chat\/slack\/(-?\d+)$/.exec(pathNorm);
  if (m && method === 'POST') return { ref: `slack:${m[1]}`, op: 'send' };
  m = new RegExp(`^/mobile/chat/app/(${UUID})(/messages|/events|/pins|/preview/.+)?$`).exec(pathNorm);
  if (m) return { ref: m[1], op: method === 'POST' && (!m[2] || m[2] === '/pins') ? 'send' : 'read' };
  m = new RegExp(`^/mobile/conversations/(${UUID})$`).exec(pathNorm);
  if (m) return { ref: m[1], op: method === 'DELETE' ? 'delete' : 'rename' };
  return null;
}

export const DEVICE_ALLOWLIST: DeviceRule[] = (() => {
  const active: ReadonlySet<DeviceStatus> = new Set(['active']);
  const rules: DeviceRule[] = [
    // Conversations v3 owner hierarchy. Admission still requires a live device
    // signature; the mounted graph source separately enforces increment A.
    { method: 'GET', re: /^\/mobile\/conversation-graph\/roots$/, statuses: active, body: 'none', ownerOnly: true, ownBucket: 30, bucket: 'conversation-graph-reads' },
    { method: 'GET', re: /^\/mobile\/conversation-graph\/nodes\/[a-z0-9_-]{1,2048}$/, statuses: active, body: 'none', ownerOnly: true, ownBucket: 30, bucket: 'conversation-graph-reads' },
    { method: 'GET', re: /^\/mobile\/conversation-graph\/nodes\/[a-z0-9_-]{1,2048}\/destinations$/, statuses: active, body: 'none', ownerOnly: true, ownBucket: 30, bucket: 'conversation-graph-reads' },
    { method: 'GET', re: /^\/mobile\/conversation-graph\/(pending|changes\/[a-z0-9_.:%-]{8,480})$/, statuses: active, body: 'none', ownerOnly: true, ownBucket: 30, bucket: 'conversation-graph-reads' },
    { method: 'POST', re: /^\/mobile\/conversation-graph\/forget-header\/(discover|ensure)$/, statuses: active, body: 'json', ownerOnly: true, ownBucket: 20, bucket: 'conversation-graph-changes' },
    { method: 'GET', re: /^\/mobile\/conversation-graph\/erasures\/[A-Za-z0-9_-]{8,160}$/, statuses: active, ownerOnly: true, ownBucket: 20, bucket: 'conversation-graph-changes' },
    { method: 'POST', re: /^\/mobile\/conversation-graph\/(changes|preview|undo|forget-header)$/, statuses: active, body: 'json', ownerOnly: true, ownBucket: 20, bucket: 'conversation-graph-changes' },
    { method: 'POST', re: /^\/mobile\/conversation-graph\/changes\/(?:(graph-event|header-op)(:|%3a)[a-z0-9_-]{8,80}|queued(:|%3a)owner-change(:|%3a)[a-f0-9]{64})\/cancel$/, statuses: active, body: 'json', ownerOnly: true, ownBucket: 20, bucket: 'conversation-graph-changes' },
    { method: 'GET', re: /^\/health$/, statuses: active },
    { method: 'GET', re: /^\/attention$/, statuses: active },
    { method: 'GET', re: /^\/sessions$/, statuses: active },
    { method: 'GET', re: /^\/telegram\/topics$/, statuses: active },
    // Topic recency for the app's conversation list (newest first); read-only.
    { method: 'GET', re: /^\/topic\/list$/, statuses: active },
    { method: 'GET', re: /^\/telegram\/topics\/[^/]+\/messages$/, statuses: active },
    { method: 'GET', re: /^\/mobile\/devices$/, statuses: active },
    { method: 'GET', re: /^\/mobile\/routes$/, statuses: active },
    { method: 'GET', re: /^\/mobile\/device$/, statuses: new Set(['pending', 'active', 'declined', 'expired']), unassignedOk: true },
    { method: 'POST', re: /^\/mobile\/device\/confirm$/, statuses: new Set(['pending', 'active']), unassignedOk: true },
    // Every POST, PATCH and DELETE below is idempotent through MobileChatRequestStore (requestId).
    { method: 'POST', re: /^\/mobile\/chat\/\d+$/, statuses: active, sendRoute: true },
    // Native app conversations (mobile-native-conversations §4.10), strict lowercase UUIDs.
    { method: 'GET', re: /^\/mobile\/conversations$/, statuses: active, conversationRef: true },
    // Keyword search over conversations (conversation-search): `ref=` names one; its own bucket, so typing never uses up the read allowance.
    { method: 'GET', re: /^\/mobile\/conversations\/search$/, statuses: active, body: 'none', conversationRef: true, ownBucket: 30, bucket: 'conversation-search' },
    { method: 'POST', re: /^\/mobile\/conversations$/, statuses: active },
    // Read reports (mobile-unread-messages §3.5): their own bucket, so they never draw on the shared
    // read allowance the emergency stop relies on. GET /mobile/conversations/read-markers is Bearer only.
    { method: 'POST', re: /^\/mobile\/conversations\/read$/, statuses: active, body: 'json', conversationRef: true, ownBucket: 60, bucket: 'read-marks' },
    { method: 'PATCH', re: new RegExp(`^/mobile/conversations/${UUID}$`), statuses: active, conversationRef: true },
    { method: 'DELETE', re: new RegExp(`^/mobile/conversations/${UUID}$`), statuses: active, conversationRef: true },
    { method: 'POST', re: new RegExp(`^/mobile/chat/app/${UUID}$`), statuses: active, sendRoute: true, conversationRef: true },
    { method: 'GET', re: new RegExp(`^/mobile/chat/app/${UUID}/messages$`), statuses: active, conversationRef: true },
    { method: 'GET', re: new RegExp(`^/mobile/chat/app/${UUID}/events$`), statuses: active, conversationRef: true },
    // "Open session": which session drives a conversation on this machine, plus a dashboard link. Read-only.
    { method: 'GET', re: /^\/mobile\/conversations\/session$/, statuses: active, body: 'none', conversationRef: true },
    { method: 'GET', re: /^\/mobile\/conversations\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/placement$/, statuses: active, body: 'none', conversationRef: true },
    // Slack conversations from the app (§4.9): the machine-local negative durable id.
    { method: 'POST', re: /^\/mobile\/chat\/slack\/-[1-9][0-9]{0,17}$/, statuses: active, sendRoute: true, conversationRef: true },
    { method: 'GET', re: /^\/mobile\/chat\/slack\/-[1-9][0-9]{0,17}\/messages$/, statuses: active, conversationRef: true },
    // Pinned messages (conversation-pinned-messages): list and pin/unpin, their own bucket.
    { method: 'GET', re: new RegExp(`^/mobile/chat/app/${UUID}/pins$`), statuses: active, body: 'none', conversationRef: true },
    { method: 'POST', re: new RegExp(`^/mobile/chat/app/${UUID}/pins$`), statuses: active, body: 'json', conversationRef: true, ownBucket: 30, bucket: 'pins' },
    { method: 'GET', re: /^\/mobile\/chat\/[1-9][0-9]{0,15}\/pins$/, statuses: active, body: 'none', conversationRef: true },
    { method: 'POST', re: /^\/mobile\/chat\/[1-9][0-9]{0,15}\/pins$/, statuses: active, body: 'json', conversationRef: true, ownBucket: 30, bucket: 'pins' },
    { method: 'GET', re: /^\/mobile\/chat\/slack\/-[1-9][0-9]{0,17}\/pins$/, statuses: active, body: 'none', conversationRef: true },
    { method: 'POST', re: /^\/mobile\/chat\/slack\/-[1-9][0-9]{0,17}\/pins$/, statuses: active, body: 'json', conversationRef: true, ownBucket: 30, bucket: 'pins' },
    // Reply notification preview (chat-media §4.11); the read token opens it too (NOTIFY_TOKEN_PATHS).
    { method: 'GET', re: new RegExp(`^/mobile/chat/app/${UUID}/preview/[a-z0-9._:-]{1,128}$`), statuses: active, conversationRef: true },
    { method: 'POST', re: /^\/mobile\/device\/push$/, statuses: active },
    // Team access (team-roles-and-access §4.1): the owner writes; a member reads their own row.
    { method: 'GET', re: /^\/mobile\/team\/people$/, statuses: active, body: 'none' },
    { method: 'GET', re: /^\/mobile\/team\/context$/, statuses: active, body: 'none', ownerOnly: true },
    { method: 'GET', re: /^\/mobile\/team\/activity$/, statuses: active, body: 'none', ownerOnly: true },
    // Chief of Staff §4: the owner's phone checks in (renews the operator lease); owner phones only.
    { method: 'POST', re: /^\/mobile\/chief-of-staff\/check-in$/, statuses: active, body: 'json', ownerOnly: true, ownBucket: 12, bucket: 'owner-presence' },
    { method: 'GET', re: /^\/mobile\/team\/requests$/, statuses: active, body: 'none', ownerOnly: true },
    { method: 'POST', re: /^\/mobile\/team\/requests\/[^/]{1,128}\/decline$/, statuses: active, body: 'json', ownerOnly: true, ownBucket: 12, bucket: 'team-writes' },
    { method: 'GET', re: /^\/mobile\/team\/invites\/[^/]{1,128}$/, statuses: active, body: 'none', ownerOnly: true },
    { method: 'POST', re: /^\/mobile\/team\/invites$/, statuses: active, body: 'json', ownerOnly: true, ownBucket: 12, bucket: 'team-writes' },
    { method: 'POST', re: /^\/mobile\/team\/grants$/, statuses: active, body: 'json', ownerOnly: true, ownBucket: 12, bucket: 'team-writes' },
    { method: 'POST', re: /^\/mobile\/team\/people\/[^/]{1,128}$/, statuses: active, body: 'json', ownerOnly: true, ownBucket: 12, bucket: 'team-writes' },
    { method: 'POST', re: /^\/mobile\/team\/(off|restore|memory-privacy|origin-gone|switches\/turn-on)$/, statuses: active, body: 'json', ownerOnly: true, ownBucket: 12, bucket: 'permission-actions' },
    // People and roles §3.5: the owner's grant switches (owner phones only, checked in the route).
    { method: 'GET', re: /^\/mobile\/people$/, statuses: active },
    { method: 'POST', re: /^\/mobile\/people\/[^/]{1,128}\/grants$/, statuses: active },
    { method: 'GET', re: /^\/mobile\/attention\/[^/]+$/, statuses: active },
    // Media in app conversations (mobile-native-chat-media §4.10).
    { method: 'POST', re: /^\/mobile\/media\/uploads$/, statuses: active, body: 'json', conversationRef: true },
    { method: 'PUT', re: new RegExp(`^/mobile/media/uploads/${UUID}/chunks/(0|[1-9][0-9]{0,5})$`), statuses: active, body: 'octet', ownBucket: 240 },
    { method: 'GET', re: new RegExp(`^/mobile/media/uploads/${UUID}$`), statuses: active, body: 'none' },
    { method: 'GET', re: /^\/mobile\/media\/[0-9a-f]{64}$/, statuses: active, body: 'none', conversationRef: true, ownBucket: 120, bucket: 'media-read' },
    { method: 'POST', re: /^\/mobile\/media\/purge$/, statuses: active, body: 'json', conversationRef: true },
    // Console sign-in from an owner phone (mobile-console-device-signin §3.1-3.2); each route
    // re-checks owner, local TLS and the feature switch itself.
    // Approve a waiting phone with Face ID (docs/specs/mobile-pairing-approve.md §3.4): owner phones only.
    { method: 'GET', re: /^\/mobile\/pairing-requests$/, statuses: active, body: 'none', ownerOnly: true, ownBucket: 30, bucket: 'pairing-requests-read' },
    { method: 'POST', re: new RegExp(`^/mobile/pairing-requests/${UUID}/(challenge|approve|decline)$`), statuses: active, body: 'json', ownerOnly: true, ownBucket: 12, bucket: 'pairing-approve' },
    { method: 'POST', re: /^\/mobile\/device\/presence-key$/, statuses: active, body: 'json' },
    // Add a new agent from a phone you already use (mobile-pairing-introducer §3.2-3.3). The
    // introducer routes re-check owner, local TLS and the switch; the waiting phone hands in its own.
    { method: 'GET', re: /^\/mobile\/introducer$/, statuses: active, body: 'none', ownerOnly: true, ownBucket: 30, bucket: 'introducer-read' },
    { method: 'POST', re: /^\/mobile\/introductions(\/challenge)?$/, statuses: active, body: 'json', ownerOnly: true, ownBucket: 12, bucket: 'pairing-approve' },
    { method: 'POST', re: /^\/mobile\/device\/introduction$/, statuses: new Set(['pending', 'active']), body: 'json', ownBucket: 6, bucket: 'introduction-redeem' },
    { method: 'POST', re: /^\/mobile\/console-ticket\/challenge$/, statuses: active, body: 'json' },
    { method: 'POST', re: /^\/mobile\/console-ticket$/, statuses: active, body: 'json' },
    // Native schedule, promises and machines (mobile-native-ops-screens): read-only trimmed
    // summaries; the routes themselves refuse a phone whose person is not the owner.
    { method: 'GET', re: /^\/mobile\/jobs$/, statuses: active, body: 'none', ownerOnly: true },
    { method: 'GET', re: /^\/mobile\/commitments$/, statuses: active, body: 'none', ownerOnly: true },
    { method: 'GET', re: /^\/mobile\/machines$/, statuses: active, body: 'none', ownerOnly: true },
    { method: 'POST', re: /^\/mobile\/devices\/[^/]+\/revoke$/, statuses: new Set(['pending', 'active', 'declined', 'expired']), unassignedOk: true },
    // The native session screen (docs/specs/mobile-native-session-screen.md): read a session's pane
    // and type plain text into it. Owner phones only; each has its own bucket so polling and typing
    // never use up the read allowance the chat list needs. The path is lower-cased here; the router
    // reads the name with its case kept.
    { method: 'GET', re: /^\/sessions\/[a-z0-9_-]{1,200}\/output$/, statuses: active, body: 'none', ownerOnly: true, ownBucket: 90, bucket: 'session-output' },
    { method: 'POST', re: /^\/sessions\/[a-z0-9_-]{1,200}\/input$/, statuses: active, body: 'json', ownerOnly: true, ownBucket: 12, bucket: 'session-input' },
    // Native Accounts, What thinking costs and Resource usage (docs/specs/mobile-native-capacity-screens.md):
    // read-only trimmed summaries, owner phones only. One shared bucket of their own, so pulling to
    // refresh never uses up the chat list's read allowance and cannot multiply peer reads.
    { method: 'GET', re: /^\/mobile\/accounts$/, statuses: active, body: 'none', ownerOnly: true, ownBucket: 20, bucket: 'capacity-reads' },
    { method: 'GET', re: /^\/mobile\/spend$/, statuses: active, body: 'none', ownerOnly: true, ownBucket: 20, bucket: 'capacity-reads' },
    { method: 'GET', re: /^\/mobile\/resources$/, statuses: active, body: 'none', ownerOnly: true, ownBucket: 20, bucket: 'capacity-reads' },
    // Unified usage ledger (docs/specs/unified-usage-ledger.md, Slice 4): owner phone only, trimmed.
    { method: 'GET', re: /^\/mobile\/usage$/, statuses: active, body: 'none', ownerOnly: true, ownBucket: 20, bucket: 'capacity-reads' },
    // Native Plans, What I've learned about you and Other agents (docs/specs/mobile-native-plans-people.md):
    // read-only trimmed summaries, owner phones only, with one shared bucket of their own (they read peers).
    { method: 'GET', re: /^\/mobile\/plans$/, statuses: active, body: 'none', ownerOnly: true, ownBucket: 20, bucket: 'plans-people-reads' },
    { method: 'GET', re: /^\/mobile\/learned$/, statuses: active, body: 'none', ownerOnly: true, ownBucket: 20, bucket: 'plans-people-reads' },
    { method: 'GET', re: /^\/mobile\/agents$/, statuses: active, body: 'none', ownerOnly: true, ownBucket: 20, bucket: 'plans-people-reads' },
    // Native Messages to you and Insights (docs/specs/mobile-native-phones-messages.md): read-only trimmed
    // summaries, owner phones only, with one shared bucket of their own (they read peers).
    { method: 'GET', re: /^\/mobile\/messages$/, statuses: active, body: 'none', ownerOnly: true, ownBucket: 20, bucket: 'phones-messages-reads' },
    { method: 'GET', re: /^\/mobile\/insights$/, statuses: active, body: 'none', ownerOnly: true, ownBucket: 20, bucket: 'phones-messages-reads' },
    // Native Passwords & keys (docs/specs/mobile-native-secrets.md): a read-only trimmed summary, owner
    // phones only: names and state, never a value, a length, a token or a Secret Drop link.
    { method: 'GET', re: /^\/mobile\/secrets$/, statuses: active, body: 'none', ownerOnly: true, ownBucket: 20, bucket: 'secrets-reads' },
    // Native console pages and the read-only file browser (docs/specs/mobile-native-console-pages.md): owner
    // phones only, one shared bucket of their own. Each answer mirrors a console route, read on this machine.
    { method: 'GET', re: /^\/mobile\/ideas$/, statuses: active, body: 'none', ownerOnly: true, ownBucket: 20, bucket: 'console-pages-reads' },
    { method: 'GET', re: /^\/mobile\/pace$/, statuses: active, body: 'none', ownerOnly: true, ownBucket: 20, bucket: 'console-pages-reads' },
    { method: 'GET', re: /^\/mobile\/development$/, statuses: active, body: 'none', ownerOnly: true, ownBucket: 20, bucket: 'console-pages-reads' },
    { method: 'GET', re: /^\/mobile\/maturation$/, statuses: active, body: 'none', ownerOnly: true, ownBucket: 20, bucket: 'console-pages-reads' },
    { method: 'GET', re: /^\/mobile\/files$/, statuses: active, body: 'none', ownerOnly: true, ownBucket: 60, bucket: 'console-files-reads' },
    { method: 'GET', re: /^\/mobile\/files\/read$/, statuses: active, body: 'none', ownerOnly: true, ownBucket: 60, bucket: 'console-files-reads' },
    // What /health means for the person (docs/specs/mobile-health-issues.md): a read-only trimmed summary,
    // owner phones only. The Fleet screen reads it every 30 s, so it has its own bucket.
    { method: 'GET', re: /^\/mobile\/health-issues$/, statuses: active, body: 'none', ownerOnly: true, ownBucket: 20, bucket: 'health-issues-reads' },
    // The person's quick actions on a problem (docs/specs/health-quick-actions.md): undoable, so the device signature
    // is enough. Exactly these two paths: the routes machines use with each other are bearer-only.
    { method: 'POST', re: /^\/mobile\/health-issues\/choices$/, statuses: active, body: 'json', ownerOnly: true, ownBucket: 12, bucket: 'health-choices' },
    { method: 'POST', re: /^\/mobile\/health-issues\/choices\/undo$/, statuses: active, body: 'json', ownerOnly: true, ownBucket: 12, bucket: 'health-choices' },
    // Done and Ignore for a Needs-you item (docs/specs/mobile-attention-choices.md), in the same bucket.
    { method: 'POST', re: /^\/mobile\/attention\/(?=[a-z0-9._:-]*[a-z0-9])[a-z0-9._:-]{1,200}\/choice$/, statuses: active, body: 'json', ownerOnly: true, ownBucket: 12, bucket: 'health-choices' },
    // Native Proposals and How I'm doing inside (docs/specs/mobile-native-proposals-inside.md): read-only
    // trimmed summaries, owner phones only, with one shared bucket of their own (they read peers).
    { method: 'GET', re: /^\/mobile\/proposals$/, statuses: active, body: 'none', ownerOnly: true, ownBucket: 20, bucket: 'proposals-inside-reads' },
    { method: 'GET', re: /^\/mobile\/inside$/, statuses: active, body: 'none', ownerOnly: true, ownBucket: 20, bucket: 'proposals-inside-reads' },
    // Native Permission slips and What I'm allowed to do (docs/specs/mobile-native-permissions.md): two
    // read-only trimmed lists, and the owner phone's Face ID-confirmed writes (each route re-checks the
    // feature switch, local TLS, an active owner phone, a configured PIN, the presence key, a single-use
    // challenge bound to the exact action, and the presence signature). Ids are lower-case in practice
    // (request ids `authreq-…`, feature ids kebab-case); the router reads them with their case kept.
    { method: 'GET', re: /^\/mobile\/permissions\/slips$/, statuses: active, body: 'none', ownerOnly: true, ownBucket: 20, bucket: 'permissions-reads' },
    { method: 'GET', re: /^\/mobile\/permissions\/features$/, statuses: active, body: 'none', ownerOnly: true, ownBucket: 20, bucket: 'permissions-reads' },
    { method: 'POST', re: /^\/mobile\/permissions\/challenge$/, statuses: active, body: 'json', ownerOnly: true, ownBucket: 12, bucket: 'permission-actions' },
    // Remote Desktop with Face ID and the PIN page (mobile-owner-presence-pin §2.1–2.4): owner phone only,
    // their own bucket so retries can't use up the approvals' allowance.
    { method: 'POST', re: /^\/mobile\/desktop-unlock\/challenge$/, statuses: active, body: 'json', ownerOnly: true, ownBucket: 12, bucket: 'owner-presence' },
    { method: 'POST', re: /^\/mobile\/desktop-unlock$/, statuses: active, body: 'json', ownerOnly: true, ownBucket: 12, bucket: 'owner-presence' },
    { method: 'POST', re: /^\/mobile\/dashboard-pin\/challenge$/, statuses: active, body: 'json', ownerOnly: true, ownBucket: 12, bucket: 'owner-presence' },
    { method: 'POST', re: /^\/mobile\/dashboard-pin\/reveal$/, statuses: active, body: 'json', ownerOnly: true, ownBucket: 12, bucket: 'owner-presence' },
    // The desktop calls the app makes after a Face ID unlock (§2.2): signed by the owner phone instead of the
    // API token, and still refused by each route without a desktop session. Reads that ask the other machines
    // share 20/min, the two writes 12/min, and the viewer's polls 240/min.
    { method: 'GET', re: /^\/desktop\/targets$/, statuses: active, body: 'none', ownerOnly: true, ownBucket: 20, bucket: 'owner-desktop-peers' },
    { method: 'GET', re: /^\/desktop\/setup$/, statuses: active, body: 'none', ownerOnly: true, ownBucket: 20, bucket: 'owner-desktop-peers' },
    { method: 'GET', re: /^\/desktop\/setup\/[^/]{1,200}$/, statuses: active, body: 'none', ownerOnly: true, ownBucket: 240, bucket: 'owner-desktop' },
    { method: 'POST', re: /^\/desktop\/setup\/[^/]{1,200}$/, statuses: active, body: 'json', ownerOnly: true, ownBucket: 12, bucket: 'owner-desktop-writes' },
    { method: 'POST', re: /^\/desktop\/requests$/, statuses: active, body: 'json', ownerOnly: true, ownBucket: 12, bucket: 'owner-desktop-writes' },
    { method: 'GET', re: /^\/desktop\/requests\/[^/]{1,200}$/, statuses: active, body: 'none', ownerOnly: true, ownBucket: 240, bucket: 'owner-desktop' },
    { method: 'GET', re: /^\/desktop\/requests\/[^/]{1,200}\/(cursor|displays)$/, statuses: active, body: 'none', ownerOnly: true, ownBucket: 240, bucket: 'owner-desktop' },
    { method: 'POST', re: /^\/desktop\/requests\/[^/]{1,200}\/(ticket|resume|revoke)$/, statuses: active, body: 'json', ownerOnly: true, ownBucket: 240, bucket: 'owner-desktop' },
    { method: 'POST', re: /^\/mobile\/permissions\/requests\/[a-z0-9._:-]{1,128}\/(approve|decline)$/, statuses: active, body: 'json', ownerOnly: true, ownBucket: 12, bucket: 'permission-actions' },
    { method: 'POST', re: /^\/mobile\/permissions\/features\/[a-z0-9._:-]{1,128}$/, statuses: active, body: 'json', ownerOnly: true, ownBucket: 12, bucket: 'permission-actions' },
    // Ask for a password or key, and cancel a request (docs/specs/mobile-native-secrets-writes.md): the same
    // Face ID-confirmed path and bucket. Neither answers a token or a Secret Drop link.
    { method: 'POST', re: /^\/mobile\/secrets\/requests$/, statuses: active, body: 'json', ownerOnly: true, ownBucket: 12, bucket: 'permission-actions' },
    { method: 'POST', re: /^\/mobile\/secrets\/requests\/[0-9a-f]{16}\/cancel$/, statuses: active, body: 'json', ownerOnly: true, ownBucket: 12, bucket: 'permission-actions' },
    // The session screen's controls (docs/specs/mobile-native-session-controls.md). Owner phones only.
    // Conversation use, signed: the keys tray and attaching a file (each re-resolves the session).
    { method: 'POST', re: /^\/sessions\/[a-z0-9_-]{1,200}\/key$/, statuses: active, body: 'json', ownerOnly: true, ownBucket: 60, bucket: 'session-keys' },
    { method: 'POST', re: /^\/sessions\/[a-z0-9_-]{1,200}\/attachments$/, statuses: active, body: 'json', ownerOnly: true, ownBucket: 12, bucket: 'session-attachments' },
    // Trimmed reads: what the menu shows, what a new session can pick, and the conversation record with secrets removed.
    { method: 'GET', re: /^\/mobile\/sessions\/controls$/, statuses: active, body: 'none', ownerOnly: true, ownBucket: 30, bucket: 'session-controls-reads' },
    { method: 'GET', re: /^\/mobile\/sessions\/new-options$/, statuses: active, body: 'none', ownerOnly: true, ownBucket: 30, bucket: 'session-controls-reads' },
    { method: 'GET', re: /^\/mobile\/sessions\/history$/, statuses: active, body: 'none', ownerOnly: true, ownBucket: 60, bucket: 'session-history-reads' },
    // What ends, moves or starts a session: the Face ID-confirmed path and bucket above.
    // Any conversation (session-swap-any-conversation §3.5): the path is lower-cased here, so a Slack
    // reference's uppercase ids match [a-z0-9]; the route re-checks the reference with its real case.
    { method: 'POST', re: /^\/mobile\/sessions\/door\/(?:(?:telegram:)?[1-9][0-9]{0,15}|app:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|slack:[a-z0-9._:-]{1,190})$/, statuses: active, body: 'json', ownerOnly: true, ownBucket: 12, bucket: 'permission-actions' },
    { method: 'POST', re: /^\/mobile\/sessions\/move\/(?:[1-9][0-9]{0,15}|app:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/, statuses: active, body: 'json', ownerOnly: true, ownBucket: 12, bucket: 'permission-actions' },
    { method: 'POST', re: /^\/mobile\/sessions\/bring-back\/app:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, statuses: active, body: 'json', ownerOnly: true, ownBucket: 12, bucket: 'permission-actions' },
    { method: 'POST', re: /^\/mobile\/sessions\/close\/[a-z0-9._:-]{1,128}$/, statuses: active, body: 'json', ownerOnly: true, ownBucket: 12, bucket: 'permission-actions' },
    { method: 'POST', re: /^\/mobile\/sessions\/new$/, statuses: active, body: 'json', ownerOnly: true, ownBucket: 12, bucket: 'permission-actions' },
    { method: 'POST', re: /^\/mobile\/sessions\/default$/, statuses: active, body: 'json', ownerOnly: true, ownBucket: 12, bucket: 'permission-actions' },
    // Start a fresh account sign-in with Face ID instead of the PIN (docs/specs/account-sign-in-face-id.md):
    // the same Face ID-confirmed path, in its own account-actions bucket (sign-ins are slow and separate from
    // the permission switches, and adding accounts joins it). Owner phones only; never named for a team phone.
    // E2E-PAIRING: EXEMPT — rate-bucket name only; the route is covered by the account-sign-in-face-id e2e test
    { method: 'POST', re: /^\/mobile\/accounts\/sign-in\/start$/, statuses: active, body: 'json', ownerOnly: true, ownBucket: 12, bucket: 'account-actions' },
    // Add a Claude or Codex account with Face ID (docs/specs/account-add-face-id.md): same path, the account-actions bucket, owner only.
    { method: 'POST', re: /^\/mobile\/accounts\/add$/, statuses: active, body: 'json', ownerOnly: true, ownBucket: 12, bucket: 'account-actions' },
  ];
  const mapped = rules.map((rule) => {
    const named = TEAM_ROUTE_TIERS.find(([method, re]) => method === rule.method && re.source === rule.re.source);
    const browser = BROWSER_ROUTES.some(([method, source]) => method === rule.method && source === rule.re.source);
    // Closed by default (§3.7): a route opens to a team phone only by being named.
    return { ...rule, tier: rule.ownerOnly ? 'owner' : named ? named[2] : 'owner', ...(browser ? { browser: true as const } : {}) } as DeviceRule;
  });
  // Every named browser route must match a rule exactly: a typo would silently close it.
  for (const [method, source] of BROWSER_ROUTES) {
    if (!mapped.some((r) => r.method === method && r.re.source === source)) throw new Error(`BROWSER_ROUTES names no device rule: ${method} ${source}`);
  }
  return mapped;
})();

/**
 * The device check for authMiddleware: returns 'none' when the request carries no device
 * headers (bearer rules apply), 'ok' after setting req.instarPrincipal, or 'refused' after
 * answering the request.
 */
/** The only paths the notification read token opens (lower-cased, no trailing slash). */
const NOTIFY_TOKEN_PATHS: ReadonlyArray<RegExp> = [
  /^\/mobile\/attention\/[^/]+$/,
  new RegExp(`^/mobile/chat/app/${APP_CONVERSATION_KEY_PATTERN}/preview/[a-z0-9._:-]{1,128}$`),
];

export function deviceAuthenticator(svc: MobilePairingService) {
  return (req: Request, res: Response): 'none' | 'ok' | 'refused' => {
    const id = req.headers['x-instar-device'];
    if (id === undefined) return 'none';
    if (!svc.enabled()) return 'none'; // gate off: device headers authenticate nothing
    // Every 401 names the answering machine (dashboard-conversations-browser-device §4.6), so a
    // browser can tell "refused here" from "set up elsewhere".
    const refuse = (status: number, error: string): 'refused' => {
      const detail = REFUSAL_DETAIL[error];
      res.status(status).json({ error, ...(detail ? { detail } : {}), ...(status === 401 ? { machineId: svc.deps.selfMachineId ?? null } : {}) });
      return 'refused';
    };
    const pathNorm = req.path.toLowerCase().replace(/\/+$/, '') || '/';
    // Notification read token (mobile-push §2.2): exactly GET /mobile/attention/<id> or a reply
    // preview (chat-media §4.11), no signature.
    const notifyToken = req.headers['x-instar-notify-token'];
    if (notifyToken !== undefined) {
      if (req.method !== 'GET' || !NOTIFY_TOKEN_PATHS.some((re) => re.test(pathNorm)) || req.headers['x-instar-device-sig'] !== undefined || typeof notifyToken !== 'string' || typeof id !== 'string') return refuse(403, 'notify-token-not-allowed');
      const d = svc.devices.get(id);
      // A browser has no notification token: the branch refuses it (dashboard-conversations-browser-device §4.4).
      if (d && isBrowserDevice(d)) return refuse(403, 'notify-token-not-allowed');
      const h = crypto.createHash('sha256').update(notifyToken).digest();
      const stored = d?.notifyTokenHash ? Buffer.from(d.notifyTokenHash, 'hex') : null;
      if (!d || d.status !== 'active' || !stored || stored.length !== h.length || !crypto.timingSafeEqual(stored, h)) return refuse(401, 'device-unauthorized');
      if (!svc.deviceRateOk(d.id)) return refuse(429, 'too-many-requests');
      const np = svc.personOfDevice(d);
      if (!np.ok) return refuse(403, 'person-unknown');
      if (np.role === 'team') {
        // The token opens a push's text, so it answers to the same limits as a signed request.
        const stop = svc.teamRefusal();
        if (stop) return refuse(403, stop);
        const target = teamConversationTarget('GET', pathNorm);
        if (!target || !svc.mayUse(np, target.ref, target.op)) return refuse(404, 'unknown-conversation');
      }
      (req as unknown as { instarPrincipal: Principal }).instarPrincipal = { kind: 'device-notify', deviceId: d.id };
      (req as unknown as { instarDevicePerson: ResolvedPerson }).instarDevicePerson = np;
      return 'ok';
    }
    const rule = DEVICE_ALLOWLIST.find((r) => r.method === req.method && r.re.test(pathNorm));
    if (!rule) return refuse(403, 'device-not-allowed');
    const raw = (req as unknown as { rawBody?: Buffer }).rawBody;
    const contentLength = Number(req.headers['content-length'] ?? 0);
    if ((contentLength > 0 || req.headers['transfer-encoding'] !== undefined) && !raw) return refuse(415, 'device requests must send JSON');
    // Each rule names its body type; a body of another type is refused before the signature check.
    const octet = /^application\/octet-stream\b/i.test(String(req.headers['content-type'] ?? ''));
    if (rule.body === 'octet' ? !(octet && raw) : octet) return refuse(415, rule.body === 'octet' ? 'this route takes application/octet-stream' : 'device requests must send JSON');
    if (rule.body === 'none' && contentLength > 0) return refuse(415, 'this route takes no body');
    // Multi-route (spec 4.2): the signature names the Host it was sent to. That Host counts only
    // if it is a listed own name still named by local configuration AND this request itself
    // arrived through this machine's own local TLS front. Flag off: the stored paired host.
    let host: string | undefined;
    // Browser devices (dashboard-conversations-browser-device §4.4–4.5): refused while the switch is
    // off; a loopback-bound browser is checked against its exact stored loopback host, from a
    // loopback peer with no forwarding header, in both multi-route modes.
    const peek = typeof id === 'string' ? svc.devices.get(id) : null;
    const browserDevice = !!peek && isBrowserDevice(peek);
    if (browserDevice && !svc.browserOn()) return refuse(403, 'browser-devices-off');
    if (browserDevice && isLoopbackHost(peek!.host)) {
      if (!loopbackBindingOk(peek!, req)) { svc.browser.noteRefusal(peek!.id, 'host-refused'); return refuse(401, 'device-unauthorized'); }
      host = peek!.host;
    } else if (svc.ownNames) {
      const h = normalizeRequestHost(req.headers.host);
      if (!h || !svc.ownNames.accepts(h) || !arrivedOverLocalTls(req.secure, req.socket.remoteAddress, req.headers['x-forwarded-proto'])) {
        // The bar is about OWN names: a name that is not ours is someone knocking, not a refusal of a real route.
        const ownName = !!h && svc.ownNames.accepts(h);
        featureEvidence.recordAtMostEvery('mobilePairing.multiRoute', `host-refused|${ownName}`, 60_000, { kind: ownName ? 'error' : 'held', reason: ownName ? 'refused on an own name: not over local TLS' : 'refused: host is not an own name', context: { ownName, routeKind: ownName ? svc.ownNames.listed().find((n) => n.host === h)?.kind ?? 'unknown' : null } });
        if (browserDevice) svc.browser.noteRefusal(peek!.id, 'host-refused');
        return refuse(401, 'device-unauthorized');
      }
      host = h;
    }
    // Immutable evidence from the key lookup used by THIS signature verification, not a later
    // registry snapshot. Async private reads compare current authority to this admission.
    let admittedIdentity: MobileDeviceAdmissionIdentity | null = null;
    const v = verifyDeviceRequest(
      { deviceId: id, time: req.headers['x-instar-device-time'], sig: req.headers['x-instar-device-sig'], method: req.method, pathWithQuery: req.originalUrl, rawBody: raw, host },
      (deviceId) => {
        const d = svc.devices.get(deviceId);
        // A browser's key is `browserPublicKey` (dashboard-conversations-browser-device §4.1 reader table).
        const key = deviceKeyOf(d);
        if (!d || !key || !d.host || d.status === 'legacy-token') return null;
        // A revocation row in the device-key ledger takes effect at once, even when the registry
        // write after it failed (mobile-native-conversations §4.6: the ledger row is the recorded
        // intent). In-memory index, no file read per request.
        const ledgerRevoked = !!svc.keyLedger && svc.keyLedger.isRevoked(deviceKeyHashOf(key), d.id);
        admittedIdentity = Object.freeze({ keyHash: deviceKeyHashOf(key),
          userId: d.userId ?? null, role: d.role ?? 'owner' });
        return { publicKey: key, host: d.host, status: ledgerRevoked ? 'revoked' : d.status as DeviceStatus };
      },
      rule.statuses, svc.replay, Date.now(), rule.sendRoute === true,
    );
    if (!v.ok && host) {
      featureEvidence.recordAtMostEvery('mobilePairing.multiRoute', `signature-refused|${v.reason}|${host}`, 60_000, { kind: v.reason === 'rate-limited' ? 'held' : 'error', reason: `signature refused on an own name: ${v.reason}`, context: { signatureReason: v.reason, host, routeKind: svc.ownNames?.listed().find((n) => n.host === host)?.kind ?? 'unknown' } });
    }
    if (!v.ok && browserDevice && (v.reason === 'stale' || v.reason === 'replay' || v.reason === 'rate-limited')) {
      svc.browser.noteRefusal(peek!.id, v.reason === 'stale' ? 'stale-time' : v.reason);
    }
    if (!v.ok) return refuse(v.reason === 'rate-limited' ? 429 : 401, v.reason === 'rate-limited' ? 'too-many-requests' : 'device-unauthorized');
    // A browser may call only the routes named for it (§4.4); checked after the signature, before the person check.
    if (browserDevice && !rule.browser) return refuse(403, 'browser-device-not-allowed');
    if (rule.ownBucket !== undefined) {
      if (!svc.deviceBucketOk(v.deviceId, rule.ownBucket, rule.bucket)) { if (browserDevice) svc.browser.noteRefusal(v.deviceId, 'rate-limited'); return refuse(429, 'too-many-requests'); }
    } else if (!(rule.sendRoute && svc.nativeOn) && !svc.deviceRateOk(v.deviceId)) { if (browserDevice) svc.browser.noteRefusal(v.deviceId, 'rate-limited'); return refuse(429, 'too-many-requests'); }
    // People and roles (spec §3.4): the phone's person, resolved once per request. A phone whose
    // person is no longer in the registry is refused everywhere except its own status, confirm and
    // self-revoke — never downgraded to the owner.
    const rec = svc.devices.get(v.deviceId);
    const person = rec ? svc.personOfDevice(rec) : null;
    if (!person || !person.ok) {
      if (!rule.unassignedOk) return refuse(403, 'person-unknown');
    } else {
      if (rule.ownerOnly && person.role !== 'owner') {
        if (pathNorm.startsWith('/mobile/conversation-graph/')) {
          res.status(403).json({ code: 'hierarchy-owner-only' }); return 'refused';
        }
        return refuse(403, 'owner-phone-required');
      }
      if (person.role === 'team') {
        if (!person.tier || !tierAtLeast(person.tier, rule.tier ?? 'owner')) return refuse(403, 'tier-required');
        const stop = svc.teamRefusal();
        if (stop && !rule.unassignedOk) return refuse(403, stop);
        const target = teamConversationTarget(req.method, pathNorm);
        if (target && !svc.mayUse(person, target.ref, target.op)) return refuse(404, 'unknown-conversation');
      }
      if (!isOwnerPerson(person)) {
        const target = teamConversationTarget(req.method, pathNorm);
        if (target?.op === 'send' && svc.sendReachesOwner(person, target.ref)) return refuse(403, 'read-only-owner-reach');
      }
      (req as unknown as { instarDevicePerson: ResolvedPerson }).instarDevicePerson = person;
    }
    (req as unknown as { instarPrincipal: Principal }).instarPrincipal = { kind: 'device', deviceId: v.deviceId };
    (req as unknown as { instarDeviceAdmissionIdentity: MobileDeviceAdmissionIdentity | null }).instarDeviceAdmissionIdentity = admittedIdentity;
    if (rec && isBrowserDevice(rec)) {
      // The wording a send uses (💻, "from the dashboard") follows the signing device's kind (§4.7).
      (req as unknown as { instarDeviceClient: 'browser' }).instarDeviceClient = 'browser';
      // "Last used on this machine", at most once a minute; never refuses or delays the request.
      try { svc.devices.touch(rec.id); } catch (err) {
        featureEvidence.recordAtMostEvery('mobilePairing.browser', 'touch-failed', 60 * 60_000, { kind: 'error', reason: `lastSeenAt write failed: ${err instanceof Error ? err.message : String(err)}` });
      }
    }
    // The moment the device signature was accepted: the signed records' `receivedAt` (§4.6).
    (req as unknown as { instarDeviceAdmittedAt: number }).instarDeviceAdmittedAt = Date.now();
    // The Host the signature was checked against (multi-route: one of this machine's own names;
    // otherwise the paired host). Signed records store THIS host, never the paired one.
    (req as unknown as { instarDeviceHost: string }).instarDeviceHost = host ?? svc.devices.get(v.deviceId)?.host ?? '';
    if (host) {
      // Per request by nature: one row a device and route an hour, carrying how many it stands for.
      featureEvidence.recordAtMostEvery('mobilePairing.multiRoute', `accepted|${v.deviceId}|${host}`, 60 * 60 * 1000, { kind: 'fired', reason: 'signature accepted on an own name', context: { deviceId: v.deviceId, host, routeKind: svc.ownNames?.listed().find((n) => n.host === host)?.kind ?? 'unknown', pairedHost: rec?.host === host } });
    }
    return 'ok';
  };
}

export interface MobileDeviceAdmissionIdentity {
  readonly keyHash: string;
  readonly userId: string | null;
  readonly role: 'owner' | 'msp' | 'team';
}

/** Identity actually used by deviceAuthenticator; never accepted from an HTTP header/body. */
export function deviceAdmissionIdentity(req: Request): MobileDeviceAdmissionIdentity | null {
  return (req as unknown as { instarDeviceAdmissionIdentity?: MobileDeviceAdmissionIdentity }).instarDeviceAdmissionIdentity ?? null;
}

/** The person of the phone that signed this request (people and roles §3.4), or null. */
export function devicePersonOf(req: Request): ResolvedPerson | null {
  const p = (req as unknown as { instarDevicePerson?: ResolvedPerson }).instarDevicePerson;
  return p && p.ok ? p : null;
}

/**
 * mobile-unread-messages §3.5 `personOfReaderKey`: a forwarded reader key to a person through THIS
 * machine's records. `owner` → the owner; `team:<k>` → the team log; `msp:<machineId>:<userId>` →
 * only when the machine is this one (a same-named user elsewhere is never taken for the same person).
 */
export function personOfReaderKey(svc: MobilePairingService, key: string): ResolvedPerson | null {
  const r = parseReaderKey(key);
  if (!r) return null;
  let p: DevicePerson;
  if (r.role === 'owner') p = devicePerson({ role: 'owner' }, null, svc.ownerIdentity());
  else if (r.role === 'msp') {
    if (r.machineId !== svc.machineId()) return null;
    p = devicePerson({ userId: r.userId, role: 'msp' }, svc.people(), svc.ownerIdentity(), (id) => svc.grants.get(id));
  } else p = devicePerson({ userId: r.personKey, role: 'team' }, null, svc.ownerIdentity(), undefined, (k) => svc.teamStanding(k));
  return p.ok ? p : null;
}

/**
 * mobile-unread-messages §3.2: positive evidence, stored on THIS machine, that a reader is gone — an
 * MSP user missing from a readable registry on its own machine, or a team person missing from a
 * healthy, switched-on team log. An absent or unreadable log, or a key from another machine, is
 * "not known here yet" and never removal.
 */
export function readerRemovedHere(svc: MobilePairingService, key: string): boolean {
  const r = parseReaderKey(key);
  if (!r || r.role === 'owner') return false;
  if (r.role === 'msp') {
    if (r.machineId !== svc.machineId()) return false;
    const people = svc.people();
    return !!people && people.getUser(r.userId) === null;
  }
  const log = svc.teamLog();
  if (!log || log.healthState() !== 'ok' || !log.state().on) return false;
  return !log.state().people.has(r.personKey);
}

/**
 * The shared conversation check for a device-signed (or notify-token) request: a bearer request
 * (no device person) may use everything, as before. Spec §3.4.
 */
/** A stored message, as much of it as the reading rule needs. */
export interface StampedRow { accessStamp?: AccessStamp; senderPerson?: ConversationOwner }

export function deviceMayUse(svc: MobilePairingService, req: Request, ref: string, op: ConversationOp = 'read'): boolean {
  if (principalOf(req).kind === 'token') return true;
  const p = devicePersonOf(req);
  return p !== null && svc.mayUse(p, ref, op);
}

/** A phone's view of attention items: the owner and the bearer see all; others follow §3.7 while team access is on. */
export function filterAttentionForPhone<T extends object>(svc: MobilePairingService | null | undefined, req: Request, items: T[]): T[] {
  const p = devicePersonOf(req);
  if (!svc || !p || isOwnerPerson(p) || !svc.teamOn()) return items;
  return items.flatMap((item) => {
    const shown = attentionForNonOwner(item as { category?: unknown }, (topicId) => svc.mayUse(p, `telegram:${topicId}`, 'read'));
    return shown ? [shown as T] : [];
  });
}

/** While team access is on, a session a phone may not read shows as "Private session". */
export function maskSessionsForPhone<T extends Record<string, unknown>>(svc: MobilePairingService | null | undefined, req: Request, rows: T[]): T[] {
  const p = devicePersonOf(req);
  if (!svc || !p || isOwnerPerson(p) || !svc.teamOn()) return rows;
  return rows.map((row) => {
    const topic = row.telegramTopicId;
    const place = (row.memoryPlaceInput as { memoryPlaceKey?: unknown } | undefined)?.memoryPlaceKey;
    const ref = typeof topic === 'number' ? `telegram:${topic}` : typeof place === 'string' ? place.replace(/^app:/, '') : null;
    if (ref && svc.mayUse(p, ref, 'read')) return row;
    return { id: row.id, status: row.status, name: 'Private session' } as unknown as T;
  });
}

/** Keep only the Telegram topics a team phone may read. Every other caller sees them all. */
export function filterTopicsForTeam<T>(svc: MobilePairingService | null | undefined, req: Request, rows: T[], idOf: (row: T) => unknown): T[] {
  const p = devicePersonOf(req);
  if (!svc || !p || p.role !== 'team') return rows;
  return rows.filter((row) => svc.mayUse(p, `telegram:${String(idOf(row))}`, 'read'));
}

/** Is this request from an MSP phone? (bearer and owner phones: false) */
export function isMspRequest(req: Request): boolean {
  if (principalOf(req).kind === 'token') return false;
  const p = devicePersonOf(req);
  return p === null || p.role !== 'owner';
}

/** The Host this request's device signature was verified against, or null. */
export function deviceAdmittedHost(req: Request): string | null {
  const h = (req as unknown as { instarDeviceHost?: unknown }).instarDeviceHost;
  return typeof h === 'string' && h.length > 0 ? h : null;
}

/** When the device authenticator accepted this request's signature (ms), or null. */
export function deviceAdmittedAt(req: Request): number | null {
  const t = (req as unknown as { instarDeviceAdmittedAt?: unknown }).instarDeviceAdmittedAt;
  return typeof t === 'number' && Number.isFinite(t) ? t : null;
}

/** Private-view links carry a token-derived signature; a device never receives one. */
export function stripViewSignatures<T>(value: T): T {
  return JSON.parse(JSON.stringify(value).replace(/([?&]sig=)[0-9a-fA-F]{16,}/g, '$1removed')) as T;
}
