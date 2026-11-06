/**
 * The cheap filter in front of the send record and the audit's new-block budget. Spec section 4:
 * it only saves money and it can miss, so it spends nothing, blocks nothing, and its misses are
 * measured by the audit's sample and shown on /attribution/status as an estimate.
 */
const CREDIT_WORD = /\b(said|says|told|tell|rule|rules|asked|asks|agreed|agree|corrected|wants?|prefers?|decided|instruct(?:ed|ion|s)?|authori[sz]ed|approved|standing)\b/i;

export function mightCreditSomeone(text: string, knownPeople: readonly string[]): boolean {
  if (CREDIT_WORD.test(text)) return true;
  const lowered = text.toLowerCase();
  return knownPeople.some((name) => name.length >= 2 && lowered.includes(name.toLowerCase()));
}
