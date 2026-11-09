<!-- bump: patch -->

## What Changed

Two pieces of existing design that were built but never worked are repaired, and the plumbing the Skill Learning
Sentinel (spec `docs/specs/skill-learning-sentinel.md`, slice 0) needs is added:

- Every agent now gets a master copy of its skills under `.instar/skills/` (the "canonical" layout the Skill
  concept spec defined in May): a one-time, copy-only backfill fills it from the skills already installed under
  `.claude/skills/` and `.agents/skills/`, stamps the installed copies so the parity rule sees them as in sync,
  and never deletes anything. Built-in skills are now written to the master copy first and rendered from it.
- The skill-use log is rewritten: one JSON row per use with no free text, written to a per-machine file under
  `.instar/skill-telemetry/`, tagged with the session, topic, machine and the exact skill version that was
  loaded. Sessions are now told which machine they run on (`INSTAR_MACHINE_ID`) and, where known, their topic.
  The old single file (which could not be parsed on busy agents and conflicted between machines) is left in
  place and ignored by sync.
- Every machine keeps its rendered copies of *learned* skills in step with the master copy — at boot and every ten
  minutes — without ever overwriting a copy a person edited by hand (a per-machine
  baseline and a journal make an interrupted write recoverable and a hand edit detectable). Rendered files are
  written atomically.
- Backups include the new folders; the config gains a `monitoring.skillLearning` block that ships **off**; the
  feature's maturation-ladder entry is registered; `.instar/state/skill-learning.db*` and the legacy telemetry
  file are git-ignored.

## What to Tell Your User

Nothing changes in how you work with me. Behind the scenes, I now keep one master copy of my skills that every
coding tool reads from, the record of which skills I use is reliable and kept per machine, and a learned skill
will stay identical on every machine I run on. The new learning feature itself stays switched off until its
trial starts.

## Summary of New Capabilities

- A master skills folder on every agent, filled automatically and kept in sync across machines.
- A trustworthy per-machine log of skill uses, with the version used.
- Groundwork (off by default) for skills the agent learns from repeated requests.

## Evidence

On this agent on 2026-11-06, `.instar/skills/` did not exist (35 skills lived only under `.claude/skills/`),
`FrameworkParitySentinel` was never constructed, and 8 of 51 rows in `.instar/skill-telemetry.jsonl` were
unparseable because raw tool arguments were echoed into JSON by the shell. Unit and e2e tests cover
the backfill (idempotent, conflict policy, nothing deleted), the hook (valid JSON for hostile arguments, unknown
on invalid names), the spawn-site exports, the reconcile (steady-state renders nothing; edited copies lock; no
baseline + stale stamp locks; journal recovery), atomic rendering, backups, and the boot wiring; the reconcile is
registered in the self-action convergence ratchet.
