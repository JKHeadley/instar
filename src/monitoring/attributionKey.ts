/**
 * Attribution-key composition for the burn-detection-and-self-heal system.
 *
 * Format (per docs/specs/token-burn-detection-and-self-heal.md §Attribution
 * key): `<componentName>::<promptFingerprintShort>`, where the fingerprint
 * is the first 8 hex chars of SHA-256 over the first 256 bytes of the
 * prompt. This collapses repeated calls with similar prompts (the bleeding
 * pattern) and distinguishes them from incidental variation.
 *
 * Pure function — no I/O, deterministic, safe to call on every LLM request.
 */

import crypto from 'node:crypto';

const FINGERPRINT_BYTES = 256;
const FINGERPRINT_HEX_LEN = 8;

/**
 * Compose an attribution key from a component name and prompt text.
 *
 * If `component` is empty/missing, returns `unknown::<fingerprint>` so the
 * detector can still group repeats by prompt shape. If the prompt is empty,
 * returns `<component>::nonprompt`.
 */
export function buildAttributionKey(component: string | undefined, prompt: string): string {
  const comp = component && component.length > 0 ? component : 'unknown';
  if (!prompt || prompt.length === 0) return `${comp}::nonprompt`;
  const slice = prompt.slice(0, FINGERPRINT_BYTES);
  const fp = crypto.createHash('sha256').update(slice).digest('hex').slice(0, FINGERPRINT_HEX_LEN);
  return `${comp}::${fp}`;
}
