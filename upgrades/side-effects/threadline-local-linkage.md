# Side-effects review — same-machine Threadline topic linkage fix

## The change

`/messages/relay-agent` (same-machine inbound) now resolves the sender's name to
its fingerprint from `threadline/known-agents.json` and passes a
`RelayMessageContext` (`trust.kind: 'plaintext-tofu'`) into
`handleInboundMessage`, where previously it passed no context at all. This lets
the anti-hijack guard's identity check match a co-located peer's fingerprint
against the stored thread owner, so the reply is no longer false-isolated and
the existing Thread→Topic linkage routes it back to the originating topic.

## Security review (this touches the anti-hijack guard's inputs)

- **No weakening of the guard.** The guard logic is unchanged. The fix only
  supplies the *correct identity* it was missing. Trust kind is `plaintext-tofu`,
  NOT `verified`, so `cryptoVerified` stays false and the guard still runs its
  identity comparison — it now simply has the fingerprint to compare. A
  regression test asserts that when no fingerprint resolves, isolation still
  fires.
- **Scope is same-machine only.** `/messages/relay-agent` is gated by middleware
  as a same-machine source (`'relay-agent': null // No check — same machine`); a
  remote peer cannot reach it. Resolving identity from the local registry is
  therefore trustworthy. The cross-machine relay path (`source === 'machine'`,
  Ed25519-verified) is not touched.
- **Affinity optimizations stay conservative.** `recordAffinity`/`peekAffinity`
  gate on `trust.kind === 'verified'`; with `plaintext-tofu` they remain no-ops,
  exactly as when the context was undefined. No new warm-session admission.

## Failure modes considered

- **Registry read fails / file missing:** wrapped in try/catch that logs and
  leaves `localRelayContext` undefined → falls back to prior behavior
  (isolation). Never throws, never 500s a request that already returned.
- **Name resolves to no fingerprint (unknown peer):** context stays undefined →
  prior behavior. No new trust granted to an unknown sender.
- **Stored owner was a name (old storage), reply presents fingerprint:** the
  guard's existing name-branch (`peer === inboundName`) still matches; unaffected.

## Blast radius

One in-scope file (`src/server/routes.ts`), one added resolution block before an
existing call, plus two unit tests. No schema, migration, config, or template
changes. No fleet-rollout surface. Reversible by reverting the commit.
