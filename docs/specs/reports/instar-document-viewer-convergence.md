# Convergence Report — Instar Documents: commentable, team-private, conversation-linked documents

**Spec:** [docs/specs/instar-document-viewer.md](../instar-document-viewer.md)
**Slug:** `instar-document-viewer`
**Converged at:** 2026-11-10T22:08:35Z
**Iterations:** 6 rounds plus one verification pass at the round cap
**Final-pass design findings:** 0 safety-class; the five non-safety design points from the verification pass were all applied (listed below)

## Cross-model review: codex-cli:gpt-6-astra

Every round and the verification pass ran two outside reads in addition to the six internal lenses and the Standards-Conformance Gate:
- **GPT-6 Astra** (`codex-cli:gpt-6-astra`), the cross-family read, status `ok` in all 7 passes.
- **Fable 5.2** (`clean-door-anthropic-review: claude-code:claude-fable-5-2`), the clean-door Anthropic read, status `ok` in all 7 passes.

Internal reviewers ran on the authoring session's model, `claude-opus-5-5`, in every round (rounds 1–3 as six separate reviewers; rounds 4–6 as three reviewers covering two lenses each).

## ELI10 Overview

This adds Instar Documents: when the agent writes something longer than a chat message, it becomes a document you can open on a phone or a computer, select any passage of, and comment on, like Google Docs. You press "Send comments to Echo" (or say "read the comments"), and the agent answers under each comment, writes a new version, and you can compare versions and resolve comments. Comments follow their passage when the text is edited, and are never silently dropped.

Every document lives in one conversation, and the document is visible to exactly the people in that conversation. A document made for you is yours alone. To share it you pick people (or the whole team) on your phone with Face ID, which moves it into a conversation shared with them. Documents are also linked to related conversations, projects and other documents, so the agent can find its way from a topic to its documents and back, without ever revealing something a person isn't allowed to see. Documents and comments are copied to every machine. The iPhone app gets document screens, built by the app's own session on the Mac Studio.

The main tradeoff: there's no "share just this one document with Mara" separate from conversations. Sharing always goes through a conversation, because that's the only way the review found to guarantee a member's words never reach a part of the agent that holds the owner's private memory.

## Original vs Converged

