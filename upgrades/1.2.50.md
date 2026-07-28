# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

PR 9 of the tunnel-failure-resilience chain — the finale, plus an urgent fix for notification noise.

**Noise fix (the headline).** The new tunnel monitoring was spamming the Dashboard topic — repeated "Couldn't reach Cloudflare… still retrying", "Tunnel is unstable… I'll stop re-pinging", and "All tunnel options are unavailable" messages on every background-retry cycle (one agent's topic hit 209 messages). The root cause: the notifier reset its own anti-repeat throttle every retry cycle, so nothing was ever actually throttled. Beyond that bug, this routine churn shouldn't reach the user at all. It's now silent. The agent only messages you about the tunnel when there's something to **do** (approve a backup) or something **usable** (a new dashboard link). A temporary Cloudflare hiccup just resolves itself quietly in the background. This is a code fix in the notifier, so **every agent gets it on update** — it is not a per-agent setting.

**Opt-out switches.** You can now turn the backup-relay behavior off entirely: `{"tunnel": {"relaysEnabled": false}}` or `{"tunnel": {"relayConsent": "never"}}` makes the agent Cloudflare-only — it will never offer or prompt for a third-party backup. These are wired through, so they genuinely disable the path (not just cosmetic config).

**Status endpoint.** `GET /tunnel` now reports the live lifecycle state (`active` / `retrying` / `awaiting-consent` / `relay-active` / `self-healing` / `exhausted`), so the agent can tell you exactly what's happening with your link instead of narrating it message-by-message.

**Agent awareness.** The CLAUDE.md tunnel section now explains the whole failure-resilience flow, so any instar agent can describe a link outage and the backup process conversationally.

## What to Tell Your User

- The tunnel will stop spamming you. You'll only hear about it when you need to approve a backup or when there's a fresh link to use — routine Cloudflare hiccups are handled silently.
- If you'd rather never use a third-party backup at all, you can set the agent to Cloudflare-only and it'll just wait for Cloudflare to recover.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Quiet tunnel notifications | Automatic — routine retry/outage churn no longer messages you; ships to all agents on update |
| Cloudflare-only opt-out | `{"tunnel": {"relaysEnabled": false}}` or `{"tunnel": {"relayConsent": "never"}}` |
| Live tunnel state | `curl -H "Authorization: Bearer $AUTH" http://localhost:PORT/tunnel` → `lifecycle.state` |

## Evidence

- Spec: `specs/dev-infrastructure/tunnel-failure-resilience.md` Parts 4, 6, 7, 8. Side-effects: `upgrades/side-effects/tunnel-route-config-quiet.md`.
- Noise fix tests: `tunnel-notifier.test.ts` adds a "spam scenario stays silent" test that churns retrying↔exhausted across 6 episodes and asserts ZERO messages reach the user (the exact pattern that produced 209 messages), plus explicit `retrying`/`exhausted` silence tests.
- Opt-out tests: `tunnel-config-knobs.test.ts` (4) — `relaysEnabled=false` and `relayConsent='never'` both send Tier-1 exhaustion straight to `exhausted` (never `awaiting-consent`), and the default pool builds no Tier-2 provider; the default still offers consent.
- No regression: 109 tunnel + auth tests pass (the two manager-rewrite assertions that checked the old retry message now check the recovery message).

## Rollback

Additive / low-risk. The notifier change is a few removed message pushes (revert restores them). Config fields are optional with back-compat defaults. The `/tunnel` lifecycle block and CLAUDE.md bullet are additive. No config-schema or persisted-state migration.
