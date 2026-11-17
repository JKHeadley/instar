---
title: "Organization members page, departure and a second policy keeper"
slug: "org-members-and-keepers"
author: "echo"
parent-principle: "The User Experience Is the Product — Reachability, Responsiveness, and Coherence Are Sacred"
eli16-overview: "org-members-and-keepers.eli16.md"
status: "approved"
approved: true
approved-by: "echo, under the standing operator rule that only constitution changes need Justin (memory: only-constitution-changes-need-justin). No constitution file is touched. Feature approved by Justin: topic 141385, 2026-11-16 13:12 PST (easy-setup brief build step 6). The recovery copy is cut into its own spec; no decision owed to Justin is taken here."
review-convergence: "2026-11-17T00:22:44.150Z"
review-iterations: 6
review-completed-at: "2026-11-17T00:22:44.150Z"
review-report: "docs/specs/reports/org-members-and-keepers-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
---

# Organization members page, departure and a second policy keeper

## Problem statement

Justin approved "easy setup for new people" on 2026-11-16 at 13:12 PST (topic 141385). Build step 6 of the approved brief: "Work agents page; departure; second policy keeper; recovery copy." The organization guide on the website (`site/src/content/docs/guides/organizations.md`) already tells admins what is coming: "A Work agents page: each agent, its person, its policy version and when it last checked in"; "When someone leaves … ask them to remove the work policy"; decision 11, "Who are the two people who can change the policy".

What `org-pack-and-join` (PR 3267) gives today:

- One organization key, made at the first publish and kept only on that machine (`org/published/<orgId>.signing-key`). If that machine is lost, the organization starts over under a new id and everyone joins again.
- Only that machine can publish. A second person cannot change the policy.
- Members fetch updates daily from `GET /org/pack/current` on the admin's agent (when `shareUpdates` is on). The admin learns nothing back: not who joined, not who is behind, not who left.
- A member can leave from their app. The admin cannot say "this person no longer works here".

## Goal

