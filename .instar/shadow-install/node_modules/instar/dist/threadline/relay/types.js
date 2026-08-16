/**
 * Threadline Relay Protocol Types
 *
 * Wire format types for the relay WebSocket protocol.
 * See THREADLINE-RELAY-SPEC.md Section 3.
 */
// ── Error Codes ─────────────────────────────────────────────────────
export const RELAY_ERROR_CODES = {
    AUTH_FAILED: 'auth_failed',
    AUTH_TIMEOUT: 'auth_timeout',
    INVALID_FRAME: 'invalid_frame',
    RECIPIENT_OFFLINE: 'recipient_offline',
    RECIPIENT_UNKNOWN: 'recipient_unknown',
    ENVELOPE_TOO_LARGE: 'envelope_too_large',
    RATE_LIMITED: 'rate_limited',
    INVALID_SIGNATURE: 'invalid_signature',
    REPLAY_DETECTED: 'replay_detected',
    BANNED: 'banned',
    INTERNAL_ERROR: 'internal_error',
};
//# sourceMappingURL=types.js.map