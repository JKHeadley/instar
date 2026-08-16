# Upgrade Guide — vNEXT

<!-- assembled-by: assemble-next-md -->
<!-- bump: patch -->

## What Changed

Two things a Grok-primary agent needed to actually work, both on an explicit
operator decision.

**Approval prompts are now answered — by meaning, not by keystroke.** The
always-on permission floor could already SEE Grok's approval menu but refused to
answer it. It now answers, and how it chooses is the point. Grok's menu offers two
different kinds of "yes": one approves the call in front of it, the other turns off
approval for every future session on the machine and writes that to user-global
config. The dangerous one is the pre-selected row. So pressing the default key was
never an option, and neither was pressing a fixed position — the row order shifts
when optional rows appear. The floor reads the option labels, presses the row
meaning "approve this call", excludes any row meaning "always", and declines
entirely when the menu is ambiguous or an unfamiliar shape.

**Background jobs run on Grok agents.** The job lane refused every Grok job, so a
Grok-primary agent's scheduled jobs all failed on their schedule indefinitely. The
lane is open; the safety bound moved to the case it was actually about.

## What to Tell Your User

- "If you run an agent on Grok, its scheduled jobs work now. They were failing
  every time before, which is what those repeated job-failure alerts were."
- "Grok sessions no longer freeze on a permission prompt when nobody is at the
  keyboard."
- Worth knowing: the auto-answer approves one action at a time. It will never pick
  the option that switches off approval for everything, even though that is the one
  Grok highlights by default.

## Summary of New Capabilities

- **Nothing to enable.** Both changes apply to agents already running Grok; agents
  that have not opted into Grok are unaffected.
- **A Grok job whose working directory is an instar source checkout is still
  refused**, by name. That is the case the original block existed for.

## Evidence

- Grok raises TWO different approval menus, both now verbatim fixtures taken from a
  live session: a three-row one for shell commands and a four-row one for file
  edits. They disagree about where the safe row sits — second on one, third on the
  other — which is what rules out a hardcoded position. The edit menu also offers a
  third scope, "allow all edits during this session", which is excluded along with
  the machine-wide option.
- Shown capable of failing: restoring the naive default-key answer turns the
  reordered-menu test and one other red; restoring the shell-only label patterns
  turns both edit-menu tests red while the other ten stay green.
- Declining is tested in both directions — an ambiguous menu with two plausible
  rows, and a menu missing the always-row (an unfamiliar shape) — because a wrong
  guess on a permission prompt is worse than a stuck session.
- Claude's behaviour is asserted unchanged, so this did not trade one framework's
  safety for another's.
- 19 Grok test files, 235 tests.

## Compatibility Notes

The job lane's original note proposed running Grok jobs in an empty scratch folder.
That was measured before building and would have broken the lane it protected: job
bodies read their config and state by relative path, so an empty folder leaves every
job failing differently while satisfying the note's wording. The bound was narrowed
to the concern the note actually named instead.

Opening the lane also made the closed-lane fallback logic unreachable while its
tests kept passing against a short-circuit. The closed-lane check is now injectable
so that logic stays genuinely exercised rather than quietly dead.
