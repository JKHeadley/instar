# Flaky tests should not block the changes that matter most (plain-language overview)

Before any change is merged, a machine runs every test we have. That is thousands of test files, and a few of them are "flaky": now and then they fail for no good reason, such as a timer running out on a busy machine.

To stop flaky tests from blocking good changes, the test line has a second-chance rule. If only one to three test files fail, each is run again by itself. If it passes alone, the first failure is treated as a fluke, written down so someone fixes the test, and the change goes through.

There is one exception. If the failing test uses any code the change touched, it gets no second chance. The reasoning is sound: maybe the change itself made the test unreliable, and one lucky pass would hide that.

The trouble is that some code is used by almost everything. Change one of those central files and nearly every test "uses code the change touched". That change then gets no second chances at all, so any flaky test anywhere stops it. On 18 November 2026 a security fix was stopped three times in a row this way, each time by a different flaky test that had nothing to do with it. It cost hours.

**The proposed fix.** The same tests are also run, many times a day, on the main branch: the code everyone shares, without the new change in it. A failing test gets a second chance only when the very same test has already been seen failing and then passing on the main branch in the last week. That proves the test is flaky without this change, because this change was not in that run. The second chance is a harder one: the test must pass three times in a row, alone, and each time that exact test has to be seen passing. A run that is green only because the test was skipped does not count.

If the main branch has never shown that test to be flaky, nothing changes: no second chance, exactly as today. Runs of other people's unfinished changes do not count as proof, because someone could create those on purpose. Nobody can fake a run of the main branch.

**The honest cost.** On the first day this helps nobody, because the list of known-flaky tests starts empty and fills as tests misbehave on the main branch. For the security fix above, two of its three blocks would have been avoided after about a week of collecting; the third would not.

**What stays the same.** If the change edited the test file itself, there is no second chance. No time limit gets longer. At most three files per run get any second chance.

**What we accept.** A change that makes an already-flaky test a little worse can still get through. We cannot tell that apart at the moment of testing.

**How we watch it.** Every test let through this way is recorded with the change it belonged to. After seven days we compare, for each such test, how often it misbehaved on the main line in the week before the change went in and in the week after. If that at least doubles, a person reads the failures and the change the same day and switches the rule off unless the cause is clearly something else.

**Rollout.** It is off by default. We try it first on a throwaway setup, then on our own development machines. For this project that second step is already the full effect, because those machines check every change we merge.
