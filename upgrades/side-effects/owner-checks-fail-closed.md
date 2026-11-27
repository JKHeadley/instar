# Side-Effects Review — owner checks fail closed (ACT-115)

**Tier 2.** Spec: `docs/specs/recommended-services.md`, rollout step 1. The owner check decides who may answer authority-bearing Telegram buttons and prompt replies, so this gets a second-pass review.

## Summary

The tunnel-consent and prompt-gate checks read "if an owner is set and this isn't them, refuse", so no owner meant anyone could answer. Prompt-gate buttons and typed answers now need the configured owner or the one verified operator from `resolveApprovalOwner`. Tunnel consent needs the configured owner only, because its prompt is only ever sent to one. Pairing taps also refuse a tap with no chat id. In these checks, config ids are normalized the way pairing reads them, so a string id still matches. `handleMobileDecline` still compares the raw value, which refuses a string id; that already existed and fails safely. `getOwnerUserId` is unchanged, so owner DMs do not widen to the inferred operator.

## 1. Over-block

- A new agent with no verified message refuses taps until its first authenticated message binds the operator. That is intended. With no allowlist, the first person to speak in the group becomes that operator, which is no worse than before, when anyone could answer.
- The operator store is per machine. A machine that has not seen the operator refuses until they message it, for example after the Telegram poll slot moves to a new machine. On 2026-11-03 this agent's Studio had one verified person across 89 bindings, and Mama PC had none. The refusal does not invite anyone to claim ownership.
- An agent with two or more verified people and no configured owner refuses every tap until one is set. A message alone does not fix this. The agent sets `ownerUserId` only when the sender's id matches its existing record of the person it works for, on each machine, with a restart. With no such record it reports that it can't confirm the owner, and the buttons stay refused. No phone flow for choosing an owner exists yet; `owner-authentication.md` is the spec that owns one.
- The forward route in pairing has no chat id and stays exempt, because only taps pass `requireChat`.
- Prompt-gate now prefers `ownerUserId` over `promptGate.ownerId`, as `getOwnerUserId` documents. An agent with different values in each changes approver.

## 2. Under-block

- A typed reply from a non-owner is no longer taken as the prompt's answer, but the text is not stopped. In polling mode it falls through to normal routing and reaches the same session when the sender is authorized, and with no allowlist everyone is. In lifeline mode messages never reach this check at all. This is the wider question of who may give a session input, filed as feedback `fb-307e298e-f0d`, and it is not closed here.
- Before the lifeline guard arms, `tc:` and prompt-gate taps do not require a verified callback, unlike pairing, so a forged tap naming the owner's id passes. This already existed.
- The rule does not stop a hostile process on the same machine, which can edit config or the operator store. The approval ladder specs own that.

## 3. Level-of-abstraction fit

The check stays in the adapter, where each callback class is dispatched. The owner rule is reused from `resolveApprovalOwner` instead of being restated. The adapter takes a resolver because it doesn't hold the operator store.

## 4. Signal vs authority compliance

This is a deterministic invariant at a real authority boundary: exact identity comparison, no judgment and no brittle text matching. Per `docs/signal-vs-authority.md`, that belongs in code. The startup report is signal only and blocks nothing.

## 5. Interactions

- Pairing and prompt-gate now read the owner through the same function and agree.
- Route setup calls the setter with optional chaining, matching `setPairingHandler`, because test stand-ins lack it. If it were absent in production the result is refusal, not access. `tests/integration/callback-owner-wiring.test.ts` runs the real adapter through real route setup, and fails when the wiring is removed.
- `everVerifiedOperatorUids` is append-only, so a second person speaking once removes the inferred owner until one is configured. This is the existing pairing behaviour, and it now also applies to prompt-gate.

## 6. External surfaces

Non-owner taps get the existing refusal text. A tap with no known owner gets a new one saying the owner can't be confirmed on this machine. Tunnel consent keeps its existing text. No new routes or config keys. One new CLAUDE.md section, added by migration.

## 7. Multi-machine posture

This adds no new state. It reads the existing per-machine operator store and per-machine `config.json`, and their postures don't change. Replicated operator records live in a separate store that the resolver deliberately doesn't read (`src/threadline/PairingInviteTelegram.ts`). So machines can disagree until the operator has messaged each one, and a configured owner applies only on the machine where it's set. Callbacks go to the one machine polling Telegram (`shouldOwnTelegramPoll`), which does not follow the lease by default. An operator's message binds on that same poller, so it lands on the right machine.

## 8. Rollback cost

A revert restores the old check. No stored state changes. The CLAUDE.md section would stay and be slightly wrong until removed.

## Migration

The behaviour arrives with the update. `migrateClaudeMd` adds the section. At startup, an agent that has met someone but can't confirm a single owner reports it: several verified people, one with no current binding, an unreadable record, or an invalid configured owner. A new agent nobody has messaged stays quiet, and so does an agent with no operator store at all, until the first tap reports. This report goes to the agent's degradation record, not to the person.

## Second-pass review

The first review raised string and blank owner ids, typed replies, the multi-machine claim, gaps in the startup report, and no recovery path. The second raised that the refusal text and recovery instruction let any tapper claim ownership through the agent's judgement, plus two false claims in section 7. All are addressed above. Unproven taps before arming remain as they were.

Final round: Concur with the review. Minor items left: the refusal gives a real owner no next step, which is the deliberate safety trade-off, and `config.json` is confirmed per machine on this agent only, where setting it on each machine is at worst redundant.
