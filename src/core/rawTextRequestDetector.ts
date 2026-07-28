/**
 * WS5.2 (ws52-operator-tap-not-text Part C arm 2) — runtime detector: is THIS
 * outbound message asking the OPERATOR to paste raw/technical text?
 *
 * Per FD6 + the lessons/adversarial reviewers, this is SIGNAL-ONLY: the detector
 * emits a signal; it does NOT independently block (asking-for-JSON is not
 * irreversible, so the signal-vs-authority "safety guard" block exception does not
 * apply — a standalone keyword blocker on a user-visible channel would wedge real
 * conversations). The primary enforcement is arm 1 (the build-time gate) + the
 * structural fact that the only operator path is the one-tap card; this is the
 * backstop that catches the obvious regression ("paste this JSON").
 *
 * HIGH-PRECISION by design: it fires only on an IMPERATIVE directed at the operator
 * paired with a technical object — "paste this JSON", "copy the authorities", "fill
 * in your fingerprint", "run this curl". It deliberately does NOT fire on the agent
 * EXPLAINING or QUOTING (the adversarial reviewer's false-positive concern), and it
 * accepts that paraphrase evades it (false negatives are fine for a backstop —
 * arm 1 + the card are the real teeth).
 *
 * Pure + unit-testable.
 */

export interface RawTextRequestSignal {
  detected: boolean;
  reasons: string[];
}

// Imperative verb directed at the operator + a short span + a technical object.
const IMPERATIVE_RAW_INPUT =
  /\b(?:paste|copy|enter|fill in|type)\b[^.\n]{0,30}\b(?:this|the following|your|the)\b[^.\n]{0,25}\b(?:json|fingerprint|authorities|bearer token|base64|blob)\b/i;

// "run this curl / the following command" — a CLI instruction to the operator.
const IMPERATIVE_RUN_COMMAND =
  /\brun\b[^.\n]{0,25}\b(?:this|the following)\b[^.\n]{0,20}\b(?:curl|command|script)\b/i;

// Phrasings like "paste the JSON below" / "copy the block below".
const PASTE_BELOW =
  /\b(?:paste|copy)\b[^.\n]{0,25}\b(?:json|authorities|block|fingerprint)\b[^.\n]{0,20}\b(?:below|here|into)\b/i;

export function detectRawTextRequestToOperator(text: string): RawTextRequestSignal {
  const t = String(text ?? '');
  const reasons: string[] = [];
  if (IMPERATIVE_RAW_INPUT.test(t)) {
    reasons.push('asks the operator to paste/enter raw technical text (JSON/fingerprint/token/base64)');
  }
  if (IMPERATIVE_RUN_COMMAND.test(t)) {
    reasons.push('asks the operator to run a CLI command');
  }
  if (PASTE_BELOW.test(t)) {
    reasons.push('asks the operator to paste a technical block');
  }
  return { detected: reasons.length > 0, reasons };
}
