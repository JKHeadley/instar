# Codex device-limit tripwire

<!-- bump: minor -->

## What Changed

OpenAI now limits how many paid personal ChatGPT accounts one device can use ("Device limit reached"). Instar can now notice when a Codex account on a machine hits that limit and stop knocking. Jev, with a Luna referee running on another Codex account, judges whether the Codex app-server's own refusal means a device-limit lockout; no phrase match decides anything. Two separate refusals 5–60 minutes apart, each freshly judged, plus another Codex account on the same machine still reading clean, bench the account on that machine only: it is skipped for new work, its live conversations move to another Codex account, and the sign-in repair stops trying (today it would retry up to 12 times). A Codex session's screen or a sign-in page can only ask for a fresh check or stop one repair. Two clean reads release a bench; the switch, a per-machine ignore list, or setting the account active undo it. Live on development agents; off on the fleet until its graduation criterion is met.

## What to Tell Your User

If one of your Codex accounts hits OpenAI's new per-device limit on a machine, I'll stop using it on that machine (it keeps working on your other machines), move any conversation on it to another account, stop trying to sign it back in there, and send you one message for that machine. Signing out of another account does not free a slot, so the real choice is which machine keeps which accounts; leaving it benched is fine, and you can tell me to keep using it there anyway.

## Summary of New Capabilities

`statusCause` on every `GET /subscription-pool` account row and a per-machine `deviceLimit` block; `logs/codex-device-limit.jsonl`; switches `subscriptionPool.codexDeviceLimit.enabled` and `.ignoreAccounts`; judge tuning under `intelligence.jevCodexDeviceLimit`; the sign-in helper's new `device-limit` hard line; one per-machine Attention row (`codex-device-limit:<machine>`).

## Evidence

Approved converged spec `docs/specs/codex-device-limit-tripwire.md` (6 review rounds, GPT cross-model). Unit, integration and production-path lifecycle tests are in the PR.
