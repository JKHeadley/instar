---
title: "Recommended outside services: every one has a backup, every choice is saved, and a no stays a no"
related-specs: "install-experience.md, owner-authentication.md, hosted-relay.md, telegram-button-approval.md"
slug: "recommended-services"
author: "echo"
parent-principle: "The User Experience Is the Product — Reachability, Responsiveness, and Coherence Are Sacred"
eli16-overview: "recommended-services.eli16.md"
status: "draft"
lessons-engaged: "Migration Parity; Mobile-Complete Operator Actions; Context Before Consent; Verify the State, Not Its Symbol; a dark guard is worse than no guard; a send result is not a delivery; a kill switch needs an owner and a re-arm date"
approved: true
approved-by: "operator, Telegram topic 135786, 2026-11-03 19:52 PST: 'I'm saying yes to everything you're recommending and approved you to move forward here'"
review-convergence: "2026-11-04T03:54:04.789Z"
review-iterations: 6
review-completed-at: "2026-11-04T03:54:04.789Z"
review-report: "docs/specs/reports/recommended-services-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 12
cheap-to-change-tags: 0
contested-then-cleared: 3
---

# Recommended outside services

## Problem statement

Operator request, 2026-11-03, topic 135786:

1. Identify every third-party service an Instar agent greatly benefits from, and make sure each has a backup so an agent does not rely on it.
2. Recommend them to all users of new agents. Save the choice. On yes, the agent sets the service up itself, asking only for credentials when needed. On no, the agent does not ask again, unless an issue arises later that the service would help mitigate or prevent.

Operator refinement, same topic, after reading the first summary: "We want to be intelligent about re-offering integrations, like cool offs or feature updates." So a no is respected, but not absolute: cool-offs and feature updates are legitimate reasons, judged rather than timed.

Standing install rules also apply: every AI door, always a self-hosted path, phone and hosted service optional.

**Acceptance.** Part 2 is met when this spec ships. Part 1 is met only when no catalog row has backup status `gap`, each gap's own spec having shipped. Recommending a service does not close its gap.

## What exists today

Read on `main` at d0aaa8bb1, confirmed by review round 1. Nothing was tested by switching a service off.

The Consent & Discovery Framework (`FeatureRegistry`, `FeatureDefinitions`, `DiscoveryEvaluator`, `/features/*`) cannot carry this rule by adding fields:

- **Re-offering isn't really judged.** `DiscoveryEvaluator.preFilter` keeps declined features eligible below 3 declines, and `recordSurface` accepts any state, so a no can return with no state change or recorded reason. `cooldownAfterDeclineMs` is display-only, and any `featureVersion` bump counts as a change. The evaluator and its bounds are the right starting point, and this spec gives them real inputs.
- **A no can be erased.** Bearer-only `DELETE /features/discovery-data` deletes the rows.
- **A yes proves nothing about a person.** `consentRecord` is built by the caller and signed with the auth token every session holds. `userId` is caller-supplied and defaults to `default`.
- **`enabled` isn't tied to working.** Nothing checks the service works, and `bootstrap` flips `enabled` to `disabled` from local config.
- **The state graph can't express this.** There is no exit from `interested` and no edge for a person asking after a no.
- **Config binding doesn't fit.** `cloudflare-tunnel` and `git-backup` are `defaultOn`, so bootstrap marks them `enabled` and they would never be offered. A quick tunnel counts as Cloudflare. Bitwarden and a second subscription have no boolean key.
- **Choices don't travel.** `discovery.db` is a local SQLite file outside the coherence registry and outside backup `includeFiles`.
- **Nothing real triggers an offer.** The session-start hook posts `problemCategories: []`, and the installer and wizard never use the framework.

## The catalog

Backup status is one of `exercised` (a drill disabled the service and proved the fallback), `specified` (code and specs provide one, no drill yet), or `gap`.

