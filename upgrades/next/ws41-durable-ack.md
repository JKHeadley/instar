# WS4.1 follow-up — an operator's ack of a pooled attention item survives the owning machine being briefly offline (durable operator-bound /ack, dark)

<!-- bump: patch -->

<!--
  NOTE: internal multi-machine substrate, dark by default
  (multiMachine.seamlessness.ws41DurableAck, default false). The change touches
  runtime src/ (new RemoteAckStore core module + the POST /attention/:id/remote-ack
  route + config/migrator/awareness), so the tests/docs-only lane does not apply.
  The user-facing sections honestly state the capability only becomes real once an
  operator turns the flag on, and that it is a no-op on a single-machine agent.
-->

## What Changed

The **durable operator-bound /ack** closes the last gap in the WS4.1 pooled attention queue: when you acknowledge or resolve an attention item whose OWNER machine is briefly offline, your ack used to evaporate — the item would reappear OPEN when that machine came back. Now the ack INTENT (with the authenticated operator who performed it) is persisted in a new durable store (`src/core/RemoteAckStore.ts`) and re-delivered to the owner on its return/boot, so your acknowledgement sticks. The store NEVER authorizes anything — the owner revalidates the carried principal through its own normal ack authorization at apply time; the durable layer only remembers intent. Exposed as `POST /attention/:id/remote-ack` (Bearer-authed; 503 while dark). Ships behind `multiMachine.seamlessness.ws41DurableAck` (default false) per `docs/specs/MULTI-MACHINE-SEAMLESSNESS-SPEC.md`; a single-machine or flag-off agent is a strict no-op.

## What to Tell Your User

None while dark — internal multi-machine plumbing. The user-visible behaviour, once an operator turns it on across more than one machine: when you tap to acknowledge or resolve something in the attention queue and the machine that owns that item happens to be asleep, your acknowledgement is no longer lost — it is remembered and applied the moment that machine wakes, instead of the item popping back up unresolved. The safety promise holds even then: a remembered acknowledgement is re-checked against who you actually are when it is applied, so it can never resolve something on a stranger's behalf. On a single-machine setup nothing changes.

## Summary of New Capabilities

None user-facing while dark. One new internal module: `RemoteAckStore.ts`. One new dark route: `POST /attention/:id/remote-ack`. Migration parity: the `ws41DurableAck` config default and the Attention-Queue awareness bullet reach already-deployed agents on update (config add-missing + idempotent `migrateClaudeMd` splice), so existing agents receive the capability and its safety prose, not just new installs.

## Evidence

- `tests/unit/remote-ack-store.test.ts` — idempotent-on-(itemId,targetMachineId), principal-carried-as-data (never authorizes), best-effort-write-never-throws, append-then-compact collapses re-acks. 8/8 green.
- `tests/integration/attention-remote-ack.test.ts` — the POST /attention/:id/remote-ack route persists intent when on, 503s when off; receiver precedence guard applies a re-delivered intent only after re-authorizing the principal.
- `tests/e2e/attention-remote-ack-alive.test.ts` — the Phase-1 "feature is alive" E2E: enabled ⇒ route 200 + intent persisted; disabled ⇒ 503; Bearer required.
- Gate suite green: tsc 0, dark-gate 24/24, no-silent-fallbacks 5/5, feature-delivery-completeness 97/97.
