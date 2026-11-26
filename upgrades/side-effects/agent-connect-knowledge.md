# Side-Effects Review — "Connecting to another agent" (agent knowledge for pairing by invite)

**Version / slug:** `agent-connect-knowledge`
**Date:** `2026-10-20`
**Author:** `Dawn`
**Second-pass reviewer:** `not required` (no block/allow, session-lifecycle, trust-level or gate code changes; Echo reviews the PR)

## Summary of the change

A new agent ("PP") was asked by its person to talk to Echo. Instead of offering a pairing invite, it asked the person for Echo's "Threadline fingerprint", offered to "package a bundle", and said networking was off and needed a restart (Justin, topic 61599, 2026-10-20). The invite flow (docs/specs/a2a-pairing-invite-link.md) already exists, but the agent's knowledge described it only under "before I share a secret", the Threadline tools list in CLAUDE.md left out `threadline_pair`, and "connect" was mapped only to "turn the relay on". This change adds one section, "Connecting to another agent", that tells an agent exactly what to do when its person says "connect / talk / pair with X": check it can pair, switch the network and pairing on for itself if they are off, make the invite (`threadline_pair action:"invite"`), hand it to the person with one sentence on where to send it, explain the other person's Approve and its own person's Finish, check status, then say hello. It also says what never to do (ask for a fingerprint, address or settings; offer a bundle; send the invite over Threadline). Files: `src/scaffold/templates.ts` (shared section + its place in the Threadline section + `threadline_pair` in the tools list + a "Connect with Echo" line in How to Use), `src/core/PostUpdateMigrator.ts` (delivers the same section and both bullets to existing agents, each content-checked on its own text), `src/knowledge/TreeGenerator.ts` (managed tree node `capabilities.agent_connect` reading that section), `src/knowledge/TreeTriage.ts` (keywords), `tests/unit/agent-connect-knowledge.test.ts`.

## Decision-point inventory

- No runtime decision point is added, modified or removed. The change is text that agents read, a migration that writes that text into CLAUDE.md, and a self-knowledge tree node. No route, gate, default or config value changes.

---

## 1. Over-block

No block/allow surface — over-block not applicable.

---

## 2. Under-block

No block/allow surface — under-block not applicable. The knowledge cannot stop an agent from improvising; it makes the right path the obvious one. The structural guarantees that matter (an invite is only usable once, approval needs the operator, invite text is intercepted before a session sees it) are unchanged and live in the pairing code.

---

## 3. Level-of-abstraction fit

Right layer. The gap was knowledge, not mechanism: the routes, the MCP tool, the Telegram Approve/Finish prompts and the dashboard fallback all exist. The section is a single shared function (`agentConnectSection(port)`) used by both the scaffold and the migrator, so new and existing agents get byte-identical text. The tree node reads the section out of CLAUDE.md rather than duplicating it, so there is one copy to keep correct.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

It is agent-facing guidance. It holds no authority over any message, session or pairing.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The triage keywords route a self-knowledge query to a node; a wrong route costs one irrelevant fragment, and triage is LLM-first with keywords as fallback.

---

## 5. Interactions

- **Shadowing:** The existing "Verified Pairing" section (credential rule) stays. The new section does not contradict it; it covers the conversational case ("connect with X") that section never mentioned, and both name the same tool and routes.
- **Double-fire:** The migration is content-sniffed on the heading, so it runs once. A freshly scaffolded agent already has the heading and is skipped (tested). The tree node is `managed`, so `migrateSelfKnowledgeTree` adds it on update and replaces it on later regenerations without duplicating; an agent-authored unmanaged node with the same id would win, as for every managed node.
- **Races:** None. The migration edits CLAUDE.md inside the existing `migrateClaudeMd` pass, like every other section.
- **Feedback loops:** None.
- **The one step that changes config:** step 1 tells an agent whose pairing route answers 503 to set `threadline.relayEnabled` and `threadline.verifiedPairing.enabled` to `true` in its own config. That happens only on its own person's explicit request to connect with another agent, for that one agent. It is the per-agent opt-in the spec's dark ship already allows, the same thing an operator would do by hand, and it matches what the Threadline section already promises ("Connect to the agent network → I'll enable the relay"; "You never need to edit config files"). Effect: after the next restart the agent is on the relay (visibility as configured, default `public`) and refuses to send credentials to agents it has not paired with, which is the intended rule. Fleet defaults are not touched.

