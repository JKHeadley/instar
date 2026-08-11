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
 * generated table (CMT-1261 — it was CMT-1246 criterion (d), which shipped without it), which derives blankness rather than listing it. Fixtures pin every member.
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
 * the string contains at least one letter, number, punctuation mark, symbol OR MARK that is not
 * `Default_Ignorable` and not a known blank glyph. (Corrected at review pass 33 finding 5: this
 * sentence still listed only L/N/P/S after marks were admitted — the account of a repair going stale
 * one function below the repair itself.)
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
export const READER_VISIBLE_TELEGRAM_PARAMS: Readonly<Record<string, string | readonly string[]>> = {
  sendMessage: 'text',
  // `editMessageText` also accepts `rich_message`, and a method can carry reader-visible content in
  // MORE THAN ONE field — which this map could not express until review pass 43. Checking only `text`
  // meant an edit carrying its content as `rich_message` returned silently and was sent unexamined.
  //
  // Worth recording how this was nearly missed: I judged `rich_message` a fabricated field because it
  // is absent from the Bot API I know, and only fetching the live documentation showed it was added
  // after my knowledge. Dismissing it would have discarded a real bypass on the strength of stale
  // memory — the same defect as trusting a stale claim, pointed the other way.
  editMessageText: ['text', 'rich_message'],
  // The dedicated rich-message methods. Absent from this table they were REFUSED as unclassified,
  // which was the safe direction but would have broken a legitimate send the moment one was used.
  sendRichMessage: ['text', 'rich_message'],
  sendRichMessageDraft: ['text', 'rich_message'],
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
 * explicitly declared bodyless. That closure is now enforced by `src/messaging/telegram-egress.ts`,
 * which REFUSES a method in neither list — "review required", not "assumed safe".
 *
 * It used to be enforced by `scripts/lint-telegram-send-funnel-guarded.mjs`, which is deleted. Review
 * pass 36 finding 3 caught the gap that left: for one commit the lists existed, this comment claimed
 * they were enforced, and nothing enforced them — an unknown method passed the door undecided.
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
 * The refusal, at the CALLER's representation. This no longer runs in either funnel — the egress door
 * checks the wire payload instead, and the funnel calls were removed as double-cover (pass 36 finding
 * 6 caught this description outliving them). Its one live caller is the tokenless-relay branch in
 * `TelegramAdapter`, whose send never reaches the Telegram host from this process.
 *
 * Historically both senders called this as the FIRST statement of their private `apiCall`, the only place every send
 * provably passes through. That lint is DELETED; `scripts/lint-telegram-egress-boundary.mjs` confines
 * egress to one door instead, and the door itself refuses an unclassified method (pass 37 finding 8:
 * this still named the deleted lint as its enforcer).
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
  rule:
    | 'no-content-codepoint'
    | 'no-content-codepoint-after-format'
    /** The egress door refused a Bot API method nobody has classified (pass 36 finding 3). */
    | 'unclassified-method'
    /** The egress door could not read the request's parameters, so it could not decide (pass 36 finding 1). */
    | 'unreadable-request';
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
/**
 * Record a refusal that did NOT come from the predicate — the egress door's own "I cannot decide"
 * cases. Review pass 37 finding 6: those threw bare errors, so the one refusal class that means
 * "something is here I do not understand" was the only one invisible to the decision stream, while
 * tests and the spec both claimed every refusal is recorded.
 */
export function emitInvisiblePayloadRefusal(decision: InvisiblePayloadRefusal): void {
  try { refusalSink(decision); } catch { /* a broken sink never becomes a delivery */ }
}

export function setInvisiblePayloadRefusalSink(
  sink: (decision: InvisiblePayloadRefusal) => void,
): (decision: InvisiblePayloadRefusal) => void {
  const previous = refusalSink;
  refusalSink = sink;
  return previous;
}

/**
 * What a READER actually receives, given a Telegram parse mode.
 *
 * Review pass 33 finding 1, proven by execution before repair: the guard ran on the PRE-FORMAT source
 * while the formatter then changed the representation. A payload whose only content characters sat in a
 * link DESTINATION passed — `[<zero-width>](https://example.com/x)` — and went on the wire as
 * `<a href="https://example.com/x">\u200b</a>` with `parse_mode: HTML`. Tags stripped, the reader
 * received one zero-width space. The original incident's exact harm, through the one door nobody had
 * looked at, inside the guard built to close that harm.
 *
 * The reasoning that failed is worth naming: "the source contains a visible code point, therefore the
 * reader receives content" does not survive a representation change. Whatever transforms the message
 * last is what decides what a reader sees.
 *
 * This extraction is DELIBERATELY SMALLER than a renderer, and review pass 35 is why. An earlier version
 * grew toward modelling Telegram's two parsers — decoding character references, consuming emphasis
 * delimiters — and every approximation error became an OVER-refusal: `~` is not a delimiter in legacy
 * Markdown, and `zwnj`/`nbsp`/`shy`/`apos` are not entities Telegram's HTML mode resolves, so payloads
 * whose visible content was literal punctuation were being judged empty. An over-refusal destroys a real
 * message. Rather than chase a parser with regexes, this keeps only the two transforms that are true of
 * Telegram's rendering when the markup is VALID — and that qualification is load-bearing, because
 * review pass 36 finding 5 showed the previous sentence ("without qualification") was false:
 *
 *   HTML     — a tag is markup; its attributes are never shown.
 *   Markdown — a link displays its LABEL; the destination is not shown.
 *
 * KNOWN OVER-REFUSAL, named rather than discovered (pass 36 finding 5). The HTML branch strips every
 * TAG-SHAPED substring without establishing that Telegram would accept it as a tag. If a payload
 * carries malformed or unsupported tag-shaped text — which a reader WOULD see, because Telegram
 * rejects the parse and falls back to sending the source — plus one invisible text node, the
 * extraction is non-empty and invisible, so this refuses a message that would have been readable.
 * The refusal is terminal, so that message is lost rather than downgraded.
 *
 * It is not fixed here for the same reason the under-refusals below are not: deciding it requires
 * Telegram's own parse result, and every regex approximation of that parser has produced errors in
 * BOTH directions (passes 34, 35, 36). It rides CMT-1260 with them.
 *
 * KNOWN UNDER-REFUSALS, accepted deliberately. A character reference (`&#8203;`) is counted as its
 * SOURCE characters, so a payload made only of encoded invisibles passes. Emphasis delimiters count as
 * content, so `*\u200b*` passes. Each is a payload that reaches a reader as nothing — the very harm this
 * file exists to prevent — and each is allowed anyway, because refusing them requires a rendering model
 * this code cannot supply, and a wrong model destroys real messages in the other direction. Closing them
 * needs Telegram's own parse result, not a better regex. Tracked as CMT-1260.
 */
export function readerVisibleText(text: string, parseMode?: unknown): string {
  const mode = typeof parseMode === 'string' ? parseMode.toLowerCase() : '';
  if (mode === 'html') {
    return text.replace(/<[^>]*>/g, '');
  }
  if (mode === 'markdown' || mode === 'markdownv2') {
    return text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
  }
  return text;
}

/**
 * The post-format check: what is about to go on the wire must still carry content once rendered.
 *
 * NOTE (review pass 36 finding 6): this WAS a second call beside a pre-format one in both funnels.
 * Those were removed when the egress door landed — execution showed the door refuses every payload
 * they caught, and two copies of one case mask each other's tests. The paragraph below describes the
 * historical pairing and is kept for the reasoning, not as a description of the current call graph.
 * The only surviving pre-format call is the tokenless-relay guard, which the door cannot reach.
 *
 * They close
 * different cases — the first refuses a payload that never had content, the second refuses one whose
 * content stopped being reader-visible when the representation changed — and each is proven to red on
 * its own.
 */
/**
 * Collect the reader-visible TEXT LEAVES of a structured field, per Telegram's actual RichText grammar.
 *
 * THE GRAMMAR, derived from the live type definitions rather than inferred from key names. Four readings
 * repaired this by adding whichever key a reviewer had just named, each time correctly and each time one
 * level too shallow; the operator's instruction was to stop doing that and read the spec. What the spec
 * says:
 *
 *   `richTextPlain`  — the LEAF. Its literal lives in `text` (string).
 *   `richTexts`      — the SEQUENCE. Its parts live in `texts` (array of RichText).
 *   the wrappers     — `richTextBold`, `Italic`, `Underline`, `Strikethrough`, `Fixed`, `Marked`,
 *                      `Subscript`, `Superscript`, `Url`, `EmailAddress`, `PhoneNumber`, `Anchor`,
 *                      `AnchorLink`, `Reference`, `Icon` — each carries its content in `text`, which
 *                      holds a nested RichText rather than a string.
 *
 * So `text` is the single carrier at every level, sometimes a string and sometimes a nested node, and
 * `texts` is the only branching point. That is why the recursive walk below is the grammar rather than an
 * approximation of it: descending objects and arrays while collecting `text` strings visits exactly the
 * literals, at any nesting depth, through any wrapper chain.
 *
 * BLOCK level adds two STRING carriers the inline layer does not have — `name` on a block anchor and
 * `expression` on a mathematical block — plus `html` and `markdown` on the container itself.
 *
 * WHAT IS DELIBERATELY NOT COLLECTED, and why it is not an oversight: `url`, `email_address`,
 * `phone_number`, `anchor_name`, `document`. A link's DESTINATION is not what a reader sees — its label
 * is, and the label is the nested `text`. Counting a destination as content is precisely how the original
 * incident shipped: a payload whose only visible characters lived inside a URL.
 *
 * A structure that yields NO leaves is allowed. That is now a derived conclusion rather than an
 * undecidable shrug: a rich message of media blocks alone — a photo, a collage, a map — legitimately
 * carries no text, and refusing it would destroy a valid message.
 */
function structuredTextLeaves(value: unknown, depth = 0): Array<{ text: string; mode: string }> {
  if (depth > 16 || value === null || typeof value !== 'object') return [];
  const out: Array<{ text: string; mode: string }> = [];
  if (Array.isArray(value)) {
    for (const v of value) out.push(...structuredTextLeaves(v, depth + 1));
    return out;
  }
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (typeof v === 'string') {
      // The KEY names the leaf's format. An `html` leaf is HTML whatever the request's `parse_mode`
      // says — the request-level mode does not govern content nested inside a rich structure.
      if (k === 'html') out.push({ text: v, mode: 'HTML' });
      else if (k === 'markdown') out.push({ text: v, mode: 'Markdown' });
      else if (k === 'text' || k === 'name' || k === 'expression') out.push({ text: v, mode: '' });
    } else if (typeof v === 'object' && v !== null) {
      // `text` holding an object is a wrapper; `texts` is the sequence. Both are descended.
      out.push(...structuredTextLeaves(v, depth + 1));
    }
  }
  return out;
}

