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
  ConfirmationCodes, DeviceRegistry, displayCode, type CodeFormat, ReplayGuard, parseDevicePublicKey, verifyDeviceRequest,
  type DeviceRecord, type DeviceStatus,
} from '../core/MobileDeviceKeys.js';
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
import { deviceKeyHashOf } from '../core/AppRecordSignatures.js';
import { buildSignedOrigin } from './mobileConversationRoutes.js';
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
  choosePerson, devicePerson, mayUseConversation, personLabel,
  type ConversationOwner, type DevicePerson, type OwnerIdentity, type PeopleLookup, type PersonProfile, type ResolvedPerson,
} from '../core/MobilePeople.js';

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
  stateDir: string;
  tunnel?: () => PairingTunnelView | undefined;
  selfMachineId?: string | null;
  siblings?: () => PairingSiblingView[];
  /** Probe our own stable origin; injectable for tests. */
  fetchFn?: typeof fetch;
  /** Send the confirmation code to the owner's private chat with a Decline button; resolves to the Telegram message id, or null. */
  ownerDM?: (text: string, declineData: string) => Promise<number | null>;
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
    role: d.role === 'msp' ? 'msp' : 'owner', personName: cleanText(d.personName),
    ...(d.unassigned === true || (d.role !== undefined && d.role !== 'owner' && d.role !== 'msp') ? { unassigned: true } : {}),
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

export class MobilePairingService {
  /** Native app conversations resolved on at boot (set by AgentServer). Gates the send-route rate move. */
  nativeOn = false;
  /**
   * The device-key ledger (mobile-native-conversations §4.6), set by AgentServer when native
   * conversations are on. Activation and revocation write their ledger row FIRST, then the
   * registry; boot reconciliation repairs a crash between the two in either direction.
   */
  keyLedger: MobileDeviceKeyLedger | null = null;
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
    // Native conversations off: exactly the old behaviour (try the Telegram DM whenever an adapter exists).
    if (!this.nativeOn) return this.deps.ownerDM ? 'telegram' : null;
    const owner = this.deps.telegramOwnerPresent ? this.deps.telegramOwnerPresent() : true;
    return this.deps.ownerDM && owner ? 'telegram' : 'dashboard';
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
  useAppConversationStore(store: { getConversation(key: string): { ownerPerson: ConversationOwner | null } | null }): void {
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
    const needsRegistry = d.role === 'msp' || !!d.userId;
    return devicePerson(d, needsRegistry ? this.people() : null, this.ownerIdentity(), (id) => this.grants.get(id));
  }

  /** May this phone's person use this conversation? (one shared check, spec §3.4) */
  mayUse(person: ResolvedPerson, ref: string): boolean {
    return mayUseConversation(person, ref, this.machineId(), this.appConversationOwner);
  }

