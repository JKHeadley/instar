# Side-Effects Review — native app conversations: lossless list, pool reads, Telegram token removal, approval method

**Version / slug:** `native-conversations-gaps`
**Date:** `2026-11-02`
**Author:** `echo`
**Second-pass reviewer:** `not run (declared --second-pass false by the brief)`

## Summary of the change

Closes four gaps an app builder found running the iPhone app against a real server with no Telegram, each measured against the converged spec `docs/specs/mobile-native-conversations.md`:

1. `GET /mobile/conversations` used a cursor that tracked only app conversations while the first page also carried up to 200 Telegram topics and was then cut to 200, so app conversations could fall off page one and never come back. The list now has one total order (newest activity, ties by `app:<uuid>` / `telegram:<topicId>`, plain string compare — the same order the store's SQLite keyset uses) and one cursor `<activity>|<sortKey>` (the store's existing cursor shape, so old cursors still parse). Every page merges the store's page with the Telegram topics strictly after the cursor (`mergeConversationPages`, `src/server/mobileConversationRoutes.ts`).
2. `?scope=pool` on the list and on `GET /mobile/chat/app/:key/messages` (spec §4.5, §4.8) now fans out to every peer's plain read with the agent's Bearer token (`poolPeerFetch`, `isPeerUrlAllowedForCredentials`, as `/telegram/topics/:id/messages?scope=pool` does), merges losslessly on the same cursor (list) or `(at, eventId)` boundary (browse), names dark machines in `pool.failed`, and never trusts a peer's verdict: a row only a peer holds reads `originVerified: "unknown"`. Wired in `AgentServer` with the route context.
3. `POST /mobile/chat/:topicId` with native conversations on (spec §4.2, §4.9 and the rollout section: the native flag gates every change to this route) no longer refuses invites, desktop codes or credential-shaped text: tokens are removed by exact match (`removeAuthorityTokens`, the same function the app route uses), the redacted text is what is stored (with a signed redaction attestation), ingested and mirrored, and the answer carries `redacted`/`removed`; credential-shaped text is delivered as written with `credentialShaped: true`, and the 📱 mirror shows it as `[credential hidden]` (`hideCredentialSpans`, built on `scrubForStore`). With native off, the route refuses exactly as before.
5. History rows (browse, sync, the device's Telegram history join) carry `originApprovedVia` (`telegram-dm` / `dashboard-pin`, from this machine's device-key ledger) when the verdict is `verified` or `redacted`, so the app can show "approved on dashboard" (§4.4, §4.6 display).

Gap 4 (the "📱 signed" tag) was verified present for app conversations (`appInboundDispatch.ts` adds it only for `verified`); the spec defines no such tag for Telegram-topic sessions, so none was added there. Slack rows in the list are absent because the Slack-from-the-app routes (spec increment 4) are not built; listing rows the app cannot open would be worse than omitting them.

Agent awareness: one new bullet in the Native app conversations section (pool reads, the single list cursor, `originApprovedVia`), and the Mobile operator chat content bullet rewritten; both reach existing agents through `migrateClaudeMd` (content-sniffed, idempotent).

Size: Tier 2 (spec-driven), 6 source files, about 300 lines plus tests. One review pass; commit attempts recorded in the PR.

## Decision-point inventory

- Telegram send preflight (`POST /mobile/chat/:topicId`) — modify — with native on, the three content refusals become exact-token removal plus a credential signal, as spec §4.2 already does for app conversations. Native off: pass-through (unchanged).
- Pool read merge — add — invariant: which rows a pool read returns is a deterministic merge; a peer's verdict is never adopted.
- `originApprovedVia` — add — display data read from the ledger; decides nothing.

---

## 1. Over-block

The Telegram route now blocks less (native on): nothing is refused for its content. The list and browse reads refuse a `scope` value other than `pool` with 400 `invalid-scope` (as the Telegram history route already does); no existing client sends another value.

---

## 2. Under-block

A credential typed into the app is now delivered to the session and kept in the Telegram history row as written (native on). That is the spec's explicit choice (§4.2: credential-shaped text is the operator's call, the app asks first; the server only signals). The mirror copy for people reading the topic hides it. An app build that skips its local check would let a credential through without asking; the server's `credentialShaped: true` and audit signal remain.

---

## 3. Level-of-abstraction fit

Token removal reuses the one function the app route uses, so both routes treat the same text the same way. The pool fan-out reuses `poolPeerFetch` and the peer URL credential guard rather than adding a transport. The list order reuses the store's own keyset order rather than a second sort definition.

---

## 4. Signal vs authority compliance

- [x] No — this change produces a signal consumed by an existing smart gate.

It removes blocking authority from a brittle detector (`detectOutboundCredential` used to refuse the message) and keeps it as a signal (`credentialShaped`), which the spec names as a judgment-candidate whose floor is "never refuses or alters". The only remaining alteration is exact-format token removal, which is structure, not judgment (spec Decision points table).

## 4b. Judgment-point check

No new static heuristic at a competing-signals decision point. The list order and the pool merge are invariants (total order, de-duplication by key).

---

## 5. Interactions

