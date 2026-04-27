---
title: "Telegram Delivery Robustness"
slug: "telegram-delivery-robustness"
author: "echo"
review-iterations: 3
review-convergence: "2026-04-27T18:35:00Z"
review-completed-at: "2026-04-27T18:35:00Z"
review-report: "docs/specs/reports/telegram-delivery-robustness-convergence.md"
approved: true
approved-by: "justin"
approved-at: "2026-04-27T18:40:00Z"
---

# Telegram Delivery Robustness

**Status:** spec — round 3 (post second review round)
**Owner:** Echo
**Date:** 2026-04-27
**Incident origin:** Inspec / topic 50 (cheryl), 2026-04-27 17:44 UTC

## 1. Problem

A successful agent reply silently fails to reach the user when `telegram-reply.sh` cannot deliver to its own server. The script exits non-zero, but the failure is invisible to the lifeline — only the agent sees it. The user sees a presence ping and then silence.

### Root cause of the originating incident

`.claude/scripts/telegram-reply.sh` reads `authToken` from `.instar/config.json` but reads `port` from the `INSTAR_PORT` env var with a hardcoded default of `4040`. When the spawned session's environment lacks `INSTAR_PORT` (the common case in tmux-managed Claude sessions), the relay hits `localhost:4040`. On a multi-agent host, port 4040 is owned by *some other agent's* server, which receives the request and rejects it with `403 Invalid auth token` because the token belongs to a different agent.

### Why nothing caught it

- The stall sentinel only fires on an idle session. The session in this incident finished cleanly — it just couldn't deliver.
- The relay script's non-zero exit lands in Claude's TUI. There is no path back to the lifeline.
- There is no contract between "agent intended to reply" and "reply was delivered." The intent evaporates with the script's exit.

## 2. Goal

When an agent attempts to reply on a topic and delivery fails for any non-final reason, the user must (a) eventually receive the reply on the same topic, OR (b) be notified — on the same topic — that delivery failed and why. The lifeline channel is a fallback only when the topic itself is unreachable. **No code path may surface a user-visible message except through the existing tone gate.** **No code path may send an auth-bearing request to a server that is not this agent's server.**

## 3. Non-goals

- Fixing Telegram's actual API flakiness (out of scope; covered by the existing 408 ambiguous-outcome path).
- Retrying tone-gate-blocked messages (tone gate decisions are final by design).
- Changing the existing 408 handling in the script (the AMBIGUOUS exit-0 stays — sentinel coordinates with this).
- Cross-agent coordination (the sentinel runs per-agent; it doesn't know about other agents' queues).

## 4. Design — three layers

### Layer 1 — Fix port resolution AND bind the token to the agent

**Layer 1 ships unconditionally — not feature-flagged.** It is the highest-leverage fix and addresses the originating incident class on its own.

#### 1a. Port resolution (script)

`src/templates/scripts/telegram-reply.sh` resolves the target port in this order:

1. `INSTAR_PORT` env var (explicit operator override).
2. `.instar/config.json` `port` field (the canonical agent-local source of truth).
3. Hardcoded `4040` only when neither is readable AND a warning is printed to stderr.

**Migration to deployed scripts:** add `migrateReplyScriptToPortConfig` to `PostUpdateMigrator.ts`, modeled on the existing `migrateReplyScriptTo408`. Detection uses **a SHA-256 of the prior templated content**, not a marker-string match — eliminating the user-modified-script overwrite class. If the on-disk script is neither the prior templated SHA nor the new templated SHA, the migrator writes the new version to `telegram-reply.sh.new` alongside the existing file and surfaces a degradation event ("user-modified relay script detected; new version available at .new — review and rename"). Existing file is **always backed up** to `.instar/backups/telegram-reply.sh.<epoch>` before any overwrite.

#### 1b. Server-side authToken binding (server)

The originating incident proved that an authToken sent to the wrong server fails open at the network layer (the wrong server happily accepts the request, evaluates auth, and rejects with 403 — but the token has *crossed the trust boundary*). Layer 1 closes this on the server side as well as the client side:

- On startup, the server records its own `agentId` (already in `config.json`) and the SHA-256 of `authToken`.
- Auth middleware adds an additional check: `Authorization: Bearer <token>` AND `X-Instar-AgentId: <id>` (added by the script). Server validates the agentId matches before token comparison; mismatch → 403 with structured body `{code:"agent_id_mismatch", expected:"<this-server-agent>"}`. Token comparison runs in constant time.
- The script always sends `X-Instar-AgentId` from `.instar/config.json`. If the resolved port belongs to a different agent, the structured 403 lets the sentinel categorize the failure precisely (vs "your token is revoked" vs "you're rate-limited").

