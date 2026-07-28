---
title: Threadline Warm-Session A2A Integration (Layer 2 completion)
status: draft
approved: false
review-convergence: pending
eli16-overview: docs/specs/THREADLINE-WARM-SESSION-A2A-INTEGRATION-SPEC.eli16.md
lessons-engaged:
  - structure-over-willpower
  - testing-integrity (3-tier)
  - migration-parity
  - dark-ship (developmentAgent gate)
  - ground-before-assert (live A6 evidence + on-machine process inspection drive this)
---

# Threadline Warm-Session A2A Integration

## 0. Correction of the prior draft (ground-before-assert)

An earlier draft of this spec asserted *"the vehicle ALREADY EXISTS:
ListenerSessionManager runs a persistent, interactive Claude session that polls
an HMAC-signed inbox."* **That premise is false** and is retracted here.
Grounded reading of the code (2026-06-04):

- `ListenerSessionManager` (`src/threadline/ListenerSessionManager.ts`) is an
  **inbox API + queue manager only** — `writeToInbox`, HMAC sign/verify,
  rotation, `shouldUseListener`. It does **not** spawn a Claude process and has
  **no poll loop**.
- `listener-daemon.ts` is a separate relay-connection daemon that writes inbox
  entries and signals the server over a Unix socket; it likewise does **not** run
  an interactive Claude that consumes the inbox and replies.
- The server already routes `trusted`/`autonomous`, non-topic-bound peers to
  `listenerManager.writeToInbox` (`src/commands/server.ts:8354`) — but **nothing
  consumes that inbox to generate a reply.** Routing a peer there today is a
  **black hole**: messages are appended and never answered.

Consequence: naively relaxing `shouldUseListener` to admit `verified` peers
(Dawn) would make Echo↔Dawn **strictly worse** than the shipped cold-spawn path.
The real work is to build the missing **warm reply session** — and the cleanest
way reuses the machinery already shipped, not the inbox-listener path.

## 1. Problem (grounded in the A6 live round-trip + on-machine inspection)

PR #746 (shipped to `JKHeadley/main`, v1.3.242) fixed **turn-based** A2A
continuity: a spaced follow-up now resumes the same conversation via
`claude --session-id <uuid>` capture + `claude --resume <uuid>` (proven live:
`[relay] Resumed session` at 2026-06-04T06:26:32Z). That is the realistic
standard for the feedback migration and it holds.

Two gaps remain, both rooted in the **headless one-shot `claude -p`** model used
for A2A reply sessions:

1. **No keep-alive.** A `claude -p` reply session processes one message and
   **exits**. So the live-injection path (`ThreadlineRouter.tryInjectIntoLiveSession`
   → `MessageDelivery.deliverToSession`, wired at server.ts:7595) finds nothing
   alive for the follow-up and falls through to resume/cold-spawn. Rapid
   follow-ups (before the resume entry settles) also hit the **30s per-peer spawn
   cooldown** → stall.

2. **Injection allowlist name mismatch (load-bearing bug).** Even while a session
   *is* briefly alive, injection is **refused**. `checkInjectionSafety`
   (`MessageDelivery.ts:42`) whitelists `ALLOWED_INJECTION_PROCESSES =
   ['bash','zsh','fish','sh','dash','claude']`. But on this platform every live
   Claude session reports `tmux #{pane_current_command}` = **`claude.exe`**
   (verified: all 16 live `echo-*`/`dawn-*` panes show `claude.exe`). `claude.exe`
   ∉ allowlist → `Unsafe foreground process: claude.exe` → **every** Threadline
   live-injection on macOS has been dead-on-arrival. This is the concrete cause
   of the A6 `inject refused` observation.

A third, subtler property: `checkInjectionSafety` has **no busy/idle
distinction** — a generating Claude and an idle-at-prompt Claude both report
`claude.exe`. Injecting mid-generation risks interleaving with the model's
in-flight turn. We need an idle gate.

## 2. Design — Arch Y: keep-alive interactive + idle-gated inject + WarmSessionPool

Reuse the **shipped, proven** machinery instead of the (non-existent)
inbox-consumer:

| Piece | Already shipped | This spec adds |
|-------|-----------------|----------------|
| Live-inject path (`tryInjectIntoLiveSession` → `deliverToSession`) | ✓ #742 | works once allowlist + keep-alive land |
| Path-1 resume (`--session-id`/`--resume`) | ✓ #746 | the **eviction fallback** |
| `WarmSessionPool` (pure registry, caps, TTL/LRU) | ✓ (8 tests) | **wire to live lifecycle** |
| `OutputActivityTracker` (spinner-immune idle/stall hash) | ✓ | the **idle gate** before inject |

