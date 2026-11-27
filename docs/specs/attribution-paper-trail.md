---
title: "Attribution paper trail: statements credited to a person resolve to the logged message"
slug: "attribution-paper-trail"
author: "echo"
eli16-overview: "docs/specs/attribution-paper-trail.eli16.md"
review-convergence: "2026-11-05T19:18:42.019Z"
review-iterations: 5
review-completed-at: "2026-11-05T19:18:42.019Z"
review-report: "docs/specs/reports/attribution-paper-trail-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 7
cheap-to-change-tags: 3
contested-then-cleared: 3
parent-principle: "Verify the State, Not Its Symbol"
parent-principle-fit: "A note saying a person ruled something is a symbol of that state; this ties the symbol to the logged message that would prove it, and labels it when nothing does."
approved: true
approved-by: "echo, under the standing rule that only constitution changes need the operator: 'I should ONLY have to approve constitution changes' [source: telegram 128243/128909 2026-10-22]. The rule this spec enforces was approved separately [source: telegram 136110/139199 2026-11-05]."
---

# Attribution paper trail

## Problem statement

Case study: `.instar/lanes/case-study-false-attribution-laptop-rule.md`. A note written 2026-07-30 said "Justin corrected me" with no pointer. By 2026-11-04 it read "Justin's standing rule", the agent told him it had broken "his rule", and it refused real work because of it. When asked, he answered: "This doesn't sound like anything I said, and that worries me" [source: telegram 136110/139070 2026-11-05]. A hand check of 36 high-risk notes found 8 drifted and 4 where no source was found, 2 of those in a record gap.

The requirement: "INSTAR should have extremely robust requirements and infrastructure that can do exactly as you said for every agent for every scenario, which is that it can tie back a paper trail of evidence to a specific conversation that is logged and recorded on how a statement or proclamation, originated, and evolved" [source: telegram 136110/139097 2026-11-05].

Today nothing asks for the source when a note is written or cited. "Cite Without Source" and "Inherited Claims" are prose (`src/scaffold/templates.ts`). `Truthful Provenance` covers who a delivered message is from, not a later claim about what someone said.

## Goal

Any statement credited to a person, in an agent's memory, notes, rules or messages, either resolves to the logged message it came from, with its later versions visible, or says plainly that it has no source. It works on every channel with a log, on one machine or many, and needs no purchased service.

## Proposed design

One service, used at write time, at send time, and by a daily report.

```
           AttributionService.check(text, surface, context)
              |              |                |
     write gate (hook)  send gate (B23)   audit report
              \              |                /
         SourceResolver + AttributionJudge + AttributionLedger
```

### 1. The marker and the one label rule

A sourced statement holds the person's exact words in quotes, then a marker on the same line:

`Justin: "at least every hour and a half or so or two hours" [source: telegram 102965/123160 2026-10-08]`

Grammar: `[source: <channel> <conversation>/<message> <YYYY-MM-DD>]`, the date being the record's UTC date. Channels: `telegram`, `slack`, `imessage`, `whatsapp`, `app`, `threadline`. Conversation and message ids are `[A-Za-z0-9._:+-]{1,128}`; anything else is percent-encoded. The date is part of the format so a ref can be classified after its row has rotated out of the log.

An unsourced statement carries `[source unknown]` or `[my inference]`.

**The label rule (one policy on every surface).** A label removes the credit; it does not decorate it. `Justin's standing rule: X [source unknown]` still credits him and is refused with `promoted-unsourced`. `X. An earlier note credited this to Justin; source unknown. [source unknown]` passes. Honest labelling always has a way through, and the refusal text shows that rewording.

Fragment quotes do not launder a rule: the judge rules on the quote together with the whole line and its neighbours, so `Justin: "on the laptop" [source: …] NEVER spawn there` fails as `overstated`.

### 2. SourceResolver (`src/core/attribution/SourceResolver.ts`)

