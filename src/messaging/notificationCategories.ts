/**
 * notificationCategories.ts — the Notification Category Registry (Quiet by Default).
 *
 * Spec: docs/specs/notification-selectivity.md §1 / §5 (FD-13 binds the v1 table as
 * printed; operator approval of the spec approved this table).
 *
 * A single CODE-DEFINED registry naming every automated-message category and its
 * disposition. Config can never add, remove, or re-class a category (D-6): the only
 * config surface is the per-category push OPT-IN (`notifications.selectivity.push.
 * categories.<id>`), written solely by the §4.2 sole-writer route.
 *
 * The June-13 inversion: silence is what you get for free (an unstamped or unknown
 * send classifies `uncategorized` → quiet); push is what you must justify in a PR.
 */

/** §5 — the significant lane's closed class set (D-6: extension is a PR, never config). */
export type SignificantClass = 'security-incident' | 'data-loss' | 'agent-cannot-operate';

export const SIGNIFICANT_CLASSES: readonly SignificantClass[] = [
  'security-incident',
  'data-loss',
  'agent-cannot-operate',
];

export type CategoryDisposition = 'quiet' | 'conversation-serving';

export type CategoryDestination = 'hub' | 'conversation' | 'agent-health';

export interface NotificationCategory {
  /** Registry id, e.g. 'reap-notice'. */
  id: string;
  /** Plain English, shown on the dashboard Notifications tab. */
  description: string;
  /** DEFAULT is 'quiet' (store + logs + pull surface); 'conversation-serving' pushes into the live conversation (§3.2). */
  disposition: CategoryDisposition;
  /**
   * The source modules allowed to emit this category — enforced by the funnel lint
   * (callsite→category fit) at build time and re-checked by the gate at runtime
   * (a category stamped by a module not listed here is recorded + audited, §9).
   * `uncategorized` is DERIVED-only (no module may stamp it explicitly).
   */
  emitterModules: string[];
  /** The significant classes THIS category may raise (§5). Absent = none. */
  significantClasses?: SignificantClass[];
  /**
   * Dotted config key of an existing per-feature delivery lever this category honors
   * (§3.5). MUST default false (lint-enforced) — a default-true lever is snapshot-
   * migrated at Increment D, never OR'd.
   */
  legacyGate?: string;
  /**
   * §3.4 (update announcements): the category's push entitlement is carried by the
   * EMITTER's own audience/maturity gating (PA-5) — a stamped send of this category
   * already passed that lever, so the gate treats it as push-entitled. No second lever.
   */
  emitterGated?: boolean;
  /** Where this category's pushes land (FD-5). Declarative — never a reroute. */
  defaultDestination: CategoryDestination;
}

/** The sentinel id every unstamped/unregistered automated send classifies to (§2.3). */
export const UNCATEGORIZED = 'uncategorized';

/**
 * The v1 registry (FD-13 — 18 categories + the `uncategorized` default, dispositions
 * as printed in the approved spec).
 */