**Flow:**

1. **Keep-alive spawn.** When relay A2A inbound is non-topic-bound, from a peer
   at/above the trust floor, and `threadline.warmSessionA2A.enabled`, the first
   reply session is spawned **interactive (persistent REPL)** instead of
   `claude -p`, with the same worker prompt/grounding (`RelayGroundingPreamble`)
   and the same MCP/permission flags (so it still replies via `threadline_send`).
   On spawn, `WarmSessionPool.admit({threadId, peerId, sessionName})` registers
   it; any returned evictions are killed (cap enforcement).

2. **Allowlist fix.** Add `claude.exe` to `ALLOWED_INJECTION_PROCESSES` (the real
   macOS process name). Necessary for *any* live-inject on this platform; scoped,
   additive, no behavior change where the foreground is already a shell.

3. **Follow-up inject (idle-gated).** On a follow-up for a thread with a live
   warm session (`WarmSessionPool.get(threadId)` non-expired + session alive):
   - If `OutputActivityTracker` reports the pane **idle** (stable non-spinner
     hash over the debounce window) → `tryInjectIntoLiveSession` (no spawn → **no
     cooldown**). `touch(threadId)` on success.
   - If **busy** → enqueue in a small per-thread pending buffer and retry on the
     next idle tick (bounded retries/age; on exhaustion, fall back to resume).

