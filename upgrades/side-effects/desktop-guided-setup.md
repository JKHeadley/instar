# Side-Effects Review — Remote Desktop guided setup

**Version / slug:** `desktop-guided-setup`
**Date:** `2026-11-01`
**Author:** `echo`
**Second-pass reviewer:** `required, see the end of this file`

## Summary of the change

Tier 2 (security-sensitive: a new way to enable full-control remote desktop across
machines). One "Set up" action per machine on the Desktop page and in the app, needing
only the PIN session. New pure guide (`DesktopSetupGuide`), target actions
(`DesktopSetupTarget`), PIN routes (`desktopSetupRoutes`), signed peer route
(`/api/desktop/setup`), dashboard module (`desktop-setup.js`). The picker's peer label
now comes from the front's pool nickname. Size: about 900 lines of source and page,
plus tests. Effort: 6 spec review rounds with one outside model, the Tier-2 cap, each finding real; commit attempts are
in the PR body. Proportion is in line with a security-sensitive feature.

## Decision-point inventory

- `DesktopSetupTarget.turnOn` front check — add — exact identity match, sender must be
  the front and the target must have no other front.
- `DesktopSetupTarget.run` prompt gate — add — positive evidence of an unlocked session.
- `desktopSetupRoutes` guard — add — PIN session + transport check on all routes.
- `DesktopSetupGuide` — add — presentation only; no authority.
- `DirectDesktopAccess` admission — modify — a new start is refused while
  `remoteDesktop.enabled` is false, so Turn off holds during a deferred restart.

---

## 1. Over-block

A machine whose front is dead or decommissioned refuses every new front; the operator
must ask the agent to change config. A page on a machine that is off, with a peer
naming a dead front, is sent to that dead front. Both are recoverable through
`PATCH /config`. A Mac reporting no session diagnostics gets no prompt, even if a person
is there. The once-a-minute limit can make a fast retry wait; the page says so.

## 2. Under-block

A stolen paired-machine key can claim a machine with no front and, on a Mac that
already holds a grant, reach its screen. Detection (attention item, audit) and undo are
the only controls; this is the named residual risk, for the operator to accept. A
claim that cannot be audited does not happen. The attention item can fail: the page says
so for a missing channel, an error or a slow send, but a hub post failing inside the
adapter may not surface. Turn off ends live access at once; pressed on the machine itself, it also
stops that peer turning the machine back on.

A machine can look ready and still fail when its grant is inherited; the note says so.

## 3. Level-of-abstraction fit

Right layer. The guide is pure and shared; the target owns its own config; the front
only relays. Wording in one place means the app has no copy to drift.

## 4. Signal vs authority compliance

Compliant per `docs/signal-vs-authority.md`. The guide is a signal with no authority.
The new blocks are exact identity comparisons and a session check, which are structural
facts, not brittle judgment. Admission stays with `DirectDesktopAccess`.

## 5. Interactions

- Config: the write is synchronous and the check reads the file, so it cannot
  interleave with `PATCH /config` in-process. A CLI writing the file at the same moment
  is last-writer-wins, as it already is.
- Restart: uses the existing supervised-restart flag and reuses a waiting request. The
  supervisor can defer it; the page reads that as restarting.
- `activate-config` and `request-permission` are unchanged and keep their own limiter,
  so an agent call and a page call can each show a prompt within a minute.
- Dashboard PIN sessions are in memory: restarting the front ends them, and the page
  asks for the PIN again.
- Overlaps with `echo/desktop-multi-display`: `dashboard/desktop.{html,js,css}`,
  `routes.ts`, `AgentServer.ts`, `CapabilityIndex.ts`, `templates.ts`, `MacDesktopHost.ts`.
  All additive and small. `echo/desktop-locked-screen` has no source changes yet; its
  spec changes signing, and the locked state here will need new wording when it lands.

## 6. External surfaces

A machine's Instar server restarts when set up, which briefly drops its conversations'
connection. A HIGH attention item reaches the operator on a peer claim. macOS prompts
and System Settings open on a Mac only after a press on the page.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

1. Leads with the primary action: yes. Each machine's row opens with its one next step and the button for it, visible on arrival under the picker. The written fallback is the only thing collapsed.
2. Zero raw internals as primary content: yes. Rows show the pool nickname and plain sentences from the guide; machine ids, states and codes are never displayed. The helper's path appears only inside the fallback, because a person must paste it.
3. Destructive actions de-emphasized: yes. Turn off is a quiet underlined link last in the row, and it asks for confirmation.
4. Plain language + phone width: yes in wording, checked in jsdom only. Buttons wrap and long paths break, by the CSS rules added here. It has not been opened on a real phone; that run is held by CMT-1206.

## 7. Multi-machine posture (Cross-Machine Coherence)

Proxied on read: the front fans out over signed peer calls, tolerant of a dark peer.
Config, audit and rate limits are machine-local by design, since each machine owns its
own enablement. A peer on older code reads as needing an update and is untouched.
One voice: only the claimed machine raises the notice. The label fix reads the pool.

## 8. Rollback cost

Revert the PR. Machines already turned on stay on and keep working; Turn off goes away,
so an agent then uses `PATCH /config` and a restart. No data migration. Dev-gated by
`remoteDesktop.guidedSetup.enabled`: dark on the fleet, and nothing turns on without a
person pressing Set up.

## Second-pass review

Two independent reviews. First: Concern raised (Turn off could be silently reversed by
the same key; did not cut live access until a deferred restart; no Telegram gave no
signal; a hung notice could block the restart; 503 read as needs-update). All fixed.
Recheck: confirmed those fixed and raised that Turn off wrote config before cutting
access, and that a hub post failing inside the adapter may not surface. The first is
fixed, the second is stated here and in the spec. Concur with the review as amended.


## Class-Closure Declaration

`unbounded-self-action`, closure `n/a`: one-shot user-driven action, not a self-triggered loop. Every restart needs a person's press behind the PIN session, and each target limits it to once a minute.
