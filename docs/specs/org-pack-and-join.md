---
title: "Organization pack and joining by invitation"
slug: "org-pack-and-join"
author: "echo"
parent-principle: "The User Experience Is the Product — Reachability, Responsiveness, and Coherence Are Sacred"
eli16-overview: "org-pack-and-join.eli16.md"
status: "approved"
approved: true
approved-by: "echo, under the standing operator rule that only constitution changes need Justin (memory: only-constitution-changes-need-justin). No constitution file is touched, and a pack can only narrow authority. Feature approved by Justin: topic 141385, 2026-11-16 13:12 PST (easy-setup brief build step 4). The decisions owed to him (blocking for joined agents, app-only trust approval, separate work agent) are not taken here."
review-convergence: "2026-11-16T22:47:28.455Z"
review-iterations: 6
review-completed-at: "2026-11-16T22:47:28.455Z"
review-report: "docs/specs/reports/org-pack-and-join-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
---

# Organization pack and joining by invitation

## Problem statement

Justin approved "easy setup for new people" on 2026-11-16 at 13:12 PST (topic 141385). Its organization half (brainstorm round 2, document 675c5da4 v2) asks that an organization such as the Monroe Institute can give every colleague's agent the same AI policy from its first minute. Build step 4 of the approved brief: "admin 'set up our organization' chat (read-back, try-it list), versioned/published policy record, invitation link/code, one join screen (what org can/can't see), joining before AI sign-in. Reuse OrgIntentManager / org-intent session-context."

Today:

- An agent's organization rules live in `.instar/ORG-INTENT.md`, read by `OrgIntentManager` (`src/core/OrgIntentManager.ts`) and injected at every session start (`formatOrgIntentForSessionStart`, `GET /intent/org/session-context`). `POST /intent/org/test-action` answers "would this be allowed?" for one action.
- The file is edited by hand on one agent. It has no version, no publisher, no organization identity and no way to reach a colleague's agent.
- The independence level (`AutonomyProfileManager.setProfile`, `POST /autonomy/profile`) can be raised to any level; nothing caps it per organization.
- Once `ORG-INTENT.md` exists, the Coherence Gate's value-alignment reviewer checks outbound messages on external channels against its `## Constraints` and blocks by default (`src/core/CoherenceGate.ts:1045-1058`, `1227`), but only on agents where the gate runs at all, which needs `responseReview.enabled` (off by default, `src/commands/server.ts:23355`). Actions (deleting a file, calling a tool) are not checked against it. Meaning-based blocking of actions is build step 5 (its own spec, behind Justin's yes). This spec does not change the gate; it delivers the policy to every agent, keeps "ask first" items out of the gate's blocking list, and says on the join screen exactly what is checked today.

## Goal

1. The admin tells their agent "set up our organization" and pastes a policy (or the starter policy from instar.sh/guides/organizations). The agent reads it back in its own words, tries everyday requests against it, and publishes version 1.
2. The agent makes an invitation link. A colleague opens it (in the Instar app, or by handing it to their own agent), sees one screen of what joining means, and joins. Their agent then follows that policy at every session start, and its independence is capped by it.
3. When the admin publishes version 2, joined agents that can reach the admin's agent pick it up and say in one line what changed.

No new server we run, no purchased service, no Telegram.

## Design

### A. The pack

A **pack** is two things, stored under `.instar/org/<orgId>/` on every agent that holds it:

