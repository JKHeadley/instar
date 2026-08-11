/**
 * invisible-payload.ts — the single definition of "this message has nothing a human can see".
 *
 * Extracted 2026-08-09 because review pass 9 found the regression test had its OWN copy of the
 * predicate: deleting the guard from the route would have left the test green. A test that cannot
 * fail when the thing it guards is removed is the *alive-but-inert* shape in test form — it reports
 * identically whether or not the protection exists. One definition, imported by both.
 *
 * The rule itself is Unicode's, not a hand-written list. An earlier version enumerated five code
 * points and pass 8 immediately produced five more it missed (U+200E, U+2061, U+FE0F, U+00AD,
 * U+180E), so "invisible payloads are refused" was true of the incident and false as a claim.
 * `Default_Ignorable_Code_Point` is the standard's own category for characters that render as
 * nothing; `Cf` is format controls.
 *
 * Earned from a live incident: a peer agent's relay accepted a send whose entire body was one
 * ZERO-WIDTH SPACE, failed with a 500 carrying an EMPTY error body, burned nine retries across
 * 4h17m, and emitted a user-facing "I had a reply for you but couldn't deliver it" notice. There
 * was no reply.
 *
 * **What this does NOT decide:** whether a visible message is *worth* sending. It answers exactly
 * one question — is there anything here a reader could see — and a message consisting of a single
 * full stop passes, correctly.
 */

/**
 * CONTENT is defined POSITIVELY: a letter, a number, punctuation, or a symbol.
 *
 * ── Why positive, after a round-6 convergence finding proved the subtractive version wrong ──────
 * The original predicate SUBTRACTED a list of invisible classes (whitespace + Default_Ignorable + Cf)
 * and treated everything remaining as visible. That is an OPEN WORLD, and an open world cannot be
 * complete: an external reviewer named the gap and execution confirmed it — a payload consisting only
 * of a C0 control (U+0001, U+0007, U+001B), an unassigned code point (U+0378), a private-use code
 * point (U+E000), a noncharacter (U+FFFE), a lone combining mark (U+0301), or a lone surrogate
 * (U+D800) ALL PASSED as "visible" and would have been delivered. Every one renders as nothing or as
 * tofu — the exact harm of the incident this guard exists for, on a wider input surface.
 *
 * Subtracting the invisible is the same mistake as enumerating the senders: you can only ever remove
 * the shapes you thought of. Naming what COUNTS closes the world — anything not named is not content,
 * including whatever Unicode adds next.
 *
 * `L` letters, `N` numbers, `P` punctuation (so a lone full stop is a legitimate message, as it always
 * was), `S` symbols (so emoji count).
 *
 * **ALL marks (`M`) are content, and the road here is worth recording because I was wrong twice.**
 * The first version excluded every mark. Review pass 30 proved that over-refuses real text and I admitted
 * `Mc`/`Me`, justifying the split by ADVANCE WIDTH — spacing and enclosing marks occupy width, nonspacing
 * marks do not.
 *
 * **That justification was false, and review pass 31 refuted it by measurement.** I re-measured on this
 * host rather than concede on assertion: at 40pt, `Mn` U+20D0 COMBINING LEFT HARPOON ABOVE advances
 * **18.400** and `Mn` U+0301 COMBINING ACUTE advances **15.078**. Nonspacing marks are NOT zero-advance,
 * so General Category was never an advance-width predicate — it was a plausible story fitted to two
 * examples. (I do not reproduce the reviewer's `Me` = 0.000 figure; mine measures 42.695. That
 * discrepancy is beside the point — the half that refutes MY claim reproduces.)
 *
 * So the split is gone rather than re-justified. Unicode classes `M` as GRAPHIC; a mark renders, on its
 * base or on a dotted-circle placeholder. Admitting all of `M` is also the SAFE direction: this guard
 * exists to stop invisible sends, and every over-refusal it makes destroys a real message.
 *
 * `L` letters, `N` numbers, `P` punctuation (so a lone full stop is a legitimate message, as it always
 * was), `S` symbols (so emoji count), `M` marks. Deliberately NOT content: separators (`Z`) and every
 * control/format/unassigned/private-use/surrogate category (`C`).
 */
const CONTENT_RE = /[\p{L}\p{N}\p{P}\p{S}\p{M}]/u;
/**
 * ...EXCEPT code points Unicode itself classes as rendering to nothing.
 *
 * Admitting all of `M` was caught within one test run by the fixtures already in this file: U+FE0F
 * VARIATION SELECTOR-16 is `Mn` and renders NOTHING — it modifies a neighbour's presentation. Widening
 * by category alone would have re-opened the original hole through a side door.
 *
 * `Default_Ignorable_Code_Point` is the standard's own answer to "renders as nothing", so the rule is:
 * a letter, number, punctuation mark, symbol or mark is content UNLESS the standard says it is
 * ignorable. One principled subtraction from a positive base, not a hand-list of exceptions.
 */
const IGNORABLE_RE = /\p{Default_Ignorable_Code_Point}/u;