| Id | Service | Benefit | Backup | Status |
|---|---|---|---|---|
| `tailscale` | Tailscale | Private address; strongest mesh link | Cloudflare, LAN, messaging with no address | specified |
| `cloudflare-domain` | Cloudflare with own domain. Quick tunnels don't count, and a no reverts to a quick tunnel rather than turning tunnels off | Stable public address | Tailscale, LAN, optional relay, consented temporary relay | specified |
| `telegram` | Telegram | Reach the agent anywhere | Slack, WhatsApp, iMessage, app, dashboard | specified |
| `jev` | Jev (TypeSafe) | Potentially huge efficiency gains, per the operator, plus extra judgment on advisory checks. Not yet measured, so the offer says "could" and quotes no number | Checks skip it or use their normal path | specified. The operator confirms new users can get keys. A yes stores the key. Its dev-gated features turn on only as each graduates the maturation path, so the efficiency gains arrive with graduation, and the offer says so |
| `bitwarden` | Bitwarden | Secrets survive machine loss | Local encrypted store, cross-machine sync | gap on a single machine |
| `github-state-backup` | GitHub, private repo | State copy off the machine | Same-machine snapshots | gap |
| `second-ai-door` | Second AI subscription | Survives one provider failing | Any other enabled door | gap with one door |
| `voice-transcription` | Groq or OpenAI | Understands voice notes | Says unavailable | gap |
| `email` | To be chosen in its gap spec | Scheduled reports | None | gap. On the list by operator decision, unavailable until sending exists |

Not recommended, because no choice is meaningful:

- **No account:** Telegraph, Cloudflare quick tunnels, temporary relays.
- **Ours, already optional:** instar.sh pair links, hosted relay, Threadline relay, feedback, telemetry.
- **Irreplaceable:** Apple push (`hosted-relay.md` covers independent users), npm.

Candidate for a later decision: an always-on computer.

**Structural checks.** A unit test fails if a row has no backup, or if a `gap` row's `gapSpec` file doesn't exist. Each gap's spec stub, with Echo as owner, ships in the same PR, and each gets a tracked commitment. An `exercised` status must name a drill test that exists. These tests prove the record is honest. Independence is proven only by drills and the shipped gap specs.

## Proposed design

### Store

A new `RecommendedServicesStore`, not more columns on `feature_state`. New ids keep bootstrap and `discovery-data` deletion away from these records. The old offers need retiring too: `cloudflare-tunnel` and `git-backup` keep their `discoveryTriggers`, so the generic evaluator path refuses both ids and any `surface` call for them, in every state. Re-offers go only through the path below. Reused: definition style with `dataImplications`, `resolveApprovalOwner`, `ApprovalLedger` for recording a yes, the replication machinery and the dashboard. `AuthorizationRequestStore` is not reused: it accepts only `user-floor-grant` proposals, has no tokens and isn't single-use.

Per service, at owner level:

```
choice:   unset | offered | yes | no
origin:   first-offer | event:<kind> | change | cool-off | person-asked | legacy-import
evidence: { entryId, principal, surface, offerTextHash, supersedes: [entryId], at }   // for yes and no
shutdown: none | authorized   // a no alone refuses offers; only a confirmed shutdown stops a running service
reason:   cost | privacy | not-needed | have-another | other | none   // tapped with a no, never free text
```

Per machine: `verified: { at, result }` and `inUse: bool`. A choice is the person's; a working install is a fact about one machine.

**Principal.** The owner. On a multi-user agent, only the owner's choice counts in this version.

Catalog values `available`, `setupRecipe`, `verify` and `reofferOn` are ids resolved server-side, evaluated at offer time, async and cached. A service with an unproven recipe or that can't be obtained is unavailable.

### Offers

Each service gets **one first offer, when it first becomes available** to this owner. Offers go in one short list:

- For a new agent, the first list follows a **delivered** first result (`install-experience.md` section 8). A `stored, not yet seen` result does not trigger it.
- A service that becomes available later joins the next list. At most one list a week.
- Existing agents get their first list after updating, through `PostUpdateMigrator`. Existing `declined` rows for `cloudflare-tunnel` and `git-backup` import as `no` for `cloudflare-domain` and `github-state-backup` before any list is built. An import has origin `legacy-import`, only suppresses offers, and is excluded from merge and reconciliation, so it can't stop a running service or beat a yes.

**Sent once.** First offers use the same ledger as re-offers, keyed by owner and service: `pending` until the outbound record proves delivery, then `offered`. A crash or lease move resumes `pending` rows. So a failed delivery isn't counted as offered. A crash between send and record can repeat one offer, as with re-offers, and is accepted. Otherwise a delivered row isn't sent again.

Each row states the benefit, what leaves the machine and to whom, cost, account needed, and the backup if you say no. An unanswered row stays `offered`. **It is not sent again.** It stays visible in the dashboard and app. Silence is never a yes or a no.

