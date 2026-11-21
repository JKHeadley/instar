---
title: "No critical data or work is lost when a machine dies"
slug: "no-data-loss-on-machine-death"
author: "echo"
tier: 3
status: "approved"
eli16-overview: "no-data-loss-on-machine-death.eli16.md"
parent-principle: "An Instar Agent Is Always a Multi-Machine Entity"
sibling-principles: "Close the Loop; Verify the State, Not Its Symbol; Self-Heal Before Notify; Bounded Accumulation; Bounded Notification Surface; No Unbounded Loops; Bounded Blast Radius; Sovereignty; An Instar Agent Always Serves a Team; Judgment Within Floors"
parent-incident: "Post-mortem: the Mac Studio outage of 19–20 November 2026 (document 59c4af4d-1fd2-4885-b0ea-7205b3b1be74, version 8). Approved by the owner: Justin, topic 145840, message 145918, 2026-11-20 10:33 PST: \"The postmortem is approved. We need to start on this work desperately.\""
scope: "Post-mortem issues B1–B12, A5, C1; fix-table items 6, 7, 8, 9, 10, 11, 16, 19; Drill 2"
sibling-project: "Losing any one machine never silences the agent (fix-table items 1–5, 14) and the rebuilt-machine items (12, 13, 15, 17, 18, 20)"
related-specs: "backup-off-machine-copy.md, multi-machine-replicated-store-foundation.md, WS2-SEND-SIDE-EMISSION-SPEC.md, MULTI-MACHINE-SEAMLESSNESS-SPEC.md, native-conversation-any-machine-access.md, STATE-COHERENCE-REGISTRY.md, disk-steward.md, agent-worktree-reaper.md, bounded-accumulation-standard.md, playwright-profile-registry.md, account-machine-matrix.md, skill-driven-signin-repair.md, identity-security-piece2b-owner-record-store.md, lease-job-definition-replication.md, cross-machine-secret-sync-spec.md, machine-self-maintenance.md"
approved: true
approved-by: "Echo (author), self-approval under Approval Only Where Required (2.0 Rule 82): this spec amends neither the constitution nor a CODEOWNERS-protected path. Basis: the owner approved the post-mortem and its fix items (Justin, topic 145840, message 145918, 2026-11-20 10:33 PST: \"The postmortem is approved. We need to start on this work desperately.\"), read after the convergence report. The report discloses that the final external read's four findings were resolved without a further external read."
review-convergence: "2026-11-20T19:52:08.243Z"
review-iterations: 6
review-completed-at: "2026-11-20T19:52:08.243Z"
review-report: "docs/specs/reports/no-data-loss-on-machine-death-convergence.md"
cross-model-review: "codex-cli:gpt-6.2-astra"
single-run-completable: true
frontloaded-decisions: 16
cheap-to-change-tags: 0
contested-then-cleared: 19
---

# No critical data or work is lost when a machine dies

## Problem statement

The owner's standard for an Instar agent on more than one machine has two halves: it never becomes unreachable because one machine went down, and **it never loses critical data or work because one machine went down.** On 19–20 November 2026 the Mac Studio, the lead machine for Echo and Luna, failed a macOS upgrade and was erased. The second half failed:

| Issue | What was lost or nearly lost | Why |
|---|---|---|
| B1 | Hub topic ids (Attention, Updates, Disk, Chief of Staff), the owner's private group, conversation names, notification choices, job history | Recorded only on the lead machine; the fresh lead created duplicate topics |
| B2 | 24 record streams the old Studio wrote, including the Chief of Staff's whole project list | A machine serves only its own records; survivors held copies and never re-served them |
| A5 | The new lead froze twice a minute, rewriting one file 18 times a second | It could not verify documents signed by the machine it replaced, and retried on every tick |
| B3 | Five custom safety hooks and other untracked agent files | Nothing backs up files git does not track |
| B4 | About 3,400 commits on 1,489 branches | Never pushed; survived only because the dead disk was still readable |
| B5 | Luna's browser sign-ins, Google credential files, house-lights session, GitHub login | Existed only on the Studio |
| B6 | Live conversations' working context (session transcripts) | Kept only on the machine running the session |
| B7 | Every Instar backup | Backups sit in the agent folder on the same disk |
| B8 | 375 GB of a 460 GB agent folder was invisible over the rescue cable, so the first inventory missed it | Nothing measures the whole folder before it is needed |
| B9 | Which phones are paired with the agent | Recorded only on the lead machine |
| B10 | Local Verify and green-PR auto-merge settings | Per-machine config; the rebuilt machine merged nothing for about 14 hours |
| B11 | The Instar app's source: recovered only up to build 106; builds 107–117 (about a day and a half of work) are probably gone (the Mini and M5 Pro are still unchecked) | A local git repository with no remote; nothing lists the repositories the agent owns |
| B12 | Echo's signed-in browser profiles | Existed only on the laptop; the rebuilt Studio cannot reach SageMind's Google Drive |
| C1 | The machine itself | Work copies grew to 422 GB; disk warnings were quiet and counted as delivered; nothing checks space before an OS upgrade |

The owner set the bar on B11: "No, I dont track this you do. This is another fundamental Instar failure that needs to be added to the postmortem." (Justin, topic 141385, message 145894), and on approving the post-mortem: "We also need to make absolutely sure that these get saved to Git hub" (topic 145840, message 145918).

**Interim protection today.** Since 11:01 PST on 20 November an hourly launchd job on the Studio (`~/Library/LaunchAgents/ai.instar.offmachine-backup.plist`, running `.claude/scripts/offmachine-backup.sh`) rsyncs every agent folder, minus worktrees, `node_modules` and the shadow install, in plaintext over ssh to the Mac Mini (about 9 GB). A separate sweep is pushing existing unpushed work to GitHub. Both are stopgaps: the rsync copy has no restore test, covers one machine, is unencrypted, and includes machine key material that should not leave its machine. Live session transcripts sit outside the agent folders, so they have **no** off-machine copy today. That gap closes with increment 7's folder backup (which includes the agent's transcript folders), or earlier with transcript checkpoints on 2026-12-02. This spec replaces both and names their retirement (§4.7, §1.6).

### Goals

1. After any one machine of a multi-machine agent is destroyed without warning, everything on the agent's **critical list** (§2) and every commit, branch and agent file is recoverable from the surviving machines **up to its stated recovery point** (below), with no human memory required — and the agent **knows** whether that is true now, before a loss, not after one.

**Recovery points** (the most that an abrupt, unannounced loss may cost, per class). Nothing is reported as protected until a peer has confirmed it holds it.

| Class | Recovery point | Why not zero |
|---|---|---|
| Commits and branches | the homing debounce plus one transfer (minutes) | copying on every write would put git traffic on the hot path; the owner's own bar (item 16) is a day |
| Journal records (Chief of Staff, cards, settings) | one seal interval plus one peer pull | the foundation is pull-based; a synchronous peer write on every record is not proportionate |
| Signed document rows | one document sync cycle | same |
| Agent folder files, uncommitted work | one backup run | whole-folder copying is bulk work on its own lane |
| Browser sign-ins | none lost on a takeover machine whose §7 page check passed; a failed or missing check is reported as "cannot reach X" | — |

The test-agent E2E for each increment includes an **abrupt-loss** case: a throwaway pool whose source is killed without warning mid-write. It checks that what the survivors hold matches what the report said was protected, and that what was lost is within the recovery point.
2. Anything not yet safe is visible: listed in the agent's "lives only here" report (§5), and, once the agent's own repair has failed, a plain Needs-you item.
3. Every guarantee is proven by a drill that destroys something real (§8).

### Non-goals

- Keeping the agent reachable during a loss (items 1–5, 14): the sibling project.
- Items 12 (one-command rebuild), 13 (machine-list learning) and 17 (identity replacement). The post-mortem lists 12 and 13 under this standard; the run brief assigns them to a separate track, and this spec does not depend on them: the drill's rebuild step is the self-contained restore path §8 defines from §1, §2 and §4. When item 12 lands, the drill uses it and must still pass every row.
- A single-machine agent. It gets an honest "everything lives only here" report (§5) and one Needs-you item; `backup-off-machine-copy.md` keeps the no-second-machine case.
- Replacing GitHub.

## What already exists (and what this builds on)

Surveyed on origin/main (v1.3.1942, 2026-11-20).

| Existing piece | What it does | What it lacks here |
|---|---|---|
| WS2 replicated-store foundation (`CoherenceJournal`, `JournalSyncApplier`, `ReplicatedPeerStreamReader`, `PeerPresencePuller`) | Pull replication of about 36 kinds (`JOURNAL_KINDS`: `chief-of-staff-record`, `work-card-record`, `mobile-device-key-ledger-row`, `conversation-graph-event`, `session-transcript-checkpoint`, …). Own streams `state/coherence-journal/<self>.<kind>.jsonl`, replicas `peers/<M>.<kind>.jsonl` | A machine serves **only streams it authored** (`buildServeBatch(kind, fromSeq, ownMachineId)`, JournalSyncApplier.ts:964; foundation §6.1). Entries carry **no per-entry signature**; authenticity is the first hop's mesh envelope. `validateEntry` rejects an entry whose `machine` is not the sender (`:578`) and binds inner origins for `failure-callout-chunk` and `session-transcript-checkpoint` (`:586`, `:589`). An `invalid` entry marks the stream suspect and stops the batch (`:517–525`) |
| Signed documents (`src/documents/`) | Rows machine-signed and hash-chained; any peer syncs rows beyond a vector | Signatures are checked with `identityKeyLookup` (AppRecordSignatures.ts:136) against the local `IdentityStore` key history. A rebuilt machine that never met the departed machine gets `unknown` and re-checks every tick: A5 |
| `IdentityStore`, `revokeMachine` | A removed machine's public key history is kept (`signingKeys[]`, `validUntil`, `revokedAt`; tombstones in `state/identity-epochs.json`) | Not carried to machines that join **after** it left |
| Session transcripts across machines (`native-conversation-any-machine-access.md` §3f; `stateSync.sessionTranscripts`) | Redacted transcript checkpoints copied to every machine | Ships dark (`enabled: false`) until its live date, 2026-12-02 (CMT-047) |
| `conversation-live-tail` | Live tail replicated holder → standby | — |
| Owner record (piece 2b) | Signed entries on every machine, any-peer resupply, per-peer heads in `GET /owner-record` | A check-only row here |
| State coherence registry (`src/data/state-coherence-registry.json`, `scripts/lint-state-registry.js`) | 184 categories with `scope`, `transport`, `paths`, `retention` | No criticality; several critical files unregistered (`agent-*-topic.json`, `chief-of-staff-topic.json`, `job-last-success-*`, `notification-preferences.json`, `mobile-devices.json`); `documents/` registered wrongly as a re-fetchable attachment cache; `config.json` registered whole as `fleet-config` with transport `git`; writes through `StateManager.set(key)` are not matched per key by the lint |
| Cross-machine secret sync | Every `{secret:true}` field reaches every peer encrypted | — |
| Portable job sync (`JobPortableSync`) | Approved portable job definitions travel | Needs a live source; run history not carried |
| `BackupManager` | Allowlisted identity/memory snapshots into `.instar/backups/` | Same disk; no untracked files |
| Disk Steward | Levels; the lease holder posts every machine's disk to the Disk topic with a repeat cadence (24 h at warn, doubling to 7 days) | Posts pass notification selectivity (quiet by default). `DiskStewardPoster.ts:131–135` treats `QuietRecordedError` as `posted`, so a quiet post reset the repeat clock |
| Worktree reapers | `AgentWorktreeReaper` (`<home>/.worktrees/`; default off, live on Echo) and `WorktreeReaper` (`.instar/worktrees/`) remove clean, merged, unused copies; `assertWorktreeCapacity(…, 500)` | No byte or file budget; cannot see unreadable folders |
| Machine self-maintenance | Detects an OS installer running (hold S1) | No disk check before an upgrade |
| Playwright Profile Registry, account × machine matrix, `subscription-signin`, skill-driven sign-in repair | Per-machine profiles; each machine signs in fresh | Registry machine-local and dev-gated ("which machine holds profile X" deferred, ACT-926); the matrix covers Claude and Codex accounts only |
| `backup-off-machine-copy.md` | A stub naming the questions | This spec answers them for an agent with two or more machines |

## Proposed design

Seven parts and one drill. Each part names what it adds, its posture, its repair, what reaches the owner, and how the drill proves it.

### 0. Shared rules

- **The owner hears only when the agent's own repair has failed** (Self-Heal Before Notify; the immediate-escalation class for irreversible loss and security is the one defined in `three-standards-enforcement.md` §304). Every part below has a repair it runs first. A Needs-you item (an Attention Queue item, one voice through the lease holder, closed on cause) is raised only when that repair is exhausted or blocked. The `standards.selfHealBeforeNotify.recoverableLatencyCeiling` (300 s) is measured from exhaustion, not from first detection: ordinary replication lag is not a failure. For single-copy work the grace window is the repair budget: homing runs from the first moment, so work that is still single-copy when the window ends usually means the repair failed. A transfer that is still visibly progressing (bytes acknowledged by the receiver within the last three attempts) holds the notice until it stalls, up to a hard ceiling of 72 hours. The 1-hour at-risk window (a pending OS upgrade, disk errors) keeps its notice even while progressing, because there the owner has a real choice: hold the upgrade.

  Only a **possible forgery** (§3) is raised on the same tick as detection. A machine that goes quiet holding single-copy items is not a loss: until it departs (D10: revoked, or marked absent by the lease holder after 6 hours), its items are a §5 line on the survivors, read from its last replicated report. They are pushed early only if that machine had a risk signal when it went quiet. Once it departs, the survivors first subtract what they can verify they hold themselves (mirror tips, backup receipts, replicated records). They record only the remainder as open debt and tell the owner once, from what was replicated: "up to 4 commits on 2 branches (`fix-x`, `wip-y`) had their only copy on the Studio, which has been unreachable since 14:20". The debt stays open until the machine returns or the owner records it as lost. A laptop that reported going to sleep is given longer than a stopped desktop before it is marked absent (D10), and an ordinary overnight sleep produces no debt notice. Restore-test failures, disk forecasts and missing settings are recoverable failures and follow the heal-first path.