---

## 6. External surfaces

- **Other agents / install base:** every agent's CLAUDE.md gains one section on update (about 3 KB). No behaviour changes until an agent's person asks it to connect with another agent.
- **External systems:** none directly. An agent that follows step 1 joins the Threadline relay after a restart, which it could already do through `threadline_relay enable`.
- **Persistent state:** CLAUDE.md and `.instar/self-knowledge-tree.json` (managed node), both already written by the migrator.
- **Operator surface (Mobile-Complete Operator Actions):** no new operator actions. The ones the section describes are already phone-completable: Approve and Finish are Telegram buttons, with the dashboard's Threadline tab as fallback. One remaining friction is named honestly: when the relay was off, the person must send `/lifeline restart` in Telegram, because a session cannot restart its own server (`SessionServerGuard`). The PR proposes removing that step; it is not removed here.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**replicated** for the text: CLAUDE.md and the tree are written by the migrator on every machine at update. The section itself covers the multi-machine case in one line: if making the invite answers 503 because this machine does not run the relay while `relayEnabled` is already on, another of the agent's machines holds the connection; the agent finds it with `GET /pool/placement` (`leaseHolderNickname`, the lease holder runs the relay), moves the conversation there with `POST /pool/transfer` (asking its person first when the route answers `needsConfirmation`), and if the move is impossible names that machine to its person. No notices, durable state or URLs are added by this change.

---

## 8. Rollback cost

Pure code and text. Revert and ship a patch; the section would remain in agents' CLAUDE.md files that already received it (harmless, accurate guidance) unless a follow-up migration removes it by heading. No data migration, no user-visible regression during rollback.

---

## Conclusion

Clear to ship as knowledge. The review produced one design change: the first draft told the agent to restart its own server, which the session guard refuses and which would strand the conversation, so the section now says the agent cannot and asks for `/lifeline restart` in one sentence. The relay and pairing defaults are deliberately NOT changed here; the PR carries a written proposal with the exact conditions under which turning them on by default would be safe.

---

## Second-pass review (if required)

Not required (no gate, trust or lifecycle code).

---

## Evidence pointers

- `tests/unit/agent-connect-knowledge.test.ts` (19 tests): the instruction's key lines; the template places it once inside the Threadline section before the tools list; the migration delivers the byte-identical section to an old CLAUDE.md before its tools heading, appends it when there is none, is idempotent and skips a fresh agent; a CLAUDE.md made from the pre-change template ends up with a Threadline How-to-Use-to-tools region byte-identical to a new agent's (section plus both bullets), a re-run adds nothing, and a file that already has both bullets keeps them once and in place; an existing tree without the node gains it on update and the node serves the section from CLAUDE.md, stopping at the next heading; triage routes "connect with Echo" and "pair with Scout" to it, and "fingerprint" no longer does.
- Breakage check: with the section migration disabled, the existing-agent tests fail; with the bullet migrations disabled, the pre-change-template and minimal-old-file tests fail; with 'fingerprint' put back in the keywords, the routing test fails.

## Review fixes (Echo's approval with four changes)

1. Existing agents now also get the `threadline_pair` tools bullet and the "Connect with Echo" How to Use bullet, each content-checked on its own text and placed at the end of the list the template puts it in (just before the section when that list is missing). The bullet text is a shared constant in `templates.ts`, so new and existing agents get the same bytes.
2. The agent no longer says "expires in an hour". It reads `exp` from the invite response and says the time in its person's local time.
3. 'fingerprint' is removed from the `capabilities.agent_connect` triage keywords (it belongs to `capabilities.canonical_identity`).
4. The relay-holder case (the invites route's 503 "this machine does not run the Threadline relay") now names the lever: `GET /pool/placement` (`leaseHolderNickname`; relay ownership follows the lease, `relayOwner: () => leaseCoordinator.holdsLease()` in server.ts) and `POST /pool/transfer {topic, to}` (routes.ts), asking the person first on a 409 `needsConfirmation`, and naming the machine to the person if the move is impossible.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect of a registered class — not applicable. This adds missing agent knowledge (Agent Awareness, Migration Parity).
