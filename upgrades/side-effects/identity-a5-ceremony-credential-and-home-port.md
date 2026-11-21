# Side-Effects Review — the app's one-time ceremony credential (A5) and the home port (A4)

**Version / slug:** `identity-a5-ceremony-credential-and-home-port`
**Date:** `2026-11-19`
**Author:** `Echo (builder #40)`
**Second-pass reviewer:** `independent Opus reviewer (security + integration), recorded below`

## Summary of the change

Tier 2 (identity, a credential, an auth path). About 330 added lines of source in 2 new files and 5 changed ones, 3 new
test files and one extended. Effort: one review round, commits listed in the PR body. Two changes on branch
`echo/a4-lan-first-phone`, both found by the Windows app's live proof (builder #39):

1. **The home port.** The default same-network port was main + 1000 = 5040, which Windows' Connected Devices Platform
   service holds on every Windows 10/11 PC, so the Windows pass-through could not listen. The default is now main + 20000
   (24040), and `POST /mobile/phone-setup` takes an exact `port` (the app checks it is free on Windows first);
   `GET /mobile/same-network` reports `preferredPort`. An asked-for port is never swapped and never moves while a phone is
   paired on the home address (`port-fixed`).
2. **A5's ceremony credential.** App-made agents have a random PIN nobody is told, so the owner could not pass the PIN
   check. `instar mobile ceremony-credential`, run as the agent's own user inside its own system, writes the SHA-256 of a
   32-byte secret into a 0600 key-material file and prints the secret once; `POST /mobile/phone-setup` accepts it in place
   of the PIN, once, within 10 minutes, only from this computer (exact loopback Host, no forwarding header, main listener),
   only where the installer-enrolled app record exists on this machine, only with no owner phone, no Telegram owner, on the
   lease holder. Any refusal is final (no PIN fallback).

## Decision-point inventory

- `POST /mobile/phone-setup` fresh check — modify — a second way through it (the credential), checked as an enumerated floor; it only adds refusals relative to "token from this computer".
- `SameNetworkListener.openForOwner` — modify — an asked-for port, `port-fixed` when a phone holds the old one.
- `KEY_MATERIAL_PATHS` / `KEY_MATERIAL_FILES` — modify — one more never-served, never-written, never-backed-up file.

---

## 1. Over-block

- An app-made agent whose mesh machine id and identity-file machine id disagree refuses the credential (`wrong-machine`); the app says so, and the terminal PIN path still works. Intended fail-closed.
- An enrolled app record with no machine id (agents enrolled before machine ids existed) is refused rather than guessed (A5 says "where none can be told apart, there is no exception"). The PIN path remains.
- Telegram-owner agents cannot use the credential (A5's surface is "take the number"; with Telegram the chat confirms). They use the PIN.
- A credential is spent even when a later step fails (network unknown, port taken); the app makes another. Cheap.
- A paired home phone pins the port: an app that finds that port taken on Windows gets `port-fixed` and cannot move it; the owner removes the phone first. Intended: moving it would strand the phone.

## 2. Under-block

- Anyone who can run a command as the agent's user can mint a credential (on Windows: any program in the owner's Windows login, through WSL). The same party can read the PIN and the token today (A4 limit 1, A5 "no weaker"). Not closed here; closing it is the Locked box level's job.
- The credential does not bind to the app's device key: the minting command cannot know which program runs it, so a key binding would prove nothing more. Recorded as a choice for the identity session.
- The home port can still collide with a program the default does not know about; the first-open fallback (OS-chosen port) and the app's own check cover it.

## 3. Level-of-abstraction fit

The credential is checked in the one route it opens, after the existing `fromThisComputer` gate, and minted by a file
write that only the agent's user can do, modelled on the Mac app's one-time ticket (`localOwnerTicket.ts`). No new route,
no new listener surface, no new middleware. The port rule lives in the listener that owns the port.

## 4. Signal vs authority compliance

- [x] No judgment-based block/allow: every check is an exact match (secret hash, Host string, machine id, record fields, a count, a time), an enumerable access-control floor like the PIN check it sits beside. Required reference: `docs/signal-vs-authority.md`.

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. The port default is a constant with a stated reason; the
caller can override it.

## 5. Interactions

- `localOnly` (`fromThisComputer`) runs first, so forwarded and tunnel traffic never reaches the credential check.
- The same-network listener's gate refuses `/mobile/phone-setup` (404) and any `Authorization` header, so the credential is unusable there (tested).
- The PIN lockout store is untouched by the credential path (wrong credentials cost credential tries, not PIN tries, so it is no PIN oracle and does not lock the PIN path).
- `keyMaterialPaths` feeds the file routes, backups, gitignore and git-sync classifier: the new entry is refused/excluded in all four (the never-served walk test and the backup tests are in the neighbour run).
- Moving the port stops the old listener before the new bind (reconcile now rebinds when the bound port differs from the stored one); the 15-second reconcile tick cannot bind the old port mid-move because the stored port is set before any await.