- **Unknown is never healthy.** Every check returns `ok | unsafe | unknown`. `unknown` past the check's window is a defect of its own ("could not check the laptop's repositories for 26 hours").
- **Heavy work stays off the server's main thread and off the source's locks.** Scans, hashing, git reads and transfers run in a background worker with a time and byte budget per run. The source side only reads git (`for-each-ref`, `rev-list`, `bundle create`, `status`), always with `GIT_OPTIONAL_LOCKS=0`, so it never takes a `.git` or `index.lock`. All git writes happen on the receiving mirror, through `SafeGitExecutor`; deletions go through `SafeFsExecutor`.
- **Bulk transfer has its own lane.** Bundles and backup blobs travel on a low-priority, bandwidth-capped, resumable lane over the authenticated machine-to-machine transport, and back off when lease or replication traffic shows strain.
- **Received peer copies live outside the backed-up tree.** Mirrors, backup blobs, generations and the drill quarantine sit under `~/.instar/peer-copies/<agentId>/<sourceMachineId>/`, outside any agent folder, so a copy never gets backed up again (no ping-pong). Disk Steward counts them as "held for other machines" in its whole-disk view.
- **Every new store is registered** in the state coherence registry with a retention class and byte cap (Bounded Accumulation), and every new WS2 kind declares its retention, rate cap and share of `aggregateJournalBudgetBytes` (foundation §8; the per-kind table is in "New record kinds" below). Records replicate **state changes only**: single-copy yes or no, where something is homed, its class, and counts rounded to power-of-two buckets. Exact bytes, file counts and timestamps stay local and are served on read. Each kind keeps the latest record per key and sends one at most once per key every 5 minutes, except a change in the **unsafe** direction (copied → single-copy, present → absent), which goes at once, so survivors can name what a machine held even if it dies inside that window.
- **Owner-only surfaces.** All new routes require the bearer token. Reports that map credentials or sign-ins are owner-only and name credentials by name and category, never by full path.

### 1. The owned-repository registry (items 9 and 16; B4, B11)

**1.1 Ownership.** Each repository found on a machine gets one class:

- **owned** — the agent's own home; a repository created or cloned through Instar's funnels (`SafeGitExecutor`, the worktree managers, the project-app scaffolder) by this agent; or a repository inside this agent's home or listed in its project map that Instar's own funnel log records this agent creating (author strings are shared across agents, so a commit's author name is not proof); or one the owner confirmed.
- **candidate** — found by scan or session evidence but not provably owned (a clone of someone else's project, the owner's personal repository). Listed in the report and homed by **pool mirror only**, which keeps it in the same custody it already has: the owner's own machines that run this agent. It is never pushed to any remote, never given a new remote, and never mirrored when it sits in a team member's scope rather than the owner's, nor to a pool machine that belongs to someone else. There is no standing ask: candidates appear in §5 and on the Data safety card, where the owner can promote one, and reach Needs-you only if the mirror repair fails.
- **Whose scope.** At registration every repository also records the person whose conversation or job created or cloned it, taken from the verified person in the signed team record. When scope cannot be proven (every repository that existed before this spec, at backfill), the repository counts as owner-scoped only while the team record has no non-owner person. Otherwise it stays mirror-only until the owner promotes it. A promotion records whose repository it is: the owner's own, or a member's with that member's signed share. A member's repository without a share never goes to GitHub. Only repositories in the **owner's** scope get remotes or backup refs on GitHub. A repository in a team member's scope is homed by the pool mirror on owner-custody machines only, and §5 says "no GitHub copy: belongs to <member>". The agent may narrow access, never widen it.
- **another agent's** — inside another registered agent's home (`GET /agents`). Skipped: that agent's own registry covers it, so there are no duplicate defects.

**1.2 Record.** One `owned-repo` record per (machine, object store) — a repository and all its worktrees form one record, with the worktrees listed inside it:

```
{ repoId,                 // sha256 of the root commit + home-relative path; a minted uuid for an empty repo
  machineId, path, class, worktrees: [path...],
  remotes: [{ name, host, ownerAccount, visibility: 'private'|'public'|'unknown', collaborators: 'owner-only'|'shared'|'unknown' }],
  home: { mirror: { peers: [machineId...], verifiedAt }, remoteBackup: { remote, verifiedAt } | null },
  singleCopy: { commits, branches, oldestAt },     // commits and branches that exist on no other machine and no remote
  uncommitted: { worktrees, files, bytes, oldestAt } }
```

Only `class`, the homes, single-copy yes or no, and the bucketed counts replicate. Exact counts, bytes and every `oldestAt` stay local and are served on read, and only a change in a replicated field triggers an emit (§0).

**1.3 Discovery.** In order of reliability:

1. *Registration at birth* through Instar's funnels: the main path.
2. *Session evidence*: a repository a session worked in (hook-event working directories and tool paths) becomes a candidate on the next tick. This path would have caught `apps/instar-ios`. Candidates from one session are deduplicated and drained at a bounded rate per tick. Only paths under the user's home or a declared project root (an owner-declared external volume counts) are taken, minus temp and scratchpad roots. A candidate is re-checked to still exist when it is drained. The queue is capped, and overflow is reported as `unknown`. `~/.instar/peer-copies/**` and `~/.instar/drill/**` are never discovered or registered by any of the three paths, including registration at birth through `SafeGitExecutor` (the receiver creates its mirrors through that funnel). Peer mirrors are other machines' copies, not repositories of this machine.
3. *Scan*: a background walk of the agent home, the project-map roots and any declared project root (an owner-declared external volume counts); never the whole home folder or above it. At a repository root it does not walk the tree. It asks git for that repository's untracked directories and its ignored ones, in two queries run in a child process: `git --no-optional-locks ls-files --others --directory` and the same query with `--ignored --exclude-standard`. Git folds an untracked or ignored directory into one entry, so Echo's home returns `apps/`, not `apps/instar-ios/`. For each directory returned, the worker therefore runs a **bounded descent**. It records and stops at any `.git`, whether a directory or a worktree's `.git` file. It prunes paths already known from `git worktree list` and the registry, directories the reaper's classifier calls regenerable (`node_modules`, build output, caches), and `~/.instar/peer-copies` and `~/.instar/drill`. It counts every entry it visits against the run budget and resume cursor. A returned directory not yet fully descended is `unknown`. This finds `apps/instar-ios` (measured on Echo's home: the folded list is 315 entries in 0.02 s) without a 226-million-file walk. It lists worktrees with one `git worktree list` per repository, keeps a durable resume cursor, and has a time budget per run. It reports the age of its last **completed** pass; a root not yet covered is `unknown`, never "no repositories".

**1.4 The rule.** Every commit and every branch of an owned or candidate repository must exist off this machine. Work that exists only here is **single-copy**. It is listed in §5 the moment it exists. It becomes a Needs-you item only if it is still single-copy when the grace window ends (§Defaults: 24 hours by default, shorter when the machine is at risk). The class follows the **verified copy count**, described in plain words as "recorded here" (one copy, this disk) or "copied independently" (verified on another machine or a remote). These are descriptions, not a citation of the multi-machine standard's Amendment 6, which governs conversations only. A repository whose work is all copied independently to a peer mirror but has **no remote** is not single-copy; it is a lesser item whose repair is creating the remote (1.5), and it reaches the owner only if that repair is blocked. Needs-you items are **aggregated**: one row per agent per machine per kind of problem ("312 branches on the laptop have no copy anywhere else, oldest 3 days"), never one row per repository or branch, so first enabling the registry on Echo's 1,489 unpushed branches produces one row, not hundreds.

**1.5 Homing** (continuous, at least daily, debounced after commits):

- **Pool mirror, for every owned and candidate repository.** Once per object store, the source reads its refs in one `for-each-ref`, including `refs/stash`. Reflog entries that git still retains and that no other homed ref reaches, such as an amended commit or a dropped stash, get recovery refs keyed by object id, `refs/instar-mirror/reflog/<ref>/<oid>`, so they do not churn as new entries arrive. They are kept as long as git keeps unreachable reflog entries (`gc.reflogExpireUnreachable`, 30 days by default). Reflog and worktree-head recovery refs are **mirror-only**: they are never pushed to a GitHub backup ref, because amended-away history is where a removed secret lives. It also records every registered worktree's `HEAD` as a recovery ref `refs/instar-mirror/worktree-heads/<worktree>`, so a clean, detached commit that no branch reaches is still homed and its exact object id is verified on the survivor. It asks each mirror peer for its current tips, and sends one incremental `git bundle` of what the peer lacks. Mirrors go to **every** takeover-eligible machine with room, not one: a mirror without worktrees is small, and each extra copy removes a way to lose the work (Amendment 1: losing a machine may cost resources, never information). The peer verifies it (`git bundle verify`) and fetches it into `~/.instar/peer-copies/<agentId>/<sourceMachineId>/mirrors/<repoId>.git` under `refs/instar-mirror/heads/*`. The receiver takes `sourceMachineId` from the authenticated sender, not the payload. It checks `repoId` against a strict pattern, and its mirrors run no hooks (`core.hooksPath` set to an empty directory) and ignore the sender's config. Mirror refs for branches deleted at the source are kept for the retention window, then pruned. The mirror count follows D4.
- **Receivers advertise the capability.** A peer is a mirror or pack receiver only when its advert carries the `ndl-receiver` capability, the same way seals use `sealed-streams`. A peer on an older version or a hotpatched dist shows as "not a mirror peer (older version)" and gets no repair attempts. While no peer has the capability, single-copy items are reported but not escalated.
- **The daily run is a reconcile sweep**, not the copy schedule: copying follows ref changes within minutes; the sweep catches anything the trigger missed.
- **Remote backup refs, for owned repositories, to a remote that passes every test at push time.** The remote, whether the agent created it or the owner did, must be private, owned by the home account or the owner's account (D3), and have no collaborators besides the owner and the agent's own login. When an owned repository's normal remote is **public** (Echo's own home: `JKHeadley/instar`), the backup refs go to a private companion repository `<name>-backup` in the home account, created once under the same rules. This is how B4's 1,489 branches reach GitHub without publishing unreleased work. **GitHub coverage is tracked separately from the mirror.** Every branch of an owned repository that is not on its normal remote is pushed to `refs/instar-backup/<machineId>/<branch>` on the passing remote, whether or not a peer mirror already holds it. A branch that is mirrored but not on GitHub past the grace window is a lesser, recoverable item whose repair is that push. It is not single-copy, but the owner asked for GitHub specifically, so it is not ignored either. These refs sit outside `refs/heads/` and `refs/tags/`, so they create no branch, no pull request, and no Actions run (Actions push triggers match branches and tags only). The tests are re-run on every homing pass. If the remote stops passing (made public, collaborator added), every backup ref on it is deleted and the owner is told once. A backup ref is deleted when its branch reaches the remote normally or is deleted locally. After the retention window it is deleted only if the branch is also verified elsewhere, on the normal remote or a peer mirror. Age alone never removes the only remote copy of a branch that is still live.
- **A credential check before anything leaves for a remote.** Before the first push of a repository to a newly created remote, and before each backup-ref push, the history being sent is scanned with the existing credential patterns. A hit on a high-confidence live-credential pattern (the command guard's literal-credential set) always holds that push: a pushed credential cannot be recalled, and holding fails toward not publishing while the pool mirror keeps the work safe. A hit on a generic, low-confidence pattern goes to a model judgment (live credential, or example, placeholder, fixture). A hit it cannot settle also holds the push. Generic hits from one push are judged in one batched call, with a daily cap; hits over the cap stay held, which is safe while the mirror holds the work. Verdicts are cached by `(file, blob hash)`. Held hits are folded into the aggregated Needs-you row. The owner, or a judgment that a specific `(file, blob hash)` is a known example, clears it for good so it never recurs.
- **Creating a remote for an owned repository with none** (D3): a **private** repository in the home account, with the owner invited as a collaborator (D3), named `<directory name>` (with `-<4 hex of repoId>` added if the name is taken). Creation never adopts an existing repository of the same name. If the agent's host login cannot create in the home account, the pool mirror still homes the work, and the owner gets one ask with a sign-in link (Secret Drop or the sign-in procedure) rather than an approval they cannot act on.

`home.*.verifiedAt` is set only from the receiver's own answer: the mirror peer's tips after the fetch, or `git ls-remote` on the remote. A command's exit code alone never sets it.

**1.5b Who pushes to GitHub.** Any owner-custody machine that holds a verified mirror of a source's repository and whose own host login passes §1.5's tests may push that source's `refs/instar-backup/<sourceMachineId>/*` refs. The source machine is not the only one that can. So a dead machine's mirrored branches still reach GitHub. The host login itself is machine-local-justification: physical-credential-locality.

**1.5a Where the owner's repository decisions live.** Credential-hit clearances, candidate promotions, confirmed ownership and per-repository grace windows are `agent-setting` records under the §2.4 authority rules. Clearing a credential hit needs owner provenance, and model judgment may never clear a high-confidence pattern. A takeover machine therefore never asks the owner again.

When the agent's own session evidence ties a repository to a member's conversation, the Data safety card offers the owner only "member's: needs their share", and shows that evidence.

**1.6 Retiring the interim GitHub sweep.** The interim sweep's results feed the registry as its first data. The sweep is stopped once increment 2 has homed every repository it covered, which the registry shows.

**1.7 Surfaces.** `GET /repos?scope=pool` lists every repository on every machine with its class, homes, single-copy counts and ages. It reads replicated records, so a survivor can list a dead machine's repositories and where their mirrors are.

**1.8 Posture.** `owned-repo` records are replicated, a new WS2 kind. Repository **content** is unified through the mirror and remote: it is not machine-local, so no machine-local marker applies. A working copy is a cache of that content.

**1.9a Drill and test repositories.** Repositories the drill or an E2E plants get a reserved name, `instar-drill-<yyyymm>-<hex>`, and the tag `drill`. They are never invited, and stop counting as owned work when the drill ends. At drill end they are archived, which the `repo` scope allows. Deleting them, and any owner-requested delete under D3, needs the `delete_repo` scope. The agent gets it through its own unattended sign-in procedure, or adds it to the one batched ask, which the run never waits on. Until then each drill report lists its archived repositories by name.

**1.9 Drill proof.** The drill plants a new owned repository with a commit and no remote, an unpushed branch in an existing repository, and a candidate clone. The registry shows all three as single-copy within one scan tick. After homing, all three are in a peer mirror, and the owned one has a private remote. After the wipe and rebuild, all three are restored with identical commit hashes.

### 2. The critical-state list (item 6; B1, B6, B9, B10)

**2.1 Where it is declared.** In the existing state coherence registry, not a new list. Increment 3 first **corrects the census**:

- it registers the missing critical files: `SYSTEM_TOPIC_STATE_KEYS` keys, `job-last-success-*`, `notification-preferences.json`, `mobile-devices.json`, `state/owner-record/`;
- it re-scopes `documents/` as the signed document store;
- it splits `config.json` into agent-scoped and machine-scoped field groups (the registry's own `fleet-config` note already says it is "split-required");
- it requires every `SYSTEM_TOPIC_STATE_KEYS` and other `StateManager` key to be registered, by a lint over the key constants.

Each category then gains a `critical` block:

```
"critical": { "lossClass": "breaks-agent" | "loses-work", "takeoverRequired": bool, "agentScoped": bool,
              "presence": "<named check>", "digest": "<named digest>", "carrier": "<kind | named path | folder-backup>" }
```

**The lint** requires a `critical` decision, or `"critical": null` with a reason, on every category that is not a `derived-cache`. It also requires that every named carrier exists. For files written with raw `fs` rather than through `StateManager`, a **ratchet test** in the throwaway-agent E2E boot walks every file written under `.instar/state/`. It fails on any path that matches no registry `paths` glob. Between the key lint and that walk, a new state file cannot stay critical-but-uncarried silently.

**2.2 The initial list.**

| Category | What | Carrier |
|---|---|---|
| hub-topics | Attention, Updates, Disk, Health, Chief of Staff topic ids | new `agent-setting` kind (singleton rule, 2.4) |
| private-group | The owner's private-group confirmation | `agent-setting` (singleton) |
| telegram-owner | Owner's Telegram id | `agent-setting`, accepted only if it matches the signed owner record |
| owner-record | The owner's signed record | piece 2b exchange (check only) |
| agent-identity | The agent's routing identity | existing adoption from sibling machines (`identityCoherence`, check only) |
| paired-devices | Paired phones and desktop apps | `mobile-device-key-ledger-row` (signed ledger is the authority); names via `agent-setting` |
| merge-settings | Agent-scoped keys of `monitoring.localVerify` and `monitoring.greenPrAutoMerge` (D12 lists them) | `agent-setting` (weakening rule, 2.4) |
| notification-choices | Per-job and per-category push choices | `agent-setting` |
| conversation-names | Conversation names and bindings | Telegram topic names: `telegram-topic-name-record` (2.2b; it follows `topic-name-replication.md`, PR #3591). Other fields: `conversation-graph-event` where it carries the field (built); otherwise `agent-setting` (new kind, increment 4), decided per field by the census |
| cos-records, work-cards | Chief of Staff projects; Work Board cards | existing kinds + §3 relaying |
| documents | Documents and comments | existing document sync + §3a key history |
| live-transcripts (B6) | Session transcripts of live conversations | `session-transcript-checkpoint` (live 2026-12-02, CMT-047); until then and as the floor, the folder backup (§4) |
| job-definitions | Job definitions | portable job sync where portable; folder backup otherwise |
| job-history | Last run and success per job | new `job-run-record` kind (latest only) |
| team, secrets | People and roles; vault secrets | existing (check only) |
| repos, browser-coverage, lives-only-here | §1, §7, §5 | new kinds |

**2.2a More state the rebuild lost** (reported by the run lead on 20 November, after the first draft). Each row says where the state lives, how it reaches every machine, and how the drill proves it.

| State | Lives today | Carrier | Drill proof |
|---|---|---|---|
| Telegram and conversation message history: many topics read empty on the rebuilt Studio, some lost on every machine | `state/telegram-messages.jsonl` (registry: `audit-telegram-messages`, machine-local, transport none) | Re-registered as critical. It is conversation memory, so it goes to every **owner-custody** machine (message bodies are the most private content the agent holds) as a new `message-log-record` kind, built in increment 4. Each machine's stream is its own (author = the recording machine, as foundation §2 requires). Each record is keyed `platform:chat:topic:messageId` and deduplicated on that key across origins, because a lease flap means more than one machine logs the same message. Custody is enforced **at the serving machine**: it serves message tails, snapshots and relayed
segments of this kind only to owner-custody machines (§4.5), even when a member-bound machine advertises the capability, and a test checks each path delivers zero bodies to such a machine. The kind is append-only, with retention taken from the existing registry entry (class A, 32 MiB × 4 segments per machine) and a row in the record-kinds table. The §2.3 check compares each topic's complete retained id sequence across machines, not just whether a topic is empty. Until that kind is live, the floor is the folder backup's critical subset (§4.5). History already lost everywhere is recovered from the rescue copy and backups where it exists (`TELEGRAM-HISTORY-BACKFILL-SPEC.md`); the rest is listed as lost, never silently empty | Each drill topic's complete retained message-id sequence on the rebuilt machine equals the survivors' sequence (after rotation), including a canary with its original id and time; no topic that had history before the wipe reads empty after it |
| Commitment records: November commitments gone, and their `CMT-` ids **reused** by old June records | `state/commitments.json` (must-be-coherent, peer-http) with ids from one machine's counter (`CommitmentTracker.nextId`) | Records: existing commitment replicas plus §3 relaying. **Ids:** identity stays the existing composite `(originMachineId, id)` (CommitmentTracker.ts:402–408), so no migration is needed and two records never merge. The **display** id must not be reused or shared. Each machine reserves a block of display numbers while it is connected, and mints only from its own block, so two machines never issue the same number even in a partition. Blocks are granted **only by the lease holder**, one at a time, serialized locally against the previous allocation high-water mark (one more than the largest of every replica, archive, tombstone and the floor). The holder replicates the advanced mark, and has it durably acknowledged by another current machine, **before** the grant is returned. A grant from a lost holder that never replicated is therefore never reused. A test makes simultaneous requests in one epoch and loses the allocator right after its first grant. A machine that exhausts its block while offline mints with its machine suffix (`CMT-412.m3`), never a bare number. `computeNextId()` today takes the max of the local store only, which is how the June records reused the November ids | On the rebuilt machine every pre-wipe commitment is present; a newly minted commitment gets an id that collides with no existing, archived or tombstoned one; and two machines minting during a simulated partition issue different display ids |
| Vault secrets: the Firebase push key and the APNs key were missing on all five machines | the vault, or files outside it (`.p8` key files) | The `secrets` category gets a **declared list of required secrets per feature** (push needs both keys). The check confirms each named secret is present on every machine. A secret present on one machine only is single-copy. A required secret absent everywhere is a Needs-you item asking the owner to supply it once through Secret Drop. Key files outside the vault are moved into it (§4.1 key-material sort), so secret sync carries them | Every required secret is present on the rebuilt machine, and a planted required test secret that existed only in the vault of the drill machine before the quiet point is restored |
| Context-layer store history | `context-layer-record` streams, rotated (`rotateKeep: 8`) | Live records: the existing kind plus §3 relaying and custodian snapshots. Rotated history: the folder backup, with its archives counted as critical so they are not pruned ahead of the stream's own retention | The rebuilt machine serves the same context layers as before, including at least one rotated archive |
| A second remote-less app repository, `apps/instar-android`, unpushed | inside Echo's home, beside `apps/instar-ios` | §1: the nested-repository descent finds both, and both are homed and given private remotes | Both are planted shapes in the §1.9 canaries. Increment 1's first run on Echo must list both, and is not accepted until it does |
| Per-project autonomous state files and project worktrees | `.instar/autonomous/` (registry: `autonomous-working-artifacts`, coherent-on-demand, transport deferred) and the project worktrees | State files: the folder backup's critical subset, to every machine (they are small and say what work is in flight). Worktrees: §1 homing for commits and §4.2 captures for uncommitted work | An autonomous state file planted before the quiet point is present on the rebuilt machine, and a project worktree's uncommitted change is restored |
| The Apple ID browser sign-in | a browser profile on one machine | §7: the Apple ID is a `followsTheLead` account. Its two-factor step is a person step, batched into the one ask | The Apple ID is signed in on the rebuilt machine, verified by its page check, or listed as the person step it is |

**2.2b Amendment after convergence (census only).** Added 2026-11-21 under CMT-2105, after the `review-convergence` date in the frontmatter, without a further review round. It changes no design in this spec. It names the carrier that already ships for one field of the `conversation-names` row, Telegram topic names, and for everything about that carrier (the record, where it lives, how it replicates) this spec follows `docs/specs/topic-name-replication.md` (PR #3591); where the two differ, that spec governs. The census build (increment 3) lists this kind as the carrier of Telegram topic names and registers the category as critical; it does not wait for `agent-setting`.

| State | Lives today | Carrier | Drill proof |
|---|---|---|---|
| `telegram-topic-name-record`: Telegram topic names and renames. Lost in the outage: 13 project topics read "Name not available" on every surviving machine and were renamed by hand on three machines (ledger N40). A missing name also seeds a wrong session name at spawn, leaves the name out of the message context a session reads, and lets `findOrCreateForumTopic` on another machine create a duplicate topic instead of reusing the one the lead made | The applied name in each machine's `.instar/topic-session-registry.json` (`topicToName`, held in memory by `TelegramAdapter`); the replicated rows in `state/telegram-topic-names.json` (registry category `telegram-topic-names`, `fixed-cardinality`: the winning immutable row per topic, its `emitted` flag and the `filled` bookkeeping) and in the coherence journal's own stream of kind `telegram-topic-name-record` (store key `telegramTopicNames`) | Replicated on the WS2 record path as `topic-name-replication.md` §1–§8 defines: a machine emits a row for each name it learns (creation, rename, Telegram's rename notice), `JournalSyncApplier` pulls peers' streams and the peer-commit observer hands landed rows to the store, one total-order fold picks the winner per topic (rename beats lead beats fill, then time, then Telegram's message id, then event id), and the winner is applied to that machine's map and registry file. Every machine that accepts a peer row as a new winner **carries** the identical row once into its own stream, so a name survives the machine that learned it before §3.3 relaying lands (carrying stays harmless after). Switch `multiMachine.stateSync.telegramTopicNames.enabled` | Every topic name on the rebuilt machine, read from its own `topic-session-registry.json` and `getTopicName` (never from an emit), equals the survivors' winning row, including a topic renamed before the quiet point and one the lead created with the lead now gone; no topic shows "Name not available" on any machine while another machine knows its name |

**2.3 The check.** `GET /critical-state?scope=pool` returns, per category per machine, `present | absent | invalid | unknown`, its digest (cached per category, recomputed on change), and for replicated kinds the **replication lag**: for each author and kind, how many records and how old the oldest record are that no other machine can yet **independently re-serve**. A record counts as protected only up to the highest contiguous seq that a survivor holds together with a verified seal covering it (§3.2), because a peer holding entries without their seal cannot supply them to a rebuilt machine. A seal is reported protected only after a machine **other than its author and other than the lease holder** has durably acknowledged holding that seal hash. Its acknowledgment is the evidence and is carried into any later checkpoint, so the lease holder dying before its own record replicates cannot drop it. When the lease holder counts a seal as protected, it also writes a signed **seal-holding** record ("seal S of origin O held by machine M at time T", a `machine-identity-record` sub-key). Its time T is only the signer's claim, so it counts as pre-revocation evidence in exactly two cases: a current machine **presented** it at revocation, which folds it into the checkpoint's signed set by the same present-and-verify step as seals, or the receiver's own log shows it arrived before the receiver-recorded `revokedAt`. The final checkpoint therefore commits to every seal hash, and its ancestry, that was ever reported protected. A survivor that slept through revocation for more than seven days and returns holding the only bytes of such a seal has them accepted, because they match a hash inside the checkpoint. A seal-holding record signed by the revoked identity that arrives after `revokedAt` is refused, so a stolen key of a departed lease holder cannot backdate one. Held-but-unsealed entries are shown as "held, not yet re-servable". A category present on several machines can still hold a newest record on one machine only, and the lag is what shows it.

The checker runs on every machine at boot and every 15 minutes, and the lease holder aggregates. It settles disagreements **by HLC recency across all reachable peers, never by who holds the lease**. A freshly rebuilt machine that holds the lease is never treated as the truth because it holds the lease. It raises:

- **"The laptop is missing the merge settings"**: absent, invalid or behind on a machine. Repair: re-pull and apply from the carrier, then re-check. Needs-you only if the repair fails.
- **"The newest Chief of Staff records exist only on the Studio"**: replication lag past the grace window. Repair: ask peers to pull; ask the author to re-advertise.
- **Concurrent writes to a high-impact field.** HLC orders every write, but order is not supersession. Each `agent-setting` record carries the version it replaced (the per-origin version vector it observed). A write that did not observe the other is **concurrent**. For ordinary settings the HLC-later concurrent write wins. For singletons and identity-bearing fields both values are kept, and the conflict is a defect naming both machines and values.
- **`takeoverRequired` categories absent on a takeover-eligible machine**: exported to the sibling project's takeover-readiness gate (item 3), which names the category when it refuses.

**2.4 Authority of `agent-setting` records.** `agent-setting` is a WS2 record keyed `<category>:<field>` holding agent-scoped, secret-free content (secrets are named, never inlined).

**A default is never a value.** Only an explicit write emits a record: a funnel call carrying a real change. A machine never emits one for a value it filled in at boot, nor for an absent file. A machine new to the pool, or behind a peer, emits no `agent-setting` record until its §2.5 pull completes. A write whose value equals the schema default and that did **not** observe the non-default value it would replace (per the version vector it carries, 2.3) is held as a defect, not applied. A write that did observe it, such as the owner setting something back to its default, supersedes it normally. A machine knows it is **behind a peer** by comparing its own held seqs per origin with the held seqs its peers advertise. **Muting delays emission and never drops it.** An explicit write made while a machine is muted (a laptop on a plane) goes to a durable **outbox**. It carries the version vector it observed and the HLC stamped at write time, which stays fixed. The outbox keeps one entry per `category:field`, with the latest value and the earliest pending version vector, and counts toward the kind's budget. It is emitted once the pull completes, and the normal 2.3 and 2.4 rules judge it then. Until then the checker treats the local value as `pending-emit`, never as behind, and repair never overwrites it. "Behind" applies only when another current pool member exists, so a sole current member (Luna) is never muted. Sole membership is decided from verified `machine-identity-record`s, and a machine running on restored state counts as new to the pool until a §2.5 pull completes. Migration seeds go through the same outbox. Files written by a §4 restore on a rebuilt machine are not funnel writes and emit no record, and the §2.5 pull supersedes any restored value. This is what stops a rebuilt machine's empty settings from overwriting the survivors' real ones under last-writer-wins, the same harm as the 02:07 hand-back, reached through time order instead of the lease.

Concurrent-write rules are in 2.3. Beyond them, the HLC-later write wins, with three exceptions:

- **Singletons** (hub topics, private group): two values are a defect, never an overwrite.
- **Identity-bearing fields** (owner Telegram id, devices) apply only when they agree with their signed authority: the owner record, the device-key ledger.
- **Weakening a safety floor** (lowering the merge floor, turning off Local Verify status posts or a gate) applies on receiving machines only with **proof the receiver can check** that it came from the owner. The proof must cover the exact change, `(category:field, old → new, record id, expiry)`, and is single-use: every receiver keeps a spent-proof set. The preferred form is the owner's **Approve tap** on a Work Board or app control bound to that change, signed with the owner's device key and checked against the device-key ledger. A dashboard PIN session or a logged owner message is accepted only when the receiver finds it in its **own** received log, or in a second machine's, never only in a log replicated from the writer. A model judgment must also confirm that the message asks for this specific change. Without such proof the write is treated as automated and held as a defect. A weakening with valid owner proof is recorded in the Data safety history, and only a weakening held for lack of proof is pushed to the owner, once.

  **Acceptance survives the proof's expiry.** The first current machine to validate a proof writes an **acceptance record**. It binds the setting version, the proof, and the validation time, and that machine signs it. A machine that joins after the proof expired checks the acceptance record against the proof's validity *at that recorded time*. For a device-key proof it re-verifies the owner's signature itself, so one acceptance record is enough. For a PIN or message proof it needs acceptance records from at least two current machines other than the writer, or from the writer and one other machine when the pool has only two. Otherwise it holds the setting as a defect. When the writer is the lease holder (which usually runs the Telegram poller, so every other machine's message log is a copy of its own), only the device-key tap or a PIN session the receiver itself served counts. A legitimate setting is still accepted; one machine's word alone cannot weaken a floor. A duplicate delivery of the same version is a no-op.

**2.5 Rebuilt machines and singletons.** At boot, a machine whose identity is new to the pool, or whose state is behind any peer's, runs the check against every reachable peer before it announces itself takeover-eligible, whatever its role. Creating an agent-scoped singleton requires every **current** peer to answer "none". Revoked peers, and peers the lease holder has marked absent, are not asked. An unreachable current peer blocks creation. The block's repair budget runs until D10 marks that peer absent, and the 300 s latency ceiling counts from then, so a sleeping peer never pages the owner; the block then becomes a Needs-you item, not a silent stall. Only the lease holder creates a singleton. Before calling Telegram it writes a **committed reservation** (`intent: create hub-topic attention`, with an id). Committed means every current takeover-eligible machine has acknowledged durably holding it, not merely that it was emitted. An unreachable successor delays creation as above. Because an external call already in flight cannot be cancelled, any successor that takes the lease must read open reservations before acting, and the external call carries that id in the topic name's metadata where the platform allows. A test loses the holder while both Telegram's answer and the peer replication are delayed, and asserts that exactly one topic results. After the call it records the result. A reservation with no recorded result after a crash is **uncertain**. The next holder never blindly creates again. It first looks for the topic, by the reserved name in the agent's recent Telegram history, and if it cannot settle the question it raises one Needs-you item. Two concurrent creators are impossible while only the lease holder creates, and the reservation's CAS on the lease epoch covers a hand-over mid-call. Every creation is itself an `agent-setting` record with its creator, so a duplicate made in a split pool shows up as a defect when the pools meet. This is the fix for B1's duplicate topics.

**2.6 Drill proof.** After the rebuild, every critical category on the rebuilt machine is `present` with digests matching the survivors and zero replication lag past the window. Hub topic, private group and paired-device ids equal their pre-wipe values. No new Telegram topic was created and no duplicate notice was sent during the drill window (counted from the Telegram send log). A live drill conversation's transcript is readable on a survivor.

### 3. Survivors re-serve a departed machine's signed records (item 7; B2, A5)

**3.1 Signed rows (documents, owner record, app records): carry the key history.** These rows are signed and relayable already. What failed in A5 was the key. The machine-identity history covers every machine ever registered to the agent, departed ones included: public signing keys, `validUntil`, `revokedAt`. It becomes a replicated `machine-identity-record` kind and is handed over at pairing. A key entry is accepted only if it is **anchored**:

- each new key signs itself (proof of possession), and each rotation is signed by that machine's previous key;
- each admission is signed by the admitting machine, in an unbroken chain back to the pool's first machine, or anchored in the signed owner record;
- when a machine is revoked, the revoker records the **set of machines it had admitted** at that moment, signed by the lease holder. An admission signed by a revoked machine and not in that set is refused, so a stolen key of a dead machine (the Studio was the pool's first machine) cannot backdate a new admission;
- keys added after their machine's `revokedAt` are refused.

Today's history carries no admission signatures (`MachineRegistryEntry`, `IdentitySigningKeyEpoch`). Increment 5's migration anchors it once:

- each live machine countersigns only its **own** live keys;
- a departed machine's key is anchored only if every live machine's pre-migration history holds identical key bytes for it, and at least two machines do where two exist. Anything else is `unanchored-legacy`: it serves signed documents only through a listed, labelled path, never authority-bearing rows;
- the anchor over the resulting set is signed by an owner device key when one is enrolled. Before any owner key exists, which is the case on solo-owner pools today, every live machine countersigns the set. It is then labelled `anchored-by-machines` (on a one-machine pool, `anchored-by-single-machine`, accepted as the weakest label), never treated as owner-anchored, and re-anchored once when the owner enrolls a key. A machine key alone never anchors it.

The retirement checkpoints (3.3) and the signed admitted-set snapshots are carried **inside `machine-identity-record`**. They are replicated to every machine and handed over at pairing, so a later lease holder or a newly admitted machine enforces them too. One compromised peer therefore cannot mint a key history for a departed machine.

Any store whose signature check returns `unknown` **quarantines the row once**, re-checks with backoff when new key history arrives, and raises a defect if it is still unknown after its window. It never re-checks on every tick. That loop, at 18 writes a second, is what froze the new lead in A5, and it is a No Unbounded Loops defect whatever key is missing.

**3.2 Journal streams: author seals.** Each author gives its own streams a hash chain and periodic signed seals:

- each own-stream entry gains `prev`, the hash of the author's previous entry of that kind;
- the author writes a **seal** `{ kind, origin, incarnation, seq, chainHead, sig }` into a separate sidecar stream (`<self>.<kind>.seals.jsonl`), never into the entry stream. It does so only when the chain head has moved, and at most once per seal interval per kind. A serve batch carries the latest existing seal and never creates one;
- the author also signs **snapshot checkpoints** `{ kind, origin, incarnation, seq, chainHead, snapshotDigest }` when it rotates or snapshots a stream (foundation §6.2–6.5). A machine that joins after rotation can then bootstrap from a relayed snapshot.

Seals and `prev` travel only to peers that advertise the `sealed-streams` capability. Peers running an older version receive the stream exactly as today, so a mixed-version pool never sees an entry its shape checks reject.

**3.3 Relaying.** The foundation's §6.1 rule ("a peer serves only what it authored") is amended for sealed segments only (D11). A machine may serve another origin's stream when that origin has departed, or when the requester asks for it by name. It serves the segment up to a seal, with the seal.

Today the receiving side keys everything by the **sending** machine: replica files, sequence bookkeeping, incarnation handling and the downstream observer (JournalSyncApplier.ts:391–536). A relayed record would be filed as the relayer's own, and Chief of Staff records would be credited to the survivor. Increment 6 therefore adds an explicit `origin` to the journal-sync request and serve batch, and keys the apply path by `(origin, kind)`: replica file `peers/<origin>.<kind>.jsonl`, seq and incarnation bookkeeping per origin, and the observer told the true author. `PeerPresencePuller`'s advert gains a `heldOrigins` list (origin, kind, highest **sealed** seq), and a request may name an origin. The receiver:

1. verifies the chain from its last trusted seal, and the seal's signature against the anchored key history (3.1);
2. checks the segment does not pass that origin's **retirement checkpoint**. A checkpoint is made only when a machine is **revoked**. Being marked absent never makes one, so a laptop that slept past the departure threshold and returns with genuine sealed work simply resumes. At revocation, the lease holder asks every current machine to **present** its highest sealed segment for each (origin, kind). It verifies each seal before counting it, so a peer cannot inflate the checkpoint by over-claiming. It then signs a checkpoint at the receiver-recorded revocation time, not the author's own timestamp. The checkpoint stays **provisional** until every current machine has answered or 7 days pass. During that window a segment past the highest verified presented seal is **held**, not applied. A receiver admitted after the revocation uses the checkpoint's signed set of presented seals as its log. Otherwise it is released only when the receiver's own advert log shows a current machine advertising that seal before the recorded revocation time. Otherwise it becomes a defect when the checkpoint is final. Every machine also refuses journal pulls from the revoked identity itself after `revokedAt`. A survivor that was asleep at revocation therefore loses nothing; its tail is only delayed. Once final, nothing past the checkpoint is accepted: a stolen departed key can neither extend history nor backdate it;
3. applies the segment through the existing `validateEntry` path. The sender-binding rule (`:578`) and the inner-origin bindings for `failure-callout-chunk` and `session-transcript-checkpoint` (`:586`, `:589`) are amended to accept a non-author sender only inside a verified sealed segment.

The unsealed tail (at most one seal interval) is not relayed. The report says plainly what could not be verified: "the last 40 seconds of the Studio's Chief of Staff records could not be verified".

**Forks.** Two different sealed segments with the same `(origin, kind, incarnation, seq)` are treated as a possible forgery: application stops past the fork, and the owner is told on the same tick. A difference **across** incarnations is the ordinary restart-and-rewind case, and it goes through the existing incarnation handling (`handleIncarnationFlip`).

**3.4 Streams written before seals existed** (the 24 streams of B2 are of this kind). A survivor may offer a departed origin's pre-seal segment as **attested**: it signs "I received this from M over an authenticated hop at time T". Survivors usually hold replicas of different lengths, so agreement is judged **per seq**. The receiver applies the prefix that every holder of those seqs agrees on. Any seq where two holders' content differs is a defect, and nothing from that seq on is applied. A tail held by only one survivor is applied with an `attested-by-single` label and never counts as verified. Attested segments carry their label in the store's reads. Two limits:

- an authority-bearing kind (device-key ledger rows, trust grants, owner-record entries, `machine-identity-record`) is **never** taken from attestation, because one survivor must not be able to speak for a departed machine on who may act;
- the path is closed for any segment written after the author advertised `sealed-streams`.

**3.5 Bounds.** A departed origin is advertised until every current machine holds its segments up to the checkpoint. While any of its records is still **current**, every survivor keeps and advertises a recoverable form of it: a Chief of Staff project still open, or a card still on the board, counts as current. The recoverable form is a snapshot checkpoint the author signed, or failing that a snapshot the lease holder builds and signs as a `custodian-snapshot`, applied with the attested label. It is pinned out of the foundation's snapshot-cache eviction (§8.2) and out of ordinary retention. So a machine that joins after rotation and eviction still gets the dead author's live projects. Only once none of its records is current do its files fall under the kind's normal retention. The key history of a departed machine is a few hundred bytes and is kept. Drill identities are revoked when each drill ends (§8), so at most one is added per month.

**3.6 Drill proof.** The drill machine writes a canary record of each critical WS2 kind and a canary document before the wipe, and it comes back with a new identity. Every canary reaches it from a survivor and verifies: by seal for journal kinds, and by anchored key history for the document. Its log shows no verification-retry loop. After the drill, its old identity's retirement checkpoint exists, and a planted record past that checkpoint is refused.

### 4. Off-machine backup of every agent folder (item 8; B3, B6, B7)

**4.1 What is copied.** The whole agent folder, including files git does not track, minus a code-owned exclusion list. Each exclusion carries its reason:

- *regenerable*: `node_modules/**`, `.instar/shadow-install/**`, build output, caches, logs past their retention window;
- *carried elsewhere*: worktree checkouts under `.instar/worktrees/**` and `.worktrees/**` (their commits are homed by §1; their uncommitted work is captured as a patch, 4.2);
- *bound to this machine by design*: the machine-scoped entries of `KEY_MATERIAL_PATHS` (the machine signing and encryption keys under `machine/`, `local-state/`). A rebuilt machine gets a new identity, and copying a private key off its machine only spreads it. Agent-scoped entries of `KEY_MATERIAL_PATHS` (`identity.json`, `threadline/inbox-hmac.key`, `threadline/invitation-secret.key`, `secure-invitations.json`, `remediation-keys.age`, `state/.manifest-key`, and the rest) are each assigned in increment 7. An entry with a carrier (agent identity adoption, secret sync, owner-record resupply) is excluded and gets a check-only row in §2. An entry without a carrier is moved into the vault, and secret sync then carries it. Until it is, §5 lists it as single-copy;
- *signed in per machine*: browser profiles (§7).

The agent's own transcript folders (`~/.claude/projects/<agent home>/`, the Codex sessions for the agent) are included, within their existing retention (B6, until and alongside transcript checkpoints). Symlinks are stored as links and never followed.

**4.2 Uncommitted work in every registered checkout.** On each backup run, every checkout in the §1 registry with uncommitted changes, including worktrees and checkouts outside the agent folder, contributes a **work-in-progress capture**: a binary diff of staged and unstaged changes, untracked files, and **ignored files the reaper's existing classifier treats as work**. Only ignored files it classifies as regenerable (build output, `node_modules`, caches) are left out, so a hand-written ignored file is captured. A capture counts only once the receiving peer returns a **receipt** that binds the base commit and the capture digest to bytes it has verified. A capture cut off before that receipt never makes a checkout eligible for removal. Captures go through the same change index and packs (4.3), so an unchanged large file is not stored again. A capture has a cheap test of its own: the patch applies cleanly to the mirrored base commit in a scratch index, and the captured files' hashes match. This is what makes §6's pressure rule satisfiable without waiting for the weekly restore test.

**4.3 How.** Changes are found from a persistent local index keyed on `(device, inode, size, mtime_ns, ctime)`, so only changed files are read and hashed. Each run has a budget for bytes hashed and files checked, and it resumes where it stopped. Manifests are stored as deltas against the parent generation. Content goes into bounded pack files, not one stored file per source file, so the receiver does not inherit millions of small files. SQLite databases are copied from a consistent snapshot (the online backup API), never as a live file. Transfer uses the bulk lane (§0).

**4.4 Keys.** Each generation has its own data key. That key is wrapped to the encryption public key of every current **owner-custody** pool machine (envelope encryption, §4.5), so any survivor can decrypt it with only its own key: no source vault and no secret sync needed. When a machine is revoked, new generations stop wrapping to it, and the retained generations are re-wrapped without it. When a machine is **admitted** to the pool, including a rebuilt machine with a fresh identity, the holders re-wrap every retained generation's data key to its encryption public key. Admission is already the trust boundary for secret sync, so this widens nothing. Without that step, a rebuilt machine could not decrypt the very backups it must restore from, because its old private key was deliberately never copied (4.1). This protects the copy against someone holding the peer's disk without a pool machine's key. It does **not** protect against a pool machine itself, which the spec says plainly. It also cannot undo copies a revoked machine already read.

**4.5 Placement and count.** One **custody rule** gates four things: mirror placement (§1.5), backup placement, key wrapping, and re-wrap on admission (4.4). Each is allowed only to an **owner-custody machine**. Today's signed team record (`TeamAccessState`, TeamAccessLog.ts) maps no machine to a person, and team access is off by default, so the rule is defined against data that exists: **every admitted pool machine of the agent is owner-custody unless an owner-signed binding ties it to a non-owner person**. The binding is a new `machine-person` event in the team access log, signed by the owner like every other team event. It ships in **increment 2, before any mirror is sent**. Custody is settled **at admission**. With team access off, every pool machine counts. With team access on, a newly admitted machine receives no mirror, pack or key envelope until its custody is recorded either way. Existing machines are classified by increment 2's migration before mirroring is enabled. A machine bound to a team member gets no mirror, no pack and no key envelope, and §5 says so. The claim "admission widens nothing" holds only under this rule.

Two sets, for two kinds of content:

- **The critical subset goes to every takeover-eligible machine.** This is what the agent *knows and is*: identity documents (`AGENT.md`, `USER.md`, `MEMORY.md`, `soul.md`), custom hooks, custom skills and scripts, `jobs.json`, and every critical-state file without a WS2 carrier. It is typically a few megabytes. The standard says losing a machine may cost resources but never information, so this set is held as widely as the critical list.
- **The whole folder goes to D4's count of peers.** These are work products and bulk files: databases that can be rebuilt from their sources, transcripts, logs and attachments. The lease holder chooses the peers from takeover-eligible machines with room. A backup never pushes a receiver below its disk floor, and its packs count against that receiver's file headroom. Two machines give one copy; three or more give two. The basis for the count is resources: a full folder runs to tens of gigabytes, and every copy competes with work copies for the disk that C1 filled.

The words "recorded here" and "copied independently" are used in this spec as plain descriptions. This spec does not rely on the multi-machine standard's Amendment 6, which governs conversations only.

**4.6 Restore tests. "Protected" means one thing everywhere** (§4, §5, §6.1, Defaults): a generation that passed its **receipt verification**. On receipt the receiver checks the disk floor, unwraps the data key with its own key, and checks every pack hash. Because generations are deltas and the receiver can change from one run to the next, the receipt also requires the receiver to hold **the whole chain**: every manifest, pack and usable key envelope that generation needs back to a full manifest. A new receiver first gets a full generation. It then restores only the SQLite and critical-state files changed since the parent generation into a private scratch folder, and checks them. The recovery point for folder files is stated as **complete through**: the start time of the first run whose scan produced the newest protected generation, because a file changed just after the scanner passed it is only as new as that start. A live scan can also *miss* a file moved from an unvisited directory into a visited one, so before a generation is offered for receipt the scanner **reconciles**. It re-stats every scanned directory, and any directory whose mtime or ctime changed **since the previous pass** (a move into it changes both) is scanned again. This repeats until a pass finds no directory changed since the pass before, within the run budget. Comparing passes, not the original start time, lets one rename followed by quiet settle at once. A test makes one mid-scan rename, then goes quiet, and checks that a receipt is issued and the moved file restores. On macOS the FSEvents history since the scan start is used as a hint for which directories to recheck; a dropped-events flag forces the full re-stat. If the scan does not settle within the budget, no receipt is issued and the next run continues. A generation's age is never used for it, and §5 shows the complete-through time. A test changes a file behind the scan cursor, then loses the source, and checks the reported time.

Weekly, and on demand (the drill pre-flight asks for one), the **deep test** runs. It gates the drill. If it fails, every generation since the last passing deep test loses its protected status. Steps that cannot be undone, such as §4.7's deletions and the real wipe, wait for a **passing deep test of a generation that still exists**. Garbage collection and the byte cap never prune the newest deep-test-passed generation or the chain it needs. If the cap would force it out, the existing Needs-you item is raised instead. The receiver verifies the newest generation using only its own key. It checks that every pack hash verifies while streaming. It also fully restores the SQLite files and every critical-state file into a private scratch folder (0700, deleted after), opens each database with `PRAGMA integrity_check`, parses each critical file, and compares a random sample of unchanged files byte for byte. Before restoring, it checks the disk floor. Nothing in the scratch folder is ever started. Every restored path is contained in the target folder: a path with `..`, an absolute path, or one that would resolve through a symlink restored earlier in the same run is refused. Links are restored last and never followed. A generation counts toward "protected" only after its restore test passes.

**Garbage collection.** Generations are deltas against their parents, so retention never deletes a manifest, pack or key envelope that a retained generation still reaches. Before a parent is pruned, its children are compacted into a full manifest. After each collection, the **oldest** retained generation is restore-tested.

**4.7 Retiring the interim rsync job, per agent.** The job copies every Studio agent folder, so it is retired agent by agent, never wholesale. At the start of increment 7 the script is changed to exclude machine-scoped `KEY_MATERIAL_PATHS` for **every** agent, never using any `--delete`, so no agent's machine keys keep being copied while it waits. Then, for each agent, once its own new backup has a generation that passed a deep test:

1. **Stop first.** The backup job writes a plain marker file `interim-retired` into that agent's own folder on the Studio. The script reads it locally, a bash script reading a file, skips the agent, and writes a stop receipt into its log;
2. **Delete second.** A Studio-side instance (Echo's, which holds the script's log) reads the stop receipt and records it as `interim-retired-ack:<agent>`, a replicated `agent-setting` sub-key. Only after that record, whichever instance of the agent can reach the Mini deletes the exact listed paths under `offmachine-backups/mac-studio/<agent>/` through `SafeFsExecutor`. That is the Mini's own instance where one exists, or the Studio's instance over ssh where it does not. It then checks the paths are gone and records the deletion (`interim-deletion:<agent>`). A test checks that a run firing between the two phases never re-creates the folder;
3. once no agent remains, the plist is unloaded and removed, along with the script.

An agent with no second pool machine of its own (Luna today, post-mortem A6) never gets a pool-placed generation, so its interim rsync copy is **kept**, with two changes made by increment 7:

- the rsync excludes that agent's machine-scoped key material (`KEY_MATERIAL_PATHS`) and **never** uses any `--delete` option. On this host `rsync` is openrsync, whose `--delete-excluded` does nothing without `--delete`, and `--delete` would wipe Luna's only off-machine copy the next time her Studio folder is empty, as it was on 20 November;
- the key material already on the Mini is removed once, by its exact listed paths. The removal is recorded and logged, and the paths are verified absent afterwards. A test checks that a source folder emptied before a run leaves the Mini copy intact.

The copy stays plaintext, and §5 says so plainly: "Luna's copy on the Mini is unencrypted and not restore-tested". It lasts until Luna gains a second machine or `backup-off-machine-copy.md`'s single-machine case lands. No conversion to encrypted packs is attempted, because no instance of Luna runs on the Mini to do it, and Luna's own machine key lives only on the Studio.

**4.8 Posture.** Generation indexes are replicated (a `backup-generation` kind), so any survivor knows where the dead machine's newest restorable copy is. The packs are placed per 4.5. The change index (4.3) is machine-local-justification: hardware-bound-resource. It is keyed on one disk's device and inode numbers, and it is rebuilt from scratch on a new disk.

**4.9 Drill proof.** The drill plants an untracked file, an uncommitted change in a worktree, and a hand-written ignored file. Then it creates a generation and restore-tests that exact generation. After the wipe, the **rebuilt identity itself** decrypts and restores the folder from it. The planted files, every custom hook, and the worktree change are present and byte-equal.

### 5. The "lives only here" report (item 10; B5, B8)

**What it is.** For each agent and each machine: everything whose only copy is on that machine right now, whatever its age. The grace window only decides when an item reaches the owner. Lines:

- single-copy commits and branches, and repositories with no remote (§1);
- critical categories present only here or with replication lag (§2);
- files changed since the newest **protected (receipt-verified)** generation (§4), from the backup index (no second walk);
- uncommitted work not yet in a work-in-progress capture;
- accounts and browser profiles signed in only here (§7);
- credential files not in the vault, and agent-scoped key material without a carrier (§4.1);
- **the folder's true size (B8)**: total bytes and files, including hidden, excluded and unreadable content, from the backup index plus a `statfs` and §6.1's cached per-copy counts (no fresh walk; a stale count reads `unknown`), with the excluded and unreadable shares named ("460 GB, of which 375 GB is work copies and 2 GB could not be read"). Unreadable is reported as unreadable, never as zero.

**Surfaces.** `GET /lives-only-here?scope=pool`. Each machine's latest report is also **replicated** (a `lives-only-here` kind). It carries summary rows plus the **identities** of single-copy items, capped at 200: the 100 newest plus the 100 oldest, with the full count in the summary row. At-once sends are coalesced per key over 30 seconds, and a new tip on a branch that is already single-copy is an ordinary update. Identities are kept for commits and branches (repository, branch, tip commit id), critical categories, accounts and credential names. Changed files and uncommitted work replicate only as bucketed counts with the oldest age bucket, never as file paths, so constant file churn cannot crowd out the identities that matter. After a machine dies, the survivors report its **last peer-confirmed** report: "at 14:20 the Studio held the only copies of …". Any later interval is stated as unknown: "anything written on the Studio after 14:20 is unknown". Survivors never claim detail they did not receive. The report appears on a **Data safety** card on the machine care page, together with repositories, critical-state coverage, backup generations and drill history.

**Rebuild runbook.** The lease holder generates one runbook document per agent from the report (`POST /docs`, owner-only). It is refreshed weekly and before a planned restart or upgrade, and says what this agent needs on a new machine, in order, and which steps are automatic. For Luna the lease holder of Luna's pool generates hers. Luna has one machine pool member today (no failover, post- mortem A6), so her report reads "everything lives only here". That is the single-machine case, and it is stated rather than hidden. Item 10's wish that Luna own her runbook is met because her own agent's lease holder writes it.

**Drill proof.** The drill pre-flight refuses while any single-copy line or any `unknown` line exists for the drill machine. After the rebuild, nothing that was present before is missing unless the pre-wipe report listed it.

### 6. Bounded work copies, pushed disk warnings, an upgrade guard (item 11; C1)

**6.1 Work-copy budget.** This part builds on the reaper work in flight on 20 November: open PRs
#3490 (worktree removal in a background process, hourly), #3493 (recognising a regenerable
`node_modules`) and #3517 (registry copy proof without `git hash-object`). Increment 9 rebases on whichever of them have merged and does not re-implement them. Pressure mode's cadence and removals per pass are derived from how far over budget the machine is (enough per pass to reach the budget within a day), not the existing fixed 20 per daily pass.

Work copies (`.instar/worktrees/` under `WorktreeReaper`, `.worktrees/` under `AgentWorktreeReaper`, and their build trees) get a budget per agent per machine, in bytes and files. The budget is the headroom that keeps the machine above Disk Steward's warn line with all other use unchanged, split across agents by recent use. File counts come from cached per-copy counts that are refreshed rarely, plus the volume's own counts. A stale count is `unknown`, never zero. Over budget:

1. **pressure mode** for both reapers. It removes their existing clean-merged-unused set first, then copies that are unused (by the reaper's existing in-use test, with its race re-check), whose commits §1 has verified homed, and whose every non-regenerable file matches a tested work-in-progress capture **at removal time**. A `git worktree lock` guards only git's own bookkeeping, not an editor's save. So the reaper first confirms that no process has the copy open (its existing in-use test). It then **renames the copy aside** on the same volume, which is atomic, into a quarantine. It runs the in-use test again on the quarantine path, including open descriptors and working directories (`lsof +D`). It compares the renamed tree's hashes against §4.2's tested capture, and deletes it only on a match. The quarantine path is new and known to no other process, so once that last check shows no holder, no new writer can reach the files. A pre-existing descriptor is exactly what the check catches. A test holds a descriptor open across the rename and asserts the copy is kept. If anything appeared at the old path after the rename (an editor saving into it), or the hashes differ, the copy is renamed back and kept. A dirty copy that cannot pass this is never removed. When pressure mode starts it asks for fresh captures of the candidate copies, so it does not have to wait for the weekly restore test. A copy that fails any of these is never removed;
2. new worktree creation is **deferred** with a plain one-line reason until usage is back under budget;
3. bytes neither reaper can read are reported as "cannot see".

The 500-count ceiling stays as the outer limit.

**6.2 Disk warnings reach a person.**

- Disk Steward's categories are exempt from quiet-by-default in notification selectivity (D13). An explicit owner choice to quiet them stays, and the next Disk post shows that choice.
- Only a **person-reachable delivery** resets the repeat clock or advances the doubling backoff: a push Telegram accepted, a Needs-you item, or an app delivery. `DiskStewardPoster` records a quiet result as `not-delivered`, not `posted`.
- The daily summary of quiet notices runs on any day a disk post was quiet.

**6.3 Upgrade guard.** Instar runs as the user and cannot stop Apple's installer, so it does three things:

1. **Instar's own updates** are refused below the update floor, unless the update fixes a data-loss or security defect. A Needs-you item names what to clear.
2. **A pending OS upgrade** (the notice includes the current single-copy count) is detected from user-readable update state (`softwareupdate --list`, a downloaded installer app, a staged update). On a machine below the OS-upgrade floor, it raises a pushed notice before the upgrade ("Don't install the macOS upgrade on the Studio yet: it has 64 GB free and needs at least 120 GB. I'm clearing work copies now.") and starts pressure mode.
3. **An OS installer starting** (hold S1) below the floor triggers an immediate fresh generation (§4) and a homing pass (§1) for that machine. A pushed notice goes at once, with the current single-copy count, rather than waiting for the 1-hour at-risk window.

**6.4 Drill proof.** The drill fills the work-copy area past budget with synthetic worktrees. It checks that creation is deferred, that the reapers get back under budget without touching a copy with unhomed commits or an uncaptured change, and that a disk post reached the Disk topic as a push. It plants a fake pending-upgrade marker below the floor and checks for the notice, the generation and the homing pass.

### 7. Signed-in browser profiles on every takeover-eligible machine (item 19; B12, B5)

**7.1 Which accounts.** Accounts in the Playwright Profile Registry marked `followsTheLead`. Default: every registry account a job or skill used in the last 30 days. The owner can add an account or take one off.

**7.2 The rule.** Every takeover-eligible machine holds a signed-in profile for every `followsTheLead` account. Profiles are never copied: cookies and passkeys are bound to one browser on one machine. Each machine signs in on its own through the account sign-in procedure (the `subscription-signin` skill: Google-account profiles, normal-browser sign-in), driven by skill-driven sign-in repair.

**7.3 Coverage.** The account × machine matrix gains browser-profile accounts as rows. Each cell is `signed-in | needs-sign-in | not-required | unknown`, with when it was checked. Cells are replicated as `browser-coverage` records, which closes ACT-926. A cell reads `signed-in` only when the account's identity (email or name) was read from the account's own page in that profile.

**7.4 Repair.** Missing or expired cells run the procedure unattended where possible (10 of 14 accounts could, in the rebuild). Cells that need the person (a passkey, a code on their phone, a CAPTCHA the agent cannot pass) are **batched into one ask**, outside the owner's quiet hours, and it names each account and machine. A takeover-eligible machine with a `needs-sign-in` cell is reported to the sibling readiness gate as "can take over, but cannot reach X".

**7.5 Drill proof.** After the rebuild, every `followsTheLead` account that can be signed in unattended is `signed-in` on the rebuilt machine, verified on the page. The rest (passkeys, phone codes) are listed in one batched ask that the drill does not wait for. The drill counts and lists each person-needed step with its reason. The target is zero, and a count above the previous drill's is a defect.

For an account whose pages show no identity, such as a house-lights session, the registry entry names a **signed-in page check**: a page or element only a signed-in session reaches. That check stands in for the identity read.

### 8. The monthly wipe-and-rebuild drill (post-mortem Drill 2; the acceptance test)

**8.1 Who and where.** A scheduled job of the lease holder takes a **drill lock**, a replicated record with a single owner. Another drill cannot start while the lock is held, and the drill aborts cleanly if the lock owner changes or the drill machine gains the lease. The drill machine is chosen each month (D6).

**8.1a Supervision.** Tier 1 supervision (an LLM checks the result, per LLM-Supervised Execution) covers every stage of the drill, the daily reconcile sweep, any repair that reaches its brake or breaker, and the low-confidence credential judgment. The per-change homing copies are deterministic. They are checked by comparing the receiver's tips with the local ones, and the LLM is called only when that check fails. This keeps token use low, which the owner ranks above gate strictness.

**8.2 The drill role.** The drill-role instance **refuses every source whose authenticated machine id is the drill machine's live identity**, and it records which machine served each restored item. R0 fails if any item came from the drill machine. Copies are counted per **physical machine** (a hardware id read live from the platform at each boot, IOPlatformUUID on macOS, `/etc/machine-id` or the DMI product UUID on Linux, never copied from stored state; two identities reporting the same id count as one machine), never per identity. So a drill identity is never counted as a copy holder by §1.4, §2.3 or §4.5, and is never chosen as a mirror or backup peer. After the quiet point the live instance writes a **journal canary** that is never replicated; it must be absent from the rebuild.

Before revoking the drill identity, the drill checks that every current pool machine lists it and then lists it as revoked (`GET /pool` on each), so the drill never leaves a split pool behind. The machine being rebuilt joins the pool with a fresh identity in a **drill role**. It pulls everything, so it can be checked. It never holds or claims the lease and never creates a singleton. It runs no scheduler, tunnel or Threadline relay connection. Every messaging adapter is off: Telegram, Slack, WhatsApp, iMessage, email and app push. Its boot refuses to start if any of them is enabled. The records it emits are tagged `drill` and tombstoned at the end. When the drill ends, its identity is revoked.

**8.3 Stages.**

1. **Pre-flight**, which refuses on any failure.
   - The drill machine is not the lease holder, and another takeover-eligible machine is healthy.
   - The drill plants its canaries (§1.9, §3.6, §4.9, a live drill conversation).
   - Then it reaches a **quiet point**. It pauses that agent's sessions and jobs on the drill machine (each is told why, and they resume afterwards), runs a homing pass and a scan of the registered roots, takes the final generation, and restore-tests it on demand, waiting a bounded time for the result. A live machine is never quiet, so the §5 test is judged against that frozen generation, not against a running agent.
   - **Real-wipe rule.** At the quiet point §5 must show no single-copy line and no `unknown` line for the drill machine. One exception: items of the `known-unprovable` class are accepted when they are listed by name in the drill report. Only the keychain-source detector may assign that class, and only to items the wipe does not touch. A real wipe refuses on anything else.
   - **Rehearsal rule** (rehearsals touch nothing). Refuse on repository, critical-state, file and uncommitted-work lines, including the planted canaries, which is what R5 checks. Accept, when listed by name, browser accounts that need a person and `known-unprovable` items. Run the quiet-point scan to completion within the 2-hour pre-flight wait, and list any root still `unknown` rather than refusing on it.
   - **Other machines' copies on the drill machine.** The drill machine also holds packs and mirrors for other sources under `~/.instar/peer-copies/`, and the key that decrypts them is in its agent folder, which a real wipe quarantines. So the real-wipe pre-flight refuses while any other source's only protected generation, or only mirror, lives on the drill machine. In that case it first places a copy on another receiver, or with a two-machine pool it runs a rehearsal only. After the rebuild, the quarantine is not deleted until the replacement identity has had every retained peer-copy generation re-wrapped to it and has decrypted and verified each one. A test takes that other source offline and restores from the rebuilt machine.
   - The target of a rehearsal or rebuild must pass the §4.6 disk-floor check. Repositories the drill did not plant are restored as bare or sparse clones.
2. **Rehearsal** (the first three months, and after any failure). The rebuild goes into a scratch home (`~/.instar/drill/<agent>`) on the drill machine in the drill role, with its own port, tmux prefix, launchd label and config home (its own `CLAUDE_CONFIG_DIR` / Codex home). It runs under a macOS sandbox profile (`sandbox-exec`) that denies reads of the real agent home, the agent's browser profiles and `~/.instar/peer-copies/…/drill-quarantine/`. The restore can therefore only read from survivors over the network. A **canary** planted only in the real home must be absent from the rebuild, or the rehearsal fails as not isolated. On Linux the same profile is a separate user namespace with the real home unmounted.
3. **Real wipe** (after three passing rehearsals in a row, **and** once the sibling track's item 17 (a rebuilt machine replaces its old identity on every pool machine) and item 13 (a new machine learns the whole machine list from any one member) are live — the pre-flight checks both through `GET /capabilities`. Without them a real wipe would recreate the A9 split pool on purpose.) Everything §5 attributes to this agent on this machine moves to a quarantine under `~/.instar/peer-copies/…/drill-quarantine/`: the agent folder, its browser profiles and its credential files. The quarantine is 0700, is outside discovery and the backup walk, and is deleted through `SafeFsExecutor` with the deletion recorded. It is deleted after 7 days, or at once if the disk floor requires, but only if the drill passed. Then the rebuild runs in the drill role, and on a pass the machine re-joins in its normal role.
4. **Rebuild.** The rebuild is a restore that needs nothing from the drill machine: a fresh `instar` install and join, then §4 restore of the newest tested generation, §1 mirror clones, §2 pull, and §7 sign-ins. Item 12's command replaces this step when it exists.
5. **Checks**, using the acceptance table.
6. **Report**: a document giving each row's result and evidence, how long the rebuild took, and every step that needed a person. A failed row opens a Needs-you item, and the next drill goes back to rehearsal.

**Honest limit.** The drill does not remove keychain items, so it cannot prove a credential that lives only in the keychain. §5 lists those as `known-unprovable`, and each drill report names them.

**8.4 Acceptance table.**

| # | Requirement | Passes when |
|---|---|---|
| R1 | Owned repositories (§1) | The three planted repositories and a clean detached worktree `HEAD` showed as single-copy, were homed, and were restored with identical hashes; the owned one gained a private remote, and its expected commit was fetched back from GitHub |
| R2a | Normal takeover path (§2.5) | In the throwaway-pool E2E with a recording Telegram adapter: the original topic ids were seeded, a creation was interrupted after Telegram had succeeded, and recovery issued no second create and no duplicate send. The drill role cannot test this because it never creates singletons, so this row is the proof for B1 |
| R2b | More rebuild-lost state (§2.2a) | Message history canary readable; no previously non-empty topic empty; every commitment present and a new id unique pool-wide; every required secret present; context layers including a rotated archive served; the autonomous state file present |
| R2 | Critical state (§2) | Every critical category is present with matching digest and no lag; the same hub-topic, private-group and device ids; zero new topics; zero duplicate notices; the drill transcript is readable on a survivor |
| R3 | Re-serving (§3) | Every canary reached the new identity and verified; no retry loop; a planted record past the retirement checkpoint was refused |
| R4 | Folder backup (§4) | The rebuilt identity itself decrypted the generation tested at the quiet point; the untracked file, the ignored hand-written file, custom hooks and the worktree change were restored byte-equal |
| R5 | Lives-only-here (§5) | Pre-flight refused while a planted single-copy item existed and started once it was homed; nothing was missing after the rebuild that the report did not list; the folder-size line matched a direct measurement |
| R6 | Disk (§6) | Creation was deferred and the budget restored safely; a pushed disk post was delivered; the pre-upgrade notice, generation and homing were observed |
| R7 | Browser profiles (§7) | The Apple ID and every `followsTheLead` account that can sign in unattended was signed in on the rebuilt machine, verified on the page; person-needed steps listed and not above the previous drill's count |
| R0 | Isolation | The real-home canary and the post-quiet-point journal canary were absent from the rebuild; no restored item was served by the drill machine's live identity; the drill identity was listed and then revoked on every current machine |

The sibling project's Drill 1 (pull the plug) runs separately; it is not a row here.

## Defaults and fixed limits

Every number in this spec is a judgment default within a floor, with the arbiter named. None is an invariant.

| Default | Value | Floor | Arbiter | Counterexample considered |
|---|---|---|---|---|
| Grace window before single-copy work reaches the owner (D2) | 24 h; shortened to 1 h when the machine is below its warn line, has a pending OS upgrade, or reports disk errors | Single-copy work is always listed in §5 at once, and homing starts at once | §1 checker; owner can set per repository | A release fix needs minutes: homing starts at once, so the window only delays the *notice*, never the copy |
| Homing cadence | Debounced 5 min after commits, and at least daily | Never longer than the grace window | §1 | A busy repository commits often: debounce |
| Scan budget per run | 60 s and 200,000 entries, with a resume cursor | A completed pass at least every 7 days; until then roots are `unknown` | §1 | A deep project: the cursor resumes, there is no depth cutoff |
| Candidates drained per tick | 20 | Every candidate is drained eventually; the queue is reported | §1 | A session clones many repositories: queued, not dropped |
| Backup copies (D4) | 1 with two machines, 2 with three or more | At least 1 whenever a second machine exists | lease holder | Peer short of space: choose another, or report |
| Backup run budget | 10 min and 20 GB hashed per run, resumable | A complete generation at least daily | §4 | The first backup of a huge folder takes many runs; §5 shows progress |
| Restore tests | Receipt verification of every generation (changed files only); deep test weekly and on demand | A generation is protected only after receipt verification; a failed deep test revokes protection back to the last passing one | §4 receiver | A full daily restore of every generation costs more than it finds |
| Retention (D5) | Generations: daily for 14 days, weekly for 8 weeks, monthly for 6 months; deleted-branch mirror refs and remote backup refs: 90 days | Byte cap from the receiver's disk; if the cap would delete a generation younger than 7 days, that is a Needs-you item | §4, §1 | Disk pressure on the receiver |
| Seal interval (D9) | 60 s, only when the chain head moved | A seal exists for every segment older than one interval | author | A busy stream: once per interval anyway; idle: none |
| Departure threshold (D10) | Revoked, or marked absent by lease-holder judgment, earliest 6 h unreachable; not before 72 h after a clean sleep report with no risk signal | Never before revoked or marked absent; explicit requests are always served | lease holder | A laptop asleep overnight: it is only advertised, never trusted less |
| Checker cadence | 15 min, and at boot | At least hourly | each machine | A burst after pairing: boot check |
| Upgrade floors (D7) | OS upgrade: the installer's own stated space requirement (from `softwareupdate --list` or the installer app), plus a margin of 20 % of used space scaled up by the volume's file count (1.5× above 50 million files), plus Disk Steward's floor; Instar update: the package size × 3 plus the floor | Never block an update that fixes data-loss or security | update manager, machine maintenance | A 256 GB laptop: the floor follows that machine's real requirement instead of a fixed 120 GB that it could never meet |
| Repair brakes | Homing: 3 attempts per hour per repository, breaker after 5 failures in a day; settings: 3 attempts, 10 min apart; signature `unknown`: backoff 1 min → 1 h, defect after 24 h; sign-in flapping: 3 expiries in 7 days | Every brake ends at a Needs-you item; none retries forever | each part | — |
| Drill pre-flight wait | Up to 2 h for the on-demand restore test | The drill never runs without a passing restore test of the exact generation | drill job | — |
| Rehearsals before a real wipe | 3 in a row | At least 1 passing rehearsal since the last failure | drill job | A mature pool: still cheap |
| Quarantine | 7 days, earlier if the disk floor requires | Deleted only after a pass | drill job | Disk pressure |
| Browser accounts that follow the lead | Used in the last 30 days | The owner can add or remove any | §7 | A rarely used account: the owner adds it |
| Worktree outer ceiling | 500 (existing) | — | existing code | — |
| Notice for a progressing repair | held while the receiver acknowledged bytes in the last 3 attempts, up to 72 h | the at-risk 1 h window still notifies | §0 | A first copy of a large repository on a slow lane |
| Latency ceiling | 300 s after repair exhaustion (registry key) | never from first detection | standard | — |
| Bulk lane bandwidth | at most 50 % of the measured link, and backs off to 10 % when lease or replication round-trips exceed twice their baseline | replication and lease traffic always first | §0 | A first backup of tens of GB on a home connection |
| No protected generation | a Needs-you item after 48 h without a protected (receipt-verified) generation | — | §4 | — |
| Audit log | 16 MB, 4 rotations | — | §0 | — |
| Checkpoint provisional window | until every current machine answers, at most 7 days | a held segment becomes a reported defect, never a silent discard | lease holder | A survivor asleep at revocation |
| Single-copy identities replicated per machine | 200: the 100 newest and the 100 oldest | the full count always replicates; items are still homed at once | §5 | 500 single-copy branches on a dead laptop: 300 are counted but unnamed |
| Pool route wait | 5 s per peer | unreadable peers reported `unknown` | routes | — |
| Rollout | Dark window ≤14 days per increment on Echo; fleet after two consecutive passing drills | — | Echo, on its E2E and drill rows | — |

## Decision points touched

| Decision point | Classification | Floor, arbiter, evidence |
|---|---|---|
| Push backup refs only to a remote that is private, owned by the home account and shared with nobody else, re-checked each push | invariant | basis: irreversible-consequence; evidence: a ref pushed to a public or shared remote is published to its readers the moment it lands and cannot be recalled (forks, clones, caches); unpushed work can hold unreleased or a team member's private content |
| A high-confidence live-credential hit always holds a push to a remote | invariant | basis: irreversible-consequence; evidence: a credential pushed in history is exposed on arrival and must be rotated (the post-mortem's printed master key, fb-ab20564d-5f7, is the same class); holding costs one delayed remote copy while the pool mirror keeps the work |
| A low-confidence credential pattern hit | judgment-candidate | Floor: held unless a model judgment or the owner calls it a known example; an unsettled hit holds; arbiter: the model judgment, recorded per `(file, blob hash)` |
| Rebuilt or admitted machines get the backup keys re-wrapped to them | invariant | basis: irreversible-consequence; evidence: without it the rebuilt machine cannot decrypt the backups it must restore from, because its old private key is never copied |
| A default value never overwrites a real one | invariant | basis: irreversible-consequence; evidence: B10 — a rebuilt machine's absent settings replicated as "newest" would erase every survivor's real settings |
| Retirement checkpoint made only at revocation, provisional until every current machine has presented its segments | invariant | basis: irreversible-consequence; evidence: a final checkpoint refuses later records for good; made on mere absence, it would discard a returning laptop's genuine work |
| Attested segments of authority-bearing kinds are never applied | invariant | basis: irreversible-consequence; evidence: one survivor speaking for a departed machine on who may act (a device row, a trust grant) could grant authority no one gave |
| Candidate repositories are never pushed to a remote or given one | invariant | basis: irreversible-consequence; evidence: pushing someone else's repository into the owner's account is an external publication the agent has no standing for (Sovereignty) |
| Create a private remote for an owned repository with none | judgment-candidate | Floor: owned class only, private only, home account only (D3), never adopts an existing repository as a newly created remote, credential check passed; fallback: pool mirror plus one sign-in ask; arbiter: the agent under D3 |
| Relayed journal records only inside a verified seal, never past the retirement checkpoint | invariant | basis: irreversible-consequence; evidence: an unverified relayed record is indistinguishable from a forgery, and once replicated to every machine it cannot be removed without `RollbackUnmerge` discarding genuine records with it |
| Key history accepted only when anchored | invariant | basis: irreversible-consequence; evidence: an unanchored key lets one compromised machine sign history in another machine's name |
| Same-incarnation sealed fork stops application and tells the owner at once | invariant | basis: irreversible-consequence; evidence: only a stolen key or a forging machine produces two signed segments in one incarnation; applying either replicates it |
| Attested pre-seal segments apply by per-seq agreement; a single-holder tail is labelled, never verified | judgment-candidate | Floor: nothing applied from a seq where holders disagree; arbiter: the receiving store; one-time path for legacy streams |
| Agent-scoped singleton creation needs every current peer to answer none | invariant | basis: irreversible-consequence; evidence: B1 — a duplicate Telegram topic and its notices cannot be recalled once people have seen them |
| Singleton conflicts are defects, not overwrites | invariant | basis: irreversible-consequence; evidence: a second value means a duplicate already exists in Telegram; overwriting hides it |
| Identity-bearing settings apply only when they match their signed authority | invariant | basis: irreversible-consequence; evidence: a wrong owner id silently mutes the owner (post-mortem A2: an unrecorded owner withdrew the private-group confirmation) |
| A weakening of a safety floor applies only from an owner action | judgment-candidate | Floor: every weakening is recorded; one held for lack of proof reaches the owner once; arbiter: the receiving machine's setting applier |
| Settle critical-state disagreements by HLC across peers, not lease role | invariant | basis: irreversible-consequence; evidence: in the outage the freshly rebuilt Studio took the lease while holding empty state; healing toward it would have overwritten good copies everywhere |
| What counts as single-copy, and when it reaches the owner | judgment-candidate | Floor: listed at once, homed at once, owner told when the grace window ends with it still single-copy; arbiter: §1/§2 checkers; window per Defaults |
| Exclusions from the folder backup | judgment-candidate | Floor: only entries with a stated reason in the code-owned list; arbiter: code review; the ratchet test refuses a reasonless entry |
| Backup peer choice | judgment-candidate | Floor: a current takeover-eligible machine, never the source, never pushed below its floor; arbiter: lease holder |
| A generation counts as protection only after its restore test, decrypting with the receiver's own key | invariant | basis: irreversible-consequence; evidence: an untested or undecryptable backup is discovered unusable only after the source is gone (B7) |
| Pressure mode removes a work copy only when its commits are homed and its uncommitted work is in a tested capture | invariant | basis: irreversible-consequence; evidence: removing a copy holding the only copy of work deletes it (the echo-dirty rescue of uncommitted work, post-mortem B4/B3) |
| Defer new worktree creation over budget | judgment-candidate | Floor: never refuse silently; arbiter: the worktree managers |
| Disk posts exempt from quiet-by-default; only person-reachable delivery resets the clock | judgment-candidate | Floor: a disk post below the warn line reaches a person-reachable surface at least once per repeat period; arbiter: Disk Steward |
| Refuse Instar updates below the floor | judgment-candidate | Floor: never refuse a data-loss or security fix; arbiter: the update manager |
| Real-wipe pre-flight refuses on any single-copy or `unknown` item at the quiet point (except listed `known-unprovable`) | invariant | basis: irreversible-consequence; evidence: the real wipe moves a real agent folder; wiping while something lives only there would repeat B11 on purpose. Rehearsals follow the rehearsal rule in §8.3 |
| Real wipe waits for items 13 and 17 | invariant | basis: irreversible-consequence; evidence: post-mortem A9, a rebuilt machine with a new identity split the pool and held the Mama PC's messages for eight hours |
| Drill machine never holds the lease or creates singletons | invariant | basis: irreversible-consequence; evidence: a rebuilding machine holding the lease is the post-mortem's 02:07 state; a singleton it created is the B1 duplicate |
| Real wipe only after passing rehearsals | judgment-candidate | Floor: never without at least one passing rehearsal since the last failure; arbiter: drill job |
| Browser cell counts as signed in only on identity (or the account's signed-in page check) read from the page | judgment-candidate | Floor: a cookie or profile file alone never counts (Verify the State; `credential-absent-signed-out`); arbiter: the coverage checker, with the per-account page check the registry names |

## Frontloaded Decisions

- **D1. Scope.** This spec owns items 6–11, 16 and 19, and Drill 2. Items 12, 13 and 17 are not built here, and nothing here depends on them (see Non-goals). Interfaces to the sibling project are named: `takeoverRequired` categories (§2.3) and browser coverage (§7.4) feed its readiness gate. The retirement checkpoint and key history (§3) are what its identity-replacement work (item 17) writes into.
- **D2. Grace window**: per the Defaults table. Source: the post-mortem's item 16, "unpushed work older than a day".
- **D3. Home account for created remotes and backup refs.** The home account is the GitHub account the **agent's own host login can create repositories in**, recorded once as `repoRegistry.homeAccount`. On Echo that is `EchoOfDawn` (checked live: `gh auth status`). Every repository the agent creates there is private and invites the owner's account as a collaborator (`repoRegistry.ownerAdmin`, seeded from `monitoring.localVerify.operatorGhLogin`, `JKHeadley` on Echo). A personal account has no admin role for collaborators, and each invitation must be accepted. So pending invitations are folded into one batched Needs-you ask, re-sent when they expire, which the run never waits on. Transferring or deleting a repository is an agent action the owner asks for. §1.5's "nobody else" test counts a pending owner invitation as the owner. No one but the owner and the agent can see these repositories.
  - Why not the owner's personal account: GitHub lets only the owner create repositories in a personal account, so remote creation there would be a permanent sign-in ask, the opposite of "I dont track this you do" (topic 141385, message 145894). The other condition was "make absolutely sure that these get saved to Git hub" (topic 145840, message 145918).
  - If the owner later supplies a token scoped to their own account (through Secret Drop), the home account switches to theirs for new repositories. Existing ones stay where they are until the owner moves them.
  - Backup refs may also go to an existing remote in the owner's account when it passes §1.5's tests.
  - Not cheap to change after (an external side effect), so it is decided here.
- **D4. Backup copies**: per the Defaults table.
- **D5. Retention**: per the Defaults table, under a byte cap.
- **D6. Drill machine**: the takeover-eligible non-lead machine with the most free space, chosen by the lease holder each month and named in the report. For Echo today that is the Mac Mini.
- **D7. Upgrade floors**: derived per machine, per the Defaults table. The Studio on 19 November (64 GB free, 226 million files) would have been below it.
- **D8. Backup encryption**: per-generation data keys wrapped to every current pool machine (§4.4). This needs neither secret sync nor the source's vault.
- **D9. Seal interval**: per the Defaults table.
- **D10. Departure.** A machine has **departed** when it is revoked, or when the lease holder has marked it absent. Marking absent is the lease holder's judgment, made no earlier than 6 hours of unreachability. It weighs the machine's last known state: a laptop that reported going to sleep with no risk signal is not marked absent before 72 hours, so an overnight or weekend lid-close produces no debt notice; a desktop that stopped mid-write is judged sooner. Departure starts unprompted relaying of its sealed segments and turns its single-copy items into named debt (§0). Only revocation makes a retirement checkpoint (§3.3), so a machine marked absent that returns resumes normally.
- **D11. Amending the foundation's §6.1.** `multi-machine-replicated-store-foundation.md` §6.1 is amended for sealed segments and attested legacy segments only. The amendment text lands in that spec in the same PR as increment 6. It is an approved spec, not the constitution.
- **D12. Agent-scoped merge settings**: `monitoring.localVerify.{enabled, postStatuses, operatorGhLogin, laneShards, queueControls, likelyFailingFirst}` and `monitoring.greenPrAutoMerge.{enabled, dryRun, floor}`; also this spec's own `repoRegistry.{homeAccount, ownerAdmin}` and the `noDataLoss.*` switches, so a rebuilt machine never loses the owner's choices (B10 again). Peer lists, paths and per-machine shard overrides stay machine-scoped.
- **D13. Disk notices push by default.** Post-mortem item 11 ("disk warnings are pushed"). An owner's existing explicit category choice is kept by the migration.
- **D14. Completion of the build run.** The build run is complete when increments 1–11 are merged and live on Echo, the drill job is in rehearsal mode, and one rehearsal has passed with every row green. The run never waits on the owner: R7's person-needed sign-ins are one batched ask the run does not wait for. After that:
  - Echo is the arbiter for dark → live, deciding on each increment's throwaway-pool E2E (D16); the rehearsal confirms.
  - Passing rehearsals count toward fleet rollout. Fleet rollout happens after two consecutive passing drills, in the next ordinary Instar release, which flips the parts' fleet defaults. Echo cuts it through its normal release process.
  - Real wipes start when the pre-flight sees items 13 and 17 live.
- **D15. The sibling dependency has a route.** Items 13 and 17 belong to the rebuilt-machine track the run lead assigned alongside this spec. When increment 11 merges, Echo opens a tracked commitment ("real-wipe drill waits on items 13 and 17") that checks `GET /capabilities` weekly and closes when both are live. Until then only rehearsals run, and every row is still proven.
- **D16. Irreversible actions ship in dry-run.** The parts that act outside the agent default to `dryRun: true` even on Echo: creating remotes, pushing backup refs, pressure-mode removals, and deleting the interim copies. In dry-run they log what they would do. Echo flips each one once its increment's **throwaway-pool E2E** passes in the **real-GitHub lane**. The standard E2E (pre-push and CI) uses a fake `gh` and a fake remote and checks the dry-run log and intended calls. A separate opt-in lane (`NDL_REAL_GITHUB=1`) runs only on Echo with its host login, once per flip, and its recorded pass is what the flip reads. A skipped or missing real-lane result never counts. That E2E creates real private repositories in the home account under the reserved drill names (§1.9a) and runs pressure mode on a throwaway home. The D14 rehearsal then runs with those actions live and confirms them. Reading, reporting, mirroring to the owner's own machines, and backups go live at merge.

## New record kinds

Every kind keeps the latest record per key, replicates state changes only, and is sent at most once per key every 5 minutes. The exception is a change in the unsafe direction (§0), which goes at once, for repository, critical-state, key-material and account lines. Changes in the safe direction are coalesced, never dropped, so the last state always lands.

| Kind | Key | Retention | Rate cap | Budget share of `aggregateJournalBudgetBytes` |
|---|---|---|---|---|
| `owned-repo` | machine + repoId | latest per key; tombstone 90 days after the repository is gone | 1 per key per 5 min | 4 % |
| `agent-setting` | category:field | latest per key, plus the previous value for conflict display | 1 per key per 5 min | 2 % |
| `job-run-record` | job slug | latest per key | 1 per job per run | 2 % |
| `machine-identity-record` | machineId + key hash | kept (a few hundred bytes per machine) | on change | 1 % |
| `backup-generation` | machine + generation id | follows D5 retention | 1 per generation | 1 % |
| `browser-coverage` | account + machine | latest per key | 1 per cell per check | 1 % |
| `lives-only-here` | agent + machine | latest per key: summary rows plus capped identities | unsafe-direction repository, critical-state, key and account lines at once; otherwise 1 per machine per 15 min | 2 % |
| drill lock and drill records | drill id | 90 days | on change | <1 % |
| `message-log-record` | `platform:chat:topic:messageId` (append-only; deduplicated across origins) | the existing message-log retention: 32 MiB × 4 segments per machine | follows inbound message rate; bulk backfill uses the bulk lane | 6 % |
| `agent-setting` sub-keys also carry | `reservation:<id>` (§2.5 singleton reservations), `interim-deletion:<agent>` (§4.7), `custodian-snapshot:<origin>:<kind>` (§3.5), `interim-retired-ack:<agent>` (§4.7) | as their parent kind | on change | within `agent-setting` |
| `machine-identity-record` sub-keys | `key:<machineId>:<keyHash>`, `checkpoint:<origin>:<kind>`, `admitted-set:<revokedMachineId>` | kept | on change | within its share |
| seal sidecars | origin + kind | rotate with their entry stream; only seals covering retained segments plus the latest | 1 per kind per seal interval | counted within the entry kind's share |

## Multi-machine posture

- **Why some content is on fewer than every machine.** What the agent *knows and is* goes to every machine: the critical list (§2) and the critical subset of files (§4.5). Repository content and the bulk of the folder are work products and files. They go to D4's count of peers, plus every repository mirror to every takeover-eligible machine with room. The count is a resources choice, stated in §4.5.

- `owned-repo` records: replicated (new kind). Repository content: unified through pool mirrors and remotes (§1.5).
- Critical categories: replicated per carrier (§2.2). `agent-setting`, `job-run-record`, `machine-identity-record`, `backup-generation`, `browser-coverage` and `lives-only-here` are replicated (new kinds). The drill lock is replicated.
- Author seals and snapshot checkpoints: replicated in each author's sidecar streams.
- Backup packs: placed on the chosen peers by count (D4); their index is replicated.
- Disk budgets and disk readings: machine-local-justification: hardware-bound-resource — the free space of a disk belongs to that disk. The Disk posts are one-voice through the lease holder.
- Browser profiles: machine-local-justification: physical-credential-locality — cookies and passkeys are bound to one browser on one machine. Coverage is replicated.
- Machine-scoped key material: machine-local-justification: physical-credential-locality — a machine's private signing and encryption keys are its identity.
- The `machine-person` team-access event: replicated through the existing team access log.
- The `interim-retired` marker file: a local signal for the Studio-only hand-built script. The authoritative records are the replicated `interim-retired-ack:<agent>` and `interim-deletion:<agent>`, and the file travels with the folder backup.
- The spent-proof set (§2.4) is replicated inside `agent-setting` acceptance records, so no machine accepts a spent proof. The scan resume cursor and the candidate queue are machine-local-justification: hardware-bound-resource — they index one disk's paths.
- `logs/no-data-loss.jsonl` (the audit of every detection and repair, metadata only): proxied-on-read through `GET /lives-only-here?scope=pool&audit=1`.

## Verify the state, not its symbol

| Detector | Symbol | State it claims | Corroboration | Unmeasurable |
|---|---|---|---|---|
| Repository homed | `home.*.verifiedAt` | every ref exists off this machine | the receiver's own tips (mirror peer after fetch; `ls-remote`) equal the local tips | `unknown`; treated as single-copy |
| Remote may receive backup refs | visibility and collaborator fields | pushing publishes to nobody else | read live with the agent's login at each push | not pushed |
| Critical category healthy | file or record exists | usable and current on that machine | `presence()` validates the value; digest equal to the HLC-latest; replication lag within window | `unknown`, past window a defect |
| Generation protected | manifest exists | the folder can be restored | the restore test passed, decrypting with the receiver's own key | not protected |
| Disk post delivered | post status | a person can see it | Telegram accepted a push, or a Needs-you item exists | not delivered |
| Profile signed in | profile or cookie file | the account is usable | identity read from the account's page | `needs-sign-in` |
| Relayed record genuine | arrived from a pool peer | the author wrote it | seal signature from the anchored key, chain, inside the checkpoint | not applied |
| Folder size | `du` of readable paths | the whole folder | `statfs` used bytes, minus other folders' counted bytes, with unreadable remainder reported | the unreadable remainder is named |

## Self-heal and escalation

| Item | Class | Repair | Reaches the owner when |
|---|---|---|---|
| Single-copy commits or branches; repository with no remote | recoverable | homing; remote creation under D3 | still single-copy when the grace window ends, or repair blocked (no peer, no login, credential hit) |
| Critical category missing, behind, or single-copy | recoverable | re-pull and apply; ask peers to pull | repair failed (latency counted from exhaustion) |
| Restore test failed or overdue | recoverable | new generation, re-test | second failure, or no protected generation for 48 h |
| Disk below warn line, or forecast to reach the floor | recoverable | reaper pressure mode | per Disk Steward's existing levels, now pushed |
| Browser cell needs sign-in | recoverable | unattended sign-in procedure | the person-needed cells, batched into one ask |
| Signature `unknown` | recoverable | pull key history from every peer | 24 h unresolved |
| Same-incarnation sealed fork, or record past a checkpoint | irreversible (possible forgery) | stop applying past it, quarantine | same tick |
| A machine departed (D10) holding single-copy items | recoverable while it may return; open debt | restore what peers hold; keep the debt open | once, at departure, worded as debt ("only copy was on the Studio, unreachable since 14:20"); "lost" only when the owner records it |

Each repair carries a dedupe key per item, brakes per the Defaults table, and a breaker that treats 3 heals of the same item within 7 days as flapping, which is raised whatever its class. Every detection and repair is written to `logs/no-data-loss.jsonl`: metadata only, paths relative to the home, no contents and no secrets; rotated at 16 MB, keeping 4 rotations (registered, retention class C).

Self-heal declaration (the shared repair loop all parts use; per-part brakes are in Defaults):

- remediation-actions:
  - homing: bundle to mirror peers, create private remote, push backup refs
  - critical state: re-pull and apply carrier records, ask peers to pull, ask author to re-advertise
  - backup: new generation and re-test
  - disk: reaper pressure mode
  - sign-in: run the account sign-in procedure
  - key history: pull machine-identity records from every peer
- max-attempts: 3 per item per hour (homing breaker at 5 failures per day)
- max-wall-clock: 24h per item (the grace window), held while progressing up to 72h; 1h at elevated machine risk
- backoff: exponential, 1m to 1h
- dedupe-key: `<part>:<machineId>:<itemId>`
- breaker: 3 heals of the same item within 7d counts as flapping and is raised
- max-notification-latency: 300s
- audit-location: logs/no-data-loss.jsonl
- class: recoverable

(The one irreversible row in the table above, a possible forgery, is raised on the same tick as detection; for every other row the latency is measured from repair exhaustion.)

## Config, migration and rollback

- **Config.** Each part has `noDataLoss.<part>.enabled` and `.dryRun` (parts: `repos`, `criticalState`, `relaying`, `folderBackup`, `livesOnlyHere`, `disk`, `browserCoverage`, `drill`). `enabled` is omitted by default, so the development-agent gate makes each part live on Echo and dark on the fleet. `.dryRun` is `true` by default for the irreversible actions (D16) and `false` for the rest. `repoRegistry.{homeAccount, ownerAdmin}` (D3).
- **Routes.** Every `?scope=pool` read waits at most 5 s per peer and reads every current machine, reporting each one it could not read as `unknown`.
- **Migration (`PostUpdateMigrator`).** Increment 4's migration **seeds** `agent-setting` records from each machine's validated persisted values (marked `seed`). Settings that already exist reach the carrier without waiting for an edit. Seeds from different machines that disagree are kept as defects, never collapsed. Add the config blocks if missing. `homeAccount` is one agent-scoped value, not a per-machine seed. It takes the first explicit value; failing that, the lease holder's own host login (`gh api user`). `ownerAdmin` comes from `operatorGhLogin`. When the two differ, `homeAccount` is never the operator login. With no host login anywhere, `homeAccount` stays unset, the pool mirror still runs, and one sign-in ask is made. Exempt the Disk Steward categories from quiet-by-default unless the owner chose otherwise. Register the homing, restore-test and drill jobs. The interim job's retirement (§4.7) is a step of the backup job itself, not of the migrator. It runs only where the hand-built `ai.instar.offmachine-backup.plist` and its script exist, and is a no-op everywhere else.
- **Awareness.** One entry, `src/data/awareness/no-data-loss.md`, covering `/repos`, `/critical-state`, `/lives-only-here`, the Data safety card and the drill, plus Registry-First rows ("Is anything on this machine only here?" → `GET /lives-only-here`).
- **Rollback.** Turning a part off stops new work and leaves its outputs in place, because they are copies of the owner's data:
  - peer mirrors, generations, private remotes the agent created, and seals stay;
  - remote backup refs stay until their retention ends, and a cleanup route deletes them;
  - turning relaying off stops serving foreign origins; applied records stay;
  - turning pressure mode off returns the reapers to their existing rules.

## Maturation plan

- **ladder:** not applicable: this PR adds only the design; increment 1 (PR #3544, owned-repository registry) adds the no-data-loss-on-machine-death switch together with its ladder entry in src/data/feature-ladders.json.
- **test-agent-live:** each increment's E2E boots a throwaway two-machine pool and runs that increment's drill row. Increment 6 adds a mixed-version pool (one old peer).
- **dev-agent-live:** Echo's machines. Each part is on at merge, with the D16 actions in `dryRun: true`. Those actions go live on Echo after their throwaway-pool E2E in the real-GitHub lane (D16), and the rehearsal confirms them. The first drill is a rehearsal on the Mini.
- **fleet:** after two consecutive passing monthly drills on Echo with the increment live.
- **graduation criterion:** a drill row passes twice in a row with no person-needed step the report did not predict.
- **dark-window:** at most 14 days per increment on Echo; Echo records why if it is longer.

## Build increments (ordered)

1. **Repository registry, read-only** (§1.1–1.3, 1.7; `owned-repo` kind; `GET /repos`). The cheapest step that would have saved B11. The disk-post delivery fix (§6.2) is small and ships alongside it.
2. **Homing** (§1.5): the `machine-person` custody binding and its migration first, then the pool mirror, credential check, private-remote creation and remote backup refs. Retires the interim GitHub sweep. Closes B4 and B11.
3. **Census correction and the critical list** (§2.1–2.3): registry entries, the `critical` block, lints, `GET /critical-state` read-only.
4. **`agent-setting` and `job-run-record`, authority rules, the singleton guard, readiness export** (§2.4–2.5). Closes B1, B9, B10.
5. **Key-history carriage and bounded `unknown` re-checks** (§3.1). Closes A5 and the documents half of B2.
6. **Seals, snapshot checkpoints, relaying, retirement checkpoints, attested legacy segments, the §6.1 amendment** (§3.2–3.5). Closes the journal half of B2.
7. **Folder backup** (§4): index, captures, packs, envelope keys, restore test, key-material sort. Retires the interim rsync job. Closes B3, B6 (with transcript checkpoints), B7.
8. **Lives-only-here report, Data safety card, runbooks** (§5). Closes B5, B8.
9. **Work-copy budget, pressure mode, the upgrade guard** (§6.1, §6.3). Closes C1.
10. **Browser coverage and per-machine sign-in** (§7). Closes B12.
11. **The drill** (§8): drill role, lock, rehearsals.

## Tests and evidence (additions)

Beyond the list below, round 2 added these required tests:

- an abrupt-loss pool test per increment: the source is killed mid-write, and the loss stays within the recovery point;
- a rebuilt identity decrypts an older generation;
- a default value does not overwrite a real one;
- a laptop returning after being marked absent keeps its sealed work;
- a single-holder attested tail is labelled and never verified;
- an authority-bearing kind is never taken from attestation;
- restore refuses `..`, absolute and through-symlink paths;
- a nested repository inside the agent home is discovered;
- after an upgrade with no settings edits, the source is lost and the seeded settings survive;
- R1 fetches the expected commit from GitHub even when the mirror finished first;
- a capture transfer interrupted before its receipt leaves the checkout in place;
- the source is lost after entries reach a peer but before their seal does, and the checker had not counted them as protected;
- a save between the reaper's last comparison and removal is impossible while the lock is held;
- a clean detached worktree `HEAD` is homed and restored with its exact object id (also in R1);
- a fresh join after a weakening proof expired accepts the setting from its acceptance record;
- an owner edit made with no reachable peer survives reconnecting and reaches every peer;
- a team member's repository gets zero remote pushes;
- custody and anchoring both work before any owner key is enrolled (`anchored-by-machines`);
- a machine admitted after a revocation refuses a record past the checkpoint;
- a survivor with a verified mirror pushes a dead source's backup refs;
- a relayed record's consumer sees `origin = M`, not the relayer; it lands in `peers/<M>.<kind>.jsonl` and does not trip `handleIncarnationFlip` for the relayer;
- an owner reset to a default value propagates;
- a non-owner pool machine is admitted and receives zero envelopes and zero mirrors;
- the drill-role instance refuses its own live identity as a source;
- a new commitment id never reuses an id held in any replica, archive or tombstone;
- a required secret absent on every machine raises one Needs-you item;
- `apps/instar-ios` and `apps/instar-android` are both found on a fixture shaped like Echo's home;
- a nested repository two levels under an untracked directory and one under an ignored directory are both found;
- a pre-existing repository on an agent with a team member gets zero remote pushes;
- a fresh join refuses a single-signer acceptance record for a message proof;
- the standard E2E never creates a real repository; the real-GitHub lane runs only with `NDL_REAL_GITHUB=1`;
- a fresh join after journal rotation and snapshot-cache eviction still receives a departed author's open projects;
- the source is killed between scheduled backup runs, and the newest protected generation's complete-through time is within the recovery point;
- a file moved from an unvisited directory into a scanned one during a scan is in the generation;
- two machines minting commitments during a partition issue different display ids;
- an amend leaves one stable recovery ref for the superseded commit, and that ref is absent from every `git ls-remote` of the backup remote;
- the oldest generation restores after garbage collection;
- two concurrent singleton creators produce one topic, and a crash after creation does not create a second;
- the rehearsal's real-home canary stays absent.

## Tests and evidence

Each increment carries unit, integration (route) and E2E ("feature is alive") tests. It also carries wiring-integrity tests for every injected dependency, and a two-machine throwaway-pool E2E of its drill row. Required semantic tests include:

- a relayed record past a checkpoint is refused;
- a cross-incarnation difference is not called a fork;
- a candidate repository is never pushed;
- a remote that turns public loses its backup refs;
- a quiet disk post does not reset the clock;
- pressure mode never removes a copy with an uncaptured change;
- a mixed-version pool keeps replicating while seals roll out;
- the lease holder's value does not win against a newer HLC.

The drill is the acceptance evidence.

## Open questions

*(none)*

## Left behind

Precision items not iterated on (full list in the convergence report):

- The exact upgrade-margin multiplier (1.5× above 50 million files) has a weak basis. It only gates a notice while an upgrade is pending.
- The custodian-snapshot completeness rule: build only from segments up to the checkpoint or highest verified seal, record that seq, and let receivers prefer the most complete copy. It needs four rare conditions at once.
- When team access is turned on after machines were admitted, ask the custody question again and stop re-wrapping to unbound machines. Envelopes already sent cannot be recalled, and §5 should say so.
- The temp and scratch exclusion for session evidence. Repositories created through Instar's funnels register anywhere, and declared roots are scanned.
- The one-machine pool anchor is the weakest label, `anchored-by-single-machine`.

**Resolved after the final external pass, without another external read.** Through all six rounds and two confirmation passes, the external GPT-tier reviewer raised a new, narrower set of race and edge findings each time. The four from its last pass are resolved in the text: scan reconciliation compares passes, protection needs an acknowledgment from an independent machine, message custody is enforced at the serving machine, and commitment blocks are granted serially by the lease holder. No further external read has checked these four resolutions. Each has a named test in "Tests and evidence (additions)", and those tests are the check during the build.
