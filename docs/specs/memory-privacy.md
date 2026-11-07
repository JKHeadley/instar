---
title: "Memory privacy: a session loads only what the people it serves may see"
slug: "memory-privacy"
author: "echo"
parent-principle: "Know Your Principal"
eli16-overview: "memory-privacy.eli16.md"
status: "draft"
approved: true
approved-by: "echo, under the standing operator rule that only constitution changes need Justin; no constitution file is touched; the one product question was answered by Justin in topic 137333 on 2026-11-03"
review-convergence: "2026-11-04T06:28:33.503Z"
review-iterations: 4
review-completed-at: "2026-11-04T06:28:33.503Z"
review-report: "docs/specs/reports/memory-privacy-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
---

## Problem statement

On any Instar agent serving more than one person, memory is one pool. Proven on the test agent nimbus with two real Slack people (feedback fb-260cd1ba-f89, fb-dc0b4725-243): person A's "remember my Q4 budget", said in a private DM, was answered to person B in a fresh session. B's session ran an ordinary `grep` over `.instar/MEMORY.md` in Bash. Reproduced on throwaway agents 2026-11-03 with a made-up fact.

A code audit found the class, not one file. No memory read that feeds a session filters by who it serves. Filter code exists (`src/utils/privacy.ts`, `TopicMemory.getRecentMessagesForUser`) but production never calls it, and most writes record no source person. Copies of the same facts also sit in message logs, attachments, backups, transcripts and temp files, and are reachable through ordinary routes such as the file viewer and session output.

So a store-by-store filter cannot close this. This design makes the boundary the session itself: what it can reach, not what each store remembers to hide.

## What this builds on

Instar's organization work (SLACK-ORG-INTEGRATION-SPEC, SLACK-ORG-PERMISSIONS-PHASE1, MULTI-USER-SETUP-SPEC, mobile-app-people-and-roles) answers **who is this** and **what may they do**: `UserProfile` with `orgRole`, `deriveRole`, `SlackPrincipalResolver`, `SlackUserRegistry` (registration creates the `UserProfile`), `RolePolicy` tiers, and `SlackPermissionGate`, which is observe-only by default. It decides what a person may do and does not cover what a session may remember or show. This spec adds that third question and adds no identity of its own: a person is a `UserProfile`, the owner comes from `deriveRole`, Slack senders resolve through `SlackPrincipalResolver`, and someone unregistered there is `place` here, matching their `guest` role. Registering a person through the existing flow is what gives them private memory.

## Goals

1. Every fact a person gives a scoped session is stored where its visibility is fixed: that person's folder or that place's folder.
2. A session reaches only what its audience may see, including when it goes looking.
3. Existing unlabelled memory reaches nobody but the owner.
4. An agent only one person can message behaves exactly as today in that person's private places. A shared place with other readers changes on purpose (section 1).
5. Existing agents get this on update. It uses the existing user identity; there is no second identity system.

Accepted cost: outside the owner's private places, the agent has no semantic or episodic recall, and it does not learn across people. Portal runs with the same cost today, for the same reason (Dawn, 2026-11-03).

## Threat model

**Closed:** a person asks, in any session, and the agent answers from what it loaded, or from what it can reach by shell, file tools or Instar's API. This includes the proven leak.

**Not closed, stated plainly:**
- Everything inside a session stays visible to that session's audience. A person's fact said in a group belongs to that group.
- The owner runs the machine and can read every file. Owner sessions keep the agent's token. Nothing loads another person's folder into an owner session, but the owner can look on purpose, as they can today.
- Jobs have owner reach. A job the owner wrote that deliberately sends to a shared place can carry owner-scope content there. Automatic scheduler notices cannot (section 6).
- A file the owner creates at the top of the agent home after a scoped session started is outside that session's file-tool deny list until it respawns. Its shell is still blocked.
- Agents sharing one OS user can read each other's files. That is a separate issue, fb-79e7b408-ad2.

## Proposed design

### 1. Audience: decided by the place

`src/users/MemoryAudience.ts`, pure and deterministic:

- `open`: today's behaviour. No scoping of any kind.
- `owner`: the owner in a private place.
- `person`: another registered person in a private place.
- `place`: a shared place, or a private place whose sender is not registered.
- `system`: the scheduler, lifeline, and unbound spawns from the agent token (dashboard console, `POST /sessions/spawn`, `POST /sessions/create`). Owner reach, as today. A spawn bound to a topic or channel takes that place instead, or people would be talking to an owner-reach session.
- `none`: unknown or an error. No memory at all.

`resolveMemoryAudience` takes a required place. There is no optional parameter that means "everything", which is the failure Portal's postmortem of 2026-07-14 records. The audience comes from the session's place, never from the data being read.

**Places.** Slack `D…` DM, an app conversation with one device person, and a WhatsApp or iMessage 1:1 are private. Slack channels and threads, Telegram, and WhatsApp or iMessage groups are shared.

Telegram has no private place in Instar: the adapter folds a DM into the group's General topic and replies to the group (`TelegramAdapter.ts:5854`, `:1570`). The audience is the whole group, because every forum topic has the same readers. Slack threads take the channel's key, because channels can read their threads. A reply goes to the thread its message came from (fb-99bf432a-05f), as a courtesy to the person, not as a privacy control.

**Readers, per place only.** A shared place counts as private only with proof that its one human reader is the person being served, and proof is recent:

- Slack: a private, non-external channel (`is_private`) whose `conversations.info` with `include_num_members` gives two members, the person and the bot. A public channel is always shared, because anyone in the workspace can read it.
- Telegram: `getChatMemberCount` less bots listed by `getChatAdministrators`, leaving one. A group holding a non-admin bot reads as shared, and `memoryPrivacy.privateGroups` lets the operator confirm a group holds only them.
- The count is taken again at every inbound message, so a joiner is caught at the next message. A failed count leaves earlier proof to expire after 5 minutes rather than clearing it, so one API error does not end a conversation. With no proof, the place is shared. A joiner who reads between messages, with no new message arriving, is a remaining race, stated here on purpose.
- **Update safety:** Telegram offers no way to list non-admin bots, so a one-person agent's existing group would read as shared and a real owner would lose their memory on update. The update therefore records that agent's existing group as confirmed. The confirmation survives count errors, and is lost when the group's member count grows past its baseline or when anyone but the operator speaks there; sessions in that group are then ended before the message is delivered. This is a deliberate choice of the operator's requirement that single-person agents behave exactly as today over reader proof: an unknown reader already in that group, or one who replaces a member at an unchanged count, is not caught.
- Slack apps need `groups:read` for private channels. It is added to the manifest and `REQUIRED_SCOPES`. An app without it gets `place` in private channels and one attention item, since a scope needs an app reinstall.

This decides that place only and never feeds multi-person. So on a one-person agent, a busy channel gets `place` while everything else stays `open`. That closes the channel gap in the one-agent-per-person stopgap, which 136880 measured on nimbus: the fact's owner asked in a channel and the agent posted it there.

**Multi-person** is true when more than one human can send to the agent. Per platform, count allowlisted ids (Slack `authorizedUserIds` less the bot, Telegram `authorizedUserIds`, WhatsApp `authorizedNumbers`, iMessage `authorizedContacts`), active `msp` phones, and senders observed at inbound. Ids resolving to one `UserProfile` count once.

- `["*"]` on an allowlist counts as many.
- An empty Telegram allowlist accepts anyone, so the agent is multi-person as soon as a second verified sender is seen.
- **Baseline at first boot.** Real agents have no profiles and unlinked ids. Echo, checked 2026-11-03, has none of the first, an empty Telegram list, one Slack id and two iMessage handles, so counting ids would call it three people and strip its memory on update. So the first boot of this version records every id the agent already has as one operator, unless the configuration clearly shows a second person: two ids on Slack or on Telegram (one human each), two reachable profiles, an `msp` phone, or `*`. iMessage and WhatsApp lists often hold one person's handles, so they prove nothing alone. The baseline waits until the Slack bot id is known, because an allowlist can hold the bot, for at most two minutes after boot, after which two Slack ids count as two people, because merging two real people would be permanent. Until then only what clearly shows a second person counts, and senders are held and treated as they would have been after it. After baseline, any new id counts as a new person, and the operator stays the owner if no profile says otherwise. The first sender on a platform with no list at baseline is the operator arriving there. Accepted limit: two real people who were unlinked on different platforms at update read as one until someone new appears, or the owner registers them. This keeps the operator's requirement that single-person agents behave exactly as today.
- `memoryPrivacy.sharedMemoryPeople` names profiles who share memory freely. They count as one, so such an agent stays `open`. Anyone else reaching it makes it multi-person. Operator decision 2026-11-03: Luna, for Justin and Adriana.