  /** The shared check by device id (push recipients): an unknown device or person ⇒ no. */
  deviceMayUseConversation(deviceId: string, ref: string): boolean {
    const d = this.devices.get(deviceId);
    if (!d) return false;
    const p = this.personOfDevice(d);
    return p.ok && this.mayUse(p, ref);
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

  /** A rule's own per-minute bucket (media chunks), independent of the read allowance. */
  deviceBucketOk(deviceId: string, perMinute: number): boolean {
    const t = this.now();
    const arr = (this.deviceBucket.get(deviceId) ?? []).filter((x) => t - x < 60_000);
    if (arr.length >= perMinute) { this.deviceBucket.set(deviceId, arr); return false; }
    arr.push(t); this.deviceBucket.set(deviceId, arr);
    return true;
  }

  /** Inbound Telegram text: void any pending device whose live code appears in it. */
  scanInbound(text: unknown): string[] {
    if (typeof text !== 'string' || !this.enabled()) return [];
    const hits = this.confirm.leakedIn(text);
    for (const id of hits) {
      this.confirm.drop(id);
      this.dashboardCodes.delete(id);
      try { this.devices.decline(id); } catch (err) { this.deps.reportDegradation?.('MobilePairing.leakDecline', err); }
      void this.deps.ownerDM?.('A pairing code was sent in a conversation, so I cancelled that pairing. Codes only go into the Instar app. Ask me for a new link if you were pairing a phone.', '');
    }
    return hits;
  }

  /** The owner's Decline button. */
  declineByNonce(nonce: string): 'declined' | 'unknown' {
    const id = this.declineNonces.get(nonce);
    if (!id) return 'unknown';
    this.declineNonces.delete(nonce);
    this.confirm.drop(id);
    try { this.devices.decline(id); } catch (err) { // @silent-fallback-ok — reported through DegradationReporter
      // The code is already gone, so the device can never confirm; it expires on its own.
      this.deps.reportDegradation?.('MobilePairing.declineWrite', err);
    }
    return 'declined';
  }
  private now: () => number;

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
    if (svc.devices.pairingPaused()) { featureEvidence.recordAtMostEvery('mobilePairing', 'redeem|pairing-paused', 60_000, { kind: 'held', reason: 'redeem refused: pairing-paused' }); res.status(429).json({ error: 'pairing-paused' }); return; }
    // Take-and-delete happens synchronously inside redeem(), before any async work.
    const r = svc.codes.redeem(body.code, token);
    if (!r.ok) {
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
      res.status(500).json({ error: 'Could not record the device. Ask for a new link.' });
      return;
    }
    if (!created.ok) {
      const status = created.reason === 'duplicate-key' ? 409 : 429;
      featureEvidence.record('mobilePairing', { kind: 'held', reason: `redeem refused: ${created.reason}`, context: { routeKind: eligible.kind, status } });
      res.status(status).json({ error: created.reason });
      return;
    }
    const device = created.device;
    // mobile-pairing-word-code §3.2: only an app that asks for it gets a WORD-NNNN code; builds
    // already on phones send digits only, so everything else keeps today's 6-digit code.
    const codeFormat: CodeFormat = Array.isArray(body.codeFormats) && body.codeFormats.length <= 8 && body.codeFormats.includes('word') ? 'word' : 'digits';
    const code = svc.confirm.issue(device.id, Date.parse(device.expiresAt!), codeFormat);
    if (approval === 'dashboard') {
      // No DM to wait for: the code (plaintext, memory only) is shown on the dashboard's Phones
      // card to an operator session; the phone shows "confirm on your dashboard".
      svc.holdDashboardCode(device.id, code, Date.parse(device.expiresAt!));
      // dashboard-console-default-and-pair-page §3.3: the code page on the host this phone just
      // redeemed on (already checked above: local TLS, an eligible host, the code's bound host).
      featureEvidence.record('mobilePairing', { kind: 'fired', reason: 'redeemed: code held on dashboard', context: { deviceId: device.id, approval: 'dashboard', role: device.role ?? 'owner', routeKind: eligible.kind, codeFormat } });
      res.json({ deviceId: device.id, agentName: svc.deps.config.projectName, status: 'pending', approval: 'dashboard', codeFormat,
        codePageUrl: codePageUrlForDevice(reqHost!, device.id) });
      return;
    }
    const nonce = crypto.randomBytes(12).toString('hex');
    svc.declineNonces.set(nonce, device.id);
    const pretty = displayCode(code);
    // People and roles §3.2: the owner approves every phone, so the message says whose phone it is.
    const forWhom = device.role === 'msp' ? svc.personOfDevice(device) : null;
    const text = [
      forWhom
        ? `Your code to pair a phone for ${forWhom.ok ? personLabel(forWhom.name, 'msp') : 'someone no longer in your user list'} with ${svc.deps.config.projectName} is ${pretty}. Give it to them only if you want them to use the Instar app with this agent.`
        : `Your code to pair a phone with ${svc.deps.config.projectName} is ${pretty}.`,
      `Type it into the Instar app only if you are pairing a phone right now. If you did not start this, tap Decline. Don't send or show this message to anyone, including me.`,
      `Phone name: ${device.deviceName ?? '(none given)'}`,
    ].join('\n\n');
    let delivered: number | null = null;
    try {
      delivered = await Promise.race([
        svc.deps.ownerDM!(text, `md:d:${nonce}`),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 10_000)),
      ]);
    } catch { delivered = null; } // @silent-fallback-ok — treated as not delivered: the pending device is removed and the caller gets 409
    if (!delivered || !svc.deps.ownerDM) {
      svc.confirm.drop(device.id);
      svc.declineNonces.delete(nonce);
      try { svc.devices.remove(device.id); } catch (err) { svc.deps.reportDegradation?.('MobilePairing.registryWrite', err); }
      featureEvidence.record('mobilePairing', { kind: 'error', reason: 'redeem failed: confirmation code not delivered', context: { deviceId: device.id, routeKind: eligible.kind } });
      res.status(409).json({ error: 'approval-unavailable', detail: 'I could not send you the confirmation code in Telegram. Open a private chat with the bot and send it any message, then ask me for a new link.' });
      return;
    }
    featureEvidence.record('mobilePairing', { kind: 'fired', reason: 'redeemed: code sent by Telegram', context: { deviceId: device.id, approval: 'telegram', role: device.role ?? 'owner', routeKind: eligible.kind, codeFormat } });
    res.json({ deviceId: device.id, agentName: svc.deps.config.projectName, status: 'pending', approval: 'telegram', codeFormat });
  });
}

