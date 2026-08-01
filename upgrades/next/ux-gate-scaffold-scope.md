<!-- internal-only -->

# UX-impact gate now sees the user-awareness surface

## What Changed

`scripts/ux-impact-lint.mjs` decides whether a PR counts as user-facing by matching
changed files against a hard-coded allowlist. That allowlist omitted
`src/scaffold/templates.ts` — the file the Agent Awareness Standard names as THE
user-awareness surface ("An agent that doesn't know about a capability effectively
doesn't have it"). A PR touching only that file matched nothing, hit
`allowlisted.length === 0`, and exited 0. The change that alters what every agent tells
its users required no UX declaration at all. `src/templates/` (hook and helper scripts)
was allowlisted; `src/scaffold/` was not.

Three edits, one defect:

1. The `:25` allowlist gains `p === 'src/scaffold/templates.ts'` — the exact file the
   standard names, in the exact exact-match style already used for two other files.
   Deliberately **not** `startsWith('src/scaffold/')`: widening a gate beyond what a
   standard names is a policy change nobody approved.
2. The `:30` refactor-only exemption excludes that path too — rewriting agent-visible
   text is never a pure refactor.
3. The `:41` failure message now names the concept and lists the paths actually
   searched. It previously read "UX Impact must quote a concrete string from the diff"
   while searching only the allowlisted subset of the diff, so an author who correctly
   quoted a real added line from an unlisted file was told something untrue about why
   they failed.

The gating predicate at `:40` is untouched. `scripts/` is CI-only, is not bundled into
`dist/`, and is executed by no deployed agent, so no running agent's behaviour changes.

## Evidence

Verified against real commit `e29259c49`, which touches `src/scaffold/templates.ts` and
zero allowlisted paths (both confirmed by control counts):

| lint | result |
|---|---|
| shipping (`origin/main`) | `UX lint: out of scope`, exit 0 — gate skipped entirely |
| patched | engages, exit 1 on `UX-Impact: none` |
| patched, replaying PR #1813 | exit 0 — no regression on a real passing PR |

The static contradiction, with a control: `CLAUDE.md` names `src/scaffold/templates.ts`
as the user-awareness surface, while `ux-impact-lint.mjs` contained `scaffold` zero
times (control: `templates` = 2, so the search works and this is a true negative).

New test `tests/unit/ux-impact-lint-scaffold-scope.test.ts` covers both sides of the
boundary and was trip-tested by reverting the lint to `origin/main`: 3/3 pass with the
fix, 2 fail without it, and the internal-path control passes either way.

Known residual, not claimed as fixed: the allowlist remains a proxy for "user-facing"
and still omits `PostUpdateMigrator.ts`, skill bodies, and hook templates. This closes
one hole in one list; the list still has no owner and no review trigger.
