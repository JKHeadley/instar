---
name: lifeline-shadow-install-self-heal
description: Boot wrapper auto-reinstalls missing shadow-install, prevents multi-day outages
metadata:
  type: capability
  shipped: vNEXT
---

# Boot Wrapper Shadow-Install Self-Heal

When the agent boots and finds `shadow-install/node_modules/instar/dist/cli.js` missing, the wrapper script (`instar-boot.cjs` or `instar-boot.sh`) now automatically attempts ONE `npm install` before exiting. This prevents multi-day outages from a vanished shadow-install directory.

## How It Works

1. Boot wrapper detects missing CLI entry point
2. Executes `npm install` with absolute path resolution (`/opt/homebrew/bin/node` + `npm-cli.js`) to survive launchd's empty PATH
3. Uses `.heal-attempted` marker file to prevent reinstall storms under launchd KeepAlive
4. If successful, proceeds normally; if it fails, exits and launchd will retry on next cycle

## Behavioral Impact

- **Recovery Time**: Agent recovers from shadow-install loss within seconds (next launchd cycle)
- **Zero Configuration**: Automatic, no setup needed
- **Cost**: One extra `npm install` attempt per boot cycle if the directory is missing

## Technical Notes

- Uses absolute `/opt/homebrew/bin/node` and `npm-cli.js` resolution to bypass launchd's empty PATH (the core cause of prior silent failures)
- Debounced by `.heal-attempted` marker to throttle reinstall storms
- Spec: `docs/specs/lifeline-shadow-install-self-heal.md` (with ELI16 companion)
- Tests: 14 unit tests in `tests/unit/lifeline-shadow-install-self-heal.test.ts`

## Rollback

Revert `src/commands/setup.ts` and redeploy. No persistent state needed.
