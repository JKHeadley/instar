# Supervisor preflight on dogfooding agents — ELI16

When an agent's server crashes or restarts, a small "supervisor" process runs
a preflight checklist before bringing it back up. One checklist item asks git
"is this repo stuck mid-rebase?" — because a stuck rebase silently breaks
updates. That question is read-only: it looks, it never touches.

Separately, Instar has a safety guard that stops automated tools from running
destructive git commands against the Instar source code itself. That guard is
good — it has prevented real damage. But every git call goes through one
funnel, and read-only calls must explicitly say "I'm read-only" to pass the
guard on a source tree.

Here's the collision: on a *dogfooding* agent — one whose project directory IS
the Instar source tree, like the dev agents — the preflight's read-only git
question never declared itself read-only. The guard rejected it, the rejection
threw, and the whole recovery preflight aborted. Net effect: the safety guard
was prolonging the exact outages the supervisor exists to end. This bit echo
live on 2026-06-05 during a restart cascade, and Codey diagnosed it while
echo's server was down and hot-patched the running copy to restore service.

A hot-patch dies on the next auto-update, so this PR lands the durable fix:
that one git-status call now carries the read-only declaration
(`sourceTreeReadOk: true`), exactly like the three earlier fixes of this same
class (#450, #455, #550 — other read-only callers that the guard migration
wrapped without the opt-in). Nothing about the guard itself changes: every
destructive operation is still blocked on source trees, and non-dogfooding
agents see zero behavior change because the guard only activates on Instar
source trees in the first place. A regression test (written by Codey during
the live incident) pins the declaration so a future refactor can't silently
drop it.