**In use.** If `verify` passes on this machine and the choice is `unset`, the machine records `inUse` and the row isn't offered. `inUse` is a fact, not consent: it never sets a choice, never overrides a `no`, and never authorizes a recipe on any machine. A config value alone is not enough, so a quick tunnel doesn't count. If `verify` is unmeasurable, the row is offered.

### Yes

A yes creates authority, so it needs a verified surface (`telegram-button-approval.md`, L15). The row's Yes opens a phone-completable confirm page carrying the data, cost and account text. The machine serving the page mints a single-use token when the page opens, bound to owner, service, target machine, offer text hash and a 30-minute expiry, so a lease move doesn't kill a yes. A dashboard or app row can open a fresh page at any time, which neither resends the offer nor spends an allowance. The first target is the machine serving the agent. A yes is recorded in `ApprovalLedger`; a no is recorded only in the choice evidence, since the ledger's `rejected` shape needs a divergence this doesn't have. The owner comes from `resolveApprovalOwner`. If no owner resolves, nothing is sent, and the rows wait in the dashboard. A Threadline peer report or a session's claim is not a yes.

**Which proof.** `ownerProof` from `owner-authentication.md` isn't built yet, and that spec is a draft. Until it ships, confirming uses today's dashboard PIN check. The agent can read that PIN, so this stops mistakes and confusion, not a deliberately hostile agent, and the spec claims no more than that. When `ownerProof` ships, this switches to it with no change to stored choices.

**Reaching the page.** A Telegram-only owner away from home has no address to open a confirm page, and an address is what Tailscale would provide. So `tailscale` and `cloudflare-domain` may be approved by an owner-only button. This is a new P-class tap, argued from the tunnel-consent grant in `telegram-button-approval.md` and not covered by its exception, so it adds its own callback class row and binding. It ends when the owner enrols their first proof (`owner-authentication.md`), or when that spec moves P-class taps to the dashboard, whichever comes first. It is safe enough because the recipe can't finish without the person's own sign-in through the link, and it refuses stored credentials and existing browser logins, so an agent can't finish that sign-in itself. It also needs the owner-check defect noted there (ACT-115) fixed for this path.

That button also covers a person asking for an address service after a no. Every other yes row, `person-asked` request and `provider-exhausted` page needs an address. With none, the row says an address comes first and offers Tailscale, instead of a dead link.

**More machines.** A yes is the person's unified choice, and it authorizes the machine it names. Confirming consumes the token and atomically writes a durable, replicated grant naming the target machine and the yes entry. A recipe needs the grant to run or resume, including after a restart, and a no invalidates it. Running the recipe on another machine takes one more confirmation for that machine.

**The agent owns setup, fully (operator direction, 2026-11-03).** "The only thing a user should ever do is approve decisions or supply credentials." After a yes, everything else is the agent's job until `verify` passes: researching how the service works today, creating the account, getting the key, configuring it, diagnosing failures, retrying and repairing. The yes opens a tracked commitment that stays open until the service works, or the person says no.

The person is asked for two things only. **Decisions,** such as a payment. **Credentials,** through Secret Drop, including a code sent to their phone. The person never opens a browser, fetches a key, visits a provider's site, runs a command, edits a file or follows steps.

**Whose account (operator direction, 2026-11-03).** The agent is like an executive assistant who manages the accounts, and the person is like a CEO who directs and approves. The agent can fully manage the person's own accounts, can use accounts of its own, or both. That is the person's choice. The agent makes clear that full account management is available, presents both as good options, and never recommends against either. Credentials still go through Secret Drop into secure storage.

**Where requests appear.** Credential entry and approvals appear in the Instar app and dashboard when those exist, because they make this effortless. They are never required, so a plain link always works. A setup message that gives the person any other task is a defect, and a test checks each recipe's messages for this.

A recipe is a proven head start, not the limit. When a provider's flow has changed or a recipe fails, the agent researches and adapts, and records what it learned.

External calls go through External Operation Safety. Choice `yes` plus `verified` is what shows as working. Routine recovery stays quiet, and shows in the dashboard. The person hears when it's working, when the agent needs something only they can give, or when it has run out of options, always in plain words and never handed back as steps. If the person changes their mind, they can say no at any point. Credential requests are bounded to one open request per service.

First recipes, each live-proven before it's available:

- **Jev:** the agent researches TypeSafe's current sign-up, creates the account, gets the key and stores it. The person only approves, and supplies a credential if the provider demands one.
- **Tailscale:** device-login link, then the operator step. That step lives only in the CLI installer and may need sudo, so it is extracted into a shared module first. If it needs rights the agent lacks, the agent works through alternatives first. If none works, it names the smallest thing it needs from the person.
- **Bitwarden:** the agent's own folder only. The confirm page lists the secrets copied. The master password never goes in a process argument, which means fixing `BitwardenProvider` unlock first.
- **GitHub:** a new private repo. `verify` proves the repo is private and reads back a push. Pushes are refused if the repo isn't private. For an existing agent with a public backup remote, that raises one attention item with the fix, because it is a privacy issue.

Second-subscription setup reuses the install door steps, also extracted from the CLI, since no server code can call the install engine today.

### No

For a service not running, a no is a tap from the list or the page, rate-bounded per `telegram-button-approval.md` class S. A running service means verified on this machine, or its config on or unknown. A machine that can't tell treats it as running and holds until a page confirmation. A no there turns something off, possibly a protection, so it goes through the confirm page, and then takes effect at once. If no address exists, a tap records the no with `shutdown: none`. Offers stop and pending grants are invalidated, but the service keeps running until the person confirms on a page, which sets `shutdown: authorized`. Either way it is sticky:

- Only the re-offer path below can offer it again, and every re-offer has a recorded reason.
- If the service was running, the agent stops future use and writes, and persists that in the config older versions also read where a key exists (a no to GitHub sets `gitBackup.enabled: false`). Copies already held elsewhere stay, the person is told so, and the agent offers to delete them.
- Switching a service off later through an owner surface counts as a no. A config edit on one machine doesn't.

**Never strand the owner or the mesh.** Before stopping a service that may be the owner's only way in, such as their only channel or only address, the agent proves another route works. If none does, it says so and keeps a narrow recovery route until the switch completes. A no to the only channel is recorded, and shutdown waits. On a mesh, a no to GitHub stops state pushes immediately. `gitBackup.enabled: false` also removes `GitSyncManager` and changes the lease medium at boot, so the config change waits until the mesh has moved its lease medium, keeping only a bounded lease path until then. A machine that is offline stops when it next syncs.

**Every machine obeys it.** Each machine reconciles its running integrations against `shutdown: authorized` on merge and at boot. A no invalidates pending setup tokens, and a recipe rechecks the choice just before activating. A disconnected machine enforces a no when it next syncs, and that gap is stated rather than hidden.

**The person can ask.** "Set up Tailscale" after a no goes to the same confirm page, origin `person-asked`. A session cannot set a yes by claiming the person asked.

### Re-offering after a no

A no can return for three reasons. All pass through `reofferFor(service, reason, evidenceRef)`, in-process only with no HTTP route.

1. **A real problem** the service would help with. Deterministic, using the event table below, with no model needed.
2. **A change that matters to this person.** Catalog entries carry `changes: [{ version, summary, affects: cost | privacy | setup | capability }]`, written by a person in code. A routine release adds nothing, so a version bump alone is never a reason.
3. **A cool-off,** when there is a good reason to think the answer would now differ.

**Saved reason.** A no offers one optional tap: cost, privacy, not needed, have another, other. Free text isn't stored, because it would replicate, enter backups and reach a model provider.

**Judgment for reasons 2 and 3.** A `reofferJudge` using the same intelligence provider as `DiscoveryEvaluator`, with its own component key, decision-point census entry and provenance logging. The evaluator's in-memory session limits and 5-second race don't fit, so limits live in the ledger. Inputs: the service, its changes since the no, the reason category, and categorical facts about the agent's use. No raw conversation. Output: `offer` or `hold` plus a one-line reason from a fixed set. The judge runs on the lease holder, for rows past the floor, and again only when a hash of its inputs changes, so a hold is remembered and the floor doesn't become a timer. A judge failure holds and is reported as a degradation, never as a judgment. Only successful verdicts are remembered, and failures retry with bounded backoff, so an outage can't freeze a row.

**Floor, in code, which judgment cannot exceed:**

