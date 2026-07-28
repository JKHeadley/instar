/**
 * Durable-Output Chokepoint Inventory — the auditable registry of every store
 * that accepts LLM output and, per store, its Layer-B scrub status + its
 * durable-secret bench-axis coverage (Durable-Output Hygiene Standard §3,
 * docs/specs/durable-output-hygiene-standard.md).
 *
 * This is the file the Standards Enforcement Coverage audit reads to grade the
 * "What Persists Must Be Clean" standard `gate` rather than `spec-only`, and the
 * file the durable-output-chokepoint ratchet (tests/unit/
 * durable-output-chokepoint-ratchet.test.ts) pins SHRINK-ONLY: a chokepoint may
 * graduate `pending → wired`, never regress, and a NEW durable-output persistence
 * path cannot silently bypass the class (it must be classified here, exactly like
 * the llmBenchCoverage map forces a bench decision on every LLM component).
 *
 * SCOPE (spec §3): memory-family stores + doc-tree summaries are in scope now;
 * logs/telemetry are covered by the existing telemetry scrubs; caches / vector
 * indexes / eval artifacts and the private-view / published-page write path are
 * enumerated as tracked follow-ups IN this inventory (a semantically-durable leak
 * path cannot park as an undated TODO — each carries an owner).
 *
 * MULTI-MACHINE POSTURE (spec §3, Cross-Machine Coherence): a replicated
 * memory-family store accepts records FROM PEERS, so a peer running with the
 * scrub dark could deliver an unscrubbed secret into a scrub-enabled machine's
 * durable store, bypassing every writer-side chokepoint. Each replicated store
 * therefore lists its RECEIVE path as its own chokepoint (`receivePath`).
 *
 * NOTE (rollout reality): the CODE that wires the scrub at each chokepoint lands
 * incrementally (dark-first). This inventory is the durable contract that names
 * every chokepoint up front so the ratchet + coverage audit measure progress
 * against a fixed denominator rather than agent memory.
 */

export type ScrubStatus =
  /** The DurableOutputScrubber is wired at this persistence write. */
  | 'wired'
  /** In scope; wiring queued. MUST carry an `owner`. Pinned shrink-only. */
  | 'pending'
  /** Argued out of scope. MUST carry a `reason` (an existing serve-time redaction,
   *  a different write path tracked as a follow-up, etc.). */
  | 'exempt';

export type BenchAxisStatus =
  /** A `durable-secret` bench axis case exists for this writer (contract id in
   *  `benchTaskId`; the case itself lives in the bench harness). */
  | 'covered'
  /** Authoring queued. Pinned shrink-only. */
  | 'pending'
  /** No meaningful durable-secret case (argued in `reason`). */
  | 'exempt';

export interface ChokepointReceivePath {
  /** Human name of the replicated-receive chokepoint. */
  store: string;
  scrubStatus: ScrubStatus;
  reason?: string;
  owner?: string;
}

export interface DurableOutputChokepoint {
  /** The LLM writer component (matches a COMPONENT_CATEGORY key where one exists). */
  component: string;
  /** Human name of the durable store the output lands in. */
  store: string;
  /** Where in the tree the persistence write lives (audit pointer). */
  path: string;
  scrubStatus: ScrubStatus;
  benchAxis: BenchAxisStatus;
  /** Durable-secret bench contract id when benchAxis === 'covered'. */
  benchTaskId?: string;
  /** REQUIRED when scrubStatus/benchAxis is `exempt` (≥ 20 chars, argued). */
  reason?: string;
  /** REQUIRED when scrubStatus is `pending` — the Close-the-Loop owner. */
  owner?: string;
  /** Replicated-store receive-path chokepoint (multi-machine posture, spec §3). */
  receivePath?: ChokepointReceivePath;
}

/**
 * The known set from the routing registry (spec §3) + the replicated-store
 * receive paths + the tracked follow-ups. SessionSummarySentinel is the FIRST
 * wired chokepoint (the demonstrated Layer-B wiring); the rest are pending
 * follow-ups adopting the same one-line scrubber call.
 */