/** Every reader-visible field a method may carry. A method can carry more than one (pass 43). */
export function readerVisibleFieldsFor(method: string): readonly string[] {
  const f = READER_VISIBLE_TELEGRAM_PARAMS[method];
  if (f === undefined) return [];
  return typeof f === 'string' ? [f] : f;
}

export function assertOutgoingPayloadVisible(method: string, params: Record<string, unknown>): void {
  for (const field of readerVisibleFieldsFor(method)) {
    assertOneOutgoingField(method, params, field);
  }
}

function assertOneOutgoingField(method: string, params: Record<string, unknown>, field: string): void {
  const raw = params?.[field];

  // A structured field carries its content in leaves, not in the field itself (pass 44). If ANY leaf is
  // visible the payload is visible. If the structure yields NO leaves at all, this cannot decide what a
  // reader receives and allows — the same undecidable line the empty-extraction case takes.
  if (raw !== null && typeof raw === 'object') {
    const leaves = structuredTextLeaves(raw);
    if (leaves.length === 0) return;
    if (leaves.some((leaf) => !hasNoVisibleCharacters(readerVisibleText(leaf.text, leaf.mode)))) return;
    emitInvisiblePayloadRefusal({
      guard: 'invisible-payload',
      outcome: 'refused',
      method,
      field,
      rule: 'no-content-codepoint-after-format',
      valueLength: leaves.reduce((n, l) => n + l.text.length, 0),
      engine: process.version,
      unicode: process.versions.unicode ?? 'unknown',
    });
    throw new InvisiblePayloadRefusedError(
      `refused: ${method} ${field} carries no reader-visible content AFTER formatting (its structured `
      + 'content has text leaves and none of them renders as anything a reader can see).',
      {
        guard: 'invisible-payload',
        outcome: 'refused',
        method,
        field,
        rule: 'no-content-codepoint-after-format',
        valueLength: leaves.reduce((n, l) => n + l.text.length, 0),
        engine: process.version,
        unicode: process.versions.unicode ?? 'unknown',
      },
    );
  }

  const value = raw;
  if (typeof value !== 'string') return;
  const visible = readerVisibleText(value, (params as { parse_mode?: unknown })?.parse_mode);
  if (!hasNoVisibleCharacters(visible)) return;

  // THE UNDECIDABLE CASE, and the line that separates it from the decided one (review pass 34 finding 1).
  //
  // An extraction that is EMPTY means the payload had no text nodes at all — it is pure markup. Such a
  // payload has two possible fates and this code cannot tell which: valid markup renders as nothing (a
  // real invisible send), while MALFORMED markup is rejected by Telegram and falls back to a plain-text
  // send in which the tags are shown to the reader. Deciding between them needs Telegram's own parser.
  //
  // An extraction that is NON-EMPTY but carries no visible character is DECIDED: text nodes exist and
  // they contain nothing a reader can see. That is the pass-33 case — a link whose label is a zero-width
  // space — and it stays refused.
  //
  // Where it cannot decide, it ALLOWS, because this guard's own policy is that an over-refusal destroys a
  // real message. Refusing pure markup outright killed a deliverable one: `<b><i>` renders as visible
  // text after the fallback, and the first version of this check threw before the fallback could run.
  // The honest cost is stated rather than hidden: a payload of VALID markup with no text nodes is not
  // refused by this arm.
  if (visible.length === 0 && value.length > 0) return;

  const decision: InvisiblePayloadRefusal = {
    guard: 'invisible-payload',
    outcome: 'refused',
    method,
    field,
    rule: 'no-content-codepoint-after-format',
    valueLength: value.length,
    engine: process.version,
    unicode: process.versions.unicode ?? 'unknown',
  };
  try { refusalSink(decision); } catch { /* a broken sink never becomes a delivery */ }
  throw new InvisiblePayloadRefusedError(
    `refused: ${method} ${field} carries no reader-visible content AFTER formatting (its content `
    + 'characters survive only inside markup such as a link destination or a tag attribute, which a '
    + 'reader never sees).',
    decision,
  );
}

export function assertTelegramPayloadVisible(method: string, params: Record<string, unknown>): void {
  for (const field of readerVisibleFieldsFor(method)) {
    assertOnePreFormatField(method, params, field);
  }
}

function assertOnePreFormatField(method: string, params: Record<string, unknown>, field: string): void {
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
    `refused: ${method} ${field} contains no visible characters (only whitespace, zero-width or `
    + 'ignorable marks, control/unassigned/private-use code points, or blank glyphs). An invisible '
    + 'message cannot inform a reader, and delivering it would produce a '
    + '"reply lost" escalation for content that never existed.',
    decision,
  );
}