#### 1c. Sentinel-side authenticated identity probe

Before any auth-bearing send during recovery (Layer 3), the sentinel hits an authenticated **`GET /whoami`** endpoint. The endpoint requires the same `Authorization` + `X-Instar-AgentId` headers (no deprecation-window exception — required from day 1, to prevent `/whoami` becoming a discovery oracle for token-port pairing). It returns `{ agentId, port, version }` and is rate-limited to 1 req/s per source agent. Sentinel only proceeds with the actual `POST /telegram/reply` if `whoami.agentId === thisAgentId`. `/health` remains public-unauthed (probe-only); it is not an identity check and is not used to route auth-bearing requests.

`/whoami` results are cached in sentinel memory for 60s, keyed on `(port, sha256(authToken), config.json mtime)`; cache invalidates on `config.json` mtime change. This cuts recovery RTT roughly in half during stampede drains.

**Forward upgrade path (NEW script + OLD server):** old servers without `/whoami` return 404. The script (and the sentinel) treat 404 on `/whoami` as "server too old for full agent-id binding"; the script falls back to `/health` + token-only auth with a single per-process degradation event raised. This deprecation tolerance is bounded by the same one-minor-version window. Threadline-relayed messages between mixed-version agents (new → old, old → new) are exempt from deprecation-event logging to avoid floods during rolling upgrades; only direct user-driven script paths log.

**Backward upgrade path (OLD script + NEW server):** new server falls back to token-only validation in a deprecation window. Deprecation is logged at most once-per-hour-per-source-agent.

### Layer 2 — Detect undelivered intents (durable queue + structured events)

#### 2a. Queue substrate: SQLite, not JSONL

JSONL with append-rewrite-tail was challenged by both Gemini and Grok on durability/atomicity grounds, and on multi-machine git-replay grounds by Integration. Replace the queue with a **per-agent SQLite database**.

**Path resolution:** `.instar/state/pending-relay.<agentId>.sqlite` (mode 0600). The `agentId` infix exists because instar supports two install layouts — `~/.instar/agents/<id>/.instar/` (per-agent) AND `<project>/.instar/` (per-project, used in shared worktrees). Two agents that share a worktree (e.g., the worktree-monitor case) share the same `.instar/` directory; the `agentId` infix prevents queue collision in that layout. The flock lockfile gets the same infix.

**SQLite configuration (mandated, not optional):**
```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA busy_timeout = 5000;
```
WAL is required because every insert by the script races every state-update by the sentinel under default rollback journaling; a 50-entry stampede drain would block script INSERTs on sentinel UPDATEs.

