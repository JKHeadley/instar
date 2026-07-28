# Update-message topic routing — the plain-English version

## What's wrong

Update-related messages keep landing in random topics instead of the dedicated **Updates** topic. You saw two of them in a Case Study topic and flagged it.

When I dug in, this isn't one bug. There are three different places that emit "update-ish" messages, and each picks a topic differently. Two pick the wrong one.

1. **The lifeline's "I'm behind the server" alert** goes to whichever topic you happened to be typing in. If you were chatting in a topic called "Case Study" when the server bounced to a new version, the heads-up about the version mismatch lands in Case Study. The lifeline is treating the inbound conversation as the destination instead of the Updates topic — that's just wrong wiring.

2. **The "Applying update — restarting now" pre-restart heads-up** routes through a general-purpose notification helper that, when no topic is specified, defaults to the **Attention** topic, not Updates. Every other update-class message (the auto-updater's own "just updated" note, the restart-confirmation note, the API endpoint that other agents call) correctly picks Updates. This one path slipped through.

3. **My own conversational "shipped X" / "back up and running on vN" messages** go to whatever topic the session I'm in is bound to. There's no rule today that tells me, the agent, "ship/update narration belongs in Updates, not the active conversation." So I default to "wherever I'm chatting." Both messages in your screenshot are this pattern.

## What I'm building

**Three small fixes, all pointed at the same outcome: update-class messages land in Updates.**

- **Lifeline 426 alert** reads the Updates topic from state (same way every correct path does) and sends the alert there. If Updates isn't configured for some reason, it falls back to the Lifeline topic — because a version-skew warning *is* a delivery health problem, and Lifeline is the always-reachable channel for delivery-health stuff. The inbound topic stops being the destination.

- **Pre-restart "applying update" heads-up** explicitly passes the Updates topic to the notification helper, so it stops defaulting to Attention. If Updates is unconfigured, the old default (Attention) still applies — no regression for any agent that hasn't been set up with an Updates topic yet.

- **Agent-narration template guidance.** Add a short section to the standard `CLAUDE.md` template (and run a migration so existing agents pick it up too) that teaches the agent: when you're about to self-broadcast a ship, restart, or update, route it through the existing `POST /telegram/post-update` channel — don't author it in the active session topic. This part is guidance, not enforcement; I'm tracking a follow-up to make it structural via a hook gate later (so the agent literally can't author update narration in the wrong topic), but that's a bigger build and I want the two code bugs out the door first.

## How I'll make sure it's right (no loose ends)

Unit tests cover each routing decision on both sides: Updates topic set → lands in Updates; Updates topic unset → lands in lifeline-topic for fix 1, Attention for fix 2 (the existing default, unchanged). An integration test wires a real lifeline against a fake Telegram API, forces a 426, and asserts the alert hits Updates and never the inbound topic. An end-to-end test boots via the production initialization path and replays the same scenario. The migration adds the new `CLAUDE.md` section idempotently — run it twice and the second run is a no-op.

Migration parity: the two code fixes land via the normal dist refresh that every agent gets on update. The `CLAUDE.md` template change gets a dedicated migration in `PostUpdateMigrator` so existing agents pick up the new guidance, not just newly-initialized ones.

## What I need from you

Approval to merge this spec and ship the fix. The change is small (≤150 LOC + tests + migration) and low risk — it strictly redirects routing, doesn't change any contract or schema, and preserves a safe fallback in each case. Reply "approved" and I'll move into the build worktree, ship it, and report back when CI is green and merged.
