# Side effects: cards from their source conversation

## Intent and basis
Approved work-front-doors stage2b2: show the cards made from messages in their source conversation. Native owner agreed the shared read contract; this increment supplies that read and the console display. Phone create remains CMT1930 with the native owner. No constitution or authority change.

## ELI16
A card made from a message stays findable in that conversation. Only the owner can see this association. Three tiles keep the initial list small; explicit expansion and paging reveal the rest. Failed or outdated reads are named.

## Direct effects
- New optional query shape on existing board GET routes; ordinary shared boardRead used by Needs-you and Projects remains unchanged.
- Exact match over all card IDs, redaction removed before count, open cards before closed, then newest record time and ID. Fifty rows per page, matching existing history batch size.
- Source metadata continues through the existing card serializer and owner-only boundary. Members with shared cards and scoped sessions cannot request source associations.
- Console compares source projection revision, structural HLC version and total between pages, rejects overlapping/malformed rows and offers explicit reload on version change. Old tiles remain labelled potentially stale and open the current Work reader.
- Awareness entry uses the installed awareness registry path; no installed hook or configuration default changes.

## Indirect effects and limits
- Each source read scans current indexed cards and serializes at most fifty. No new journal, cache or writer.
- HLC changes elsewhere on the board may request a conservative reload even if this source did not change.
- `behind` describes incomplete local replication, so the UI states that it is catching up and never turns that into a definitive empty result.
- Source associations are stored facts, not inferred from message text. Platforms without existing Make-a-card source keys receive no tiles.
- This does not implement native phone creation, native tile UI, source-history pagination, or the broader dashboard spec.

## Signal versus authority
A source link is navigation only. Reads never approve, create, regroup or dispatch cards. Device members cannot use source association as a route around conversation privacy. Browser cancellation prevents stale reads repainting a later conversation.

## Verification
Real-service projection and route-boundary tests, DOM failure/paging/version/cancellation tests, signed HTTP integration cases and AgentServer lifecycle assertions. Integration/e2e execution belongs to Local Verify under the maintainer instruction; no local whole suite. Independent implementation review and desktop/phone Chromium evidence accompany the PR.

## Rollback
Revert this increment's source query branch, projection, module and mount, tests and awareness entry. Existing card source records and all normal board reads remain intact. Native consumers must treat an older server response without the source-list shape as unavailable, never as an empty list.

The source revision hashes matching card record identities and HLC versions and effective statuses in display order, plus policy record identities and HLC versions. It detects delayed peer changes below the maximum HLC. A card absent from capped board lanes opens via the existing single-card read; failed reads offer retry.

## Decision-point inventory
Added explicit query-shape selection and validation on public list routes. Existing authenticated owner/bearer boundary is passed through; non-owner source association is refused. Added exact stored source matching, fixed-size pagination, deterministic display ordering and revision equality before page append. Modified direct-link lookup to read an omitted card and scope open-once behavior to a navigation visit. These are wire/identity/presentation invariants, not judgments about message intent.

## 1. Over-block
A source key over 200 characters, containing a control character, or a non-integer/repeated page is refused explicitly. Ordinary board queries remain ordinary. Slack has no existing Make-a-card source mapping in the console and receives no invented source section. An unrelated journal change can conservatively ask the reader to reload; it cannot prevent opening an already visible card.

## 2. Under-block
Replication can be incomplete; behind is surfaced instead of declaring the list complete. A card can be removed after a tile read; its own reader returns the removed view or an unavailable response. Revision equality is not a write lock or an authorization token, and no caller can approve work through it.

## 3. Level-of-abstraction fit
The shared service projection owns filtering, ordering and counts before board presentation limits. The existing card serializer owns fields. The public list wrapper owns the query branch so shared Needs-you and Projects readers keep their original contract. The console owns only expansion and presentation; it does not infer associations from titles.

## 4. Signal vs authority compliance
No brittle message-content classifier gains authority. Existing owner/bearer access is a fixed identity floor, and exact source equality and page bounds are enumerable wire invariants. The list is a navigation projection, never an approval, work decision or dispatch signal. Reference: docs/signal-vs-authority.md.

## 4b. Judgment-point check
No new static heuristic at a competing-signals decision point. Open versus closed is an existing finite card status, not a guess about priority or urgency. Title text, recency and the person's message content do not grant permission or create source membership.

## 5. Interactions
Shadowing: source query handling lives outside the shared boardRead and does not replace Needs-you or Projects lanes. Double-fire: the display emits no work action; repeat clicks read the existing card. Races: navigation/current-render checks discard late responses, and sourceRevision plus structural HLC and total prevent page mixing. Feedback loops: none; reads write no records. Periodic Work refresh does not reopen a dismissed sheet, but a new navigation visit may open it again.

## 6. External surfaces
The response variant is additive only when sourceConversationKey/sourcePage is supplied. Native owner was notified of sourceRevision and the older-server unavailable behavior. No Telegram, Slack or external service sends are added. No durable state or configuration is added. Every added operator action is phone-completable: open the card, expand, load another page or retry/reload in the dashboard. These are reads, with existing card actions retaining their existing approval flow.

## 6b. Operator-surface quality
1. Leads with the primary action: Conversations still leads with original history; the secondary source-card region presents three directly actionable rows without a collapsed container. Each row opens its card. Expansion reveals additional rows only.
2. Zero raw internals as primary content: titles and need lines are human-facing text. Card IDs, source keys, HLC fields and hashes stay in requests/links and are never printed as headlines. Catch-up uses plain words without machine IDs.
3. Destructive actions de-emphasized: the new region contains no destructive action. Existing card sheets retain their bottom action area below the card facts; opening a tile does not promote remove/archive.
4. Plain language and phone width: verified at390 and1280 in Chromium. Neutral rows avoid falsely marking Done or With-agent cards as urgent. Explicit Show more, Try again and Reload labels; no horizontal scroll. Screenshots /tmp/source-card-tiles-1117-{390,1280}.png were inspected.

## 7. Multi-machine posture
Replicated: card source and record state follow the existing work-card-record coherence journal. Each machine projects its current replicated index and reports behind when its copy is catching up. The revision hashes ordered record identities and versions, including late peer arrivals and same-ID higher-HLC replacements. No user-facing notices or durable state are introduced. Relative Work URLs resolve through the selected machine's existing card reader; unavailable or removed data is stated. No status, health, capabilities or channels endpoint changes.

## 8. Rollback cost
Revert and release a patch. No data migration or agent-state repair is needed. During rollback, source rows disappear and older servers lack the response variant; the new client treats that shape as unreadable, not empty. Native consumers have the same contract notice. Stored cards and source records remain unchanged.

## Conclusion
Ready for merge-line verification after targeted guards, build, independent review and desktop/phone browser checks. Review added a real single-card lookup for capped-out cards, a source revision for delayed updates, and visit-scoped repeat navigation. Production verification and installation are not claimed.

## Second-pass review
Reviewer: /root/review_work_folds. Independent read: concur after all three reported blockers were addressed. Final message confirms no additional material issues. Browser and guard evidence are produced by the implementing session, not claimed as rerun by the reviewer.

## Class-Closure Declaration (display-only mirror)
No agent-authored-artifact defect — not applicable. This is a shared read and UI increment, not a prompt/hook/config/skill/standards repair or a self-triggered controller. The additional deep-link regressions detect the existing code defects that would block these tiles.