`resolve(ref)` reads that channel's existing log by streaming the file (measured on Echo: 143MB, 975ms warm). In-flight lookups are de-duplicated and a parsed result is cached by file size + mtime.

**Who wrote this record: a per-channel table, no new writers.** `fromUser` is never evidence. Only Telegram rows hold `provenance`, so each channel has its own proof, and each result carries a `strength`:

| Channel | Store and key | The record is theirs when | Strength |
|---|---|---|---|
| telegram | `telegram-messages.jsonl`, topicId + messageId | `provenance === 'user'`, `forwarded === false`, identity maps, and `AspAuthorshipJoin` says `human` | `verified` |
| telegram | same | as above, but the join says `unclassifiable` (pre-2026-08-19) or `UNRESOLVED` | `logged-unclassified` |
| telegram | same, `via: 'mobile-device'` (no `forwarded` field; sent from the app) | `provenance === 'user'`, identity maps | `identity-only` |
| slack | `slack-messages.jsonl`, channelId + messageId | inbound row, `platformUserId` maps | `identity-only` |
| imessage | `imessage-messages.jsonl`, channelId + messageId | inbound row, `platformUserId` maps | `identity-only` |
| whatsapp | `messages.jsonl`, channelId + messageId | inbound row, `platformUserId` maps | `identity-only` |
| app | `AppConversationStore`, conversation + eventId | `role === 'operator'`, `senderPerson` maps; tombstoned or purged resolves `removed` | `identity-only` |
| threadline | `ThreadLog`, threadId + seq (path-confined) | `direction` inbound, `peerFingerprint` maps to a known agent. The person is that agent, never a human it relays | `identity-only` |

**Identity maps** through `UserManager` or, for the owner, through the existing owner resolvers (`resolveApprovalOwner`, `readPairingOwnerName`, which refuse ambiguity), the owner's Telegram id and `mobilePairing.slackOwnerUserId`. A second verified operator is not the owner. Echo has no `users.json`, so the owner path is the live one. A logged display name alone never maps: it returns `identity-unverified`, which needs `[source unknown]`. A channel with no owner id on file reads `identity-unverified` until one exists.

`logged-unclassified` passes but is shown as weaker in the trace and never reported as human. A peer returns its own ASP verdict with the row, because that ledger is per machine, and the weaker of the two verdicts wins; a peer's `agent-verified` is never re-read here as a gap. No strength is authority by itself: the judge's `own` ruling is also required, because agent text can arrive under the person's real account (pastes, session prompts).

**Earlier than the claim.** The record must predate the claim's first-seen time: its lineage root in the ledger, else the file's first git commit holding the line, else unknown. A record later than a known first-seen is refused as `later-than-claim`. Predating a claim does not prove the claim came from it, so `relation: origin` is written only when the marker was there from the claim's first version. A source attached later, or any match the audit reports, is `relation: reconstructed`, which means "these words support it", not "this is where it came from". The trace shows that difference and when the source was attached.

**Outcomes stay distinct:**
- `found`
- `not-found`: every live machine answered 2xx and the ref's date is inside each one's retained range. A retired machine cannot be ruled out, so the report says "not found on any live machine" and never says "false".
- `unverifiable`: the date is older than a machine's oldest row, or falls in a declared `attribution.recordGaps` range, or the row has rotated.
- `unreachable`: a machine did not answer or returned non-2xx.
- `removed`: the person deleted it. The pin is dropped.

An **existing** marker is never refused for `unverifiable` or `unreachable`; those are recorded and re-checked by the next audit. A **new or changed** marker needs more, or an agent could invent a ref dated inside a gap: if it is `not-found` or `unverifiable`, and no pin or ledger row already holds that ref, the judge is told it cannot be shown, and the honest way through is `[source unknown]`. A new marker that is only `unreachable` passes but its ledger row reads `relation: unconfirmed`, not `origin`: passing is permission to write, not proof. The trace and report show it as unconfirmed until a machine shows the row.

