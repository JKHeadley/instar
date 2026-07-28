/**
 * Threadline Relay Protocol Types
 *
 * Wire format types for the relay WebSocket protocol.
 * See THREADLINE-RELAY-SPEC.md Section 3.
 */

// ── Agent Identity ──────────────────────────────────────────────────

/** Agent's fingerprint: first 16 bytes of Ed25519 public key, hex-encoded (32 chars) */
export type AgentFingerprint = string;

/** Agent visibility on the relay */
export type AgentVisibility = 'public' | 'unlisted' | 'private';

/** Agent metadata sent during auth and presence */
export interface AgentMetadata {
  name: string;
  framework?: string;
  capabilities?: string[];
  bio?: string;
  interests?: string[];
  version?: string;
  agentCardUrl?: string;
}

/** Agent presence entry in the registry */
export interface PresenceEntry {
  agentId: AgentFingerprint;
  publicKey: string; // base64-encoded Ed25519 public key
  metadata: AgentMetadata;
  visibility: AgentVisibility;
  status: 'online' | 'offline';
  connectedSince: string; // ISO 8601
  lastSeen: string; // ISO 8601
  sessionId: string; // relay session ID
}

// ── Wire Frames ─────────────────────────────────────────────────────

/** Relay → Agent: Auth challenge */
export interface ChallengeFrame {
  type: 'challenge';
  nonce: string;
}

/** Agent → Relay: Auth response */
export interface AuthFrame {
  type: 'auth';
  agentId: AgentFingerprint;
  publicKey: string; // base64 Ed25519 public key
  signature: string; // base64 Ed25519 signature of nonce
  metadata: AgentMetadata;
  visibility?: AgentVisibility;
  registry?: RegistryConfig;
}

/** Agent → Relay: Registry configuration in auth handshake */
export interface RegistryConfig {
  listed: boolean;
  homepage?: string;
  frameworkVisible?: boolean;
}

/** Relay → Agent: Auth success */
export interface AuthOkFrame {
  type: 'auth_ok';
  sessionId: string;
  heartbeatInterval: number; // ms
  registry_status?: 'listed' | 'not_listed' | 'updated';
  registry_token?: string;
  registry_token_expires?: string;
  registry_notice?: string;
}

/** Relay → Agent: Auth failure */
export interface AuthErrorFrame {
  type: 'auth_error';
  code: string;
  message: string;
}

/** Message envelope for E2E encrypted messages */
export interface MessageEnvelope {
  from: AgentFingerprint;
  to: AgentFingerprint;
  threadId: string;
  messageId: string;
  timestamp: string; // ISO 8601
  nonce: string; // base64 random nonce for replay protection
  ephemeralPubKey: string; // base64 X25519 ephemeral public key
  salt: string; // base64 32-byte HKDF salt
  payload: string; // base64 XChaCha20-Poly1305 encrypted content
  signature: string; // base64 Ed25519 signature of canonical envelope
}

/** Agent ↔ Relay: Encrypted message */
export interface MessageFrame {
  type: 'message';
  envelope: MessageEnvelope;
}

/** Bidirectional: Message acknowledgment */
export interface AckFrame {
  type: 'ack';
  messageId: string;
  status: 'delivered' | 'queued' | 'rejected';
  reason?: string;
  /** TTL in seconds (included when status is 'queued') */
  ttl?: number;
}

/** Agent → Relay: Presence announcement */
export interface PresenceFrame {
  type: 'presence';
  status: 'online' | 'offline';
  agentId: AgentFingerprint;
  metadata?: AgentMetadata;
}

/** Agent → Relay: Discovery query */
export interface DiscoverFrame {
  type: 'discover';
  filter?: {
    capability?: string;
    framework?: string;
    name?: string;
  };
}

/** Relay → Agent: Discovery response */
export interface DiscoverResultFrame {
  type: 'discover_result';
  agents: Array<{
    agentId: AgentFingerprint;
    name: string;
    framework?: string;
    capabilities?: string[];
    status: 'online' | 'offline';
    connectedSince?: string;
    lastSeen?: string;
  }>;
}

