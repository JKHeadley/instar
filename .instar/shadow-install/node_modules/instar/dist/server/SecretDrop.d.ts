/**
 * SecretDrop — Secure secret submission from user to agent.
 *
 * When an agent needs a secret (API key, password, token), it creates a
 * one-time-use, time-limited URL. The user opens the link in a browser,
 * submits the secret via a clean form, and the agent receives it directly —
 * never passing through Telegram or any chat history.
 *
 * Security properties:
 * - One-time use: token destroyed after successful submission
 * - Time-limited: expires after configurable TTL (default 15 minutes)
 * - In-memory only: pending requests and secrets never touch disk
 * - CSRF protection: form includes a hidden CSRF token
 * - Rate-limited: max submissions per IP
 * - XSS-safe: all rendered content is escaped
 * - The URL token IS the auth — no login or bearer token needed
 */
export interface SecretField {
    /** Field identifier (e.g., "api_key", "password") */
    name: string;
    /** Human-readable label shown in the form */
    label: string;
    /** Whether to mask the input (default: true) */
    masked?: boolean;
    /** Placeholder text */
    placeholder?: string;
}
export interface SecretRequest {
    /** Unique token for the URL */
    token: string;
    /** CSRF token embedded in the form */
    csrfToken: string;
    /** What's being requested (shown in the form header) */
    label: string;
    /** Optional description/reason shown to the user */
    description?: string;
    /** Fields to collect (defaults to a single "secret" field) */
    fields: SecretField[];
    /** Telegram topic to notify on receipt */
    topicId?: number;
    /** When this request was created */
    createdAt: number;
    /** When this request expires (ms since epoch) */
    expiresAt: number;
    /** Callback fired when the secret is received */
    onReceive?: (values: Record<string, string>) => void;
    /** Agent name (shown in the form) */
    agentName: string;
}
export interface SecretSubmission {
    /** The values submitted by the user */
    values: Record<string, string>;
    /** When the submission was received */
    receivedAt: string;
    /** The request label */
    label: string;
    /** The topic to notify */
    topicId?: number;
}
export interface CreateSecretRequestOptions {
    /** What's being requested — shown as the form title */
    label: string;
    /** Why it's needed — shown as description in the form */
    description?: string;
    /** Fields to collect. Defaults to single masked "secret" field */
    fields?: SecretField[];
    /** Telegram topic to notify on receipt */
    topicId?: number;
    /** TTL in milliseconds (default: 15 minutes) */
    ttlMs?: number;
    /** Callback when secret is received */
    onReceive?: (values: Record<string, string>) => void;
}
export declare class SecretDrop {
    private pending;
    private received;
    private cleanupTimer;
    private agentName;
    constructor(agentName: string);
    /**
     * Create a new secret request. Returns the token for URL construction.
     */
    create(options: CreateSecretRequestOptions): {
        token: string;
    };
    /**
     * Get a pending request by token. Returns null if expired or not found.
     */
    getPending(token: string): SecretRequest | null;
    /**
     * Submit a secret. Validates CSRF, consumes the request (one-time use),
     * fires the callback, and stores the submission for retrieval.
     * Returns the submission on success, null on failure.
     */
    submit(token: string, csrfToken: string, values: Record<string, string>): SecretSubmission | null;
    /**
     * Retrieve a received submission (for polling-based retrieval).
     * Returns and removes the submission.
     */
    getReceived(token: string): SecretSubmission | null;
    /**
     * List all pending requests (for the agent's management API).
     */
    listPending(): Array<{
        token: string;
        label: string;
        topicId?: number;
        createdAt: number;
        expiresAt: number;
        expired: boolean;
    }>;
    /**
     * Cancel a pending request.
     */
    cancel(token: string): boolean;
    /**
     * Remove expired requests.
     */
    private cleanup;
    /**
     * Render the secret submission form as self-contained HTML.
     */
    renderForm(request: SecretRequest): string;
    /**
     * Render an expired/not-found page.
     */
    renderExpiredPage(): string;
    /**
     * Shutdown — clean up timer.
     */
    shutdown(): void;
}
//# sourceMappingURL=SecretDrop.d.ts.map