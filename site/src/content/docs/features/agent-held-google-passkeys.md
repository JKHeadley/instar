---
title: Agent-Held Google Passkeys
description: One human sign-in per account per machine, then hands-off Claude/Codex sign-in repair through a passkey the agent holds itself — grants, revokes and signed cross-machine instructions, shipping dark increment by increment.
---

⚗️ **Experimental — dark on the fleet.** Every route below answers `503` unless `passkeys.enabled`
resolves on (a development agent), and even then nothing is minted or loaded until the enrollment
increment lands. Spec: `docs/specs/agent-held-google-passkey.md` (converged, operator-approved
2026-09-22).

## The problem it solves

Instar repairs an expired Claude or Codex sign-in by driving a real browser through Google. Today
that needs a password (or a session cookie that eventually dies) — which means a human is on the
hook every time a login lapses, on every machine. A **passkey the agent holds itself** replaces that:
the human signs in **once** per account per machine to let the agent create its own passkey, and
from then on the agent signs in hands-off — no password typed, no code relayed.

The passkey is a full Google credential, so the design is built around **grants**: nothing is ever
minted or used on a machine that does not hold an explicit, per-(account × machine) grant written on
that machine by the operator.

## What is built so far (the dark increments)

1. **Legacy keys stop spreading.** The prototype `google_passkey_*` vault entries no longer sync
   between machines; a peer that still receives one drops it and audits the drop; every read is logged
   (names only).
2. **A locked, per-machine store.** `PasskeyCredentialStore` keeps a passkey in its own encrypted
   file under `secrets/passkeys/`, which backups, working-set transfers and git all refuse.
3. **A browser that can hold a passkey safely.** The repair browser gains a passkey mode: Chrome over
   a private pipe, extensions and prerendering off, every tab and popup given a virtual authenticator
   *before* it navigates, and the credential pulled back the instant a page leaves
   `accounts.google.com` or loads another Google page in a frame.
4. **`google-passkey` as a login method.** Repair is admitted only when the account's passkey cell is
   verified `ready` (every other state refuses by name); unattended graduation is earned per method;
   the driver never falls back to a password; `POST /passkeys/revert-method` restores the previous
   method.
5. **Grants, issuers and the signed `passkey-cell` instruction** — this page's routes.
6. **The durable revoke outbox** — re-delivery with backoff, the 30-day breaker and escalation.
7. **The pool read path** — every pool-wide check reads its peers through one memo; see below.
8. **Per-cell health and the one digest** — the state each cell is in, decided from proof outcomes,
   and a single attention item that lists what needs a human; see below.
9. **Closed Google page classes.** The repair browser recognises the twelve Google pages the passkey
   work can meet by *structure* — exact origin, sign-in route, stable element ids, roles and exact
   control labels — before its older prose-based chain runs, so help text can never make a passkey
   prompt look like a code entry. See below.

## Cell health (what a proof outcome does to a cell)

Every granted account on a machine — a *cell* — carries a health state decided only by the outcomes
of its sign-in proofs, recorded through `POST /passkeys/health/outcome` and read back with
`GET /passkeys/health`. A cell starts `healthy` and due for a proof. A `failed` proof does not
degrade it by itself: one confirming proof runs an hour later, and only a confirmed failure makes
the cell `degraded`; three confirmed weekly failures open the breaker (`breaker-open`, automatic
proofs stop). Three `unknown` outcomes in a row make it `unverified`, retried on a 7 → 14 → 28-day
backoff; three more unknowns at the cap make it `unverified-stopped`. A `credential-rejected` outcome
makes it `rejected` (no immediate retry). A `security` outcome — the passkey signed in as a different
account — is terminal until the cell is re-enrolled. A `ready` proof heals `degraded`, `unverified`
and `rejected`; `breaker-open` and `unverified-stopped` heal only on an operator-triggered proof or a
re-enrollment. No `ready` for 21 days makes a cell `unverified` — but that clock pauses while the
pool read path is degraded for the account, so a dark peer never pushes cells toward unverified.
Three healthy↔degraded flips in 30 days set a `flapping` flag. Every transition is audited to a
states-only log; the email never appears in it.

