# Side-Effects Review — agent survives a reboot after an npx install; new agents can pair a phone

**Version / slug:** `install-stable-service-and-pairing`
**Date:** `2026-11-03`
**Author:** `Echo`
**Second-pass reviewer:** `independent subagent; concern raised (one blocker, five should-fix), all fixed, then concurred (see the end of this file)`

## Summary of the change

A fresh install of Cirrus (Ubuntu 24.04, `npx -y instar@latest install`, 2026-11-03) found three defects, recorded by topic 136110 in the shared ledger. Driven by `docs/specs/install-experience.md`.

1. **The agent did not survive a reboot when installed through npx.** The Linux unit was built from `findInstarCli()`, which under npx falls back to a bare `instar`, so it got `ExecStart=instar server start ...` (systemd: 203/EXEC, restart loop from the first second) and a PATH into `~/.npm/_npx/<hash>/`, which npm may clear. Linux units now start the same way macOS does: through the agent's boot wrapper (`/bin/bash .instar/instar-boot.sh ...`), which runs the agent's own copy of instar in `.instar/shadow-install` (the copy the auto-updater keeps current) and reinstalls it once if it is missing. The wrapper now runs node as a child and passes TERM, INT and HUP on to it: under systemd the wrapper's bash is the unit's main process, and with `KillMode=process` a stop or restart signals only that process. npx cache folders and the folders `npm exec` adds are dropped from the unit's PATH, and the node running setup is put first. The wrapper's one-shot reinstall now also finds `node` on PATH and at `/usr/bin/node` (it looked only in Homebrew folders, so it could never heal on Ubuntu). `findInstarCli`, now unused, is removed.
2. **The failure was invisible.** The installer starts its own server before installing auto-start, and that server holds the agent's single-instance lock, so a broken unit and a working one looked the same until the next reboot. The installer now gives the agent its own copy of this instar version first, installs auto-start, stops its own server, and waits up to two minutes for the service's server to answer. If it never answers, the installer removes the service (so the two never fight over the lock), starts its own server again, and says plainly that the agent won't come back after a reboot. If the copy can't be made (no network, or a version that is not on npm), the service is still installed. Its wrapper then makes the copy at first start, and the handover shows whether that worked.
3. **A fresh agent could not pair with the iPhone app.** `mobilePairing` is development-agent gated, so it was off. An agent the installer creates now gets `mobilePairing` on (pairing, multi-route, native conversations, media), unless the config already has a `mobilePairing` setting.
4. **The installer ended with a localhost dashboard and no pairing step.** It now asks the running agent for a one-time pairing link and prints it with the dashboard on the address the phone can reach (the agent's Tailscale HTTPS name), and says where the 6-digit code appears (the dashboard's Phones tab, or Telegram when there is an owner). On a computer with no browser, no address a phone can reach and no Telegram, it prints the PIN, then stops and asks for Tailscale on both devices, then `instar install --resume`. With Telegram, or on a desktop, it ends at the local dashboard. It prints a line before asking for the link, and does not ask at all when pairing is turned off.

Existing Linux agents whose unit has a bare or npx-cache `ExecStart`, or an npx-cache PATH, get the unit rewritten by a new `PostUpdateMigrator` step (`migrateSystemdStableStart`), which backs the old unit up first. It enables the rewritten unit but does not start it: the agent is running some other way at that moment, and a second start would only lose the single-instance lock and loop. The new unit takes over at the next reboot or service restart.

## Decision-point inventory

- How the Linux unit starts the agent — modify — always the boot wrapper.
- Whether an existing unit is rewritten — add — only when it cannot start on its own (bare name or npx cache).
- Whether auto-start counts as working — modify — only after the service's own server answers.
- Whether a new agent has phone pairing — modify — on for installer-created agents; an existing setting wins.
- How the install ends — modify — pairing link + reachable dashboard; a server without an address waits for Tailscale.

## 1. Over-block

A server with no Tailscale address now stops at the last step instead of finishing with a localhost URL nobody can open from there. The agent is already running and starts after a reboot; only the final hand-off waits. A desktop with a browser is unaffected.

## 2. Under-block

Pairing on by default means the pairing routes answer on a new installed agent. Pairing still needs a minted one-time link (Bearer token) and a 6-digit code read on the PIN-locked dashboard or in the owner's Telegram DM; a paired phone gets only the fixed device route set. Pairing security itself is unchanged; only its default for installer-created agents is. One exposure change does come with it: `multiRoute` makes the agent run `tailscale serve` at boot (HTTPS 443 → its port) when 443 is free, so the agent's API and dashboard answer over HTTPS to every device on the person's tailnet, shared devices included, protected by the Bearer token and the dashboard PIN as on localhost. That is the address the phone needs; without it the app has no way in on a server. Native media adds the app's upload route (device-signed only). Existing agents are untouched.

## 3. Level-of-abstraction fit

The unit text is built in one pure function (`buildLinuxSystemdUnit`), used by `installAutoStart` and so by every unit writer (CLI, server/lifeline self-heals, migrations). The handover and the pairing ending live in the installer steps, the only place that starts a server before auto-start exists.

## 4. Signal vs authority compliance

No message is gated. The handover check is a health probe; its only consequence is what the installer says and whether it restarts its own server.

## 4b. Judgment-point check

None.

## 5. Interactions

