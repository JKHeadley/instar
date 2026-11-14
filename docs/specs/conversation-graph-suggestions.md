---
approved: true
approval-evidence: "Justin, topic 137342, 2026-11-11 18:56 PST: 'Yes please. Also, the \"Chief of Staff\" conversation should always be the root conversation' (answering the 18:50 explanation of the suggestion step)"
parent-spec: docs/specs/conversation-effort-hierarchy-v3.md
eli16-overview: docs/specs/conversation-graph-suggestions.eli16.md
tier: 1
---

# Conversations: suggestion step and the Chief of Staff root

## 1. Why

The Conversations Overview shows only efforts. Efforts come from the owner's "Create effort" or from live delegation capture (v3 §5 item 5), so an agent with a long history opens on an empty Overview. v3 already names the cure: "Historical inference proposes placements", reviewed by the owner with `Accept` and `Reject` (v3 §5.3 corrections table, §6 "Review suggestions", §7.1 suggestion endpoints). This spec builds that step at its smallest useful size, plus the owner's rule that the Chief of Staff conversation is always the root.

## 2. Chief of Staff is the root

- The root is the agent's Chief of Staff Telegram topic (StateManager `chief-of-staff-topic`), present only where the Chief of Staff feature runs.
- `GET /conversation-graph/roots?view=overview` (no search) adds `root`: the Chief of Staff conversation's ordinary projection item, when the viewer may see it. The dashboard draws it as the top row and every root effort under it. All and search are unchanged.
- It has nowhere to go: `GET …/nodes/:ref` reports `moveEligible:false, reason:'chief-of-staff-is-root'`, `…/destinations` returns no items, `POST …/preview` answers `eligible:false` with that reason, and `POST …/changes` refuses a placement of it under any parent with 409 `chief-of-staff-is-root` (`requestState:'not-recorded'`). Placing it at the top level (`parent:null`) stays allowed.
- An effort cannot be placed under a conversation in the v3 model, so "every effort under Chief of Staff" is how the Overview presents root efforts, not a graph edge. No event is written and nothing needs migrating.

## 3. Suggestions (advice only)

- Inputs: the viewer's unassigned conversations (no visible parent, not unavailable, never the root), most recent first, at most 120. Each carries its title, its bound project (topic-project binding) and up to 360 characters of what it has been about (TopicMemory purpose/summary and live topic-intent goals).
- One model call per build (`attribution.component: 'ConversationGraphSuggestions'`, category `reflector`, balanced tier). Conversations are given to the model by short alias inside a fenced data block that the prompt says never to obey.
- Deterministic validation of the answer, nothing repaired: only offered aliases; 2 to 12 distinct members; no conversation in two groups; no group mixing two bound projects; nothing the owner rejected; at most 8 groups; name and reason clipped to 60 and 160 characters.
- A suggestion's id is the hash of its sorted member keys. A rejection is remembered by that id and never offered again. An accepted one is never offered again. A suggestion any of whose members is no longer an unassigned visible conversation is withdrawn, not trimmed.
- Spend: a build starts by itself when the list is opened and the last attempt is more than 24 hours old; a manual refresh at most every 10 minutes; one build at a time; no model call with fewer than two inputs. No model configured: the page says so and nothing runs.
- Routes (dashboard owner proof; mounted only with owner corrections): `GET /conversation-graph/suggestions`, `POST /conversation-graph/suggestions/refresh`, `POST /conversation-graph/suggestions/:id/start`, `POST /conversation-graph/suggestions/:id/reject`, `POST /conversation-graph/suggestions/:id/accepted`.

## 4. Accept

Accept runs, from the owner's dashboard session, exactly the owner changes a manual Create effort and Move would: `create-effort` (empty project scope), `set-effort-title`, then for each member a `POST /preview` and a `set-primary-placement` under the new effort. Each step waits for its change to commit before the next, because the next names what the last made. The create-effort request id comes from the server, once per suggestion (`POST /conversation-graph/suggestions/:id/start`), so a reload, a second tab or a later visit reuses the same owner request and gets the same effort. A started Accept stays offered (as Continue) while its members move in, and its members are left out of later builds. A step still saving after 60 seconds stops with the waiting machines named and a Continue button. A conversation that is already under any other parent, or can no longer move, is skipped and reported: the owner's own placement wins. Naming is skipped when the effort already has a name. A refused step stops the Accept and changes nothing after it. When every step is done the dashboard records `accepted`.

## 5. Multi-machine posture

Suggestion state (the built list, rejections, acceptances) is one small file in the serving machine's state directory: machine-local by design. Suggestions are advice regenerated from shared inputs. The graph changes an Accept makes are the ordinary replicated owner events. A rejection recorded on one machine is not known to another, so a different machine's dashboard could offer the same grouping again. Moving this state onto a replicated store is tracked <!-- tracked: CMT-1650 -->.

## 6. Out of this change

The app (mobile) surface keeps the flat list. Its device-signed route allowlist does not include the suggestion routes, and adding them is tracked with the app consolidation <!-- tracked: CMT-1651 -->.

## Carriers

The two follow-ups above <!-- tracked: CMT-1650 --> <!-- tracked: CMT-1651 --> and the commitments that carry them (frozen excerpts from the registry, 2026-11-11):

> **CMT-1650** — "Move conversation-graph-suggestions state (rejected/accepted/accepting) onto a replicated store so a rejection on one machine is honored on every machine (spec docs/specs/conversation-graph-suggestions.md section 5)"
>
> **CMT-1651** — "Add the suggestion routes to the device-signed mobile allowlist and an app Review suggestions screen (spec docs/specs/conversation-graph-suggestions.md section 6)"

Promise ids above are open commitments in this agent's registry.