- **Originally**, a document could be shared with chosen people directly, separate from its conversation. **Now** a document's audience is its conversation's audience, and sharing means moving it into a shared conversation (owner's phone, Face ID). **Why:** every reviewer found that a direct share let someone comment into a conversation they couldn't speak in, so their words could reach an unconfined, owner-private part of the agent.
- **Originally** the commenting page was a dashboard page. **Now** it is a separate page with its own strict rules (no outside scripts, no raw HTML, no forms), and inside the app every comment is signed by the commenter's phone. **Why:** member-written text on the dashboard's origin could have reached the owner's controls; and machine-signed comments could be forged by anything holding the machine key.
- **Originally** documents replicated through the general machine-to-machine journal, as single large records. **Now** they replicate as small signed rows plus separately stored text, paged by size, pulled the way team access is. **Why:** the journal silently drops anything over 80 KB and bursts over its rate cap, so long documents would have quietly gone missing on other machines.
- **Originally** the dashboard PIN could move documents and act as the owner. **Now** moving and sharing need the owner's phone, and the dashboard can only comment in the owner's own private documents. **Why:** the agent can read the PIN from its own settings, so the PIN can't prove the owner did something.
- **Originally** the app work was a note ("the app needs a button"). **Now** it's six specified screens and actions with exact request formats, built by `echo-instar-app` against a live development agent, tested in the simulator, shipped through TestFlight, with a run boundary at Justin's install. **Why:** Justin's correction (13:14) — no deferred functionality; filed as an Echo Bugs case study.
- **Originally** rows were ordered by wall-clock time and versions numbered by the writer. **Now** each row records what it had seen of the document and of the team record, the fold is causal, concurrent edits fork visibly, and sharing is an explicit disclosure record. **Why:** clocks differ between machines; without causal order a revoked person's comment or a backdated edit could slip in, and newly added readers could see rows written before they had access.


## Iteration Summary

| Iteration | Reviewers who flagged design issues | Design findings | Precision findings | Spec sections changed |
|-----------|-------------------------------------|-----------------|---------------------|-----------------------|
| 1 | all 8 (GPT-6 Astra, Fable 5.2, security, scalability, adversarial, integration, decision-completeness, lessons-aware) | ~45 | ~30 | full rewrite (v2): audience = conversation, own page, chunked signed rows by vector pull, app plan |
| 2 | all 8 | ~35 | ~20 | causal deps, disclosure, purge via blobs, lease-holder delivery, quotas, freshness, push invariants |
| 3 | all 8 | ~17 | ~15 | phone-signed payloads, bridge domain, dashboard limits, snapshots, two-level diff |
| 4 | all 8 | ~13 | ~12 | op-specific payloads, phone-backed reads, native composer, format constants, export backup |
| 5 | all 8 | ~13 | ~15 | Send rebuilt on existing chat routes; member browser devices (§3.6a); projection versions; stable labels |
| 6 | all 8 | ~14 (2 safety) | ~12 | browser scope, phone-signed bindings, prune protections, content-defined chunking |
| 6v (cap verification) | GPT-6 Astra, Fable 5.2 (both MINOR) | 5 (0 safety) | ~6 | salts only in blobs, replicated device bindings, advisory send row, guest browsers |

Standards-Conformance Gate: ran every round (3, 3, 3, 3, 2, 1, 1 flags).

## Proportion

Tier 2 (new replicated store, identity and access surface, app work). Spec grew from about 4,000 to about 13,000 words. 6 rounds, the Tier-2 cap, plus one verification pass because round 6 found two security problems in the member-browser design added in round 5. ⚠ The effort is large: much of it came from one structural choice made late (member browsers on computers, needed to meet "on a phone or a computer" for team members), which itself needed two rounds to settle.

## Left behind

- Owner phones paired before team step 2b: phone bindings are machine-signed, so a machine-key holder can bind keys (inherited from the team spec; stated in §3.6a item 5 and §8).
- A browser linked by scanning a QR code shown by a page the machine serves can be substituted by a process running as the agent's user; bounded to documents-scoped writes for 30 days, labelled, and visible in People (§3.6a).
- Per-person quotas can overshoot by the number of machines while machines are cut off from each other (§6).
- Links in chat name the lease holder's tunnel; a link to a sleeping machine doesn't open (§3.6).
- Delivery of a Send during a lease split behaves as any message does (§8).
- Precision items from every round not worked into the spec, one line each, are in the findings log kept with this report's working notes; none changes what is built.

## Full Findings Catalog

```
# Round 1 findings log (spec hash 7825ea7d…)

Models: internal reviewers = claude-opus-5-5 subagents (session model); external = codex-cli:gpt-6-astra (ok, SERIOUS ISSUES); clean-door = claude-code:claude-fable-5-2 (ok, SERIOUS ISSUES). Standards-Conformance Gate: ran (3 flags + parent-principle unresolved).

## External
- GPT-1 DESIGN doc-grant commenters can't send in primary conversation; Send bypasses owner-reach refusal.
- GPT-2 DESIGN session authorization contradictory; sessionPlaceAudience undefined; require visibility for whole audience.
- GPT-3 DESIGN concurrent versions lack identity (n collides across machines).
- GPT-4 DESIGN Send crash gap; need outbox keyed batchId, destination dedupe, delivery-status events.
- GPT-5 DESIGN historical authorization lacks cross-log rule; bind writes to access dependencies, quarantine, revalidate.
- Fable-1 DESIGN doc grants break confinement (owner-reach session reads non-owner text).
- Fable-2 DESIGN members served the owner console, contrary to team FD8; standalone page, strict CSP, CSRF.
- Fable-3 DESIGN fold order by wall clock; use per-origin seq + team-log vector; version fork rule.
- Fable-4 DESIGN team step 2b dependency (now merged #2933 — verify).
- Fable-5 DESIGN primary-set PIN vs phone signature contradiction.
- Fable-6 PRECISION caps inconsistent (500×512KiB vs 32MiB).
- Fable-7 PRECISION numbering/refs; comment-edit/reanchor missing from table.
- Fable-8 PRECISION justify in-repo Bitap/Myers.

## Adversarial (A1–A13): A1 Send from grant-only commenter; A2 legacy phones see every telegram doc; A3 PIN guards nothing vs agent, copy/derive widening; A4 memorySessionAllows pure, intersection rule; A5 forged/backdated events, owner/agent actor unsigned; A6 per-person quotas, Send rate limit; A7 title injection, boot context; A8 fabricated quotes, exact cap; A9 traversal leaks via invisible nodes, reason text, project/spec visibility; A10 page origin/CSP, tracking pixels; A11 commentId scoping (P); A12 proposal text server-rendered (P); A13 verifyTeamAccessOrigin doesn't exist, purge contradiction, open code in query (P).

## Scalability (S1–S8): S1 HIGH 512KiB versions exceed 80KiB replicated line cap, silently dropped; S2 exact uncapped; S3 64MiB is bytes/sec not storage; S4 rate cap 100/50 drops bursts; S5 push flood; S6 10-line cut silent; S7 hot-path bounds (P); S8 pool fan-out wording (P).

## SCG flags: Bounded Notification Surface (push flood); Judgment Within Floors (caps); Never Silently Cut (10-line); parent principle Rule 123 unresolved in registry.

# Round 2 (spec hash 66b3c734…, snapshot r2/spec-r2.md)
Models: internal = claude-opus-5-5 subagents; external codex-cli:gpt-6-astra (ok, SERIOUS ISSUES, 5 design); clean-door claude-code:claude-fable-5-2 (ok, SERIOUS ISSUES, 6 design + 5 precision). SCG: ran (3 flags: outbox unbounded retry; re-anchor thresholds judgment; session-start ranking).
- GPT: doc causality; moves defeat permanent confinement; per-reader 2b visibility; purge vs signed chain; chunk escaping.
- Fable: doc causal deps; primary-set confinement both ways; coalescing vs immutable batch; purge; owner chat stranded; dashboard PIN Send as owner.
- Scalability: TeamAccessLog class unsuited (whole-log memory, re-fold, per-row fsync, 12MB body, swallowed push); seq domain (per-origin across docs + index); unbounded storage/boot; single retrier; re-anchor on event loop; coalescing contradiction (P).
- Decision-completeness: 4h question to Justin not legitimate → ladder; run boundary at install; agent-facing additions must follow the switch; 64KiB basis cites unused transport; outbox brakes; owners for Rule 123 merge / share format / fleet flip; precision DC-7..9.
- Adversarial: metadata titles/reasons leak member text; home-machine dependence in mayUseConversation; stale machine accepts after revoke (freshness); MobileChatRequestStore pattern/24h/local; forwarded Send needs send row + re-check; discusses edge write scope; open on standby without tunnel; precision placeOf, cookie scope, nosniff, Telegram seen.
- Security: documents-send must not carry sender authority / title as instruction; metadata leak (dup); fromView copy by confined session; outbox re-check at delivery; per-person quotas + chunk cap; precision stated limit + monotonic access; DOM from tokens, referrer policy; link-target probe.
- Lessons: outbox brakes + requestId format; TeamAccessSync paging by rows/12MB/swallowed push → signed POST have/heads/starts paged by bytes; ingest skips team checks (middleware) → extract core; push invariants (no text, receivesNotices, msp, dedupe); Rule 123 shared-place exception; P21 citation wrong, P19/P7, Rule 123 merge owner; precision primary wider, Slack-only, share refusals, deterministic reasons, receipt field, Slack yet.
- Integration: share not one request (3 requests + resumable); no trust kind fits / steps in route; app origin stripped by validateOrigin + forward check → readers + version gate; no off-lease forward → lease holder delivers; backup restore rolls back access → blocked like team access; unlock returns bearer → operator session only; push closed union/whitelist/receivesNotices/caps; precision hook per-message → session-start; generalise sync; stable origin; coalescing as fold.

# Round 3 externals (hash 71086ac3…): SCG ran (3 flags: truthful provenance dashboard comments; freshness 10-min window; text caps). GPT-6 Astra SERIOUS (4 design: disclosure record for history; agent stamps launch-time vector; coalescing late join; purge leaves anchor excerpts). Fable 5.2 MINOR (4 design: sharing history disclosure; unsalted hashes; purged-set-first mechanism; clock freshness) + precision (sync GET, forwarding, share wording, commentKeys bound, app-update-required, route collision, delete op, diff-match-patch, WebView signing bridge).
All applied → r3b snapshot for internal reviewers.
# Round 3 internals (on r3b): security MINOR (2 design: bridge signs anything; dashboard table vs §3.3); scalability MINOR (2: Myers cap bounds output not work; signedOrigin body in row); adversarial SERIOUS (3: bridge domain; primary-set docDeps chosen by machine; dashboard writes in shared docs); integration (3: backup claim wrong; documentsSeenAt machine-local; version gate source/unknown/breaker); decision-completeness MINOR (2: person signedOrigin storage; FD12 basis circular / commentKeys size); lessons (3: dashboard table; device-signed body carrier; version gate waits for all machines). Counts DC: frontloaded 13, cheap 4, contested-cleared 7. All applied → r4.
# Round 4 externals (hash 81c146da…): SCG 3 flags (constitutional traceability Rule 123 unmerged; structure>willpower dashboard reads by policy; comment 32KiB single blob). GPT-6 Astra SERIOUS (3: signed payload must bind all op fields + requestId; later grants lack doc-history watermark; split-brain delivery at-least-once). Fable 5.2 MINOR (5: optional signedOrigin defeats claim; split-brain eventId from batchId; shared origin; alternatives not considered; selection→projection mapping) + precision. All applied → r4b.
# Round 4 internals (on r4b): sec+adv (3 design: verifyDesktopOperatorSession accepts PIN; modified page can make phone sign → native composer; place-disclosure exposes withheld rows); scal+integ (4: snapshots copy store synchronously ×20 → excluded + incremental export; place-applied/generation don't exist; desktop verifier; quota posture); decision+lessons (3: config-set format bounds split pool → format constants; desktop verifier; place-applied/generation). Counts: frontloaded 13, cheap 2, contested-cleared 2. All applied → r5.
# Round 5 externals (hash 29ed39af…): SCG 2 flags (caps derivation; traceability). GPT-6 Astra SERIOUS (2 design: cross-machine phone auth for open; coalescing joins unsigned) + 1 precision. Fable 5.2 SERIOUS (5 design: projection unversioned; descendants of withheld rows; unstable version numbers; simpler Send via existing chat routes; no desktop commenting on shared docs) + precision. Applied: Send rebuilt on existing device send routes (removes documents-send origin, extractions, version gate, outbox, coalescing); browser devices for members via phone QR browser-link; dashboard PIN writes nothing; projectionVersion; withheld cascade; stable labels; open on paired machine; audience text incl Telegram boundary; durability statement. → r5b.
# Round 5 internals (on r5b): sec+adv (3: PIN-approved owner browsers; peers can't verify member browser rows; agent-owned member browser key via QR); scal+integ (2: member browsers share owner cap; browser-link needs real path: record userId/role team, approvedVia person-phone, ledger row, phone-bind, revocation, switch); decision+lessons (3: browser-link undefined identity primitive; caps evidence for 256KiB; self-contradiction line 178/FD9/CSRF). Counts: frontloaded 13, cheap 0, contested-cleared 3. All applied (new §3.6a) → r6.
# Round 6 externals (hash f97253ab…): SCG 1 flag (title 120 derivation). GPT-6 Astra SERIOUS (3 design: disclosure prefix vector vs filtered set; Send move race between two writes; quotas under partition) + 1 precision. Fable 5.2 MINOR (5 design: move vs copy alternative; meaning of unsent; per-machine links / creation without stable origin; storage versions×size; table incomplete) + precision. All applied → r6b.
# Round 6 internals (on r6b): sec+adv (3: SAFETY member browser gets all member chat routes → scope documents; SAFETY phone-bind machine-forgeable → browser-bind carries phone signed request + stated inherited limit; prune lacks purge protections); scal+integ (4 OTHER: random salts defeat dedupe; chunking vs quota → CDC; write redirect cross-origin → approving machine; posture for browser records); decision+lessons (2 OTHER: send row check on non-home machine → signed receipt; limits rows). All applied → r6v. Cap verification pass follows (externals + focused security).
# Cap verification pass (hash 14b6b9e7…): SCG 1 flag (title/body limit derivation — answered by write-side judgment row). GPT-6 Astra MINOR (2 design OTHER: guest browser enrollment; edit-after-send coverage) + 1 precision (purge propagation). Fable 5.2 MINOR (3 design OTHER: salts in signed payload defeat purge guess-resistance; device auth across machines inconsistent; Send receipt over-built) + precision. No SAFETY. All applied (salts only in blobs; replicated bindings authenticate on any machine; send row advisory; guest read-only browsers; revision-bound coverage). Converged at cap.

```

## Convergence verdict

Converged at the round cap (6) plus a verification pass. Round 6 found two safety-class problems; both were fixed and the verification pass by GPT-6 Astra and Fable 5.2 found no safety-class problems, only five non-safety design points, all applied. Open questions: none. The spec is ready for Justin's review and approval.
