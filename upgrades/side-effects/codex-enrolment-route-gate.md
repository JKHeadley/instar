# Side-Effects Review — the enrolment route must not disagree with the identity layer

## Summary of the change

The enrol route carried its own gate — `provider !== 'anthropic' || framework !== 'claude-code'`
— which refused a Codex account BEFORE the identity oracle was consulted. It now asks the
identity layer what it covers (`isIdentityVerifiableSlot`), and the list of covered pairs
lives beside the oracle that implements it.

## How it was found

By attempting the actual enrolment against a live server after the identity fix deployed,
and getting `subscription-account-identity-provider-unsupported`. Not by reading the code.

The previous PR's integration test drove `SubscriptionAccountEmailRegistrar.register()` —
the pool's verified-add path — and proved a Codex slot enrols. That was one layer BELOW
the route. The route's own gate was untested, so every test passed while the operation the
tests existed to enable still failed. The lesson is specific: an integration test that
stops short of the real entry point can be green over a broken feature.

## Decision-point inventory

One: may this (provider, framework) pair be submitted for identity verification? It gates
enrolment only. It grants nothing — the oracle still decides, and an unidentifiable slot is
still refused.

## 1. Over-block

Previously: over-blocked every non-Anthropic pair, including one the identity layer could
answer for. That was the defect.

Now: over-blocks only pairs no oracle covers, which is the correct refusal — reaching the
oracle with an unanswerable pair yields a more confusing error, not a better outcome.

## 2. Under-block

The gate admits a pair; it does not admit an ACCOUNT. A Codex home that cannot identify
itself is still refused downstream by the registrar, with its own reason. A test pins that
every advertised pair is genuinely answerable, so the list cannot drift into admitting
something unverifiable — the failure direction that would trade a false refusal for a false
acceptance, which is strictly worse.

## 3. Level-of-abstraction fit

The capability list belongs beside the oracles, not at the callsite. Restating it at the
callsite is what went stale: adding an oracle and declaring what it covers are now the same
edit. Hardcoding a second pair at the route would have repeated the bug on the third oracle.

## 4. Signal vs authority

The route holds no identity opinion. It asks a capability question and defers the identity
decision to the oracle, which is where the evidence is.

## 5. Interactions

The credential-field guard above it is untouched and still runs first, so the registry
still cannot be handed a token. The `email-mismatch` and `email-unresolved` paths are
unchanged. No change to any account already enrolled.

## 6. Multi-machine posture

Machine-local BY DESIGN, matching the identity layer it fronts: the gate is about a
credential slot on THIS machine's disk. Nothing replicates.

## 7. Failure modes

The predicate is a pure array membership test over a frozen literal; it has no I/O and
cannot throw for a caller passing anything, including `undefined` (pinned by a control).

## 8. Rollback cost

Remove `openai`/`codex-cli` from the list — one line, no state, no migration. That restores
the previous refusal exactly.

## Evidence

9 tests. The load-bearing one is the regression: restoring the inline pair fails it, so it
catches precisely the defect that shipped. A CONTROL proves the gate still refuses an
uncovered pair (without it, a gate that admitted everything would pass). A consistency test
drives the real composite oracle for EVERY advertised pair and asserts each is genuinely
answerable, with an assertion that the Anthropic pair still routes to the Anthropic oracle
— so the list cannot advertise a pair with no oracle behind it.
