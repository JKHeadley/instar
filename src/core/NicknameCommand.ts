/**
 * NicknameCommand — pure recognizer for the user's natural-language "move/run this
 * on <machine-nickname>" requests (Multi-Machine Session Pool §L4). The headline
 * test-as-self scenario: the user, mid-conversation, says "move this to the mini"
 * and the session transfers to that machine. Per "Structure > Willpower" this is a
 * deterministic recognizer over the KNOWN nickname set (resolved from the registry),
 * NOT an open-ended LLM intent guess — so it can never invent a target machine.
 *
 * The recognizer is intentionally conservative: it only matches when an explicit
 * relocation verb is present AND the tail resolves to a real, known nickname. A
 * bare mention of a machine name ("the mini is fast") never triggers a transfer.
 */

export interface NicknameCommand {
  /** 'transfer' (move an existing session) vs 'pin' (hard-pin future placement). */
  intent: 'transfer' | 'pin';
  /** The known nickname that was matched (canonical form as registered). */
  nickname: string;
  /** The verb phrase that triggered recognition (for audit/telemetry). */
  matchedVerb: string;
}

// Relocation verbs → intent. "pin" is the only hard-pin verb; the rest are transfers.
const TRANSFER_VERBS = ['move', 'transfer', 'switch', 'migrate', 'send', 'shift', 'hand off', 'handoff', 'run', 'continue', 'resume', 'keep'];
const PIN_VERBS = ['pin', 'lock'];

// A relocation command must contain BOTH a verb and a "to/on/onto/over to" preposition
// before the target, OR an explicit "this/the conversation … on <nick>" shape. We
// anchor on the preposition so "the mini handled that" can't match.
const PREPOSITION = /\b(?:over to|onto|on to|to|on|at)\b/i;

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Recognize a nickname relocation command in free text. Returns null if the text
 * is not an explicit move/pin request OR if the target doesn't resolve to a known
 * nickname. Matching is case-insensitive; when multiple nicknames could match, the
 * LONGEST is chosen (so "mac mini" wins over "mini").
 */
export function recognizeNicknameCommand(text: string, knownNicknames: string[]): NicknameCommand | null {
  if (!text || typeof text !== 'string' || knownNicknames.length === 0) return null;

  // Find the EARLIEST-occurring relocation verb (pin verbs win on a positional tie).
  const allVerbs: Array<{ verb: string; intent: 'transfer' | 'pin' }> = [
    ...PIN_VERBS.map((v) => ({ verb: v, intent: 'pin' as const })),
    ...TRANSFER_VERBS.map((v) => ({ verb: v, intent: 'transfer' as const })),
  ];
  let chosenVerb: { verb: string; intent: 'transfer' | 'pin' } | null = null;
  let chosenIdx = Infinity;
  let verbEnd = -1;
  for (const cand of allVerbs) {
    const m = new RegExp(`\\b${escapeRegExp(cand.verb)}\\b`, 'i').exec(text);
    if (m && m.index < chosenIdx) {
      chosenVerb = cand;
      chosenIdx = m.index;
      verbEnd = m.index + m[0].length;
    }
  }
  if (!chosenVerb) return null;

  // There must be a preposition AFTER the verb (the target follows it).
  const afterVerb = text.slice(verbEnd);
  const prep = PREPOSITION.exec(afterVerb);
  if (!prep) return null;
  const tail = afterVerb.slice(prep.index + prep[0].length);
  const tailLower = tail.toLowerCase();

  // Resolve the target against the KNOWN nickname set (longest match wins).
  const matches = knownNicknames
    .filter((n) => n && typeof n === 'string')
    .filter((n) => {
      const re = new RegExp(`(?:^|\\b|\\s)${escapeRegExp(n.toLowerCase())}(?:$|\\b|\\s|[.!?,])`, 'i');
      return re.test(tailLower);
    })
    .sort((a, b) => b.length - a.length);

  if (matches.length === 0) return null;
  return { intent: chosenVerb.intent, nickname: matches[0], matchedVerb: chosenVerb.verb };
}
