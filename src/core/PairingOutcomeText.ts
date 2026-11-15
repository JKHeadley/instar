/**
 * Pairing outcome lines (docs/specs/mobile-pairing-outcome-notice.md §3.3–§3.4).
 *
 * One fixed, plain line per pairing link, posted into the conversation that asked for the
 * link. The only variable text is the phone's chosen name / the mint label / the agent name,
 * and each is reduced to a plain alphabet (letters, digits, spaces, apostrophes, hyphens) so a
 * line can carry no link, no domain, no mention and no formatting. The same grammar is
 * exported as `matchesPairingOutcomeLine`, which `system-templates.ts` uses to treat these lines
 * as reviewed system templates (no LLM tone verdict; the credential wall still runs).
 */

/** The in-process automation producer id for pairing outcome lines. */
export const PAIRING_OUTCOME_PRODUCER = 'mobile-pairing-outcome';

export type PairingOutcome =
  | 'paired'
  | 'declined-wrong-codes'
  | 'declined'
  | 'expired'
  | 'interrupted'
  | 'ended'
  | 'not-delivered'
  | 'unknown'
  | 'link-void'
  | 'link-expired';

/** Longest a filtered name may be. */
export const OUTCOME_NAME_MAX = 40;

/**
 * Reduce untrusted text to the outcome-line alphabet: Unicode letters and digits, spaces,
 * apostrophes and hyphens. Everything else (markdown, `.`, `@`, `/`, `:`, bidi and zero-width
 * characters, emoji) is removed; runs of spaces collapse; the result is cut to 40 characters.
 * Returns null when nothing is left.
 */
export function outcomeSafeText(v: unknown, max = OUTCOME_NAME_MAX): string | null {
  if (typeof v !== 'string') return null;
  const kept = v.normalize('NFC').replace(/[^\p{L}\p{N} '’-]/gu, ' ').replace(/’/g, "'");
  const s = kept.replace(/\s+/g, ' ').trim().slice(0, max).trim();
  return /[\p{L}\p{N}]/u.test(s) ? s : null;
}

/** The device fingerprint shape (`ABCD-1234-...`, 4 groups of 4 hex). */
const FP_RE = /^[0-9A-F]{4}(?:-[0-9A-F]{4}){3}$/;

export interface OutcomeLineInput {
  outcome: PairingOutcome;
  /** The phone's chosen name (preferred) — untrusted. */
  deviceName?: string | null;
  /** The mint label — untrusted. */
  label?: string | null;
  /** config.projectName. */
  agent: string;
  /** Device fingerprint, shown on paired lines. */
  fingerprint?: string | null;
}

function phoneSubject(name: string | null): string {
  return name ? `A phone named "${name}"` : 'A phone';
}

const ASK_AGAIN = ' Ask for a new link to try again.';

/** Build the one line for an outcome. Pure; every output matches `matchesPairingOutcomeLine`. */
export function outcomeLine(input: OutcomeLineInput): string {
  const agent = outcomeSafeText(input.agent) ?? 'the agent';
  const name = outcomeSafeText(input.deviceName) ?? outcomeSafeText(input.label);
  const label = outcomeSafeText(input.label);
  const named = label ? ` ("${label}")` : '';
  const subject = phoneSubject(name);
  const fp = input.fingerprint && FP_RE.test(input.fingerprint) ? input.fingerprint : null;
  switch (input.outcome) {
    case 'paired':
      return `${subject} was paired with ${agent}${fp ? ` (key ${fp})` : ''}.`;
    case 'declined-wrong-codes':
      return `${subject} was not paired with ${agent}: the confirmation code was entered wrong too many times.${ASK_AGAIN}`;
    case 'declined':
      return `${subject} was not paired with ${agent}: the request was declined or cancelled.`;
    case 'expired':
      return `${subject} was not paired with ${agent}: nobody approved it in time.${ASK_AGAIN}`;
    case 'interrupted':
      return `${subject} was not paired with ${agent}: ${agent} restarted or moved to another machine while it was waiting.${ASK_AGAIN}`;
    case 'ended':
      return `${subject} used the pairing link for ${agent}, but I did not see it get approved. Check the phone list to be sure.`;
    case 'not-delivered':
      return `A phone tried to pair with ${agent}, but I could not send you the approval message. Open a private chat with ${agent} in Telegram and send it any message, then ask for a new link.`;
    case 'unknown':
      return `I could not tell how the pairing link for ${agent}${named} ended. Check the phone list to be sure.`;
    case 'link-void':
      return `The pairing link for ${agent}${named} stopped working when ${agent} restarted.${ASK_AGAIN}`;
    case 'link-expired':
      return `The pairing link for ${agent}${named} expired without pairing a phone.`;
  }
}

// ── The template grammar (bounded; no `.*`) ─────────────────────────────

const SAFE = `[\\p{L}\\p{N}' -]{1,${OUTCOME_NAME_MAX}}`;
const SUBJECT = `A phone(?: named "${SAFE}")?`;
const AGENT = SAFE;
const NAMED = `(?: \\("${SAFE}"\\))?`;
const ASK = ' Ask for a new link to try again\\.';

const LINE_RES: RegExp[] = [
  `${SUBJECT} was paired with ${AGENT}(?: \\(key [0-9A-F]{4}(?:-[0-9A-F]{4}){3}\\))?\\.`,
  `${SUBJECT} was not paired with ${AGENT}: the confirmation code was entered wrong too many times\\.${ASK}`,
  `${SUBJECT} was not paired with ${AGENT}: the request was declined or cancelled\\.`,
  `${SUBJECT} was not paired with ${AGENT}: nobody approved it in time\\.${ASK}`,
  `${SUBJECT} was not paired with ${AGENT}: ${AGENT} restarted or moved to another machine while it was waiting\\.${ASK}`,
  `${SUBJECT} used the pairing link for ${AGENT}, but I did not see it get approved\\. Check the phone list to be sure\\.`,
  `A phone tried to pair with ${AGENT}, but I could not send you the approval message\\. Open a private chat with ${AGENT} in Telegram and send it any message, then ask for a new link\\.`,
  `I could not tell how the pairing link for ${AGENT}${NAMED} ended\\. Check the phone list to be sure\\.`,
  `The pairing link for ${AGENT}${NAMED} stopped working when ${AGENT} restarted\\.${ASK}`,
  `The pairing link for ${AGENT}${NAMED} expired without pairing a phone\\.`,
].map((src) => new RegExp(`^${src}$`, 'u'));

/** True only for a line `outcomeLine` can produce (the system-template membership check). */
export function matchesPairingOutcomeLine(body: string): boolean {
  if (typeof body !== 'string' || body.length > 400) return false;
  return LINE_RES.some((re) => re.test(body));
}
