# Upgrade Guide — team-switches-agent-wide

## What Changed

The settings a team needs (memory privacy and app conversations) now turn on for the whole agent. `GET /mobile/team/context` gains `teamSwitches`: one entry per setting that is off somewhere, `{ setting, on: false, offOn: [machineIds], action: 'turn-on-everywhere' | 'update', requested: [machineIds] }`, counting this machine and every peer. `machinesBelowFloor` is unchanged for older apps.

New owner route `POST /mobile/team/switches/turn-on` with body `{ setting }` (owner phone, Face ID, signed line `team-switch-on <setting>`). The machine that takes the tap sends a machine-signed `POST /api/team-access/switch-on` to every peer, which sets the setting in its own config (only ever on, only these two settings) and requests its own supervised restart; this machine applies it last. The answer lists every machine with its result (`applied`, `already-on`, `unreachable`, `needs-update`, `refused`, `failed`). Unreached machines are kept in `state/team-access/switch-requests.json` and retried on the team exchange tick for up to 7 days. The existing `POST /mobile/team/memory-privacy` now uses the same whole-agent path.

The invite and grant refusal `machine-below-floor` now carries `teamSwitches` and says to turn the setting on for the whole agent (or update), instead of suggesting a machine be marked gone.

## What to Tell Your User

When you add teammates in the app, the People page no longer lists each of my computers separately. If something needs turning on, you see it once, for the whole agent, and one Face ID tap turns it on everywhere. If one of my computers is asleep, it gets the change when it wakes, and the page tells you which one is still catching up.

## Summary of New Capabilities

| Capability | How to Use |
|---------|-----------|
| Turn memory privacy or app conversations on for every machine at once | The owner taps the one line on the app's People page and confirms with Face ID |
| One summary line per setting instead of one row per machine | Automatic, in the People page data (`teamSwitches`) |
| Machines that missed the change are retried and listed | Automatic |

## Evidence

- `tests/unit/team-switches.test.ts`: summary shape, fan-out order, per-machine results, unreachable peer retried across a restart, undialable machine listed.
- `tests/integration/team-access-routes.test.ts` (team settings block): owner Face ID turn-on, legacy route fans out, member/bearer/unsigned/wrong-setting refused, refusal text no longer says gone.
- `tests/e2e/team-switches-two-machines.test.ts`: two real servers; the owner's tap on one sets `memoryPrivacy.enabled` in the other's config over the signed machine route and writes its planned-restart flag; a third registered machine with no address is listed unreachable and kept for retry.
