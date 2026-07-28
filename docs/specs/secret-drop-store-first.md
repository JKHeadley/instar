---
parent-principle: "Distrust Temporary Success — A Recurrence Is a Root Cause"
review-convergence: "rev-1 — operator-mandated incident response. Root cause grounded in source (in-memory-only `received` map; nothing persists a submission durably), fix designed as the minimal coherent unit: persist-on-submit to the existing encrypted SecretStore + transparent durable fallback in the one retrieve route the hardened helper uses + consume-cleans-both + opt-out flag. During implementation the test run itself reproduced a SECOND latent failure (machine-global keychain entry overwritten by any fresh-stateDir SecretStore), which this spec folds in as the structural test guard. Both sides of every decision boundary covered by tests."
approved: true
approved-by: "operator (Justin) via Telegram topic 13481 — 2026-06-04 ~18:57Z (\"make note that this issue of dropping the secret has happened MANY MANY TIMES and we need to fix this. When you are handed a secret your FIRST priority is to STORE IT SECURELY so that you don't accidentally consume/lose it\") under the standing 12h-autonomous pre-approval for multi-machine robustness work"
approved-at: "2026-06-04T18:57:00Z"
---

# Secret Drop — Store-First Durable Persistence

**Status:** Approved 2026-06-04. Implemented.
**Author:** Echo
**Companion:** secret-drop-store-first.eli16.md
**Trigger:** Recurring operator-reported failure (topic 13481, 2026-06-04): secrets handed to the agent via Secret Drop have been lost "MANY MANY TIMES." The same day, a 1-hour-TTL drop link's token evaporated live in a server auto-update restart — the exact failure, observed mid-conversation.

---

## Failure being addressed

A submitted Secret Drop lives ONLY in the in-memory `received` map
(`src/server/SecretDrop.ts`). On submission the server (1) holds the values in
memory, (2) sends a Telegram "✅ Secret received", (3) nudges the agent session
to retrieve. **Nothing persists the value durably.** Any churn between submit
and consume — a server auto-update restart, session compaction, a
cross-machine handoff, or the 15-minute idle cleanup — loses the secret
outright, and the user is asked to resubmit. With multi-machine session
movement and a fleet shipping ~20 releases/day (each one a server restart),
the churn window is hit routinely. This is the root cause of the recurring
"I handed you a secret and you dropped it" failure.

A second latent failure surfaced while building this fix: the SecretStore
master-key keychain entry (`instar-secret-store` / `master-key`) is
**machine-global** — shared by every agent and process on the box — while the
file fallback key is per-agent. A SecretStore constructed against a fresh
stateDir with no file key generates a new master key and silently OVERWRITES
the global keychain entry. The first run of this spec's own integration test
did exactly that on the dev machine, instantly making the real agent's vault
undecryptable for every keychain-resolving reader (the server reported the
store as empty). Remediated live; the test-environment guard below makes the
class structurally impossible for every current and future test.

## The fix

1. **Persist on submit (store-first).** `POST /secrets/drop/:token`, after a
   successful in-memory `submit()` and BEFORE the Telegram confirm/agent nudge,
   writes the submission to the durable AES-256-GCM `SecretStore` at
   `secretDrops.<token>` (label, topicId, receivedAt, field names, values).
   Best-effort + loud: a persist failure logs an ERROR but never 500s the
   user's submission (the ephemeral copy still exists for immediate use). The
   value is never logged.

2. **Transparent durable fallback on retrieve.** `POST /secrets/retrieve/:token`
   (the only route the hardened `secret-drop-retrieve.mjs` helper uses) falls
   back to the durable copy when the in-memory one is gone. Peek does not
   delete; `?consume=true` against the durable copy deletes it.

3. **Consume cleans both.** An in-memory consume also deletes the durable copy,
   so a consumed one-time secret never lingers in the encrypted store.

4. **Opt-out, default ON.** `config.secrets.persistDrops: false` reverts to
   the pre-2026-06-04 in-memory-only behavior. Absence of the flag = enabled —
   a pure safety fix needs no migration and no developmentAgent gate.

5. **Keychain-pollution guard (structural).** `MasterKeyManager` detects a test
   run (`VITEST` / `NODE_ENV=test`) and forces file-key mode — no test can
   touch the machine-global keychain entry even if it forgets `forceFileKey`.
   Additionally `config.secrets.forceFileKey` is plumbed through the routes so
   operators (and the integration tests) can pin the key source explicitly.

## Security posture

- The durable copy is AES-256-GCM encrypted at rest with the existing
  per-agent master key — the same store that already holds `github_token` and
  the platform tokens. This trades "never on disk" for "encrypted at rest +
  actually survives" — the operator explicitly mandated that trade ("FIRST
  priority is to STORE IT SECURELY").
- One-time semantics preserved: consume deletes both copies; the drop link
  remains one-time + CSRF-protected + TTL-bound.
- The retrieve route remains Bearer-authed; the hardened helper remains the
  only sanctioned client.

## Migration parity

- `src/scaffold/templates.ts` (`generateClaudeMd`): Security bullet rewritten —
  submissions persist store-first; opt-out documented.
- `src/core/PostUpdateMigrator.ts`:
  - The inject-if-missing Secret Drop section carries the new wording.
  - A new idempotent migration rewrites the stale "in-memory only (never
    written to disk)" bullet on existing agents' CLAUDE.md.

## Tests

- `tests/integration/secret-drop-store-first.test.ts` (5): persist-on-submit;
  durable fallback when in-memory gone (peek preserves); durable consume
  deletes + second retrieve 404s; in-memory consume cleans durable;
  `persistDrops:false` persists nothing and gets no fallback.
- `tests/unit/secret-store.test.ts` (+1): the test-run keychain guard — a
  MasterKeyManager WITHOUT forceFile still uses the file key under VITEST and
  reports not-keychain-backed.
- `tests/unit/PostUpdateMigrator-secretDropHardenedRetrieve.test.ts` (+3):
  Security-bullet rewrite, idempotency, fresh-inject carries new wording.

## Out of scope (tracked separately)

- Cross-machine push of the persisted drop (`/secrets/sync`) — Phase 4.
- Per-agent keychain account + key-id header + dual-key read fallback + loud
  decrypt-failure surfacing (the broader key-coherence disease) — follow-up
  owned by commitment CMT-1038. <!-- tracked: CMT-1038 -->