export const NOTIFICATION_CATEGORIES: readonly NotificationCategory[] = [
  {
    id: 'attention-item',
    description: 'Attention-queue items (all createAttentionItem emissions not otherwise laned).',
    disposition: 'quiet',
    emitterModules: ['TelegramAdapter'],
    significantClasses: ['security-incident', 'data-loss', 'agent-cannot-operate'],
    defaultDestination: 'hub',
  },
  {
    id: 'agent-health',
    description: 'The calm self-health lane (🩺). Opted-in pushes keep the Agent Health topic.',
    disposition: 'quiet',
    emitterModules: ['TelegramAdapter'],
    defaultDestination: 'agent-health',
  },
  {
    id: 'job-status',
    description: 'JobScheduler summaries, failure alerts and job lifecycle notices.',
    disposition: 'quiet',
    emitterModules: ['JobScheduler'],
    defaultDestination: 'hub',
  },
  {
    id: 'sentinel-escalation',
    description: 'Consolidated sentinel escalations (silently-stopped trio and friends).',
    disposition: 'quiet',
    emitterModules: ['sentinelConsolidatedSend', 'SentinelNotifier'],
    legacyGate: 'monitoring.sentinelTelegramEscalation',
    defaultDestination: 'hub',
  },
  {
    id: 'reap-notice',
    description:
      'Per-topic session-shutdown notices. The monitoring.reapNotify.enabled lever defaults TRUE, so it is NOT a legacyGate — it is snapshot-migrated at Increment D (§3.5), never OR\'d.',
    disposition: 'quiet',
    emitterModules: ['ReapNoticeDrain'],
    defaultDestination: 'conversation',
  },
  {
    id: 'resume-queue-notice',
    description: 'Mid-work revival queue notices (revived / paused / gave-up).',
    disposition: 'quiet',
    emitterModules: ['ResumeQueue', 'server'],
    defaultDestination: 'conversation',
  },
  {
    id: 'commitment-deadletter',
    description:
      'PromiseBeacon dead-letters + agent-carried-loop surfacing. FD-14: quiet is a NAMED operator decision (The Agent Carries the Loop collision, DEV-6).',
    disposition: 'quiet',
    emitterModules: ['PromiseBeacon', 'CommitmentTracker'],
    defaultDestination: 'conversation',
  },
  {
    id: 'spend-alert',
    description: 'Spend/burn alerts (SpendAlertResolver, burn detector, spend topic channel).',
    disposition: 'quiet',
    emitterModules: ['SpendAlertResolver', 'TelegramSpendTopicChannel', 'BurnDetector'],
    defaultDestination: 'hub',
  },
  {
    id: 'mesh-alert',
    description: 'Multi-machine mesh notices (rope health, machine coherence, lease episodes).',
    disposition: 'quiet',
    emitterModules: ['RopeHealthMonitor', 'MachineCoherenceGuard', 'server'],
    defaultDestination: 'hub',
  },
  {
    id: 'tunnel-notice',
    description: 'Cloudflare tunnel lifecycle notices.',
    disposition: 'quiet',
    emitterModules: ['TunnelManager'],
    defaultDestination: 'hub',
  },
  {
    id: 'advisory-escalation',
    description: 'OutboundAdvisory repeated-ignore escalations.',
    disposition: 'quiet',
    emitterModules: ['OutboundAdvisoryAudit'],
    defaultDestination: 'hub',
  },
  {
    id: 'autonomous-heartbeat',
    description: 'The autonomous-run liveness line (its local brakes remain).',
    disposition: 'quiet',
    emitterModules: ['AutonomousProgressHeartbeat'],
    defaultDestination: 'conversation',
  },
  {
    id: 'update-announcement',
    description:
      'Post-update announcements. PA-5\'s audience/maturity gating IS this category\'s lever (§3.4): a stamped send already passed audience:user promotion.',
    disposition: 'quiet',
    emitterModules: ['AutoUpdater', 'UpgradeNotifyManager'],
    emitterGated: true,
    defaultDestination: 'hub',
  },
  {
    id: 'selectivity-digest',
    description: 'The §4.5 opt-in digest itself (push requires digest opt-in; content pinned to counts).',
    disposition: 'quiet',
    emitterModules: ['SelectivityDigest'],
    defaultDestination: 'hub',
  },
  {
    id: 'presence-standby',
    description: '🔭 standby receipts answering a live unanswered inbound.',
    disposition: 'conversation-serving',
    emitterModules: ['PresenceProxy'],
    defaultDestination: 'conversation',
  },
  {
    id: 'cold-start-fallback',
    description: 'Always-Reachable corollary-2 notices (session could not start — lifeline pointer).',
    disposition: 'conversation-serving',
    emitterModules: ['server', 'SessionManager'],
    defaultDestination: 'conversation',
  },
  {
    id: 'message-loss-notice',
    description: 'Inbound-queue loss / sender-rejection notices (constitutionally mandated floors).',
    disposition: 'conversation-serving',
    emitterModules: ['droppedMessages', 'InboundQueue', 'server'],
    defaultDestination: 'conversation',
  },
  {
    id: 'command-response',
    description: 'Replies to user-typed hub/topic commands (TelegramAdapter internal handlers).',
    disposition: 'conversation-serving',
    emitterModules: ['TelegramAdapter'],
    defaultDestination: 'conversation',
  },
  {
    id: UNCATEGORIZED,
    description:
      'ANY unstamped or unregistered automated send (§2.3). Derived-only: no module may stamp this id explicitly — it is what absence classifies to.',
    disposition: 'quiet',
    emitterModules: [],
    defaultDestination: 'hub',
  },
];

/**
 * §5 — the significant code table: (category, significantClass) → hub-push-without-
 * opt-in. Derived from each category's `significantClasses` declaration so the table
 * and the registry can never disagree. Extension is a PR to the registry (D-6).
 */
export const SIGNIFICANT_TABLE: ReadonlyMap<string, readonly SignificantClass[]> = new Map(
  NOTIFICATION_CATEGORIES.filter((c) => (c.significantClasses?.length ?? 0) > 0).map((c) => [
    c.id,
    c.significantClasses as readonly SignificantClass[],
  ]),
);

const CATEGORY_INDEX: ReadonlyMap<string, NotificationCategory> = new Map(
  NOTIFICATION_CATEGORIES.map((c) => [c.id, c]),
);

/** Resolve a registry entry; unknown ids resolve to the `uncategorized` entry. */
export function resolveCategory(id: string | undefined): NotificationCategory {
  if (!id) return CATEGORY_INDEX.get(UNCATEGORIZED) as NotificationCategory;
  return CATEGORY_INDEX.get(id) ?? (CATEGORY_INDEX.get(UNCATEGORIZED) as NotificationCategory);
}

/** Strict lookup (no uncategorized fallback) — the opt-in write surface uses this to reject unknown ids. */
export function getCategory(id: string): NotificationCategory | undefined {
  return CATEGORY_INDEX.get(id);
}

/** Is (category, class) permitted by the §5 code table? */
export function isSignificantAllowed(categoryId: string, cls: SignificantClass): boolean {
  const allowed = SIGNIFICANT_TABLE.get(categoryId);
  return !!allowed && allowed.includes(cls);
}

/** All category ids (dashboard inventory + opt-in validation). */
export function allCategoryIds(): string[] {
  return NOTIFICATION_CATEGORIES.map((c) => c.id);
}