**Peers.** Parallel fan-out through `poolPeerFetch` with one shared 6s deadline, `isPeerUrlAllowedForCredentials`, `redirect: 'manual'`, at most 16 peers, 512KB per response. `GET /attribution/resolve?scope=local` answers locally only and never fans out. Eligibility is re-run locally on anything a peer returns. A negative result is cached for 5 minutes.

**Pins.** The first verified resolve copies the row to `<state>/attribution/pins.jsonl`, keyed by ref, 0600, text through `scrubString`, loaded to an in-memory map. The `attribution/` directory is added to `BackupManager` defaults, since a restore without pins would turn good citations into uncheckable ones. Deletion is known only where a channel records it: today an app `tombstone` or `purge` event, which takes precedence over a pin and drops it, on the machine that holds it and on peers at next resolve. Elsewhere a pin answers as `pinned-copy`, which says the row is no longer in the log and cannot tell why. Nothing is ever evicted: the in-memory map holds the newest 20k, older ones are read from the file on a miss.

**`find(person, claim, around?)`** suggests sources. It filters to eligible records for the person, widens by date and topic when the note names them, searches through `TopicMemory`, and has the judge rerank a capped candidate set. `/semantic/search/hybrid` is not used: it searches stored entities, not message logs. A miss is `no-literal-match`, never absence, and it never produces a label by itself. It reads local logs plus peers through the same fan-out, and reports which machines did not answer.

### 3. AttributionLedger (`src/core/attribution/AttributionLedger.ts`)

Append-only `<state>/attribution/ledger.jsonl`, 0600, text scrubbed. A row is written only when wording or verdict changes:

`{ id, claimId, parentClaimId?, linkedBy?, ts, machineId, surface, path?, person, claim, kind, ref?, quote?, verdict, reason, relation, strength? }`

**Lineage.** `claimId` identifies a claim across rewordings; `id` identifies one check. A new statement inherits `parentClaimId`:
- `linkedBy: edit` when an Edit's `old_string` held the parent (exact);
- `linkedBy: judge` when the judge matches it to an earlier claim about the same person and subject, shown as inferred in the trace. Candidates come from peers' local answers as well, since the note and the later copy can be on different machines. This runs in the background after the verdict and retries if a peer is unreachable, so it never slows a write. A newly found parent is an append-only row, and it triggers a re-check of the earlier-than-the-claim rule against the older root; a changed verdict is another row and goes in the report.

`GET /attribution/trace?claim=…|ref=…|q=…` returns the origin record, then every row in order, merged across peers, with a `failed` list and pagination. That is how "corrected me", then "standing rule", then "I broke your rule" reads as one visible chain. Rows are written at note-write time and at send time, in every mode except `off`. A refused attempt is kept for diagnosis but never becomes a claim's first-seen time or a parent. A write that passed the gate and then failed is rare; the audit's read-back marks a row whose text never reached the file. The audit seeds a `reconstructed` root row for each older note it reads, so a note with no ledger history gets one.

Rotation at 50k rows into gzipped archives that are kept, never deleted (Archiving May Never Mean Deleting); a trace reads live files first and archives only when asked. Pins live separately so rotation cannot carry them forward. Rows before the ledger existed have no lineage, and the trace says so.

### 4. AttributionJudge (`src/core/attribution/AttributionJudge.ts`)

`ctx.intelligence` on the balanced tier (the fast tier failed the 2026-11-06 replay on both Codex and Claude), as a `gating` call, with text and log rows in an untrusted-data envelope. Provider failure uses the router's normal failover. No new purchase: it is the agent's own subscription.

**Its own queue and budgets.** A dedicated `LlmQueue` instance, as the metered verifier in `AgentServer.ts` has, so it cannot be aborted by interactive callers or consume the shared background share. Budgets are per use and persisted to `<state>/attribution/budget.json`, so a restart does not reset them: write gate 200 a day, audit 40 a run, send record 300 a day. Echo sends 225 to 943 non-user messages a day, so the send record runs only when a cheap prefilter sees a known person's name or a credit word (said, told, rule, asked, agreed). That filter only saves money and it can miss. `/attribution/status` reports what it skipped and the misses the audit's sample finds, as an estimate. Over budget means `unchecked`, counted.

