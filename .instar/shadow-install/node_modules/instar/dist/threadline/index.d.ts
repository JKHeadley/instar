/**
 * Threadline Protocol — Session coherence, autonomy-gated visibility,
 * and cryptographic inter-agent handshake.
 *
 * Phase 1: Session resume for threaded agent-to-agent conversations.
 * Phase 2: Autonomy-gated visibility — user involvement scales with trust level.
 * Phase 3: Threadline endpoints, Ed25519/X25519 handshake, relay tokens.
 */
export { ThreadResumeMap } from './ThreadResumeMap.js';
export type { ThreadResumeEntry, ThreadState } from './ThreadResumeMap.js';
export { ThreadlineRouter } from './ThreadlineRouter.js';
export type { ThreadlineRouterConfig, ThreadlineHandleResult, RelayMessageContext } from './ThreadlineRouter.js';
export { AutonomyGate } from './AutonomyGate.js';
export type { GateDecision, GateResult, ThreadlineNotifier } from './AutonomyGate.js';
export { ApprovalQueue } from './ApprovalQueue.js';
export type { ApprovalQueueEntry } from './ApprovalQueue.js';
export { DigestCollector } from './DigestCollector.js';
export type { DigestEntry, DigestState } from './DigestCollector.js';
export { generateIdentityKeyPair, generateEphemeralKeyPair, sign, verify, ecdh, deriveRelayToken, computeChallengeResponse, } from './ThreadlineCrypto.js';
export type { KeyPair } from './ThreadlineCrypto.js';
export { HandshakeManager } from './HandshakeManager.js';
export type { HandshakeState, HelloPayload, ConfirmPayload } from './HandshakeManager.js';
export { createThreadlineRoutes } from './ThreadlineEndpoints.js';
export type { ThreadlineError, ThreadlineEndpointsConfig } from './ThreadlineEndpoints.js';
export { AgentDiscovery } from './AgentDiscovery.js';
export type { ThreadlineAgentInfo, AgentInfoFile, HttpFetcher } from './AgentDiscovery.js';
export { AgentTrustManager } from './AgentTrustManager.js';
export type { AgentTrustLevel, AgentTrustSource, AgentTrustHistory, AgentTrustProfile, TrustAuditEntry, TrustChangeNotification, TrustChangeCallback, InteractionStats, } from './AgentTrustManager.js';
export { CircuitBreaker } from './CircuitBreaker.js';
export type { CircuitStateValue, CircuitState, } from './CircuitBreaker.js';
export { RateLimiter, DEFAULT_RATE_LIMITS } from './RateLimiter.js';
export type { RateLimitConfig, RateLimitType, RateLimitResult, RateLimitStatus, } from './RateLimiter.js';
export { MCPAuth } from './MCPAuth.js';
export type { MCPTokenScope, MCPTokenInfo, MCPTokenCreateResult, } from './MCPAuth.js';
export { ThreadlineMCPServer } from './ThreadlineMCPServer.js';
export type { ThreadlineMCPServerConfig, ThreadlineMCPDeps, RegistryClient, SendMessageParams, SendMessageResult, ThreadHistoryMessage, ThreadHistoryResult, } from './ThreadlineMCPServer.js';
export { AgentCard } from './AgentCard.js';
export type { AgentCardConfig, AgentCardSkill, GeneratedAgentCard, } from './AgentCard.js';
export { ContextThreadMap } from './ContextThreadMap.js';
export type { ContextThreadMapping, ContextThreadMapConfig, } from './ContextThreadMap.js';
export { ComputeMeter } from './ComputeMeter.js';
export type { ComputeBudget, ComputeMeterConfig, MeterCheckResult, } from './ComputeMeter.js';
export { SessionLifecycle } from './SessionLifecycle.js';
export type { SessionState, SessionEntry, SessionLifecycleConfig, SessionCapacityResult, SessionStats, } from './SessionLifecycle.js';
export { A2AGateway, A2A_ERROR_CODES } from './A2AGateway.js';
export type { A2AGatewayConfig, A2AGatewayDeps, GatewaySendParams, GatewayResponse, GatewayHistoryMessage, A2AErrorResponse, A2AMetrics, AuditEntry, } from './A2AGateway.js';
export { DNSVerifier } from './DNSVerifier.js';
export type { DNSVerifyResult, DNSResolverFn, DNSVerifierConfig, } from './DNSVerifier.js';
export { InvitationManager } from './InvitationManager.js';
export type { InvitationCreateOptions, Invitation, InvitationStatus, InvitationValidateResult, } from './InvitationManager.js';
export { TrustBootstrap } from './TrustBootstrap.js';
export type { TrustBootstrapStrategy, TrustBootstrapConfig, BootstrapEvidence, BootstrapResult, } from './TrustBootstrap.js';
export { OpenClawBridge } from './OpenClawBridge.js';
export type { OpenClawMessage, OpenClawRuntime, OpenClawAction, OpenClawBridgeConfig, OpenClawBridgeMetrics, BridgeSendParams, BridgeResponse, BridgeAgentInfo, BridgeHistoryMessage, } from './OpenClawBridge.js';
export { generateSkillManifest } from './OpenClawSkillManifest.js';
export type { SkillManifest } from './OpenClawSkillManifest.js';
export { bootstrapThreadline } from './ThreadlineBootstrap.js';
export type { ThreadlineBootstrapConfig, ThreadlineBootstrapResult } from './ThreadlineBootstrap.js';
export { InboundMessageGate } from './InboundMessageGate.js';
export type { InboundGateConfig, GateDecision as InboundGateDecision } from './InboundMessageGate.js';
export { buildRelayGroundingPreamble, tagExternalMessage, RELAY_HISTORY_LIMITS } from './RelayGroundingPreamble.js';
export type { RelayGroundingContext } from './RelayGroundingPreamble.js';
export { ContentClassifier, createDisabledClassifier } from './ContentClassifier.js';
export type { ContentClassification, ClassificationResult, ContentClassifierConfig, ThreadContext, } from './ContentClassifier.js';
export { RelayServer } from './relay/RelayServer.js';
export { PresenceRegistry } from './relay/PresenceRegistry.js';
export { RelayRateLimiter } from './relay/RelayRateLimiter.js';
export { MessageRouter } from './relay/MessageRouter.js';
export { ConnectionManager } from './relay/ConnectionManager.js';
export { RELAY_ERROR_CODES } from './relay/types.js';
export { ThreadlineClient } from './client/ThreadlineClient.js';
export { RelayClient } from './client/RelayClient.js';
export { MessageEncryptor, computeFingerprint, deriveX25519PublicKey } from './client/MessageEncryptor.js';
export { IdentityManager } from './client/IdentityManager.js';
export { RegistryRestClient } from './client/RegistryRestClient.js';
export type { RegistryRestClientConfig } from './client/RegistryRestClient.js';
export type { ThreadlineClientConfig, KnownAgent, ReceivedMessage, } from './client/ThreadlineClient.js';
export type { IdentityInfo } from './client/IdentityManager.js';
export type { PlaintextMessage } from './client/MessageEncryptor.js';
export type { AgentFingerprint, AgentVisibility, AgentMetadata, MessageEnvelope, RelayServerConfig, RelayClientConfig, } from './relay/types.js';
//# sourceMappingURL=index.d.ts.map