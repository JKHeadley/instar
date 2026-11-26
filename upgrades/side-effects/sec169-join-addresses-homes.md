# Side effects: the public way-back list names only addresses where a computer is set up (SEC-169)

In plain words: the document page's public "other addresses" list (member-browser-any-computer §3.6) returned every pool machine's document address to any anonymous caller. Each machine keeps its own dashboard PIN guess budget, so the list multiplied a stranger's PIN guessing rate by the number of machines (compounding SEC-150). The list now names only the addresses where a computer of either kind is set up and still counts.

Tier 1 by size, security-sensitive: an independent second-pass review is attached below. Size: 2 source files (`src/core/TeamComputers.ts`, `src/server/documentJoinRoutes.ts`), 1 new unit test file, 1 updated integration test, 1 new end-to-end case, and a dated amendment to spec §3.6.

## What changes for running agents
- **`GET /docs/_join/addresses`** (public, documents-gated) filters the machine's address list (`computerAddresses()`, unchanged) to hosts in `computerHomeHosts(teamLog.state(), now)`. With no readable team log, or no computers, it returns `{ addresses: [] }`. The 16-entry cap, the `no-store` header and the response shape are unchanged.
- **`computerHomeHosts`** (new, pure) covers each joined computer for which `computerStandingIn` holds now: not unbound, its person on the team, before its end. It uses that computer's `host`. It also covers each phone-linked computer (`browser-bind`) that is not unbound, whose person is on the team, and whose `expiresAt` is in the future. Its host comes from `host` in the signed body (`bodyB64`). The linking machine checked that value equals the address it issued the computer's nonce on (`documentLinkRoutes.ts`, the `wrong-machine` check). The helper never uses `signed.host`, which is the address the phone used. Hosts are lowercased, and the port is kept. An unreadable body, or a host that is not a plain host name, is skipped.
- **The document page** (`dashboard/docs/doc-page.js`) is unchanged. It already removes the current origin and shows nothing when the list is empty.

## Who loses what
- **Team members:** nothing. A computer's key exists only in the browser storage of the address it was set up on, so the only address that is ever a way back is that computer's own. It is in the replicated team log, which every machine folds.
- **The owner's own phone-linked browsers** are local device records only (`browser-bind` refuses `owner`), so their addresses are not listed. On another address, the owner uses the same screen's link code with their phone, which the page already offers. A team member would otherwise have needed a new invite, and they are fully covered.
- **Addresses where a computer is set up stay visible** to an anonymous caller. Those are normally the lease holder's host, where invites are redeemed and links are posted, so they are already public. The finding's second fix, making the PIN guess budget pool-wide, is a separate SEC-150 follow-up. It is not in this change.

## Signal vs authority
The list is display only. It authorizes nothing, and a wrong entry only opens a page that also has no key. This change narrows what an anonymous caller is told. It grants nothing.

## Second-pass review
**Reviewer:** independent Claude Sonnet subagent (fresh context, read-only, given the finding, the diff and this note), 2026-11-22. Verdict: CONCUR. It confirmed the route now gives an anonymous caller no address when no computer is set up, and only computers' homes otherwise. A joined computer's bind `host` is the address the browser used at redeem (`arrival.reqHost`). `computer-adopt` changes only the home machine, not the host. A phone link's body `host` is the address its nonce was issued on (the `wrong-machine` check), while `signed.host` is the phone's. The host format matches `new URL(origin).host`, and parse errors, the body bound, unbound links, people and expiry fail closed. Its notes: the remaining exposure is the homes themselves, which are normally the already-public holder host, and the pool-wide budget stays the SEC-150 follow-up, as stated above. It also noted that a home not advertised as a `documentsOrigin` is dropped from the list, which is display only, as before. It asked for a check of other origin-reading routes. Those were checked: the only bearer-exempt routes are the document join and link routes, and `phoneSetupRoutes`, `mobilePairingRoutes`, `mobileSessionRoutes` and `teamRoutes` read only this machine's own `pairingOrigin()`, which the caller already knows. `browser-bind` refusing `owner` is in `validateMachineEvent` (`TeamAccessEvents.ts`).

## Rollback
Revert the commit. No stored data changes.

## Tests
- `tests/unit/sec169-join-addresses-homes.test.ts` (new, 5 cases), over the real team-log fold.
- `tests/integration/documents-join.test.ts`: the old assertion that every machine's address is listed is replaced by the SEC-169 case. It returns `[]` with no computer and only the joined computer's address after a real join. A phone-linked computer adds its own address, and nothing is listed once the person leaves.
- `tests/e2e/documents-join.test.ts` (real AgentServer): the route answers `[]` before any computer is set up, and only this machine's address after a real join.
- Run here: the new unit file, `team-computers`, `documents-page-model` and `html-site-ratchet` (4 files, 59 tests), all passing. Typecheck is clean. Integration and end-to-end coverage comes from Local Verify. This machine does not run them by hand.

## Class-Closure Declaration
- `unbounded-self-action`: closure n/a. A read-only filter on one public GET. Nothing is retried, scheduled or looped.
