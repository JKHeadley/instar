<!-- bump: patch -->
## What Changed

A team member without the Instar app can read and comment on documents from a computer (spec `docs/specs/member-browser-any-computer.md`, topic 146128; the project the documents spec's Decision 14 names).

- The owner's team invite link (or the existing invite for another device) now carries `j=1` when documents and the browser switch are on, and the instar.sh pair page then offers "Use this computer instead". The member's browser makes a non-extractable key on the agent's join page (`GET /docs/_join`), redeems the invite (`POST /docs/_join/redeem`), and confirms with the code shown only on the owner's phone in People (`POST /docs/_join/confirm`, signed by that key under a new `instar-join-v1` domain).
- The joined computer is documents-scoped (a guest's reads only), exactly the reach of a computer a member's phone links. Its binding is a new team-log machine event `computer-bind`; new `computer-renew`, `computer-adopt` and `computer-limits` events carry renewal on use (about weekly, written by the computer's home machine), takeover by a machine serving the same address after a rebuild, and the replicated allowance and lifetimes (defaults 3 computers, 4 an hour, 30 days idle, 90 days at most). Expiry writes no revocation; only Forget, the owner's removal through the agent, or the person's removal do.
- No machine writes any of these rows until every machine in the pool advertises that it reads them (`seamlessnessFlags.teamLogComputerRows`); until then the join answers `409 peers-updating` naming the machine.
- The owner gets an attention item (pushed to their phones) when someone is waiting for a code, with the computer's check letters.
- Team devices' codes (phones and computers) are no longer listed to, or declinable from, a dashboard PIN session (`GET /mobile/pairing-approvals`), on every agent: the agent itself can read the PIN, so a PIN session must not see a member's anchoring code. The owner's People screen is unchanged.
- New agent routes (bearer): `GET /team/computers`, `POST /team/computer-limits` (agent-wide or per person), `POST /team/people/:personKey/computers/:deviceId/forget`. The document page gains "Forget this computer" (`POST /docs/_link/forget-self`), the end-date line, and links to the agent's other addresses when this browser has no key there (`GET /docs/_join/addresses`).
- The documents spec's Decision 14 and §8 are amended: documents go to the fleet only after this ships and the owner has accepted browser keys in place of passkeys (one Approve/Decline, asked when the fleet turn-on is proposed).

## What to Tell Your User

People on your team who don't have the Instar app can now read and comment on documents from a computer. When you send them an invite, they open it on their computer and choose "Use this computer instead"; you'll get a notification, and you read them the code that appears in People on your phone. Their computer only reaches documents, stays signed in while they use it (up to 90 days), and you can ask me to remove it any time. This is only on for development agents for now.

## Summary of New Capabilities

- Members join a computer from the owner's team invite, no app needed (`/docs/_join`, `/docs/_join/redeem`, `/docs/_join/confirm`; dev-gated with documents and the browser switch).
- The agent lists, limits and removes members' computers: `GET /team/computers`, `POST /team/computer-limits`, `POST /team/people/:personKey/computers/:deviceId/forget`.
- Team pairing codes are no longer shown to a dashboard PIN session.

## Evidence

- Unit: `tests/unit/team-computers.test.ts` (row validation with fixed bounds, first bind wins across phones and both kinds of computer in both orders, unbind needs the device id, home and adoption with a new machine id, renew only from the home before the end it extends and never past `endsBy`, `origin-gone` cut, renew cadence for idleDays 1 and 30, limits by signed time across machines with different seq counts and per-person rows, allowance counts, `deviceStoodAt` for a joined computer); `tests/unit/mobile-device-keys.test.ts` (waiting, active, adopted records); `tests/unit/documents-page-model.test.ts` (join fragment, signed strings match the server, refusal words, end line); `tests/unit/html-site-ratchet.test.ts`.
- Integration: `tests/integration/documents-join.test.ts` (real pairing service and real fold: j=1 link, redeem, held code survives the lease tick, wrong key/host/clock/code, confirm and idempotent retry, guest scope, owner link spent, person removed before confirm, the pool write gate taking nothing, the allowance before the take, the agent routes, Forget and removal, crash reconcile); `tests/integration/mobile-dashboard-pairing.test.ts` (team codes absent from the PIN listing and decline); existing pairing, documents and team suites green.
- E2E: `tests/e2e/documents-join.test.ts` on a real AgentServer: owner invite with j=1, redeem, the owner's People read of the server-built name and code, confirm, a real docpage open and comment, the comment verifying as a peer would, other device routes refused, Forget ends it while the old comment still verifies, a guest reads only, documents off answers 503 with no j=1.
