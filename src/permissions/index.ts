/**
 * Slack organizational permission system (Pillar 2 + Pillar 3 hook).
 * Design: docs/specs/SLACK-ORG-INTEGRATION-SPEC.md
 */
export * from './types.js';
export * from './RolePolicy.js';
export * from './IntentClassifier.js';
export * from './LlmIntentClassifier.js';
export * from './AmbientContributionGate.js';
export * from './AnomalyScorer.js';
export * from './PermissionDecisionLedger.js';
export * from './SlackPermissionGate.js';
export * from './MandateBackedGrantStore.js';
export * from './SlackPrincipalResolver.js';
export * from './SlackPermissionObserver.js';
export * from './SlackUserRegistry.js';
