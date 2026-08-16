# Business Review: PR #30 iMessage Adapter

### Approval Status: CONDITIONAL

**Score: 6/10**

---

### Problem-Solution Fit

iMessage fills a real gap: zero-enrollment UX for Apple-ecosystem users. Telegram and WhatsApp require the user to have the app and know to use a specific contact. iMessage is already in the operator's contact list. For personal agents and tight trust circles, this removes onboarding friction entirely.

### Target Market

Primary segments: macOS power users with personal agents, small Apple-device teams, household automation scenarios. Market is US-skewed (iMessage is ~55% of US smartphone users, essentially 100% of the macOS developer community). Current addressable market is hundreds to low thousands of instar operators.

### Competitive Landscape

No dominant commercial player offers what this PR does. Beeper Mini demonstrated both the demand and fragility in 2023. The `imsg` CLI follows the same AppleScript pattern other macOS automation tools use.

### Platform Risk (7/10)

Three independently fragile dependencies:
- `chat.db` SQLite read access -- could be locked in any macOS update
- `imsg` CLI for sending -- third-party, single-maintainer Homebrew tap
- Full Disk Access grant -- user-granted, can be friction-increased by Apple

Mitigation is good: the adapter is optional, fails gracefully with degradation reporting.

### Value Proposition

Strong: zero-friction for Apple users, 30-message conversation history lookback, native feel.
Weak: cannot scale to large user bases, group chat absent, useless for international/Android.
Net: Real but narrow. Personal power-user channel, not scalable deployment channel.

### macOS Lock-in

Short term positive: unique differentiator. Medium term risk: single point of failure. Cross-platform tension: iMessage is fundamentally single-machine.

---

### Critical Issues

1. **No group chat support** -- scope must be explicitly documented as 1:1 only
2. **`imsg` CLI is single-maintainer** -- supply chain risk. AppleScript fallback would be more durable
3. **Startup lookback triggers stale session spawns** -- timestamp gate needed
4. **Multi-device dedup** -- needs explicit testing coverage

### Recommendations

1. Document as single-machine, Apple-only, best-effort channel
2. Add platform risk warning in setup docs
3. Add AppleScript native fallback send path
4. Explicitly scope to 1:1 chats only
5. Timestamp-gate startup lookback
