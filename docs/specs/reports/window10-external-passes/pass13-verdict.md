# External review pass 13 — reviewer's verbatim final answer

Committed before any repair. **The first version of this file was a STUB** — a summary plus a pointer
saying the verbatim block "is preserved in full in the run transcript". That is the unauditable-archive
defect this directory exists to prevent, and it has been a review finding three times (passes 5, 9, 12).
Caught and replaced in the next commit rather than left; recorded here rather than quietly fixed.

Pass 13 is the thirteenth reject. It regressed the axis pass 12 had improved (pass 12: zero mechanism
defects; pass 13: one mechanism divergence and one live evasion), and it caught the increment written
*entirely to correct stale numbers* publishing a sixth wrong version of the number it was correcting.
Independently verified before accepting: **49 / 25 / 15**, against my 48 / 33 / 20 — the cause was that
my measuring script RE-TYPED the guard's token rule instead of importing it.

Run against the frozen tree at `b7c92ffaa`. Exploration logs are NOT kept; only the final answer block.

---

```text
FINDINGS

1. SEVERITY: major — The measurement written to retire the word "unmeasured" is itself wrong, and one of its three figures is contradicted by another sentence in the same paragraph. `docs/STANDARDS-REGISTRY.md:170` now states: "33 of 201 (16.4%) appear anywhere in the resolving corpus at all, 20 of 201 (10.0%) in `src/` or `tests/` … and 48 of 201 carry no id-shaped token whatsoever." The third figure reads no file at all — it is `TOKEN_RE`/`isIdShaped` applied to a checked-in JSON list. Computed: 49, not 48. Robust across every token variant I tried (guard-exact 49; letter+digit 50; hyphen+digit 50; `\w{3,}` 58; no-slash 49). The same paragraph already says "4 of 168 markers carrying an id-shaped token"; the tracked population is 217, so that sentence asserts 217−168 = 49. Direct computation over the live markers confirms 217 / 168-with / 49-without. Two sentences in one paragraph, 48 and 49, and the older one is right. The other two figures are no better: replaying the guard's own rules over `docs/deferral-referent-baseline.json` (201 orphans; live run confirms 217/16/201) gives 25 / 15 under the ALL-tokens rule the guard actually uses, and 31 / 22 under the loosest ANY-token reading — reproducing pass 12's 25/15/49 exactly, with the internal check 201−49 = 152 = the with-token set. I swept token-length × corpus-definition × resolution-rule (18 combinations); no single consistent rule produces (33, 20, 48). The closest is a min-1-character token rule with ANY-token resolution → (33, 24, 48) — and that rule treats the bare `4` in `programNeeds §4` as an identifier, which is precisely the "ordinary words count as identifiers" defect pass 5 corrected. And the stated cause of the disagreement — "the exact token and binary rules each replay reconstructed" — is falsifiable and false: running the replay with the binary heuristic on and off yields identical numbers (25/31 both ways), and the 48/49 figure touches no file. This is the sixth wrong version of this number, published simultaneously into three artifacts by the increment whose own text is "a number restated in four places goes stale in three of them."

2. SEVERITY: major — The sentence written to replace the falsified one is itself false in its first limb, and a probe walks through. `docs/STANDARDS-REGISTRY.md:170` now adds: "Comments are stripped and `.md` is excluded, so the COMMENT half holds … the honest statement is narrower: comments do not resolve a referent, and prose files do not, but prose inside a structured file still does." Executed in a clone: four fresh markers, each with exactly one occurrence. `ZZZ-90201`, whose only occurrence is `// ZZZ-90201 lives only in this JSON comment` inside a tracked `.json`, RESOLVED. Controls fired correctly: `ZZZ-90203` (`//` in `.ts`) orphaned, `ZZZ-90204` (`#` in `.yaml`) orphaned, `ZZZ-90202` (prose in a JSON string value) resolved. Cause: `HANDLED_EXT` admits `json|jsonl`, and `withoutComments()` returns those two forms unchanged. Same family as pass 10's finding 2, one file type over.

3. SEVERITY: major — The newly-admitted heading-evasion class is admitted in a code comment and recorded nowhere a guard reads. `scripts/standards-registry-article-core.mjs:79-92` now honestly says the refusal closes the indented form only and "NOT the class of CommonMark-legal headings a parser here cannot see". Verified live: `- ### X`, `1. ### X`, `> ### X` and `<h3>X</h3>` all pass every lint and `standards-coverage`, while the column-zero control fails two of them. But `docs/STANDARDS-REGISTRY.md` contains the string "indent" 0 times; `docs/enforcement-gaps.json` has no record of this shape; no sub-obligation countdown tracks it; and no enforcement fingerprint cites `standards-registry-article-core.mjs`, so the gap sweep can never reach that surface. The same commit did re-reach the registry and the gap record for the other two repairs — so the discipline pass 12 named was applied to two of three and not to this one.

