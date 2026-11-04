---
title: "Anything that needs the operator is on the first screen, counted, and linked"
slug: "operator-needs-first-screen"
author: "echo"
status: "converged"
parent-principle: "Structure beats Willpower — rule 1 of Operator-Surface Quality was enforced only by a written answer at commit time, and the Development page broke it with every gate green."
created: "2026-11-03"
topic: 136706
eli16-overview: "docs/specs/operator-needs-first-screen.eli16.md"
review-convergence: "2026-11-04T03:00:00.000Z"
review-iterations: 2
review-completed-at: "2026-11-04T03:00:00.000Z"
approved: true
approved-provenance: "Job brief for topic 136706 (2026-11-03): use /spec-converge, stop at the 80/20 point, hold only the registry edit on the operator's answer, everything else proceeds."
---

# Anything that needs the operator is on the first screen, counted, and linked

## Problem statement

Operator, topic 136706, 2026-11-03: "Something like this should NOT be hidden at the bottom of the page. I now see the 'auto merging' notice at the top, but that notice should be clickable to expand and see the 'turn on' button. We should have STRONG user experience standards that always hand-hold the user through any decision/action that needs them."

`docs/STANDARDS-REGISTRY.md` already has Operator-Surface Quality rule 1 ("lead with the primary action, visible and actionable on arrival, never collapsed, below the fold"). It is enforced only by a written answer at commit time, so nothing caught the breach. A survey of the console (2026-11-03) found:

- Home's "What needs you" reads only the attention queue and promises. Auto-merge stopped never reaches it, and neither do permission approvals, waiting passwords, plans waiting on the operator, or spending controls.
- Spending controls that need the operator are the last section of the Costs page, collapsed by default on other states.
- Pull requests waiting on the operator's GitHub approval sit inside a fold on Development that is often closed.
- Copy points at places instead of offering the action: "Turn it back on below", "tap Turn on pairing below", "Connect one below", "Every decision below is suspect".
- When an agent sends the operator to a surface, nothing checks that the message has a link or the on-screen words, or that the agent looked at the page first.

## Proposed design

### 1. One registry of what needs the operator: `dashboard/console/needs-model.js`

A pure module, no DOM. `NEED_SOURCES` lists each state that needs the operator:

| id | page | reads | built from |
|---|---|---|---|
| `merging` | `work/development` | `/green-pr-automerge` | `buildShipping` → `stoppedLead` |
| `shipping-approvals` | `work/development` | `/green-pr-automerge` | `buildShipping` rows waiting on GitHub approval |
| `feedback` | `work/development`, maintainer mode only, every fourth tick | the six feedback reads | `operatorTodos` |
| `accounts` | `capacity/accounts` | `/subscription-pool?scope=pool`, `/subscription-relogin?scope=pool` | `buildAccountsPage` → `needs` |
| `agents` | `people/agents` | `/threadline/pairing`, `/threadline/pairing/invites` | `pairingModel` → `waitingCards` |
| `approvals` | `people/mandates` | `/authorization-requests?status=pending` | `buildApprovals` |
| `plans` | `work/plans` | `/initiatives`, `/blockers` | `buildPlansPage` → `needsYou` |
| `secrets` | `people/secrets` | `/secrets/pending` | `buildRequests` → `waiting` |
| `spending` | `capacity/costs` | `/routing-spend/enable-status` | `spendingNeed`: limits turned on but not enforcing |

Each entry has a small adapter returning `{ off }`, `{ failed }` or `{ rows }`. A row is `{ key, main, sub, tone, refs, action: { kind: 'href', href } }`, the shape Home already renders, so every row has somewhere to tap. Builders are the pages' own, so Home and the page interpret a state the same way.

**Exempt states are listed in the same file by page and exact phrase**, each with its reason, not by whole page, so a new need using the floor's vocabulary still fails on an exempt page. This is regression coverage for registered states and selected words; a new state phrased differently needs a reviewer, which the side-effects question on operator surfaces asks for. Exempt: Schedule, Allowed, Machines, Sessions, Maturation and Inside "needs a look" states (the agent's to handle, the rule Home's headline already states); Promises (already on Home, keeping the operator's 2026-11-02 decision that only promises due within 24 hours count); Messages (a PIN unlock to read a log, nothing is blocked); Ideas (advice with no consequence for waiting); Learned (a preference conflict the agent can carry); a merge stop only the agent's own records hold, which it releases itself (its card still leads Development); a deliberately frozen spending route and a pending restart (the operator's own choice, and the agent's job); the two incident banners, broken decision chain and saved keys unreadable, which keep their lead position but have no operator action to offer today.

### 2. Home counts every source

`loadHome` reads sources concurrently, each with one in-flight read and the console's 20-second deadline, and publishes each source's answer on its own, so a stalled source cannot delay a healthy one. There is no retry timer beyond the next tick, and a 403 on a source does not sign the operator out. `combineNeeds(needs, promised, surfaced)` merges surfaced rows **before** its early returns, so a slow queue cannot hide them. Count, rows and `headline` all come from that one result.

