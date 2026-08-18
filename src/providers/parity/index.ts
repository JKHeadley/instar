/**
 * Phase 3c — behavior-parity scenarios across paired adapters.
 *
 * Public entry point. Import {@link runParitySuite} and any scenario
 * sets, construct two adapters, and run.
 */

export {
  PARITY_SUMMARY_SCHEMA,
  reportParityResults,
  reportParityResultsJson,
  runParitySuite,
  summarizeParityResults,
} from './runner.js';
export type {
  ParityContext,
  ParityHarness,
  ParityResult,
  ParityScenario,
  ParitySummary,
} from './runner.js';

export { oneShotCompletionScenarios } from './scenarios/oneShotCompletion.js';
export { capabilityOverlapScenarios } from './scenarios/capabilityOverlap.js';
export { sessionIdScenarios } from './scenarios/sessionId.js';

import { oneShotCompletionScenarios } from './scenarios/oneShotCompletion.js';
import { capabilityOverlapScenarios } from './scenarios/capabilityOverlap.js';
import { sessionIdScenarios } from './scenarios/sessionId.js';

/**
 * The full Phase 3c scenario set. Adapters wiring this in for the first
 * time should start here, then layer in optional / asymmetric primitive
 * scenarios as they're written.
 */
export const allParityScenarios = [
  ...capabilityOverlapScenarios,
  ...oneShotCompletionScenarios,
  ...sessionIdScenarios,
] as const;