- **Extract:** each span crediting a person with a statement, rule, decision, preference or instruction, and each refusal resting on an unsourced rule, person named or not: `{ span, person | null, kind, markerIndex | null, labelled, parentHint? }`. A span not verbatim in the input is dropped.
- **Support:** `{ ownWords: own|relayed|unclear, faithful, why }`. `faithful` is false when the line is stronger, wider or more permanent than the words.

Not an attribution: the agent's own conclusions; quotes of public text; reporting that someone sent a message without saying what it meant. A past-tense recap of the current conversation is exempt **on the send surface only**, where the recent messages are supplied. In a note it is always an attribution, because "Justin corrected me" is how the case study began.

Input is capped at 16KB, chunked at paragraph boundaries; per-check cap of 8 markers. Exact facts run first and need no model: marker parses, marker date equals the record's date, record resolves, quote is a normalized substring (whitespace, curly quotes, case). A marker that does not parse is rejected outright as `malformed-marker`: that is structural validation of a format (`STANDARDS-REGISTRY.md`, the moving threshold; `docs/signal-vs-authority.md`, hard-invariant validation). The rest are evidence requirements for a sourced claim: while the judge is running, a wrong date, a quote not in the record, or a marker with no quote beside it is refused, so a displayed citation is never known to be wrong. Signal vs. Authority says a matcher gets no veto when the gate is absent, so with no model these pass as `unchecked` (below). The judge rules on meaning: own words and faithful. `cannot-be-shown` applies once the judge has found a claim resting on a new marker no machine can show.

**Verdicts:** `pass` | `refuse` with one line per failing claim: `malformed-marker`, `unsourced`, `quote-not-in-record`, `date-mismatch`, `record-not-theirs`, `identity-unverified`, `relayed`, `overstated`, `promoted-unsourced`, `later-than-claim`, `cannot-be-shown`. Or `unchecked`.

**With no model after failover:** the write passes as `unchecked`, with the exact-fact results recorded, reported to `DegradationReporter` and counted in `/attribution/status`. This is a stated exception to fail-closed for gating calls, entered in `no-silent-llm-fallback.test.ts`: failing closed would block every memory write during an outage, which is a far worse harm than a claim the audit re-checks later.

### 5. Consumers

**Write gate.** PreToolUse hook `attribution-gate.js`, on Claude Code (`Write|Edit|MultiEdit`) and on Codex through `installCodexHooks` (`apply_patch`, timeout set explicitly). If `apply_patch` turns out not to fire PreToolUse in the live check, the audit is Codex's floor and a commitment tracks it. It exits at once for an out-of-scope path (matched after realpath, since the memory folder is a symlink) and otherwise calls `POST /attribution/check`.

The judge sees the resulting document's changed blocks with their headings, not a fragment, so changing only a heading to "Justin's standing rules" is seen. Only changed lines can be refused: Edit is diffed against `old_string`, Write against the file on disk.

Default scope: the memory directory, `.instar/MEMORY.md`, `.instar/USER.md`, `.instar/AGENT.md`, `.claude/rules/**`, and `CLAUDE.md` outside instar's managed region. `attribution.paths` extends it (lanes are opt-in), confined to resolved roots under the agent home.

On refusal it returns the failing lines, the two honest ways through, and up to 3 suggestions from `find` only if time is left: the verdict comes first. Measured here, a comparable call takes 7s at the median and 20s at p95, so an unsourced note needs one call and a sourced one two. Budget 20s, on the feature's own queue; on any error or timeout the hook passes, and the server records the timeout as the outcome and counts it. In `record` mode the hook does not wait: it posts and exits.