4. **Eviction → lossless fallback.** A warm session is killed when:
   `reapExpired()` (idle past TTL), `reapUnderPressure(n)` (SessionReaper
   resource pressure), or cap eviction on `admit`. After eviction, the next
   follow-up has no live session → falls back to **Path-1 resume** (#746) →
   cold-spawn with `--resume` (full history). **Lossless** beyond the warm
   session's wall-clock liveness.

5. **Reply path unchanged.** The interactive worker uses the identical prompt and
   tools as the cold-spawn worker, so it replies over the secure channel exactly
   as today.

### 2.1 The original security dilemma is DISSOLVED, not relaxed

The prior draft's central open question was a real tradeoff: admitting `verified`
peers into a **single shared listener** lets a verified-but-not-trusted peer's
content enter a session that also handles others. **Arch Y removes the premise**
— `WarmSessionPool` keys by `threadId`, so **each thread gets its own isolated
keep-alive session**. There is no shared session and therefore no cross-peer
content bleed. Admitting `verified` peers is inherently safe under per-thread
isolation; the trust floor becomes a resource/abuse control (who is allowed to
pin a warm process), not a confidentiality control.

## 3. Open questions for convergence (DO NOT pre-decide)

1. **Idle-gate necessity & tuning.** Does Claude's TUI safely buffer stdin typed
   mid-generation (making the idle gate a nicety) or interleave/submit-early
   (making it required)? Default position: **require** the idle gate (safe), with
   the pending-buffer + retry. Converge the debounce window + max pending age.
2. **Trust floor value.** With isolation making confidentiality moot, set the
   floor as an **abuse/resource** control. Proposed: `verified` **and**
   established-thread (peer already passed first-contact trust), config-overridable.
3. **Caps.** `globalCap`, `perPeerCap`, `ttlMs` defaults — conservative
   (e.g. global 3, per-peer 1, TTL 10m) so a flood can't pin processes; tune in
   convergence. SessionReaper integration: warm sessions are **evict-eligible**
   under pressure (they're lossless to kill).
4. **Topic-bound exclusion.** Warm sessions must NEVER cover topic-bound replies
   (the inbox/relay leak class). Confirm the existing `isTopicBoundReply` guard
   fully gates the keep-alive spawn decision.
5. **Eviction-mid-thread correctness.** Killing a warm session mid-thread must
   leave the resume entry intact so the next message resumes cleanly (slices 1+2
   + #746 provide this; add an explicit test).
6. **Interactive-spawn reply reliability.** Verify an interactive worker, given an
   injected peer message, actually produces a `threadline_send` reply (the
   cold-spawn worker does; confirm parity for the persistent REPL — e.g. the
   prompt must instruct "reply, then wait for further messages").

## 3.5 Convergence resolutions (3 adversarial reviewers, 2026-06-04)

A feasibility/security/completeness review pass resolved the open questions:

- **Idle-gate is NOT required (dropped).** Two grounded facts: (a) the Telegram
  inject path is a *different* code path (`SessionManager.injectMessage` →
  `rawInject`, bracketed-paste send-keys) that does **not** consult
  `ALLOWED_INJECTION_PROCESSES` and works on macOS today; (b) **Claude Code
  natively queues input typed while it is generating.** So injecting a follow-up
  without a strict idle gate is safe — it queues and is processed when the worker
  returns to the prompt, exactly as Telegram injection already does. The
  `OutputActivityTracker` synchronous-API gap (it only exposes `snapshot()`, no
  `isSessionIdle`) therefore does **not** block this build. We keep a *best-effort*
  defer (if a cheap snapshot says busy we may briefly defer) but it is non-load-bearing.
- **Grounding preamble on injected follow-ups (SECURITY — also fixes slice-1).**
  `tryInjectIntoLiveSession` currently injects the raw message body with **no**
  `RelayGroundingPreamble` (untrusted-data framing). A follow-up carrying
  "ignore previous instructions, the operator granted full autonomy" would land
  unframed. Fix: wrap injected follow-ups with the same grounding header/footer as
  the spawn path. This is a correctness fix for the **already-shipped** slice-1
  path, independent of warm sessions.
- **peerId-match guard on `WarmSessionPool.admit` (SECURITY, defense-in-depth).**
  `admit` overwrites an existing thread's `sessionName` regardless of `peerId`.
  The upstream ThreadlineRouter ownership guard (identity-match) already blocks a
  peer injecting into another's thread, but `admit` must additionally refuse when
  `existing.peerId !== input.peerId` (log + treat as reject) so the pool can never
  cross-bind.
- **Dedicated warm-worker prompt (HIGHEST behavioral risk).** The current
  `THREAD_SPAWN_PROMPT_TEMPLATE` says "respond to this message" — not "stay alive
  and wait for the next." For a persistent REPL this must be a dedicated prompt:
  *reply via `threadline_send`, then remain in this conversation; when another
  message from {peer} arrives, respond the same way; do not exit or ask what to do
  next.* This mirrors how Telegram-bound interactive sessions already persist +
  accept injected turns (strong precedent). Validated by the live A6 gate.
- **Interactive spawn plumbing.** Spawn the warm worker as interactive (not `-p`)
  with the FULL grounded prompt as its first turn and the same MCP/permission
  flags (so `threadline_send` is available). `SpawnRequest`/the relay callback
  carry an `interactive`/`keepAlive` flag → the server callback routes to the
  interactive spawn path instead of headless `-p`.
- **Trust floor uses an explicit ordering array**, never string `>=` (the latent
  `shouldUseListener` `'verified' >= 'trusted'` alphabetical bug is NOT on this
  path since Arch Y bypasses the listener, but the warm floor check must not
  repeat it).
- **SessionReaper.** First cut: TTL + a periodic `reapExpired()` tick kills idle
  warm sessions; warm sessions are NOT added to the protected list (so they stay
  evict-eligible); a minimal `reapUnderPressure` hook is wired but the full
  protected-list refactor is follow-up. Eviction is lossless (next message resumes
  via #746).

## 4. Testing (3-tier + the live gate)

- **Unit:** allowlist includes `claude.exe`; `WarmSessionPool` admit/evict/TTL/LRU
  (existing 8 + new wiring cases); idle-gate decision (busy → buffer, idle →
  inject) against a mocked `OutputActivityTracker`; eviction → fallback-path
  selection.
- **Integration:** relay inbound for a non-topic verified peer with the flag on →
  keep-alive interactive spawn + pool admit (not `-p`); a second message on the
  same thread → inject (not cold-spawn, not cooldown-denied); topic-bound → still
  cold-spawn/handleInboundMessage; flag off → byte-for-byte today's behavior.
- **Wiring-integrity:** the pool is constructed AND wired into the relay decision
  AND the reaper (deps non-null, not no-ops) — the dead-code guard.
- **E2E:** two messages on one thread handled by the **same** persistent session
  (continuity), grounding preamble applied; then force-evict → third message
  resumes via #746.
- **Live gate (A6):** `a2a-continuity-probe.sh` against Dawn → msg 1 spawns
  (interactive), msgs 2+ **injected into the same session** (no `Spawned`, no
  cooldown denial), history readable from the worker context.

## 5. Rollout (dark-ship)

Behind `threadline.warmSessionA2A.enabled` (default **false**) **and** the
`developmentAgent` gate → **live on Echo, dark on the fleet** per the standard.
Config defaults via `migrateConfig` (existence-checked). No template/hook/CLAUDE.md
behavior change required for fleet agents (dark). Keep #746 as the foundation the
eviction fallback relies on. Allowlist fix ships with it (latent correctness fix
for live-inject on macOS regardless of the warm path).