## 6. External surfaces

- New CLI command `instar mobile ceremony-credential` (for the apps, not people) and `--port` on `instar mobile add-phone`.
- `POST /mobile/phone-setup` gains `ceremonyCredential` and `port`; new errors `bad-port` (422), `port-fixed` (409, with `port`), `ceremony-credential-refused` (403), `no-app-on-this-computer` (403), `ceremony-credential-not-for-chat-owner` (409).
- `GET /mobile/same-network` gains `preferredPort`.
- The Windows app (piece 3c) must switch from typing the PIN to minting a credential, and pass the port it checked. Contract in the PR body.
- **Operator surface (Mobile-Complete):** no new operator action. The owner's action is still "Add your phone" in the app on the agent's computer; this removes a PIN the owner never had.

## 6b. Operator-surface quality

No operator surface — not applicable (no dashboard, approval page or form changed).

## 7. Multi-machine posture

Machine-local by design: the credential is bound to the machine id it was made under and to the lease holder, because the
first phone is set up at the computer serving the agent (A4/3a), and the enrolled app record it requires is bound to that
machine. It is never replicated (key material, excluded from git-sync and backups). The home port is per machine, like the
listener. No notices, no URLs that cross machines. Status surface: `GET /mobile/same-network` is this machine's listener
only, as before; `preferredPort` is this machine's.

## 8. Rollback cost

Pure code revert. The credential file is at most 10 minutes old and harmless if left (nothing reads it after a revert;
it is gitignored key material). A listener that already stored port 24xxx keeps it after a revert (the stored port wins);
a revert does not move any paired phone.

## Conclusion

Two narrow changes that unblock the Windows app's first live run without weakening A4: the credential is never usable from
the network, fails closed on every condition, and gives no party anything it could not already read. The choices A5 leaves
open are recorded in the spec (§4.6) for the identity session.

## Second-pass review

**Reviewer:** independent Opus reviewer (security + integration), reading the code, A5/A4 text and the spec.
**Independent read: concur (no blocker)**, with two MAJOR and nine MINOR findings, handled as follows:

- MAJOR 1, a port move joining a running reconcile could report and keep the earlier port: fixed (settle once more
  after the joined reconcile; white-box test that fails without the fix).
- MAJOR 2, a Telegram owner of an app-made agent has no way through (credential refused, PIN unknown): kept restrictive
  and raised to the identity session as an explicit decision in the spec (§4.6 choice a) and the PR body.
- MINOR 3, refusals known in advance came after the spend: moved before it (paused, no outside address, no listener,
  fixed port); tested unspent.
- MINOR 4, a wrong try could write an old credential over a newer one: the try is written only if the stored hash is
  still the one checked.
- MINOR 5, the stored lapse time was trusted: capped at the credential's own life, plus a one-minute clock allowance; tested.
- MINOR 6, several enrolled-app records were accepted: exactly one is required now (A5's rule); tested.
- MINOR 7, two machine-id sources: the enrolled-app check uses the enrolment's source, the credential check the
  command's source (the identity file). In production both are the same file (MachineIdentity).
- MINOR 8, an asked-for port equal to the main port: refused (`bad-port`); tested.
- MINOR 9, a paused home phone: no paused device status exists (pending, active, declined, expired, revoked); the
  active-or-pending rule covers every live record. No change.
- MINOR 10, native Windows always refuses: intended; stated in the code and spec so nobody loosens it.
- MINOR 11, missing tests: added for 1, 3, 5, 6, 8; 4's interleaving cannot be produced from outside a synchronous call.

## Evidence pointers

- `tests/unit/ceremony-credential.test.ts`, `tests/unit/same-network-port.test.ts`, `tests/integration/phone-setup-ceremony-credential.test.ts`, `tests/e2e/same-network-first-phone-alive.test.ts`.
- Mutation check: disabling each of the Host, enrolled-app, Telegram and spend checks made the integration test fail.
- Port evidence: listeners and reserved ranges read on the Windows 10 test PC and the Windows 11 Mama PC on 2026-11-19 (5040 held by svchost on both; nothing in 24040-24099; Hyper-V's reserved ranges all at 49749 and above).

## Class-Closure Declaration

- **Class:** `unbounded-self-action` — **closure:** `guard` (enforcement: test).
- **Component:** `src/server/sameNetworkListener.ts` (the 15-second reconcile, unchanged in shape).
- **Citation:** `tests/unit/same-network-port.test.ts`.
- **How it converges:** one reconcile per 15 s fixed interval, serialized; a port move or a failed move ends in one of two states (listening on the stored port, or closed) with no retries, spawns or notices.