The flip to multi-person is sticky, stored in `state/memory-privacy.json`, and evaluated at inbound before routing. A detection error keeps the last known value, and a first-ever error counts as multi-person.

**Owner:** `memoryPrivacy.ownerUserId`, else the profile matching the Telegram owner (`getOwnerUserId()`), else the only profile with the `owner` role, else, with no owner role at all, the only `admin`. An organization normally has several admins, so `owner` decides first. If none or several: nobody is the owner, legacy memory is reachable by nobody, and one attention item gives the fix.

**Decisions written down** (from Dawn's review):
- Someone who joins a group later can reach that group's memory, the same as its history. A place's memory belongs to the place.
- What a person says in a group stays in that group's folder. Their private folder does not pull it back, even when it is about them.

### 2. Storage: visibility is where a fact lives

`~/.instar/memory-scopes/<agent id>/<kind>-<sha256[:16]>/`, created 0700. Each holds the memory, an `inbox/` and a `tmp/`.

These folders sit **outside the agent home**, verified necessary: a file-tool deny on a parent beats any allow, and `dontAsk` auto-allows reads in the working directory, so the agent home must be denied without exceptions. It also means GitSync's whole-tree commit never sees them, so private folders cannot reach a remote, with no ignore-list changes.

`open`, `owner` and `system` keep `.instar/agent-memory` and its link. Nothing is moved or rewritten, so that is the whole migration of existing data. The folder is the visibility and, for `person`, the source person. For `place` the source is the place; the session is told to record who said what, but nothing depends on it.

`none` gets a fresh empty folder per session, removed at session end, so it cannot pass facts between sessions. There is no shared general folder. A fact reaches owner memory only if the owner says it there. Dawn's experience supports this: a shared space fed by anything but one deliberate rewriting step became a leak twice.

Each audience has its own folder, so there is no shared index filtered after search, and Dawn's starvation failure cannot happen.

Scope folders are machine-local and are not in backups: a topic that moves machines starts with an empty scope, never a wider one. GDPR export and erase include the person's folder.

Files named in an inbound message (long Telegram messages, attachments, Slack recovery files) are copied into `<scope>/inbox/` at injection, and the text is pointed at the copy, so a person can still send files to their own session. Only paths under the known inbound folders and only files from the last 10 minutes are copied, so a typed path cannot pull in an older attachment.
### 3. Session binding

The audience is computed in one place, `SessionManager.resolveSessionAudience`, on every spawn in all four lanes (headless, rerouted interactive, interactive, triage), from a required `place` the caller passes. No caller passes an audience. A spawn with no place on a multi-person agent is `none`, unless section 1 makes it `system`.

- Each session stores its `place`. Every respawn, resume and recovery recomputes from it. Places are also stored on the resume entries. A pre-existing resume entry has no place, so the place comes from the topic or channel binding.
- Each place records its full audience: kind plus the person id or place key. If that differs in any part, the resume binding is dropped: the old transcript may hold what the new audience must not see.
- Jobs pass `system`. On a multi-person agent, triage does not run on `person`, `place` or `none` sessions, because it runs with owner reach.
- On a multi-person agent, inbound agent-to-agent sessions are refused. Trust levels limit what a peer may do, not what data its session can see, so a `verified` peer given owner reach could ask for a person's fact and pass it on, and scoped sessions have no MCP to reply with. Stated cost. An agent kept `open` by `sharedMemoryPeople` is unaffected.
- Every inbound message checks the live session for its place and ends it if its audience differs, before the message reaches it, and any resume from a different audience is dropped. This close lifts the ordinary keep-guards, because a busy session is the one that would answer. If the session still cannot be ended, the message is not delivered and the sender gets the fixed reply. A same-name session is reused only for the same audience. That one rule covers sessions from before the update, a restart, and a place that lost its reader proof. Sessions that get no message are harmless until one arrives.
- On a flip to multi-person, whatever caused it, every other interactive session whose audience would change is ended as well, once. Headless work is left alone.

Inbound paths build the place: Telegram, Slack (`SlackPrincipalResolver`), app (`DevicePerson`), WhatsApp and iMessage (`UserProfile` channels). Wiring runs straight after the session manager is created and before any adapter starts, and boot waits for the sandbox probe, so no message or session comes first. Nothing is retired at boot; the per-message check does that with all guards in place.

### 4. What a `person`, `place` or `none` session can reach

One function sets this up, and a spawn that cannot apply it fails. All four lanes use a dedicated `memorySettingsPath`, separate from the confinement path, with no `--setting-sources` change, so hooks still run. Hooks run outside the sandbox and are trusted code.

The launch drops `--dangerously-skip-permissions` and uses `--permission-mode dontAsk` with an exact tool list (`Bash,Read,Edit,Write,Skill,WebFetch,WebSearch,TodoWrite`), `--allowedTools` for those tools and for Read, Edit and Write on the scope folder, and `--strict-mcp-config` with no servers. This is a new mode beside `confinedTools`, sharing its assertion. The settings file holds:

```json
{
  "autoMemoryDirectory": "<scope folder>",
  "permissions": { "deny": ["Read, Edit, Write on <home>/.instar/**, every other top-level entry of the agent home, and Edit, Write on CLAUDE.md, AGENT.md and .claude/**"] },
  "sandbox": {
    "enabled": true, "failIfUnavailable": true, "allowUnsandboxedCommands": false,
    "autoAllowBashIfSandboxed": true,
    "filesystem": {
      "denyRead": ["$HOME", "<agent home>", "/tmp", "/private/tmp", "the system temp root"],
      "allowRead": ["scope folder", "the reply scripts"],
      "allowWrite": ["scope folder"]
    },
    "network": { "allowLocalBinding": true, "allowedDomains": ["localhost", "127.0.0.1", "public suffixes"] }
  }
}
```

**The two boundaries are separate.** File tools run in `dontAsk` mode, so a Read, Edit or Write is refused unless `--allowedTools` lists it, and that list names only the scope folder. Anything outside the agent home, including sibling scopes and credential files, is blocked that way. `dontAsk` does auto-allow reads in the working directory, which is why the agent home also needs the deny rules; a deny beats an allow. The shell is bounded by the sandbox's `denyRead` and `allowRead`.

Verified with real sessions on macOS, Claude Code 2.1.316, 2026-11-03: other scope folders, `.instar`, `history.jsonl` and all of `$HOME` refused from the shell and from file tools; own folder read and written; writes to the agent home refused; reply script ran; localhost and web reachable; `autoMemoryDirectory` honoured; `CLAUDE.md` still loads. `CLAUDE.md` does **not** load if the agent home's root is denied, which is why the deny lists top-level entries instead. On Ubuntu 24.04 the same read boundary was verified with the AppArmor profile in place.

**Reaching the agent server on Linux.** bubblewrap gives the shell its own network namespace, so `localhost` inside it is not the agent's server, and the sandbox's `NO_PROXY` lists `localhost`, so curl goes direct and fails (exit 7). Every reply script uses plain curl. On Linux the spawn writes `<scope>/.curl/.curlrc` containing `noproxy = ""` (rewritten at every spawn) and sets `CURL_HOME` to that folder, so curl sends `localhost` through the sandbox proxy, which allows it because it is in `allowedDomains`. The session reaches nothing it could not reach on macOS, where it shares the host loopback. Measured with Claude Code 2.1.318 on Ubuntu 24.04, 2026-11-04, using the real settings and the real `slack-reply.sh` and `telegram-reply.sh`: without the file, curl exit 7 and no reply; with it, both replies reached the server with the session token, outside hosts still answered, and the agent home's files stayed unreadable. Forcing the proxy without its credentials gives 407, which is what an earlier probe misread as the proxy refusing localhost. macOS is unchanged.

The shell denies whole `$HOME` and temp roots because `~/.claude*/history.jsonl` holds every prompt, and session temp folders hold task output. Unix sockets stay denied, so tmux cannot reach another session's token. Session temp goes to `<scope>/tmp`, started from a clean environment the way `applyClaudeConfinement` does.

**Environment:** `INSTAR_AUTH_TOKEN` (session token), `INSTAR_PORT`, `INSTAR_AGENT_ID`, `INSTAR_MEMORY_SCOPE`, `INSTAR_BIND_TOKEN`, `INSTAR_CONVERSATION_ID`. Reply scripts use `INSTAR_PORT` and take the token from the environment even when `config.json` is unreadable, including the `slack-reply.sh` branch that today sets `AUTH` only inside a `config.json` test. Origin tokens are not refreshed for these sessions, since the refresh goes through tmux. The failed-send queue file is unreachable from the sandbox, so a reply that fails after retries is reported to the session rather than queued. Accepted cost.

**Claude Code floor:** 2.1.316, the oldest version these settings were verified on. Boot checks the version and runs the probe; a scoped launch on anything older is treated as no working sandbox.

**iMessage:** `imessage-reply.sh` sends from inside the session with `imsg`, which needs Automation access the sandbox does not give. It is treated like a framework with no adapter: on a multi-person agent, a non-owner iMessage gets the fixed reply. Stated cost.

**No working sandbox.** Boot runs a real probe and checks the Claude Code version. On Linux the sandbox needs `bubblewrap` and `socat`, and on Ubuntu 24.04 also an AppArmor profile. A fresh server has none of them, so boot installs them with `sudo -n` when it can, only if the probe failed. A shell limited by permission rules alone was tried and rejected: on a real session, a recursive `grep` over the working directory ran anyway, because read-only commands there are auto-allowed and deny rules match only named paths. Otherwise, and for frameworks with no such adapter, an inbound message that would start one of these sessions gets a fixed reply saying private memory isn't set up and to ask the agent's owner, plus one attention item naming the fix. It does not run unprotected. `memoryPrivacy.enabled: false` is the operator's explicit way out.

**No agent is restricted by an update.** Decided by Justin on 2026-11-04, after the feature refused an owner and blocked an agent's reads. Memory privacy is on only when `memoryPrivacy.enabled` is exactly true, which only an owner sets. `migrateConfig` writes false where it is missing, keeping anything else in the block. The check does not rely on the migration: boot wires memory privacy from config loaded before the migration runs, so a missing value must already read as off, or the first boot after an update would restrict the agent. With it off, boot also ends any session still inside the boundary, because it would otherwise keep its sandbox and limited token. The cost is plain: an agent serving several people does not separate their facts until its owner opts in.

**New agents stay off for now.** Justin's decision allowed new agents to start with it on. They do not yet, because the boundary is not sound across machines: `config.json` is not in the mesh repo, so a joined standby has no copy of the setting and would serve unprotected after failover. Once failover keeps the explicit setting, new agents can start on. Until then an owner who opts in must set it on every machine.

**Owner recovery.** Boot names the real blocker: the sandbox, a Claude binary that will not run, or one below the floor. A Mac is a supported platform, so "no supported sandbox" is never the report there. Everyone but the owner still gets the fixed reply. The owner here means a verified person matching the owner id: operator keys are inferred at baseline and can hold a colleague, so they never count. An owner with no user profile gets the fixed reply, except the Telegram case below; the attention item and `GET /memory-privacy` still give the fix. The owner hears the cause only in private: in a direct message the reply carries it, and in a shared place the reply says only that a private message was sent, because paths and links must not reach other readers. Slack, Telegram and WhatsApp each send that private message. A failed send falls back to the fixed reply and can be tried again, so the channel never claims a message that did not go. When no owner profile resolves, the Telegram owner counts by the configured owner id too, because Telegram vouches for the sender and group senders often have no profile. A real owner profile always wins, and the Telegram message goes only when its fixed recipient is the person who asked. In the owner's own private chat private memory is not the cause, so a refusal there, such as a session that could not be reset, just asks them to try again.

That message links to the solution for every cause, as Justin asked: a page, live for 30 minutes, gives the cause and the steps. When a binary at the floor is on the machine, the page also offers a one-click repair, and that link works once. The link is the credential, like Secret Drop. Opening it changes nothing, because apps fetch links to build previews; only the page's POST spends it. The request carries no input. The server chose the repair at boot and measures the binary again before using it: it sets `sessions.claudePath` and new sessions use that binary. Running sessions keep theirs. It cannot turn memory privacy off or run anything outside the sandbox. The address is the tunnel, so it opens on a phone. With no tunnel there is no such address, so the message says so and gives the manual step rather than a localhost link. `GET /memory-privacy` reports `blocker` and `fix`. The degradation report can leave the machine, so it carries no paths.

### 5. Routes: default deny

The session token is a random value, like `ior1_` origin tokens (`OriginSessionRegistry.ts`). It maps to the session and its audience, persists in state across server restarts because a running session's environment cannot change, is never reissued, and is revoked at session end. The audience is in the in-memory map, so the guard does no disk read per request. A session token is **denied on every route unless listed**:

| Allowed | Limit |
|---|---|
| Reply and send routes for each channel | Own place only |
| Hook event routes | Own session only |
| `GET /internal/stop-gate/hot-path`, `POST /internal/stop-gate/evaluate`, `/messaging/preflight`, `/telegram/origins/operations/*`, `/events/delivery-failed` | Session plumbing; no remembered content. Other stop-gate routes show all sessions or change agent-wide state, so they are refused. `/internal/compaction-resume` is refused because it accepts any session name |
| `GET /identity/soul/integrity`, `POST /feedback` | Unchanged; `GET /feedback` is refused, because it lists free text from all sessions |

A test enumerates every route on every mounted router and fails on any route not classified. Exact-compare sites (`routes.ts:21128, 39371, 20460, 20286, 5422, 18799`, `WebSocketManager.ts:316`) refuse a session token, which is the wanted result. Absence of an audience on a request is never read as owner; only the agent's own token is. `serendipity-capture.sh` gets its existing `SERENDIPITY_SIGNING_KEY` rather than deriving from the env token.

There are no history routes on the list. A session gets its place's history in its bootstrap message. `/commitments` returns every row and `/topic/context?assembled=true` runs working memory, so neither is safe. `POST /app/session-reply` refuses `files` from a session token, because the server reads those paths with its own reach. Accepted cost: a person's session cannot send files through the app.

### 6. Keeping owner stores clean

- Generated hooks skip reading `.instar/MEMORY.md` and listing it and `USER.md` for `person`, `place` and `none`. Their API-backed sections need no branch: the session token is refused there and `curl -sf` stays silent. Sessions from before the update are retired at boot, so there is no session left with the old reach and no variable.
- `SessionActivitySentinel` skips `person`, `place` and `none` sessions, so their output does not become digests.
- `PreCompactionFlush` does not run for scoped sessions, because its route is not on the allow-list.
- `spawnSessionForTopic` injects a person's profile server-side (`server.ts:1400`). In a `place` or `none` session it injects only name and permissions; bio, interests, relationship and custom fields are for `person`, `owner` and `open`.
- Automatic scheduler notices to a place with other readers carry job name and status only, never output (`JobScheduler.ts:3071`). This goes by the destination's audience, not the multi-person flag, so a one-person agent with a busy channel is covered too.
- Message logs are unchanged. Jobs read them with owner reach and write to owner stores.

### 7. Old memory

Legacy memory is owner scope. On an agent whose owner works only in a group with others, the owner has no private place, so it is unreachable there until the operator sets `sharedMemoryPeople` or the owner uses a private place. The flip's attention item says this and gives both options. Operator direction 2026-11-03: hidden by default; Luna is named explicitly.

### 8. Config and rollout

`memoryPrivacy: { enabled, ownerUserId?, sharedMemoryPeople?, privateGroups? }`. Off by default for every agent, new and existing: it is on only when an owner sets `enabled: true` (section 4, "No agent is restricted by an update", Justin 2026-11-04). With it on, `open` still makes it inert for single-person agents.

`PostUpdateMigrator`: `migrateConfig` writes `enabled: false` where it is missing, and the code reads a missing value as off without relying on that; `migrateHooks` overwrites generated hooks and scripts; `migrateClaudeMd` adds an awareness section (template too); the bubblewrap profile attempt. When an owner turns it on for a multi-person agent, the next boot applies the flip handling in section 3.

Rollback: `enabled: false` restores today's behaviour for new sessions; scope folders are left in place and simply not loaded. A version downgrade ends session tokens; sessions respawn with the agent token.

Multi-machine: enforcement is per machine and needs no replication. An older peer enforces nothing, so a multi-person agent with a peer on an older version raises one attention item until that peer updates. That is a remaining gap on such agents during a rollout.

## What a confined session can make the server do

A confined session is sandboxed, and the server that serves it is not. Anything the session can write or report is untrusted input to the server:

- On the hook route a scoped session speaks only for itself, whatever the address names.
- A session id must be a plain id before it is stored or passed to a launch. It reaches a command line and a file path, so a leading dash, a slash or a dot is refused at each point.
- The server never writes through a link in a scope folder. `.curlrc` is staged and renamed over, and a link or file where `inbox`, `tmp` or `.curl` should be is moved aside.
- A confined session never feeds agent-wide digests, on the periodic scan or at session completion.

## Decision points touched

| Decision | Classification | Justification |
|---|---|---|
| Audience, owner and route table | invariant | Deterministic boundaries on identity, not content checks, failing closed, so they hold authority legitimately under Signal vs Authority. An LLM here would weaken the boundary |
| Multi-person detection | invariant | Counts of configured and observed people; deterministic |
| Reader count per place | invariant | A platform count; no fresh proof means shared |

> Each audience decision is logged in one structured line (session, place kind, audience; no content), so "why did it forget" can be answered.

## Symbol vs state (P20)

| Detector | Symbol | State | When they diverge |
|---|---|---|---|
| Multi-person | Allowlists, profiles, phones | Humans who can reach the agent | Observed senders flip it, before routing; unlinked ids raise an attention item |
| Reader count | Platform member count, `is_private` | Humans who can read the place | No fresh count means shared; join events refresh at once |
| Sandbox working | A real probe | Session cannot read denied paths | Every scoped spawn has `failIfUnavailable`; a live canary reads a marker and must fail |
| Hook gate | `INSTAR_MEMORY_SCOPE` | Session's audience | The value is set at spawn; old sessions are retired at boot, and routes refuse by token regardless |

## Maturation plan

- **test-agent-live:** the E2E on the production wiring path, plus a live run on a throwaway Ubuntu server and with two real Slack people on a test agent: fresh session, shared channel, a session told the path of another person's folder, and a brand-new user.
- **ladder:** memoryPrivacy
- **dev-agent-live:** an owner opts a development agent in with `memoryPrivacy.enabled: true` and a restart. The first is the nimbus test agent (Linux), with two real Slack people, after a release carries PR 2766. On every other agent, an update leaves the setting off and sessions start unchanged.
- **fleet:** stays off by recorded preference: `final: default-off-by-preference` in `src/data/feature-ladders.json`. Decided by Justin on 2026-11-04 in topic 137333, after 1.3.1652 restricted Luna: a feature that can refuse or wall off working access is the owner's choice, never an update's (class: opt-in cost). It stays available to every owner who turns it on and keeps its thresholds; a later move to default-on for new agents would be a new decision, recorded the same way.
- **graduation criterion:** for the dev rung, the feature's own record: scoped sessions started and replies delivered from them, with no reply lost to the sandbox and no owner locked out (thresholds in the ladder entry). Before that: the two-person Slack proof passes on nimbus and Luna's retest passes. 2026-11-04 status: privacy held on nimbus, but on Linux no reply was delivered (fb-0fd50d5c-bad); PR 2766 fixes that and was proven on a throwaway Ubuntu server. The Slack rerun waits for its release.
- **dark-window:** the dev rung must have its Slack proof by 2026-11-06. If it misses that, the new date goes in the ledger under a 137333 heading by 2026-11-05. Until the feature records evidence (tracked in the ladder entry), the dev rung is read from that proof and the ledger, not from logs.

## Multi-machine posture

Machine-local by design for scope folders: replicating them means copying private facts across machines through a sync path built for shared state. The standards gate flagged this and it is an accepted cost. Audience is computed per spawn from the place. Older peers are in section 8.

## Testing

- Unit: audience table, both sides of every boundary; detection and flip; reader count failure; settings file; token lifecycle.
- Route classification test across all routers.
- Integration: session token against allowed and refused routes.
- E2E: production init with two people. **Standing regression:** two people plus a brand-new user with no memory (Dawn: that is how Portal's second leak was found). Single-person agent: byte-identical launch arguments and environment to today.
- Live: two real people on a test agent. DM; shared channel with the fact's owner asking while someone else is present, and someone other than the owner asking (Luna); a session told the path of A's folder, backups, logs and credential store; A saves a file and B searches for it; macOS and Ubuntu.

## Open questions

None.