- The service must be available.
- Reason 2 needs a change entry newer than the no, and each entry is spent once. Reason 3 needs the cool-off to have passed since the later of the last no and the last delivered re-offer: 90 days after one no, 180 after two. An imported legacy decline starts its cool-off at import.
- An ignored re-offer counts toward the limit. After 3 refusals or 3 delivered re-offers, reasons 2 and 3 stop. Real problems can still re-offer.
- At most one re-offer a day across services.
- Conservative default: if the judge is unsure, fails or times out, the row holds. Fallback ends at the deterministic rung: real-problem re-offers fire with no model at all.
- `reofferJudge` can only return these values. It can't set a choice, send anything, or choose the text.

**Evidence before authority.** Until the judge has earned it, reasons 2 and 3 run in shadow: it records what it would do, and only real-problem re-offers go out. The deterministic default is `hold` for reasons 2 and 3, so the judge must beat it on named criteria. On a labelled bench (for example, a cost objection and a price drop is `offer`, a cost objection and a new screen is `hold`), it must find at least 80% of the `offer` cases, which `hold` finds none of, with at most 5% false `offer`s and none on a row the floor should stop. Dev-agent shadow records must also show no surprising offers on review. Judge failures do not count as passes.

Each re-offer says why it is asking now, from a fixed template per reason.

### Real-problem events

Called only from the named sources below. Offer text is a fixed template per kind, and never includes error text.

| Kind | Source, built by this spec unless noted | Threshold | Offers |
|---|---|---|---|
| `address-repeatedly-down` | Counter over `TunnelLifecycle` failures, plus a new Tailscale health probe | 3 outages in 24 h that self-heal didn't resolve | Tailscale, then Cloudflare if Tailscale is already `yes` or this kind already re-offered it |
| `provider-exhausted` | New predicate over `QuotaManager` and `SubscriptionReloginRuntime` | Every enabled door unusable for 30 min, twice in 7 days, so one routine limit doesn't trigger a paid offer | Second subscription |
| `secret-lost` | Boot check: a referenced secret is missing and no vault is set up. CLI restore leaves a marker the server reads at next start | Once found | Bitwarden |
| `state-loss-risk` | Same restore marker, plus an off-machine copy check | Restore finds no off-machine copy | GitHub |
| `voice-unreadable` | Shared wrapper in `VoiceTranscription`. All channels must raise `TranscriptionUnavailableError` rather than plain errors or swallowing it | Once | Voice transcription |

An event re-offers a service only when its choice is `no` or `offered`. A re-offer writes to the ledger only and never changes the choice, so a `no` stands until a confirmed yes.

**Bounds.**

- Each event kind re-offers a given service at most once per cool-off, running 90, 180, then 360 days and staying there. The daily cap applies, and a capped event waits rather than being dropped.
- Spent on delivery. Non-holding machines record events. The lease holder reserves, sends, and marks the allowance spent from the outbound record. After a crash or lease move, the new holder resumes reservations. A crash between send and record can repeat one offer, which is accepted. Undelivered reservations are released after 7 days.
- Signal only: a re-offer never blocks or changes anything else.

**With every door down,** no model can run, and an LLM gate would hold the message. So the `provider-exhausted` offer uses the fixed-template deterministic path from `install-experience.md` section 8, and its confirm page drives the install engine's resumable door steps with no model session. With no address either, the deterministic path first runs Tailscale's install and sign-in link with no model, then door setup. Tested from a Telegram-only install with every door down.

### Surfaces

- `GET /recommended-services`: read only, with choices and backup statuses.
- `POST /recommended-services/:id/no`: authenticated topic tap or dashboard session. A plain bearer token is refused, as PIN unlock returns the master token.
- `POST /recommended-services/:id/confirm`: requires the single-use token and operator proof.
- Dashboard section. `generateClaudeMd` and `CapabilityIndex` entries, with the proactive trigger "the person asks about one of these services".

## Decision points touched

| Decision point | Class | Justification |
|---|---|---|
| May a declined service be offered again for a change or cool-off? | judgment-candidate | Competing signals: the saved reason, what changed, how it is being used. Floor: the code limits in Re-offering. Arbiter: `reofferJudge`. Action space: `offer` or `hold`. Conservative default: `hold`. Fallback ends at the deterministic rung of real-problem events only |
| May a declined service be offered again for a real problem? | invariant | Numeric thresholds and the ladder |
| Did a real issue occur? | invariant | Numeric thresholds over named sources. It only permits an offer |
| Which service does an event offer? | invariant | Fixed order in the table |
| Is a yes valid? | invariant | Authority check: token plus operator proof, or the owner-only button for address services until first proof |
| Is a service in use, or has setup succeeded? | invariant | `verify` result. Unmeasurable means not proven |
| Is a service available? | invariant | Deterministic: recipe proven and obtainable |