/**
 * Code points that are CATEGORY-POSITIVE but render BLANK — the positive predicate's own false positives.
 *
 * Found at convergence round 10, and confirmed by execution: each of these is a letter (`Lo`) or a symbol
 * (`So`) by General_Category, so `CONTENT_RE` accepted it, and each renders as empty space in ordinary
 * clients. A message of one HANGUL FILLER is the incident all over again, wearing a letter's category.
 *
 * **Honest about what this is.** The positive definition closed the open world of non-printing CATEGORIES;
 * this is a small subtraction from inside the positive set, and a subtraction has a tail — a future
 * category-positive blank code point would pass until it is added here. That residual is accepted
 * deliberately and stated in the spec rather than papered over: the structural fix is the vendored,
 * generated table (CMT-1246), which derives blankness rather than listing it. Fixtures pin every member.
 */
const BLANK_GLYPHS = new Set([
  'ㅤ',  // HANGUL FILLER (Lo)
  'ᅟ',  // HANGUL CHOSEONG FILLER (Lo)
  'ᅠ',  // HANGUL JUNGSEONG FILLER (Lo)
  'ﾠ',  // HALFWIDTH HANGUL FILLER (Lo)
  '⠀',  // BRAILLE PATTERN BLANK (So)
]);

/**
 * True when `text` carries nothing a reader could receive as content. Callers refuse such a payload
 * rather than sending it.
 *
 * The name is kept for its callers and its history; the precise claim is the MECHANICALLY-VISIBLE one:
 * the string contains at least one letter, number, punctuation mark, or symbol.
 */
export function hasNoVisibleCharacters(text: string): boolean {
  for (const ch of text) {
    if (CONTENT_RE.test(ch) && !IGNORABLE_RE.test(ch) && !BLANK_GLYPHS.has(ch)) return false;
  }
  return true;
}

/**
 * The Telegram API methods whose `text` parameter IS the body a reader reads.
 *
 * DERIVED, not asserted (2026-08-10, window 12). Every `apiCall('<method>')` in `src/` was
 * enumerated and each method inspected for a reader-visible `text` param. `sendMessage` and
 * `editMessageText` carry one; `answerCallbackQuery` also carries `text`, and is deliberately
 * EXCLUDED — it renders a transient toast, and an empty one legitimately just dismisses the
 * spinner, so refusing it would be an over-refusal rather than a protection.
 */
export const READER_VISIBLE_TELEGRAM_PARAMS: Readonly<Record<string, string>> = {
  sendMessage: 'text',
  editMessageText: 'text',
  // Swept in 2026-08-10 after a second-pass reviewer pointed out the same class on a different
  // PARAM. A forum topic's `name` is as reader-visible as a message body, and an invisibly-titled
  // topic is worse than an invisible message — it persists in the topic list, unfindable. The two
  // routes that create topics validate `name.trim().length >= 1`, and `trim()` does NOT remove
  // zero-width characters (they are format controls, not whitespace), so a name of two ZERO WIDTH
  // SPACEs measures length 2 and passes. Verified by execution, not by reading the spec.
  //
  // Including these is the PATTERN swept rather than the case fixed — the failure this branch
  // recorded three times is closing the instance in front of you and leaving its siblings open.
  createForumTopic: 'name',
  editForumTopic: 'name',
};

/** The method names alone, derived from the map above so the two can never disagree. */
export const BODY_CARRYING_TELEGRAM_METHODS: ReadonlySet<string> = new Set(
  Object.keys(READER_VISIBLE_TELEGRAM_PARAMS),
);

/**
 * Telegram methods deliberately classified as carrying NO reader-visible field.
 *
 * Added 2026-08-10 on a round-3 convergence finding, and it closes the last version of this window's
 * defining hole. Before it, the classification was open-world: a method in the map was guarded, and
 * EVERYTHING ELSE was silently unguarded — so a future `sendPhoto` with a caption, or a `sendPoll` with a
 * question, would join the codebase completely unclassified and no check would say a word. Unclassified
 * members silently escaping a population is the exact shape that has produced this branch's every repeat
 * failure.
 *
 * With both lists present the world is CLOSED: every Telegram method a sender calls is either guarded or
 * explicitly declared bodyless, and `scripts/lint-telegram-send-funnel-guarded.mjs` FAILS on anything in
 * neither list — "review required", not "assumed safe".
 *
 * Each entry is a claim that the method shows a reader nothing they could be deprived of:
 *   answerCallbackQuery      a transient toast; an empty one legitimately dismisses the spinner
 *   sendChatAction           the "typing…" indicator; no text at all
 *   getUpdates/getMe/getFile/getChat/getChatMember   reads; nothing outbound
 *   deleteWebhook/deleteMessage                      removals; no body
 *   closeForumTopic/reopenForumTopic/pinChatMessage/unpinAllForumTopicMessages
 *                            topic + message state changes; they carry ids, not prose
 */
export const NO_READER_VISIBLE_FIELD_TELEGRAM_METHODS: ReadonlySet<string> = new Set([
  'answerCallbackQuery',
  'sendChatAction',
  'getUpdates',
  'getMe',
  'getFile',
  'getChat',
  'getChatMember',
  'deleteWebhook',
  'deleteMessage',
  'closeForumTopic',
  'reopenForumTopic',
  'pinChatMessage',
  'unpinAllForumTopicMessages',
]);

