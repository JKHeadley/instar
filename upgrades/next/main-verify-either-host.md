<!-- bump: patch -->
## What Changed

With a peer verifier configured, the coordinator handed the peer PR verifies only. A verify of the main branch always ran in the coordinator's own slot, even while the peer was free (2026-11-17 on the Echo test machines: main waited 82 minutes on average and used 426 coordinator-minutes in a day). Spec: `docs/specs/local-verify-main-on-peer.md`, which amends `local-verify-capacity` Part D.

- New setting `monitoring.localVerify.mainOnPeers` (boolean, default `false`, read live on the coordinator). Off or absent, nothing changes.
- On: a queued `main` verify is handed to a free peer, only while main is healthy, under the same fair-share rule as the local slot (a PR the peer could take goes first until main's oldest unverified merge is 90 minutes old).
- The coordinator alone judges main. A red result from a peer makes main suspect; the confirming re-run and every run while suspect or red are the coordinator's own, so a peer can never turn main red.
- One `main` verify at a time across both hosts. A newer head queues behind a peer-run `main` verify and never cancels it.
- `POST /local-verify/peer-run` accepts an optional `kind: "main"` (then `pr` is 0, head equals base, base ref is `main`, no isolation input). The peer starts it only if its own read says main contains that head (main's head, one of the two commits under it, or an ancestor in its clone).
- A peer that cannot confirm the head refuses. That does not count toward its health breaker; three in a row pause `main` offers to that peer for 30 minutes (`peer-main-paused`) and raise `local-verify:peer-main-unconfirmed:<machine>`.
- A `main` record may carry the peer `attempt` it answers. The coordinator imports it into main health only (never the PR index, the journal or the merge line), and counts its coverage from its own dispatch time.
- `GET /local-verify/peer-result` returns an optional bounded `run` (`reasons`, `failures`) with a red `main` record, so the main-red hold still knows the failing files.
- A peer that gives no usable answer for 5 minutes (two polls in a row) loses the `main` reservation; the coordinator runs it.
- A `main` entry is saved in `queue.json` only while reserved for a peer, so a coordinator restart resumes the same attempt.
- Both machines must be updated together: the verifier version changes, and machines on different verifier versions hand each other no work.

## What to Tell Your User

Nothing changes unless you turn the new setting on. If your agent tests its own changes on two machines, it can now let the helper machine run the periodic test of the main branch too, so changes waiting to be tested are held up less. The coordinator machine still makes the call on whether the main branch is healthy.

## Summary of New Capabilities

- `monitoring.localVerify.mainOnPeers` (default off). No new routes; the peer-run request and peer-result answer each gain one optional field.

## Evidence

- Unit: `tests/unit/localVerify/peerVerifier.test.ts`, block "a main verify on whichever host is free" (27 cases, listed in the spec's Tests section); `tests/unit/localVerify/record.test.ts` (main record with an attempt). The four Local Verify unit files: 362 passing. `tsc --noEmit` clean.
- Integration: `tests/integration/local-verify-peer-routes.test.ts`, "a main verify travels the same routes".
- E2E: `tests/e2e/local-verify-lifecycle.test.ts`, peer-only production wiring: the switch reads off by default and on when set; the three reads the head check needs are wired.
- Baseline to compare after a day with the switch on: coordinator `local-verify.jsonl` 2026-11-17, main wait 82 min, Studio main-verify 426 min/day (throughput brainstorm decision 2026-11-17, experiment E3).
