# A local-floor install never posts success from the Actions floor — plain-English overview

## What this change actually is

Instar's server runs the full test suite on each pull request and then writes a
mark on GitHub called `instar/local-verify`. That mark is the only thing the
repository requires before a pull request may merge, and it is meant to mean
exactly one thing: "this server ran the whole suite on this exact version and it
passed."

There has always been a second way that mark could be written. If the server
decided the "local floor" was not in force, it copied GitHub's own Actions
results into the mark instead (the "mirror"). That copy is right for an install
that has chosen the Actions floor. It was wrong for this one, because on this
repository the mark is the merge authority, and the Actions results are not the
full suite.

On 2026-10-25 at 04:08:46 UTC one of the three GitHub settings reads the server
makes every minute (the one asking whether the agent can bypass the ruleset)
failed once. The server read that as "settings unreadable", dropped the local
floor, and the mirror wrote `success · actions-floor green` on eleven pull
requests — five of which had never passed the local suite at that version.
GitHub's auto-merge, which was waiting on exactly that mark, merged all five
within a minute. Ninety seconds later the read succeeded again and the floor came
back; by then the merges were done.

## What already exists

- The floor gate (`src/localVerify/floorGate.ts`) that reads the three GitHub
  settings and decides whether the local floor is "effective".
- The status projection (`src/localVerify/statusProjection.ts`) that turns the
  server's knowledge into a GitHub status.
- The reconcile loop (`src/localVerify/StatusReconciler.ts`) that runs every
  minute and posts whatever the projection says.
- The audit file `.instar/logs/local-verify.jsonl`, which is how the cause was
  found: it recorded the settings state flipping and every post that followed.

## What is new

The configured floor now decides who may say "success". When the configuration
says `local`, an eligible pull request is on the local floor whether or not the
settings read came back. If the local verifier cannot vouch right now — the read
failed, the verifier is switched off, or one of the operator's GitHub edits is
still outstanding — the mark is `pending` with the reason written in it, for
example `local-floor held · settings-unreadable`. It never copies Actions
results. The Actions mirror is still used for the two cases where it was always
correct: installs whose configured floor is `actions`, and pull requests that
were never eligible for the local floor (another author, a fork).

Each time such a hold starts, the server writes one audit row, raises one
attention item, and records one degradation report; a repeat of the same hold is
not repeated. The hold reason is also visible on `GET /local-verify/status`
(`floor.hold`).

## Safeguards, in plain terms

- The change can only make the mark **more** cautious. Nothing that previously
  projected `pending` or `failure` can become `success`.
- Genuine local records behave exactly as before once the hold lifts; the
  incident's own recovery path (`settings-unreadable` → `effective`) is replayed
  in a test.
- Installs that configured the Actions floor see no change at all; a test pins
  that.
- A revert restores the previous behaviour completely; there is no stored state.

## What you need to decide

Nothing. This is a fix to a safety rule that was already written down ("the
status means the server ran the full suite on this head") and was not being
enforced in one transient state. If your install deliberately wants Actions
results to stand in for the local suite, set the configured floor to `actions`;
that path is unchanged.
