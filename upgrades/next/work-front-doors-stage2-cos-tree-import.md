<!-- bump: patch -->
## What Changed

Chief of Staff project sub-conversations now appear under their project in Conversations (spec `docs/specs/work-front-doors.md` §3.1 and §7 stage 2).

- New graph authority use: the import tier. For each live Chief of Staff `tree` record whose parent is the front door of a project the owner accepted (the stage 2b Accept), and whose child has no placement yet, the graph writer records one import placement of the child under that project. It replaces nothing (the validator only accepts a first placement directly under an effort), so it never moves anything the owner placed or removed, and any owner change outranks it.
- An owner change is never refused because an import landed after the owner looked (an owner change saved offline, forwarded from another machine, or previewed first): an import head the owner did not see is replaced by the owner's change. The importer also leaves alone any conversation with an owner change still waiting to be saved.
- The import carries the tree record it came from; every machine verifies that the placement is exactly what that record yields (new receipt method `cos-tree-import`). Event ids are derived from the record, so a re-run writes nothing new.
- Switched on by `multiMachine.conversationGraph.cosTreeImport` (absent: on for development agents, off on the fleet), and only once every machine of the agent advertises a build that verifies import receipts (new heartbeat flag `conversationGraphImportAuthority`). Older builds refuse these receipts, so nothing imports while any machine still runs one.
- The Chief of Staff tree is still written exactly as before; stopping that double write is a later step (CMT-2074).

## What to Tell Your User

Once you accept a Chief of Staff project into Conversations, the conversations the Chief of Staff already had under it now show up under that project too, on every computer. Anything you placed or removed yourself stays where you put it, and you can move or remove the imported ones like any other. Nothing to do.

## Summary of New Capabilities

- Chief of Staff tree children are placed under their accepted project in Conversations automatically, marked as placed by import.

## Evidence

- Unit: `tests/unit/conversation-graph-cos-tree-import.test.ts` (validator, planner, real receive-side verifier, gate, tree fold, runner preconditions).
- Integration: `tests/integration/conversation-graph-cos-tree-import.test.ts` (real two-member runtime and witness: gate shut writes nothing; one import commits on both machines; idempotent re-run; owner placement and owner removal win; forged source refused).
- E2E: `tests/e2e/conversation-graph-cos-tree-import-alive.test.ts` (production AgentServer composition runs it; dark on a fleet agent).
- Side effects: `upgrades/side-effects/work-front-doors-stage2-cos-tree-import.md`.