## Frontloaded Decisions

- **Jev.** On the list. The operator confirmed on 2026-11-03 that new users can get keys. Its recipe still has to be live-proven before it's available.
- **Email.** On the list, by operator decision on 2026-11-03. Unavailable until its gap spec ships.
- **Re-offering.** Judged within the floor. Operator direction on 2026-11-03. 90 days and one a day are the agent's picks, told to the operator. Reason categories replace free text, which narrows what was told to the operator, and the report says so.
- **Offering a service whose backup is a gap.** Allowed, and the row says what the backup is. The agent still runs without Bitwarden, GitHub or voice. `second-ai-door` keeps the agent going only with a second door, and that gap is first in line.
- **Backup work order.** Local model as last resort, off-machine copy needing no outside account, on-machine voice, email.
- **List timing, the single showing, the re-offer limits and thresholds.** Decided as written. These are user-visible, so changing them later is a deliberate change.
- **Owner-level choice** for this version.
- **Interim proof.** Today's PIN check until `ownerProof` ships. Accepted by the operator on 2026-11-03, with the limit stated to them. The limit is stated in Yes. Offers needing proof do not wait for it.
- **Button approval for address services only,** with the reason in Yes.
- **A rollback limit.** Older code honours a no only where a config key carries it. That covers Git backup, and Cloudflare and Tailscale through their existing settings. For the others, older code simply never offers them.
- **Rollout.** Maturation path: throwaway test agent first, then the development agent, then the fleet after live proof. Owner: Echo, tracked as a commitment until the fleet is on.
- **Kill switch.** `recommendedServices.offers.enabled` stops offers and the judge only. Sticky no and token checks don't depend on it. Events while off are logged and not replayed.

## Multi-machine posture

- **Dependency.** Replication rides the coherence journal, which is dev-gated today, and its explicit-only replication switch. Where either is off, choices stay on one machine, the route says `replicating: false`, and offers do not go live on a multi-machine agent. Turning the journal on for the fleet, or giving this store another path, is a prerequisite of the fleet stage.
- **Choices and evidence:** `unified`. New kind on `ReplicatedRecordEmitter`/`ReplicatedKindRegistry`, modelled on `TopicPinReplicatedStore`, added to the resolved `stateSync` flags as default on, with `rotateKeep: 0`, and registered in the state coherence registry. Evidence is signed by the machine identity and verified per origin, since auth tokens differ between machines. On a single machine the store is in backup `includeFiles`.
- **Merge.** Each yes and no is a separate entry with its own id and record key, so compaction can't drop a no. A yes lists every no it replaces in `supersedes`, computed at confirm time. A `no` that a yes doesn't list wins, so delayed replication and clock skew can't undo a refusal.
- **Offer ledger:** `unified`, same kind, append-only with unique keys. It holds first offers, re-offers, delivery state and the weekly and daily caps, so a new lease holder normally won't resend. There is no handoff fence: a lease move before replication finishes can repeat one offer or briefly exceed a cap. That is accepted, because the harm is one extra message, and it is bounded by the row's limits once replication catches up. The lease holder reserves. The token table is local to the machine serving the page.
- **Offers:** one voice through the lease holder.
- **Verified results, `inUse` and recipes:** per machine. A login or install lives on one disk, and each further machine takes its own confirmation.

machine-local-justification: physical-credential-locality impossible-because="a service login or install exists on one machine's disk and cannot be replicated; an unused token is deliberately local to the machine that minted it" permanence="permanent"

## Detectors

| Detector | Symbol | State claimed | Corroboration | Unmeasurable |
|---|---|---|---|---|
| In use | `verify` result | Works for this person | End-to-end probe: connection over Tailscale, vault read, private repo read-back | Offered |
| Setup done | `verify` result | Works | Same | Not shown as working; person told |
| Re-offer events | Counters and markers | Issue affected this person | Threshold, evidence reference, and service still absent | No re-offer, logged |
| Backup status | Catalog field | Fallback works | Named drill for `exercised`; `specified` claims only that code and specs provide one | Status stays `specified` |

## Self-heal

Re-offers are suggestions, not attention raises. Detecting components keep their self-heal and notices, and re-offer thresholds count only outages self-heal didn't resolve. The public-repo item is a privacy class and is raised on detection, once. The ledger is the audit trail.

