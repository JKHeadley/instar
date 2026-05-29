# Side-effects review — Non-interactive, code-authenticated pool join (trust model A)

## What changed & why

Bringing up a second real machine for the Multi-Machine Session Pool surfaced
that the awake machine never learned about a machine that joined headlessly: the
existing `pair`/`join` flow is **interactive by design** — `/api/pair` was
"signal-only" and real registration completed only via a human confirming
matching SAS visual symbols on both screens. An active-active session pool can't
require a human to eyeball symbols per machine, so (operator decision: "Proceed
with A") pairing becomes **code-authenticated and non-interactive**: the
time-limited, single-use pairing code (carried over the TLS tunnel) is the
shared secret that authorizes the join; Ed25519-signed mesh RPCs handle trust
thereafter.

Root cause of the gap: `instar pair` created the `PairingSession` into an
**unused** `_pairingSession` variable and discarded it, so the running server
had no code to validate against.

Changes:
- **`src/core/PairingSessionStore.ts`** (new): persists the validation-relevant
  fields of the active `PairingSession` to `.instar/machine/pairing-session.json`
  (0600), and loads it. The ephemeral X25519 private key is deliberately NOT
  persisted (it is a `KeyObject`, not JSON-serializable, and unused for code auth).
- **`src/commands/machine.ts`** (`pairMachine`): persists the session via
  `PairingSessionStore` (10-min window) instead of discarding it; (`joinMesh`):
  sends the joiner's own advertised URL in the pair body when it already has one.
- **`src/server/machineRoutes.ts`** (`/api/pair`): validates the submitted code
  against the persisted session (`validatePairingCode` — single-use,
  attempt-capped, TTL'd), and on success registers the joiner as **standby**,
  stores its public keys (`storeRemoteIdentity`, so MeshRpc can verify it),
  records its advertised URL, and burns the code. Rejections are audited.
- **`src/core/MachineIdentity.ts`**: adds a `baseDir` getter so the route can
  co-locate its `PairingSessionStore` with the registry.

## Security analysis

- **The code IS the auth.** It is a `WORD-WORD-NNNN` secret, single-use
  (`consumed`), attempt-capped (default 3 — failed attempts persist across
  requests so the cap actually throttles brute force), and TTL'd (10 min as set
  by `instar pair`). It travels over the Cloudflare TLS tunnel. Brute force over
  a large code space within 3 attempts is infeasible.
- **A joiner can only ever become `standby`.** The role is hard-coded in the
  handler; a join request can never claim the awake role or move the lease.
- **`/api/pair` remains unauthenticated** (it is the bootstrap, before the joiner
  is known) — but it is now *gated*: with no active session it rejects (403)
  rather than the old behavior of accepting any request. Malformed identities are
  rejected (400) before anything is persisted.
- **What we trade away vs. SAS:** the human visual-symbol MITM check. Mitigated
  by code-over-TLS + short TTL + single-use + attempt cap. This is the operator's
  explicit trust-model choice for automated pool formation.

## Blast radius

- **Dark-feature-adjacent.** This is the multi-machine pairing path; a
  single-machine agent never calls it. No behavior change unless an operator runs
  `instar pair` + `instar join`.
- **No new config / schema.** `/api/pair` is server code → existing agents get
  the new handler on update; no `PostUpdateMigrator` entry needed. The
  `pairing-session.json` file is created on demand by `instar pair`.
- **Backward-compatible join:** `joinMesh` still registers the awake machine from
  the response and records its URL (the #531 fix); the only response change is
  `status: 'paired'` instead of `'pending'`, which `joinMesh` does not branch on.

## Not closed here (scoped follow-up)

For a **quick-tunnel** standby, its reachable URL is only known after its server
starts (post-join), so it cannot be sent in the pair body. The awake machine
therefore still needs a way to learn a quick-tunnel standby's URL — either the
standby uses a named tunnel (deterministic URL, exchanged at pair time), or a
dedicated authenticated URL-announce path is added (the standby is now registered
with verifiable keys, so it can sign such a call). Raised explicitly; the
heartbeat path is awake→standby (lease arbitration), so it is not a clean carrier.

## Tests

- `tests/unit/pairing-session-store.test.ts` — `PairingSessionStore` roundtrip,
  null-on-absent, no-private-key-persisted, 0600 perms, overwrite, malformed-file
  tolerance.
- `tests/integration/pool-noninteractive-pairing.test.ts` — valid code registers
  joiner as standby + records URL + stores keys + consumes code; wrong code 403 +
  attempt increment; brute-force lockout; no-session 403; consumed 403; malformed
  identity 400.
- `tests/integration/machine-routes.test.ts` — updated the legacy signal-only
  assertion to the new session-gated contract.
