# Side-effects review — publish-spec-review honest send

**Change.** `publish-spec-review.mjs` spawned `.instar/scripts/telegram-reply.sh` as a
bare relative path and then printed `[published] … delivered to topic N` without
inspecting the spawn result. Now the relay is resolved by walking up from cwd (with the
documented `.claude/scripts/` fallback), and delivery is only claimed when the relay's own
`Sent <n> chars to topic <id>` confirmation is present.

**This bug was filed three times in fifteen days before being fixed:** ACT-616
(2026-07-13, medium), ACT-1390 (2026-07-27, high), ACT-1517 (2026-07-28, high).
Reproduced live at 18:09Z: the ENOENT line and the "delivered" line printed one after the
other, and the operator received nothing.

## 1. Over-block — what legitimate inputs does this reject that it shouldn't?

The delivery check requires the relay's `Sent … chars to topic …` marker, so a future
relay that succeeds *silently* would be reported as NOT delivered — a false negative.
Accepted deliberately: this script's only job is handing the operator something to
approve, so a false "didn't send" (which prints the composed message for manual sending
and exits 1) is strictly safer than a false "sent". If the relay's output contract
changes, this test fails loudly rather than the ask disappearing quietly.

The path walk can in principle find a relay in an unrelated ancestor directory. In the
agent-home/worktree layout the first match walking up is the agent's own relay, and
`INSTAR_AGENT_HOME` takes precedence when set.

## 2. Under-block — what failure modes does this still miss?

- **The relay can confirm a send that Telegram later drops.** `Sent N chars` means the
  relay accepted and posted it; downstream delivery failure is the relay's own retry
  domain (PendingRelayStore / DeliveryFailureSentinel), not this script's.
- **A wrong topic id still "delivers"** — to the wrong place. Not addressed here.
- **Non-`--send` callers are unchanged**: they print the message and the verified link for
  the caller to send, and can still drop it themselves. That path already exits 0
  honestly because it never claims delivery.

## 3. Level-of-abstraction fit

Correct layer. "Where does the relay live" is knowledge the spawning process must have,
and "did the spawn work" is a question only the spawner can ask. Neither belongs to the
relay or the caller. The walk-up specifically encodes the worktree convention
(`docs/specs/AGENT-WORKTREE-CONVENTION-SPEC.md`), which is *why* cwd is reliably not the
agent home.

## 4. Signal vs authority compliance

Compliant, and this is the crux. The script sits on a hook-ENFORCED path: the
`grounding-before-messaging` hook BLOCKS a hand-written spec-review message and directs
the agent here. So this script holds real authority over whether an operator ever sees an
approval ask — and it was reporting success without checking. A brittle, unchecked step
was granted the last word on a human decision point.

The fix adds no new blocking authority. It makes an existing authority *honest*: it now
fails closed (exit 1, message printed for manual sending) instead of failing silent.

## 5. Interactions

- **The grounding hook** is the upstream producer of traffic here; unchanged.
- **telegram-reply.sh** is spawned identically, only via an absolute resolved path. Its
  own duplicate-suppression and tone-gate behaviour are untouched.
- **No double-send risk:** the delivery check is read-only on the result; it never retries.
  A false negative prints the message for a human to send, which could produce a duplicate
  if the relay *had* silently sent it — bounded by the relay's own exact-duplicate
  suppression window.
- No shadowing, no race: one synchronous spawn, one verdict.

## 6. External surfaces

Developer/agent tooling under `skills/`. No runtime agent behaviour, route, config, job,
message schema, or persisted state changes. The only externally visible difference is that
a failed send is now reported as failed — previously it was reported as success.

## 7. Multi-machine posture

**Machine-local BY DESIGN.** The question answered is "where on THIS disk is this agent's
relay script" — a per-machine filesystem fact. Replicating or proxying it would be
incorrect; a peer's relay path says nothing about this machine's. No durable state, no
generated URL, no user-facing notice, so nothing strands on a topic transfer. The rendered
private-view link the script produces is a separate concern and already tunnel-backed.

## 8. Rollback cost

Revert the commit. Two pure exported functions and one call site; no persisted state, no
migration, no config. Reverting restores the false-success behaviour, which is the reason
not to.

## Verification

- 11 unit tests over both exported functions, including the exact production failure
  (ENOENT → `relayDelivered` false) and the worktree walk-up that shipped broken.
- Proven against the real filesystem from the actual worktree: `resolveRelayScript`
  returns the agent home's relay and `fs.existsSync` on it is true.
- The end-to-end fix direction was confirmed before writing the code — running the
  unmodified script from the agent home printed `Sent 408 chars to topic 29723` and
  genuinely delivered, while running it from the worktree printed ENOENT followed by
  "delivered".