## Testing

- **Unit:** a no stays no on both sides of each floor (before and after the cool-off, change entry present, spent and absent, after 3 refusals or 3 ignored re-offers); a judge failure holds and raises a degradation; unchanged inputs aren't re-judged; a version bump alone doesn't count; delayed, concurrent and clock-skewed merges; `inUse` grants nothing; forged token, wrong service, expired or reused token refused; once-per-kind and per-day bounds; allowance spent only on delivery; merge rule; catalog checks; no resend of unanswered rows.
- **Integration:** routes; `DELETE /features/discovery-data` and the evaluator cannot affect these services.
- **E2E lifecycle:** a fresh agent shows the list after a delivered result. A yes is working only after `verify`. A choice survives restart and reaches a second machine.
- **Wiring:** each event source calls `reofferFor`.
- **Failure:** a no to the sole channel and sole address strands nobody; a recipe resumes after restart only with a valid grant; a no arriving during a recipe stops it; legacy declines import before the first list; first-offer crash and lease move at both boundaries; every door down: the offer arrives, and setup resumes with no model. Concurrent events and crashes before and after send.
- **Drills:** one per `specified` row, moving it to `exercised`.
- **Live-user proof:** the list, a yes, a no and one real re-offer, on real surfaces on a throwaway agent, with delivery proven from the outbound record.

## Rollout

1. The ACT-115 owner-check fix and its migration check. Store, replication, routes, sticky rules, evaluator exclusions, and legacy decline import. Offers check a per-owner migration-complete flag before reserving anything. No offers yet. Also two prerequisites: move the door steps and the Tailscale operator step out of the CLI, and add a delivered-first-result trigger, since `install-experience.md` section 8 has no such event in code.
2. Catalog, gap stubs, commitments, dashboard. All services unavailable.
3. Recipes one at a time, each with live proof. Offers go live for new agents with what's proven. `offers.enabled` defaults to false until this step passes on a test agent, then the development agent, then the fleet. Existing agents stay out until step 5, through the migration flag. Before any offer reads the step 1 prerequisites, this step settles four things the review of that groundwork left open. **What counts as a result:** the marker takes the first ordinary reply a platform accepted, which can be a short acknowledgement or a job's status post, so the trigger moves to an explicit result signal, tied to the first tasks where they exist. **The holder's view:** a reply a standby forwards through the origin path never reaches the holder's reply route, and a note through the legacy relay loses its markers, so the holder needs a reliable reading. **Other carriers:** WhatsApp returns no message id and no client reports displaying a reply, so those agents get no first list until each carrier can prove delivery. **Replication:** both values are per machine, which fits none of the allowed machine-local reasons, so they move into the replicated ledger or get an explicit operator decision.
4. Event sources. `reofferJudge` in shadow, and live once its bench and shadow criteria pass.
5. Existing-agent first lists.
6. Drills.

**Rollback.** Older code doesn't know the new ids. It would again offer the two legacy features through their triggers, and honours a no only where config carries it, as stated in Frontloaded Decisions. Stored choices stay and apply again on return. Reversal does not undo anything already set up.

## Maturation plan

- **test-agent-live:** a throwaway agent runs the list, a yes, a no and one real re-offer through real surfaces, with delivery proven from the outbound record.
- **dev-agent-live:** step 3 on the development agent with `offers.enabled` on, after the test agent passes.
- **fleet:** new agents after dev-agent graduation, with replication available on any multi-machine agent. Existing agents follow in rollout step 5.
- **graduation criterion:** two weeks on the development agent with no offer sent against a no outside the floor, every yes reaching `verified` or an honest stated blocker, and no setup message asking the person for anything but a decision or a credential.
- **dark-window:** `offers.enabled` stays false for at most 30 days after step 1 ships, and an attention item raises it for review at day 30.

## Left behind

Accepted as written, one line each:

- No delivered first result means no first list. The dashboard still shows the rows.
- A lease move before replication can repeat one offer.
- Restoring an older backup on a single machine can undo a no.
- `state-loss-risk` fires only after a loss, not before one.
- `principal` in `rotateKeep: 0` records: use an owner id, not personal data.
- Kill switch re-arm: if set false, it raises an attention item after 30 days.
- The fixed-template offer path is a prerequisite in rollout step 1.

## Open questions

*(none)*
