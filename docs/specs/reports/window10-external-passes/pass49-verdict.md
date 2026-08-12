=== VERDICT ===
UNSOUND. The door is structurally central for cloud Bot API egress, but the rich-message formula model still lets source text stand in for rendered content in cases the code itself says may paint nothing. In addition, one structured formula representation never received the new body-content check, and a reader-facing spec companion still describes the superseded pre-door architecture as current/owed.

=== MAGNITUDE ===
3 NEW load-bearing findings: 1 DESIGN, 2 PRECISION. Previously-stated-open items are not counted here.

## FINDINGS

1. DESIGN — Formula SOURCE content is allowed to waive an otherwise invisible rich message, even when the source can render no glyphs.

Evidence: `src/messaging/invisible-payload.ts:602` says formula source characters are not glyphs, and `src/messaging/invisible-payload.ts:652` removes formula regions from the text visibility test. The waiver is then granted solely because the captured formula body has mechanically visible source characters (`src/messaging/invisible-payload.ts:664`-`src/messaging/invisible-payload.ts:668`), which sets `undecidable` and lets `assertOneOutgoingField` return without refusal (`src/messaging/invisible-payload.ts:737`-`src/messaging/invisible-payload.ts:740`). The positive test at `tests/unit/telegram-egress-boundary.test.ts:473`-`tests/unit/telegram-egress-boundary.test.ts:482` pins that behavior with a spacing-only formula class as deliverable.

Failure path: a `sendRichMessage`/`editMessageText` rich-message `markdown` or `html` arm contains no reader-visible non-formula content and contains a formula whose LaTeX source has visible command characters but whose rendered result is blank/spacing-only. The scanner strips the formula from the visible leaf, marks the structure undecidable because the source body has content, and the egress door sends. The reader receives no visible glyph from the non-formula text and no visible glyph from the formula.

2. PRECISION — The "formula body must carry content" repair does not reach explicit structured formula discriminators.

Evidence: inline RichText `mathematical_expression` is classified as unconditionally opaque at `src/messaging/invisible-payload.ts:420`-`src/messaging/invisible-payload.ts:423`, and `richTextScan` returns `OPAQUE` without reading its expression/body at `src/messaging/invisible-payload.ts:522`-`src/messaging/invisible-payload.ts:524`. Block-level `mathematical_expression` is also unconditionally in `BLOCK_OPAQUE` at `src/messaging/invisible-payload.ts:452`-`src/messaging/invisible-payload.ts:463`, and `blockScan` pushes `OPAQUE` before any content validation at `src/messaging/invisible-payload.ts:549`-`src/messaging/invisible-payload.ts:556`. `assertOneOutgoingField` allows any opaque structured scan at `src/messaging/invisible-payload.ts:737`-`src/messaging/invisible-payload.ts:740`.

Failure path: a rich-message `blocks` arm, or a RichText wrapper under a rendered block field, carries only a structured `mathematical_expression` whose own expression/body is absent, empty, or mechanically invisible, plus otherwise invisible leaves. The explicit discriminator is treated as rendering unreadable content without the captured-body test that markdown/html formulas received, so it vouches for a message that renders nothing.

3. PRECISION — The spec companion still presents the deleted per-sender/presence architecture as the active safeguard.

Evidence: the main spec correctly says the old guarantee summary is superseded and that the current structural door is `src/messaging/telegram-egress.ts` (`docs/specs/telegram-egress-invisible-payload-guard.md:50`-`docs/specs/telegram-egress-invisible-payload-guard.md:60`), and later records CMT-1246 as shipped (`docs/specs/telegram-egress-invisible-payload-guard.md:213`-`docs/specs/telegram-egress-invisible-payload-guard.md:237`). But the plain-language companion still says the automatic check works out sender files and fails if any sender is missing the guard (`docs/specs/telegram-egress-invisible-payload-guard.eli16.md:80`-`docs/specs/telegram-egress-invisible-payload-guard.eli16.md:90`), and still says the "one single place a message can leave from" is owed rather than shipped (`docs/specs/telegram-egress-invisible-payload-guard.eli16.md:121`-`docs/specs/telegram-egress-invisible-payload-guard.eli16.md:126`).

