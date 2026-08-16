/**
 * notificationEnvelope.ts — the outbound provenance envelope + the stamper wiring
 * (Quiet by Default, docs/specs/notification-selectivity.md §2.1).
 *
 * The envelope is stamped at ORIGINATION chokepoints — never caller-supplied free
 * text. Emitter modules get stamping capability through narrow TYPED factories
 * exported ONLY from this wiring module (the capability-object pattern): the funnel
 * lint forbids importing `mintEnvelope` anywhere else, so a stamp handle cannot
 * drift into general circulation. No reflection-based runtime module-identity check
 * is claimed (JavaScript offers none for free) — callsite→category fit is the
 * lint's + PR review's jurisdiction, re-checked by the gate against the registry's
 * `emitterModules` at runtime (mismatch → recorded + audited, §9).
 */

import { resolveCategory, type SignificantClass } from './notificationCategories.js';

export type EnvelopeOrigin = 'verified-reply' | 'automated';

export interface OutboundEnvelope {
  origin: EnvelopeOrigin;
  /** Registry id; absent/unknown → 'uncategorized'. */
  category: string;
  /** Honored only per the §5 code table (mislabels are ignored + audited). */
  significantClass?: SignificantClass;
  /** Conversation-serving corroboration — the SPECIFIC inbound this send serves (§3.2). */
  inboundMessageId?: string;
  /** For dedup/audit; mirrors attention items' sourceContext. */
  sourceContext: string;
  /** True when the envelope crossed the mesh (§2.4) — stamped by the HOLDER, never the sender. */
  relayedOrigin?: boolean;
  /** The module the stamper was minted for (wiring-time, not caller-supplied at stamp time). */
  emitterModule?: string;
}

/**
 * §2 — the internal PRE-DECIDED envelope: an unforgeable in-process object
 * (module-private constructor key, not a string field, so no caller can spoof it
 * as a category). Minted ONLY by NotificationSelectivityGate for verdicts it has
 * already rendered (significant pushes, §6 failure notices, overflow summaries,
 * attention-hub sends). SINGLE-USE: consumed on delivery — a captured instance
 * cannot be replayed to skip §5.2 budget re-evaluation. It NEVER crosses the mesh
 * (the relay serializes only the plain envelope; a relayed send is classified
 * fresh by the holder, §2.4).
 */
const PRE_DECIDED_KEY = Symbol('notification-selectivity-pre-decided');

export class PreDecidedEnvelope {
  readonly category: string;
  readonly significantClass?: SignificantClass;
  readonly sourceContext: string;
  readonly reason: string;
  private used = false;

  constructor(
    key: symbol,
    fields: { category: string; significantClass?: SignificantClass; sourceContext: string; reason: string },
  ) {
    if (key !== PRE_DECIDED_KEY) {
      throw new Error('PreDecidedEnvelope is mint-only (NotificationSelectivityGate)');
    }
    this.category = fields.category;
    this.significantClass = fields.significantClass;
    this.sourceContext = fields.sourceContext;
    this.reason = fields.reason;
  }

  /** Consume for delivery. Returns false when already used (replay → classify fresh). */
  consume(): boolean {
    if (this.used) return false;
    this.used = true;
    return true;
  }
}

/**
 * Gate-internal mint hook. NOT part of the stamper surface; the funnel lint forbids
 * importing this outside this module and the gate module.
 */
export function mintPreDecided(fields: {
  category: string;
  significantClass?: SignificantClass;
  sourceContext: string;
  reason: string;
}): PreDecidedEnvelope {
  return new PreDecidedEnvelope(PRE_DECIDED_KEY, fields);
}

export interface CategoryStamper {
  /** The module this stamper was minted for. */
  readonly module: string;
  stamp(
    category: string,
    fields?: {
      significantClass?: SignificantClass;
      inboundMessageId?: string;
      sourceContext?: string;
    },
  ): OutboundEnvelope;
  /** Convenience for reply-route minting only (origin computed by the route, §2.2). */
  stampOrigin(
    origin: EnvelopeOrigin,
    category: string,
    fields?: {
      significantClass?: SignificantClass;
      inboundMessageId?: string;
      sourceContext?: string;
      relayedOrigin?: boolean;
    },
  ): OutboundEnvelope;
}

/**
 * Generic envelope constructor — INTERNAL to this wiring module (lint-enforced).
 * Emitters never call this; they hold a `CategoryStamper` minted for their module.
 */
function mintEnvelope(
  module: string,
  origin: EnvelopeOrigin,
  category: string,
  fields?: {
    significantClass?: SignificantClass;
    inboundMessageId?: string;
    sourceContext?: string;
    relayedOrigin?: boolean;
  },
): OutboundEnvelope {
  const resolved = resolveCategory(category);
  return {
    origin,
    category: resolved.id === category ? category : resolved.id,
    ...(fields?.significantClass ? { significantClass: fields.significantClass } : {}),
    ...(fields?.inboundMessageId ? { inboundMessageId: fields.inboundMessageId } : {}),
    sourceContext: fields?.sourceContext ?? module,
    ...(fields?.relayedOrigin ? { relayedOrigin: true } : {}),
    emitterModule: module,
  };
}

/**
 * Mint a stamper bound to one emitter module. Stamps outside the module's
 * registry-declared categories still produce an envelope — the GATE records +
 * audits the mismatch (§9); it never throws on the send path.
 */
export function mintStamper(module: string): CategoryStamper {
  return {
    module,
    stamp: (category, fields) => mintEnvelope(module, 'automated', category, fields),
    stampOrigin: (origin, category, fields) => mintEnvelope(module, origin, category, fields),
  };
}

/* ── The named per-module stampers (the only sanctioned handles) ──────────────
 * One per emitter family in the v1 registry. A new emitter adds its stamper HERE
 * plus its module to the category's `emitterModules` — both are PR-reviewed and
 * lint-checked (callsite→category fit).
 */
export const telegramAdapterStamper = mintStamper('TelegramAdapter');
export const jobSchedulerStamper = mintStamper('JobScheduler');
export const sentinelConsolidatedStamper = mintStamper('sentinelConsolidatedSend');
export const sentinelNotifierStamper = mintStamper('SentinelNotifier');
export const reapNoticeStamper = mintStamper('ReapNoticeDrain');
export const resumeQueueStamper = mintStamper('ResumeQueue');
export const promiseBeaconStamper = mintStamper('PromiseBeacon');
export const commitmentTrackerStamper = mintStamper('CommitmentTracker');
export const spendAlertStamper = mintStamper('SpendAlertResolver');
export const spendTopicChannelStamper = mintStamper('TelegramSpendTopicChannel');
export const burnDetectorStamper = mintStamper('BurnDetector');
export const ropeHealthStamper = mintStamper('RopeHealthMonitor');
export const machineCoherenceStamper = mintStamper('MachineCoherenceGuard');
export const serverStamper = mintStamper('server');
export const tunnelManagerStamper = mintStamper('TunnelManager');
export const advisoryAuditStamper = mintStamper('OutboundAdvisoryAudit');
export const autonomousHeartbeatStamper = mintStamper('AutonomousProgressHeartbeat');
export const autoUpdaterStamper = mintStamper('AutoUpdater');
export const upgradeNotifyStamper = mintStamper('UpgradeNotifyManager');
export const selectivityDigestStamper = mintStamper('SelectivityDigest');
export const presenceProxyStamper = mintStamper('PresenceProxy');
export const sessionManagerStamper = mintStamper('SessionManager');
export const droppedMessagesStamper = mintStamper('droppedMessages');
export const inboundQueueStamper = mintStamper('InboundQueue');
