/**
 * Codex event-normalizer canary.
 *
 * Per Rule 3.2: every state-detection code path needs a canary that
 * verifies the detector still works correctly across upstream evolution.
 * The Codex event-normalizer is the highest-leverage state-detection
 * surface in this adapter — every event emitted by `codex exec --json`
 * flows through it, and Codex CLI minor versions add/change event types
 * regularly.
 *
 * This canary uses KNOWN-SHAPE JSONL fixtures captured against Codex CLI
 * 0.130.0 (2026-05-15) and asserts each one maps to the expected
 * CanonicalEvent. If a future Codex version changes the shape, the canary
 * fails loudly at startup, surfacing to ECHO ONLY via the
 * DegradationReporter — not to all Instar agents. Self-healing is not
 * applicable for an enum-shape mismatch; the next step is a code fix to
 * the normalizer.
 *
 * RULE 3.1 RATIONALE
 *   Criticality: critical — silent data corruption if a turn-completed event
 *                changes shape and we silently drop it
 *   Frequency:   startup canary (one tick per pool spawn, scheduled hourly
 *                via the same canary interval used by the empty-prompt detector)
 *   Stability:   unstable — Codex CLI changes event vocabulary across versions
 *   Fallback:    none — failure surfaces via degradation alert; cannot self-heal
 *   Verdict:     deterministic structural assertion with cached known-good
 *                fixtures + version-pinned canary outputs
 */

import {
  normalizeCodexJsonlEvent,
  RECOGNIZED_CODEX_EVENT_TYPES,
} from '../observability/eventNormalizer.js';

interface FixtureCase {
  description: string;
  line: string;
  expectedType: string;
  /** Optional per-case extra assertions on the canonical event payload. */
  extraAssert?: (ev: Record<string, unknown>) => string | null;
}

/**
 * Known-good Codex JSONL fixtures captured 2026-05-15 against codex-cli
 * 0.130.0. Each fixture maps a real (or realistic) line to its expected
 * canonical type.
 */
const FIXTURES: ReadonlyArray<FixtureCase> = [
  {
    description: 'thread.started → session-lifecycle (started)',
    line: '{"type":"thread.started","thread_id":"019e2d73-0982-7391-996d-da5f370efca7"}',
    expectedType: 'session-lifecycle',
    extraAssert: (ev) => {
      if ((ev['lifecycleKind'] as string) !== 'started') return 'lifecycleKind != started';
      return null;
    },
  },
  {
    description: 'turn.started → null (boundary marker only)',
    line: '{"type":"turn.started"}',
    expectedType: 'NULL',
  },
  {
    description: 'turn.completed → turn-end with usage',
    line: '{"type":"turn.completed","usage":{"input_tokens":100,"output_tokens":50}}',
    expectedType: 'turn-end',
  },
  {
    description: 'turn.failed → error',
    line: '{"type":"turn.failed","error":{"message":"upstream failure"}}',
    expectedType: 'error',
    extraAssert: (ev) => {
      if (ev['recoverable'] !== false) return 'turn.failed should be recoverable=false';
      return null;
    },
  },
  {
    description: 'error → recoverable error event',
    line: '{"type":"error","message":"transient blip"}',
    expectedType: 'error',
    extraAssert: (ev) => {
      if (ev['recoverable'] !== true) return 'error event should be recoverable=true';
      return null;
    },
  },
  {
    description: 'item.agentMessage.delta → message-delta',
    line: '{"type":"item.agentMessage.delta","delta":"Hello"}',
    expectedType: 'message-delta',
  },
  {
    description: 'item.commandExecution.requestApproval → interactive-prompt',
    line: '{"type":"item.commandExecution.requestApproval","item":{"command":"ls"}}',
    expectedType: 'interactive-prompt',
    extraAssert: (ev) => {
      if (ev['source'] !== 'structured') return 'expected source=structured';
      return null;
    },
  },
  {
    description: 'unknown.event → provider-raw (escape hatch)',
    line: '{"type":"unknown.event","data":42}',
    expectedType: 'provider-raw',
  },
];

export interface CodexEventNormalizerCanaryResult {
  status: 'pass' | 'fail';
  message: string;
  failures: ReadonlyArray<string>;
  recognizedTypeCount: number;
}

/**
 * Run the canary. Returns 'pass' if every fixture maps to its expected
 * canonical event type, 'fail' otherwise. Fast and synchronous.
 */
export function runCodexEventNormalizerCanary(): CodexEventNormalizerCanaryResult {
  const failures: string[] = [];

  for (const fixture of FIXTURES) {
    const result = normalizeCodexJsonlEvent(fixture.line);
    if (fixture.expectedType === 'NULL') {
      if (result !== null) failures.push(`${fixture.description}: expected null, got ${result.type}`);
      continue;
    }
    if (result === null) {
      failures.push(`${fixture.description}: expected ${fixture.expectedType}, got null`);
      continue;
    }
    if (result.type !== fixture.expectedType) {
      failures.push(`${fixture.description}: expected ${fixture.expectedType}, got ${result.type}`);
      continue;
    }
    if (fixture.extraAssert) {
      const err = fixture.extraAssert(result as unknown as Record<string, unknown>);
      if (err) failures.push(`${fixture.description}: ${err}`);
    }
  }

  // Vocabulary check: the recognized type set must be a known size. A
  // shrink is a regression (we recognize fewer Codex events than before).
  // A grow with no fixture update is a soft warning — pass but flag.
  const expectedMinVocab = 12;
  if (RECOGNIZED_CODEX_EVENT_TYPES.size < expectedMinVocab) {
    failures.push(
      `recognized event vocabulary shrank: ${RECOGNIZED_CODEX_EVENT_TYPES.size} < ${expectedMinVocab}`,
    );
  }

  if (failures.length === 0) {
    return {
      status: 'pass',
      message: `codex event-normalizer canary: all ${FIXTURES.length} fixtures pass`,
      failures: [],
      recognizedTypeCount: RECOGNIZED_CODEX_EVENT_TYPES.size,
    };
  }
  return {
    status: 'fail',
    message: `codex event-normalizer canary: ${failures.length} fixture(s) failed`,
    failures,
    recognizedTypeCount: RECOGNIZED_CODEX_EVENT_TYPES.size,
  };
}
