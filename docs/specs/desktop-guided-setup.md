---
title: "Remote Desktop guided setup"
slug: "desktop-guided-setup"
author: "echo"
tier: 2
parent-principle: "Mobile-Complete Operator Actions"
eli16-overview: "desktop-guided-setup.eli16.md"
approved: true
approved-by: "echo, on the operator's 2026-11-01 directive that Remote Desktop setup be streamlined and foolproof, relayed in the build brief. The operator has not read this spec; the claim tradeoff in the overview is raised for his decision on the PR."
review-convergence: "2026-11-02T00:44:44.217Z"
review-iterations: 6
review-completed-at: "2026-11-02T00:44:44.217Z"
review-report: "docs/specs/reports/desktop-guided-setup-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 3
cheap-to-change-tags: 0
contested-then-cleared: 0
---

# Remote Desktop guided setup

## Problem statement

The operator's request (2026-11-01): Remote Desktop setup must be "as streamlined
and automated as possible. If anything is required of the user, they must be
hand-held through the required steps and the result should be extremely easy and
foolproof."

What he went through that day:

1. Three Macs had `remoteDesktop` off, so an agent had to patch config and restart
   each one. The dashboard and app had no way to do it.
2. On a locked Mac, a permission prompt does nothing useful, and nothing said so.
3. The Mini showed prompts but never listed `instar-desktop-host`. Adding it by hand
   with + gave no feedback and the list stayed empty, while the live grants read true.
4. The M5 listed five entries. A prompt named tmux.
5. The app showed "Mac Lan" for the machine the pool calls Mac M5 Pro.

### Measured causes

- **Mac Lan.** `/desktop/targets` shows each peer's self-reported label, which is that
  peer's own registry nickname. Read over SSH on 2026-11-01, the M5's registry says
  `Mac Lan` for itself and `Dabombs Mac Studio` for the Studio; the Studio's says
  `Mac M5 Pro` and `Mac Studio`. A rename made on one machine did not reach the
  other's copy. The label to show is the front's own pool nickname.
- **Five entries.** The Settings list cannot be read and the permission databases
  refuse read access over SSH, so the number 5 is not explained. What was measured on
  the M5: 18 copies of the helper on disk, signed ad hoc under 2 identifiers with 4
  distinct code hashes; the M5 is a Local Verify peer whose verify runs each build a
  fresh `dist/native/instar-desktop-host`; in 6 hours `tccd` logged permission checks
  for over 20 distinct helper paths, with 2 distinct Node programs as the responsible
  process. Those are plausible sources of extra rows, not proof. Signing is handled
  by the locked-screen spec and is not touched here.

## Proposed design

One action, "Set up", on each machine, from the Desktop page and the app. It needs
only the dashboard PIN session. Everything after it is driven by the live check.

### Guide (pure)

`src/core/DesktopSetupGuide.ts` turns one machine's live status into one step:
`{ state, ready, title, detail, actions, fallback?, note? }`. It holds no state and
all wording, so the dashboard and app show the same words. Order: unreachable, too
old to answer, tied to another front, companion failed, unsupported, restarting, off,
restart needed, cannot start, then person-at-the-Mac states (nobody signed in, another
user, sign-in window, locked, session unknown, no display), then Screen Recording, then
Accessibility, then ready.
`ready` comes only from the live probe's status. Permission prompts and the Settings
button are offered only when the Mac reports an active unlocked session.

Wording rules: success is the live check; the permission steps say plainly that the
Settings list can be empty or show several entries and that this page asks the Mac
itself; allow only a pop-up naming instar-desktop-host, and a pop-up naming tmux or
another program is declined because that grant can change at a restart.

### Target actions

`src/core/DesktopSetupTarget.ts` runs on every machine, whether desktop is on or off.
It is reached locally, or from the front over the signed machine route
`POST /api/desktop/setup`:

- `status` returns live diagnostics, the config, whether a restart is already waiting
  on the supervisor, and the helper's real path.
- `turn-on` writes `remoteDesktop { enabled: true, frontMachineId }` to the machine's
  own config and requests a supervised restart. The ownership check and the write are
  one synchronous step against the file, not memory, so two senders cannot both win
  inside this server, which is the only writer of this block at runtime. A CLI or a
  hand edit at that instant is last-writer-wins, as every config write already is.
  Siblings are preserved. A machine already running that config does nothing. A
  machine whose restart is already waiting reuses it. Native Linux refuses.
