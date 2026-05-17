/**
 * RULE 3.1 RATIONALE
 * Criticality: high
 * Frequency: per-prompt
 * Stability: unstable
 * Fallback: none
 * Verdict: deterministic + canary
 */
import { execFile } from 'node:child_process';
const _captureUse = "capture-pane";