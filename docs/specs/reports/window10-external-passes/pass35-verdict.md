## FINDINGS

1. **DESIGN — The Adapter’s “plain” retry is formatted and refused again.**  
   Both outer catches retry with the original `params`, without `_isPlainRetry` ([TelegramAdapter.ts:1418](</Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/src/messaging/TelegramAdapter.ts:1418>), [TelegramAdapter.ts:1436](</Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/src/messaging/TelegramAdapter.ts:1436>)). `applyTelegramFormatter` skips formatting only when `_isPlainRetry` is true; otherwise it defaults to Markdown conversion ([TelegramAdapter.ts:5860](</Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/src/messaging/TelegramAdapter.ts:5860>), [TelegramAdapter.ts:5872](</Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/src/messaging/TelegramAdapter.ts:5872>), [TelegramAdapter.ts:5878](</Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/src/messaging/TelegramAdapter.ts:5878>)). Therefore every post-format refusal in these branches re-enters the same transformation and guard instead of reaching the visible plain representation. The focused run emitted two structured post-format refusal records for each of the two relevant tests, reopening the “one operation, one record” invariant. Those tests assert rejection and zero fetch, but not decision count ([telegram-send-funnel-invisible-payload.test.ts:462](</Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/tests/unit/telegram-send-funnel-invisible-payload.test.ts:462>)); the count assertion covers only a pre-format refusal ([same test:417](</Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/tests/unit/telegram-send-funnel-invisible-payload.test.ts:417>)). The separate `send()` entry point does not attempt this recovery at all unless the error text contains `(400)` ([TelegramAdapter.ts:1271](</Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/src/messaging/TelegramAdapter.ts:1271>)).

2. **DESIGN — Lifeline never implements the new decided/undecidable fallback.**  
   `TelegramLifeline.sendToTopic` treats every `InvisiblePayloadRefusedError`, including the post-format rule, as terminal and returns before its no-parse-mode retry ([TelegramLifeline.ts:2863](</Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/src/lifeline/TelegramLifeline.ts:2863>), [TelegramLifeline.ts:2870](</Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/src/lifeline/TelegramLifeline.ts:2870>)). Thus a representation judged invisible after formatting cannot fall through to the raw, potentially visible form on this funnel. This path lies outside the claimed repair.