- **Shadowing:** the inbound core (`/internal/telegram-forward` handler, `trust` path) still refuses invite/desktop text with 422 `not-from-the-app`; after removal the text no longer carries either (the core's checks use the same `tlinv1:` regex and a leading `/desktop`, which the line-based removal covers), so the core's refusal stays as a backstop and is not reached for removed text. Tested end to end.
- **Double-fire:** none; the mirror is still best-effort after delivery.
- **Races:** pool reads are read-only. The list's duplicate collapse picks the newest copy; a lagging machine's older copy of the same conversation can reappear on a later page (the app already de-duplicates rows by id).
- **Feedback loops:** a peer's pool read is its plain read (no `scope`), so fan-out never recurses.

---

## 6. External surfaces

- Response shapes gain fields (`pool`, `machine`, `originApprovedVia`, `redacted`, `removed`, `credentialShaped` on the Telegram send); nothing is removed. The list's `nextCursor` is non-null in more cases (now correct).
- Telegram: the 📱 mirror text changes only when a credential span is present (hidden) or a token was removed.
- Persistent state: the Telegram send stores the redacted text plus a redaction attestation instead of the original body when a token was removed (the same record shape app conversations use; verified `redacted`).
- Operator surface: no new operator action.

## 6b. Operator-surface quality

No operator surface (no dashboard or approval page touched) — not applicable.

---

## 7. Multi-machine posture

**proxied-on-read** for the list and browse: `?scope=pool` merges every answering machine's plain read, with `pool.failed` for dark ones; the store itself already replicates (`appConversations` kind). A peer-only row's verdict reads `unknown` because only this machine's ledger is trusted (§4.8). `originApprovedVia` comes from this machine's replicated device-key ledger. No user-facing notices, no new durable state, no URLs.

---

## 8. Rollback cost

Pure code change: revert and ship a patch. The CLAUDE.md lines added by the migration would remain on updated agents (accurate only while this code ships; a revert would need the old lines restored by a later migration). Turning `mobilePairing.native.enabled` off restores the Telegram route's refusals immediately.

---

## Conclusion

The four gaps are closed against the spec with tests at unit and integration level; gap 4 needed no change. The one judgment worth a reader's attention is that credential-shaped text through the Telegram route is now delivered (native on), which is what the spec specifies and what app conversations already do.

---

## Second-pass review (if required)

Not run: the brief for this change declared `--second-pass false`.

---

## Evidence pointers

- `tests/unit/mobileConversationListPaging.test.ts` — order, cursor, lossless multi-source paging, duplicate collapse, mirror hiding.
- `tests/integration/mobile-native-conversations-gaps.test.ts` — 250 Telegram topics + 5 app conversations paged to completion; interleaved paging; pool list and browse with a live peer and a dark peer; Telegram token removal (`redacted`, token absent from disk), credential signal and hidden mirror, native-off refusals unchanged; `originApprovedVia` for Telegram- and dashboard-approved phones and absent on a failed record.
- `tests/unit/PostUpdateMigrator-appConversationsGaps.test.ts` — awareness lines for new and existing agents, idempotent.

---

## Review follow-ups (independent review: CONCERN, all five addressed)

1. **Mirror leak through invisible characters.** `hideCredentialSpans` scrubbed the raw text only, while `detectOutboundCredential` also reads it with invisible characters removed, so a key split by a zero-width space was flagged but shown in the 📱 copy. Now the scrubbed copy is re-checked with the same wall; if the wall still sees a credential the whole copy is hidden as `[credential hidden]`. Tested for nine invisible characters (U+200B/C/D, U+2060, U+FEFF, U+00AD, U+034F, U+FE0F, U+202E) and end to end through the Telegram route.
2. **Desktop codes on a later line.** `DESKTOP_LINE_RE` allowed only space or tab before and after `/desktop`, so `/desktop\u00A0abc 123456` (and other non-ASCII whitespace) on a later line reached the session. Leading space and separator are now `[^\S\n]`, the core check's whitespace class minus newline. This function is shared with the app-conversation send route, so it removes more there too (only exact `/desktop` lines; `/desktops` and mid-line mentions are untouched, tested).
3. **Peer attachments.** Peer-only browse rows no longer carry the peer's attachment rows at all (their files live on that machine, which this machine cannot serve, and their fields were unchecked); the row says `filesOnOtherMachine: <count>`. `deliveryState` from a peer is restricted to the known values, else `unknown`.
4. **Peer times.** A peer's `lastActivity` (list) and `at` (browse) must be a strict ISO-8601 instant and are normalised with `toISOString()`; anything else drops the row, so a value like `"0"` can no longer become the cursor that ends paging early. A note: a peer row is sliced to `limit` before validation, so a peer returning invalid rows wastes its own slots, never another source's.
5. **Pool browse of a conversation not replicated here yet.** Spec 4.8 says the live pool read covers events not yet replicated, so `?scope=pool` now reads a conversation this machine has never seen from the peers (all rows `originVerified: "unknown"`). A conversation this machine knows is deleted stays 404; if no peer has it, 404; if a machine did not answer, 200 with `pool.failed`. Only a valid app conversation key is forwarded, and it is URL-encoded.

---

## Class-Closure Declaration (display-only mirror)

- **Defect class:** `unbounded-self-action`
- **Closure:** `n/a` (negative declaration)
- **Reason:** one-shot user-driven action, not a self-triggered loop. The Telegram send route runs once per device request (rate-limited and idempotent through MobileChatRequestStore); this change only replaces its content refusals with token removal, and the pool reads are request-driven, read-only fan-outs.