**Runtime dependency:** `sqlite3` CLI is not universally pre-installed (Alpine Docker, minimal Debian, some ARM CI runners). On server boot, run `sqlite3 -version`; if absent, raise a `sqlite3-cli-missing` degradation event. The script falls back to `node -e 'require("node:sqlite")...'` (Node ≥22 ships `node:sqlite`; older Node falls back to a vendored `better-sqlite3` already in instar's dependency tree). The script's port resolution code reaches the same DB by either path.

Schema:

```sql
CREATE TABLE entries (
  delivery_id   TEXT PRIMARY KEY,        -- UUIDv4, generated by script
  topic_id      INTEGER NOT NULL,
  text_hash     TEXT NOT NULL,           -- SHA-256 of normalized text
  text          BLOB NOT NULL,           -- raw bytes; not indexed
  format        TEXT,
  http_code     INTEGER,
  error_body    TEXT,
  attempted_port INTEGER,
  attempted_at  TEXT NOT NULL,           -- ISO
  attempts      INTEGER NOT NULL DEFAULT 1,
  next_attempt_at TEXT,
  state         TEXT NOT NULL,           -- queued|claimed|delivered-recovered|delivered-tone-gated|delivered-ambiguous|escalated|dead-letter
  claimed_by    TEXT,                    -- "<bootId>:<pid>:<leaseUntil>"
  status_history TEXT NOT NULL DEFAULT '[]'  -- JSON array of state transitions
);
CREATE INDEX idx_state_next ON entries(state, next_attempt_at);
CREATE INDEX idx_text_hash_topic ON entries(text_hash, topic_id);
```

SQLite gives us ACID, atomic state transitions, indexed dedup lookups, no JSONL-rewrite race, and no append-truncation risk on crash.

#### 2b. Script changes (detector role only — no judgment)

When `HTTP_CODE` matches a *recoverable* class (see classification below), the script:

1. Generates `delivery_id = uuidv4()` (using `python3 -c 'import uuid; print(uuid.uuid4())'` — already a script dependency).
2. **Insert dedup window:** before INSERT, query for any existing row with `(topic_id, text_hash)` written within the last 5s. If found, no-op (return that row's `delivery_id`) — prevents a tight loop in a misbehaving session from filling the DB to its size cap. This is structural validation, not judgment, so signal-vs-authority is fine.
3. **Text size cap:** `text` larger than 32KB is truncated at insert with `truncated=1` flag in a new column. On recovery, truncated entries deliver with a one-line system-template suffix "(message truncated for storage during delivery outage)".
4. Inserts a row. On insert conflict on `delivery_id`, no-op (idempotent).
5. Best-effort POSTs `/events/delivery-failed` to the **same port the original send used** (NOT the live config port — see §4 Layer 2c on cross-tenant safety). The endpoint returns 2xx/4xx; any non-2xx is silently ignored — SQLite is the source of truth.
6. Exits **1**.

**HTTP code classification (the entire decision matrix lives here, in the script):**

| Code | Recoverable? | Reason |
|------|--------------|--------|
| 200 | n/a | Success — script exits 0, no queue |
| 400 | no | Malformed input — agent bug, won't fix on retry |
| 403 with `agent_id_mismatch` | yes | Cross-port collision — Layer 1 fix should prevent recurrence, sentinel re-resolves |
| 403 with `revoked` | no | Token revoked — operator action required |
| 403 with `rate_limited` | yes (special) | Rate-limited — sentinel honors `Retry-After` header, no count against budget |
| 403 unstructured | **no** (default-deny) | Unknown 403 → not retryable; treat as terminal until proven otherwise |
| 408 | n/a | Ambiguous — script exits 0, no queue (existing behavior) |
| 422 | no | Tone gate — final, agent's responsibility |
| 5xx, conn-refused (HTTP 000), DNS | yes | Transport flake — sentinel retries with backoff |

#### 2c. Server endpoint: `POST /events/delivery-failed`

Authenticated (Bearer token + agent-id header, same as `/telegram/reply`). Strict validation:

- Body schema enforced via existing route validator (zod or equivalent); reject any extra fields.
- Caps: `text` ≤ 8KB, `errorBody` ≤ 1KB, total body ≤ 16KB.
- Per-agent rate limit (token bucket: 10 req/s, burst 50). 429 on exceed.
- The endpoint **does not store anything** server-side — it's a fan-out for the SSE event stream. SQLite is the durable record on the script side.
- Auth failures (mismatched agentId, wrong token) emit a *single* `auth_failure` audit log line and return 403; do **not** echo any agent-supplied data in the response.

**Cross-tenant safety:** The script POSTs to the *original* port, never to the re-resolved port. If the original send hit the wrong agent's server, the failed event also hits that wrong agent's server — but auth fails (agent-id mismatch on Layer 1b), so the wrong agent's server only sees a single 403'd request and discards everything except a one-line audit log. No content is processed by the wrong tenant.

### Layer 3 — Auto-recover, same-topic-first, with a hardened sentinel

**Where:** `src/monitoring/delivery-failure-sentinel.ts`. Modeled on `src/monitoring/stall-detector.ts` but owns its full lifecycle.

#### 3a. Trigger model: event-driven + watchdog

Primary trigger: SSE subscription to the agent's own `delivery_failed` event. New entries are picked up within ~1s of enqueue.

Backstop: a 5-minute watchdog tick that scans `entries WHERE state IN ('queued','claimed') AND next_attempt_at <= now()`. The 5-min interval is chosen because (a) idle cost on a 5-agent host is 60 wakeups/hr, (b) the SSE primary path covers latency-sensitive cases, (c) any entry truly missed by SSE is by definition not user-time-critical.

#### 3b. Lock & lease — `flock(2)`-based, not mtime

Per-database advisory lock via `flock(LOCK_EX|LOCK_NB)` on `.instar/state/pending-relay.<agentId>.sqlite.lock`. OS releases on process death — no stale-PID problem, no NFS heartbeat ambiguity. SQLite's own busy-timeout handles transient contention if two processes race.

**`bootId` lifecycle:**
- The server creates `.instar/state/boot.id` (mode 0600) **synchronously before binding the listener** on first start. Content: 16 bytes from `crypto.randomBytes` hex-encoded (NOT derived from start-time + hostname, which is guessable and forgeable). The file persists across server restarts within an instar version; it rotates only on `instar update` minor-bump.
- The sentinel waits for `boot.id` existence with a 5s timeout at startup. If still missing, it logs and exits — a server should never be partially initialized.
- A queue row whose `claimed_by` references a `bootId` not matching the current server's is always reclaimable, regardless of `leaseUntil`. (Catches PID reuse across reboots.)

Per-entry lease: when a sentinel claims an entry, it writes `claimed_by = "<bootId>:<pid>:<leaseUntil>"` with `leaseUntil = now + 90s`. Entries are reclaimable when `leaseUntil < now` OR `bootId` differs.

#### 3c. Retry policy — exponential backoff within TTL

Recoverable failures (403/agent_id_mismatch, 5xx, conn-refused, DNS): backoff 30s → 1m → 2m → 5m → 15m → 30m → 1h → 2h → 4h, capped at 24h TTL from `attempted_at`. `next_attempt_at` is computed and stored on each retry.

`403/rate_limited`: backoff to `Retry-After`; does not consume the regular budget.

Per-topic delivery rate cap: ≤1 delivery per topic per 30s during recovery, so a 50-entry queue draining after a 1h outage releases over time, not all at once. Per-topic cap is enforced via `MAX(attempted_at) WHERE topic_id=? AND state IN ('delivered-recovered', 'escalated')` predicate before claim. Cross-topic recovery runs in parallel with a max-concurrency cap of 4 so a 10-topic stampede doesn't serialize end-to-end.

Stampede summarization: when more than 5 entries are recoverable for the same topic on the same tick, deliver only the *most recent* original message and emit a single sentinel digest: *"⚠️ I had N replies queued for this topic during a delivery outage. Only the latest is delivered; the others are dropped. Set INSTAR_DEBUG=1 to see the suppressed text."*

#### 3d. Recovery delivery path

1. Read live `port` and `authToken` from `.instar/config.json`.
2. `GET /whoami` (authed). If `agentId` mismatch → categorize 403/agent_id_mismatch, retry next tick (operator may have rotated config). Never POST `/telegram/reply` without a passing `/whoami`.
3. **Re-tone-gate the queued text** by calling the local server's outbound gate API directly (`POST /messaging/tone-check` — auth'd, returns the same `{ok|issue|suggestion}` shape as the inline check). Any 422 here finalizes the entry as `delivered-tone-gated` AND sends a user-visible meta-notice on the topic: *"⚠️ I had a reply for you, but my tone-of-voice check rejected it on re-send. Original was queued during a delivery outage and is now discarded."* This is bounded text composed from a fixed template (no original-text excerpting), so it cannot reintroduce the offending content.
4. POST `/telegram/reply` with the original text + `X-Instar-DeliveryId: <delivery_id>` header. Server-side: maintains a 24h LRU of seen `delivery_id`s; duplicate deliveries return 200 idempotent (no second send). This neutralizes the "200-but-client-blind" double-send class.
5. On 200 → finalize as `delivered-recovered`. On 422 → see step 3 (cannot happen here because step 3 already gated; treat as defense-in-depth → `delivered-tone-gated`). On 408 → finalize as `delivered-ambiguous` (no retry, matches script semantics). On 5xx/agent_id_mismatch → schedule next retry via §3c.

#### 3e. The recovered marker — fire-and-forget follow-up, gated on confirmed delivery

The `_(recovered)_` annotation moves out of the original message body and becomes a **separate fire-and-forget follow-up reply on the same topic**, sent ~2s after the recovered message: *"`_(recovered after delivery outage — delivery_id <short>)_`"*. The marker:

- Is **never enqueued.** A failed marker send is logged and dropped — never queued, never retried. Its job is operator-visible signal, not durable.
- Is **gated on a confirmed 200** of the original recovered send. If recovery returned 408 (ambiguous) or any non-200, no marker is sent — avoids the dangling-meta-notice case where a marker arrives but the message it refers to didn't.
- Includes the `delivery_id` short form, so even if Telegram delivers the marker before the message (out-of-order edge), the reference is self-explaining.

This eliminates the code-fence corruption risk, the 4096-char overflow risk, and the textHash-collision risk from the round-1 design, AND closes the round-2 cascade-failure risk on the marker itself.

#### 3f. Escalation — circuit breaker, not infinite loop

When an entry exhausts retries (24h TTL or 9-step backoff exhausted, whichever first):

1. Compose a fixed-template escalation message: *"⚠️ I had a reply for you on this topic but couldn't deliver it after retrying for {duration}. Reason: {category}. (delivery_id: {short_id})"* — `{category}` is one of an enumerated set; no original-text excerpting. Tone gate is bypassed for sentinel-system messages by setting `X-Instar-System: true` on the request. The bypass is restricted to a fixed allow-list of message templates verified at server boot.
2. Try sending on the same topic. If 200 → finalize `escalated`. On failure → 1 retry on the same topic.
3. Both topic-attempts failed → fall back to lifeline channel with the same template, prefixed *"[topic {N} unreachable] "*.

**Per-agent circuit breaker:** if the sentinel records 5 consecutive *escalation* failures across any topics within 1h, the sentinel suspends itself, writes a single `delivery-sentinel-suspended` degradation event, and waits for either:
- a **content-hash change** of the auth-relevant fields in `config.json` (specifically `port`, `authToken`, `agentId` — *not* mtime, which is forgeable and gets bumped by unrelated jobs like tunnel updates or templates-drift writes), OR
- an explicit `instar sentinel resume` CLI command.

On resume, the sentinel issues a single probe send (a sentinel-template "self-test" message to `delivery-sentinel-test` virtual topic that the server short-circuits) before un-suspending; if the probe fails, the breaker stays tripped and a second degradation event is emitted. While suspended, the queue continues to grow but no retries are attempted. This prevents log/alert flooding when config is permanently broken.

**System-template integrity** for both the escalation message (§3f) and the tone-gated meta-notice (§3d step 3): the allow-list of fixed templates ships **embedded in compiled source** (TypeScript constants, hashed at build time). It is **not** a writable on-disk file — that would make the tone-gate bypass a write-controllable surface. At server boot, the runtime computes hashes of the in-memory template set and compares against build-time hashes baked into `dist/`; mismatch fails closed (sentinel cannot escalate) and emits a `template-integrity-failed` degradation event.

#### 3g. Privacy & retention

- File mode `0600` enforced on creation of `pending-relay.<agentId>.sqlite` and the lockfile.
- Pre-write redaction: a small fixed list of known-secret patterns (Bearer tokens, AWS keys, OpenAI keys, Anthropic `sk-ant-` keys, GitHub PATs incl. fine-grained, Slack `xoxb-`, Telegraph access tokens) are substituted with `<redacted:type>` in the `text` column at insert time. The pattern list lives at `src/security/secret-patterns.ts` (compiled-in, not on-disk) so future provider tokens require a code change, not a config edit. Redaction is **defense-in-depth, not a leak prevention guarantee** — agents must already not put secrets in user messages.
- **`error_body` sanitization:** on insert, strip control characters and cap length; on dashboard render via `/delivery-queue`, treat as opaque text — never render as HTML. A wrong-tenant 403 could embed crafted bytes in `error_body`; sanitization keeps that hostile string from reaching dashboard consumers.
- Retention:
  - `delivered-recovered`, `delivered-tone-gated`, `delivered-ambiguous`, `escalated` → purged after 1 hour.
  - `dead-letter` → 7 days, then operator-required to drain via `instar sentinel drain --dead-letter`.
- Size cap: 50MB or 10,000 entries, whichever first. Excess oldest non-claimed entries move to `pending-relay-deadletter.<agentId>.sqlite` with a degradation event raised at 50% capacity. **Expected steady-state for a chatty agent:** ~200 replies/day with ~1% recoverable failure rate yields 2 entries/day under normal operation; cap holds with multi-decade headroom. During a sustained 24h misconfig (pre-circuit-breaker), 200 entries/day × ~8KB ≈ 2MB/day plus indices and history rows; well within cap. Operators should treat any sustained queue depth >50 entries as evidence of a real problem, not noise.

#### 3h. Backup, restore, and multi-machine

- New migrator step adds `pending-relay.*.sqlite`, `pending-relay.*.sqlite-wal`, `pending-relay.*.sqlite-shm`, and `pending-relay.*.sqlite.lock` to `.instar/.gitignore` (the WAL/SHM patterns matter — WAL mode produces sidecar files that would otherwise auto-commit). Regression test asserts `git check-ignore` reports all four patterns as ignored.
- `BackupManager.includeFiles` allowlist deliberately **excludes** these files. Snapshots do not capture in-flight queue state.
- On restore: sentinel checks each entry's `attempted_at` against `now()`; entries older than `now() - 5m` at startup are auto-purged with a one-line restore log.
- Multi-machine: because the file is gitignored AND restore-purged, machine A's queue can never replay on machine B.

#### 3i. Telemetry

Counters in `.instar/state/delivery-sentinel-stats.jsonl` (append-only daily-rotated):

```json
{"ts":"2026-04-27T17:44:35Z","queued":1,"recovered":0,"escalated":0,"dead_letter":0,"tone_gated":0,"ambiguous":0,"queue_depth":1,"oldest_age_s":3}
```

`GET /delivery-queue` (authed) exposes current queue depth, oldest entry age, and per-state counts. Dashboard adds a "Pending Replies" panel sourced from this endpoint. The default-off → opt-in → default-on rollout requires:
- ≥3 canary agents on different multi-agent hosts for ≥7 days.
- p95 recovery latency < 60s.
- Zero `delivery-sentinel-suspended` events on canaries.
- Zero `auth_failure` from sentinel paths (agent-id binding works).

These are written gates, not gut calls.

#### 3j. Feature flag scope

`monitoring.deliveryFailureSentinel.enabled` defaults `false`. **Flag controls Layer 3 only.** Layer 1 (port-from-config + agent-id binding) and Layer 2 (queue + endpoint) ship unconditionally. Layer 1 alone prevents the originating incident; Layer 3 is the upgrade for general delivery resilience.

## 5. Signal-vs-authority compliance — revisited

Round 1 framing called the sentinel a "deterministic policy evaluator on enumerable HTTP-code domain." External reviewers (GPT) challenged this as partly load-bearing because the sentinel *also* composes user-visible content (escalation messages with a "category," tone-gate-rejection notices). That's a content-authority surface.

Round 2 resolution:

- **HTTP-code policy** (retry vs escalate vs finalize) — remains a deterministic policy evaluator. The domain genuinely is enumerable per the table in §4 Layer 2b. No LLM, no judgment.
- **User-visible content from the sentinel** — only emitted via **fixed templates** (§3f), with `{category}` drawn from an enumerated set, no excerpting of agent text. The tone gate's allow-list of system-template hashes (verified at server boot) ensures the templates themselves passed tone-gate review once, at code-review time, not per-message.
- **Tone-gate decisions on queued text** — re-evaluated by the existing tone gate authority on every recovery attempt (§3d step 3). The sentinel never overrides a tone-gate decision; it propagates it.

The sentinel is therefore: a deterministic policy engine for retry mechanics + a fixed-template message emitter routed through the same single tone-gate authority. No new content authority is introduced. This satisfies `docs/signal-vs-authority.md` §"Authorities — what qualifies" without smuggling judgment into a brittle layer.

## 6. Test plan

### Unit (`tests/unit/telegram-reply-port-resolution.test.ts`)

- Script reads `port` from `.instar/config.json` when present.
- `INSTAR_PORT` env var still wins over config.
- Falls back to `4040` and warns when both are absent.
- 408 / 422 paths unchanged.
- Sends `X-Instar-AgentId` header from config.

### Unit (`tests/unit/delivery-sentinel-policy.test.ts`)

- Recoverable classification: 403/agent_id_mismatch, 5xx, conn-refused → enqueue.
- Non-recoverable: 200, 400, 403/revoked, 403 unstructured (default-deny), 408, 422 → no enqueue.
- 403/rate_limited honors `Retry-After`.
- Backoff schedule matches §3c table for attempts 1..9.
- Stampede digest path triggers at >5 entries on same topic same tick.

### Unit (`tests/unit/migration-relay-script-hash.test.ts`)

- Prior templated SHA + new templated SHA → migrator overwrites in-place after backing up.
- User-modified script (neither SHA) → writes `.new` file, raises degradation, leaves original untouched.
- Idempotent: second run with already-new script is a no-op (no rewrite, no extra backup).

### Integration (`tests/integration/delivery-recovery-cross-port.test.ts`) — NO MOCKS

This is the bug-fix evidence test.

1. Spin up real `instar` server A on **ephemeral port** (`server.listen(0)`) with `agentId="A"`, `authToken=T_A`.
2. Spin up real `instar` server B on **ephemeral port** with `agentId="B"`, `authToken=T_B`.
3. Run templated `telegram-reply.sh` from server B's project dir with `INSTAR_PORT` pointing at server A's port (worst-case scenario). Assert: 403 with `agent_id_mismatch`, no token leak (server A sees only its own audit log).
4. Sentinel on B picks up the failure via SSE, `/whoami`'s server B successfully, retries. Assert: delivery succeeds on B's port, recovered marker arrives 2s later as a follow-up reply.
5. Reset; force B's config to point at A indefinitely; sentinel exhausts retries, escalation fires on B's topic with the fixed template (no excerpt), then circuit breaker engages after 5 escalation failures. Assert: no further retries until `config.json` mtime changes.

### Integration (`tests/integration/delivery-tone-gate-recovery.test.ts`) — NO MOCKS

- Queue a message that would pass tone gate when sent (script enqueues on a 5xx). Server returns 422 on the recovery attempt. Assert: user receives the meta-notice template, original text is not repeated, entry finalizes `delivered-tone-gated`.

### Integration (`tests/integration/delivery-restart-survival.test.ts`)

- Enqueue 3 entries; kill the server hard; restart; sentinel resumes. Assert: entries with `attempted_at` < 5m old at restart proceed normally; older entries auto-purge. Assert: PID-from-prior-boot is treated as reclaimable via bootId mismatch.

### Integration (`tests/integration/multi-machine-no-replay.test.ts`)

- Create queue with entries on machine A. Snapshot+restore the project dir on machine B. Assert: queue is empty on B (gitignored + backup-excluded).

### Integration (`tests/integration/shared-worktree-no-collision.test.ts`)

- Two agents (`A`, `B`) share a single project `.instar/` dir (worktree-monitor case). Both run their relay scripts concurrently with different agent IDs and tokens. Assert: each agent's queue lives at `pending-relay.<id>.sqlite`; no row written by A is observable from B's sentinel; flock contention resolves cleanly.

### Integration (`tests/integration/sqlite-fallback-alpine.test.ts`)

- Spin up a minimal environment with `sqlite3` CLI absent. Assert: server boot raises `sqlite3-cli-missing` degradation; the script's `node:sqlite` fallback successfully writes and reads the queue end-to-end.

### Integration (`tests/integration/cross-version-upgrade.test.ts`)

- NEW script + OLD server (no `/whoami` route): script falls back to `/health` + token-only, raises one degradation event, delivery still works.
- OLD script + NEW server: token-only auth still accepted within deprecation window; deprecation log dedup'd to ≤1/hr/source-agent.

## 7. Scope additions from review (no orphan TODOs)

The round-1 spec deferred a **templates-drift verifier** to a follow-up PR. Per `feedback_no_out_of_scope_trap` and Integration finding #8, that orphan-note pattern is the wrong shape for the *root cause* of this incident. Bringing it into this PR:

- New `scripts/verify-deployed-templates.ts`: enumerates known-deployed templates (their canonical paths + SHA history), scans all agents on the host (`~/.instar/agents/*` + `~/Documents/Projects/*/.instar/`), and reports drift. Wired as a daily job (`.instar/jobs.json`) with a degradation event on first detection.
- Same migration step as Layer 1 1a, generalized: any drifted template gets a `.new` candidate written and a degradation event raised, never an in-place overwrite of user-modified content.
- **Kill-switch:** `monitoring.templatesDriftVerifier.enabled` (default true) lets operators with intentionally customized scripts disable the daily noise. Findings route to `DegradationReporter` (the existing channel for operator-visible warnings); `instar-cli` surfaces them under `instar status`. Degradation events are deduped per-`(template-path, current-SHA)` so a long-running drift produces one event, not 365.

## 8. Rollback

- **Layer 1a (port fix):** revert template + delete migrator step. Existing migrated scripts continue to work (port-from-config is additive). Backup files remain on disk for operator recovery.
- **Layer 1b/1c (agent-id binding + `/whoami`):** old scripts still work during a one-minor-version deprecation window (see §1b). Beyond that, revert removes the deprecation and lets bare-token requests through again — net regression on the originating incident class. Document the deprecation window explicitly in the upgrade notes.
- **Layer 2 (SQLite queue + endpoint):** revert script changes; queue stops growing. Existing SQLite file becomes inert. If sentinel reverted too, queue is operator-drainable via `sqlite3` CLI.
- **Layer 3 (sentinel):** flip feature flag off in default config; revert source. Pending entries become inert.

No persistent schema changes outside the per-agent SQLite file (which is gitignored, backup-excluded, and never replayed cross-machine).

## 9. Acceptance criteria

1. The original incident reproduced as integration test recovers automatically and delivers on the original topic with no token leak.
2. No code path adds a second authority over outbound content (tone gate remains sole authority); sentinel-emitted text is fixed-template only, with templates pre-approved at server boot.
3. Layer 1 ships unconditionally; Layer 3 is feature-flagged with a written rollout gate (§3i).
4. Side-effects artifact at `upgrades/side-effects/telegram-delivery-robustness.md` complete with second-pass review (high-risk: outbound messaging + recovery infra + auth surface change).
5. All test files pass; integration tests use ephemeral ports; no mocks in cross-port reproduction.
6. `.instar/.gitignore` migrator runs on upgrade; regression test asserts queue files are git-ignored on every supported agent layout.
7. Templates-drift verifier ships in same PR; daily job wired; orphan-TODO commitments deleted from spec.

## 10. Round-1 review log

40+ findings collected from 4 internal reviewers (security, scalability, adversarial, integration) and 3 external models (GPT, Gemini, Grok). Material findings addressed in this rev:

| Theme | Reviewers | Resolution in this rev |
|---|---|---|
| Cross-port token leakage on re-resolve | Security #1, Adversarial #2, GPT, Grok | §4 Layer 1b/1c — agent-id binding + `/whoami` identity check before any auth-bearing send |
| 403 conflated with revoked/banned | Security #2, GPT | §4 Layer 2b classification table — structured 403 sub-codes, default-deny on unstructured |
| Endpoint payload-spam DoS | Security #3, Scalability #10 | §4 Layer 2c — caps + token bucket + agent-id auth |
| Plaintext message bodies + permissions | Security #4, GPT (privacy) | §4 Layer 3g — 0600 perms, secret redaction, retention table |
| Tone-gate content leak via escalation | Security #5, Adversarial #7 | §4 Layer 3d step 3 + §3f — fixed templates, no excerpting, re-gate on recovery |
| 422 race poisoning queue | Security #6 | §4 Layer 2b — only `recoverable:true` body hint enters queue |
| Lockfile/heartbeat ambiguity | Security #7, Scalability #5, Adversarial #3, GPT, Grok | §4 Layer 3b — `flock(2)` + `bootId:pid:leaseUntil` |
| Predictable path → file-bombing | Security #8, Scalability #2 | §4 Layer 3g — size cap + dead-letter spillover + degradation event |
| No idempotency on re-attempt | Security #9, GPT | §4 Layer 3d step 4 — server-side `delivery_id` LRU dedup |
| 30s tick wastes cycles + recovery floor | Scalability #1 | §4 Layer 3a — SSE primary + 5min watchdog backstop |
| Unbounded queue growth, no rotation | Scalability #2/#3 | §4 Layer 3g — size cap + dead-letter spillover |
| Retry budget shape vs realistic outage | Scalability #6 | §4 Layer 3c — 9-step exponential backoff to 4h within 24h TTL |
| Migration idempotency untested | Scalability #7 | §6 unit test — double-run idempotency assertion |
| Canary selection bias | Scalability #8 | §3i rollout gate — written threshold including ≥3-agent host |
| Escalation embeds full text | Scalability #9, GPT | §3f fixed template, no excerpting |
| textHash whitespace fragility | Adversarial #1 | §4 Layer 2a — text_hash on normalized text + delivery_id dedup as primary |
| Stampede after outage | Adversarial #4 | §3c — per-topic rate cap + digest |
| Marker breaks code fences / 4096 limit | Adversarial #5, Gemini | §3e — moved to follow-up reply |
| Escalation budget ambiguity | Adversarial #6, Grok | §3f — explicit state machine + circuit breaker |
| 422-on-recovery silent swallow | Adversarial #7 | §4 Layer 3d step 3 — user-visible meta-notice |
| Persistent-config infinite loop | Adversarial #8 | §3f — circuit breaker after 5 consecutive escalation failures |
| PID reuse across boots | Adversarial #9, GPT, Grok | §4 Layer 3b — bootId in claim record |
| Custom-script overwrite | Integration #1, GPT, Grok | §4 Layer 1a — SHA-based detection + `.new` candidate path |
| Backup/restore replay | Integration #2 | §3h — backup-excluded + restore-staleness gate |
| Multi-machine git-sync replay | Integration #3 | §3h — `.gitignore` migrator + regression test |
| Old script vs new server skew | Integration #4 | §4 Layer 1b — one-minor-version deprecation window with logging |
| No dashboard surface | Integration #5 | §3i — `/delivery-queue` endpoint + dashboard panel |
| No telemetry for rollout | Integration #6 | §3i — counters file + written rollout gate |
| Hardcoded ports in test | Integration #7 | §6 — ephemeral ports throughout |
| Templates drift orphan TODO | Integration #8 | §7 — pulled into this PR, no orphan |
| JSONL atomicity / concurrent rewrite | Gemini, Grok, GPT | §4 Layer 2a — replaced JSONL with SQLite |
| Marker breaks Telegram 4096 | Gemini | §3e — moved to follow-up reply |
| Event POST leaks to wrong server | Gemini | §4 Layer 2c — original-port-only + agent-id auth |
| Multi-tenant fs collisions | Grok, GPT | All `.instar/state/*` paths are per-agent already; agent-id binding closes the auth dimension |
| Signal-vs-authority partly load-bearing | GPT | §5 — fixed-template content, single tone-gate authority on every send |
| `/health` ≠ identity | Security, Adversarial, GPT | §4 Layer 1c — `/whoami` is the authed identity probe; `/health` retains its public-probe role |

Non-material findings (cosmetic, repeats, or rejected with reason): see iteration log in convergence report.
