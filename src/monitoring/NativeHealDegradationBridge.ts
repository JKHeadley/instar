/**
 * NativeHealDegradationBridge — surface NativeModuleHealer failures on the
 * user-visible DegradationReporter path.
 *
 * Without this bridge, a failed better-sqlite3 rebuild only lands in
 * <stateDir>/native-module-heals.jsonl and console.error. The agent then
 * silently runs with SemanticMemory / TopicMemory / MemoryIndex / TokenLedger
 * degraded and no Telegram alert ever fires. DegradationReporter is the
 * canonical path for "the primary failed, the user should know" — this
 * bridge connects the two.
 *
 * Scope: failure events only. Successful heals are silent on purpose —
 * the feature recovered, no user action is required. The listener still
 * fires on success so future health-info consumers can subscribe without
 * a parallel dispatch surface.
 *
 * Dedupe: one degradation event per component per process. Heals are
 * already once-per-process via NativeModuleHealer.healAttempted, but the
 * Set in here defends against future surface-area changes (e.g. per-module
 * heal retries) that would otherwise spam the alert path.
 */

import { NativeModuleHealer, type HealEvent } from '../memory/NativeModuleHealer.js';
import { DegradationReporter } from './DegradationReporter.js';

const FALLBACK_IMPACT =
  'Feature unavailable until better-sqlite3 is rebuilt. Restart the agent or run `npm rebuild better-sqlite3 --prefix <install_prefix>` to retry.';

const COMPONENT_IMPACTS: Record<string, string> = {
  SemanticMemory:
    'Persistent knowledge graph unavailable; new entities and evidence will not be retained across sessions.',
  TopicMemory:
    'Conversation summaries unavailable; sessions start without prior-thread context.',
  MemoryIndex:
    'Memory search unavailable; queries against the memory index will return empty results.',
  TokenLedger:
    'Token-usage telemetry unavailable; /tokens/summary and /tokens/sessions endpoints will return 503.',
};

function buildDegradationReason(event: HealEvent): string {
  const prefix = event.installPrefix ? ` (prefix=${event.installPrefix})` : '';
  const tail = event.errorTail ? `: ${event.errorTail}` : '';
  return `NativeModuleHealer rebuild failed on Node ${event.nodeVersion}${prefix}${tail}`;
}

/**
 * Subscribe a DegradationReporter to NativeModuleHealer heal events.
 * Returns the unsubscribe function from NativeModuleHealer.onHealEvent
 * so tests (or future hot-reload code) can detach the bridge.
 *
 * The `reporter` parameter is exposed primarily for tests; production
 * callers should rely on the DegradationReporter singleton default.
 */
export function bridgeNativeHealToDegradation(
  reporter: DegradationReporter = DegradationReporter.getInstance(),
): () => void {
  const reported = new Set<string>();
  return NativeModuleHealer.onHealEvent((event) => {
    if (event.success) return;
    if (reported.has(event.component)) return;
    reported.add(event.component);

    reporter.report({
      feature: event.component,
      primary: 'native SQLite via better-sqlite3',
      fallback: `${event.component} unavailable — better-sqlite3 ABI mismatch could not be healed automatically`,
      reason: buildDegradationReason(event),
      impact: COMPONENT_IMPACTS[event.component] ?? FALLBACK_IMPACT,
    });
  });
}
