# Round 2 triage (spec sha256 f8579b95…, 1,675 words)

Reviewers: GPT 6 Astra (MINOR ISSUES), Fable 5.2 (MINOR ISSUES), and two combined internal reviews (A: security/scalability/adversarial; B: integration/decision-completeness/lessons). Standards-Conformance Gate: ran, 2 flags.

**Health line, round 2:**
- Distinct DESIGN findings: 6 (round 1: 10).
- Precision items: about 14.
- New durable mechanisms: 0.
- Every round-1 resolution checked against the code still holds (review A: "No new DESIGN findings").
- Words: 1,675, then 2,086 after the round-2 edits. That is under 1.5× the 1,500 budget (2,250).

**Tripwire.** "Design findings must halve by round 2." They fell from 10 to 6, a 40% drop, not half, so the tripwire fired on the count. **Echo's judgment: the spec is converging, not diverging. It proceeds to round 3, its last allowed round, rather than being split.** Reasons:
- No round-1 resolution was reopened.
- No mechanism was added.
- Four of the six round-2 design findings concern conformance to the governance format: the Maturation plan section, who arbitrates, the machine-local key, and a duplicated field. None is an architectural flaw.
- Splitting out the ratchet would not touch any round-2 finding.

This override is disclosed to Justin. It is also recorded as a calibration input for sub-effort C: the tripwire should count findings that reopen a resolution or add a mechanism, not the raw count.

| DESIGN finding | Raised by | Resolution in round 3 |
|---|---|---|
| `invalid` drop stores raw text in a frozen interface | Astra, Fable, security (precision) | `requestedValue` is omitted on `invalid` |
| `cliVersion` reads `unknown` on the first run after each restart | Fable | The probe runs alongside the spawn, and `recordStart` waits for it for up to 2s |
| Criterion 3's boundary conflicts with "Verify the state" | Astra | Bound to `recordStart` after `spawnSession` resolves; spawn errors go to `recordSpawnError` with no launch |
| Wrong arbiter for Maturation Path; required `## Maturation plan` section missing (the tag writer refuses without it) | review B, SCG | Section added (passes `FeatureMaturationPlanGate` with `requireLadder`). The `feature-maturation-review` model decides, and Justin's B6 confirmation sits on top of that |
| "Any grade drop fails" is an underived floor | review B, SCG, Astra (precision) | Fail only on a median drop larger than the baseline IQR; smaller moves are judgment inputs |
| Machine-local key misapplied to an inherited surface | review B | No key claimed; the inherited posture is stated; the gap is filed as fb-ca7635e0-b76 |
| `launch.framework/model` duplicates existing row fields | review B | Removed. The top-level fields, taken from the same session object, are the only copy |

Precision items applied:
- the migration sniff phrase is now unique;
- all enums are additive-only and readers tolerate unknown values;
- the ratchet scope (no tests; re-keying allowed; it is a floor, not a proof);
- `Session.launch` is named;
- the env assertion runs on the real spawn path;
- the Codex `--oss` setting matches interactive;
- the retainer's existing sync probe is disclosed;
- the env-inheritance limit is stated;
- criterion 2 now has an "unless dropped" qualifier;
- matching now includes `cliVersion`;
- run counts for the D8 jobs.