4. SEVERITY: major — A third registry population, silently narrower than the other two, gates the enforced ratio; nothing reports the divergence. `scripts/standards-coverage.mjs:240,245` — `if (!block.article.rule) continue;` — drops any `###` article carrying no `**Rule.**` section. Verified: a brand-new column-zero article with no Rule → `lint-no-duplicate-definitions` 89 articles, `standards-coverage` total=88, `unrecognizedSections: []`, `enforcedRatio` unchanged at 0.75. Add a `**Rule.**` line → coverage 89 and the ratio moves to 0.7416. All 88 current articles carry a Rule, so the three populations agree today by coincidence — the exact wording this change records against itself. Honest bound: a new fingerprinted Rule-less article is refused by the gap-sweep staleness arm and by `lint-registry-self-counts`, so this is not a live evasion of the whole chain — but `standards-coverage`, whose `--check` is the required gate and whose floors are the ratchets, never sees the article.

5. SEVERITY: major — the required coverage gate still rejects the submitted state; sixth consecutive pass. `standards-coverage.mjs --check` → exit 1 on Building and The Substrate; `b7c92ffaa` edited registry lines inside both areas, so the post-pass-12 repairs re-staled the audits exactly as the post-pass-11 repairs did.

6. SEVERITY: major — the three ratchets still constrain nothing here. All three baselines ABSENT from origin/main; `readPinnedBase` returns `establishing` on `REQUIRED=0` and `local-unbound` with no base env, both of which return early. Carried unchanged from passes 7/9/10/11/12; dated.

7. SEVERITY: minor — the sub-obligation countdown collection gate is still open and still uncaptured as named work. An EXPIRED countdown injected into an article carrying no `UNENFORCED SUB-OBLIGATION` phrase → clean, exit 0; the total does not even rise. The header's "no declared deadline is in the past" remains false as written.

8. SEVERITY: minor — repair (g) removed the forbidden figure as an assertion and left it in the file as a mention. The token `62%` is still in the file the instruction was applied to. The substantive replacement is correct.

9. SEVERITY: minor — the two newly-written accounts of what stops attack B name different guards. The gap-records header says the sibling requirement lint; the registry says `lint-no-duplicate-definitions`. Executed: `lint-no-duplicate-definitions` exit 1 and it runs earliest; `lint-enforcement-fingerprint` exit 1; `lint-enforcement-gap-records` exit 0. Both sentences are individually defensible; "what actually stops attack B" names the second-in-line.

10. SEVERITY: nit — parser divergence inside one lint file, unchanged from pass 12. A heading inside an HTML comment is counted as a real article and fails the build. Over-refusal, safe direction — but a heading cannot be commented out.

11. SEVERITY: nit — the paragraph explicitly labelled "Scope" still names only fenced blocks; the blockquote skip and list-item blindness are stated in the docblock body but not in the Scope paragraph.

12. SEVERITY: nit — `if: always()` also runs on cancellation; `!cancelled()` is the idiom that does not. Six occurrences. Carried from passes 11 and 12.

Critical: none. Class empty.

REGRESSION-CHECK

(a) constitution's two-arm certification corrected — CLEAN. Attack A → PARTITION BROKEN, exit 1. Attack B → identical, exit 1. Negative control by REMOVAL: replacing the condition with `if (false)` makes BOTH attacks report clean; restoring returns 88/6/82. Exactly one refusal. No new defect.

(b) gap record why/evidence re-reached — CLEAN. Every specific claim verified by input, including the new "KNOWN NOT COVERED" clause, which I tested rather than accepted: attack C (duplicate of a grandfathered heading, neither copy fingerprinted) leaves the partition satisfied and is caught by the shrink-only arm and the sibling lint, exactly as stated.

(c) shared-core universal narrowed — NEW DEFECT (finding 3). The narrowing is factually accurate and a strict improvement on a false certification, but the class it admits is recorded only in a code comment.

(d) gap-records header narrowed — CLEAN on substance, minor imprecision (finding 9).

(e) "prose and comments do not resolve" corrected — NEW DEFECT (finding 2).

(f) "unmeasured amount" replaced by a measurement — NEW DEFECT (finding 1), and the sharpest of this pass. Recording the disagreement instead of resolving it is evasive, not honest, for four reasons I established rather than asserted: the question is decidable in about fifteen seconds from two checked-in artifacts and four lines of the guard; one figure reproduces the guard's rules exactly and the other reproduces nothing I could construct; the offered cause is falsified — binary handling changes nothing at all; and no bound is actually stated, two precise triples are. Worst of all, the paragraph already contained the answer to one third of it.

(g) superseded figure removed — CLEAN on substance, minor residue (finding 8).

(h) new dated residual — CLEAN, and genuinely enforced. Collected (45 → 46), back-dating fails the build with a named message, duplicate id refused across both spaces, and its underlying claim reproduces: neutering the gap lint's failure exit still prints clean.

Re-test of earlier repairs: pass 9, 10, 11 and 12 repairs all hold. Neutering `hasNoVisibleCharacters` reds both test files; deleting the route guard reds the route file and leaves the predicate file green; `npm run lint` exits 0 with all four registry lints clean.

MECHANISM-CHECK

(a) CLOSED. (b) CLOSED. (c) PARTIAL. (d) CLOSED. (e) OPEN. (f) OPEN. (g) CLOSED. (h) CLOSED.