1. The admin sees a Work agents page in the Instar app: each joined agent, its person, the policy version it runs, and when it last checked in.
2. When someone leaves the organization, the admin marks them as gone; that person's app then asks them, once, whether to remove the organization's policy. Nothing is removed without the person's tap.
3. The admin names a second policy keeper. That person's agent can publish new versions, which members accept like the admin's own.
4. The recovery copy (build step 6's fourth item) is its own spec, `org-recovery-copy`, built after this one: its review kept finding new problems in fencing a lost or stolen key, so it was cut out to let this part ship.

No new server we run, no purchased service, no Telegram.

## Design

### A. Check-ins (members → the organization's agent)

**Member side.**
- At join (app join and installer; `POST /mobile/org/join` and the installer's `orgBundle` both gain an optional `inviteToken`), the member's agent makes a **member key** (Ed25519) in `org/keys/<orgId>/member-key` (0600) and stores the token in `org/keys/<orgId>/invite-token`. `org/keys/` is not moved by leave, so a rejoin keeps the same key and the same entry. A joined member who opens a newer invitation link for the same organization gets its bundle applied as the existing join does today (a higher version, possibly with a new `updateOrigin`), and its token stored.
- The daily update check (`OrgPackUpdater`, unchanged cadence and backoff) also sends `POST /org/checkin` to the same origin when the record has an `updateOrigin` (the admin turned on `shareUpdates`). Body (cap 2 KB), signed by the member key over the canonical JSON of every other field:
  `{ v: 1, orgId, memberKey, agentName, personName, appliedVersion, state: 'joined' | 'left', at, inviteToken?, rejoin?, sig }`.
  `personName` is the agent's configured user name (empty when unset). `agentName` and `personName` are each one plain line of at most 120 characters with no control characters (refused otherwise, as `orgName` is), and everywhere they are shown to the admin's agent they are labelled as reported by the member, never read as instructions. `inviteToken` is included until an answer says `enrolled: true`, and again after any `invitation-needed`. `rejoin: true` is included after any join that follows a leave of the same organization (app, installer or a newer link), kept in `org/keys/<orgId>/member.json` (`pendingRejoin`); a rejoin refused with `invitation-needed` shows the person "Ask <org> for a new invitation link", and dropped only once an answer shows `state: 'joined'`.
- At leave, one `state: 'left'` check-in is sent from the membership as it stood just before the leave (its `updateOrigin` and keys), best effort.
- The answer is `{ ok, enrolled, state, removal: { id, at } | null }`. A removal id not seen before raises the notice (§C); `removal: null` clears any notice still waiting.
- **Outgoing calls** (check-ins, proposals, the keeper's reads of `/org/pack/current`) use the update job's existing address checks: https only, no private or local addresses, and the connection pinned to the address that was checked. A bundle that comes back with `stale-base` is run through `validateBundle` against the organization key before it is shown or used as a base.
- **Members who joined before this version** send no check-in until the person approves it once: their app shows a card, "<Org> would like to see your agent's name, your name, the policy version it runs, and when it last checked in", with **Allow** and **Not now**. Policy updates keep working either way. New joins approve it on the join screen.
- The join screen (instar.sh/join and the apps) gains one line: "Your organization sees your agent's name, your name, the policy version it runs, and when it last checked in." The installer's join step shows the same line.

**Organization side.**
- **Invitations.** `POST /org/invitations` (existing) also mints a random 128-bit `inviteToken`, carried in the link's fragment beside the bundle (not in the signed record). `org/published/<orgId>.invites.json` holds, per token hash, `{ createdAt, maxUses: 50, usedBy: [memberKey], revokedAt?, active }`. A token's use is counted once per member key (`usedBy`), so a resend never uses up the link. The admin's app lists invitations with their use counts and can revoke one (`POST /mobile/org/invitations/revoke`, owner device).
- **Members.** `org/published/<orgId>.members.json` holds, per member key, `{ agentName, personName, appliedVersion, state: 'joined' | 'left' | 'removed', firstSeen, lastSeen, lastAt, removal?: { id, at } }`. `lastSeen` is the server's time; `lastAt` is the member's own `at` from its last accepted check-in. Writes are temp + rename under one in-process queue.
- **`POST /org/checkin`** is a public route like `/org/pack/current`, under the same `shareUpdates` switch and the rate limits in §D. Checks, in order: known `orgId`; `at` within 10 minutes of now; signature by `memberKey`. Then:
  - a listed key: accepted only if `at` > its `lastAt` (a replayed check-in changes nothing). It updates name, version and `lastSeen`, then applies the transition table below.
  - a new key: accepted only with a valid, active, unrevoked token under its `maxUses` (otherwise 403 `invitation-needed`), and only while there are fewer than 500 **joined** entries (409 `member-limit`).
- **Transitions** (the only ones there are):

  | From | Event | To |
  |---|---|---|
  | (none) | `state: 'joined'` check-in with a valid token | joined |
  | (none) | `state: 'left'` check-in | no entry; answered `ok` |
  | joined | `state: 'left'` check-in | left |
  | removed | `state: 'left'` check-in | removed (stays), `leftAt` recorded, shown as "removed, has left" |
  | any | admin remove | removed, with a new `removal` id |
  | removed | admin restore (`POST /mobile/org/members/restore`) | joined, removal cleared |
  | left | check-in with `rejoin: true` and a valid token | joined |
  | any | any other check-in | unchanged |

  Every move into `joined` (first check-in, restore, rejoin) checks capacity: with 500 joined entries it answers 409 `member-limit` and changes nothing.

  So a removed person comes back only through the admin's restore, an owner-device tap: a check-in from a removed key, with or without a link, leaves it removed.
- **Capacity and retention:** the 500 limit counts only joined entries. A joined entry that checked in once and not again for 30 days is dropped (first when the list is full). Left entries are kept up to 5000, oldest dropped first. Removed entries are kept whole (names, `lastAt`, `leftAt`, removal; a few hundred bytes each) and never dropped; at 10,000 removed entries a further remove is refused with 409 `too-many-removed` and the app says so. A removal therefore cannot be undone by waiting or by filling the list.
- **The publisher's own agent** is a member of its own organization without an invitation: at publish it registers its own member key in `members.json` directly.
- What a check-in proves: the same agent has checked in before (the key). It does not prove who the person is; anyone holding an invitation can check in under any name. The page says so in one line ("Names are what each agent reports").

### B. The Work agents page (admin)

- `GET /mobile/org/members` (owner device, `ownerOnly`, read bucket) and `GET /org/members` (bearer, so the admin's agent can answer "who has joined?") return the members of the organization this agent publishes, sorted by `lastSeen`: name, person, version, `behind` (version < current), `quiet` (no check-in for 3 days), state (joined, left, removed).
- The Mac app's Organization tab, for an agent that publishes, gains "Work agents": one row per member with those four facts in words ("Wren, Jordan Lee, version 3, checked in today"; "behind: version 2"; "no check-in for 5 days"). The iPhone gets the same list later (out of this spec).
- Members who never check in (an organization with `shareUpdates` off) cannot appear; the page then says "Turn on updates to see your work agents here" with the switch.

### C. Departure

- `POST /mobile/org/members/remove { memberKey }` (owner device, `org-acts` bucket) sets `state: 'removed'` and `removal: { id, at }` on that entry (a new id each time); its check-ins then answer that removal. `POST /mobile/org/members/restore { memberKey }` sets it back to joined and clears the removal (§A transition table); the member's next answer carries `removal: null`, which clears any waiting notice.
- The removed member's agent, on an answer carrying a removal whose `id` it has not seen, writes one notice (`org/keys/<orgId>/removed.json`, keyed by removal id) and shows the person a card in the app, from `GET /mobile/org/status` (new field `removedNotice`): "The Monroe Institute marked you as no longer part of it. Remove its policy from Wren?" with **Remove** (the existing `POST /mobile/org/leave`) and **Not now** (dismisses that removal id; the card comes back only for a new removal). The agent's session-start context also gets one line until the person decides.
- Nothing is removed automatically: the agent belongs to the person, and leaving lifts the policy's limits, so only the person's tap does it. The organization keeps its usual levers (ending the person's access to its systems), as the guide says.

### D. A second policy keeper (countersigned by the organization's agent)

Members only ever trust the organization key. A keeper never signs anything a member checks: the keeper proposes a version, and the organization's agent, which holds the organization key, checks it and signs it as an ordinary version. So `validateBundle`, `verifyRecordSignature`, `currentRecord()` and the cap read stay unchanged, a new joiner verifies a keeper-written version like any other, and a keeper (or a former one) cannot hand members a version directly.

- **Keepers are listed only on the organization's agent**, in `org/published/<orgId>.keepers.json` (`[{ name, publicKey, addedAt }]`, at most 3). This is a right to propose, held where proposals are checked; it is not part of the record. The record's existing `keepers` field stays what it is today: the names members are told to ask, chosen by the admin at publish. So adding or removing a keeper publishes no new version and makes no member wait for a tap.
- **Becoming a keeper.** The keeper's agent needs the organization's address: it takes it from its own membership or from an invitation link the keeper pastes (`POST /mobile/org/keeper-request { invitationLink? }`). It makes a keeper key (`org/keys/<orgId>/keeper-key`, 0600) with `POST /mobile/org/keeper-request` (owner device), which returns a short code: base64url of `{ orgId, name, publicKey }`. The keeper sends it to the admin by any means; the admin's app shows "Add Jordan as a policy keeper? Key code: A1B2-…" (the key's fingerprint, read aloud to check). On a tap (`POST /mobile/org/keepers/add { code }`, owner device), the admin's agent checks that the code's `orgId` is the organization it publishes and that the name is one plain line of at most 120 characters, then adds the key to `keepers.json`. Removing one (`POST /mobile/org/keepers/remove { publicKey }`) takes effect at once: later proposals signed by that key are refused.
- **Proposing a version.** Keeper authority is independent of membership: the organization's agent checks only `keepers.json`. The keeper's agent drafts from the organization's current published version, which it reads from `GET /org/pack/current` at draft time (or from the bundle returned with a `stale-base` answer); its draft records that base. The keeper tells their agent the change; the agent reads it back like the admin's publish (draft, try list, read-back) and, on the keeper's tap, `POST /mobile/org/keeper-propose { draftId, readBackConfirmed: true, maxIndependence }` (owner device) signs a proposal with the keeper key: `{ v: 1, orgId, baseVersion, basePolicySha256, policy, maxIndependence, proposedBy: name, at, sig }` and sends it to the organization's agent: `POST /org/pack/propose` (public, same `shareUpdates` switch, 64 KB cap). This route never creates an organization or touches `published/` on the keeper's agent.
- **The organization's agent accepts a proposal** only if: the signature is by a key in `keepers.json`; `at` is within 10 minutes; `baseVersion` and `basePolicySha256` match its current published version (otherwise 409 `stale-base` with the current bundle, and the keeper's app shows the newer text and asks again); `maxIndependence` is unchanged or stricter (otherwise 403 `keeper-cannot-loosen`). It then builds the next record: version current + 1, the proposal's policy with its `policySha256` recomputed, the proposal's `maxIndependence`, a fresh `publishedAt`, `publishedBy` = the keeper's name **from `keepers.json`** (the proposal's `proposedBy` is ignored), everything else from the current record. It signs it with the organization key, runs the same `validateBundle` every member runs (sizes, rule-file limit, signature) on the finished bundle, answers 400 with the reason if that fails, and only then writes `org/published/current.json`, which `/org/pack/current` serves. Publish and propose share one in-process lock (the key machine runs one server process; a crash leaves nothing to clear), so two versions can never claim the same number; the admin's own publish checks its base the same way: the admin's chat drafts from `org/published/current.json` (not from the admin agent's own applied version, which may be behind a held keeper version), and `POST /org/draft` records the version and policy hash that text came from (`baseVersion`, `basePolicySha256`), and a publish whose draft base is no longer current answers 409 `stale-base` with the current bundle.
- **The admin's own agent** is a member of its own organization; it receives a keeper-written version like any member, as a held update that waits for the admin's tap (§F of `org-pack-and-join`), never applied silently.
- When the organization's agent is unreachable, the keeper's app says "The organization's main agent isn't reachable right now, so this version can't go out." Nothing is applied anywhere.
- Rate limits on the public routes come in two stages. Before the signature is checked, requests go to one of two lanes. A request naming a member or keeper key already on the list counts in that key's own lane (60 per hour), so junk from a shared address cannot block a real member. Any other request counts per source address, 120 per hour. The source address is `CF-Connecting-IP` only when the request arrived through the agent's own tunnel connector, otherwise the socket address; a request forwarded by a peer machine over `MeshRpc` carries the address it was counted under. After it verifies, it counts against its key (check-in: 30 per hour per member key; propose: 10 per hour per keeper key). Junk requests therefore cannot use up a real member's or keeper's allowance.

## Decision points touched

| Decision point | Classification | Why |
|---|---|---|
| Check-in acceptance (signature, clock window, member limit, rate limit) | invariant | Basis: external-constraint; evidence: an Ed25519 signature and a time window are facts; the limits bound work on a public route. |
| Keeper proposal acceptance on the organization's agent (keeper key listed, base matches current, cap not looser); members verify only the organization key | invariant | Basis: irreversible-consequence; evidence: a looser cap, a new keeper or a moved origin would widen authority across every member; only the organization key, held by the organization's agent, signs what members accept. |
| Remove, restore, keeper add and remove, keeper-request and invitation revoke need an owner-device request | invariant | Basis: irreversible-consequence; evidence: each changes who may change rules or holds the key; same trust level as the existing `ownerOnly` organization acts. |
| A removal only asks; the person decides to leave | invariant | Basis: enumerable-domain; evidence: two outcomes, chosen by the person on a card; no judgment by the agent. |

## Open questions

*(none)*

## Acceptance

1. Unit: a check-in with a bad signature, a stale `at`, an unknown org, or as the 501st new key is refused and changes nothing; a valid one creates then updates one entry; `behind` and `quiet` are computed from the current version and `lastSeen`.
2. Unit: a keeper proposal on base vN is countersigned as v(N+1) and verifies with the organization key alone (a fresh joiner accepts it); refused when the key is not a listed keeper, the base is stale (409 with the current bundle) or the cap is looser; an admin publish and a proposal racing on vN produce one v(N+1) and one `stale-base`.
3. Unit: the transition table, row by row, including a removed member's rejoin with a token minted before the removal (refused) and after it (joined), and a restore at 500 joined entries (409).
4. Integration (three servers): admin publishes with `shareUpdates`; member joins and checks in; `GET /mobile/org/members` lists it with its version; admin adds a keeper (third server, joined); the keeper proposes v3 through `/org/pack/propose`; the member's update job holds v3 and accepts it; admin removes the member; the member's next check-in answers a `removal` with an id and `GET /mobile/org/status` carries `removedNotice`; a restore then clears it (`removal: null`); a second removal raises a new notice with a new id; Remove leaves; the admin's page shows "removed, has left"; a rejoin with `rejoin: true` and a valid token shows "joined" again.
5. E2E alive: on the production boot path `POST /org/checkin` and `/org/pack/propose` answer 404 when `shareUpdates` is off and 400 on an empty body when on; `GET /mobile/org/members` refuses the bearer.
6. Live: on the Mac, the Organization tab's Work agents list shows a joined throwaway agent; checked at 1280x728 (the Mac app's minimum width is above 390).

## Maturation plan

- **test-agent-live:** three throwaway agents on the Studio (admin, member, keeper); acceptance 4 and 6 pass. Target 2026-11-18, owner echo.
- **dev-agent-live:** Echo's pilot organization with one throwaway member. Target 2026-11-19, owner echo.
- **fleet:** the next release after dev-agent-live. Owner echo, review due 2026-11-26. An agent that never publishes or joins is unchanged.
- **graduation criterion:** the Monroe Institute pilot shows its members on the page, and a keeper-published version reaches a member.
- **dark-window:** none: nothing happens until an owner publishes or joins.
- **ladder:** not applicable: no staged rollout of its own, it rides the release train and a revert undoes it

## Multi-machine

The organization's registries (`members.json`, `invites.json`, `keepers.json`) and `published/current.json` live on the machine holding the organization key. On a multi-machine admin agent, any other machine forwards to it through the existing same-agent `MeshRpc`: the public routes (`/org/pack/current`, `/org/checkin`, `/org/pack/propose`) and the admin's device routes for members, invitations and keepers, and `POST /org/draft`, so every draft records its base from the key machine's `published/current.json`. When the key machine is asleep, those answer 503 `org-key-machine-asleep` (members retry on their daily cadence). Members' own keys (member key, keeper key, invite token) live under `org/keys/`. A member key, invite token, `enrolled` flag, pending rejoin and removal notices are copied to the agent's peers with the `org-apply` fan-out and also in the `org-state-pull` catch-up, so every machine of a member signs as the same member, including a peer that missed the fan-out. A keeper key is copied the same way.

**Built in two steps.** This PR is single-machine complete (every pilot agent today runs on one machine). The forwarding to the key machine and the copying of member state to peers above land in a follow-up PR <!-- tracked: CMT-1873 --> in the same 143810 run, tracked in its autonomous state file, before this feature leaves test-agent-live.

> **Carrier (frozen excerpt — the work the multi-machine deferral marker points at):** <!-- tracked: CMT-1873 -->
> **CMT-1873** — "Build the multi-machine part of org-members-and-keepers: forward /org/checkin, /org/pack/propose, /org/pack/current, admin device routes and /org/draft to the key machine over MeshRpc, and copy member key, token, enrolled, pending rejoin and removal notices to peers via org-apply and org-state-pull"

## Rollback

Revert the code: check-ins stop (members get 404 and keep updating), keepers can no longer propose (versions they already proposed are ordinary organization-signed versions, still valid). No migration.

## Out of this spec

The recovery copy (`org-recovery-copy`, next, tracked as task 6's fourth item in the 143810 run). The iPhone and Android Work agents list, members choosing to hide their person name, and more than one organization per agent.
