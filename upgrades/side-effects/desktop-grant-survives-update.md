# Side-Effects Review — Mac desktop permission survives an update that leaves the helper unchanged

**Version / slug:** `desktop-grant-survives-update`
**Date:** `2026-11-01`
**Author:** `echo`
**Second-pass reviewer:** `independent subagent, see below`

## Summary of the change

Macs now run the desktop helper from one kept copy at `~/.instar/desktop-helper/instar-desktop-host`, replaced only when the helper's source hash changes, with a fallback to any grant the installed copy still holds. When the source really changes, the probe carries `helperChange`, the unavailable reason says a person must re-allow it, and one self-closing Attention item is raised. Tier 1: a revert or `remoteDesktop.retainedHelper: false` fully undoes it, and the kept folder is inert. Size: about 5 source files plus 2 new modules, 2 build scripts, new tests. One review pass; effort proportional.

## Decision-point inventory

- `MacDesktopHost.trustedBinary` — modify — chooses between kept and installed copy of the same program.
- `DesktopHelperRetention.resolveFully` — add — decides whether a package may replace the kept copy.
- `DesktopHelperPermissionNotice.check` — add — signal only, decides whether to raise one notice.
- Readiness (`DirectDesktopAccess.probe`) — pass-through — unchanged.

---

## 1. Over-block

No block/allow surface on user input. The nearest thing: an older agent may not replace a newer agent's kept copy, and runs its installed copy, which likely has no grant until it updates. That lasts minutes under auto-update, and is the correct side to err on.

## 2. Under-block

A real source change still loses the grant; this change states that, it does not prevent it. Two agents racing the first install can both copy; rename is atomic and the bytes match when the source matches. A same-user process can edit the file and its record together, as it already can edit the installed copy.

## 3. Level-of-abstraction fit

Host-level retention sits under the adapter that launches the helper, reusing the idea of `ClaudeBinaryRetainer` (never mutate under a live process, fall back on any failure). Signing remains the right long-term layer; this does not replace it and its fixed path is what a signed helper needs.

## 4. Signal vs authority compliance

Compliant. The notice and `helperChange` are signals. Copy choice follows macOS's own answer, and no check blocks anything. `docs/signal-vs-authority.md` reviewed.

## 5. Interactions

- Own/inherited identity: unchanged and per-capability; a held input keeps its program and identity through a probe.
- Extra helper start: at most one packaged own-probe per 30 s while the kept copy lacks a grant, on top of the 500 ms recheck; one per 5 s only while a failed refresh is holding a good reading, which lasts at most 30 s.
- `desktop-locked-screen` (unapproved) plans digest-named directories; its spec should adopt this path. PRs #2557 and #2558 touch `MacDesktopHost.ts` and the Swift file; rebase conflicts are possible, and merging either is itself a source change that costs one re-grant.
- `/desktop/request-permission` targets the kept copy, which is the right entry for future grants.
- Test runs default off, so tests never touch a real kept copy.

## 6. External surfaces

New folder under `~/.instar/` shared by agents on a Mac. New diagnostics fields, additive. A new macOS entry appears in System Settings once granted. One HIGH Attention item per helper per Mac on a Mac that has `remoteDesktop.enabled`. Macs that are ready or feature-off see nothing. Operator text names the kept path, which they need to add it by hand.

## 7. Multi-machine posture

Machine-local by design: the grant, the helper and the screen belong to one physical Mac. The reason reaches peers through the existing availability relay, and the notice names the machine. Each machine raises its own item.

## 8. Rollback cost

Config flag or revert, next server start. Installed-copy grants are left untouched, so a Mac that re-granted only the kept copy would need one grant on rollback. Leftover folder is inert.

---

## Second-pass review

Independent reviewer raised seven concerns; all were addressed before commit. (1) A live session could lose a working installed-copy grant at the next recheck: the reading now follows the serving choice and a live stream pins it. (2) A probe cleared the serving choice before awaiting, so a spawn in that window used the ungranted copy: the choice now changes only after the readings. (3) Any probe failure abandoned the kept copy until restart: now three consecutive failures, with its own reason. (4) A notice claim could be consumed without an item: the claim is released on failure, an agent with no Telegram does not claim, and clearing no longer relies on memory. (5) Restoring a damaged copy kept the old proof, so a real loss was silent: restoring now clears the proof. (6) Notice claim was unlocked: now an atomic marker file. `retained.json` itself stays last-writer-wins; the worst case is one extra re-check. (7) A universal build from a source checkout could replace the kept copy: default now requires a `node_modules/instar` install.

**Reviewer:** independent subagent, second pass of the merged branch, 2026-11-01

**Confirming pass, 2026-11-02 00:34: concur.** The same reviewer re-read fixes 1-6 (0db70965a) and the merge with main (a7378a33c) and agreed. Known follow-up: when the installed copy serves and holds one permission, the reason should ask for both permissions on the kept copy, so setup and the reason name the same path.

The second pass raised six findings, all fixed in the following commit. (1) Blocker: a failed or timed-out probe of the installed copy was cached as null for 30 s with no last-good reading, so a Mac served by the installed copy's grant read as lost, a live session was revoked, and the notice check could raise a false item. A failure now never replaces a good reading: a failed refresh keeps it for one further 30 s window, retried every 5 s. (2) `helperChange` ignored whether the kept copy was in use, so after `retainedHelper: false` the operator was told to allow a path this agent does not launch. It now needs `resolution.source === 'retained'`. (3) Hashing, stat and record writes could throw and reject a probe. `resolve()` and `noteGranted()` no longer throw; unreadable kept bytes are restored from the package. (4) A failed copy retried on every resolve. It now waits one minute, doubling to a one-hour cap, and resets on success. (5) Guided setup's `helperPath` ignored the serving choice. It now reads the host's `servedHelperPath()`, the same choice `requestPermission` uses. (6) The retention e2e cleanup did not name the local-verify root; it now does, as its sibling tests do.

Local Verify then failed one unit test: `no-silent-fallbacks` counted the new `noteGranted` catch (495 over a baseline of 494). That catch logs once and the next probe retries, so it now carries the `@silent-fallback-ok` marker. Comment only, no logic change.

## Class-Closure Declaration

- `unbounded-self-action`, closure `n/a`: not an unbounded loop. A 15-minute reader raises at most one Attention item per helper source per Mac, held by an atomic marker and a stable conditionKey. A failed send retries at the next tick and lands on the same row. It restarts, kills and respawns nothing.