MY-ACCOUNT-CHECK

The archive is complete and tracked: twelve files, all twelve reject. I read passes 10, 11 and 12 in full and spot-checked the rest; I did NOT independently re-derive the per-pass severity counts for passes 1–9, and say so rather than implying I checked.

Four discrepancies:
1. The commit body says pass 12 graded "four of five repairs mechanically CLOSED". Pass 12's table graded three CLOSED, one PARTIAL and one OPEN; its prose phrase was "mechanically sound". "CLOSED" is an upgrade of the reviewer's word applied to the reviewer's own grading table.
2. The archive preamble to pass12-verdict.md says "every pass-8/9/10/11 repair still held"; the verdict body says 9, 10 and 11. Pass-8 is added by the author.
3. The prompt's framing of (f) is accurately transcribed. The implicit invitation to treat both replays as equally supported is what does not survive execution.
4. Everything else in the prompt's list is a faithful description of what the commit did.

MAGNITUDE-METRIC

Load-bearing enforcement integrity — defects that let a guard, ratchet, test, or evidence artifact certify a condition it has not established, including certifying machinery that no longer exists and publishing a measurement the stated method does not produce. Unchanged from passes 5–12, deliberately.

TRAJECTORY

Load-bearing, passes 1→13: 4 → 4 → 5 → 4 → 4 → 4 → 4 → 4 → 3 → 5 → 5 → 5 → 5.
Raw major, passes 1→13: 5 → 7 → 6 → 4 → 4 → 4 → 5 → 5 → 5 → 6 → 6 → 6 → 6.

Flat on both, fourth consecutive pass. Composition moved the wrong way: pass 12's distinguishing result was zero mechanism defects; this pass has one new mechanism divergence found by execution and one live guard evasion demonstrated by probe. The blocking condition is unmet for the seventh consecutive pass. Two of this pass's three are sentences that did not exist before `b7c92ffaa` and are false as written. To be fair about the third: repair (c) replaced a false certification with a true-but-untracked one, strictly smaller than what it replaced, and I grade it a defect of completeness rather than of honesty.

CONVERGENCE

No. The second half of the criterion is met and has been for two passes: 49 tracked countdowns, expiry proven to fail the build on the newest one, uniqueness proven across both id spaces, known-open items dated on the articles they belong to. Verified rather than read.

The first half is not met, and this pass is worse than pass 12 on the axis pass 12 improved. The increment written entirely to correct stale numbers published a sixth wrong version into three artifacts at once, contradicting a figure a hundred words away, and explained the contradiction with a cause that changes nothing. The increment written to retire a false sentence shipped a narrower sentence a fifteen-line probe falsifies. And pass 12's structural criticism was honoured for two of three repairs and repeated for the third.

What would flip it: (1) one pass finding nothing new inside the previous pass's repairs; (2) resolve the orphan measurement instead of recording a disagreement about it; (3) something that binds a recorded verdict — and a newly-authored certification — to the source it describes; (4) convert the admitted heading class into a gap record or dated countdown; (5) the gate must be able to go green.

COHERENCE

No. Six mismatches, each established by execution: 48 against 49 by computation and against the same paragraph's "4 of 168"; 33/20 against the guard's 25/15; the "binary rules" cause that changes the result by zero; "the COMMENT half holds" against a marker resolving through a `//` comment in a tracked `.json`; the heading class unrecorded anywhere a guard reads; and `standards-coverage` counting a Rule-gated population while reporting `unrecognizedSections: []`.

Against that: the candour remains real and unusual, and the mechanism work is the best of the run. The account is failing where the machinery is not.

VERDICT

reject. The mechanism held again — attacks A, B and C all refused, the negative control fired by removing the check rather than mutating it, the dialect refusal bites at one space with correct silence on fenced, HTML-commented and four-space forms, the new residual is collected and provably expires, and every earlier repair survived re-test — so the machinery is now the strongest part of this change for the second pass running. But the repairs were an all-prose commit whose single job was to make the account true, and two of its sentences are false as written. The increment that replaced "unmeasured" with a measurement published a figure that reads no file and is still wrong, contradicts "4 of 168" in its own paragraph, cannot be reproduced by any of eighteen rule combinations, and attributes the discrepancy to binary handling that provably changes nothing — the sixth wrong version of the number whose paragraph is about that number going stale. The increment that retired "prose and comments do not resolve a referent" shipped "the COMMENT half holds", and a marker whose only trace is a `//` comment in a tracked `.json` resolves. The one class the shared core now honestly admits open is recorded in a code comment and nowhere a guard reads. And I found a mechanism divergence twelve passes missed: `standards-coverage` drops any article lacking a `**Rule.**`, so the population behind the enforced-ratio floor is silently narrower than the two the lints count. Load-bearing magnitude is flat at 5 and raw majors flat at 6 for a fourth consecutive pass, the composition regressed from pass 12's zero-mechanism-defect result, the seventh consecutive pass has found new load-bearing defects inside the previous pass's repairs, and `standards-coverage --check` still exits 1 on two audits these repairs re-staled. The criterion asks whether the stream's magnitude is genuinely declining. It is not.
```
