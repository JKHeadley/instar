# Upgrade Guide — vNEXT

<!-- bump: patch -->
<!-- patch = bug fix with regression test, no new surface -->

## What Changed

**fix(packaging): `dist/cli.js` now ships with the executable bit set in the published npm tarball.**

`tsc` writes compiled output at mode 0644 by default. The build script previously did not chmod the bin target, so every published instar tarball from 1.0.13 onward shipped `dist/cli.js` at `-rw-r--r--`.

Normally `npm install` papers over this by chmodding bin targets to 0755 at link time, so fresh installs work. But `npx`'s package cache reuses the bin symlink across version upgrades and skips re-chmodding the underlying target file on subsequent installs — so users who had previously run `npx instar` could hit `sh: .../instar: Permission denied` after a version bump, even though the symlink itself looked correct. The mode on the target file stayed at 0644 from a previous install while new file bytes were written in place.

After this release:
- `package.json` `build` script ends with `chmod 0755 dist/cli.js`, so the file is mode 0755 before `npm publish` packs it.
- The tarball entry for `dist/cli.js` ships at `-rwxr-xr-x` regardless of npm's install-time behavior.
- `tests/unit/package-completeness.test.ts` adds a regression test that packs a real tarball, lists it with `tar -tvf`, and asserts every entry referenced by `package.json` `bin` has the exec bit. The test fails if the chmod step is removed.

## What to Tell Your User

No user action needed. If you had previously seen the npx instar command fail with a permission-denied error after a version bump, that path is now fixed — the next published version will run cleanly. If a stale copy is still cached, clearing the npx cache picks up the corrected bytes.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| npx instar works across version bumps even when npm's bin chmod is skipped | Automatic — published tarball now ships dist/cli.js with the exec bit |

## Evidence

**Reproduction (before the fix):**

```
$ npm pack
$ tar -tzvf instar-*.tgz package/dist/cli.js
-rw-r--r--  0 0  0  90101 Oct 26  1985 package/dist/cli.js
```

The tarball entry has no `x` in the mode — confirms the published 1.2.7 (and every earlier version back to 1.0.13) shipped without the exec bit.

**After the fix:**

```
$ npm run build
$ npm pack
$ tar -tzvf instar-*.tgz package/dist/cli.js
-rwxr-xr-x  0 0  0  90101 Oct 26  1985 package/dist/cli.js
```

**Regression test:**

`tests/unit/package-completeness.test.ts > all package.json bin files ship with the executable bit set` — runs `npm pack` into a temp dir, inspects the tarball with `tar -tvf`, asserts each bin entry has `x` in its mode string. Verified to fail when the `chmod 0755` step is removed from the build script — output: `dist/cli.js: ships at "-rw-r--r--" (no exec bit)`.

**Original failure observed in the field:**

```
$ npx instar@latest
sh: /Users/.../node_modules/.bin/instar: Permission denied
```