- `policy.md`: the organization's policy, the readable document people approved. Its headings follow the starter policy: `Purpose`, `Never`, `Ask first`, `Normally`, plus optional free text. Unknown headings are kept and shown, not interpreted.
- `record.json`: `{ v: 1, orgId, orgName, version, policySha256, maxIndependence, publishedAt, publishedBy, keepers: [name], updateOrigin | null, signerPublicKey, sig }`.
  - `orgId`: 16 random bytes base64url, made once at the first publish.
  - `version`: an integer, +1 per publish.
  - `maxIndependence`: one of `careful | balanced | trusting | independent`, mapped to `AutonomyProfileLevel` in order (`cautious`, `supervised`, `collaborative`, `autonomous`). The admin chooses; the starter policy says Balanced. All four are allowed because the organization, not Instar, decides how much independence its work needs.
  - `updateOrigin`: the admin agent's stable https origin when it has one (the same origin pairing links use), else null.
  - `signerPublicKey` / `sig`: the **organization's own** Ed25519 key, made at the first publish, not a machine key (a machine key belongs to one machine and rotates). Its private half is kept on the machine that first published, in `org/<orgId>/signing-key` (0600), and never leaves it: secret sync is off on most agents, so this spec does not rely on it. Publishing runs only on that machine; any other machine of the same agent answers 409 `org-key-elsewhere` naming it. The signature covers the canonical JSON of every other field. If that key is ever lost, the organization publishes under a new `orgId` and members join again; there is no key rotation in this version. What it proves: every later version came from the same publisher as the first invitation the colleague accepted. It does not prove that publisher is really the named organization; the first invitation is trusted because a known person sent it. To make that checkable, both sides show the key's **fingerprint** (the first 10 bytes of SHA-256 of the key, as 5 groups of 4 hex characters): the admin's agent says "Tell colleagues your organization's code is A1B2-C3D4-E5F6-0718-293A", and the join screen shows the same code. It also does not prove the policy is enforced.

From the policy the agent writes `.instar/ORG-INTENT.md` in the existing format, so every existing reader keeps working. The meaning of each line is preserved explicitly, never left to the heading: a `Never` item becomes the constraint `Never: <item>` (an item that already starts with "never", "do not" or "don't" keeps its own wording, prefixed "Never: " only when it does not already say it); an `Ask first` item goes into a new `## Ask First` section as `Ask your person first before: <item>`; a `Normally` item becomes a goal `By default: <item>`; `Purpose` becomes a `## Purpose` section. `OrgIntentManager.parse` gains three fields: `askFirst` (from `## Ask First`), `purpose` (from `## Purpose`) and `otherText` (from `## Also In This Policy`, where every unknown heading is written as a bold line `**<heading>**` and every line of its text keeps its words, with any leading `#` replaced by its escaped form `\#`, so no policy text can start or end a section the parser reads). `formatOrgIntentForSessionStart` prints each as its own block ("PURPOSE", "ASK YOUR PERSON FIRST", "ALSO IN THIS POLICY"), and the parser's "is this intent empty" check counts them, so a policy with only a purpose or only ask-first items still reaches the session. Tests cover a purpose-only, an ask-first-only and an unknown-heading policy. It is not a constraint, so the Coherence Gate does not block messages over it (an "ask first before sending any message outside" item would otherwise block every outbound message). Size limits: at most 25 items per section, 300 characters per item, and 8 KB for the generated file; a policy over them is refused at draft, publish and join (`policy-too-long`), because all of it is read into every session start. A test checks the session-start text for the starter policy word for word. The file starts with a generated-from line naming the org, version and hash, and is rewritten only from the pack (a hand edit is detected by hash and reported, never silently overwritten: the agent says "Your organization rules file was changed by hand; joining or updating will replace it. Keep the change?").

### B. Admin: set up, try, publish (routes on the admin's agent, bearer or owner device)