/**
 * The refusal, at the funnel. Both Telegram senders (`TelegramAdapter` and `TelegramLifeline`)
 * call this as the FIRST statement of their private `apiCall`, which is the only place every send
 * provably passes through — enforced by `scripts/lint-telegram-send-funnel-guarded.mjs`.
 *
 * ── Why here and nowhere else ──────────────────────────────────────────────────────────────────
 * This guard was placed on one HTTP route at review pass 9 and called "fixed at the point of
 * sending"; pass 27 falsified that with a second route; it was moved to a second door and called
 * "both doors"; pass 28 falsified THAT with a third. It was then moved into `sendToTopic` and
 * called "the single chokepoint every Telegram send passes through" — and pass 29 falsified that
 * by execution, because `send()` (the interface method a router calls) reaches the API without
 * touching `sendToTopic` at all. FOUR enumerations, four over-claims, one habit: asserting the
 * shape of a set instead of deriving it.
 *
 * The derived population is 16 `apiCall('sendMessage')` sites across TWO classes — 14 in the
 * adapter across 9 methods, 2 in the lifeline, which has its own private funnel and had no guard
 * whatsoever. The refusal in `sendToTopic` was REMOVED when this was added rather than kept as a
 * belt-and-braces second copy: pass 23 established that two pieces of code closing the same case
 * MASK each other's tests — break either alone and nothing reds. One way it works, one way to
 * break it.
 *
 * Throwing is the established contract of both funnels (each already throws on a non-ok response),
 * and a caller that swallows the error drops an invisible message, which is the correct outcome —
 * the incident this exists for was a "reply lost" escalation raised for content that never existed.
 */
/** The structured record of one refusal. Carried ON the error so any catcher can log it too. */
export interface InvisiblePayloadRefusal {
  guard: 'invisible-payload';
  outcome: 'refused';
  method: string;
  field: string;
  /** WHY it was refused, in the predicate's own terms — never the payload itself. */
  rule: 'no-content-codepoint';
  /** Length only. The payload is invisible, but it is still user content and is never logged. */
  valueLength: number;
  /** The predicate is engine-resolved, so the engine is part of the decision (see multi-machine posture). */
  engine: string;
  unicode: string;
}

/** Error type carrying the structured decision, so a caller that catches can record it as well. */
export class InvisiblePayloadRefusedError extends Error {
  readonly decision: InvisiblePayloadRefusal;
  constructor(message: string, decision: InvisiblePayloadRefusal) {
    super(message);
    this.name = 'InvisiblePayloadRefusedError';
    this.decision = decision;
  }
}

/**
 * Where refusal decisions are emitted. Defaults to one structured line on stderr.
 *
 * `docs/signal-vs-authority.md` is explicit: *"Authorities must log their decisions in a structured form:
 * which signals they received, what the conversation context was, which rule they applied, and what the
 * outcome was. This is how over-blocks and under-blocks become detectable instead of just frustrating."*
 * This guard IS blocking authority, and it logged nothing — raised at convergence round 4, not acted on,
 * and raised again at round 11. Seeing a finding and not acting on it is worse than not seeing it.
 *
 * A console sink rather than a file sink deliberately: this function is called from CLI commands and setup
 * wizards as well as the server, and a shared pure module that opens a log file on a CLI path would be a
 * worse defect than the one it fixes. Injectable so a host with a real audit trail can route it there.
 */
let refusalSink: (decision: InvisiblePayloadRefusal) => void = (decision) => {
  console.warn(`[invisible-payload] ${JSON.stringify(decision)}`);
};

/** Route refusal decisions to a host-provided audit trail. Returns the previous sink. */
export function setInvisiblePayloadRefusalSink(
  sink: (decision: InvisiblePayloadRefusal) => void,
): (decision: InvisiblePayloadRefusal) => void {
  const previous = refusalSink;
  refusalSink = sink;
  return previous;
}

export function assertTelegramPayloadVisible(method: string, params: Record<string, unknown>): void {
  const field = READER_VISIBLE_TELEGRAM_PARAMS[method];
  if (field === undefined) return;
  const value = params?.[field];
  if (typeof value !== 'string') return;
  if (!hasNoVisibleCharacters(value)) return;

  const decision: InvisiblePayloadRefusal = {
    guard: 'invisible-payload',
    outcome: 'refused',
    method,
    field,
    rule: 'no-content-codepoint',
    valueLength: value.length,
    engine: process.version,
    unicode: process.versions.unicode ?? 'unknown',
  };
  // The decision is recorded BEFORE the throw, so a caller that swallows the error cannot also
  // swallow the record — which is the whole point of the requirement.
  try {
    refusalSink(decision);
  } catch {
    // A broken sink must never convert a refusal into a delivery.
  }
  throw new InvisiblePayloadRefusedError(
    `refused: ${method} ${field} contains no visible characters (only whitespace and/or zero-width `
    + 'marks). An invisible message cannot inform a reader, and delivering it would produce a '
    + '"reply lost" escalation for content that never existed.',
    decision,
  );
}
