# Upgrade Guide — vNEXT

<!-- assembled-by: assemble-next-md -->
<!-- bump: patch -->

## What Changed

`scripts/lint-no-unfunneled-topic-creation.js` now resolves the Telegram method name before applying
its rules.

That lint enforces the **Bounded Notification Surface** standard — the last-resort budget on
automatically-created forum topics, added after the third topic-spam incident. Its three patterns each
required `createForumTopic` as a string LITERAL adjacent to the seam, so all three of these reached the
Bot API uncounted while the build reported `clean`:

```js
const M = 'createForumTopic'; apiCall(M, { name: 'x' });
apiCall('createForum' + 'Topic', { name: 'x' });
const M = 'createForumTopic'; ({ method: M, name: 'x' });
```

Measured against the shipped lint with a positive control (the bare literal) firing in the same run:
control caught, all three EVADE.

None of that is evasive — lifting a repeated string into a named constant is ordinary tidying. Someone
could step around a notification-flood ceiling while making code *nicer*, and nothing would say a word.

Added: `foldAdjacentLiterals` (folds `'a' + 'b'` only, never across an identifier),
`collectStringConsts` (per-file identifier → literal; an identifier bound twice to different values is
dropped as unresolvable), `resolveLine` (substitutes ONLY at the two seam positions), and `scanFile`
(extracted so matching is testable). `PATTERNS`, `ALLOWLIST` and the violation message are unchanged.

Also added: a **direct-invocation guard**. Importing this module previously ran the whole repo scan and
called `process.exit(1)` on the first real violation, killing the importing process — which is why its
internals had never been unit-tested. Three other lints hit the same hazard this week.

## What to Tell Your User

Nothing changes for you. A build-time check that stops features from creating unlimited Telegram topics
could be walked past by giving a string a name first — an ordinary bit of tidying, not a trick. It now
sees through that. Nothing you use behaves differently; a category of notification flood just got harder
to ship by accident.

## Summary of New Capabilities

None. No new command, endpoint, setting, or runtime behaviour. A CI guard that was defeatable by a local
constant is no longer defeatable by one.

## Evidence

- `tests/unit/topic-creation-lint-resolution.test.ts` — 18/18 green.
- **Negative control: 5 of 18 fail** against the shipped matching behaviour; the other 13 pass both ways
  and are the controls. Source restored byte-exact afterwards (sha match, zero markers left).
- Six anti-over-block controls, because this lint blocks commits: a const bound elsewhere, an identifier
  that never reaches a seam, an identifier with conflicting bindings, a concatenation involving an
  identifier, a longer look-alike method name, and seam-local (not global) substitution.
- Real tree: `exit 0` before AND after — no new flags on existing code.
- Full `npm run lint` chain green (57 steps); lint-chain membership verified explicitly rather than
  inferred from a `package.json` reference.
- **Declared open in the source:** cross-module names, runtime-built names, and anything needing
  dataflow. Also named: the lint does not strip comments, which is pre-existing and neither fixed nor
  worsened here.
