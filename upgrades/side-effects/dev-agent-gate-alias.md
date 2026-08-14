# Side-Effects Review — dev-agent gate check follows a local alias

**Version / slug:** `dev-agent-gate-alias`
**Date:** `2026-08-14`
**Author:** `echo`
**Second-pass reviewer:** `not required — Tier 1 (CI-only lint script; no runtime path). The rule is unchanged; the check now recognises one more spelling of the thing it already forbids.`

## Summary of the change

`scripts/lint-dev-agent-dark-gate.js` assertion A bans hand-rolled dev-agent gate resolution — anything
resolving `enabled ?? !!<x>.developmentAgent` outside `resolveDevAgentGate`. The matcher required
`.developmentAgent` (or `['developmentAgent']`) **literally after the `??`**, so lifting the value into a
local const first walked past it while resolving the gate by hand exactly as before:

```ts
const da = config.developmentAgent;
return enabled ?? !!da;          // exit 0 against the shipped lint
```

instar-codey reproduced this while auditing rename-defeatable checks and scoped the remedy: *"low for
simple local alias folding around `developmentAgent` feeding `??`."* That is the scope implemented — local
`const`/`let`/`var` aliases only, rebuilt per file.

The lint's header **already declared this limit** ("cannot catch arbitrary aliases/wrapper helpers"). Like
the journal-actuation ban earlier today, it is closed because the declared gap is cheap to close for the
shape that actually occurs, not because the declaration was dishonest.

## Decision-point inventory

- `collectDevAgentAliases(lines)` — ADD — per-file identifiers bound to `<expr>.developmentAgent`.
- `aliasGateMatcher(names)` — ADD — `?? [!!|Boolean(] <alias>`; returns null when there are no aliases, so
  a file without one is byte-identical to before.
- Assertion A predicate — WIDEN — `HANDROLLED_GATE || aliasGate`.
- Assertions B and C, the funnel allowlist, the comment-stripping (`codeOnly`), and the marker logic are
  untouched.
- No runtime block/allow decision added or modified. CI-time only.

## 1. Over-block

The failure that matters: this lint fails builds, so flagging correct code costs more than missing a case.
Four controls, each with a test:

- **An alias of something else** (`config.somethingElse`) is not flagged — only `developmentAgent` binds.
- **A look-alike name** (`config.developmentAgentName`) is not flagged: the `\b` holds through the alias
  exactly as it holds at the direct callsite.
- **An alias never used at a `??`** is not flagged. *Reading* the flag is legal; resolving the GATE by hand
  is what is banned, and that distinction is preserved.
- **A comment describing the aliased pattern** is not flagged — `codeOnly` already strips comments and the
  alias collector runs on the same stripped lines, so a commented-out declaration binds nothing.

Scope is per-file by construction: aliases cannot leak between files.

Verified against the real tree: exit 0 — the widened check introduces **no new flags on existing code**.

## 2. Under-block

Stated in the source rather than implied:

- **Wrapper helpers** (`isDevAgent(config)`) — still invisible.
- **Cross-module aliases** — an alias exported from another file is not followed.
- **Anything needing dataflow** to resolve.

Guessing at those would over-match. The header's original claim is narrowed, not erased: it now cannot
catch *arbitrary* aliases, having gained the local-const case.

## 3. Level-of-abstraction fit

Same layer as the existing check — line-oriented regex over comment-stripped source, no AST, no type
information, no new dependency. The alias map is the minimum needed to answer "what value is at this
`??`?" without climbing to a parser.

## 4. Signal vs authority compliance

Unchanged. A CI guard, not a runtime authority. It pushes callers toward `resolveDevAgentGate`; the funnel
allowlist still exempts the funnel itself.

## 5. Interactions

- `npm run lint` chain — position unchanged; full chain green.
- Assertions B/C unaffected; their env-fixture tests pass untouched.
- No source module, route, config key, or state file touched.

## 6. External surfaces

None. Developer tooling, not an agent capability; the Agent Awareness Standard does not apply.

## 7. Rollback cost

`git revert` of one script plus the appended tests. No migration, no state, no deployed artifact.

## Conclusion

Ship. One evasion closed at the scope a peer's audit recommended, four anti-over-block controls added, real
tree verified clean.

## Evidence pointers

- `tests/unit/lint-dev-agent-dark-gate.test.ts` — **31/31 green** (24 existing + 7 added).
- Negative control: tests written BEFORE the fix and run against the shipped lint — **3 of 31 fail** (const
  alias, bracket-access alias, `Boolean(alias)`); the four new controls and all 24 existing tests pass both
  ways, which is what makes them controls.
- Reproduced by hand first, with a positive control: the direct form exits 1, the aliased form exits 0.
- Real-tree verdict: `node scripts/lint-dev-agent-dark-gate.js` → exit 0.
- Full `npm run lint` chain green.
