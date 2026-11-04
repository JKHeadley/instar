# Side-Effects Review — recommended services setup runner

**Tier 2.** Spec: `docs/specs/recommended-services.md`, The agent owns setup. It lets a confirmed yes start a session with owner reach, and adds a route that stores a secret. Only a throwaway or development agent that lists a recipe under `recommendedServices.provingRecipes` can reach it. A fleet agent ignores the list.

## Summary

- `src/recommended/recipes.ts`: the `jev-v1` recipe. Its brief hands a session the whole job, and its `verify` calls TypeSafe with the stored key.
- A yes opens the service's own Telegram topic and starts an interactive session there, so the person can answer and a credential can reach it. The session claims the topic, so another machine can't start a second copy.
- `POST /recommended-services/:id/verify` runs only the recipe's check. Only `pass` closes the commitment.
- `POST /recommended-services/:id/key` stores the one secret a recipe names, as a plain text body as the brief says, so a JSON slip can't put part of a key in a parse-error log. A session that sends JSON anyway still can. It refuses a key that was here before setup, and lets setup correct its own until it passes.
- A check at boot and every five minutes stops work after a no from any machine, and starts a session that died quickly up to three times in all, with growing waits, then raises one attention item.
- If `verify` already passes before setup, no session starts, the person is told if a Lifeline topic exists, and the state and route show `alreadyHeld`, so it can't be mistaken for proof. If `verify` can't tell, nothing starts and no attempt is used.

## 1. Over-block

- An agent with no Telegram can't run setup. It uses its starts and then only a degradation report records why, plus "Setup stopped" on the dashboard row once the notice is sent, which itself needs Telegram, so on such an agent the row won't show that either. Slack and app conversations aren't supported in this version.
- A key that was here before setup and is now wrong can't be replaced by setup (`already-held`). The session has to tell the person. Replacing a key that live features read isn't a setup session's call.

## 2. Under-block

- **The brief is prompt text.** Nothing structurally stops a session asking the person to do something, spending, or using the wrong account. Browser clicks aren't gated by External Operation Safety, and the brief says so. Acceptable while proving, not for the fleet.
- **A key passes through the session.** It reads the key from the provider's console and sends it to the route, so the value can land in a Bash command, a transcript and hook-event logs, and some of those are tracked in an agent's git. A Secret Drop or script that stores straight to the vault doesn't exist yet. This has to be solved before the fleet, and checked before a proof on this agent.
- **A no reaches a running session within five minutes,** not at once, when it came from another machine. A session can act in that gap, and verify's refusal can't undo an account already made.
- **A real key from another account passes verify.** Nothing ties it to the whose-account choice.
- **`/v1/models` isn't proven to accept a good key.** The reviewer saw 403 with no key, 401 with a fake key and one timeout. Existing callers use `/v1/systemone`. The first proof must confirm it. If a good key gets some other answer, setup reports `unknown` forever and never finishes.
- **Anything down for over an hour stays down, with no notice.** `dormant` is meant for a session idled out while waiting on the person, but it also covers a real crash after an hour, a machine down for an hour, and a stopped notice that kept failing for an hour. A reply goes through the ordinary topic respawn, which probably doesn't carry the brief, so that session may not know the job, and the stopped notice's promise to pick this up rests on the same path, with nothing clearing `exhausted`. I read that path and didn't run it. The live proof has to test this, and it is the likeliest thing to need changing.
- **A replicated no after a pass with no session doesn't clear `verified`.** The row can read "Working" above a standing no on a multi-machine agent.
- **The target machine may not hold the Telegram lease.** The grant names the machine that served the page. If that isn't the lease holder, the session can't reach the person. Must be settled before a multi-machine agent proves this.
- **The "no task for the person" test reads static text.** The spec's check on real setup messages still has nothing real to read.
- **A kill that keeps failing retries every five minutes with no ceiling.** Cheap, and only after a no.

## 3. Level-of-abstraction fit

The route file holds the lifecycle, and `routes.ts` holds the real session and topic calls, which a wiring test drives. Interactive sessions are the existing path for a conversation with a person. The timer is one interval in the server, because the existing beacon's user output is off by default and has no session-loss signal for this commitment, so it would have stayed silent. The commitment is a record, with no beacon.

## 4. Signal vs authority compliance

Starting setup needs an active grant, a deterministic check on a signed row. `verify` is the deterministic end-to-end check the spec names, and `unknown` never counts as a pass. Reference: `docs/signal-vs-authority.md`.

## 5. Interactions

- `recordVerify` won't let `unknown` overwrite `pass`, so an outage can't restart setup on a working service.
- The memory-audience refusal from `/sessions/spawn` applies here, because a setup session has the owner's reach.
- A no clears `verified`, so a later yes doesn't skip a dead session on an old pass. A fresh yes to changed text keeps the commitment already open.
- A yes and a tick can't both start a session, through an in-memory set. Across a restart, the session name and running check cover it.
- 430 test files build routes, and each leaves one unref'ed timer. Its check returns at once with no ledger.

## 6. External surfaces

- Nothing changes without `provingRecipes` on a throwaway or development agent. The routes answer `no-recipe` otherwise.
- With it: one Telegram topic per service, one session, real calls to the provider, and a real account if the session makes one.
- The dashboard row can now read "Working" or "Setup stopped".

## 6b. Operator-surface quality

No new page. The topic is named "Set up <service>". The stopped notice says setup has stopped, that the yes stands, and what picks it up again.

## 7. Multi-machine posture

Setup state stays on one machine, declared `machine-local` with reason `physical-credential-locality`: a login or install lives on one disk. Each further machine takes its own confirmation. See the lease gap in section 2.

## 8. Rollback cost

A revert removes the routes and the timer. A running session keeps going until it ends, and a stored key stays. Removing a recipe from `provingRecipes` while setup runs leaves the session running, because availability isn't what stops it. A no does.

## Must ship before any service is available to the fleet

The catalog test's comment lists them and fails on any real recipe: live proof, a route to stop a running service, the address route for an owner with no address, and the confirm page in the CLAUDE.md section. Also the key path and the lease gap above.

## Second-pass review

**Required: it starts sessions and stores a secret.** The independent reviewer read this work three times.

- **First read,** four blocking findings: no way to reach the person, a no during spawn leaving a session running, no way to store a key, and a key already held passing as success and being overwritable. All fixed.
- **Second read,** one finding blocking merge: my declaration used a value the gate doesn't accept, and a self-triggered loop needs a registered guard. Fixed. Five that would stop a real proof: the notice being withheld, an outage starting a session, idle kills using up starts, no topic ownership claim, and a mistyped key being uncorrectable. All fixed except the reply-after-death part of the idle finding, which is open above. It also corrected several claims in this document, which I've rewritten.

- **Third read,** limited to the dark path, meaning an agent without `provingRecipes`: "Concur with the review". It found nothing that changes such an agent, and corrected four sentences here. The second round's behaviour on a real proof hasn't been reviewed. I stopped there on purpose, because what's left depends on how a real session behaves, so the live proof on a throwaway agent is the better next check. The reviewer did not run the full suite. The verifier does.

## After review

Local verification failed `no-silent-fallbacks`, because four new catches only swallowed or logged. All four now report through `DegradationReporter`. The reviewer has not read this change, which only affects failure reporting.

## Class-Closure Declaration (display-only mirror)

- defectClass: unbounded-self-action
- closure: guard
- guard: tests/unit/self-action-convergence.test.ts (registered as `recommended-service-setup-restart`)
- reason: A check on a timer starts sessions. Starts are capped at three with growing waits, then one notice and a durable stop, and a fresh yes needs the operator's PIN.
