# Instar Jobs as agent.md — Plain-English Overview

> The one-line version: stop hiding instar's job prompts inside a giant escaped-JSON file. Put each one in its own markdown file. Then the prompts the user wrote belong to the user — and the prompts instar ships belong to instar — and the line between them is a path on disk, not a heuristic.

## The problem in one breath

Today, every scheduled job an instar agent runs has its prompt stored as a JSON-escaped string inside a single file (`.instar/jobs.json`). Echo's is 698 lines long. Writing a multi-paragraph prompt means hand-escaping every newline as `\n`, every quote as `\"`, and giving up real markdown — no headers, no code blocks, no tables, no links. Authors regress toward terse one-liners because the JSON fights them.

There's a second, deeper problem. The same `jobs.json` file mixes two completely different things together: jobs instar ships as defaults (health checks, reflection triggers, identity reviews) AND jobs the user has written for themselves. Today, instar's update process tries to keep these separate using string-matching heuristics. The heuristics get fragile fast. When a user edits a default's prompt, the next update can quietly overwrite it. When instar retires a default in a new release, there's no clean way to mark it retired.

## What this spec changes

Two namespaces on disk, owned by two different parties:

- `.instar/jobs/instar/<slug>.md` — instar's defaults. The update process owns these. It overwrites them every time you update.
- `.instar/jobs/user/<slug>.md` — the user's jobs. Instar never touches these. Not on update, not ever.

A third directory, `.instar/jobs/schedule/<slug>.json`, holds the per-job manifest — when the job runs, whether it's enabled, what tools it's allowed to use. One file per job, so a one-line edit shows up as a one-line git diff instead of a one-line change inside a 700-line blob.

The runtime knows which namespace a job is in by reading the path. No string-matching heuristics. The distinction between "instar default" and "user job" becomes structural.

## The trust layer

There's a fourth file: `.instar/jobs/instar.lock.json`. Instar signs this at release time with a private key kept in CI; the corresponding public key ships inside the npm package. The lock-file contains a hash of every default's body and frontmatter. When an agent boots, it verifies the signature, then hashes each default on disk and compares to the lock-file. If a slug claims `origin: instar` but its body doesn't match what was signed, the runtime refuses to trust it — that entry doesn't get to run with the full tool authority the legitimate default would.

This is the structural answer to "what if someone slips a malicious file into `.instar/jobs/instar/`?" The signed lock-file is the source of truth for what "instar default" means; everything else is treated as a potentially-forged claim.

## Tool allowlists

Every job declares which tools it's allowed to use (`Read`, `Bash`, `Edit`, etc.) via its frontmatter. The default for user jobs is the minimal `[Read]` — a drifted user prompt can't accidentally `rm -rf` the project. Widening past Read requires an explicit `unrestrictedTools: true` flag in the manifest, AND it has to route through the same operator-confirmation gate that protects every other destructive action. There is no `--force` flag and no `yes |` bypass; the Dashboard surfaces a four-screen confirmation for unrestricted widening.

## The migration path

Existing agents currently have a `jobs.json` with everything mixed together. The migration script (`instar job migrate`) reads `jobs.json`, looks up each entry's slug in the lock-file, hashes the body, and routes:

- Slug in lock + body matches → migrate to `origin: instar` with manifest pointing at the bundled body. The user gets the new structure with zero change in what the job does.
- Slug in lock + body differs → fork to `user/` with the body preserved verbatim. The user keeps their edits; they're just not "an instar default" anymore.
- Slug not in lock → it's a user job. Write to `user/`.

A backup of the original `jobs.json` is always written first. `instar job migrate --abandon` rolls everything back in one command. The script is idempotent — running it twice produces the same state.

A "Seamless Migration Guarantee" suite asserts every fixture (pristine, customized, body-edited, user-jobs, retired-defaults, mixed-state, multi-machine-drift, in-flight) passes nine invariants: zero job loss, zero schedule drift, user namespace untouched, one-button rollback, transactional safety on interrupt, fail-closed semantics, full telemetry. The release pipeline refuses to ship Phase 4 or later without the suite green.

## Why a user should care

Before this lands, editing an instar default prompt means hand-escaping JSON inside a 700-line file and praying the next update doesn't quietly overwrite it. After this lands, you edit a single readable markdown file, your edits are durable across updates, and the Dashboard shows you clearly which jobs are yours vs which are instar's. You can override any default, you can switch back, you can disable a default without forking it, and a 30-day backup of every unfork is kept locally for "I changed my mind."

The day-to-day experience improves the most for the agent author trying to tweak a prompt without rewriting JSON. The systemic improvement is bigger: instar updates can now refresh its shipped defaults across the fleet without ever touching a user's work, and a tampered default fails closed instead of running with quietly-elevated tool authority.

## Rollout shape

Six phases, each its own pull request:

1. **Phase 1** — loader, scheduler, lock-file infrastructure (runtime consumer + build-time signer)
2. **Phase 2** — the 14 shipped prompt-type defaults become markdown templates; `installBuiltinJobs()` writes them to agent disk on init and on every update
3. **Phase 3** — `instar job migrate` CLI ships, operator-initiated
4. **Phase 4** — Dashboard rewrite (Jobs tab, Issues card, drift digest, unfork action with backup, four-screen unrestricted widening) plus the operator-confirm endpoints that flip the release-cut gate
5. **Phase 5** — `PostUpdateMigrator` auto-runs the migration with `--default-action=fork` on every update for any agent that still has a legacy `jobs.json`
6. **Phase 6** — `execute.type: "prompt"` for instar default jobs is deprecated and removed two releases after Phase 4 lands

Legacy `jobs.json` continues to work for the entire transition. Rollback is a single field flip per phase. Nothing breaks during the transition.
