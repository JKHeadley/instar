# Side-effects review — bare fingerprint-prefix addressing in `resolveAgent`

**Change:** `ThreadlineClient.resolveAgent` gains a bare fingerprint-prefix branch
(`findAgentByFingerprintPrefix`), so the 8-char fingerprint `threadline_discover`
emits is an address `threadline_send` will actually accept.

**Discovered:** live, 2026-07-27. Echo → instar-codey. Both agents healthy, both
relay-connected, correct chat, correct topic. Every send answered
`Agent not found: "7970149e"`. Codey's own reply to Echo failed with the mirror-image
error `Agent not found: "63b1dbb2"`. Neither agent was misconfigured — the address one
tool handed out was an address the other tool refused.

## 1. Over-block — what legitimate input does this reject that it shouldn't?

None. The new branch only ever *adds* resolutions; it returns `undefined` for any input
that is not a bare hex string of 4–64 chars, and for any hex string that matches no
known fingerprint. In both cases control falls through to the pre-existing name path
unchanged.

The one input class that now behaves differently in a *rejecting* direction is an
**ambiguous** prefix — two known agents sharing it. That previously resolved to `null`
("not found"); it now throws a named-candidates error. This is strictly more informative
than the old outcome, and the alternative (silently picking) is the failure this review
most wants to prevent. See §4.

## 2. Under-block — what does this still miss?

- **Discover still emits 8 chars while its neighbouring comment says 32.**
  `ThreadlineMCPServer.ts` sets `entry.fingerprint = a.publicKey.substring(0, 8)` at two
  sites (lines 510, 870 on main) beside a comment reading "fingerprint = first 32 hex
  chars". This change makes the 8-char form *work* rather than making the two halves
  agree. Deliberate: changing discover's output is a contract change to every existing
  consumer, whereas widening the resolver is backward-compatible and fixes all current
  callers at once. The inconsistency is recorded here rather than silently fixed.
  <!-- tracked: ACT-1380 -->
- **A 4-char prefix is permitted.** With a large enough agent population, 4 hex chars
  will collide. Collisions surface as the ambiguity error rather than a wrong delivery,
  so the failure mode is safe, but it is a usability cliff at scale rather than a
  correctness one.
- This does not address unreachability caused by anything other than addressing — a dark
  relay, an unpaired peer, or a trust refusal are all untouched.

## 3. Level-of-abstraction fit

Correct layer. `resolveAgent` is the single funnel every send path already goes through
(`routes.ts:12841` calls `relayClient.resolveAgent(targetAgent)` and 404s on null). Fixing
it here fixes the MCP tool, the HTTP route, and any future caller at once. Fixing it in
the MCP tool would have left the HTTP route broken; fixing it in discover would have
changed a published output shape without helping callers who already hold a short
fingerprint from an older message or a log line.

## 4. Signal vs authority compliance

`resolveAgent` is an *authority* — its return value directly determines which peer
receives a message. That is precisely why the new branch **requires a unique match**.

The tempting implementation is "match the prefix, take the first hit." That would have
made my own send succeed today, because discover returned **two** `instar-codey` rows
(`092c1cac…` and `7970149e…`) and only one is live. Taking the first would have delivered
to whichever the map happened to yield first — a silent wrong-recipient delivery, which is
categorically worse than a failed send, because the sender believes it succeeded.

So the branch reuses the existing convention exactly:
- exactly one match → resolve
- several matches, exactly one online → resolve to the live one (`pickSingleOnline`, the
  same live-vs-dead twin allowance `findAgentByName` already makes)
- otherwise → throw, naming every candidate and its full fingerprint

Ambiguity is surfaced to the caller as a decision, never absorbed as a guess.

## 5. Interactions

- **Ordering.** The prefix branch runs after exact-match (1) and before name parsing (2).
  It cannot shadow name resolution, because a zero-match prefix returns `undefined` and
  falls through. An agent whose *name* is hex-like resolves as before — covered by an
  explicit regression test.
- **`name:prefix` syntax.** Untouched. `parseAgentAddress` only engages on a colon, and a
  bare prefix has none. The 4-char floor is deliberately the same one `parseAgentAddress`
  already uses for its suffix, so the two addressing forms agree on what counts as a
  prefix.
- **Cold cache.** The retry after `autoDiscover()` in step 4 now re-tries the prefix as
  well as the name. Without this the fix would work only when the cache was already warm —
  which is the very condition that is false on a first send after boot.
- **Rediscovery cooldown.** Unchanged; the prefix branch performs no discovery of its own.

## 6. External surfaces

No wire-format, protocol, or persisted-state change. No new config, route, or dependency.
The observable difference is that an address which previously 404'd now resolves, plus one
new error message string on the ambiguous path. Nothing depends on timing or conversation
state.

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local by design, and correctly so — no justification marker needed because no
durable state is introduced.** `knownAgents` is a process-local in-memory cache rebuilt
from relay discovery on every connect. Two machines running this agent each resolve
against their own live view of the relay, which is the correct behaviour: reachability is
a property of *this* process's relay connection, not a fact to replicate. Replicating a
resolution cache would actively harm — a peer that machine A can reach may be unreachable
from machine B, and a shared cache would assert otherwise.

No user-facing notice, no generated URL, no state that could strand on topic transfer.

## 8. Rollback cost

Near zero. Revert the commit; the added method becomes unreferenced and the resolver
returns to exact-match-plus-name. No migration, no persisted state, no agent-state repair.
Any address that worked before still works after a revert — the change is purely additive
to the set of inputs that resolve.

## Evidence

Tests were verified to fail against unmodified source before the fix was applied, so they
demonstrably exercise the bug rather than merely accompanying it:

```
# fix reverted, tests only
Tests  5 failed | 21 passed (26)
  ✗ resolves the 8-char prefix that discover emits (the reported bug) → null
  ✗ is case-insensitive on the prefix                                 → null
  ✗ THROWS on an ambiguous prefix rather than delivering to the wrong agent → resolved null
  ✗ names every candidate in the ambiguity error                      → resolved null
  ✗ prefers the single LIVE row when a stale twin shares the prefix    → null

# fix applied
Tests  26 passed (26)

# regression surface
tests/unit/threadline/ — 65 files, 1581 passed
tsc --noEmit — clean
```

The 21 that pass in both runs are the deliberate regression guards (full fingerprint,
ordinary name, hex-like name, unknown prefix → null); they *should* pass either way, and
their passing on unfixed source is what makes them meaningful as guards.