/** Bearer routes: mounted on the authenticated router. */
export function createMobilePairingRouter(svc: MobilePairingService, deps: MobilePairingDeps, poolCtx?: PoolCtx): Router {
  const router = Router();

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
    if (!approval || (approval === 'telegram' && !svc.holdsLease())) {
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
    const approvals = svc.dashboardApprovals().map(({ device, code, expiresAt }) => ({
      deviceId: device.id, deviceName: device.deviceName, label: device.label, fingerprint: device.fingerprint ?? null, ...personFields(device, svc),
      // Display form for both formats (mobile-pairing-word-code §3.4): `KITE-4172` or `123 456`.
      code: displayCode(code), codeFormat: /^\d{6}$/.test(code) ? 'digits' : 'word', pairedAt: device.pairedAt, expiresAt: new Date(expiresAt).toISOString(),
    }));
    res.json({ approval: svc.approvalPath(), approvals });
  });

  // "Not me": the operator declines a dashboard-path pairing from the same card.
  router.post('/mobile/pairing-approvals/:id/decline', (req: Request, res: Response) => {
    if (!operatorOnly(req, res)) return;
    const id = String(req.params.id);
    if (!svc.isDashboardPending(id)) { res.status(404).json({ error: 'not-pending' }); return; }
    svc.confirm.drop(id);
    svc.dropDashboardCode(id);
    try { svc.devices.decline(id); } catch (err) { // @silent-fallback-ok — the code is gone, so the device can never confirm; reported
      deps.reportDegradation?.('MobilePairing.declineWrite', err);
    }
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
      ...(d.status === 'pending' && svc.isDashboardPending(d.id) ? { approval: 'dashboard' } : {}),
      ...(d.approvedVia ? { approvedVia: d.approvedVia } : {}),
      // People and roles §3.1: whose phone this is (`unassigned` when the person was removed).
      person: personView(svc.personOfDevice(d)),
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
      res.status(500).json({ error: 'Could not record the change. Try again.' });
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
      res.status(500).json({ error: 'Could not record the assignment. Try again.' });
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
    let after: DeviceRecord | null;
    const approvedAt = new Date().toISOString();
    if (check.result === 'ok' && svc.keyLedger) {
      // Ledger row first (the durable intent), registry second; reconciliation repairs a crash between.
      try { svc.keyLedger.recordActivation(d, approvedVia, approvedAt); } catch (err) {
        deps.reportDegradation?.('MobilePairing.keyLedger', err);
        featureEvidence.record('mobilePairing', { kind: 'error', reason: 'confirm failed: key ledger write', context: { deviceId: d.id, approvedVia } });
        res.status(500).json({ error: 'Could not record the confirmation. Try again.' });
        return;
      }
    }
    try {
      after = svc.devices.applyConfirm(d.id, check.result === 'ok' ? { ok: true, approvedVia, approvedAt } : { ok: false, wrongHmac: check.hmac });
    } catch (err) {
      deps.reportDegradation?.('MobilePairing.registryWrite', err);
      featureEvidence.record('mobilePairing', { kind: 'error', reason: 'confirm failed: registry write', context: { deviceId: d.id, approvedVia } });
      res.status(500).json({ error: 'Could not record the confirmation. Try again.' });
      return;
    }
    if (check.result === 'ok') {
      svc.confirm.drop(d.id); // consumed only after the activation was written
      svc.dropDashboardCode(d.id);
      for (const [n, id] of svc.declineNonces) if (id === d.id) svc.declineNonces.delete(n);
      featureEvidence.record('mobilePairing', { kind: 'fired', reason: 'confirmed', context: { deviceId: d.id, approvedVia, role: d.role ?? 'owner' } });
      res.json({ status: 'active' });
      return;
    }
    featureEvidence.record('mobilePairing', { kind: 'held', reason: 'confirm refused: wrong code', context: { deviceId: d.id, nowDeclined: after?.status === 'declined', pairingPaused: svc.devices.pairingPaused() } });
    if (svc.devices.pairingPaused()) {
      deps.raiseAttention?.('Phone pairing paused', 'Ten wrong pairing codes were entered in the last 24 hours, so phone pairing is paused for now. If you were not pairing a phone, someone may be guessing.');
    }
    if (after?.status === 'declined') {
      svc.confirm.drop(d.id);
      svc.dropDashboardCode(d.id);
      void deps.ownerDM?.('Three wrong codes were typed for a phone pairing, so I cancelled it. If that was you, ask me for a new link. If not, someone may have your pairing link.', '');
      res.status(409).json({ error: 'declined' });
      return;
    }
    res.status(403).json({ error: 'wrong-code' });
  });

  // Revoke: bearer may revoke any device; a device only itself.
  router.post('/mobile/devices/:id/revoke', async (req: Request, res: Response) => {
    if (!svc.enabled()) { json503(res); return; }
    const id = String(req.params.id);
    const p = principalOf(req);
    if (p.kind === 'device' && p.deviceId !== id) { res.status(403).json({ error: 'a device may only revoke itself' }); return; }
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
      res.status(500).json({ error: 'Could not record the revocation. Try again.' });
      return;
    }
    if (held) { svc.confirm.drop(id); featureEvidence.record('mobilePairing', { kind: 'fired', reason: 'revoked here', context: { deviceId: id, by: p.kind, heldHere: true } }); res.json({ revoked: true, machine: deps.selfMachineId ?? null }); return; }
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
      res.status(500).json({ error: 'Could not record the registration. Try again.' });
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
      const item = poolCtx?.telegram?.getAttentionItem?.(id) ?? poolCtx?.localAttention?.get(id);
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
    const senderPerson = sender.role === 'msp' && sender.userId ? { machineId: svc.machineId(), userId: sender.userId } : null;
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
    if (body.attachments !== undefined && !mediaOn) { res.status(400).json({ error: 'media-target-unsupported', detail: 'Files can be sent in app conversations. Sending them into a Telegram topic is not available yet.' }); return; }
    let signedFiles: SignedAttachment[] | null = null;
    if (body.attachments !== undefined && !isExactStopMessage(text)) {
      const checked = checkSignedFiles(body.attachments);
      if ('status' in checked) { res.status(checked.status).json(checked.body); return; }
      signedFiles = checked.files;
    }
    if ((text.length < 1 && !signedFiles) || text.length > 4000) { res.status(400).json({ error: 'text must be 1-4000 characters' }); return; }
    if (typeof requestId !== 'string' || requestIdTime(requestId) === null) { res.status(400).json({ error: 'bad-request-id' }); return; }
    const store = chatStoreOf();
    if (!store) { res.status(503).json({ error: 'chat-unavailable', detail: 'The message record could not be read on this machine.' }); return; }
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
    const ownerId = tg?.getOwnerUserId?.();
    if (!tg || !ingest || !ownerId) { res.status(503).json({ error: 'chat-unavailable', detail: 'This agent has no Telegram owner to speak as.' }); return; }
    if (!svc.holdsLease()) { res.status(409).json({ error: 'not-serving', detail: 'This machine is not receiving messages right now. Try again shortly or use Telegram.' }); return; }
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
      res.status(503).json({ error: 'chat-unavailable', detail: 'The message could not be recorded, so it was not sent. Try again.' });
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
        res.status(503).json({ error: 'chat-unavailable', detail: 'The message could not be saved, so it was not sent. Try again.' });
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
    try {
      // The mirror is a copy for people reading the topic: credential-shaped spans always show
      // as "[credential hidden]", even when the operator sent them as written (§4.9).
      const mirrorText = svc.nativeOn ? hideCredentialSpans(delivered) : text;
      if (app && stored.length > 0) {
        await mirrorMediaToTelegram(tg as unknown as TelegramMediaMirrorTarget, topicId, senderName, stored, mirrorText, (sha) => app.media.locateBlob(sha));
      } else {
        await tg.sendToTopic(topicId, `📱 ${senderName} (from the app): ${mirrorText}`, { silent: true, skipStallClear: true, operatorMirror: true });
      }
      mirrored = true;
    } catch (err) {
      deps.reportDegradation?.('MobileChat.mirror', err);
    }
    const response = {
      ok: true, outcome, eventId, mirrored, ...(stored.length > 0 ? { mirror: mirrored ? 'sent' : 'failed', messageId: storeMessageId } : {}), ...extras,
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
function principalOf(req: Request): Principal {
  return ((req as unknown as { instarPrincipal?: Principal }).instarPrincipal) ?? { kind: 'token' };
}

/** `{ name, role }` for a resolved person; `{ role, unassigned: true }` for a removed one. */
function personView(p: DevicePerson): Record<string, unknown> {
  return p.ok ? { name: p.name, role: p.role } : { role: p.role, unassigned: true };
}

/** The person fields of a device row (people and roles §3.2). */
function personFields(d: DeviceRecord, svc: MobilePairingService): Record<string, unknown> {
  const p = svc.personOfDevice(d);
  return { role: p.role, personName: p.ok ? p.name : null, ...(p.ok ? {} : { unassigned: true }) };
}

function publicDeviceView(d: DeviceRecord, machine: string | null, svc?: MobilePairingService): Record<string, unknown> {
  const showFingerprint = d.status === 'active' || d.status === 'revoked';
  return {
    id: d.id, deviceName: d.deviceName, label: d.label, pairedAt: d.pairedAt, status: d.status, ...(svc ? personFields(d, svc) : {}),
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
export const DEVICE_ALLOWLIST: Array<{ method: string; re: RegExp; statuses: ReadonlySet<DeviceStatus>; sendRoute?: boolean; body?: 'json' | 'octet' | 'none'; ownBucket?: number; unassignedOk?: boolean; conversationRef?: boolean }> = (() => {
  const active: ReadonlySet<DeviceStatus> = new Set(['active']);
  return [
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
    { method: 'POST', re: /^\/mobile\/conversations$/, statuses: active },
    { method: 'PATCH', re: new RegExp(`^/mobile/conversations/${UUID}$`), statuses: active, conversationRef: true },
    { method: 'DELETE', re: new RegExp(`^/mobile/conversations/${UUID}$`), statuses: active, conversationRef: true },
    { method: 'POST', re: new RegExp(`^/mobile/chat/app/${UUID}$`), statuses: active, sendRoute: true, conversationRef: true },
    { method: 'GET', re: new RegExp(`^/mobile/chat/app/${UUID}/messages$`), statuses: active, conversationRef: true },
    { method: 'GET', re: new RegExp(`^/mobile/chat/app/${UUID}/events$`), statuses: active, conversationRef: true },
    // "Open session": which session drives a conversation on this machine, plus a dashboard link. Read-only.
    { method: 'GET', re: /^\/mobile\/conversations\/session$/, statuses: active, body: 'none', conversationRef: true },
    // Slack conversations from the app (§4.9): the machine-local negative durable id.
    { method: 'POST', re: /^\/mobile\/chat\/slack\/-[1-9][0-9]{0,17}$/, statuses: active, sendRoute: true, conversationRef: true },
    { method: 'GET', re: /^\/mobile\/chat\/slack\/-[1-9][0-9]{0,17}\/messages$/, statuses: active, conversationRef: true },
    // Reply notification preview (chat-media §4.11); the read token opens it too (NOTIFY_TOKEN_PATHS).
    { method: 'GET', re: new RegExp(`^/mobile/chat/app/${UUID}/preview/[a-z0-9._:-]{1,128}$`), statuses: active, conversationRef: true },
    { method: 'POST', re: /^\/mobile\/device\/push$/, statuses: active },
    // People and roles §3.5: the owner's grant switches (owner phones only, checked in the route).
    { method: 'GET', re: /^\/mobile\/people$/, statuses: active },
    { method: 'POST', re: /^\/mobile\/people\/[^/]{1,128}\/grants$/, statuses: active },
    { method: 'GET', re: /^\/mobile\/attention\/[^/]+$/, statuses: active },
    // Media in app conversations (mobile-native-chat-media §4.10).
    { method: 'POST', re: /^\/mobile\/media\/uploads$/, statuses: active, body: 'json', conversationRef: true },
    { method: 'PUT', re: new RegExp(`^/mobile/media/uploads/${UUID}/chunks/(0|[1-9][0-9]{0,5})$`), statuses: active, body: 'octet', ownBucket: 240 },
    { method: 'GET', re: new RegExp(`^/mobile/media/uploads/${UUID}$`), statuses: active, body: 'none' },
    { method: 'GET', re: /^\/mobile\/media\/[0-9a-f]{64}$/, statuses: active, body: 'none', conversationRef: true },
    { method: 'POST', re: /^\/mobile\/media\/purge$/, statuses: active, body: 'json', conversationRef: true },
    { method: 'POST', re: /^\/mobile\/devices\/[^/]+\/revoke$/, statuses: new Set(['pending', 'active', 'declined', 'expired']), unassignedOk: true },
  ];
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
    const refuse = (status: number, error: string): 'refused' => { res.status(status).json({ error }); return 'refused'; };
    const pathNorm = req.path.toLowerCase().replace(/\/+$/, '') || '/';
    // Notification read token (mobile-push §2.2): exactly GET /mobile/attention/<id> or a reply
    // preview (chat-media §4.11), no signature.
    const notifyToken = req.headers['x-instar-notify-token'];
    if (notifyToken !== undefined) {
      if (req.method !== 'GET' || !NOTIFY_TOKEN_PATHS.some((re) => re.test(pathNorm)) || req.headers['x-instar-device-sig'] !== undefined || typeof notifyToken !== 'string' || typeof id !== 'string') return refuse(403, 'notify-token-not-allowed');
      const d = svc.devices.get(id);
      const h = crypto.createHash('sha256').update(notifyToken).digest();
      const stored = d?.notifyTokenHash ? Buffer.from(d.notifyTokenHash, 'hex') : null;
      if (!d || d.status !== 'active' || !stored || stored.length !== h.length || !crypto.timingSafeEqual(stored, h)) return refuse(401, 'device-unauthorized');
      if (!svc.deviceRateOk(d.id)) return refuse(429, 'too-many-requests');
      const np = svc.personOfDevice(d);
      if (!np.ok) return refuse(403, 'person-unknown');
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
    if (svc.ownNames) {
      const h = normalizeRequestHost(req.headers.host);
      if (!h || !svc.ownNames.accepts(h) || !arrivedOverLocalTls(req.secure, req.socket.remoteAddress, req.headers['x-forwarded-proto'])) {
        // The bar is about OWN names: a name that is not ours is someone knocking, not a refusal of a real route.
        const ownName = !!h && svc.ownNames.accepts(h);
        featureEvidence.recordAtMostEvery('mobilePairing.multiRoute', `host-refused|${ownName}`, 60_000, { kind: ownName ? 'error' : 'held', reason: ownName ? 'refused on an own name: not over local TLS' : 'refused: host is not an own name', context: { ownName, routeKind: ownName ? svc.ownNames.listed().find((n) => n.host === h)?.kind ?? 'unknown' : null } });
        return refuse(401, 'device-unauthorized');
      }
      host = h;
    }
    const v = verifyDeviceRequest(
      { deviceId: id, time: req.headers['x-instar-device-time'], sig: req.headers['x-instar-device-sig'], method: req.method, pathWithQuery: req.originalUrl, rawBody: raw, host },
      (deviceId) => {
        const d = svc.devices.get(deviceId);
        if (!d || !d.publicKey || !d.host || d.status === 'legacy-token') return null;
        // A revocation row in the device-key ledger takes effect at once, even when the registry
        // write after it failed (mobile-native-conversations §4.6: the ledger row is the recorded
        // intent). In-memory index, no file read per request.
        const ledgerRevoked = !!svc.keyLedger && svc.keyLedger.isRevoked(deviceKeyHashOf(d.publicKey), d.id);
        return { publicKey: d.publicKey, host: d.host, status: ledgerRevoked ? 'revoked' : d.status as DeviceStatus };
      },
      rule.statuses, svc.replay, Date.now(), rule.sendRoute === true,
    );
    if (!v.ok && host) {
      featureEvidence.recordAtMostEvery('mobilePairing.multiRoute', `signature-refused|${v.reason}|${host}`, 60_000, { kind: v.reason === 'rate-limited' ? 'held' : 'error', reason: `signature refused on an own name: ${v.reason}`, context: { signatureReason: v.reason, host, routeKind: svc.ownNames?.listed().find((n) => n.host === host)?.kind ?? 'unknown' } });
    }
    if (!v.ok) return refuse(v.reason === 'rate-limited' ? 429 : 401, v.reason === 'rate-limited' ? 'too-many-requests' : 'device-unauthorized');
    if (rule.ownBucket !== undefined) {
      if (!svc.deviceBucketOk(v.deviceId, rule.ownBucket)) return refuse(429, 'too-many-requests');
    } else if (!(rule.sendRoute && svc.nativeOn) && !svc.deviceRateOk(v.deviceId)) return refuse(429, 'too-many-requests');
    // People and roles (spec §3.4): the phone's person, resolved once per request. A phone whose
    // person is no longer in the registry is refused everywhere except its own status, confirm and
    // self-revoke — never downgraded to the owner.
    const rec = svc.devices.get(v.deviceId);
    const person = rec ? svc.personOfDevice(rec) : null;
    if (!person || !person.ok) {
      if (!rule.unassignedOk) return refuse(403, 'person-unknown');
    } else {
      (req as unknown as { instarDevicePerson: ResolvedPerson }).instarDevicePerson = person;
    }
    (req as unknown as { instarPrincipal: Principal }).instarPrincipal = { kind: 'device', deviceId: v.deviceId };
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

/** The person of the phone that signed this request (people and roles §3.4), or null. */
export function devicePersonOf(req: Request): ResolvedPerson | null {
  const p = (req as unknown as { instarDevicePerson?: ResolvedPerson }).instarDevicePerson;
  return p && p.ok ? p : null;
}

/**
 * The shared conversation check for a device-signed (or notify-token) request: a bearer request
 * (no device person) may use everything, as before. Spec §3.4.
 */
export function deviceMayUse(svc: MobilePairingService, req: Request, ref: string): boolean {
  if (principalOf(req).kind === 'token') return true;
  const p = devicePersonOf(req);
  return p !== null && svc.mayUse(p, ref);
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
