# Upgrade Guide — vNEXT

<!-- assembled-by: assemble-next-md -->
<!-- bump: patch -->

## What Changed

`WriteAdmission.refusal()` builds `This write belongs to ${ownerNick ? ... : `machine ${ownerId}`}`.
`nicknameOf` was declared (`WriteAdmission.ts:168`), consumed (`:370`) and **supplied nowhere**, so
`ownerNick` was ALWAYS null and **every refusal took the raw-hex branch** — the readable branch was
unreachable.

Measured with controls: `nicknameOf` at the construction site = 0; CONTROL `selfNickname` = 1.

This is the more consequential half of the same gap: the previous change let a machine name ITSELF,
this one lets it name the OTHER machine — the entire point of a refusal that says where to re-send.

Both failure paths degrade to `null` (the accessor may be unset; an unregistered machine has no
nickname), which is exactly what the message already fell back on — so it can only replace hex with a
name.

**Where it came from:** my own class-closure note on the previous change, which named `nicknameOf` as
not addressed.

## What to Tell Your User

When your agent runs on more than one machine and a write is refused, the message tells you which
machine owns it so you know where to go instead. It was naming that machine by a long string of hex
instead of its nickname — the friendlier wording existed but could never be reached. It now says "the
Mac Mini" where it used to print an id. If you run one machine, nothing changes for you.

## Summary of New Capabilities

None. No new command, endpoint or setting — an existing refusal message can now reach its readable form.

## Evidence

- `tests/unit/write-admission-self-nickname.test.ts` — 11/11 green.
- Negative control: 1 of 11 fails against the unwired tree, naming the line and the consequence; the
  other 10 pass both ways including the anti-vacuity control.
- Real `tsc --noEmit` exit 0. `server.ts` restored byte-exact after the control.
