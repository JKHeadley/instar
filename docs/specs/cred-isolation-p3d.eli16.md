# Credential-resolution audit + boot coherence sample, increment P3d — ELI16

## What this is

Increments P3a–P3c make sure an agent on a shared computer always acts as
ITSELF — never as another person whose identity happened to be lying around
in the environment. P3d adds the part that lets you SEE that machinery
working: a small, append-only record of every identity decision instar's git
funnel makes, plus a one-line health sample taken every time the server
boots.

Think of it like the access log next to a door lock. The lock (P3a) already
keeps the wrong identity out. The log (P3d) tells you the wrong identity
TRIED — which is exactly the information that was missing during the
"Caroline" incident: the bleed was only discovered by reading prose, not by
any machine record.

## What changed, concretely

Two additions, both observe-only:

1. **Resolution audit.** Inside the git funnel's environment-sanitization
   step, the two interesting decisions are now recorded to
   `.instar/audit/credential-resolution.jsonl`:
   - *repo-local-strip* — an inherited identity (for example a
     `GIT_AUTHOR_NAME` exported by whatever shell spawned the agent) was
     stripped because the repo has its own agent identity. This is the
     Caroline-class moment, now durably visible.
   - *host-identity-inject* — a repo without its own identity had the host's
     identity filled in (the long-standing behavior for non-agent installs).
   A recurring identical decision (a sync loop hitting the same repo every
   few minutes) is recorded once per process, not flooded.

2. **Boot coherence sample.** When the server starts, it reads the agent's
   expected identity from its own repo-local git config and compares the
   machine's other identity surfaces against it: inherited identity
   environment variables, the machine-global `~/.gitconfig`, and whether a
   machine-global gh CLI login exists at all. Divergences are written as one
   `boot-coherence` line in the same file, and a single console warning
   points at it. Nothing is blocked — the server always boots.

## Why it's safe

Everything is signal-only by construction: the audit writer swallows its own
failures (an unwritable disk can never break a git operation), the boot
sampler never throws (a broken sample can never block boot — proven by an
end-to-end test that boots a real server with auditing disabled), and all
probes are pure file reads — no subprocesses, so test suites that script
child-process call sequences are untouched (the lesson CI taught us in P3a).
There are no new routes, no config flags, no migrations: the same
`INSTAR_AUDIT_LOG_DIR` / `INSTAR_AUDIT_LOG_DISABLED` overrides that govern
the existing destructive-ops audit govern this file too.
