# Built-in Skill Install — Single Source of Truth (plain English)

## What this is

Every Instar agent gets a set of built-in "skills" — little slash-command tools it
can run (`/learn`, `/feedback`, and so on). These are supposed to be installed
automatically when an agent is set up.

It turns out they're installed from **two different lists that don't know about each
other**. One list lives as text baked inside a TypeScript file (`init.ts`). The
other is a folder of skill files (`skills/`) sitting right there in the repo. The
setup code only ever reads the first list. The whole folder — 14 skills — is never
installed by anyone.

That's not a small folder. It contains the most important developer tools Instar
has: `spec-converge` (the careful, multi-reviewer process we run on a design before
building it) and `instar-dev` (the skill for actually changing Instar's own code).
So the agent whose entire job is developing Instar — Echo — never had the tools
Instar uses to develop itself. They were sitting in the repo the whole time,
un-shipped.

## Why it matters

Our constitution has a rule that basically says: a capability the agent doesn't know
it has, it effectively doesn't have. An uninstalled skill is the strongest possible
version of that — it's not just un-mentioned, it's not even there. A second rule says
there must be **one source of truth**, never a hand-maintained list that drifts out
of sync with reality. The bug is exactly that second rule being broken: two lists,
one forgotten.

## What changes

1. We make **one** canonical list of built-in skills instead of two. The skills
   folder becomes the single source; the baked-in-text list moves into it as real
   files.
2. We **reconcile** — we don't blind-copy all 14. A few are duplicates (one feedback
   skill is an older copy of the one already installed) or have been replaced by
   better built-in machinery (a "send a Telegram" skill is obsolete now that the
   relay does it). Those get dropped or kept as docs-only. The rest get installed.
3. Existing agents — not just brand-new ones — get the skills, through a one-time
   update step.
4. We add a **safety check in CI**: if the canonical list and what actually gets
   installed ever drift apart again, the build fails. So this exact bug can't come
   back silently.

## The tradeoff

The main judgment calls are: which of the borderline skills (knowledge-base,
scheduler, the identity ones) are still useful versus replaced by newer
infrastructure, and whether dropped skills should be deleted or kept as
documentation. Those get settled in the review (convergence) round, not by one
person guessing. Nothing here adds a new permission, a new gate, or a new way for
the agent to message you — it's purely about making sure every agent actually has
the tools it was always supposed to have.