Failure path: a future maintainer reading the ELI16 spec can trust the old model: per-sender guard presence plus a still-pending single-door migration. That is false of the code under review. The actual lint proves Bot API egress confinement to the door (`scripts/lint-telegram-egress-boundary.mjs:19`-`scripts/lint-telegram-egress-boundary.mjs:27`, `scripts/lint-telegram-egress-boundary.mjs:253`-`scripts/lint-telegram-egress-boundary.mjs:255`), not per-sender guard presence, and the single door has already shipped.

## REGRESSION-CHECK

Redirect crossing: still open as stated; `methodFromTelegramUrl` classifies only the initial URL and `telegramFetch` ultimately calls native `fetch` with normal redirect-following behavior (`src/messaging/telegram-egress.ts:36`-`src/messaging/telegram-egress.ts:45`, `src/messaging/telegram-egress.ts:435`).

Body encoding from wrapper rather than `Content-Type`: still open as stated; `collectParams` infers JSON/form from the JavaScript body value and never consults headers (`src/messaging/telegram-egress.ts:217`-`src/messaging/telegram-egress.ts:249`).

Duplicated top-level JSON key makes the whole body unreadable before relevance: still true; duplicate detection happens before assigning parsed params and before method-field relevance can narrow it (`src/messaging/telegram-egress.ts:220`-`src/messaging/telegram-egress.ts:231`).

`answerCallbackQuery` and `editForumTopic` classifications: still product judgments; `answerCallbackQuery` remains bodyless by policy and `editForumTopic` remains guarded as `name` (`src/messaging/invisible-payload.ts:117`-`src/messaging/invisible-payload.ts:123`, `src/messaging/invisible-payload.ts:159`-`src/messaging/invisible-payload.ts:160`, `src/messaging/invisible-payload.ts:186`-`src/messaging/invisible-payload.ts:195`).

Local Bot API Server endpoint: still outside runtime and lint recognition; runtime host is hard-coded to `api.telegram.org` and the lint host marker is also the cloud host (`src/messaging/telegram-egress.ts:60`, `src/messaging/telegram-egress.ts:92`-`src/messaging/telegram-egress.ts:93`, `scripts/lint-telegram-egress-boundary.mjs:54`-`scripts/lint-telegram-egress-boundary.mjs:55`).

Multipart claim and single-read claim from pass 47: not re-counted; current code reads iterable `FormData`, freezes it by serializing string entries, and then sends the checked body (`src/messaging/telegram-egress.ts:263`-`src/messaging/telegram-egress.ts:269`, `src/messaging/telegram-egress.ts:314`-`src/messaging/telegram-egress.ts:326`, `src/messaging/telegram-egress.ts:433`-`src/messaging/telegram-egress.ts:435`), while one-shot streams remain refused (`src/messaging/telegram-egress.ts:272`-`src/messaging/telegram-egress.ts:275`).

Structured content only inspected in JSON-body representation: still open as stated; query/form/multipart collection leaves values as strings, so rich structures serialized outside JSON object bodies do not enter `structuredFieldScan` (`src/messaging/telegram-egress.ts:195`-`src/messaging/telegram-egress.ts:210`, `src/messaging/telegram-egress.ts:241`-`src/messaging/telegram-egress.ts:245`, `src/messaging/telegram-egress.ts:263`-`src/messaging/telegram-egress.ts:268`, `src/messaging/invisible-payload.ts:737`-`src/messaging/invisible-payload.ts:770`).

Lint host prefilter literal source text: still open as stated; the lint skips files unless literal source contains `api.telegram.org` (`scripts/lint-telegram-egress-boundary.mjs:145`-`scripts/lint-telegram-egress-boundary.mjs:148`).

No-leaf structures are allowed: still open and not carried far enough. Structures proven to render nothing, such as `anchor`, still produce no leaves and no `undecidable`, then are allowed because `leaves.length === 0` returns (`src/messaging/invisible-payload.ts:423`-`src/messaging/invisible-payload.ts:424`, `src/messaging/invisible-payload.ts:465`-`src/messaging/invisible-payload.ts:466`, `src/messaging/invisible-payload.ts:737`-`src/messaging/invisible-payload.ts:740`). This remains a known/stated design gap, not counted as new.

Deliberately red family-audit assertion: not evaluated as part of this pass and not counted; its stated purpose remains external convergence rather than an expectation to edit.