- `POST /org/draft { orgName, policyMarkdown }` → parses the policy and returns `{ never: [], askFirst: [], normally: [], unplaced: [lines], tryList }`. `unplaced` lists sentences the parser could not put under a heading, so the agent can ask about them. `tryList` is twenty everyday requests (a fixed starter list plus requests built from the policy's own nouns). Each runs through the same judge `POST /intent/org/test-action` uses (`IntentTestHarness`, keyword matching by default, the LLM judge when `monitoring.orgIntentLlmJudge.enabled`), built in memory from the draft, twice: once with only the `Never` items as constraints and once with only the `Ask first` items. Refused by the first is `blocked`, else refused by the second is `ask`, else `allowed`, with the matched item named. The list is labelled an estimate. Nothing is written to disk except the stored draft.
- Because only the key-holding machine can publish, two of the admin's machines cannot publish the same version number. A received record whose version equals the held one but whose `policySha256` differs is refused as `version-conflict` and shown to the owner.
- `POST /mobile/org/publish { draftId, readBackConfirmed: true, maxIndependence, keepers, shareUpdates }`. It publishes only a draft made by `POST /org/draft` (which returns a `draftId` and stores the draft for 24 hours) whose policy hash is unchanged, and only with `readBackConfirmed: true`, so the draft (with its parse and try list) must exist; the app's publish card shows that stored read-back and try list to the person (§B2). The draft id, the try-list results and the confirmation are written into the decision journal with the publish. It writes the pack (version 1, or current + 1), applies it to this agent (§D), and returns the record and its fingerprint.
- **What publishing shares.** Every invitation carries the whole policy, so anyone given a link can read it. With `shareUpdates` on, the policy is also readable by anyone who can reach this agent's address. The publish response and the agent's confirmation say exactly that ("Anyone you send an invitation to, and anyone who can reach my address, can read this policy."). `shareUpdates` defaults to true and is stated at publish; with it off, `GET /org/pack/current` answers 404 and colleagues get new versions only through a new invitation.
- `POST /org/invitations { label }` → returns `{ link, expiresAt }`. The link is `https://instar.sh/join#p=<bundle>`, where the bundle (in the fragment, never sent to any server) is base64url of the JSON `{ record, policy }`, deflate-compressed. A starter-sized policy (about 2.5 KB) gives a link of about 2 KB. Invitations are not secrets: anyone with a link can read the policy and join their own agent to it, which grants them nothing (the organization sees no one's data, and joining only restricts the joiner). `label` and the time are recorded locally so the admin can see who was sent one.
- `GET /org/pack/current` (public, read-only, only when this agent published a pack with `shareUpdates` on; else 404): returns `{ record, policy }` for update checks. It holds the same content as every invitation, which the owner was told is shareable.

The agent's awareness entry teaches the conversation: read back counts and every item, ask about `unplaced` lines one at a time, show the try list, warn when more than a third of the try list is blocked ("this blocks a lot; move some never rules to ask first?"), ask for the second keeper, publish only on the person's explicit yes.

### B2. Who can publish, join, leave or accept: the person, through their app

**Routes.** One table; no other paths exist:

| Route | Who | What |
|---|---|---|
| `POST /org/draft` | bearer | parse, try list, store a draft (§B) |
| `POST /org/invitations` | bearer | make an invitation link from the published pack |
| `GET /org/status` | bearer | membership, version, held update, key code |
| `GET /org/pack/current` | public, if `shareUpdates` | the published `{ record, policy }` |
| `GET /mobile/org/status` | owner device | what the app's screens show: membership, newest draft with its read-back and try list, held updates with full text |
| `POST /mobile/org/publish` | owner device | publish a draft |
| `POST /mobile/org/join` | owner device | join from a bundle |
| `POST /mobile/org/leave` | owner device | leave |
| `POST /mobile/org/update-accept` | owner device | apply a held update |

`publish`, `join`, `leave` and `update-accept` are device routes, accepted only as requests signed by an owner device (the Mac or iPhone app), never with the bearer: `POST /mobile/org/publish`, `/mobile/org/join`, `/mobile/org/leave` and `/mobile/org/update-accept`, each added to `DEVICE_ALLOWLIST` with `ownerOnly: true`, body `json`, their own bucket `org-acts` (`ownBucket: 5`, per minute, the allowlist's unit), and left out of `BROWSER_ROUTES`, so a browser device (whose key is not hardware-held) is refused. The apps send them only from a screen the person tapped (the join screen, a "Publish this policy?" card, an update card), each showing the full text being applied. Each of the four handlers checks `principalOf(req).kind === 'device'` itself (as the existing device-only handlers do; `ownerOnly` alone only turns away non-owner phones), so these paths called with the bearer answer 403 `owner-device-required`, with the line the agent relays: "Open the Instar app to confirm."

`/org/draft`, `/org/invitations` and `/org/status` take the bearer, so the agent does all the preparation in conversation.

**What this does and does not prove.** It makes the person's tap in the app the only designed path, so an agent following a link in an email is told to send the person to the app rather than joining. It does not stop an agent that deliberately misuses its own bearer: today the bearer can mint a pairing code and, with the dashboard PIN the agent can read, approve a software key as an owner device (no hardware attestation exists). That is the same trust level as every existing `ownerOnly` route. Closing it is the trust journey's account-path approval (CMT-1837), which is also the "app-only trust approval" decision owed to Justin; when it lands, these four routes take its proof too.

This version needs an owner device. An agent with no paired app cannot publish or join; the agent says so and offers to pair the app. (Agents created by the Mac app have one from the start, `mac-app-creates-agent`.) The app screens (join, publish card, update card) are part of this spec's delivery in `apps/instar-ios` and are listed in Acceptance.

### C. Colleague: join

- The instar.sh page `/join` (static, in `site/`) reads the fragment in the browser and shows the join screen (§E) with two buttons: **Open in the Instar app** (an `instar://join#p=…` link the app handles) and **Copy for my agent** (a sentence to paste into any agent: "Join this organization: <link>").
- `POST /mobile/org/join { bundle }` on the joining agent, approved by the person (§B2):
  1. Decode, check the size (≤ 64 KB decoded: about 25 pages of text, far above any policy meant to be read on one screen, and a bound on parse work for a public link; a longer policy should be summarized, with the full document linked from it) and shape, check `policySha256` against the policy text and `sig` against `signerPublicKey`.
  2. **First join pins the org key:** the agent stores `orgId → signerPublicKey`. A later bundle or update for the same `orgId` with a different key is refused (`org-key-changed`) and shown to the owner, never applied.
  3. While joined, the same version is a no-op answered `already-current`. After a leave, the same version (or higher) is a rejoin and is applied in full; the version floor in `pins.json` only refuses lower versions. A lower version is refused as `older-version` (409) and changes nothing; rollback is never applied.
  4. Write the pack, apply it (§D), record `membership.json { state: 'joined', orgId, version, changedAt, epoch, updateOrigin }`, where `epoch` is one more than the previous membership epoch on this agent.
  5. An agent belongs to at most one organization. A join for a different `orgId` while a membership exists is refused (`already-member`); leaving first is required. Reason: two organizations' policies each carry their own rules and independence cap, and silently merging them could put one organization's rules in charge of the other's work; a person working for two organizations uses one work agent for each (the recommended separate work agent).
- `POST /mobile/org/leave` (approved by the person, §B2): removes the membership and the generated `ORG-INTENT.md` (after the same hand-edit preflight: a hand-edited file is left in place and the person is told), lifts the independence cap, keeps the pack folder renamed `left-<date>` for the record. The pinned key and the highest version seen stay in `org/pins.json`, so an old invitation for the same organization cannot be replayed to roll a rejoin back. Leaving writes `membership.json { state: 'left', changedAt, epoch: previous + 1 }`.
- **Joining before AI sign-in.** The installer answers file gets `orgBundle` and `orgAccepted` (added to `InstallAnswersFile`, `answersFileProblem` and the `--answers` help). The Mac app writes `orgAccepted: true` only after the person tapped Join on its own join screen; that tap is the person's approval for this brand-new agent, which has no owner device yet. Anyone who runs the installer could write it too, which is acceptable only because the agent is brand new and has no owner, policy or data to protect. Without `orgAccepted`, the installer ignores the bundle and says so. `runInstallCommand` runs `validateBundle` on it before the install flow starts, so before `install-tools`, `door-install` and the sign-in (the same effect as a first state-machine node, with no new state), so the app can show the org's join screen before any sign-in, and it is applied right after the agent's files are created (`agent-init`, which runs after `door-sign-in`), before the server first starts. So the policy is shown before the AI sign-in and applied after it; no work material reaches the AI account in between, because the agent does not exist yet. Any autonomy profile the installer sets afterwards goes through `setProfile`, so the cap holds. `applyOrgPack` needs no server: it writes files, and the profile lowering writes the autonomy state file through `AutonomyProfileManager` constructed on the agent's state folder. A policy whose `Never` list names AI services (a line matching "AI service" or "outside tool") is shown on the join screen, and the person's AI account choice comes after they have read it. The installer does not judge the AI account against the policy; the colleague and their organization decide that.

### D. Applying a pack (one function, used by publish, join and update)

`validateBundle(input)` is the one check used by join, update and peer fan-out alike, and it takes the raw input, not a typed object: the shape check, the size of the whole serialized bundle and of the policy (§C.1), the generated `ORG-INTENT.md` size (§A), `policySha256` equal to the SHA-256 of the policy text, the signature over the record, the pinned key (§C.2), and the version rule (§C.3). An update response that fails any part is refused like a bad invitation.

`applyOrgPack(stateDir, pack)` is an ordered commit that can always be finished. Applies are serialized: one in-process queue plus `org/apply.lock` (pid), so a join, an update, a peer fan-out and start-up recovery never interleave.
0. **Preflight, before any write:** if `ORG-INTENT.md` exists and its full-file SHA-256 matches neither `applied-intent.sha256` nor the `intent.sha256` of the version a leftover `org/txn.json` names (the file this agent was in the middle of writing), or there is no applied hash at all (a hand-written file before the first join), it was written by hand: refuse with `org-intent-hand-edited` unless the owner's request carries `replaceHandEdit: true` (the agent asks first, §A). On paths with nobody to ask (the update job) it refuses and leaves one notice for the person; the installer path cannot meet a hand-written file because the agent is brand new.
1. Stage the transaction in `org/staging/<txnId>/`: `bundle.json` (the validated bundle, or the leave), and `membership.json` and `pins.json` with this transaction's new values, including its newly assigned ordering tuple `(epoch, changedAt, machineId)` (each temp + rename). Only then write the marker `org/txn.json { txnId, orgId, version, op }` (temp + rename). The marker stays until step 5. Everything recovery needs is in the staging folder before the marker exists; an interruption before the marker leaves only an orphan staging folder, deleted at start.
2. Write the immutable version folder `org/<orgId>/v<version>/` from the staged bundle: `policy.md`, `record.json` and `intent.sha256` (the hash of the `ORG-INTENT.md` about to be generated). It holds only the policy, never membership or pins. A complete version folder is never rewritten; an incomplete one (no `record.json`) is deleted and written again from the staged bundle.
3. Generate `ORG-INTENT.md` from that folder.
4. Apply the independence cap (below).
5. Point `org/<orgId>/current` (a one-line file naming the version folder) at it by temp + rename, which is atomic; copy the staged `membership.json` and `pins.json` and the version's `intent.sha256` (as `applied-intent.sha256`) to their places; record the decision-journal entry `org-pack-applied { orgId, version, policySha256 }`; delete `txn.json`, then the staging folder.

**Recovery.** At server start, and before any join or update, a leftover `txn.json` means an apply did not finish: the agent runs the preflight again (so an edit made after the interruption is never overwritten without asking; if it finds one, the transaction is kept and the person is asked, exactly as for a new apply), then re-runs steps 2 to 5 from the staging folder it names, keeping the staged ordering tuple (so a retried rejoin keeps its own new epoch). Every step is idempotent, and the derived files are rewritten from the version folder. An agent whose current version equals an incoming version but whose `ORG-INTENT.md` hash no longer matches `applied-intent.sha256` (and was not hand-edited) is re-applied rather than answered `already-current`, so equal versions can repair.

**The independence cap.** It comes from the incoming version folder's record; afterwards from the record the `current` pointer names, whose signature is checked again on every read (an unsigned or altered copy counts as "no cap" for raising and is reported, never as a looser cap). "Looser" is what `TrustRaiseGuard.profileRaises` already compares, and the cap covers exactly those settings:
   - the autonomy profile itself (`autonomyProfile`), and its three authority settings `agentAutonomy.level`, `safety.level` and `evolution.approvalMode`.
   - **On apply:** before anything is lowered, the current profile and the three settings are written to the staging folder (`staging/<txnId>/authority-before.json`) and copied to `org/<orgId>/clamped.json` if none exists, so recovery always has the values to restore. Then the profile is lowered to the cap if above it, through a new `AutonomyProfileManager.lowerForOrgPolicy(level)` (a narrowing, so no proof; `setBy: 'org-policy'`, added to the `setBy` type and shown in the summary as "Lowered by <orgName>'s policy"). Each of the three settings whose current value is looser than the cap profile's value is rewritten in `config.json` to the cap profile's value. The previous profile and values are saved in `org/<orgId>/clamped.json` and the decision journal.
   - **Afterwards:** `setProfile` refuses any profile above the cap even with a valid operator proof, and `PATCH /config` refuses `evolution.approvalMode` looser than the cap's (the other two cannot be patched; the check sits beside `configPatchRaises`), with a new refusal code `org-policy-cap` ("Your organization's policy allows at most Balanced").
   - **On leave:** the saved profile and values are restored, each unless the person changed it since (then the current value stays). Settings that were unset before and filled with the cap's values stay at those stricter values (the safe direction).
   - Other `PROFILE_DEFAULTS` settings (`updates.autoApply`, `autoRestart`, `trustAutoElevate`) are not authority under `profileRaises` and are not capped; nor are per-service trust levels in `AdaptiveTrust`.

The cap only lowers. A pack can never raise independence, read conversations, or add a person.

**Hand edits at session start.** `formatOrgIntentForSessionStart` compares `ORG-INTENT.md` with `applied-intent.sha256` when an organization pack is applied; if they differ it adds one line: "This rules file was changed since your organization's policy was applied; tell your person." Edits to files are otherwise outside this spec: an agent that can write its own files can already change any of them.

**Honest session text.** `formatOrgIntentForSessionStart` today says violating outbound messages "are blocked at the Coherence Gate". That is true only where the outbound check is on. It takes the gate's live state (its one caller, `GET /intent/org/session-context`, passes `outboundGateOn` from `config.responseReview?.enabled`) and says "outbound messages that break these are blocked by the message check" only when it is on; off or unknown says "these are rules you follow; nothing blocks them automatically yet", so the agent never claims enforcement that is not running.

### E. The join screen (instar.sh/join and the apps)

One screen, in this order:

- **"Join <orgName>?"**
- **Your agent will never:** the `Never` list, verbatim.
- **It will ask you first before:** the `Ask first` list.
- **By default it will:** the `Normally` list, and the Purpose line.
- **Also in this policy:** every other line that will reach your agent, verbatim. Nothing reaches the agent that is not on this screen.
- **Most independence allowed:** Careful / Balanced / Trusting / Independent, in words. (Careful and Balanced set the same safety, autonomy and approval settings today, `PROFILE_DEFAULTS`; Careful additionally keeps the profile itself at its lowest. The screen says "Careful (the same limits as Balanced today)" so it does not promise more than it gives.)
- **What <orgName> can see:** your agent sends it nothing. If the policy has updates on, your agent asks <orgName>'s agent for a newer version once a day, so that computer can see your network address and when the check happens; with updates off (invitation-only) there is no contact at all. Check-ins that would report which version you follow are build step 6 and will be shown here when they exist. **What it can't see:** your conversations, your files, what you ask.
- **How strict this is today**, from the joining agent's live state where it is known (the app and the agent's own read-back), and conditional on the static instar.sh page: with the outgoing-message check on, "Your agent reads these rules at the start of every conversation, and messages it sends outside are checked against the 'never' list and held if they break it. Other actions aren't checked automatically yet."; with it off (the default), "Your agent reads these rules at the start of every conversation and follows them. Nothing blocks them automatically yet." The instar.sh page says: "Your agent reads these rules at the start of every conversation. Whether its outgoing messages are also checked depends on its settings (off by default)." (Replaced when build step 5 ships.)
- Policy version, publisher, date, and **"<orgName>'s code: A1B2-C3D4-E5F6-0718-293A. Check it matches what they told you."** Buttons: **Join** / **Not now**.

The Mac app shows the same screen natively when opened with `instar://join` (§B2); the iPhone app follows on the same bundle format.

### F. Updates

A joined agent with an `updateOrigin` fetches `GET <updateOrigin>/org/pack/current` at server start and then once a day from the existing scheduler (a built-in job `org-pack-update`, jittered), with a 10 s timeout. After a failed check the next one waits 1, 2, 4, then 7 days (the cap). After 30 days with no successful check the job stops, and the agent tells its person once: "I haven't been able to reach <orgName> for policy updates since <date>. A new invitation link will update me." A new invitation, a successful manual "check for updates", or a restart after 7 days resets it. A response is applied only when it passes `validateBundle` and its version is higher. Any change to the policy text is held, because any line, under any heading, is read by the agent as an instruction ("Never: …" can carry an instruction, and a broad "Never" line can stop every outgoing message): the agent shows the person every added, changed and removed line and applies it only on the person's approval (`POST /mobile/org/update-accept { version }`, §B2). The one change applied at once is a lower independence cap with identical text, and the person is told in one line. A held update is re-offered at most once a day. The `updateOrigin` must be `https`, must not name a loopback, link-local or private address (checked after DNS resolution), and its response is capped at 256 KB.

The job is an in-server timer, not an LLM job. Its state (`lastSuccessAt`, `failures`, `nextAt`, `stopped`) lives in `org/<orgId>/update-state.json`. It runs on the lease holder only. An unreachable origin is noted in status, never a warning that repeats.

## Decision points touched

| Decision point | Classification | Why |
|---|---|---|
| Bundle size ceiling, one-organization limit | invariant | Basis: external-constraint; evidence: the ceiling bounds parse work on a public link (resource floor, sized far above any readable policy); the single membership avoids an unspecified merge of two organizations' rules and caps (see §C.5). |
| Join / update acceptance (signature, pinned key, version) | invariant | Basis: external-constraint; evidence: an Ed25519 signature and a version integer are facts with one correct answer; accepting a different key or an older version would let anyone replace an organization's policy. |
| Publish, join, leave and accept need an owner-device request (§B2) | invariant | Basis: irreversible-consequence; evidence: publishing changes every member's rules and joining changes the joiner's own; the app tap is the designed path, at the same trust level as other `ownerOnly` routes (limits stated in §B2). |
| Independence cap in `setProfile` | invariant | Basis: enumerable-domain; evidence: four ordered levels and one cap value; the refusal is a comparison. |
| Policy → ORG-INTENT mapping and the try list | judgment-candidate | Floor: the deterministic heading mapping (Never → constraint, Ask first → Ask First section, Normally → goal), with unplaced lines returned to the person rather than guessed; arbiter: the person's read-back confirmation before publish. The try list uses the existing `test-action` judge, whose answers are shown, never enforced, here. |

## Open questions

*(none)*

## Acceptance

1. Unit: parse the starter policy into 5/5/5 with nothing unplaced; a policy with a stray line returns it in `unplaced`; ORG-INTENT generation round-trips through `OrgIntentManager.parse` (5 never constraints, 5 ask-first items that are not constraints, 5 goals); a bearer-only publish, join, leave or accept answers 403 `owner-device-required` and changes nothing; a hand-edited ORG-INTENT is detected and not overwritten.
2. Unit: bundle encode/decode; a tampered policy (hash mismatch, on join and on update), a bad signature, a different key for a pinned org, a lower version (`older-version`), a second organization, and an oversized bundle are each refused and change nothing; an equal version answers `already-current` unless the generated rules file drifted, in which case it re-applies; an apply interrupted at each step (a leftover `txn.json`) is finished at start; a hand-edited `ORG-INTENT.md` stops the apply before any write. The session text for the starter policy reads "Never: Share personal information …" and "Ask your person first before: Sending any message …".
3. Unit: the cap refuses `setProfile` and a `PATCH /config` raise above it with `org-policy-cap`, even with an operator proof; lowers a higher profile once with `setBy: 'org-policy'`; rewrites an explicit looser `safety.level` and restores it on leave; an altered `record.json` gives no looser cap. An update that only lowers the cap applies at once; any text change is held until accepted. Publish, join, leave and accept with only the bearer answer 403 `owner-device-required`; signed by an owner device they apply. `## Ask First` items appear in the session text and are not Coherence Gate constraints. A policy over the size limits is refused. After leave, a replayed older invitation for the same org is refused.
4. Integration: an admin server publishes (owner-device signed) and mints a link; a second agent server joins from the link's bundle (owner-device signed); its `GET /intent/org/session-context` contains the policy's never rules and ask-first block; the admin publishes v2 with a changed line; the second agent's update job holds it, and an owner-device-signed accept applies it; a v2 signed by another key is refused; a leave then a rejoin at the same version restores the rules and cap; an interruption after step 2 is finished at the next start without a hand-edit refusal; an unknown heading named "Constraints" stays text under "Also in this policy".
5. E2E: production init path; `/org/draft` and `/org/invitations` answer 200 to the bearer; `/mobile/org/publish` and `/mobile/org/join` answer 200 to an owner-device-signed request and 403 `owner-device-required` to the bearer; `/org/pack/current` answers 200 after a publish.
5b. App: the Mac app's join screen (opened by `instar://join#p=…`), "Publish this policy?" card and update card render every policy line and send device-signed requests; checked by screenshot.
6. Live: Justin's Echo (or a throwaway admin agent) publishes the starter policy adapted for the Monroe Institute pilot; a throwaway colleague agent joins from the link through instar.sh/join; its session start shows the rules; checked at 390x844 and 1280x728.

## Maturation plan

- **test-agent-live:** two throwaway agents on the Studio (admin and colleague), the colleague joining through a local build of instar.sh/join; acceptance 4 and 6 pass. Target 2026-11-17, owner echo.
- **dev-agent-live:** Echo publishes a pilot pack; one throwaway colleague agent joins it through the published instar.sh/join. Target 2026-11-18, owner echo.
- **fleet:** the next release after dev-agent-live. Owner echo, review due 2026-11-25. An agent that never publishes or joins is unchanged: no pack, no cap, no update job work.
- **graduation criterion:** one real organization pilot (the Monroe Institute) with one admin and one colleague joined, a v2 update reaching the colleague, and no wrong refusal of a valid bundle.
- **dark-window:** none: nothing happens until an owner publishes or joins.
- **ladder:** not applicable: no staged rollout of its own, it rides the release train and a revert undoes it

## Multi-machine

`ORG-INTENT.md` and `.instar/org/` are not replicated by any existing sync. Publishing happens only on the machine holding the organization's key (§A); joined packs fan out explicitly: the machine that accepts a publish, join, update or leave applies it, then sends the same validated bundle (or the leave, with its epoch) to every awake peer machine of the same agent through a new `MeshRpcDispatcher` command `org-apply`, permitted only between machines of the same agent (the same rule as `secret-share`), and each peer applies it through `applyOrgPack` (idempotent). A peer still runs `validateBundle` itself; the approval happened once, on the machine that took it. A peer applies fan-out and catch-up through `reconcile(membership, bundle?)`, which is distinct from a person's join: it skips the `already-member` refusal (a newer membership for another organization replaces the old one, after `validateBundle` on the new bundle) and applies an unchanged-policy membership change by advancing the tuple alone. Every membership change, live fan-out and start-up catch-up alike, carries the ordering tuple `(epoch, changedAt, machineId)` and is applied only if it is newer than the tuple in the peer's own `membership.json`; an older one (a delayed join arriving after a leave) is dropped and logged. A held update (§F) is fanned out the same way (`op: 'hold'`) and stored in each machine's `org/<orgId>/held/v<N>/`, so an accept arriving at any machine applies its own copy and fans the apply out. A peer that was asleep catches up at its own start: it asks its peers for their `membership.json` and applied record, takes the membership with the highest `epoch` (so a leave made while it slept wins over its old join; two different changes with the same epoch, possible only during a split between machines, are ordered by `changedAt`, then by machine id), and, when that membership is `joined`, the highest valid version of that organization's pack. The cap travels with the pack (§D.3). A leave carried by `org-apply` is not signed; it rests on the trust between machines of the same agent, the same any-peer trust `MeshRpc` already gives other same-agent commands.

## Rollback

Revert the code: `ORG-INTENT.md` files already written stay (they are plain files the old code reads as before); the cap field is ignored by old code, so independence is no longer capped; packs on disk are inert. `POST /mobile/org/leave` undoes a join on any version that has it.

## Out of this spec

Strict blocking of "never" rules (build step 5, needs Justin's yes), check-ins and the Work agents page, departure tooling, a second policy keeper's approval flow and recovery copy (build step 6), and the separate work agent (a decision owed to Justin). <!-- tracked: topic 143810 autonomous run tasks 5, 6, 7 -->
