# W25 LANE 6 — B-1 REPAIR, ROUND 2, WITH THE SEAM RULING MADE

## What lane 5 established, and why it stopped

Lane 5 did the right thing and stopped rather than edit a test it was not authorized to touch. Its
measurements, on `DaBombs-Mac-Studio.local`, split the four failures cleanly:

**Reproduced with B-1 ALONE on its own base** (so B-1 is broken, not merely conflicting):
- `tests/unit/telegram-stop-journal-seam.test.ts` — both tests, `expected true to be false`
- `tests/unit/no-silent-fallbacks.test.ts` — `expected 498 to be less than or equal to 496`

**NOT reproduced with B-1 alone** (so these are interaction with the candidate, cause unknown):
- `tests/integration/feedback-drain-performance.test.ts` — passed 1/1 on B-1 alone
- `tests/integration/threadline-pairing-routes.test.ts` — passed 16/16 on B-1 alone

## THE SEAM RULING — made by the orchestrator, so you do not have to escalate it again

The seam tests assert, at lines 111 and 138:

    expect(fs.existsSync(path.join(tmpDir, 'autonomous', `${topic}.local.md`))).toBe(false);

That encodes the OLD contract: an emergency stop DELETES the run's state record. Blocker B-1 exists
precisely to overturn that contract — it is chartered as a release blocker because deleting the
record destroys the continuity evidence this window's whole product depends on. The two behaviours
cannot both hold, and lane 5 was right that no code-only repair can satisfy both.

RULING: the seam tests' expectation is the stale one. Update it. This is authorized.

But update it PROPERLY, not by flipping a boolean. Those tests' actual subject — read their titles —
is that the coherence-journal seam is threaded into `stopAutonomousTopic` on a sentinel emergency
stop, and that it is optional. The file-existence line is an incidental side-effect assertion. So:

- KEEP each test's real subject intact. Do not weaken what they verify about the seam.
- REPLACE the stale side-effect assertion with the NEW contract, asserted in full rather than
  inverted: the record still EXISTS, it is marked inactive, and it carries the stop timestamp.
  Read `tests/unit/AutonomousSessions.test.ts` → `stopAutonomousTopic preserves the topic record
  while making the run inactive` for the contract B-1 actually implements, and match it.
- A test that now asserts `toBe(true)` where it once asserted `toBe(false)` and nothing else has
  been weakened, not updated. The point is that it should fail if the record is preserved but the
  stop stops working, or preserved but never marked inactive.

Leave a comment at each changed assertion naming WHY it changed — blocker B-1, the deliberate
contract reversal — so the next reader does not mistake it for a test loosened to go green.

## The silent fallbacks — same pattern lane 4 used, do not invent a new one

B-1 adds two silent fallbacks, taking the ratchet 496 → 498. Do NOT raise the ceiling. Make them
report before they fall back, exactly as lane 4 did for the previous two. Its patch is the worked
example: `.instar/w25/preserved/lane-4/lane-4-fix.patch`.

## The two interaction failures — diagnose before you touch anything

`feedback-drain-performance` and `threadline-pairing-routes` pass with B-1 alone and fail with B-1
on the candidate. Something in the combination does it. Find out what. They may share a cause with
each other, or with the seam problem, or be unrelated — establish it rather than assume it.

Note the shapes: feedback-drain expected `feedback-work:oldest-eligible:1` and got
`feedback-work:newer-eligible:1` (an ORDERING difference); threadline-pairing expected 200 and got
401 (an AUTH difference). Neither smells like a stop-preservation change on its face, which is why
it is worth measuring rather than guessing. If either turns out to be an order-dependent or
shared-state test rather than a real defect, say so with the evidence — that is a finding, not a
failure to fix.

## Where to work, and commit as you go

`/Users/dabombstudio/.instar/agents/echo/.instar/w25/repos/b1-repair` already exists at B-1's tip
(`4ba27703c`) — use it, branch from there. Symlink `node_modules` to the live tree's.
NOT `/private/tmp`: three lanes today left work in temporary storage and two had to be rescued.

COMMIT AS YOU GO. If the pre-commit gate refuses a source commit for a missing side-effects
review, STOP AND REPORT it — do NOT use `--no-verify`. That gate is deliberate and the orchestrator
has already declined to bypass it once today.

## The bar

- the two seam tests pass, with their real subject still verified and the new contract asserted
- the ratchet reads 496, achieved by reporting rather than by raising the ceiling
- both interaction failures either fixed, or explained with evidence and named as such
- must-fail control for each fix: prove it fails with your change reverted
- `node_modules/.bin/tsc --noEmit` exit 0

Do NOT run the full suite; the orchestrator runs the authoritative one. Report targeted results.
Read `EXIT=` and the `Test Files` line for every run — a wrapper's exit status is not the runner's.

## Report to

`/Users/dabombstudio/.instar/agents/echo/.instar/w25/lane-6-b1-repair-2.md` — write as you go.