3. **DESIGN — Decode-before-strip does not model HTML parsing and creates over-refusals.**  
   The logic decodes entities over the whole source and then removes every tag-shaped substring ([invisible-payload.ts:282](</Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/src/messaging/invisible-payload.ts:282>), [invisible-payload.ts:299](</Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/src/messaging/invisible-payload.ts:299>)). It consequently cannot distinguish source markup from entity-decoded text. An HTML text node containing encoded angle brackets that become tag-shaped, accompanied only by invisible text, loses its visible literal punctuation and is classified as a non-empty invisible extraction. It is refused even though those encoded brackets are reader text. Additionally, the decoder treats `zwnj`, `zwj`, `nbsp`, `shy`, and `apos` as accepted named entities ([invisible-payload.ts:283](</Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/src/messaging/invisible-payload.ts:283>)); ordinary Bot API HTML supports only `lt`, `gt`, `amp`, and `quot` as named entities. Unsupported zero-width entity spellings are therefore refused before Telegram can reject the parse and invoke a plain fallback. [Telegram’s Bot API formatting rules](https://core.telegram.org/bots/api#html-style) support this distinction.

4. **DESIGN — Markdown delimiters are removed by character class, not by Telegram grammar.**  
   `readerVisibleText` deletes every `*`, `_`, `~`, and backtick regardless of whether it participates in a valid entity ([invisible-payload.ts:301](</Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/src/messaging/invisible-payload.ts:301>)). In legacy `Markdown`, `~` is not a strikethrough delimiter—Telegram explicitly says that mode has no strikethrough. Payload shapes whose visible content is such literal punctuation plus invisible text are therefore refused although readers would see the punctuation. Unpaired or malformed delimiter shapes have the same unmodelled parse/fallback boundary. The test exercises only paired emphasis ([telegram-send-funnel-invisible-payload.test.ts:506](</Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/tests/unit/telegram-send-funnel-invisible-payload.test.ts:506>)).

5. **PRECISION — The repaired post-format lint does not prove its output-flow claim.**  
   A file is deemed to format based on a raw textual occurrence of the formatter name, and post-guarded when any bare call with the guard’s name exists anywhere in the file ([lint-telegram-send-funnel-guarded.mjs:244](</Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/scripts/lint-telegram-send-funnel-guarded.mjs:244>), [lint-telegram-send-funnel-guarded.mjs:252](</Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/scripts/lint-telegram-send-funnel-guarded.mjs:252>)). It does not establish that the call is dominated by the formatter, occurs in the fetch funnel, or receives the formatter’s `outgoingParams`. These unexamined paths contradict the lint’s claims that the sender checks “what the transform produced” and that all formatter users invoke the post-guard ([lint:336](</Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/scripts/lint-telegram-send-funnel-guarded.mjs:336>), [lint:359](</Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/scripts/lint-telegram-send-funnel-guarded.mjs:359>)).

6. **DESIGN — The known import/callee-resolution claim remains false.**  
   The lint independently detects an import and any bare call bearing the expected spelling ([lint-telegram-send-funnel-guarded.mjs:193](</Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/scripts/lint-telegram-send-funnel-guarded.mjs:193>), [lint:210](</Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/scripts/lint-telegram-send-funnel-guarded.mjs:210>), [lint:250](</Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/scripts/lint-telegram-send-funnel-guarded.mjs:250>)). It performs no lexical binding resolution. An unused genuine import plus a shadowing local binding and bare call satisfies both predicates. The comment’s claim that the two checks together establish a call to the imported function ([lint:202](</Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/scripts/lint-telegram-send-funnel-guarded.mjs:202>)) is unsupported. The post-guard arm is weaker still: it does not require an import.

7. **DESIGN — Method classification remains limited to literal direct-call shapes.**  
   `callsIn` records only string-literal and no-substitution-template arguments ([lint-telegram-send-funnel-guarded.mjs:170](</Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/scripts/lint-telegram-send-funnel-guarded.mjs:170>)); classification consumes only those values and literal URL matches ([lint:295](</Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/scripts/lint-telegram-send-funnel-guarded.mjs:295>), [lint:301](</Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/scripts/lint-telegram-send-funnel-guarded.mjs:301>)). A method supplied through a variable, enum member, concatenation, interpolated expression, or wrapper is not presented to `KNOWN`, so it cannot become “review required.” This independently confirms the second stated-open defect.

## REGRESSION-CHECK

The focused command passed all **135/135 tests** across the three requested files. `npm run lint` also passed and reported 89 registry articles, seven fingerprinted/swept enforcement gaps, six Telegram body senders, and two formatter users.

Those green checks do not establish the repaired behavior:

- The new Adapter fallthrough is not plain and records the same refusal twice.
- Lifeline never falls through on a post-format refusal.
- Entity decoding interacts with tag stripping: decoded visible text can be mistaken for markup.
- Markdown delimiter consumption rejects characters that legacy Markdown displays literally.
- Pure-markup empty extraction is unconditionally allowed at [invisible-payload.ts:345](</Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/src/messaging/invisible-payload.ts:345>). Locally I can prove that the guard relinquishes its no-invisible-send guarantee; without a live Telegram transaction I cannot prove which accepted pure-markup shapes actually produce a reader-empty message, so I did not count that downstream uncertainty separately.

Two repair interactions are present:

1. Pass 34’s nonterminal post-format decision reopens pass 30’s duplicate-observability defect because the retry traverses the same formatter and guard.
2. The new entity decoder, combined with the existing tag regex, converts encoded reader text into syntax and then deletes it.

I attempted the unrestricted Vitest run. It encountered environment failures—denied `sysctl`, filesystem writes outside the sandbox, local socket binding failures, `tmux` denial, and nested cache writes—then stalled and was stopped with exit 130. Those are not attributed to the frozen tree. The requested focused tests completed cleanly.

The mutating coverage measurer was **not run**. Coverage was assessed from the guard paths and tests, as permitted.

## FRESH-ATTACK-REPORT

I attacked four boundaries independently of the supplied repair account:

- Exception transitions from post-guard through both outer catch sites.
- Representation changes across source, formatter output, retry input, and Telegram parsing.
- The lint’s binding, dominance, argument-flow, and method-propagation obligations.
- Test negative space: especially decision-count assertions and Lifeline parity.

That produced five findings beyond merely reconfirming the two disclosed open defects: the Adapter retry loop, Lifeline terminal behavior, HTML semantic-order error, Markdown grammar error, and unsupported post-guard dataflow claim.

No bypass implementation or constructed attack file was written.

## MY-ACCOUNT-CHECK

The supplied account is materially false in four places:

- “Plain-text fallback” is false in the Adapter because the retry is formatted again.
- The decided/undecidable behavioral repair does not cover Lifeline.
- “Decode what Telegram decodes” is false for named HTML entities and for the semantic order of tag recognition versus entity decoding.
- The new lint knows that a formatter and post-guard name occur in a file, but does not know that the formatter output is guarded.

Both confirmed-open items are accurately disclosed and remain open.

The provenance claim did not match the workspace presented to me: its HEAD was `455c23dbf`, not `e4c7c1cdc`, and it already contained untracked `data/`. The only committed difference from the named revision was the added pass-35 question document. I therefore reviewed an isolated checkout at exact commit `e4c7c1cdcbb798aa72fdd7279fb6e32a931d9c36`.

No tracked file was mutated. Test-created database/key artifacts in the isolated checkout were removed, and that checkout finished clean. The supplied worktree remains unchanged with its pre-existing `data/`.

## MAGNITUDE-METRIC

**7 load-bearing findings: 6 DESIGN, 1 PRECISION.**

Excluded beside that number:

- Sandbox-caused unrestricted-suite failures.
- The supplied worktree’s commit mismatch and pre-existing `data/`.
- The intentionally allowed pure-markup case as a separate defect, because successful reader-empty delivery was not locally established.
- Separate counts for the two Adapter catch sites, `send()`, or each duplicate refusal.
- Separate counts for individual entity and Markdown delimiter shapes.
- Separate counts for the post-lint’s missing import, ordering, and argument-flow checks.
- The seven already registered enforcement-gap records and 89 registry articles.
- Coverage ratios, because the mutating measurer was not run.

## TRAJECTORY

Using the archive’s load-bearing metric:

`1 → 4 → 7 → 6 → 6 → 5 → 4 → [pass 32 aborted] → 5 → 5 → 7`

The prior series is recorded at [pass34-verdict.md:115](</Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/docs/specs/reports/window10-external-passes/pass34-verdict.md:115>). Pass 35 rises from five to seven: repaired instances were replaced by retry-state, semantic-order, and assurance defects while both known structural gaps remained.

## CONVERGENCE

Not converged.

The exact focused reproductions are green, but they do not cover the newly introduced transition semantics. The implementation still lacks a Telegram-equivalent rendering decision, a functioning plain fallback on both funnels, binding/dataflow-aware funnel assurance, and closed method propagation. The same repairs also conflict with earlier observability invariants.

## COHERENCE

The tree is locally executable but not logically coherent:

- Comments call the second Adapter attempt plain while the formatter’s control flag is absent.
- Tests expect rejection for the very post-format cases whose comments say should fall through to a visible representation.
- The one-record invariant is asserted only for pre-format refusal while focused execution reveals duplicate post-format records.
- “Empty extraction means no text nodes” ([invisible-payload.ts:331](</Users/justin_instar_1/.instar/agents/echo/.worktrees/guard-effectiveness-observability/src/messaging/invisible-payload.ts:331>)) is false after global entity decoding can manufacture tag-shaped text.
- The lint prints a dataflow conclusion derived only from file-wide name occurrence.

## VERDICT

**UNSOUND.**

The last repairs do not merely leave the two acknowledged gaps open. They introduce over-refusal through inaccurate HTML and Markdown rendering models, fail to supply the promised plain fallback on either funnel, reopen duplicate refusal observability, and strengthen lint claims without strengthening the analysis enough to support them.

---

## Disposition, written 2026-08-11 03:57 PDT

**7 findings. 4 were introduced by the pass-34 repairs.** The count across the last four readings ran
5, 5, 4, 7 — it went UP after a round of repairs, which is the signal that mattered more than any single
finding. Findings 3 and 4 were both over-refusals in code I had added one reading earlier to close an
under-refusal. I was building a Telegram renderer out of regexes, and each round it produced roughly two
new errors for every one it removed.

The repair is a RETREAT, not a seventh pattern:

- **F3, F4 — closed by removal.** Character-reference decoding and the emphasis-delimiter character class
  are deleted. What remains are the two transforms true of Telegram's rendering without qualification:
  an HTML tag is markup, and a Markdown link displays its label. The under-refusals this reopens
  (`&#8203;`, `*​*`) are now DOCUMENTED in the source, PINNED by tests that assert the allow, and
  tracked as CMT-1260. Between an over-refusal that destroys a real message and an under-refusal that
  delivers an unreadable one, this file takes the recoverable error and says which one it took.
- **F1 — closed and measured.** Both adapter catches now treat every invisible-payload rule as terminal.
  The retry they guarded re-entered the formatter without `_isPlainRetry`, so it re-derived the same
  refusal: measured 2 decision records for one operation before, 1 after.
- **F2 — closed by design consistency.** The lifeline was already terminal. The fallback the adapter
  claimed did not exist on either funnel; rather than build it, the claim is withdrawn and both funnels
  now agree.
- **F5, F6 — claims corrected, analysis unchanged.** The lint finds a bare call bearing a name in a file.
  It does not prove the call resolves to the import, is dominated by the formatter, or receives its
  output. A comment asserting otherwise has now been wrong across two readings — corrected before the
  analysis was, which is its own lesson and is recorded in the source.
- **F7 — confirmed open.** Method classification reads only literal direct-call shapes.

F6 and F7 are answered by the shared-client consolidation (CMT-1246), which ends the class rather than
adding a seventh pattern to it.
