# Side-effects review — messaging consumer-side hardening (v1.3.270 incident)

Incident (2026-06-05): Echo's server crash-looped at boot (~13 min Telegram mute) and
the lifeline 404-zombied. The `{ secret: true }` placeholder OBJECT for the Telegram
token survived a failed secrets merge and flowed into consumers — `tokenHash(Object)`
threw ERR_INVALID_ARG_TYPE at startServer, and the poller stringified the object into
the bot-token URL.

**Scope note (parallel-work split):** the CONFIG-LAYER root-cause fix — per-agent
keychain master key, verify-decrypt precedence, loud merge failure + critical-
placeholder fail-fast — is a separate converged Tier-2 spec
(`docs/specs/keychain-per-agent-master-key.md`, codex-adversarial-reviewed) built in a
parallel session; its forensics identified the true root cause (a machine-global
keychain slot poisoned by another agent's freshly-generated key — NOT transient
contention). THIS change is deliberately narrowed to the CONSUMER-SIDE guards that
hold regardless of why an unresolved placeholder ever reaches the messaging layer.
The two compose: that spec makes the failure rare and loud at the source; this makes
the messaging layer structurally unable to crash or zombie on it.

## 1. The change (two consumer-side guards + one type widening)

1. **Crash-path guard** (`commands/server.ts`): only a real non-empty STRING token
   reaches `lifelineOwnsTelegramPoll`/`tokenHash` — a placeholder object is treated
   as missing (no poll-ownership check; boot continues).
2. **Zombie-path guard** (`TelegramAdapter`): a non-string token NORMALIZES to `''`
   in the constructor (the well-defined TOKENLESS state every existing guard —
   pool-standby/relay/send-only — already handles) with a loud warn, and `start()`
   REFUSES to long-poll without a usable token, surfacing
   `fatalReason: 'no-usable-bot-token'` via `getStatus()` instead of 404-looping.
3. `fatalPollReason`/`fatalReason` union widened with `'no-usable-bot-token'`
   (display-only; no consumer branches on the old literals — verified by grep).

## 2. Blast radius

Healthy boots byte-for-byte unchanged (string token → identical paths; no new
warns). The tokenless pool-standby case is PRESERVED — normalization maps the
failure into exactly that existing state. `start()`'s refusal fires only where
polling would have 404-zombied anyway. No config, schema, or route changes.

## 3. Failure modes after the fix

An unresolved placeholder reaching the adapter → loud warn + tokenless boot (sends
via relay still work) + visible `no-usable-bot-token` status; never a crash-loop,
never a zombie poller. Recovery = next restart after the secret store is readable
(or the keychain-per-agent fix lands and the failure stops occurring at all).

## 4. Test coverage

4 unit tests: constructor normalization (loud, no-throw, placeholder object);
start() refusal for the placeholder AND the empty-string token with `fatalReason`
surfaced; the healthy string-token path still polls. Adjacent suites re-run green
(TelegramAdapter, Config, SecretMigrator — 32 passing).
