/**
 * apprenticeshipStallGate.worker — the bounded child for the stall-coverage
 * runtime gate's hermetic validation (spec §3.2 Decision 6 / instar#1069:
 * matrix validation never runs on the server event loop).
 *
 * Receives a StallGateValidationInput via workerData, runs the SAME exported
 * validation unit the in-process fallback uses (behavior parity), and posts
 * one structured `{ ok, output | error }` message. Timeout enforcement lives
 * in the parent (ApprenticeshipStallGate.runValidationBounded — a timeout
 * fails CLOSED with a named retryable reason).
 */

import { parentPort, workerData } from 'node:worker_threads';
import {
  runStallGateValidation,
  type StallGateValidationInput,
} from './ApprenticeshipStallGate.js';

if (parentPort) {
  try {
    const output = runStallGateValidation(workerData as StallGateValidationInput);
    parentPort.postMessage({ ok: true, output });
  } catch (err) {
    parentPort.postMessage({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
}