- A row that names the same thing as an open queue item is dropped by identity, not by category: `refs` (a pull request number in this agent's one repository, or a full account address) must appear as a whole token in that queue row. Everything unmatched stays, so one sign-in item never hides another account's. At worst one thing counts twice, which is the safer way to be wrong.
- Before a source's first answer, `headline` says "Checking in", so "All quiet" can never paint early.
- A failed read marks the card partial ("Nothing needs you that I can see") and its last good rows stay for `PARTIAL_GRACE_MS`. A 503 means switched off, the console-wide contract `get` already applies: pages say the same thing for the same answer.

### 3. Every page leads with its need, with the action in place

"First screen" means: the first need's action is visible on arrival at 1280x728 and 390x844, and further needs follow directly or are counted with a control that reveals them. Pages mark the lead with `data-operator-need="<source id>"` (a fixed source id, never a row key: a secret card's key holds its drop token). Changes:

- Costs: a need card leads the page when limits are on but not enforcing, linking straight to the legacy spend tab, the only place the control exists.
- Development: pull requests waiting on approval get a lead line that opens the Shipping fold and scrolls to it. The existing stopped card and to-do card get the marker.
- Agents: the turn-on card moves above the lists when pairing is off. The alarm card gets an action, since it has none today.
- Accounts, Plans, Secrets and Mandates approvals already lead, and gain the marker.

### 4. Copy never points at a place

Page copy never says "below", "further down", "scroll down" or "at the bottom". Existing strings drop the pointer: a notice either carries its control or says nothing about where to go.

### 5. Enforcement: `tests/unit/console-needs-first-screen.test.ts`

- **Registry vs pages.** For every source, a fixture puts the shipped page in that state in jsdom. Asserted: `[data-operator-need]` exists; only the page head or another need comes before it; it is not inside a closed `<details>` or hidden element; it holds an enabled button, or a link that leaves the section; the page head above it stays within a size cap (a tall head is how a need slides off-screen without changing DOM order).
- **Home.** For every source, the same fixture yields a row with an action, the count rises, and `headline` is not a quiet one. Two needs in one category both survive.
- **Population floors.** Fails if `NEED_SOURCES` shrinks below the committed count, or if any console file says "needs you", "need you", "waiting on you" or "your approval" outside a registered source or an exact-phrase exemption.
- **Copy scan.** Fails on a forbidden word in any string in `dashboard/console/*.js`, comments stripped.
- **Negative controls.** A page that buries the need below a section, a need with no action, a need in a closed fold, an unregistered "needs you", and a notice saying "below" each fail the same predicates.

jsdom has no layout, so the viewport half is proved in the real browser at both sizes before this ships, with screenshots read. CI has no browser in this repo's unit lane; that gap is stated, not hidden.

### 6. Agent-side check: `B22_SURFACE_REFERRAL`

One new **advisory** tone-gate rule (like B2 and B21: a nudge with a recorded override, never a wall). `detectSurfaceReferral` in `src/core/operatorSurfaceReferral.ts` is a pure detector that feeds `signals.surfaceReferral` in the outbound route beside `filePath`. It is NOT added to `GateSignalDetectors`, because every hit there counts as a leak on the outage path. It reports whether a direct link is present, whether exact on-screen words are quoted, and whether the agent confirmed rendering. The LLM judges by meaning whether the message really sends the operator to a surface. The rule's text is added to the prompt only for a message the detector flagged, so the benchmarked prompt template is unchanged for everything else and its saved benchmark stays valid.

Rendering is confirmed through the existing reaction path, with no new script, file or flag: the first send without confirmation comes back as a nudge saying what is missing and to load the link at the operator's viewport (1280x728 and 390x844 by default). The agent loads it, then resends with `--tone-complied B22_SURFACE_REFERRAL`, which records it and marks the signal confirmed. An agent that cannot render overrides with a stated reason. That is a self-report, recorded as one, and every reaction is graded by the decision-quality meter. A sentinel redrive gets no signal, because nobody can react and the recovery policy treats any 422 as final. A receipt system was reviewed and cut: no browser ships with instar, so most agents could never produce a receipt, receipts go stale, and they would store links that can hold secrets.

## Decision points touched

- `B22_SURFACE_REFERRAL` (outbound tone gate): classification `judgment`. Detector is signal-only; the LLM decides; disposition `advisory`, so the message is handed back with a recorded override path and never dropped. Bias to send: favor false negatives, like B15–B18.
- `combineNeeds` and `headline` (Home): classification `invariant-floor`. Display only.
- The CI test is a floor: it fails the build for a new regression, the Dashboard UX pattern.

## Signal vs authority

The detector is a signal with no I/O. The tone gate is the single authority and this rule is advisory. Registry reads are display-only.

## Multi-machine posture

Sources read what their pages read. `accounts` is pool-wide. `merging`, `approvals` and `secrets` read machine-local stores, the same reach their pages have today, so a console opened on a machine that does not hold them cannot see them. That is proxied-on-read work the routes do not yet support; it goes to the feedback queue. The operator's console is served from the machine running the merge watcher, so the founding case is covered. The rule is stateless per message, so there is nothing to replicate.

## Migration

Browser files ship with the package. The rule ships with the server. A CLAUDE.md section naming `--tone-complied B22_SURFACE_REFERRAL` goes through `generateClaudeMd` and `migrateClaudeMd`. No relay-script change.

## Rollback

Revert. The rule's disposition is a code constant, so turning it off is a revert and release. No stored state.

## Constitution

The rule's wording in `docs/STANDARDS-REGISTRY.md`, under Operator-Surface Quality with its "Applied through" line, and the F12 line from the previous PR, are held for the operator's ratification (asked in topic 136706, 2026-11-03). They ship as a separate small commit when answered. Enforcement does not wait for it.

## Open questions

None. The registry wording waits on the operator, as above; everything else proceeds.
