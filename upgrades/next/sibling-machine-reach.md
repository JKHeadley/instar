<!-- bump: patch -->
## What Changed

Sibling-machine reach (spec `docs/specs/sibling-machine-reach.md`, commitment CMT-2073, feedback fb-56855d0f-0d2).

On 2026-11-20, after the Mac Studio rebuild, four subscription accounts were missing on the Studio while the Mac Mini held browser profiles signed in to all four. The agent told its operator to open the dashboard, enter his PIN and do four sign-ins. The outbound message check's "agent reach" described only the sending machine, so a per-machine gap looked like a gap in the agent's access.

Now:

- Each machine keeps a memory-only `SiblingHoldingsCache` (`src/core/sibling-holdings.ts`) of what its other machines hold: signed-in subscription accounts (plain `/subscription-pool`, which now names the answering machine) and browser profiles asserted signed in (a new light `GET /playwright-profiles?view=accounts`: agent bearer only, before the dev gate, no vault read, no file written). It refreshes every 10 minutes off the send path, dials at most 12 peers a tick through the admitted ropes only, backs a dead peer off (60 s, then 10 → 20 → 40 → 60 min), keeps each surface's last successful read dated by this machine's clock, discards a read whose responder is a different machine, and reports anything not read within an hour as UNKNOWN (never "none"). Older peers are read for their pool only and never asked for a browser view.
- The outbound gate renders an `OTHER MACHINES` section — this machine's pool accounts plus each other machine's holdings, one account per line, each sibling browser profile tagged with an opaque reference — only when other machines exist, so a single-machine prompt is byte-identical. The section opens with B17 precedence (other machines' holdings never satisfy HELD-ACCESS) and a B21 per-machine sub-clause: a procedure handed to the operator for a sign-in, browser step or missing account on one machine is user-task substitution when another machine has a browser profile signed in to that exact identity (a pool login there is corroboration only; UNKNOWN, same-provider-different-identity, another person's account, a new account, a physical step and a one-tap PIN approval pass).
- In code, other machines' data can only nudge: any B17 or B21 from a prompt that rendered the section is re-reviewed once without it (`reviewWithinBudget`, bounded by the route timeout). A B17 stands only if the local-only review also says B17; a local-only B17 wins over a sibling B21; a re-review with no verdict takes the existing no-verdict path, never a confirmed B17.
- When B21 fires citing a sibling profile reference that validates against the reach that built that prompt, the 422 carries `otherMachine` (machine, admitted address when it still resolves, counts) and `otherMachinesHint` — a server-owned template appended to `suggestion` and `howToProceed`, which the reply scripts already print — and every account identity rendered in the prompt is redacted from the model-written `issue`/`suggestion`.
- `GET /subscription-pool?scope=pool` gains `siblingReach` (per machine: ages, failures; account and browser identities only for the agent's own bearer). The awareness entry *Access you already hold* now says: check every machine with that one lookup, and use a helper session on the machine that can.
- Feature evidence `toneGate.siblingReach`: `hint-attached`, `override-after-hint`, `complied-after-hint`, `b17-overturned`, `b17-unconfirmed`. The refresh loop is registered as the `sibling-holdings-refresh` self-action controller.

Switch: `toneGate.siblingReach.enabled`, read live on every send and tick. Unset = live on development agents, dark on the fleet; an explicit value always wins. Off, or a single machine, is byte-identical to before.

## What to Tell Your User

If your agent runs on more than one computer: before it asks you to sign in, do a browser step or add an account on one of them, it now checks whether another of its computers already has that account signed in — and if so, it does the step itself from there instead of asking you. Nothing to set up. (It reaches other agents only after it has proven itself on the development agent.)

## Summary of New Capabilities

- The outbound check sees what the agent's other machines hold and nudges the agent toward the machine that can do a per-machine step (B21 per-machine sub-clause; other machines' data never hard-blocks). Switch `toneGate.siblingReach.enabled` (development agents first).
- `GET /playwright-profiles?view=accounts` — light accounts view (agent bearer only; no vault, no write).
- `GET /subscription-pool` names the answering machine; `?scope=pool` gains `siblingReach`.
- The agent's instructions: check every machine with one lookup before asking about a per-machine resource.

## Evidence

- Unit `tests/unit/sibling-machine-reach.test.ts` (24): projection and login normalization, per-surface retention and ageing, identity mismatch, older peers, backoff and the never-read retry, roster UNKNOWN rows, the live switch, fetch bound, single-flight; reach refs and one-account-per-line rendering with the line budget; the complete prompt byte-identical without siblings; the section apart from AGENT REACH; `siblingProfileRef` parsing; the 2026-11-20 replay and its contrast cases. `tests/unit/self-action-convergence.test.ts` covers the registered refresh controller.
- Integration `tests/integration/sibling-machine-reach-routes.test.ts` (11) over a real HTTP stub peer and the real routes: hint on a cited B21 with no identity in the 422; a sibling-only B17 never walls; a local B17 still blocks; a local B17 beats a sibling B21; a no-verdict re-review never confirms B17; an unknown ref attaches nothing; peer down → UNKNOWN; switch off → nothing fetched; the light view answers the agent bearer with the dev gate off, reads no vault and creates no file; `machineId` on the plain pool; `siblingReach` in the pool view.
- E2E `tests/e2e/sibling-machine-reach-lifecycle.test.ts` (2) on the real `AgentServer`: armed at boot with the peer UNKNOWN (never-read); a nudged send kicks a targeted refresh, after which the next nudge names the Mini with its address.
