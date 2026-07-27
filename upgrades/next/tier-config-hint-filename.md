# Upgrade Guide — vNEXT

<!-- internal-only -->
<!-- bump: patch -->

## What Changed

`scripts/lib/classify-tier.mjs` no longer treats a `.config` FILENAME reference as evidence of a
config surface. The `\.config\b` alternative in `CONFIG_SURFACE_HINT` matched any text containing
`.config`, including filenames — so a script that merely READ `vitest.push.config.ts`, combined with
an ordinary object literal, fired "new capability: new config key added" and raised that change's risk
floor to 2.

## Evidence

Falsified by restoring the alternative:

```
× does NOT fire on a mere .config FILENAME reference — the reproduction of the real case
  → reading a .config filename is not adding a config key: expected 2 to be 1
  Tests  1 failed | 48 passed (49)
```

Restored byte-identical; 49 passed, including all 47 pre-existing classifier tests unchanged. A second
new test iterates every remaining anchor (`ConfigDefaults`, `defaultConfig`, `InstarConfig`,
`configSchema`) and asserts the floor still rises — narrowing a check must not blind it.

## Known limits

If a genuine config-key addition mentions only a `*.config.ts` filename and none of the remaining
anchors, its floor will no longer rise. The remaining anchors cover this repo's actual config
surfaces, and the both-sides test guards against a future narrowing that blinds the check — but this
is a heuristic over diff text and always was.

## Why it mattered

The floor is what makes a tier declaration meaningful: declaring under it is permitted but audited as
a deliberate override. A floor that fires on a filename teaches authors that below-floor declarations
are routine, which is how a real floor gets argued past later. A noisy guard degrades the guard it
belongs to.

## What to Tell Your User

None — internal change (no user-facing surface).

## Summary of New Capabilities

None — internal change (no user-facing surface).