`POST /passkeys/attest-google-removed` records the operator's word that a passkey was removed on
Google when the read-only list check cannot run; the cell shows it as *attested*, never as removed.

## The one digest (`passkey-health:digest`)

Everything that needs a human lands in ONE attention item under a fixed key, refreshed by
`POST /passkeys/health/digest/refresh` and by a five-minute server timer: cells that are degraded,
breaker-open, unverified, stopped, rejected, in a security state, quarantined, or awaiting Google-side
removal; revokes still awaiting a peer; unobserved peers. The serving-lease holder narrates the whole
pool (peers' published health rides in through the pool read path); a machine that does not hold the
lease narrates only itself. It buzzes at most once per 24 hours; a security event or a suspension
buzzes once per tick regardless; a change to the unobserved-peer list alone updates the item silently;
and when nothing is left to report the episode resolves. A pass that changes nothing sends nothing.

## The pool read path (what my machines know about each other)

Enrollment, proofs and pauses are bounded POOL-WIDE — one enrollment attempt per account per machine
per 30 minutes, three per account per day across every machine, proofs of the same account from
different machines at least six hours apart — so each machine has to know what its peers have done.
Every machine publishes its own non-secret passkey state at `GET /passkeys/pool-state` (canonical
emails, grant sequence numbers, custody state by name, attempt rows, pauses, grant echoes, outbox
rows, whether it is the secret-sync push authority; never a credential, an entry key or a signed
bundle), and a reader on each machine queries every peer once per tick — five seconds per peer, five
seconds overall, in parallel — and serves ONE memo to every check and to `GET /passkeys?scope=pool`
(marked with its age). `POST /passkeys/pool-state/tick` runs a pass on demand.

Peers are classified with the rope-health signal: `observed` (answered), `peer-offline` (silent and
its heartbeat has stopped — a closed laptop; its last-known rows still count, which only ever makes
the pool stricter), `excluded` (the operator excluded a long-unobserved peer with
`POST /passkeys/exclude-peer`; `include-peer` or the peer answering again clears it), or
`partitioned` (silent but not provably offline, or rope health absent) — and a partitioned peer
means enrollment and proofs refuse on that machine with `passkey-pool-state-unavailable` while repair
and revoke continue. A single machine has no peers and is never degraded. Last-known rows survive a
restart on disk. Peer rows can only restrict; they never grant anything and never load a key.

`GET /passkeys/admission?action=enroll&email=…` is the read-only answer to "would this run right
now, and if not, why?": the pool table (partitioned peer, suspension, kill switch, lease holder), the
rate limit with its retry time, the same-account gap and any active throttle or risk pause. It is
honest about what this build does not publish yet — the suspension record and the lease-holder state
land with the health-watcher increment and are reported as such rather than assumed healthy.

## Closed page classes (what the browser is allowed to recognise)

The sign-in pages on `accounts.google.com`: the account identifier, the passkey prompt (and its
"not recognised" and "throttled" states), the authenticator-code and backup-code entries, the
enrollment speedbump and its confirm dialog, and any CAPTCHA / risk-review page. The passkey
settings page on `myaccount.google.com`: the read-only list, the create control and its confirm,
the "already enrolled" dialog, and the Workspace policy refusal. Anything else is `unknown`, and an
unknown page is never acted on.

Two rules follow from the class: the **outcome** a proof or repair records (`credential-rejected`
only from the not-recognised page; `security` only when a different account is signed in; `ready`
only with an observed assertion, a single-credential authenticator and an identity match; everything
uncertain is `unknown`) and the **actions the supervisor may choose from**. A credential-creating
control — "Create a passkey", its confirm, a backup-code submission — enters that list only on its
exact page *and* only in an enrollment drive; a sign-in drive can decline the speedbump but never
mint. The supervisor can decline any action; it can never add one.

Each page predicate is tagged with where it came from (measured live in the prototype notes, or
documented Google routes not yet visited); the Rung-1 live step re-checks every documented row before
any unattended use. Until then a mismatch can only make a page `unknown`.

## Grants (per account × machine)

`GET /passkeys/grants` shows this machine's grants, the copies of grants it issued to peers, its
confirmed issuers and the revoke high-water mark.

- `POST /passkeys/grant` — with the dashboard PIN, grant one account on this machine (or, with
  `targetMachineId`, on a peer). Exactly one active grant per cell; each instance carries a monotonic
  sequence.
- `POST /passkeys/revoke` — revoke by sequence: a re-grant made after a revoke was signed survives
  it. The high-water mark lives outside the backup manifest, so **a restore can never bring a revoked
  grant back**. A revoke stops *this agent's* passkey path only — the browser profile's live session
  and any stored password remain, and the result says so.

Authority is **local**: a grant exists on a machine only because it was written there — by the PIN
route, by a verified instruction from a trusted machine, or by a restore under the high-water rule.

## Trusted issuers — no trust on first use

A machine accepts a signed passkey instruction only from a machine on its own **issuer set**:

- its own first local PIN check adds itself;
- a **peer** becomes an issuer only when the operator confirms it on *this* machine's own dashboard
  with a locally entered PIN (`POST /passkeys/issuer-add`, which requires a paired, active machine);
- after that, existing issuers can add or remove others with signed instructions
  (`POST /passkeys/issuer-remove` to drop one).

Membership is re-checked at every verification: a machine whose identity was **revoked** is refused
and dropped; one that is pending, missing or unreadable is refused but kept. On a multi-machine agent
the very first grant is refused (`issuer-bootstrap-required`) until at least one peer issuer is
confirmed — a deliberate one-time step per machine.

## The signed instruction (`passkey-cell`)

A cross-machine op is an Ed25519-signed body — principal, canonical email, target machine, op,
arguments, issue time, nonce, expiry — signed by the issuing machine's identity key under a domain tag
distinct from the account-follow-me mandate, so the two can never be confused. The receiver
(`POST /passkeys/cell-action`) verifies, in order: shape → issuer trusted → signature → addressed to
this machine → fresh (15 minutes ± 2 minutes of skew; a **revoke** is exempt so it can always be
delivered late) → never seen (a durable nonce ledger). The nonce is written *before* anything acts,
together with the exact revoke cutoff it will apply, so a redelivery or a crash-finish re-applies the
same thing and can never catch a grant made afterwards.

## Revokes never silently expire (the outbox)

A revoke for a cell on a **peer** is signed once and placed in a durable outbox
(`GET /passkeys/outbox`). The same bundle is re-delivered unchanged — first immediately, then after
1 hour, 6 hours, and daily — until the peer applies it; a peer observed coming online pulls the next
attempt forward (never below a 15-minute floor). Thirty days after issue without an acknowledgement
the entry escalates: one aggregated attention item per machine lists every affected account, automatic
re-delivery stops, and exactly one more attempt runs when that machine is next online. The peer's
applied acknowledgement, an operator dismissal on the peer, or a permanent refusal (a bundle the peer
can never accept — re-issue instead) closes the entry. `POST /passkeys/outbox/tick` runs a pass on
demand; the server does so every ten minutes.

## What is not here yet

Enrollment (the one human action), the cold proof, the health watcher and pool-wide suspension
(including the Google-side removal link the escalation points at), replicated grant rows and
lease-holder takeover of a lost issuer's outbox, the dashboard grid and the migration of the existing
prototype keys are later increments of the same run. Until enrollment lands, grants are inert and the
page classes are only ever exercised against the local fixture.
