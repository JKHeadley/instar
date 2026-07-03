# Durable conversation identity — the proof consumer: funnel delivery, the E1 guard, bind-pins, the bind token, and the §4 consolidation (increment 2)

<!-- bump: minor -->

## What Changed

Per `docs/specs/durable-conversation-identity.md` (review-converged round 11 —
0 CRITICAL / 0 MAJOR — approved under the standing Session-A preapproval,
topic 29836), §6.1 STEP 2 lands: the FLAGSHIP proof consumer. The Phase-1
live proof this increment delivers — *a commitment made in a Slack thread
survives a server restart and lands back in that exact thread* — is now real
machinery, dev-gated (live-on-dev in dry-run, dark-on-fleet). The Telegram
lane is byte-identical when the gate is off.

- **The `deliverToConversation` funnel grows its §5 arms:** the §5.1
  permanent-vs-transient classification over `SlackApiError.slackError` (the
  pinned set `{is_archived, channel_not_found, not_in_channel}` — the code is
  `is_archived`, not `channel_archived` — plus the L5 drift canary that treats
  an unrecognized permanent-SHAPED code as transient + raises ONE attention);
  the §3.5.2 `boundTuple` delivery overlay with the SHARED id↔tuple coherence
  check (an incoherent pair is a typed non-delivery on NEITHER field — R6-M4);
  reachability flip/auto-clear + flap dampening + mass-unreachable P17
  coalescing; and two new typed outcomes — `already-delivered-recently`
  (DELIVERED-EQUIVALENT for sequencing, R7-M1) and the `standDown`/`permanent`
  flags.
- **The §5.0(a) E1 ambiguous-outcome idempotency guard** — durable
  `send-intent` / `ambiguous-send` / `send-retire` / `send-intent-resolved`
  journal WRITERS. A caller with a logical send identity rides the
  RETIREMENT-based lane; a windowless caller rides the WINDOW-based
  content-hash lane (R3-M1/R7-M2). A crash-orphaned intent converts at boot BY
  ITS RECORDED LANE (logical → a suppressor; content-hash → resolved toward
  retry — R8-M1). The seq-persist-before-retire inter-store order (R5-M3)
  closes the last double-post window.
- **PromiseBeacon rides the funnel (the swap):** every beacon send routes
  through `deliverToConversation` (logicalSendId = `<commitmentId>:<sendSeq>`,
  the durable monotonic seq persisted via an ATOMIC tmp→rename write — R4-M2/
  R4-minor-1). `fire()` now re-arms in `finally` so a thrown send can never
  silently kill the timer. A permanent §5.1 failure dead-letters; a transient
  one dead-letters only after N consecutive failures (R3-M15). A non-owning
  refusal STANDS the beacon DOWN and the ownership recheck (riding the
  existing external-block sweep — no new timer) picks it back up when this
  machine becomes the owner (R3-M16). Delivered-equivalent suppression
  advances the seq so the beacon is never muted past one cadence (R7-M1).
- **The §3.5.2 bind-pin overlay + record-carried `boundTuple`:** opening a
  commitment on a minted id registers the conversation durably (WAL fsynced)
  and records a refcounted bind-pin; the bind-time tuple is denormalized onto
  the commitment so ANY machine that later delivers it reconstructs the pin
  (an ownership migration can't reopen the C3-class misdelivery). The pin is
  released only when the binding permanently closes.
- **The §7 bind-time authority:** a stateless, self-authenticating per-session
  bind token (HMAC over `{sessionName, bootstrapConversationIds, mintedAt}`),
  minted at spawn into `INSTAR_BIND_TOKEN` and verified at `POST /commitments`.
  A durable-state open on a MINTED id is fail-closed without a valid token
  scoped to that conversation; a positive-id bind keeps today's behavior. The
  token survives any number of server restarts (a live tmux session outlives
  the server — R4-M3); rotating the secret is the loud revocation lever.
- **The §4 hash-copy consolidation (deferred from increment 1):** the three
  legacy `-(Math.abs(hash)+1)` copies collapse onto `candidateIdForRoutingKey`.
  `slackRoutingKeySyntheticId` is a re-export; the `routes.ts` build-heartbeat
  inline copy mints through the registry. The mint-idiom ratchet allowlist
  shrinks accordingly — a fourth copy is still a CI failure.
- **The §5.2 `/telegram/reply/:topicId` 400-on-negative:** a negative id is a
  minted conversation and is refused with a 400 the recovery policy already
  classifies terminal — no negative-id relay row retries forever.

Behavior-identical for existing flows: the funnel's `id<0` arm is dev-gated +
dryRun-first; the beacon falls back to the legacy send path when the funnel
dep is unwired; the §4 consolidation is value-identical by golden parity.

## What to Tell Your User

<!-- audience: agent-only, maturity: experimental -->
- **Promises I make in a Slack thread can now survive a restart (development
  agents only, still in dry-run):** if I say "I'll report back in 10 minutes"
  in a Slack thread and my server restarts, the follow-up heartbeat lands back
  in that exact thread — the same durability Telegram already has. This rides
  behind a development-only switch in dry-run first (I log what I *would*
  deliver before I actually deliver), so nothing changes on the fleet yet. A
  duplicate follow-up can't slip through: if a send's outcome is ambiguous
  (Slack maybe got it, maybe not), I never double-post the same heartbeat.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Slack follow-through delivery (dark/dry-first) | `conversationIdentity.followThrough` (dev-gated; `dryRun: true` first) — a commitment on a minted id delivers its beacon into the Slack thread |
| Per-session bind authority | `INSTAR_BIND_TOKEN` (spawn env) scopes a durable-state open (`POST /commitments`) to the session's own conversation |
| Negative-id guard | `POST /telegram/reply/:topicId` returns 400 for a negative id (use the conversation funnel) |
| Send-guard observability | `GET /conversations/health` → `sendGuard` (unretired entries, unresolved intents, bind-pins) |

## Evidence

- Spec converged round 11 (0 CRITICAL / 0 MAJOR), approved under the standing
  Session-A operator preapproval (topic 29836).
- All three test tiers shipped and green: unit (funnel §5.1 classification +
  E1 idempotency both lanes + boundTuple overlay; registry bind-pin/
  reachability/send-guard writers + the R8-M1 boot conversion; the shared
  coherence predicate; the stateless bind-token round-trip incl. restart
  survival + rotation revocation; the PromiseBeacon funnel swap incl. R5-M3
  order, R7-M1 un-mute, stand-down pickup, permanent/transient dead-letter,
  legacy passthrough), integration (the `/telegram/reply` 400-on-negative and
  the §7 bind gate through the REAL routes + authMiddleware), e2e (the
  increment-1 lifecycle + mint-idiom ratchet stay green after the §4
  consolidation).
- Continuation (tracked in the side-effects artifact): the remaining §4
  server.ts closure retirement (to `readIdForRoutingKey`/`idForSessionKey`)
  and the full live-proof scenario matrix on the dev agent's Slack workspace.