**Send gate.** New tone-gate rule `B23_UNSOURCED_ATTRIBUTION`, `advisory`, beside B21/B22, reaching every channel through `checkOutboundMessage`. It receives a signal `attributionSources`, always present, valued `resolved | unmeasured` with per-marker results; the crediting condition below uses it only when `resolved`, and marker checks have a 6s sub-budget inside the 20s route budget. It fires when:
- a message credits a person with a statement, rule or standing instruction not visible in the supplied recent conversation and not sourced by a resolved marker;
- a refusal or block rests on an unsourced rule, **whether it names a person or not** ("that's a standing rule, so no", "we agreed", "policy"). That message must say the rule is the agent's own.

The two conditions are decided separately. With no conversation context the "visible in recent conversation" condition is `unmeasured` and does not fire. The refusal condition needs neither context nor marker results, so it always runs. Applies to `reply` senders that can react. The agent revises, or answers with `--tone-ack` and a recorded reason.

**Send-side record.** After delivery, a background call extracts credited spans and writes ledger rows with lineage, in `record` and `enforce`. Never blocks a send.

**Threadline.** `/threadline/relay-send` runs `check` alongside the send, not before it, because the route's reply wait leaves only 20s of margin. Findings return in the `advisory` field the MCP client already forwards, plus a ledger row. It never holds a peer message. This is the "Justin authorized" case told to a peer.

**Memory routes.** `POST /semantic/remember`, `/evolution/learnings`, `/evolution/actions` run `check` in the background and write the result to the ledger; the route is not slowed and stored text is not changed. The audit report lists what it finds.

**Audit, report only.** `AttributionAudit`, a server poller once a day on the `background` lane, reads in-scope files and writes **nothing to any note**. It hashes each block with its heading and neighbouring lines, so a changed heading re-checks the lines under it. It runs up to 40 judge calls per run, split so nothing starves: 20 for new blocks that pass the same cheap filter as the send record (memory first, then oldest-unchecked), 10 for a rotating sample of blocks the filter skipped, which is what makes the filter's miss rate measurable, and 10 for retries. It and stores a hash only after a successful judgment. A claim whose last outcome was `unreachable`, `unverifiable` or `unclear` is retried regardless of its hash, with its interval doubling up to 30 days so a permanent gap cannot use up the retry budget, and at once when a machine that was down returns. `unchecked` rows from any surface hold their text and context in the ledger, so the audit re-judges messages and memory submissions too, not only files, oldest first within the budget. Next-day checking is a target, not a guarantee: `/attribution/status` reports backlog age. The breaker re-opens after 24h. Backoff doubles on failure up to 24h; after 3 failed runs a breaker stops it and reports to `DegradationReporter`. Results go to `<state>/attribution/report.json`: unsourced, false citations, suggestions, backlog size. `GET /attribution/status` serves that plus hook timeouts, `unchecked` counts and judge error rate.

Fixing notes is a session's job, so every correction passes the write gate like any other edit. A job `attribution-review` spawns a session to work through the report; it is on whenever mode is `enforce`. The session-start hook shows the backlog count, so the report has a reader. Nothing rewrites memory on its own, so a wrong model pick can never appear as a verified citation.

### 6. Modes

`attribution.enabled` is omitted from config so `resolveDevAgentGate` resolves it (a boolean), and `attribution.mode` is `record` | `enforce`, default `record`. Disabled is `off` below. In `record`, B23 is off, and the send record's verdict is the would-hold measurement.

| | write gate | B23 | ledger + send record | audit report |
|---|---|---|---|---|
| `enforce` | refuses | advisory hold | yes | yes |
| `record` | records, hook does not wait | off | yes | yes |
| `off` | none | off | no | no |

Dev agents get `record`, then `enforce` after the shadow step below. The fleet stays `off` until graduation, then `record`. `enforce` is opt-in for every existing agent; updates do not add restrictions to them. Basis: "existing agents should NOT be restricted by privacy updates" [source: telegram 136110/137818 2026-11-04]; widening that from privacy updates to any update is my inference, recorded in `updates-never-restrict-existing-agents`. Default for a newly created agent changes only at the graduation below.

## Decision points touched