- **Linux units regenerated by any writer** now use the boot wrapper. An agent with no shadow install gets one at its next service start (the wrapper's one-shot reinstall, now able to find node on Linux). An agent installed globally with an absolute ExecStart is NOT rewritten by the migration (it can start), only when something else regenerates its unit.
- **Mama PC (WSL, Linux):** its unit has an absolute ExecStart outside the npx cache, so the migration leaves it alone.
- **Single-instance lock:** the handover relies on it: the installer's server is stopped, then the service's start takes the lock.
- **`instar server stop`** only stops the tmux server, never the service, so the handover never stops the service itself.
- **`instar server restart` on Linux** (systemctl stop, then start) depends on the wrapper passing the stop signal on. Without that, the old node kept the port and lock and the restart did nothing; the wrapper's trap closes it (tested with a real process, and live).
- **Globally installed Linux agents with no shadow copy** whose unit something regenerates: the wrapper's one-shot reinstall at the next start installs `instar@latest`, which is the same behaviour macOS agents already have.
- **Auto-updater:** unchanged. It already installs into `.instar/shadow-install`, the copy the wrapper runs.

## 6. External surfaces

The installer runs `npm install instar@<this version> --ignore-scripts --prefix <agent>/.instar/shadow-install` and `npm rebuild better-sqlite3` (the same pair the auto-updater runs), and calls the agent's own `POST /mobile/pairing-codes` on 127.0.0.1. The pairing link is printed to the terminal only, never to the install log.

## 6b. Operator-surface quality

Every new message says what happened and what to do next. No config field is named.

## 7. Multi-machine posture (Cross-Machine Coherence)

machine-local-justification: physical-credential-locality. The service unit, the agent's own copy of instar and the pairing link are this machine's.

## 8. Rollback cost

Revert the commit. A rewritten unit keeps working after a revert (it starts the boot wrapper, which still ships), and its pre-migration copy is next to it as `.bak-<time>`.

## Conclusion

Safe to ship once the live run below passes.

## Evidence pointers

- Tests: `tests/unit/systemd-stable-start.test.ts` (the Cirrus unit is recognized; the new unit is absolute, through the wrapper, without npx PATH; wrapper finds `/usr/bin/node` and passes `bash -n`), `tests/unit/systemd-killmode.test.ts` (now reads the built unit), `tests/unit/install-flow.test.ts` (handover success, failure with restart, no service without a copy, pairing ending with a reachable dashboard, Tailscale ask on a server, desktop fallback, pairing default and existing setting kept, link origin parsing).
- Related suites: 202 unit files (install, setup, PostUpdateMigrator, mobile) and the two launchd boot-wrapper e2e files pass.
- Live run: see the next section.

## Class-Closure Declaration

- defect class: `unbounded-self-action`
- closure: `n/a`
- reason: install-time steps and a one-time unit rewrite, not a self-triggered loop.

## Live run

Fresh Hetzner server (Ubuntu 24.04, cx33, 2026-11-03), Node 22 from NodeSource, the branch packed and run as `npx -y ./instar-1.3.1627.tgz install` (the npx path that broke on Cirrus), Claude signed in with a pasted setup-token.

- First version: the service file read `ExecStart=/bin/bash .../.instar/instar-boot.sh server start --foreground --dir ...`, the service was active through the wrapper and the agent's own copy, and the ending asked for Tailscale (no Tailscale on that server). The PATH still carried `npm exec`'s folders; that is now filtered.
- After the review fixes, a fresh run from a wiped home: PATH was the plain system PATH; `mobilePairing` was on in the new agent's config; the ending printed the PIN, then the Tailscale ask.
- `systemctl --user restart`: the old node logged "Shutting down..." (signal passed on), systemd logged a clean "Stopped", and a new node took over.
- Real reboot: the machine was up at 19:27:51 UTC, the service active at 19:28:10, and the first SSH login at 19:28:30, so the agent started at boot with nobody logged in. Health 200.
- Not run live: the Tailscale success ending (link and reachable dashboard), because this server is not on a tailnet. Unit-tested against the mint route's response shape (`{ link, originKind }`). 136110 runs the next Cirrus install with Tailscale up, which covers it.
- Seen and already filed: the agent's config.json was back at 664 after the server ran (its own atomic rewrites; fb-bb921dc1-e5b).

## Second-pass review

Independent subagent, 2026-11-03, read the diff before this file. **Concern raised:**

1. **Blocker:** under systemd the wrapper's bash is the main process and `KillMode=process` signals only it; bash died and node kept the port and lock, so `instar server restart`, uninstall and teardown on Linux left the old server running. Fixed: the wrapper passes TERM/INT/HUP to node and waits for it (real-process test; live restart).
2. The migration started the rewritten unit next to the running agent, which then looped on the lock. Fixed: `installAutoStart(..., { noStart: true })`.
3. Up to about 75 s of silence while asking for the link. Fixed: a progress line; no request when the config turns pairing off; 503/404 end the retry.
4. A headless agent with Telegram was held for Tailscale, and the PIN wasn't shown on that path. Fixed.
5. The handover fallback left the service fighting the installer's server. Fixed: the service is removed first.
6. A failed copy blocked auto-start, a regression on macOS. Fixed: auto-start still installs; the handover tells the truth.
Notes 8 (ExecStart prefixes), 9 (a misplaced doc comment) and 10 (state the `tailscale serve` exposure) were also fixed.

The same reviewer re-read every fix: **Concur.** Remaining notes, accepted: the wrapper's one-shot reinstall installs `instar@latest` (as on macOS; the installer now makes the copy ahead), and the Tailscale success ending is covered by unit tests until the next Cirrus install with Tailscale up.
