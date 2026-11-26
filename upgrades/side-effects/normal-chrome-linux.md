# Side-Effects Review — Linux agents can drive Chrome, and always know they have a browser

**Version / slug:** `normal-chrome-linux`
**Date:** `2026-11-04`
**Author:** `echo`
**Second-pass reviewer:** `independent general-purpose subagent; concerns resolved (see Second-pass review)`

## Summary of the change

A Linux agent can now drive an ordinary Google Chrome on a private virtual display it owns: `xdrive.sh` and `x-drive.py` read through AT-SPI and act through real X input. Passwords travel from Secret Drop into the page's password box through the helper's new `--browser` mode, with the destination stored on the request and shown to the person. A new agent installs what it needs at boot through `xdrive-provision.sh`. Every agent reads a named browser state from `GET /browser/state`, and Linux sessions start with a `BROWSER:` line. Spec: `docs/specs/normal-chrome-linux.md`.

## Decision-point inventory

- Driver and wrapper refusals (`x-drive.py`, `xdrive.sh`) — add — each refuses its own unsafe operation; the full table is in the spec.
- Secret Drop helper exits for a `browserHost` request — add — refuses stdout, `--run`, `--consume`.
- `POST /secrets/request` `browserHost` validation — add — a malformed host, or one with `senderVerification`, answers 400.
- Durable persistence of a submission — modify — a `browserHost` submission is not stored.
- Boot install decision (`decideProvision`) — add — stored value plus machine facts; adds packages, gates nothing.
- `POST /browser/linux/install` — add — 403 without the header, 409 on explicit false or a throwaway.
- `browserCapability` — add — a pure mapping; reports only.

## 1. Over-block

`ERR multiple-tabs` refuses a page opened by a `target=_blank` link, so the agent must close and relaunch. Blunt, but stated in the skill. Boot install only serves Ubuntu 24.04 amd64 with passwordless sudo; other machines read `not-built` with the reason. That is the measured line, not a claim the others cannot work. Masking every editable field after `typesecret` over-masks other boxes on that page until it changes, deliberately.

## 2. Under-block

A caller running `x-drive.py` or an X client directly against the agent display skips the wrapper. Same-user code can call the retrieve route directly, so "the agent never sees it" holds for an honest agent only. A cross-origin iframe hidden from accessibility may not be seen by the hit-test. A few milliseconds remain between the last check and the input; the post-state read is the backstop. A process lost in the instant between spawn and record is cleared by a reboot, not the driver.

An existing agent that has not opted in runs nothing at all at boot: the who-gets-it rule comes first, before any `sudo` probe. A WSL host reads as not Linux here, because `ndrive.sh` is its driver. The driver sets its core-file limit to zero, so a crash cannot write a password to disk.

The hourly check is a self-triggered action, so it is registered as `linux-browser-install-retry` and proven to settle: 1 h, 6 h, 24 h, then a hard stop after six attempts, with the count on disk so a restart cannot reset it. The daily Chrome upgrade records its attempt before starting, so a runner that cannot start still waits a day.

## 3. Level-of-abstraction fit

The rules live in the wrapper and driver because they need AT-SPI and X at input time. The Standards-Conformance Gate flags this against "A Decision That Can Block Must Live Where the Checks Can See It"; the answer, kept from the earlier rounds, is that the lint widens to `.py` so the decisions are declared and content-pinned. The install decision is TypeScript, where it can be tested; only the root steps are a script, and that script must outlive the server.

## 4. Signal vs authority compliance

Reference: `docs/signal-vs-authority.md`. Every refusal is a deterministic fact about the tool's own operation (an element under a point, a host, a marker) and refuses that operation only. None gates a message, a session or another agent. Nothing uses brittle matching to block a judgment call; the judgment rows stay with the agent and operator.

## 4b. Judgment-point check (Judgment Within Floors standard)

Judgment stays with the agent and operator, each with a floor in the spec's decision table: which host goes in `browserHost`, whether to use `close --force`, what to do after a stopped `typesecret`, whether to install on an existing agent, whether to make a new profile, and which of several matches to click. The invariants are deterministic facts at input time, with no LLM judgment in the driver.

## 5. Interactions