| Decision | Class | Floor + arbiter |
|---|---|---|
| Marker does not parse | invariant | Structural validation of a format; refused, with the labels as the way through. |
| Date matches, quote is a substring, record exists | invariant | Evidence requirements for a sourced claim, enforced only while the judge runs. With no gate they do not refuse. |
| Record eligibility per channel and strength | invariant | Fields only; name-only never maps. Strength is reported, and is not sufficient without the judge. |
| Own words, faithful, is this a credit, new-citation refusal, lineage match | judgment-candidate | Floor: label path always open; `unchecked` when no model or over budget. Arbiter: `AttributionJudge`. |
| Refuse a note write | judgment-candidate | Floor: `enforce` only; hook passes on error, timeout or no model, counted and reported. Arbiter: judge, with invariant results as signals. |
| B23 hold | judgment-candidate | Floor: reasoned ack always delivers. Arbiter: tone gate, the existing single authority. |
| Which suggestions are shown | judgment-candidate | Floor: suggestion only, no label or marker written from it. |
| Send-record prefilter | judgment-candidate | Floor: a miss loses only a history row, disclosed by count. Argued exemption from a model: it spends nothing and blocks nothing. |
| Which path is in scope | invariant | Config list, realpath-confined. |

## Signal vs authority and verify the state

`attributionSources`, `strength` and recall ranking are signals. Exact facts are evidence requirements that apply only with the gate running. Only the judge and the tone gate rule on meaning. The audit decides nothing and writes nothing to notes.

**Verify the state, not its symbol:**
- `provenance:user` / `role:operator` / `platformUserId`: symbol. Claimed state: "this person typed this". Corroboration: identity map plus the judge's `own`. Unmeasurable: `unclear` from the judge fails to `unchecked`, not `own`.
- `[source: …]`: symbol. Claimed state: "this person said this first". Corroboration: full check at every write and send; pins answer only for rotated rows. Unmeasurable: `unverifiable`.
- `[source unknown]`: claims nothing, needs nothing; `promoted-unsourced` guards the wording around it.
- Stored block hash: symbol for "judged". Written only after a successful judgment, so a failure is re-checked.
- A silent gate: `/attribution/status` counts timeouts and `unchecked`, so "no refusals" is distinguishable from "gate not running".

## Multi-machine posture

Ledger and pins: **proxied-on-read** through peer fan-out on `/attribution/trace` and `/attribution/resolve`, reporting `unreachable` for a down machine rather than absence. Evidence held only on a down machine is unavailable until it returns, and citations to it stay `unreachable`, not false. Moving these to a replicated kind on the existing replicated-store foundation is required before the fleet rung (see Maturation plan).

Audit report: proxied-on-read. The audit runs on one machine at a time through the existing lease, so shared notes are not judged twice. It writes no shared state, so `MEMORY.md` and `CLAUDE.md`, which are `must-be-coherent`, gain no second writer. The feature sends no notices, so one-voice is untouched.

## What this does not do

- It cannot prove a real sentence was meant the way a note reads, beyond the judge's ruling.
- Shell writes to notes are not gated at write time; the daily audit reports them. The same holds for sessions on Gemini CLI, Grok Build or instar-native until they have a PreToolUse equivalent, so the audit is their floor; a commitment tracks parity.
- **Declared gaps, each with a tracked close path:** terminal input, email and lines the owner wrote by hand have no marker kind yet, and sit outside the audit's report of false citations but may show as unsourced; `.instar/preferences.json` carries no source ref; the memory routes warn and do not refuse. A commitment is opened for each at ship.
- A rule with the credit removed and no reason ("NEVER POST…") is caught when it is used to refuse (B23), not when written.
- Stored rows are not tamper-proof. An agent editing the ledger is outside this threat model.

## Frontloaded Decisions

