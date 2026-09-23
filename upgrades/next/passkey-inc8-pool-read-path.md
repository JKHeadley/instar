# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

Eighth increment of the approved agent-held Google passkeys spec
(`docs/specs/agent-held-google-passkey.md` §5.1, §3.7, §4). Every pool-wide safety check the passkey
work needs — one enrollment attempt per account per machine per 30 minutes, three per account per
day across all machines, proofs of the same account from different machines six hours apart,
throttle and risk pauses — now reads its peers through one path: each machine publishes its own
non-secret passkey state at `GET /passkeys/pool-state`, a reader on each machine queries every peer
once every five minutes (five seconds per peer, five seconds overall), classifies each peer with the
rope-health signal (`observed`, `peer-offline` with its last-known rows still counting, `excluded`,
or `partitioned`, which blocks enrollment and proofs), keeps last-known rows on disk across restarts,
and serves one memo to `GET /passkeys?scope=pool` and to the new read-only
`GET /passkeys/admission`. The operator can exclude a long-silent peer from a machine's pool checks
with the dashboard PIN (`exclude-peer` / `include-peer`, also as signed instructions to other
machines); an exclusion clears itself when the peer answers again. Peer rows can only ever make a
machine stricter.

Still dark: nothing enrolls, proves or uses a passkey yet.

## What to Tell Your User

Nothing changes for you in this update. It's groundwork: your agent's machines can now see what each
other has done with passkeys, so the limits that keep Google from seeing too many sign-in attempts
are enforced across all of them together, not per machine.

## Summary of New Capabilities

- `GET /passkeys` (per-cell view; `?scope=pool` merges peers with their condition and the memo age),
  `GET /passkeys/pool-state` (what a peer reads), `POST /passkeys/pool-state/tick`.
- `GET /passkeys/admission?action=…&email=…` — would this run now, and if not, exactly why.
- `POST /passkeys/exclude-peer` / `include-peer` (dashboard PIN; also `passkey-cell` ops).

## Evidence

- `tests/unit/passkey-pool-state.test.ts` (ledger, exclusions, clamping, classification, rate limit,
  gap, admission table, reader budgets / last-known / auto-clear); `tests/integration/passkeys-pool-read-path-routes.test.ts`
  (two- and three-machine pools in one process, partitioned vs offline vs excluded, caller refusal,
  mandate op); `tests/e2e/passkeys-pool-read-path-lifecycle.test.ts` (feature alive over HTTP; dark on the fleet).
