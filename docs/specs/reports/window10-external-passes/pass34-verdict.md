# External review pass 34 — reviewer's verbatim final answer — **UNSOUND, load-bearing 5 (4 DESIGN, 1 PRECISION)**

**Findings 4 and 5 independently confirm the two I had already declared open** — the call-resolves-to-import
gap and literal-only method classification — which is itself useful: they were not taken on my word.

**Its sharpest result is that my own two repairs INTERACTED.** Making a content refusal terminal (pass 30
finding 2) blocked the plain-text fallback that pass 34 finding 1 shows would have made the payload visible.
Neither repair was wrong alone; only a reading that asked about the interaction found it.

Run against `743f3d0a7`. Tree verified clean afterwards. Exploration logs are NOT kept.

---

```text
## FINDINGS

Fresh judgment: **UNSOUND**. I found five load-bearing issues: four DESIGN, one PRECISION.

1. **DESIGN — The post-format checker over-refuses HTML that the existing fallback would make visible.**

   The raw-HTML send path intentionally retries malformed HTML as plain text, explicitly noting that the tags then become visible: `src/messaging/TelegramAdapter.ts:1400-1412`. But `readerVisibleText()` strips every tag-shaped substring before Telegram validates it: `src/messaging/invisible-payload.ts:279-283`. Therefore, for an HTML input containing no text-node content but containing tag syntax that Telegram would reject, the new check throws before the first request. The plain-text recovery path never runs, even though that path would have shown the tag text to the reader.

   This is new blocking behaviour introduced by the repair. It conflicts with the stated guard policy that an over-refusal destroys a message: `src/messaging/invisible-payload.ts:56-58`.

2. **DESIGN — The same checker still under-refuses supported representations because it is not a renderer.**

   The HTML branch removes tags but does not decode character references: `src/messaging/invisible-payload.ts:281-283`. In HTML passthrough mode, the formatter deliberately returns the caller’s HTML unchanged: `src/messaging/TelegramMarkdownFormatter.ts:532-541`. Consequently, a numeric character reference resolving only to a default-ignorable character is counted from its source punctuation and digits, although Telegram renders the decoded invisible character.

   The Markdown branch recognizes only inline links: `src/messaging/invisible-payload.ts:284-286`. Yet legacy-passthrough preserves the caller’s Markdown representation byte-for-byte: `src/messaging/TelegramMarkdownFormatter.ts:497-506`, `src/messaging/TelegramAdapter.ts:5862-5875`. Formatting delimiters outside the link pattern can therefore supply the category-positive source characters while Telegram consumes them as markup.

   The reasoning fails at `src/messaging/invisible-payload.ts:260-277`: “reader actually receives” requires Telegram grammar and decoding, whereas the implementation provides two regular-expression projections.

3. **PRECISION — The new guard is absent from the funnel assurance that purports to protect the send paths.**

   The lint defines its guarded function exclusively as `assertTelegramPayloadVisible`: `scripts/lint-telegram-send-funnel-guarded.mjs:43`. Its call scanner and final assertion likewise only concern that name: `scripts/lint-telegram-send-funnel-guarded.mjs:179-194`, `:218-237`, `:326-329`.

   It never checks `assertOutgoingPayloadVisible`. Removing the post-format call from the Lifeline at `src/lifeline/TelegramLifeline.ts:2914` would leave the lint satisfied because the pre-format call at `:2908` remains. The post-format behavioural tests exercise an Adapter configured for Markdown, not the Lifeline: `tests/unit/telegram-send-funnel-invisible-payload.test.ts:454-500`.

   Thus the repository currently contains both calls, but its claimed cross-funnel enforcement does not prove the newly load-bearing one remains present.

4. **DESIGN — The send-funnel lint does not establish that a call resolves to the imported guard.**

   Calls are reduced to bare callee names at `scripts/lint-telegram-send-funnel-guarded.mjs:143-177`; the matching import is checked independently at `:196-201`. The two facts are combined only as booleans at `:232-236`.

   A same-spelled lexical binding or parameter can therefore satisfy the call check while the imported guard is unused. The explanation at `:188-192` claims name resolution that the analysis does not perform.

5. **DESIGN — Method coverage is closed over direct literal shapes.**

   Method extraction records string-literal arguments only: `scripts/lint-telegram-send-funnel-guarded.mjs:168-170`. Classification then recognizes a literal URL or a literal first argument to known wrapper names: `:271-309`.

   Methods passed through variables, constants, enums, expressions, aliases, or unrecognized wrappers are not classified. At runtime, unrecognized methods return no reader-visible field and therefore receive no content decision: `src/messaging/invisible-payload.ts:125-139`, `:299-305`, `:326-332`.

## REGRESSION-CHECK

I reviewed an isolated export of exact commit `537a1917018e29197f1f8ce5f3f99695e6176a33`.

- `npm run lint`: passed. It reported 89 registry articles, seven fingerprinted enforcement gaps, seven sweeps, and contiguous archived verdict citations.
- Focused guard suites with cache writes disabled: **3 files, 132/132 tests passed**:
  - `telegram-send-funnel-invisible-payload.test.ts`
  - `window10-guards-behaviour.test.ts`
  - `guard-population-parity.test.ts`
- The full suite was attempted, but it was not a valid green signal in this sandbox: denied socket binding, tmux, `sysctl`, external-directory writes, network-dependent operations, and nested Vitest cache writes produced unrelated failures; it was stopped after sustained inactivity. I do not claim a completed full-suite total.
- I did not run the mutating coverage measurer. I reasoned from its target code and tests, as permitted by the brief.
- I wrote no bypass or exploit case.

The isolated review copy is clean after removing test-created SQLite sidecars. No source file was mutated.

The supplied worktree itself was not at the frozen state: its HEAD was `743f3d0a7c622c0b3aa35a44b1c0e27d83da23d4`, with `537a19170` as an ancestor, and it already contained untracked `data/registry.db-shm` and `data/registry.db-wal`. I left that worktree unchanged; the same two files remained on exit.

## FRESH-ATTACK-REPORT

This reading adds three angles unavailable before the post-format repair existed:

- It follows HTML through the pre-request guard and the existing post-400 plain-text recovery path. That reveals a new over-refusal, rather than another invisible-payload under-refusal.
- It checks decoding and legacy-passthrough semantics, not just the default Markdown-to-HTML formatter tested by the repair.
- It treats the new post-format call as a new enforcement population. The established funnel lint and Lifeline tests never enrolled it.

The central new result is that the post-format repair is wrong in both directions: it can block recoverably visible content and still accept source syntax that renders invisibly.

## MY-ACCOUNT-CHECK

The supplied account is partly correct:

- The original default-Markdown link-destination case is repaired. The focused test proves that the formatted anchor is examined.
- The contiguity fixture repair is present and green.
- The predicate description and structured refusal record now describe both stages.
- The two explicitly accepted lint limitations remain exactly as described.

The highest-confidence claim is false, however: the post-format check does **not** generally measure what the reader receives. It measures text after two partial regex transformations. HTML entity decoding, legacy Markdown parsing, and Telegram’s failure-to-plain-text transition lie outside that model.

The “frozen, clean, local == remote” state also did not describe the worktree presented to this review, so I used an isolated export of the named commit.

## MAGNITUDE-METRIC

**5 load-bearing findings: 4 DESIGN, 1 PRECISION.**

Included:

- HTML over-refusal and fallback suppression: one root.
- HTML/legacy-Markdown under-refusal from incomplete rendering models: one root.
- Missing assurance for the post-format guard: one root.
- Import/callee non-resolution: one root.
- Closed-world method classification: one root.

Excluded beside that number:

- The sandbox’s full-suite infrastructure failures.
- The live worktree’s pre-existing untracked database sidecars and commit mismatch.
- Separate counts for each HTML entity, Markdown construct, or malformed-tag shape.
- A duplicate count for both the missing Lifeline behavioural test and the lint omission.
- The three repaired pass-33 account/test issues.
- Prospective shared-client consolidation work.
- Coverage ratios, because the mutating measurer was not run.

## TRAJECTORY

Using the archive’s load-bearing metric:

`1 → 4 → 7 → 6 → 6 → 5 → 4 → [pass 32 aborted] → 5 → 5`

Pass 34 is flat in count. Three pass-33 defects closed, but the new semantic boundary introduced two correctness findings and one assurance finding. The mix moved from pass 33’s 3 DESIGN / 2 PRECISION to 4 DESIGN / 1 PRECISION.

## CONVERGENCE

The tree has converged locally on the exact pass-33 reproduction: default Markdown formatting no longer lets link-destination-only content through.

It has not converged globally. The repair substitutes a partial syntax stripper for the previous source check without establishing Telegram-equivalent rendering semantics. Meanwhile, both older enforcement-design gaps remain deliberately open, and the new guard lacks equivalent funnel assurance.

## COHERENCE

The current implementation is locally coherent in several respects: both present funnels call both checks, refusals are terminal, the new rule is recorded distinctly, and the focused tests and lints pass.

Its end-to-end reasoning is not coherent:

- The policy warns that over-refusal destroys messages, while the new comment justifies conservatism in a direction that produces over-refusal.
- The HTML send path promises malformed-markup recovery, while the new guard can prevent that recovery from being attempted.
- “Reader-visible text” is claimed at `src/messaging/invisible-payload.ts:260-277`, but the implementation omits decoding and most Markdown grammar.
- The repository’s funnel lint protects only the older pre-format guard.

## VERDICT

**UNSOUND.**

The repair closes the demonstrated default-Markdown case, but its “what the reader receives” claim is broader than its logic. It introduces a real send-path regression, leaves representation-dependent invisible payloads unmeasured, and is not itself fully covered by the funnel assurance.
```
