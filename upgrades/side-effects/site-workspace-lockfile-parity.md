# Side-Effects Review — site workspace / lockfile parity

**Version / slug:** `site-workspace-lockfile-parity`
**Date:** `2026-08-01`
**Author:** `Echo (instar-dev agent)`
**Second-pass reviewer:** `not required (Tier 1)`

## Summary of the change

PR #1753 (merged 18:26Z today, by me) added `site/pnpm-workspace.yaml` to make `site/` its
own pnpm workspace root, so starlight would resolve `zod@^3` instead of the root's
`zod@^4`. The root `pnpm-workspace.yaml` still declares `packages: ["site"]`. Those two
statements contradict: the root install then demands `site/package.json`'s specifiers, which
the root lockfile does not carry, and `pnpm install --frozen-lockfile` exits 1 with
`specifiers in the lockfile don't match specifiers in package.json`. That is the command the
`ux-impact-pr-gate` runs, so **every PR opened since 18:26Z has a red check its author cannot
fix**.

This reverts `site/` to being an ordinary workspace member (deletes
`site/pnpm-workspace.yaml`) and instead names the constraint directly: `zod: ^3.25.76` as a
direct dependency of `site/package.json`. Starlight takes `zod` as a **peer** dependency, so
it uses whatever the surrounding project supplies — previously the root's v4. With `site/`
asking for v3 by name it gets v3, the root keeps v4, and one lockfile describes both. Files:
`site/pnpm-workspace.yaml` (deleted), `site/package.json` (+1 line), `pnpm-lock.yaml`
(regenerated).

## Decision-point inventory

No decision point. This is build/packaging configuration; no gate, sentinel, or runtime
branch is added, modified, or removed.

---

## 1. Over-block

No block/allow surface — over-block not applicable. The nearest analogue is over-constraining
resolution: pinning `zod` in `site/` could conflict if a future `site/` dependency required
`zod@4`. Nothing in `site/package.json` does today (starlight is the only zod consumer and it
wants `^3.25.76`), and the constraint is a caret range, so patch and minor upgrades inside v3
still float.

---

## 2. Under-block

No block/allow surface — under-block not applicable. What this still misses: the **class**
that let it hide. `ci.yml` installs with `npm ci` on every job, so main never exercises the
pnpm path; the only job that does is this PR-only gate. Main therefore stays green while
every PR fails. This change fixes the instance and leaves that blind spot open — deliberately,
because closing it means either adding a pnpm frozen-install job to main or standardising on
one package manager, both larger decisions than this fix.

---

## 3. Level-of-abstraction fit

Correct layer, and deliberately the *lower* of the two candidates. The alternative — keeping
`site/` as an independent workspace root and adding an `allowBuilds` block to it — was built
and tested first. It made the frozen install pass and **re-broke the site build**, because an
independent `site/` still resolved starlight's peer `zod` up to the root's v4. Declaring the
dependency in `site/package.json` addresses the actual mechanism (an unsatisfied peer) rather
than the symptom (which workspace owns the directory).

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

Packaging configuration. It holds no authority over agent behaviour or information flow.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. Dependency resolution is
enumerable and declarative: starlight's peer range and the root's dependency are both stated
facts, and the fix states a third. Nothing is inferred at runtime.

---

## 5. Interactions

- **Shadowing:** none. Removing `site/pnpm-workspace.yaml` restores the single root workspace; there is no second resolver to shadow.
- **Double-fire:** none.
- **Races:** none.
- **Feedback loops:** none.
- **The one real interaction is with `npm ci`.** `package-lock.json` is unchanged by this PR, and CI's six `npm ci` jobs were passing before and after (they never saw the pnpm contradiction at all). Verified: main's CI is green today with the contradiction present, which is precisely why it hid.

---

## 6. External surfaces

- **Other agents / install base:** none. `site/` is the docs site; it ships no runtime code into the package.
- **External systems:** Vercel builds `site/`. It builds from `site/` with its own install, and the site build was re-verified end-to-end here (99 pages, complete) — the property #1753 existed to restore.
- **Persistent state:** none.
- **Operator surface (Mobile-Complete):** no operator-facing actions.

---

## 6b. Operator-surface quality

No operator surface — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**machine-local BY DESIGN**, with the reason that there is no state at all: this is
repository configuration, identical on every machine because git makes it so. It emits no
user-facing notices, holds no durable state, and generates no URLs.

---

## 8. Rollback cost

- **Hot-fix release:** revert the commit. Two files plus a regenerated lockfile.
- **Data migration:** none.
- **Agent state repair:** none.
- **User visibility:** reverting restores today's broken state — every PR red again. The rollback is strictly worse than the fix, which is worth stating plainly.

## Conclusion

The review changed the fix once, decisively. My first attempt dropped `site` from the root
`packages` list, which made the frozen install pass and re-broke the site build; the
level-of-abstraction question is what surfaced that the real mechanism is an unsatisfied peer
dependency, not directory ownership. The second attempt was verified on all three properties
plus a negative control against unfixed main.

The honest residue: this PR fixes the instance. The reason it went unseen for two hours —
main installing with `npm ci` while the only pnpm consumer is a PR-only gate — is untouched
and is a real gap. Flagged, not fixed.

Clear to ship, and it should go ahead of other work: until it lands, every open PR carries a
red check its author cannot resolve.

---

## Second-pass review (if required)

**Reviewer:** not required — Tier 1 (two files plus a lockfile, no decision-point surface, no
persistent state, revert-only rollback).

---

## Evidence pointers

- **Reproduced before fixing**, on a copy of current main with the gate's exact command: `pnpm install --frozen-lockfile --config.blockExoticSubdeps=false` → exit 1, `specifiers in the lockfile don't match specifiers in package.json: * 6 dependencies were added: @astrojs/starlight@^0.37.7, @astrojs/vercel@^9.0.4, @tailwindcss/typography@^0.5.19, @tailwindcss/vite@^4.2.0, astro@^5.17.1, tailwindcss@^4.2.0`.
- **After the fix, in the PR worktree:** root frozen install → **exit 0**; `site/node_modules/zod` → **3.25.76**; `pnpm exec astro build` in `site/` → **exit 0, 99 pages built, Complete!**
- **Negative control:** the same frozen install against unfixed `main` still exits 1, so the check discriminates rather than passing everywhere.
- **Rejected alternative, tested not assumed:** keeping `site/` as its own workspace root and giving it an `allowBuilds` block → frozen install exit 0, but `astro build` exit 1 with `Cannot read properties of undefined (reading '_zod')`, resolving `node_modules/.pnpm/zod@4.3.6/`.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. The defect is in repository packaging
configuration, not in an LLM prompt, hook, config, skill, or standards text, and the change
adds no self-triggered controller.