`migrateClaudeMd`'s hardened-helper rewrite sniffs the string `secret-drop-retrieve.mjs`, and the v3 card mentioning it would have silently skipped that rewrite on legacy agents; existing tests caught it, the card no longer names the file, and a test pins that. The helper now always peeks first, which changes existing callers in four small ways: `--consume` is two calls where there was one, a crash between them leaves the value for the existing cleanup, and a failed consume is now reported on stderr; `--names --consume` and `--consume` on a missing field no longer destroy the submission; `--run --consume` now consumes only on exit 0. Each is safer than before, and none removes a working path. `installBrowserScripts` rewrites scripts in place; the runner's `main "$@"; exit` body makes that safe. The Chrome upgrade takes `agent.lock`, so a launch can answer `ERR busy` for the length of an upgrade, once a day at most.

## 6. External surfaces

New routes `GET /browser/state`, `POST /browser/linux/install`. The file API now refuses `state/playwright-profiles/` and `state/xdrive/`, and backups skip them, on every agent: a person who read a profile file through the API can no longer. Nothing an agent does depends on that. New optional field `browserHost` on `POST /secrets/request`, shown on the Secret Drop form. New Linux agents make a durable root change at first boot: packages, Google Chrome, Google's apt source and key. Sites see an ordinary Chrome with accessibility on; whether passive risk scoring treats that differently is an accepted unknown.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

The person sees two new things. The Secret Drop form says in plain words which site a password is for. An existing agent asks one yes/no naming what gets installed, with no command to paste. There is no dashboard surface in v1. Nothing here needs a person to type a command or read a log.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design: profiles, the cookie, bindings, install results and `autoInstall`. They describe processes and packages on one machine, and copying a profile would copy credentials. `state/xdrive/` and `state/playwright-profiles/` are backup-blocked and classified never-sync, and `POST /browser/linux/install` is registered as a machine-local write, so `auto-install.json` cannot start a root install on another machine after a restore. `GET /browser/state` speaks for the machine that answers and says so. Joined machines get no automatic install: they read `not-built` and take the yes/no path.

## 8. Rollback cost

Revert the release; the scripts stay on disk and still work. `autoInstall: false` stops further installs. Packages, Chrome and the apt source stay on machines that installed them, removed by `apt-get remove` plus deleting three files (the key, the apt source, `/etc/default/google-chrome`); nothing depends on them. A `browserHost` request made on a newer server and retrieved by an older helper would fall back to plain stdout, the behaviour before this change.

## Evidence pointers

The pre-push gate caught the Secret Drop helper resolving its own folder with `URL.pathname`, which breaks on a path with a space; it now uses `fileURLToPath`.

`tests/unit/normal-chrome-linux-rules.test.ts`, `normal-chrome-linux-wrapper.test.ts`, `linux-browser-provision.test.ts`, `PostUpdateMigrator-normalChromeBrowser.test.ts`; `tests/integration/linux-browser-routes.test.ts`; `tests/e2e/linux-browser-boot-lifecycle.test.ts`. Live gate results go in the spec.

## Second-pass review

**Reviewer:** independent general-purpose subagent, reading this artifact against the diff.

Concern raised: a WSL install loop, sudo probes on agents that had not opted in, unmentioned file-API refusals, understated helper changes, two lint failures, and a possible core dump. It found no password leak to stdout, logs, argv or storage, and `markNewAgent`'s import is light and not circular.

All were resolved before this commit: WSL is left alone, the who-gets-it rule runs before any probe, helper flags stop at `--`, the driver sets its core limit to zero, and sections 2, 5, 6 and 8 above now state the rest. Concur with the review as revised.

Live gate: after the review, the run on real Linux found and fixed seven defects no stub could show: Chrome's rewritten process title, a link's text child counted as a second match, the address bar's dropdown counted as a tab, the wrong element chosen from several reported as focused, an `alert()` dead end, a latch surviving `close`, and Xlib's default error handler killing the driver. Results are in the spec.

## Class-Closure Declaration

`unbounded-self-action`, closure `guard`, citation `tests/unit/self-action-convergence.test.ts`, enforcement `ratchet`. Controller `linux-browser-install-retry`: paced 1 h, 6 h, 24 h, a hard stop after `MAX_INSTALL_ATTEMPTS`, the count on disk. Steady state is zero until an operator says yes.