1. Fleet default is `off`, then `record` at graduation. `enforce` is opt-in for existing agents. See section 6.
2. B23 is `advisory`. A wrong hold on an urgent message costs more than a nudge, and the ack is recorded.
3. No new log store and no new provenance writers; the per-channel table is the proof. Stamping can strengthen it later without changing the format.
4. The audit writes nothing to notes.
5. Marker includes a date, fixed now because it is an on-disk format.
6. Budgets: write gate 200 a day, audit 40 a run, send record 300 a day, kept separate so sends cannot starve the write gate.
7. Cheap-to-change-after: suggestion count, in-memory pin map size, ledger rotation size. Each only affects local caches and the ship is behind a dark fleet gate.

## Maturation plan

- **ladder:** attribution.paper-trail
- **test-agent-live:** On a throwaway agent, run hook refusal and pass, a live Codex `apply_patch` write, B23 hold and ack through real Telegram and Slack messages, a peer lookup with one peer down, and a replay of the 36 hand-checked notes plus the note-check results as a labelled set.
- **dev-agent-live:** Echo in `record` for 72h of real writes and sends, with would-hold verdicts taken from the send record, comparing every would-refuse against the labelled set and a sample read by a session. Then `enforce` on Echo.
- **graduation criterion:** Replay plus shadow shows at most 5% false refusals and catches at least 80% of the labelled false credits, the judge's error rate stays under 5%, hook timeouts under 2% of checks, and the ledger and pins are moved to a replicated kind. Numbers are inputs to a reviewed decision, not an automatic switch.
- **fleet:** After graduation, `record` for all agents through `migrateConfig` and `enforce` as the default for newly created agents. Existing agents keep `record` until their owner opts in.
- **dark-window:** Dark on the fleet at most 30 days from merge. A monthly maturation review either moves it forward or writes down why not.

## Open questions

*(none)*

## Left behind

Converged at the round cap set for this work; these are accepted, with reasons:

- Peer deletion status beyond app tombstones: other channels record no deletion, so a pin answers as `pinned-copy`.
- Pins and ledger quotes outlive a removed row in archives until the replicated-kind rung; the row stays private to the agent and scrubbed.
- Budget sizes are estimates from one agent's traffic; `/attribution/status` makes a bad estimate visible and they are one config change.
- `find` quality is unmeasured until live use; it only suggests.
- Further outside findings past round 5 were not iterated on. Each round's findings had narrowed from the design's core to edge cases and lifecycle details, and live use will test the rest.

## Rollback

`attribution.enabled: false` stops every consumer at once. Nothing was rewritten in any note by the system, so nothing needs restoring. A PR revert removes the code; the migrated hook entry passes when its route is gone.

## Testing

- Unit: marker grammar; per-channel eligibility on real row shapes (agent posts under the person's account, a paste, ASP-wrapped row, legacy rows, name-only Slack row); strength; earlier-than-claim; outcomes including rotated and gap; quote normalization; judge parsing with invented spans; lineage by edit and by judge; ledger rotation; audit hash not stored on failure, backoff, breaker; modes.
- Integration: all routes through `createRoutes`; `checkOutboundMessage` with B23 both signal values; relay-send warning; route overrun; peer fan-out with one peer down and a 404 peer reading `unreachable`; no peer recursion.
- E2E: production init path, feature alive (200, not 503) and dark on a fleet config; hook refusal on a credited write, pass on a labelled one; heading-only reattribution; the laptop-rule chain as the regression case on real data shapes.
- Wiring: deps not null or no-ops; `MessagingToneGate` receives the signal; Codex hook registered.

## Agent awareness and migration

Template: Capabilities, Registry First ("who said this" → `/attribution/trace`), Feature Proactivity, plus `migrateClaudeMd`. Hook always-overwrite through `migrateHooks`, settings in `migrateSettings`, mirrored in `init.ts`, `settings-template.json`, `builtin-manifest.json`, `installCodexHooks`. `migrateConfig` adds only missing fields. `CapabilityIndex` entries, `devGatedFeatures` entry, `feature-ladders.json` entry, `state-coherence-registry.json` entries, `BackupManager` defaults.