- `turn-off` writes `enabled: false`, ends live access, and restarts. It is the undo. `activate-config`
  cannot do this: it answers 409 unless desktop is enabled.
- `show-prompt` runs the existing `requestPermission`, not awaited.
- `open-settings` runs `/usr/bin/open` with one of two fixed Privacy URLs chosen by
  `pane`. Nothing from the request reaches the command line.

`show-prompt` and `open-settings` are macOS only, need desktop access constructed,
and need positive evidence of a session: `sessionActive === true` and
`screenLocked === false`.
Missing diagnostics count as no evidence, and the guide says the session is unknown
rather than locked. The prompt, each settings pane, and turn-on/off are each limited to once a
minute per target, as separate limits. Turn-on/off reserves its slot before any wait, so
overlapping changes are refused. Turn off on the machine's own page has no limit. Every accepted change appends to `logs/desktop-setup.jsonl` on the target:
time, action, sender machine, outcome.

### Authority on the target

A target accepts a peer's `turn-on` only when the authenticated sender is the front
named in the body, and the target's `frontMachineId` is unset or already that sender.
The front comes from the machine signature, never a separate claim. `show-prompt`,
`open-settings` and `turn-off` need the sender to match the configured front, and
`turn-off` works even when that front is itself already off. `status` is open to any
authenticated paired machine, because a machine that is off must read its peers to
find an existing front: it exposes the desktop diagnostics, the front id and the
helper's path, and no secret.

What is new, stated plainly: a paired machine can name itself front on a target that
has none, without that target seeing a PIN. The target cannot verify a PIN: each
machine's PIN stays on that machine. Secret sync is dark and receive-only by default,
so this is not "already covered" by other trust; screen and input are more than a
paired machine reaches today, and `devGatedFeatures` records this flag as needing an
explicit local operator enable. This change moves that enable from a local config
edit to a PIN at the front. The PIN protects the front's page and routes. The target
enforces machine-key authority alone, so whoever holds a paired machine's key can make
this call directly. A one-use signed assertion was considered and rejected: the same
key would sign it, so it adds nothing against that.

The limits on it:

- A Mac with no grant shows nothing: macOS grants need a person at the Mac.
- A Mac that already holds a grant can be reached this way. That is the residual risk.
- On a machine without the gate, a peer cannot claim it at all.
- Detective control: the claim is written to the audit before the config, and a claim
  that cannot be recorded changes nothing. One HIGH attention item then names the machine and how to undo it, before the restart. That notice
  depends on Telegram: a missing channel, an error or a slow send leaves the claim
  standing, the audit records it, and the page says so. A hub post that fails inside the
  adapter may not surface. The audit is the guarantee; the notice is not.
- Undo: each machine shows Turn off in its row, on the front's page and on its own
  page, whichever machine is the front. A machine may always manage itself. Turn off
  ends any live grant at once and refuses new ones, because a restart can wait up to an hour.
  On the machine's own page no rate limit stands in front of it. Live access ends before
  the config write, so a failed write cannot leave it running.
  Turn off pressed on the machine's own page also sets `peerClaimRefused`, so the same
  key cannot turn it back on; only that machine's own page clears it. The front's own
  Turn off does not, so the operator can change their mind from the front.
- Every claim gets its own notice id, a unique id per claim event, so an open notice
  cannot swallow a repeat. A
  machine with no notice channel, or a notice slower than 4 seconds, counts as failed.

The operator decides this tradeoff; the PR and overview name it.

### Front routes

`src/server/desktopSetupRoutes.ts`, all behind the existing tunnel/loopback check and
a verified dashboard operator session. A Bearer token alone is refused.

- `GET /desktop/setup`: this machine and up to 7 peers, one step each.
- `GET /desktop/setup/:machineId`: one machine, for polling after an action.
- `POST /desktop/setup/:machineId` `{ action, pane? }` (needs `X-Instar-Request: 1`):
  runs the action, answers the fresh step. A refusal carries fixed wording chosen by
  code, never the peer's text, plus the fresh step.

Restart states: the target's own `restartPending` while it can answer, and a 200-second
window on the front while it cannot (WSL boot can take 140 seconds).

