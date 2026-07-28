# ELI16: Dev Preflight New-Surface Guard

Instar now has a developer-only preflight command for PRs that add or touch new server surfaces. The
command runs lint, runs the CapabilityIndex discoverability tests, and then scans the diff for newly
added Express route registrations.

The route scan is only a heuristic. It looks for added `app.get/post/put/delete/patch('/prefix')` or
`router.get/post/put/delete/patch('/prefix')` lines and warns if the top-level prefix is not in
`CAPABILITY_INDEX`. It never edits source, never updates `CapabilityIndex`, and never blocks the
server.

Only two things make the command exit nonzero: lint failing, or the discoverability/CapabilityIndex
unit tests failing. Route-prefix findings are warnings so the agent can make the deliberate
classification without hidden automation changing the registry.

The command also prints the Tier-2 ship checklist so PR authors remember the surrounding artifacts:
upgrade note, side-effects review, ELI16/private-view proof, docs coverage, and build.

Private view proof: https://codey.dawn-tunnel.dev/view/e060533e-cafd-4a37-b251-7d8d4dbeb63b?sig=7d25de0423b88fd4c59ec3f0a1238bfe69e8891d841da33d92308bec7be2f71c

Verified HTTP 200 on 2026-06-03.
