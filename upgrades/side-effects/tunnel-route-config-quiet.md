# Side-effects review — /tunnel route + config knobs + quiet notifications (PR 9 of tunnel-failure-resilience chain)

**Scope (PR 9, the chain finale + an urgent operator fix):**
1. **Notifier noise reduction** (operator feedback 2026-05-23): routine
   tunnel churn (`retrying`, `exhausted`, the flap-collapse "unstable"
   message) is now SILENT on the group topic. These fired on every
   background-retry cycle — and because the notifier resets its throttle
   when the episode id changes (which it does each retry cycle), they
   re-emitted endlessly (a real agent's Dashboard topic hit 209 messages).
2. Config knobs (spec Part 4): `relayProviders`, `relaysEnabled`,
   `relayConsent`, `consentTimeoutMs`, `notifyTopic` — added to the type,
   ConfigDefaults, and WIRED into the manager (the safety opt-outs must
   actually work).
3. `GET /tunnel` exposes the lifecycle state (spec Part 8 surface).
4. CLAUDE.md Agent Awareness in both template sites (spec Part 7).

**Files touched:**
- `src/tunnel/TunnelNotifier.ts` — `retrying` + `exhausted` cases emit
  nothing; the flap-collapse "unstable" noise message is removed.
  Removed the now-dead `reasonSuffix` helper + its import.
- `src/tunnel/TunnelManager.ts` — `buildDefaultPool` gates Tier-2 on
  `relaysEnabled`/`relayProviders`; `exhaustedOrBackoff` skips the
  consent path when `relaysEnabled=false` or `relayConsent='never'`;
  `requestConsent` uses `consentTimeoutMs` from config. New config fields
  on `TunnelConfig`.
- `src/core/types.ts` — `TunnelConfigType` gains the 5 optional fields.
- `src/config/ConfigDefaults.ts` — `SHARED_DEFAULTS.tunnel` defaults
  (deep-merged existence-checked → existing agents get them on update).
- `src/commands/server.ts` — passes the new fields to the manager.
- `src/server/routes.ts` — `GET /tunnel` adds a `lifecycle` block.
- `src/scaffold/templates.ts` + `src/core/PostUpdateMigrator.ts` —
  CLAUDE.md tunnel section gets a "Failure resilience" bullet (new agents
  via the template; existing agents via a content-sniffed migration).
- Tests: `tunnel-config-knobs.test.ts` (4, NEW); `tunnel-notifier.test.ts`
  rewritten for the quiet behavior (incl. an explicit "spam scenario stays
  silent" test); two `tunnel-manager-rewrite.test.ts` assertions
  re-pointed from the removed retrying message to the recovery message.

**Over-block (notifications):** The silenced states carry no
actionable/usable information — a transient Cloudflare outage is
self-evident if the user opens the link, and `GET /tunnel` reports live
state for anyone checking. The user is still messaged for the two things
that matter: a consent ask (owner DM, when a backup is genuinely needed)
and a new usable link (owner DM, relay-active / recovered). No important
signal is lost.

**Under-block (config opt-outs):** `relaysEnabled=false` and
`relayConsent='never'` are SAFETY opt-outs — a field that wasn't wired
would be a broken opt-out (a user who disabled relays would still get
consent prompts). Both are wired and unit-tested: on Tier-1 exhaustion
the manager goes straight to `exhausted` (never `awaiting-consent`), and
the default pool builds no Tier-2 provider.

**Level-of-abstraction fit:** Config is read in the manager (the layer
that owns the relay decision); the route reads the manager's existing
lifecycle snapshot; the notifier owns the message policy. No new
cross-layer coupling.

**Signal vs authority:** unchanged. `relayConsent`/`relaysEnabled` are
operator authority expressed in config; the manager enforces them.

**Migration parity (Justin's explicit ask — fix it for ALL agents):**
- The notifier silence is a CODE change in `src/tunnel/TunnelNotifier.ts`
  — it ships to every agent through the normal npm update (not a
  per-agent config tweak). No per-agent action needed.
- Config defaults flow to existing agents via `SHARED_DEFAULTS` +
  existence-checked deep-merge (`getMigrationDefaults`).
- CLAUDE.md awareness reaches existing agents via the content-sniffed
  `PostUpdateMigrator` block (`Cloudflare Tunnel` present + `Failure
  resilience` absent → append), idempotent.

**`/tunnel` route safety (spec Part 6):** Bearer-gated by authMiddleware;
`lastFailureReason` is a classified enum (never a raw/credentialed URL);
no PIN/token is included.

**Rollback cost:** Low/additive. The notifier change is a few removed
message pushes (revert restores them). Config fields are optional with
back-compat defaults. The route addition is additive. No persisted-schema
change.
