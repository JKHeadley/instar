# Site Workspace / Lockfile Parity — Plain-English Overview

## The problem in one breath

Every pull request opened since 18:26Z today has been failing one check, and the failure has
nothing to do with the pull request. I broke it, in a fix I merged earlier the same evening,
and the way the repository is set up meant the main branch stayed green the whole time so
nobody could see it.

## What already exists

The docs site lives in `site/`, inside the main repository. The root `pnpm-workspace.yaml`
lists it as a member of the workspace, which is the normal arrangement: one lockfile at the
root describes what every part of the repo installs.

Earlier today I fixed a genuine problem where the docs site would not build — it was picking
up version 4 of a library called `zod` when the docs framework needs version 3. My fix was
to give `site/` its own `pnpm-workspace.yaml`, which makes it an independent workspace with
its own resolution.

That worked, and it created a contradiction I did not see.

## What this changes

Two statements were both true and could not both be true:

- The root said *"site is one of my packages"* (`packages: ["site"]`).
- `site/` said *"I am my own workspace root"* (its own `pnpm-workspace.yaml`).

When the root installs, it therefore demands the versions listed in `site/package.json` —
but because `site/` had resolved itself independently, those versions were never written
into the root lockfile. The two files disagreed, and the install refused to proceed.

This change removes `site/pnpm-workspace.yaml` so `site/` is an ordinary workspace member
again, and instead adds one line to `site/package.json`:

```json
"zod": "^3.25.76"
```

That is the whole fix. The docs framework takes `zod` as a *peer* dependency, meaning it
uses whatever version the surrounding project provides rather than bringing its own. The
surrounding project provided version 4. Now `site/` asks for version 3 by name, so it gets
version 3, and the root keeps version 4 for everything else. No independent workspace, no
contradiction, one lockfile that matches.

## The safeguards

**Verified against the command that actually gates the repo.** The check runs
`pnpm install --frozen-lockfile`. My original testing used plain `pnpm install`, which
quietly *rewrites* the lockfile to match — so it passed locally and failed in CI. Every
check below used the frozen form.

**Verified that the thing the earlier fix repaired still works.** It would be easy to make
the install pass by simply undoing the earlier change and re-breaking the docs build. The
site build was re-run: 99 pages, complete.

**Verified with a negative control.** The same frozen install was run against unfixed
`main` and fails there — so the check discriminates between fixed and broken, rather than
passing everywhere.

## What ships when

Immediately, and it should be merged ahead of anything else, because until it lands every
open pull request shows a red check that its author cannot fix.

## What you actually need to decide

Nothing, unless you want the deeper question answered now.

The reason this hid for hours is that `ci.yml` installs with `npm ci` on every job, while
this one gate uses `pnpm`. The main branch therefore never exercises the `pnpm` path, and
the gate that does is pull-request-only. Main stays green while every PR fails.

That is the same blind spot I described in the release note for the earlier fix — I wrote
the sentence naming it and then shipped a change that broke exactly that path. Closing it
properly means either running a `pnpm --frozen-lockfile` install on main, or standardising
on one package manager. Both are larger decisions than this fix and are left to you.
