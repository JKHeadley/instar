# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

- **The feedback executor can build its native dependencies, so a report can actually become a pull request.** `depsCache.buildNatives()` rebuilds `better-sqlite3` inside the sandbox runtime whenever the copy fast-path cannot be used (the agent's own install and the lockfile pin different versions). That rebuild could never succeed: the confinement policy puts `os.homedir()` in `denyRead`, while npm and node-gyp keep their caches under `$HOME`, so node-gyp's configure step died with `EPERM: operation not permitted, open '~/Library/Caches/node-gyp/<ver>/installVersion'` and every real feedback cluster stopped at `deps-unavailable` / `deps-install-failed: native rebuild failed (exit 1)`. `HOME` is now set to a per-attempt directory inside the attempt's own temp (already in `allowWrite`), created before the command runs. **Nothing is loosened** — the sandbox settings are untouched and the real home stays denied for both read and write; the toolchain is simply no longer asked to use it. This also clears the secondary `prebuild-install warn install EPERM: ... /.npm`.
- **A failed confined rebuild now says why.** `ConfinedResult` carries `stdout` and `stderr` and the throw discarded both, so a one-line permission error was only recoverable by re-running the sandbox invocation by hand. The error now carries a bounded, secret-scrubbed diagnostic line via the `scrubForStore` funnel already used in this directory (fail-closed: text that cannot be vouched for is withheld, not emitted), and `DepsCache.ensure()` stops truncating the reason to 200 characters. `rebuildFailureTail()` deliberately prefers the first non-`warn` failure line over a plain tail: npm's last lines are its own epilogue (`You can rerun the command with --loglevel=verbose`) while the cause sits further up, and the non-fatal `prebuild-install` warning precedes the fatal line and would otherwise mask it.

## What to Tell Your User

Nothing is user-visible, and there is nothing to decide — no new setting, no approval, no migration. If your agent runs the feedback factory, the part that turns a bug report into a pull request was failing before it ever started; it can now get past that step.

## Summary of New Capabilities

- No new surface. `rebuildFailureTail(result, limit = 150)` is exported from `src/feedback-factory/execute/depsCache.ts` for its unit tests; it is pure text selection and decides nothing.

## Evidence

- Reproduced through the real `SandboxRuntimeRunner` with the settings `buildNatives` builds, cache under the agent home (production's layout): `EXIT=1`, `gyp ERR! configure error`, `EPERM ... node-gyp/24.14.1/installVersion`. Re-run with the `HOME` redirect and otherwise identical settings: `EXIT=0`, `rebuilt dependencies successfully`, `better_sqlite3.node` present at 1,897,088 bytes, `prebuild-install` warning absent.
- A discarded intermediate run placed the cache under `/tmp` and produced a *different* EPERM (`unlink build/Release/...`) — a harness artifact of macOS resolving `/tmp` to `/private/tmp` so the literal `allowWrite` prefix did not match. Recorded because it is the kind of false lead that reads like a second bug.
- `tests/unit/feedback-factory/execute-units.test.ts`: `HOME` is the attempt temp, is not `os.homedir()`, and the directory exists; a failed rebuild carries the fatal line into `deps-unavailable` while npm's epilogue is excluded and the reason stays bounded; `rebuildFailureTail` prefers the fatal line over a `warn`, falls back to the last line, returns empty for empty input, and bounds its length. 37/37 in that file, 6/6 in `execute-wiring.test.ts`.
- Cause recorded in the trace's `causalAutopsy`: latent from #2155 (which introduced the confined rebuild). The copy fast-path masked it wherever the agent install and the lockfile agreed on a version; it surfaced when the install floated to `better-sqlite3` 12.11.1 against a lockfile pinning 12.8.0, so the version check correctly refused the copy and fell through to the rebuild for the first time.
