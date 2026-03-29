/**
 * Inter-Agent Messaging type definitions.
 *
 * These types define the contracts for agent-to-agent communication
 * in the Instar ecosystem — same machine, cross-agent, cross-machine.
 *
 * Derived from: docs/specs/INTER-AGENT-MESSAGING-SPEC.md v3.1
 */
/**
 * Valid delivery phase transitions.
 * Used by the state machine to enforce monotonic progression.
 */
export const VALID_TRANSITIONS = [
    ['created', 'sent'],
    ['sent', 'received'],
    ['received', 'queued'],
    ['received', 'delivered'],
    ['queued', 'delivered'],
    ['delivered', 'queued'], // Exception: post-injection crash watchdog
    ['delivered', 'read'],
    ['received', 'expired'],
    ['queued', 'expired'],
    ['expired', 'dead-lettered'],
    ['failed', 'dead-lettered'],
    // Any phase can transition to 'failed' on unrecoverable error
    ['created', 'failed'],
    ['sent', 'failed'],
    ['received', 'failed'],
    ['queued', 'failed'],
    ['delivered', 'failed'],
];
/**
 * Allowed foreground processes for injection.
 * Only inject if one of these is running — whitelist is strictly safer than blocklist.
 */
export const ALLOWED_INJECTION_PROCESSES = [
    'bash', 'zsh', 'fish', 'sh', 'dash', 'claude',
];
// ── Configuration ──────────────────────────────────────────────────
/** Default TTL per message type (in minutes) */
export const DEFAULT_TTL = {
    info: 30,
    sync: 15,
    alert: 60,
    request: 120,
    query: 30,
    response: 15,
    handoff: 480,
    wellness: 5,
    system: 60,
};
/** Default data retention per message type (in days) */
export const DEFAULT_RETENTION_DAYS = {
    info: 7,
    sync: 3,
    alert: 30,
    request: 30,
    query: 7,
    response: 7,
    handoff: 90,
    wellness: 1,
    system: 30,
};
/** Default rate limits per scope */
export const DEFAULT_RATE_LIMITS = {
    'session-send': { maxMessages: 20, windowMs: 5 * 60_000 },
    'session-receive': { maxMessages: 30, windowMs: 5 * 60_000 },
    'agent-total': { maxMessages: 100, windowMs: 5 * 60_000 },
    'broadcast': { maxMessages: 5, windowMs: 5 * 60_000 },
    'cross-machine': { maxMessages: 30, windowMs: 5 * 60_000 },
    'inbound-triggered': { maxMessages: 5, windowMs: 60_000 },
};
/** Thread limits */
export const THREAD_MAX_DEPTH = 50;
export const THREAD_STALE_MINUTES = 30;
/** Message body size limits */
export const MAX_BODY_SIZE = 4096; // 4KB
export const MAX_PAYLOAD_SIZE = 16_384; // 16KB
export const MAX_SUBJECT_LENGTH = 200;
export const PAYLOAD_INLINE_THRESHOLD = 2048; // 2KB — payloads larger than this are written to temp files
/** Clock skew tolerance per transport type (in milliseconds) */
export const CLOCK_SKEW_TOLERANCE = {
    'relay-machine': 5 * 60_000, // 5 minutes for cross-machine relay
    'relay-agent': null, // No check — same machine
    'drop': null, // No check — offline transport
    'git-sync': null, // No check — offline transport
    'outbound-queue': null, // No check — queued for later
};
//# sourceMappingURL=types.js.map