# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

**Every pull request opened after 18:26Z on 2026-08-01 carried a red `ux-impact-pr-gate` its author could not fix.** The failure was mine, introduced by PR #1753 which I merged at 18:26Z, and `main` stayed green throughout so nothing surfaced it.

#1753 added `site/pnpm-workspace.yaml` to make `site/` its own pnpm workspace root, so starlight would resolve `zod@^3.25.76` rather than the root's `zod@^4.3.6`. The root `pnpm-workspace.yaml` still declares `packages: ["site"]`. Both statements cannot hold: the root install then demands `site/package.json`'s specifiers, which the root lockfile never received, and the gate's command fails —

```
specifiers in the lockfile don't match specifiers in package.json:
* 6 dependencies were added: @astrojs/starlight@^0.37.7, @astrojs/vercel@^9.0.4,
  @tailwindcss/typography@^0.5.19, @tailwindcss/vite@^4.2.0, astro@^5.17.1, tailwindcss@^4.2.0
```

This makes `site/` an ordinary workspace member again (`site/pnpm-workspace.yaml` deleted) and names the real constraint instead: `zod: ^3.25.76` as a direct dependency of `site/package.json`. **Starlight takes `zod` as a peer dependency** — it uses whatever the surrounding project supplies, which was the root's v4. With `site/` asking for v3 by name it gets v3, the root keeps v4, and a single lockfile describes both.

**The mechanism I got wrong the first time.** #1753 treated the problem as *which workspace owns the directory*. It is not — it is an unsatisfied peer range. Isolating the directory happened to fix the symptom while creating the lockfile contradiction. The first attempt at *this* fix repeated the mistake from the other side (drop `site` from the root `packages` list): the frozen install passed and the site build broke again, resolving `zod@4.3.6` from the root store.

**Two findings recorded while fixing it:**

- **I verified with a different command than the one that gates the repo.** #1753 was tested with `pnpm install`; CI runs `pnpm install --frozen-lockfile`. Plain install silently *rewrites* the lockfile to match, so it passes locally exactly when it would fail in CI. Every check in this PR used the frozen form.
- **`main` cannot see this class of break.** `ci.yml` installs with `npm ci` across all six jobs; the only consumer of the pnpm path is a PR-only gate. So main is green while every PR is red — the same blind spot #1753's own release note described, which is what makes shipping this regression through it worth recording rather than quietly repairing. <!-- tracked: ACT-1701 -->

Deliberately not changed: which package manager this project standardises on, and whether `main` should run a `pnpm --frozen-lockfile` install. Both are the operator's call and neither is needed to unblock the queue today.

## What to Tell Your User

Nothing changes in how you work with me, and there is nothing for you to do.

For a couple of hours this evening, every new code change in this project showed a failing check that had nothing to do with the change itself. I caused it with an earlier fix, and the way the project is set up meant the main branch looked perfectly healthy the entire time, so there was no signal that anything was wrong.

That is now fixed, and the documentation site still builds correctly — I checked both, because the obvious repair would have traded one break for the other.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| New code changes no longer show a failing check caused by the documentation site's setup | Nothing to do — open changes as normal |
| The documentation site keeps building correctly alongside that fix | Nothing to do — verified at 99 pages built |

## Evidence

- **Reproduced before fixing**, on a copy of current `main` with the gate's exact command: `pnpm install --frozen-lockfile --config.blockExoticSubdeps=false` → **exit 1**, with the six-specifier mismatch above.
- **After the fix, in the PR worktree:** root frozen install → **exit 0**; `site/node_modules/zod` → **3.25.76**; `pnpm exec astro build` in `site/` → **exit 0, 99 pages built, Complete!**
- **Negative control:** the same frozen install against unfixed `main` still exits 1 — so the check discriminates between fixed and broken rather than passing everywhere.
- **Rejected alternative, tested rather than assumed:** keeping `site/` as its own workspace root and giving it an `allowBuilds` block → frozen install exit 0, but `astro build` **exit 1** with `Cannot read properties of undefined (reading '_zod')`, resolving `node_modules/.pnpm/zod@4.3.6/`. That is the shape of the original bug returning, which is why it was discarded.
