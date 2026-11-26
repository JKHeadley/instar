---
title: A queued or forwarded agent-signed message keeps its agent label (SEC-106)
slug: queued-signed-inbound-label
eli16-overview: queued-signed-inbound-label.eli16.md
status: approved
approved: true
approved-by: "echo-chief-of-staff"
approval-note: "Chief of Staff brief 2026-11-18 07:28 PST to the security owner (topic 143781): one round 7 scoped to decision 5a; if the raising reviewer concurs, tag and build. Round 7: all three concur."
author: echo
created: 2026-11-18
parent-principle: "Know Your Principal — An Unverified Identity Is a Guess"
review-convergence: "2026-11-18T15:30:46.522Z"
review-iterations: 7
review-completed-at: "2026-11-18T15:30:46.522Z"
review-report: "docs/specs/reports/queued-signed-inbound-label-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
---

# A queued or forwarded agent-signed message keeps its agent label (SEC-106)

## Why this exists

An agent can sign a message and send it through a human's Telegram account (the ASP "tenet-5
channel"). At log time the ASP classifier verifies the signature and remembers the verdict
in-process (`AspInboundClassifier.recent`, 1,000 entries, keyed by topic and platform message id)
and in its durable ledger. On the LIVE path, `server.ts` (~3048-3060) reads that verdict with
`resolveSignedByAgent`, writes it to `msg.metadata.signedByAgent`, skips operator auto-bind (~3078),
and passes the label to `injectTelegramMessage` (~3505-3522), whose tag reads
`from agent <id> (signed) via <human>'s account`.

Every other way the same message can reach a session drops the verdict, so the session is told the
human wrote it (authorship laundering; the agent text may carry relayed outside content). The ASP
label's own side-effects review already named the queue path as a residual
(`upgrades/side-effects/asp-signed-inbound-label.md:28`); this spec closes it and the rest:

| Path | Where | Today |
|---|---|---|
| A. Queue drain, live session, local inject | `server.ts` ~3850-3874 | `injectTelegramMessage(...)` with no options |
| B. Queue drain, no live session: respawn / spawn | `server.ts` ~3910-3920, ~3970-3990 | first message built bare, under "The user's latest message:" |
| C. Live path, session dead or missing: respawn / spawn | `server.ts` ~3584, ~3615, ~3704 | same |
| D. Mesh `deliverMessage` receiver (owner machine): inject ~29747, spawn ~29774, dashboard-start waiter inject ~29808 | `server.ts` | no label, no sender name or id |
| E. Admission-refused re-place (#3376) | `QueueDrainLoop.ts` ~854-870, then A/B or D | carries the envelope, which has no label |
| F. Stuck-message replay (`reinjectStuck`) | `server.ts` ~37035-37058 | re-enters ingress as `replay-<dedupeKey>` with `viaLifeline: true` and no `telegramMessageId`, so the ingress block finds no platform id and strips the label |

Two classifier facts make even the live path fragile: `classify()` always calls `remember()`, so a
second classification of the same (topic, id) (a lifeline re-forward reaching `logInboundMessage`
again, whose nonce is then already used) overwrites `agent-verified` with `rejected`, and the routed
copy then reads no label.

The persisted envelope (`InboundSenderEnvelope`, `SessionRouter.ts:52`, mirrored by `SenderEnvelope`,
`PendingInboundStore.ts:45`; stored as JSON in `sender_envelope`, forwarded whole over the mesh)
carries `userId`, `firstName`, the mobile-device fields and `personKey`, but no label.

Severity: low-medium (ledger SEC-106). The classifier and the label are signal, not authority; the
harm is a session treating agent text as the human's instruction.

## The rule

The agent label is decided at Telegram ingress, from the classifier's own verdict, and then travels
with the message to every injection or first message, on every machine. Message content, a queue
row's payload, or anything outside the envelope field cannot mint it. Operator auto-bind stays
decided at ingress (~3078; `routes.ts` ~31570) and is never re-read from the envelope: the envelope
label changes the session's framing of the message and nothing else.

## Frontloaded Decisions

1. **Carrier: a new optional field `signedByAgent?: string`** on the THREE sender-envelope types:
   `InboundSenderEnvelope` (`SessionRouter.ts:52`), the queue's `SenderEnvelope`
   (`PendingInboundStore.ts:45`) and the processing ledger's `SenderEnvelope`
   (`MessageProcessingLedger.ts:66`, read by stuck-message replay), as `personKey` was added to two
   (team-roles-and-access §3.6). No queue schema change (JSON column). No mesh schema change: the
   envelope is forwarded whole, `validateSender` reads only `userId`/`via`, and an older receiver
   ignores the field.
2. **Writers.** Exactly four places put the field into an envelope:
   (a) on this machine, one helper `telegramSenderEnvelope(msg, pipeline, telegramUserId)` builds the
   envelope at the four ingress sites (~3331 ordering-behind-queued, ~3355 route, ~3468 and ~3728
   admission-refusal enqueues) and sets `signedByAgent` ONLY from `msg.metadata.signedByAgent`, which
   the ingress block at ~3051 owns (it strips any incoming value and rewrites it from the classifier);
   (b) the mesh receive path stores the envelope a paired peer sent (`queueMessage` ~32640,
   `forceReplace` ~32768) unchanged;
   (c) the processing-ledger entry `reinjectStuck` replays from gets the label in the SAME call that
   creates it. That ledger is written in exactly two places: the lifeline ingress, where
   `decideIngress` records the entry with a `sender` built from the request (`routes.ts` ~31483-31496),
   and the mesh owner's `claimForwardedInbound` (`server.ts` ~29735), which today stores no sender.
   At `decideIngress`, the `sender` gains `signedByAgent` from a read of the classifier's cached
   verdict (a second read of the same cached entry the ingress block reads later, held stable for the
   same message by decision 5), done the same way the lifeline auto-bind check already reads it (`routes.ts` ~31560; `logInboundMessage` has
   run first, ~31414), skipped for app messages (`trust` set). `claimForwardedInbound` gains an
   optional sender envelope and the mesh receiver passes `cmd.senderEnvelope` (label included). No
   later update of a ledger row exists (rows are `INSERT OR IGNORE`); nothing correlates rows by
   topic. The sender column is JSON TEXT (`MessageProcessingLedger.ts:88`), so no migration.
   Allowed writers of the field, pinned by a grep test: the ingress envelope helper, the mesh receive
   store, the `decideIngress` sender, and the `claimForwardedInbound` envelope.
3. **One reader.** `labelFromEnvelope(envelope)` returns the label used for framing. Present and
   valid (`sanitizeSignedAgentId`) → that id. Present but invalid (wrong type, bad charset, too long)
   → `'unknown-agent'`. Absent → `null`. `unknown-agent` is a display value only: the ingress never
   writes it (an ASP agent id equal to it is written as-is, and reads the same, which is harmless:
   both say agent-written).
4. **No drain-time classifier fallback.** The drain does not re-ask the classifier. A message id in a
   queue row is not a safe classifier key (an app message is minted `tg-<server id>` and logged under
   the same (topic, id) key space as Telegram, `routes.ts` ~31595), and no row records which machine
   classified it. Rows enqueued before this change carry no field and drain unlabelled (today's
   behaviour); that window ends when those rows drain or reach the queue TTL. Accepted, with no
   further work planned.
5. **The classifier never downgrades a verdict for the same message, and never classifies app
   messages.** `remember()` stores the sha256 of the classified text with the verdict. A later
   classification of the same (topic, id) with the SAME text hash never replaces an `agent-verified`
   entry with anything else (the re-forward case: same message, nonce already used). A different
   text hash is a different message sharing the key and replaces the entry normally, so no label is
   inherited across messages. Messages from the native app are kept out of the classifier entirely:
   the app forward's `logInboundMessage` entry carries `via: 'mobile-device'` (routes.ts ~31429);
   `AspInboundEntry` (`AspInboundClassifier.ts:35`) gains an optional `via` that the hook fills from
   the logged entry, and the classifier skips such entries (neither classified nor remembered),
   and the ingress block skips `resolveSignedByAgent` when `msg.metadata.viaMobileDevice` is true. An
   app message is the owner's phone by construction and is never agent-signed through Telegram.
5a. **Every classifier READ is bound to the message's text (round 6, unreviewed).** `verdictFor`
   takes the text hash of the message being labelled and returns the stored verdict only when the
   stored hash matches; a mismatch returns null and counts `hashMismatch` in the decision 9 set. Every
   read that labels or gates auto-bind passes it: the `decideIngress` sender read, the route's
   auto-bind read (~31560), and the ingress block (~3051). The hash is taken over the SAME text the
   classifier was given at log time: one helper `aspClassifiedText(...)` builds that form for every
   log site that builds it and for every reader (the hook itself passes `entry.text` through unchanged).
   Plain text and voice log the content as-is. A message with files logs `historyTextFor(caption, media)`
   at three sites: the lifeline route (~31418) and the polling photo and document sites
   (`TelegramAdapter.ts` ~6921, ~7022). The route readers have `fwdMedia` in scope; the ingress block
   recovers the caption from `msg.content` with `stripFallbackSentences(content, metadata.media)`
   (`inboundMedia.ts:108`; the file sentences lead the content, and re-escaping is idempotent), then
   applies `historyTextFor`. A replay (`metadata.replay === true`) that mismatches counts
   `hashMismatchReplay` instead (a replayed Message may lack its media, and its label comes from the
   ledger copy), so `hashMismatch` stays a clean drift signal. A
   test pins that both sides produce identical hashes for plain text, a caption with files and a file
   with no caption. A mismatch fails to null: no label, and, as today on the live path, no block on
   auto-bind; `hashMismatch` moving is how a derivation drift between log and read would be seen. In
   Telegram a (topic, id) names one message; the same key with different text is an edit by the same
   account, or the app id space, which decision 5 already excludes.
6. **The ledger label reaches ingress in-process (replay F and lifeline re-claims), and a replay never
   binds an operator.** `reinjectStuck`
   reads `signedByAgent` from the processing-ledger entry's sender envelope (decision 2c) and sets it
   on the replay Message as `metadata.replaySignedByAgent` ONLY when the ledger value is present (an
   unlabelled ledger entry sets nothing; `undefined` and a missing key both mean absent). It does not
   parse the dedupe key (that key may hold a Telegram update_id, a `tg-<n>` id or an app event id,
   `routes.ts` ~31482).
   The lifeline route does the same for every message `decideIngress` lets through (`process`; for a
   brand-new row the copy equals the classifier read just made, so it adds nothing). It declares
   `ledgerLabel` before the exactly-once gate, and inside the gate reads
   `ledger.get(dedupeKey)?.senderEnvelope?.signedByAgent` ONLY when the row's stored input equals the
   current text (a dedupe key can fall back from update_id to message_id after a lifeline restart,
   `TelegramLifeline.ts` ~118, so two different messages could share a row; a mismatch copies
   nothing) and `trust` is not set (app rows carry no label). It stays undefined when the gate throws
   (fail-open), is skipped, or the sender is untrusted, which matches the classifier-only live path.
   This covers a restart followed by a re-forward of the same update: the fresh classifier sees a used
   nonce and records no verified verdict, but the row still holds the label written when the message
   was first seen. The route then uses `classifier ?? ledgerLabel` for its OWN operator auto-bind
   check (~31560-31570, which today reads the classifier alone) and copies `ledgerLabel` to
   `metadata.ledgerSignedByAgent`.
   The ingress block reconciles with ONE algorithm (decision 10): classifier verdict for the platform
   id if any (`C`), and, when either in-process field is present,
   `labelFromEnvelope({ signedByAgent: <that field> })` (`L`; `replaySignedByAgent` honoured only with
   `metadata.replay === true`). Label = `C` if valid, else `L`; when both are present and differ, the
   label is still applied (classifier id preferred, it is the fresh verification) and the
   disagreement is logged and counted. Ingress uses this reconciled label for its own auto-bind check
   (~3078), so a ledger-backed label blocks binding at BOTH sites. After reading, ingress removes
   `replaySignedByAgent` and `ledgerSignedByAgent` from the metadata, as it already does for
   `signedByAgent`.
   No wire body can set `replay`, `replaySignedByAgent` or `ledgerSignedByAgent`: the lifeline builds
   its Message with fixed metadata (`routes.ts` ~31595-31625), the mesh receiver never calls
   `onTopicMessage`, and every other Message builder sets fixed metadata.
   Replay survives a restart (the ledger is durable; the boot replay is F's main trigger). A replay
   NEVER auto-binds the topic operator: the auto-bind condition (~3078) adds `metadata.replay !== true`
   (a replay is not fresh evidence the person is present). If a wire body could ever set these fields,
   the most it could do is label a message agent-written or skip an auto-bind (more caution, the
   decision 8 class).
7. **All paths frame the label.**
   - A, D-inject (~29747) and D-waiter (~29808): pass `{ signedByAgent }` to `injectTelegramMessage`,
     as the live path does. The D sites also pass the envelope's `firstName` and `userId` (today they
     pass neither), so the tag reads as it did on the receiving machine. The three D sites go through
     one receiver helper.
   - B, C and D-spawn: `spawnSessionForTopic` gets an optional
     `firstMessageLabel?: { signedByAgent: string; senderName?: string }` in its existing `spawnOpts`;
     `respawnSessionForTopic` takes the same option and threads it through explicitly (today it
     forwards only `awaitInitialInjection`, ~2146). When set: the message line is built with
     `buildInjectionTag`, the same tag the inject path uses; the heading `The user's latest message:`
     becomes `The latest message (written by agent <id>, sent through <name>'s account):`; the sentence
     "the user has been talking to you" is kept (it describes the history, not this message); and the
     over-500-character reference line says `... and the latest message, written by agent <id> (signed)`
     instead of "the user's latest message". `respawnSessionForTopic` today joins a `recoveryPrompt` and
     the message into one string (~2120-2123); it passes them separately instead, so the label wraps
     only the message and the recovery text stays unlabelled. A carried brief is used only when there
     is no latest message (~1640), so it never meets a label; the no-history branch (~1858) has no
     heading and gets the tag change only. When unset, every line is byte-identical to today.
   - E needs nothing of its own: it re-enters A, B or D with the same envelope.
   - `PendingInjectStore` stores the composed text, so the label survives boot recovery unchanged.
     Codex/other frameworks: the relay block is appended after, unaffected.
8. **Mesh trust.** The field arrives from a paired peer inside a signed mesh command, the same trust
   the payload and `userId` already have. A peer that omits it is the older-peer residual. A peer that
   sets it (or an invalid value) can make a genuine operator message read as agent-written: no new
   reach, since the peer already controls the payload (SEC-042); named as a residual below.
9. **Observability.** One in-process counter set in `signedInbound.ts`, since boot, per machine:
   `delivered` keyed by path (`live`, `A`, `B`, `C`, `D`, `F`; E is counted under the path it
   re-enters) for a message framed with a valid label, and `invalid` for a field present but invalid
   (framed as `unknown-agent`; not also counted in `delivered`). Every framing site increments it
   through the same helper that builds the label, so no path can frame without counting. It is
   surfaced in the authed `/health` extension as `signedInboundLabel`, beside the existing
   `messageOrigin` counters (`routes.ts` ~6251): counts only, never ids or text. Each labelled
   delivery off the live path also logs one line (topic, message id, path), as the live path does.
   Counts are per machine; no pool-wide sum is claimed. A replay (F) that finds no verdict is counted
   nowhere: it is indistinguishable from a human message, which is the point.

10. **Store coherence.** The envelope and ledger fields are not new sources of truth: each is a
   write-once record of the classifier's verdict for one message, written when its row or envelope is
   created and never updated. The ledger copy comes from one read of the cached verdict at
   `decideIngress`; the envelope copy from the ingress block's read a moment later. What decision 5
   guarantees between the two reads is narrow: a RESIDENT `agent-verified` entry for identical text is
   never downgraded. The cache can still upgrade a non-verified entry, replace one for different text
   under the same key, or evict. Decision 5a binds every read to the message's own text, so a replaced
   entry is never read for a different message; what remains is that one read may hold a label the
   other lacks (upgrade, eviction), and because the label is applied when ANY source has it, the only
   effect is that a label is kept. The invariant: for a given
   message, every copy says agent-written with the classifier's id, or is absent (an older build, or
   a verdict the cache did not hold at that read). Where the copies can meet (ingress, via the
   in-process ledger fields of decision 6), absence never wins over a label. Precedence when they meet: the
   label is applied if ANY source in scope says agent-written (all sources only add caution), so a
   disagreement can never strip a label. The two places sources meet at read time are stuck replay
   and lifeline reclaims (classifier verdict and ledger copy), both reconciled by the decision 6 algorithm; when both exist and
   differ, ingress applies the label, logs one `signed-label-disagree` line (topic, message id, both values) and counts
   `disagree` in the decision 9 set. No cadence check is added: the copies are immutable after
   ingress, and the classifier side never downgrades a resident verified verdict for the same text
   (decision 5) and is only ever read for the text it classified (decision 5a); upgrade and eviction
   remain possible, so divergence shows up only at read time, where it is caught.

