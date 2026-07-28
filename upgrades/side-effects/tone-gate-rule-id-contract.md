# Side-effects review — MessagingToneGate prompt rule-id contract + escaping rule

**Change:** two string edits inside the tone-gate prompt template (src/core/MessagingToneGate.ts):
(1) the JSON schema line + closing constraint now demand the FULL rule identifier
(e.g. B15_CONTEXT_DEATH_STOP) instead of enumerating the short ids ("B15") that
parseResponse rejects fail-closed; (2) a JSON quote-escaping rule for
issue/suggestion strings. Plus a source-level contract-pin test.

**Principle check (Phase 1):** the change touches a decision point (the tone
gate) but adds NO new decision logic and NO new authority — it corrects the
prompt's own output-format instruction so the EXISTING parser receives what it
already demands. The prompt previously instructed the exact output the parser
rejects (a self-contradiction every model obeyed: cross-model failure share up
to 1.00 in INSTAR-Bench v2). Signal-vs-authority compliant: no brittle check
gains blocking authority; an existing smart gate becomes reliable.

1. **Over-block** — none identified. The edit does not change WHAT the gate
   blocks; it changes how the model formats its verdict. A/B evidence: 0
   previously-passing cells regressed (118 cells, 7 routes, ab-tone-gate2).
2. **Under-block** — strictly reduced: previously a correct BLOCK verdict with
   a short rule id was unparseable, so real violations could fall into the
   parse-failure path. Full-id verdicts now parse, so more true blocks land.
3. **Level-of-abstraction fit** — right layer: the defect is IN the prompt
   text, the fix is in the prompt text. The alternative (teaching the parser
   to accept short ids) would loosen a fail-closed contract and create
   ambiguity between B1 and B15 prefix families; rejected.
4. **Signal vs authority** — compliant; see principle check. No authority
   moved.
5. **Interactions** — none: no other component parses this prompt's output;
   the structured self-stop block and rule lists are untouched. The
   contract-pin test interacts only with the source text.
6. **External surfaces** — none beyond the model-facing prompt. No API, no
   config, no user-visible strings. Works identically across providers
   (evidence spans claude/codex/pi doors and, from the v1 round, groq/gemini).
7. **Multi-machine posture** — machine-local BY DESIGN: the prompt ships in
   code; every machine gets it with the release. No replicated state, no
   URLs, no topic-transfer surface.
8. **Rollback cost** — trivial: revert the two strings (one commit). No data,
   no migration, no config. The bench A/B harness re-verifies in ~15 minutes.

**Evidence:** INSTAR-Bench v2 A/B `ab-tone-gate2` — CLEAN-WIN, 40 cells fixed /
0 regressed / 118 cells over 7 routes (claude-sonnet/opus/haiku, codex
gpt-5.5/gpt-5.5-plain/gpt-5.4-mini, pi gpt-5.5), with infra-class cells
excluded from accounting and the single disputed cell arbitrated at 3 samples
(2/3 pass — sample-0 flake). Verdict JSON:
research/llm-pathway-bench/results/instar-bench-v2/ab-tone-gate2-verdict.json
(research tree, agent home). Review record:
research/llm-pathway-bench/instar-bench-v2/review-records/tone-gate.md.

**Second-pass review:** required (gate keyword) — see appended reviewer note.

## Second-pass review (independent)
Concur with the review.
Verified against the actual diff (3 insertions / 2 deletions in
src/core/MessagingToneGate.ts, prompt-template strings only — no logic, no
authority moved): (a) the self-contradiction claim is true — the old closing
constraint enumerated bare short ids ("exactly one of B1–B9, B11, …") while
`interpret()` (line ~840) requires `VALID_RULES.has(rule)`, a set of FULL
identifiers only, so an obeyed bare id → retry → fail-closed hold; and
`parseResponse` JSON.parses the first `{...}` block, so a raw inner double
quote in issue/suggestion throws → null → the same fail-closed path — the
escaping-rule claim is also true. (b) Over-block: none — pass:true verdicts
carry empty rule/issue/suggestion, untouched by both edits; the blocking
criteria themselves are unchanged; A/B shows 0/118 regressions. I confirmed
all 19 VALID_RULES appear in the prompt lists as full identifiers, so
"byte-identical from the lists above" is satisfiable for every rule. (c) No
other consumer: greps show the only parser of this output is
parseResponse/interpret in the same file; no production code, test, or
research file pins the OLD strings (the new pin test asserts their absence);
the two other tests reading this source (gate-prompts-judge-by-meaning,
GateSignalDetectors) don't touch the response-format section — all 31 tests
across the three files pass. One point the artifact UNDERSTATES in its own
favor: on the tiered operator channel a discipline failure DELIVERS
(`operatorChannelDeliver`, failedOpenOperatorChannel), so pre-fix a correct
BLOCK with a short id could fail OPEN there, not merely be held — the fix is
more load-bearing than claimed. Minor nit, non-blocking: the new prompt text
says a bare id "fails the parser"; strictly it fails the VALID_RULES check in
interpret(), but as model-facing prose the effect described is accurate.