Front choice: the configured `frontMachineId`, else this machine, and the row says it
becomes the front. Before founding one, a machine reads its peers, on the list and
again on the action itself; if any names a front, the page sends the operator there.
Two machines can still each become a front if neither can reach the other at that
moment; each target then takes the first and refuses the second by name. Until this
machine is on, only its own row can act. If the config names another machine, actions
on other machines refuse with `front-elsewhere`, and its own row keeps working. Moving a front stays an agent action through `PATCH /config`, as it
is today, so a dead front means asking the agent; the step says so.

Peer calls use a signed fetch that does not need the mesh broker, keeping the same
URL gate. A peer's reply is untrusted: bounded to 8 KB, every field type-checked,
unknown fields dropped. 404 reads as "needs an update", anything else unanswered as
unreachable, a refusal as its code.

`ready` is the live probe's status plus the same identity-key check the picker uses,
so setup never calls ready what the picker would refuse. A machine that works through
an inherited grant reads as ready with a note that a restart can change it, and a
button asking for the helper's own permission. The note goes when the live check shows
the helper's own grant. Nothing promises it lasts: signing is not touched here.

### Label fix

`/desktop/targets` uses the front's own pool nickname for a peer and falls back to
the peer's label only when the front has none.

### Surfaces

- Dashboard: new `dashboard/desktop-setup.js` renders one row per machine, ready or
  not, under the picker, replacing the short reason notes. It polls the machine
  being worked on every 4 seconds, doubling up to 60 seconds after a failed check, and
  stops when ready, after 10 minutes, or when the operator leaves. It never runs an
  action by itself. When
  `/desktop/targets` answers 503 the setup list is what the operator sees.
- App (`apps/instar-ios`, its own repository): `DesktopAPI` gains the three calls,
  and `RemoteDesktopView` renders the same server steps. The app's copy of the wording
  is none.
- Awareness: CLAUDE.md template and migration, CapabilityIndex.

## Maturation plan

- **test-agent-live:** the production boot test turns a throwaway agent on through the real routes and a real config write. Real macOS prompts are not exercised there.
- **dev-agent-live:** Echo's machines, dev-gated by `remoteDesktop.guidedSetup.enabled` (omitted ⇒ live on a development agent); first use on a real Mac is an owner-run pass over each state, ending in a real desktop session.
- **fleet:** only after the graduation criterion holds, and after the operator has decided the peer-claim tradeoff named in the overview.
- **graduation criterion:** each of the operator's Macs and the Windows PC taken from off to a working session through this flow with no agent config edit and no defect left open.
- **dark-window:** fleet-dark until the criterion holds. The page's routes answer 503 there and the page shows what it shows today. The gate also decides, on each target, whether a peer may turn it on. `status`, prompts and Settings for an already-named front are not gated, so a machine already on can still be walked through its permissions; a machine with the gate off and desktop off says so and asks for that machine's own page.

**Rollback:** `remoteDesktop.guidedSetup.enabled: false`.

## Decision points touched

- `DesktopSetupTarget` front check (invariant): an exact identity comparison on who may claim a machine.
- `DesktopSetupTarget` session check (invariant): prompts need positive evidence.
- `desktopSetupRoutes` PIN session and transport guard (invariant).
- `DesktopSetupGuide` next step (invariant): a deterministic mapping for presentation that gates nothing; admission stays with `DirectDesktopAccess`.

## Multi-machine posture

Proxied on read: one front fans out to peers, tolerant of a dark peer. Config and
audit stay machine-local by design; each machine owns its own enablement. A peer on
older code answers 404 and reads as "needs an update"; it is not changed.

## Rollback

To turn a machine off, use Turn off on the Desktop page. Revert the PR and the routes
and page go away, and machines already on stay on. The undo that survives the revert
is `PATCH /config` with `remoteDesktop.enabled: false` and a server restart.

## Testing

Unit: every guide state on both sides, including locked versus unlocked and wording
checks; target front match, idempotency, config preservation, fixed URLs, rate limit.
Integration: routes over HTTP with PIN required, Bearer alone refused, peer failures,
label fix. E2E: production boot, feature alive with desktop off and with it on.

No real machine's config or prompts are touched by tests or while building this: the
building session is read-only on real machines by instruction. So the Live-User-Channel
proof on a real Mac has not been run; commitment CMT-1206 holds that run. It runs on the throwaway path where possible
(a throwaway agent's dashboard, real HTTP, a fake peer), and the Mac-only steps (a real
prompt, the real Settings page, a real turn-on) stay open until an owner-authorized
run. The PR says so, and nothing claims done before that run.

## Open questions

None.
