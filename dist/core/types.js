/**
 * Core type definitions for instar.
 *
 * These types define the contracts between all modules.
 * Everything flows from these — sessions, jobs, users, messaging.
 */
/**
 * Minimum trust level required to DIRECTLY write to each soul.md section.
 * At lower levels, writes are routed to the pending queue (not rejected).
 * Collaborative+ can write to all sections directly.
 */
export const SOUL_SECTION_TRUST = {
    'integrations': 'cautious',
    'open-questions': 'collaborative',
    'evolution-history': 'cautious',
    'convictions': 'collaborative',
    'core-values': 'collaborative',
    'growth-edge': 'collaborative',
};
//# sourceMappingURL=types.js.map