export const DURABLE_OUTPUT_CHOKEPOINTS: readonly DurableOutputChokepoint[] = [
  {
    component: 'SessionSummarySentinel',
    store: 'session routing summaries (state/sessions/<id>/summary.json)',
    path: 'src/messaging/SessionSummarySentinel.ts',
    scrubStatus: 'wired',
    benchAxis: 'covered',
    benchTaskId: 'session-summary-durable-secret',
  },
  {
    component: 'SessionActivitySentinel',
    store: 'activity-digest entries → SemanticMemory (long-term memory)',
    path: 'src/monitoring/SessionActivitySentinel.ts',
    scrubStatus: 'pending',
    owner: 'durable-output-hygiene rollout step 3 (Layer A digest writer already shipped v1.3.721; migrate its persist path onto the shared scrubber)',
    benchAxis: 'pending',
  },
  {
    component: 'SelfKnowledgeTree',
    store: 'self-knowledge facts extractor → self-knowledge-tree.json',
    path: 'src/core/SelfKnowledgeTree.ts',
    scrubStatus: 'pending',
    owner: 'durable-output-hygiene rollout (adopt the shared scrubber at the facts-persist write)',
    benchAxis: 'pending',
  },
  {
    component: 'knowledge-base-synthesizer',
    store: 'knowledge-base synthesized records',
    path: 'src/knowledge (KB synthesizer persist path)',
    scrubStatus: 'pending',
    owner: 'durable-output-hygiene rollout (adopt the shared scrubber at the KB record write)',
    benchAxis: 'pending',
    receivePath: {
      store: 'replicated KB catalog (WS2.4 stateSync.knowledge receive)',
      scrubStatus: 'pending',
      owner: 'durable-output-hygiene multi-machine posture (scrub-on-receive with the shared module, or argue a serve-time-redaction exemption)',
    },
  },
  {
    component: 'correction-learning',
    store: 'correction distiller records (CorrectionCaptureLoop)',
    path: 'src/monitoring/CorrectionCaptureLoop.ts',
    scrubStatus: 'exempt',
    reason: 'CorrectionCaptureLoop already applies the deterministic scrubSecrets() pass on BOTH sides of its LLM hop (pre-distill + post-distill persist) per its own spec §3.3 — an existing serve-time/persist redaction. Migrates to the shared module in rollout step 0; the class is not unguarded here.',
    benchAxis: 'covered',
    benchTaskId: 'correction-distiller',
  },
  {
    component: 'CartographerSweep',
    store: 'cartographer doc-tree node summaries',
    path: 'src/core/cartographerSummary.ts',
    scrubStatus: 'pending',
    owner: 'durable-output-hygiene rollout (adopt the shared scrubber at the node-summary write; the sweep already runs on a light off-Claude model)',
    benchAxis: 'pending',
  },
  {
    component: 'learnings-registry',
    store: 'learnings registry entries',
    path: 'src/core (learning registry persist path)',
    scrubStatus: 'pending',
    owner: 'durable-output-hygiene rollout (adopt the shared scrubber at the learning-persist write)',
    benchAxis: 'pending',
    receivePath: {
      store: 'replicated learnings (WS2.2 stateSync.learnings receive)',
      scrubStatus: 'pending',
      owner: 'durable-output-hygiene multi-machine posture (scrub-on-receive with the shared module, or argue a serve-time-redaction exemption)',
    },
  },
  {
    component: 'RelationshipManager',
    store: 'relationship records (WS2.3 — user-visible PII)',
    path: 'src/core/RelationshipManager.ts',
    scrubStatus: 'pending',
    owner: 'durable-output-hygiene rollout (adopt the shared scrubber at the relationship-record write)',
    benchAxis: 'pending',
    receivePath: {
      store: 'replicated relationships (WS2.3 stateSync.relationships receive)',
      scrubStatus: 'pending',
      owner: 'durable-output-hygiene multi-machine posture (scrub-on-receive with the shared module, or argue a serve-time-redaction exemption)',
    },
  },
  // ── Tracked follow-ups (spec §3 scope boundary + Frontloaded Decision #3) ──
  {
    component: 'private-view-publisher',
    store: 'private views / published Telegraph pages (different write path)',
    path: 'src/server (view + publish routes)',
    scrubStatus: 'exempt',
    reason: 'Out of scope for the first pass (spec Frontloaded Decision #3): a different write path, same pattern. Tracked follow-up owned by the class-closure escalator gap machinery (max-age escalation applies) — a semantically-durable leak path may not park undated.',
    benchAxis: 'exempt',
  },
  {
    component: 'vector-index-eval-artifacts',
    store: 'caches / vector indexes / eval artifacts',
    path: 'src/memory (embedding + eval artifact write paths)',
    scrubStatus: 'exempt',
    reason: 'Enumerated as a tracked follow-up (spec §3 scope boundary) under the class-closure gap machinery so it carries the max-age escalation — a semantically-durable leak path cannot park as an undated TODO. Not silently omitted.',
    benchAxis: 'exempt',
  },
];

/** Chokepoints whose writer-side scrub is wired (the class is guarded here). */
export function wiredChokepoints(): DurableOutputChokepoint[] {
  return DURABLE_OUTPUT_CHOKEPOINTS.filter((c) => c.scrubStatus === 'wired');
}

/** Chokepoints still awaiting the scrub (Close the Loop — each has an owner). */
export function pendingChokepoints(): DurableOutputChokepoint[] {
  return DURABLE_OUTPUT_CHOKEPOINTS.filter((c) => c.scrubStatus === 'pending');
}
