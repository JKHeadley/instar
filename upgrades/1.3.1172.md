# Upgrade Guide — vNEXT

<!-- assembled-by: assemble-next-md -->
<!-- bump: patch -->

## What Changed

Four things a Grok-primary agent needed in order to actually work. The first two
were the operator's decision; the last two are defects found while proving the
first two, by running them rather than reading them.

**Approval prompts are now answered — by meaning, not by keystroke.** The
always-on permission floor could already SEE Grok's approval menu but refused to
answer it. It now answers, and how it chooses is the point. Grok's menu offers more
than one kind of "yes": one approves the call in front of it, another turns off
approval for every future session on the machine and writes that to user-global
config, and a third grants every edit for the rest of the session. The most
sweeping one is the pre-selected row. So pressing the default key was never an
option, and neither was a fixed position — Grok raises at least two different
menus and the safe row sits in a different place on each. The floor reads the
option labels, presses the row meaning "approve this call", excludes every blanket
row, and declines entirely when the menu is ambiguous or an unfamiliar shape.

**Background jobs run on Grok agents — and actually do their work.** The job lane
refused every Grok job, so a Grok-primary agent's scheduled jobs failed on their
schedule indefinitely. The lane is open, and the safety bound moved to the case it
was actually about. Opening it was not sufficient on its own: a headless Grok run
silently skips any action needing approval and still exits successfully, so a job
asked to write a file would announce it, write nothing, and be recorded as a
success. Reads were unaffected, which is what made it invisible — a read-only job
looked perfectly healthy. Jobs now run in a mode where their actions actually
execute.

**Grok jobs no longer report success while doing nothing.** Opening the lane
introduced a worse failure than the one it fixed. Job manifests name a generic
model tier, and the new lane passed that tier to Grok verbatim instead of
translating it, as every other tool's lane does. Grok rejects an unknown model and
then **exits with a success code**, so jobs spawned, died at startup in 18 seconds,
and were recorded as successful. Any Grok job that "succeeded" suspiciously fast
before this release did no work.

**Grok job prompts are no longer visible to other programs on your machine.** They
were passed as command-line arguments, which anything else running on the same
machine can read. They now travel in a file only the agent can open.

## What to Tell Your User

- "If you run an agent on Grok, its scheduled jobs work now. They were failing
  every time before, which is what those repeated job-failure alerts were."
- "Grok sessions no longer freeze on a permission prompt when nobody is at the
  keyboard."
- **Worth checking:** if you saw Grok jobs reporting success very quickly, they
  were not doing anything. That is fixed, but nothing retroactively re-runs them.
- Worth knowing: the auto-answer approves one action at a time. It will never pick
  the option that switches off approval for everything, nor the one that grants
  every edit for the session — even though the sweeping one is what Grok highlights
  by default.

## Summary of New Capabilities

- **Nothing to enable.** All four changes apply to agents already running Grok;
  agents that have not opted into Grok are unaffected.
- **A Grok job whose working directory is an instar source checkout is still
  refused**, by name. That is the case the original block existed for.

## Evidence

- Grok raises TWO different approval menus, both now verbatim fixtures taken from a
  live session: a three-row one for shell commands and a four-row one for file
  edits. They disagree about where the safe row sits — second on one, third on the
  other — which is what rules out a hardcoded position, by measurement rather than
  by the vendor's warning. The edit menu also offers a third scope, "allow all
  edits during this session", which names neither "always" nor "don't ask again"
  and is excluded explicitly.
- Shown capable of failing: restoring the naive default-key answer turns the
  reordered-menu test and one other red; restoring the shell-only label patterns
  turns both edit-menu tests red while the other ten stay green.
- Declining is tested in both directions — an ambiguous menu with two plausible
  rows, and a menu missing the always-row (an unfamiliar shape) — because a wrong
  guess on a permission prompt is worse than a stuck session.
- The model fix is pinned for every generic tier, with a control proving a real
  Grok model id still passes through untouched. Verified live: a job that died in
  18 seconds now runs 47.
- The "jobs actually act" fix was measured mode by mode against the live CLI, with
  the file being created as the only success signal — no mode, "accept edits" and
  "don't ask" all failed to create it while exiting successfully; two other modes
  worked. The one that sounds most obviously correct is among the ones that do
  nothing, which is why this is pinned by a test rather than left to judgement.
- Claude's behaviour is asserted unchanged, so this did not trade one framework's
  safety for another's.
- 20 Grok test files across all three tiers, 245 tests.

## Compatibility Notes

The job lane's original note proposed running Grok jobs in an empty scratch folder.
That was measured before building and would have broken the lane it protected: job
bodies read their config and state by relative path, so an empty folder leaves every
job failing differently while satisfying the note's wording. The bound was narrowed
to the concern the note actually named instead.

Opening the lane also made the closed-lane fallback logic unreachable while its
tests kept passing against a short-circuit. The closed-lane check is now injectable
so that logic stays genuinely exercised rather than quietly dead.

The paragraph agents read about Grok said background jobs do not run on Grok, and a
test was asserting that it said so. Both are corrected, and the paragraph is now
coupled to the code: if the text and the lane disagree, the build fails.
