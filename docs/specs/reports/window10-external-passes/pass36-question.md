# External review pass 36 — THE QUESTION, recorded before the reading

Sixth archived question. Held near-identical to passes 33, 34 and 35: the series measures the tree, and a
brief that drifts measures itself.

## Frozen tree

CODE frozen at `6549aa23993b9f15154c60424517d2a7a34425d7` on `echo/window10-deep-property-guards`.
This question is archived in the commit immediately after it, which adds ONLY this file — so the
reading happens at that later HEAD and the source under review is byte-identical to the frozen SHA.
A document cannot contain the hash of the commit that introduces it; naming both is the honest form.
Clean (dirt 0),
`local == remote` verified by `git ls-remote`, boundary lint clean, no stray measurer process.
Memory checked before dispatch per the standing rule: 22% RAM free, ~1.0 GB swap headroom (recovered
from 392 MB). This reading is attempted after a long hold on a saturated machine; if it dies on
capacity the rule is to stop, not to retry.

## What changed since pass 35

Pass 35 returned UNSOUND at 7 (6 DESIGN, 1 PRECISION) — the count went UP, and four of the seven were
introduced by pass 34's repairs. **The response was a RETREAT and then a CONSOLIDATION, not a seventh
pattern.**

**Retreat (findings 3 and 4 — closed by removal).** The extraction had grown toward modelling Telegram's
HTML and Markdown parsers with regexes, and every approximation error was an OVER-refusal: `~` is not a
delimiter in legacy Markdown, and `zwnj`/`nbsp`/`shy`/`apos` are not entities Telegram's HTML mode
resolves. Character-reference decoding and the emphasis-delimiter class are DELETED. What remains are the
two transforms true of Telegram without qualification: an HTML tag is markup, and a Markdown link
displays its label. **The under-refusals this reopens are documented in the source, PINNED by tests that
assert the ALLOW, and tracked as CMT-1260.**

**Findings 1 and 2 — closed by making the design consistent.** Both adapter catches now treat every
invisible-payload rule as terminal; the "fall through to plain" retry re-entered the formatter without
`_isPlainRetry`, so it re-derived the same refusal (measured: 2 decision records for one operation before,
1 after). The plain fallback the adapter claimed existed on neither funnel, so the CLAIM was withdrawn
rather than the fallback built.

**Findings 5, 6 and 7 — closed by moving the boundary (CMT-1246).** Those three were properties of the
QUESTION the lint asked. "Is each of six senders guarded" requires binding resolution and method
inference; "may anyone but the door reach the network" requires neither.

`src/messaging/telegram-egress.ts` is now the ONLY function permitted to `fetch` the Telegram Bot API, and
it checks the **SERIALISED body** — the exact bytes on the wire, after every transform, with nothing after
it that could undo the check. 13 call sites across 7 files were migrated, including 7 bodyless calls the
six-sender population had never included. The predecessor lint is deleted; the new one is a boundary check
that canary-tests its own URL recogniser before trusting any verdict.

## STATED OPEN — attack the openness, do not rediscover it

1. **One per-sender guard survives, deliberately.** The tokenless-standby relay egress
   (`TelegramAdapter.ts`, the `outboundRelay` branch) hands the message to ANOTHER MACHINE. This process
   never makes a request to the Telegram host, so the door structurally cannot see it. CMT-1246's
   criterion (b) — "every per-sender call DELETED" — is therefore unmeetable as written, and the guard
   stays rather than being deleted to make a checklist come out even.
2. **The invisible-codepoint table is NOT vendored.** The predicate still uses runtime `\p{...}` escapes,
   so its verdict depends on the host's Unicode version and is not reproducible across the mesh. This is
   CMT-1246 criterion (d), unmet, tracked as CMT-1261.
3. **The relay refusal/unreachable conflation is located but NOT fixed.** `relayOutbound` treats only 422
   as a refusal; every other non-ok status returns `null`, reported as "router unreachable". Pinned by
   three tests that assert CURRENT behaviour so the defect stays visible. CMT-1247.
4. **The boundary lint does not catch a blinded door.** Breaking the door's own url-to-method recogniser
   leaves the lint CLEAN — the boundary is intact, only the guard's ARGUMENT changed. That case reds 7
   tests instead. The split is documented in the lint header.


## Added after the draft: the full suite, and one red left standing

A full-suite run (3,059 files / 48,010 tests) after the egress refactor found 12 failures that every
targeted run had been blind to. Eleven are fixed in the frozen tree. **One is deliberately left red** and
should NOT be reported as a finding unless the reading disagrees with the reasoning:

`tests/unit/standards-coverage-ratchet.test.ts` asserts all six family audits are current. Building and
The Substrate are stale because this branch amended both. Refreshing them legitimately requires a real
multi-reviewer family convergence (the existing artifact records four reviewers, a convergence report and
52 resolved findings). The test's own comment states that editing the expectation "would be forging the
acceptance the record exists to prove." It is red, and reported as red, rather than edited.

Also worth attacking: the new boundary lint was itself absent from `REQUIRED_LINTS` — the shrink-only
list that stops a merge dropping a guard — and so was its predecessor, for as long as it existed. It is
registered now. **Ask whether anything else in this branch is a guard that nothing guards.**

## The question

Read the tree at the frozen SHA and answer: **is the guarantee — that no Telegram payload reaching a
reader as nothing can leave this agent — SOUND, and is every claim made about it in source comments,
lint output, tests and the spec TRUE of the code as written?**

Judge the claims as strictly as the code. A comment that overstates what its analysis performs is a
defect of the same kind as a missing check, because it is what a later reader will trust instead of
re-deriving. Prior passes found three such claims and each had survived a reading that only checked
behaviour.

Report a VERDICT (SOUND / UNSOUND), a MAGNITUDE (count of load-bearing findings, classified DESIGN or
PRECISION), then the FINDINGS with file:line evidence, then a REGRESSION-CHECK against the stated-open
list above — for each, confirm it is still open as described, or explain how the description is wrong.

Analysis only. Do not construct working evasions; describe the class and cite the line.
