# Side effects: the same Mac can replace its own app key

Asked for by the Mac app session (echo-instar-desktop-app) after Justin's second "Testy" create on his laptop on 2026-11-17. The app had enrolled a new key, and the agent refused it forever ("Another app has already connected to this agent."), so the agent was orphaned. Parent principle: "The Person Decides; the Agent Does the Rest". The app lost its key, not the person their agent.

## Change
- `instar install --app-ticket --key <new> --replace-app-key` (`src/cli.ts`, `appTicketCommand`, and `appTicketPlan` in `src/core/localOwnerTicket.ts`). This writes a ticket that names the earlier devices.
  - It is allowed only when every earlier app connection belongs to this machine: the device's `localBinding.machineId` equals `<stateDir>/machine/identity.json`'s `machineId`, or, for an activation with no device record, the ledger row was signed by this machine.
  - It refuses for a device enrolled from another computer, an owner the app didn't create, an unknown identity, or a device bound before the machine had an identity.
  - Without the flag, the old refusal now adds the hint to use the flag.
- `POST /mobile/local-owner-device` step 7a (`src/server/mobileLocalOwnerDevice.ts`). With a replace ticket:
  - Every check that could refuse the new key runs before anything is revoked: the machine identity is known, every active owner is named and bound to this machine, and the key is not held or in the ledger.
  - It then revokes those owners: the ledger row first (a failed write is reported), then the registry (one retry), plus `confirm.drop`.
  - Then it enrolls the new key and answers 200 with `replaced: [ids]`.
  - The person gets an attention item once the new key is enrolled.

## Who can do it
Only the agent's own OS user on this Mac. The ticket is a 0600 file, and the route is loopback-only, refuses forwarding headers, and needs the device-key proof. Remote callers and phones get 404. Another machine of the same agent can replace only devices bound to itself. A session of the agent runs as that user and could do this too; that is the same trust boundary as before, and the attention item is the person's signal.

## Recovery
If the enrollment fails after the revoke, a retry with the same ticket, or a fresh plain ticket, enrolls the key: no active owner remains, so the first-owner path applies.

## For the Mac app
- Run `instar install --app-ticket --key <new> --replace-app-key`. Exit 0 prints "…It replaces this Mac's earlier app connection." A refusal prints one plain line.
- Then call POST /mobile/local-owner-device as today; 200 now carries `replaced`.
- New refusals:
  - 409 `machine-identity-missing`, and 409 `owner-device-exists` when the owner isn't this Mac's (both delete the ticket);
  - 409 `duplicate-key` (keeps the ticket).

## Rollback
Revert. Replaced devices stay revoked, as a normal revoke would leave them.

## Review (independent, two rounds)
Round 1 found:
- one high finding: owners were revoked before the duplicate-key check, which could leave no owner;
- medium findings: 7(b) running before the replace could burn the new key; registry revoke without a retry; no person notice or `confirm.drop`; the null machine-id message.

All are fixed, with tests. Round 2 concurred; its two small points (notify only after enrolling, and a comment on which refusals keep the ticket) are applied.