## Decision points touched

- `server.ts` Telegram ingress envelope construction (four sites → one helper) — **invariant** — basis: enumerable-domain; evidence: the field has exactly one source (the ingress block's classifier read, `server.ts` ~3051) and four named writers, pinned by a grep test.
- Drain local inject (A), drain spawn/respawn (B), live spawn/respawn (C), mesh receiver inject/spawn/waiter (D), stuck replay (F) — **invariant** — basis: enumerable-domain; evidence: the six delivery paths are the closed list in the Why table, and each frames from the envelope field through one helper that also counts it.
- `spawnSessionForTopic` / `respawnSessionForTopic` first-message framing (opt-in option; respawn passes the recovery prompt separately) — **invariant** — basis: enumerable-domain; evidence: two states, label present or absent; absent is pinned byte-identical to today by test.
- Operator auto-bind conditions at both sites (route ~31570, ingress ~3078): replays excluded, ledger-backed labels honoured — **invariant** — basis: irreversible-consequence; evidence: a wrong bind seats a person as the verified topic operator, an authority record later actions rely on; the conditions withholding it are boolean facts (label present, replay flag).
- `AspInboundClassifier.remember` (same-text no-downgrade), text-bound reads (5a), the classifier hook (app entries skipped), the processing-ledger envelope, `reinjectStuck` — **invariant** — basis: enumerable-domain; evidence: sha256 equality of the classified text and the closed verdict set (`human` / `agent-verified` / `rejected`) decide every read.
- The three envelope types and the authed `/health` extension (`signedInboundLabel`) — **invariant** — basis: external-constraint; evidence: older peers and older stored rows must keep reading the envelope, so the field is optional and additive, and `/health` exposes counts only under auth.

## Multi-machine posture

The label is decided on the machine that classified the message and carried in the envelope to the
owner. Mixed versions: a new sender to an old owner → the old owner ignores the field (today's
behaviour); an old sender to a new owner → no field → unlabelled (today's behaviour). Both close as
the pool updates.

## Honest residuals

- The mesh owner records a processing-ledger row only for a purely numeric message id
  (`server.ts` ~29733); routed Telegram forwards use `tg-<n>`, so most forwarded messages have no
  owner-side row and no owner-side stuck replay at all (a pre-existing gap of stuck recovery, not of
  labelling). Where the owner does record a row, it now carries the label. Not counted as coverage.
  Tracked as feedback `fb-b017cbbd-638` (filed 2026-11-18) for the stuck-recovery owners.

- Rows enqueued before this change, and messages forwarded by an older peer, are unlabelled (today's
  behaviour). Accepted: the rows end at drain or TTL, the peer case when the pool updates.
- A compromised paired peer can omit the field, or set it to make an operator message read as
  agent-written. It already holds the payload and the bot token (SEC-042): no new reach.
- The live path's own reading depends on the in-process cache (1,000 entries, lost on restart).
  Decision 5 removes the same-message overwrite; eviction before routing needs over 1,000 newer
  classifications in between, which the live path does not wait for. Queued, spawned and forwarded
  messages no longer depend on the cache (the envelope carries the label), nor does replay (the
  ledger carries it).

- A signed message carrying a file, stuck, then re-forwarded after a restart by a lifeline upgraded
  in between (legacy tag vs `bodyMedia`) can compose different text: the ledger copy is not taken
  (input mismatch), the classifier sees a used nonce, and the route can bind the operator from it.
  Needs a file, a stuck turn, a restart and a lifeline upgrade in that window. Accepted.

## Constitution notes

- **Cross-Store Coherence Is an Invariant: deliberate deviation, no cadence check.** The conformance
  gate (signal-only) flags that decision 10 declares the invariant but adds no periodic check. Why
  none: (1) the envelope and ledger fields are write-once snapshots of one ingress decision, never
  updated, so they cannot drift over time, only be read (the classifier cache itself can change by
  upgrade, replacement or eviction, decision 10; reads are text-bound, decision 5a); (2) a periodic sweep would have to match
  queue rows to the ASP ledger by message id, which round 1 and 2 showed is not a safe key (app ids
  share the key space; dedupe keys may hold update ids), so the check itself would produce false
  disagreements; (3) the read-time meeting points (stuck replay and lifeline reclaims) are checked
  on every read and counted (`disagree`). The ASP durable ledger remains the audit authority for who wrote a message.

## Maturation plan

- **test-agent-live:** a throwaway agent paired with a throwaway signing agent: a signed message sent while the topic session is busy (queued, path A), with no session (spawn, path B/C), and replayed after a forced stuck turn and a server restart (path F); each reaches the session tagged `from agent <id> (signed)`, no operator is bound, and the authed `/health` shows `signedInboundLabel.delivered` moving for that path.
- **dev-agent-live:** Echo on the M5 and the Studio for one week: every agent-signed inbound that reaches a session off the live path carries the label (per-path counters move; `hashMismatch` stays 0 outside replays; no `signed-label-disagree` line without a matching explanation).
- **fleet:** on by default in the release that carries it; a security fix with no switch (the field is additive and older code ignores it).
- **graduation criterion:** after the dev-agent week, `hashMismatch` at 0 on both machines and zero operator-found mislabelled messages; a non-zero `hashMismatch` reopens the text-binding helper before anything else.
- **dark-window:** not applicable: ships on by default; there is no dark stage to wait out.
- **ladder:** not applicable: on-by-default security fix with no feature switch.

## Rollback

Revert. The extra envelope field in stored rows is ignored by the old code.

## Tests

Unit (at most 5 files per run on the M5):
- `telegramSenderEnvelope`: label copied from metadata only; content claiming a signature does not
  set it; mobile and team fields unchanged.
- `labelFromEnvelope`: valid, invalid → `unknown-agent`, absent → null.
- Classifier: an `agent-verified` entry survives a later `rejected`/`human` classification of the
  same key and same text; a different text under the same key replaces it; a later
  `agent-verified` replaces an earlier non-verified one; an app (`viaMobileDevice`) entry is neither
  classified nor remembered, and ingress does not look one up.
- Replay: the ledger entry records the label at ingress; `reinjectStuck` carries it as
  `replaySignedByAgent`; ingress labels a replay from it with an empty classifier cache (the
  post-restart case); a non-replay Message carrying `replaySignedByAgent` is ignored; a replay never
  auto-binds the operator, labelled or not; a replay whose classifier verdict and ledger copy differ
  is labelled, logs `signed-label-disagree` and moves `disagree`.
- Drain local inject passes the label (A), including the over-500-character reference line on the
  inject path (`refTag`, `SessionManager.ts:9508`).
- Counters: each framing path moves `delivered[path]` once; an invalid field moves `invalid` and not
  `delivered`; an unlabelled message moves nothing; `/health` (authed) shows them and the
  unauthenticated `/health` does not.
- First-message builder: labelled spawn uses the injection tag, the labelled heading and the labelled
  reference line; unlabelled is byte-identical (B/C/D); a recovery prompt stays unlabelled.
- Mesh receiver helper passes label, first name and user id at all three D sites.
- Grep pins: writers of the field only at the four places in decision 2; readers only in
  `labelFromEnvelope`, the injection/first-message builders, `reinjectStuck` and the lifeline route
  (ledger extraction), and the ingress reconciliation.
- Ledger: `decideIngress` records the label for a signed lifeline message and none for an app
  message; `claimForwardedInbound` stores the forwarded envelope; an owner-side replay after restart
  is labelled.
- Unlabelled replay through the full ingress path stays unlabelled (no `unknown-agent`).
- Restart, then an identical lifeline re-forward of a stuck signed message (row reclaimed) into an
  UNBOUND topic: the classifier records no verified verdict, the row's label reaches ingress as
  `ledgerSignedByAgent`, the routed message (and its queue envelope, if queued) is labelled, and
  NEITHER auto-bind site (route ~31570, ingress ~3078) binds an operator.
- Same, but the current text differs from the row's stored input (shared key): no label is copied.
- Ingress strips `ledgerSignedByAgent` / `replaySignedByAgent` from the metadata after reading.
- The same `bodyMedia` text forwarded twice matches the stored input.
- Text-bound reads: a cache entry replaced (different text, same key) between classification and
  consumption is not read for the original message; log-time and read-time `aspClassifiedText`
  hashes agree for plain text, caption with files, file without caption; a mismatch moves
  `hashMismatch`.
- Text-bound parity is tested from REAL Messages, not by calling the helper twice: a polling photo
  and document Message, a lifeline Message with files (bodyMedia, legacy-tag and download-failed
  forms); the read-side hash rebuilt from each equals the hash of the text the log site logged.
- Existing source pins (`tests/unit/session-pool-activation-wiring.test.ts` ~91, ~140-146, which pin
  literal `injectTelegramMessage(` / `spawnSessionForTopic(` call text) are updated in the same change,
  and so are the `verdictFor` / `resolveSignedByAgent` callers in `tests/unit/asp-inbound-classifier-verdictFor.test.ts`,
  `tests/unit/signed-inbound-label.test.ts` and any other test the signature change breaks.
Integration/e2e: a queued-then-drained agent-signed message reaches the session labelled (Local Verify).