/** Relay → Agent: Heartbeat ping */
export interface PingFrame {
  type: 'ping';
  timestamp: string;
}

/** Agent → Relay: Heartbeat response */
export interface PongFrame {
  type: 'pong';
  timestamp: string;
}

/** Relay → Agent: Error notification */
export interface ErrorFrame {
  type: 'error';
  code: string;
  message: string;
  relatedMessageId?: string;
}

/** Agent → Relay: Subscribe to presence changes */
export interface SubscribeFrame {
  type: 'subscribe';
  agentIds?: AgentFingerprint[]; // specific agents, or all if omitted
}

/** Relay → Agent: Presence change notification */
export interface PresenceChangeFrame {
  type: 'presence_change';
  agentId: AgentFingerprint;
  status: 'online' | 'offline';
  metadata?: AgentMetadata;
}

/** Relay → Agent: Displacement notification (another device connected with same key) */
export interface DisplacedFrame {
  type: 'displaced';
  reason: string;
}

/** Relay → Agent: Notification that a queued message expired without delivery */
export interface DeliveryExpiredFrame {
  type: 'delivery_expired';
  messageId: string;
  recipientId: AgentFingerprint;
  queuedAt: string; // ISO 8601
}

// ── Union Type ──────────────────────────────────────────────────────

export type RelayFrame =
  | ChallengeFrame
  | AuthFrame
  | AuthOkFrame
  | AuthErrorFrame
  | MessageFrame
  | AckFrame
  | PresenceFrame
  | DiscoverFrame
  | DiscoverResultFrame
  | PingFrame
  | PongFrame
  | ErrorFrame
  | SubscribeFrame
  | PresenceChangeFrame
  | DisplacedFrame
  | DeliveryExpiredFrame;

/** Frames sent by agents to the relay */
export type ClientFrame =
  | AuthFrame
  | MessageFrame
  | AckFrame
  | PresenceFrame
  | DiscoverFrame
  | PongFrame
  | SubscribeFrame;

/** Frames sent by the relay to agents */
export type ServerFrame =
  | ChallengeFrame
  | AuthOkFrame
  | AuthErrorFrame
  | MessageFrame
  | AckFrame
  | DiscoverResultFrame
  | PingFrame
  | ErrorFrame
  | PresenceChangeFrame
  | DisplacedFrame
  | DeliveryExpiredFrame;

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
} as const;

export type RelayErrorCode = typeof RELAY_ERROR_CODES[keyof typeof RELAY_ERROR_CODES];

// ── Configuration ───────────────────────────────────────────────────

export interface RelayServerConfig {
  port: number;
  host?: string;
  heartbeatIntervalMs?: number; // default 60000
  heartbeatJitterMs?: number; // default 15000
  authTimeoutMs?: number; // default 10000
  maxEnvelopeSize?: number; // default 256 * 1024 (256KB)
  maxAgents?: number; // default 10000
  missedPongsBeforeDisconnect?: number; // default 3
  rateLimitConfig?: Partial<import('./RelayRateLimiter.js').RelayRateLimitConfig>;
  a2aRateLimitConfig?: Partial<import('./A2ABridge.js').A2ABridgeRateLimitConfig>;
  offlineQueueConfig?: Partial<import('./OfflineQueue.js').OfflineQueueConfig>;
  abuseDetectorConfig?: Partial<import('./AbuseDetector.js').AbuseDetectorConfig>;
  /** Data directory for registry SQLite database. Default: ./data */
  registryDataDir?: string;
  /** Relay ID for registry entries. Default: auto-generated */
  relayId?: string;
}

export interface RelayClientConfig {
  relayUrl: string; // wss://threadline-relay.fly.dev/v1/connect
  name: string;
  framework?: string;
  capabilities?: string[];
  version?: string;
  visibility?: AgentVisibility;
  reconnectInitialMs?: number; // default 1000
  reconnectMaxMs?: number; // default 60000
  reconnectJitter?: number; // default 0.25 (±25%)
  stateDir?: string; // where to store identity keys
}
