# Side-effects review — user-channel liveness in the channel registry

**Change:** the two direct USER channels (Telegram, Slack) join the peer channel registry, with
liveness probes that read live adapter state instead of configuration. `ChannelDefinition` and
`ChannelReport` gain an `audience: 'peer' | 'user'` field.

**Decision point touched:** none that blocks. This is a read surface — it informs a routing choice a
caller makes, and holds no authority over it. `advisory: true` is already on the response.

## 1. Over-block — what legitimate inputs does this reject that it shouldn't?

Nothing is rejected; nothing is gated. The nearest analogue is reporting a *usable* channel as
unusable, which would cause a caller to avoid a working path.

One case deliberately risks that and should be named: a Telegram that is **not polling with no
recorded reason** reports `unknown`, not `working`. If the adapter was stopped deliberately and could
still send, this understates it. That direction is chosen on purpose — over-reporting liveness is the
defect being fixed, and `unknown` carries its reason rather than pretending to a verdict.

Transient errors do NOT downgrade a live channel: still-polling with a non-zero consecutive error
count stays `working`, with the count named in the detail. Marking that broken would be the opposite
over-block.

## 2. Under-block — what does it still miss?

- **A live reading is not a promise.** `working` means the loop was polling when asked. It can die a
  second later. No probe can fix that; the response carries `generatedAt`.
- **No round-trip is attempted.** Telegram `working` means the poll loop is up, not that a message to
  a specific topic would land (a topic could be deleted, a user could have blocked the bot). The
  peer registry's `mutual-ssh` entry already makes the same distinction in its own detail text, and
  this follows that precedent rather than overstating.
- **Slack is one workspace.** `isConnected()` is per-adapter; a multi-workspace setup is not modelled.
- **Other user surfaces are absent** — WhatsApp and iMessage adapters exist in the tree. They are not
  in this change, and the registry will therefore not claim anything about them. Under the registry's
  own "absence is impossible" property this is a real limit: a channel with no row cannot report that
  it is missing. Called out rather than quietly scoped away.

## 3. Level-of-abstraction fit

The user definitions live in a NEW file (`src/core/userChannels.ts`) rather than being added to
`src/core/instarChannels.ts`, whose header declares an explicit "PEER-TO-PEER only" scope discipline
and justifies two prior exclusions. Widening that file would have silently discarded a deliberate
decision by its author.

The two lists are composed at the route and resolved by the same `resolveChannels`, so the registry's
invariants (one row per definition, bounded probes, `unknown` on failure) apply identically to both
without being reimplemented.

`audience` is data on the channel, not two registries, because the peer-vs-user choice is itself a
routing decision a caller must be able to weigh. Two surfaces would require the caller to already
know which to consult — the arbitrariness the registry exists to remove.

## 4. Signal vs authority

Pure signal. The registry reports; it never routes, blocks, or sends. The response is already flagged
`advisory: true`. The mapping functions (`telegramStateFrom`, `slackStateFrom`) are exported and pure
precisely so the verdict logic can be pinned by tests without constructing an adapter — the mapping
is where a wrong verdict would originate.

## 5. Interactions

- **`/capabilities`** — unchanged. It keeps reporting `telegram: { configured: true }`, which remains
  correct for what it measures (configuration). This adds the missing state reading; it does not
  correct or replace the config reading, and the two answer different questions.
- **Peer channels** — behaviour unchanged; they gain an `audience: 'peer'` tag. Because `audience` is
  required on `ChannelDefinition`, a future channel cannot be added untagged: it is a compile error,
  not a silent default.
- **No double-fire / no races** — read-only, no writes, no timers of its own. Probes are bounded by
  the registry's existing 3s timeout.

## 6. External surfaces

`GET /channels` gains two rows and every row gains an `audience` field. Additive: existing consumers
reading `id`/`state`/`detail` are unaffected. No new route, no config key, no user-visible string.

## 7. Multi-machine posture

**Machine-local BY DESIGN**, `machine-local-justification: physical-credential-locality` — a Telegram
bot token and its long-poll loop, and a Slack Socket Mode connection, live in one process on one
machine. "Is my Telegram polling?" is only meaningful about the machine asked; replicating another
machine's answer would assert liveness this process cannot observe. This matches the peer registry,
which is machine-local for the same reason (its relay/SSH probes read local runtime state).

## 8. Rollback cost

Low. One new file, one required field on two interfaces, one route composing two lists. No data
migration, no config, no persisted state. Reverting restores the prior behaviour exactly — including
the gap.

## Refusals demonstrated (command + output)

Falsification 1 — make the Telegram probe read EXISTENCE instead of liveness (`if (status !== null)`
in place of `if (status.started)`), i.e. exactly what `/capabilities` does:

```
× THE FIX: a configured-but-DEAD Telegram is never reported as working
× a missing bot token is a credential verdict, not a network one
× a network death is broken — distinct from a credential problem
× stopped for NO recorded reason is unknown — never working, never a confident broken
  Tests  4 failed | 12 passed (16)
```

Falsification 2 — give Slack "ever connected" semantics (`if (enabled)` in place of
`if (connected)`), the exact trap its own source warns about:

```
× THE TRAP: enabled with the socket DOWN is broken, not working
  Tests  1 failed | 15 passed (16)
```

Restored: `Tests 35 passed (35)` across `channel-registry`, `channel-registry-claims` and
`user-channel-liveness`; `npx tsc --noEmit` exit 0.

Two source ratchets are included so the probes cannot drift back: one asserts `userChannels.ts` never
reads a `.configured` property or a `config.*` value, the other asserts the route wiring uses
`isConnected()` and never `slackAdapter.started`.
