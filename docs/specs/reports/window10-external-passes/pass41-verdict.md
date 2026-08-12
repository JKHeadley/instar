The workspace is read-only, so creating `PASS40-VERDICT.md` was rejected. The requested report is printed below.

=== VERDICT ===

UNSOUND

Beyond the acknowledged rendering under-refusals, two unchecked egress paths remain: test-environment method-in-parameter requests and mutation between inspection and `fetch`. The boundary lint also cannot sustain its categorical confinement claim. Several source/spec claims remain materially false.

=== MAGNITUDE ===

7 load-bearing findings: **3 DESIGN, 4 PRECISION**.

## FINDINGS

1. **DESIGN — Test-environment token-root requests bypass method classification.**

   Evidence: [telegram-egress.ts:67](/Users/justin/window12-exam/src/messaging/telegram-egress.ts:67), [telegram-egress.ts:111](/Users/justin/window12-exam/src/messaging/telegram-egress.ts:111), [telegram-egress.ts:317](/Users/justin/window12-exam/src/messaging/telegram-egress.ts:317), [telegram-egress-boundary.test.ts:198](/Users/justin/window12-exam/tests/unit/telegram-egress-boundary.test.ts:198), [telegram-egress-boundary.test.ts:221](/Users/justin/window12-exam/tests/unit/telegram-egress-boundary.test.ts:221).

   Telegram’s server removes the optional `test` segment and treats the entire remaining path as the method; when that method is empty, its query layer falls back to the first `method` argument. See Telegram’s [HTTP path extraction](https://github.com/tdlib/telegram-bot-api/blob/master/telegram-bot-api/HttpConnection.cpp#L33-L45) and [method-argument fallback](https://github.com/tdlib/telegram-bot-api/blob/master/telegram-bot-api/Query.cpp#L555-L590).

   `BOT_PATH` returns no method for a test-environment token root, while `isBotApiRoot` recognizes only the production root. Consequently, a test-environment root request whose method and reader-facing field are parameters reaches `fetch` without classification or visibility checking. The tests cover test paths with a path method and production roots with a parameter method, but not their intersection.

2. **DESIGN — The inspected body need not be the body passed to `fetch`.**

   Evidence: [telegram-egress.ts:16](/Users/justin/window12-exam/src/messaging/telegram-egress.ts:16), [telegram-egress.ts:366](/Users/justin/window12-exam/src/messaging/telegram-egress.ts:366), [telegram-egress.ts:391](/Users/justin/window12-exam/src/messaging/telegram-egress.ts:391), [TelegramAdapter.ts:5794](/Users/justin/window12-exam/src/messaging/TelegramAdapter.ts:5794).

   The door reads `init.body`, checks that value, and later gives the original mutable `init` object to `fetch`. A valid stateful `RequestInit` property—or another mutation of the object during those accesses—can therefore expose visible content to the check and different, invisible content to native `fetch`.

   This directly falsifies the claims that the door checks “the exact bytes about to go on the wire” and that the adapter’s checked bytes are “the exact bytes Telegram receives.” The boundary needs a captured, immutable request representation, not a check followed by reuse of the caller-owned wrapper.

3. **DESIGN — The lint has additional unacknowledged direct-egress blind spots.**

   Evidence: [lint-telegram-egress-boundary.mjs:58](/Users/justin/window12-exam/scripts/lint-telegram-egress-boundary.mjs:58), [lint-telegram-egress-boundary.mjs:74](/Users/justin/window12-exam/scripts/lint-telegram-egress-boundary.mjs:74), [lint-telegram-egress-boundary.mjs:104](/Users/justin/window12-exam/scripts/lint-telegram-egress-boundary.mjs:104), [lint-telegram-egress-boundary.mjs:235](/Users/justin/window12-exam/scripts/lint-telegram-egress-boundary.mjs:235).

   The scan includes only `.ts`, although executable `.js` and `.mjs` files exist under `src`. Its binary-expression handling recursively searches operands for a complete host marker; it does not constant-fold a host split across concatenated literals. Its call matcher also misses direct invocation through `call`, `apply`, or computed property access.

   A direct Bot API request placed in any such shape can therefore bypass `telegramFetch` while the lint prints that all egress is confined. These are additional to the already-stated imported-URL and renamed-`fetch` limitations.

4. **PRECISION — Path recognition consumes an alphabetic prefix, while Telegram consumes the entire remaining path.**

   Evidence: [telegram-egress.ts:67](/Users/justin/window12-exam/src/messaging/telegram-egress.ts:67), [telegram-egress.ts:76](/Users/justin/window12-exam/src/messaging/telegram-egress.ts:76), [telegram-egress.ts:341](/Users/justin/window12-exam/src/messaging/telegram-egress.ts:341).

   `BOT_PATH` is not end-anchored and captures only `[A-Za-z]+`. Telegram instead uses the complete residual path as the method. A path beginning with a known method followed by a nonletter suffix is classified locally as the known method and forwarded, while Telegram sees an unknown full method and rejects it.

   This is not presently an invisible-message delivery bypass, because Telegram rejects the request. It is nevertheless a false closed-world decision and disproves the comment that the locally recovered method “cannot disagree with the request.”

5. **PRECISION — The specification still describes a predicate different from the implementation.**

   Evidence: [telegram-egress-invisible-payload-guard.md:239](/Users/justin/window12-exam/docs/specs/telegram-egress-invisible-payload-guard.md:239), [telegram-egress-invisible-payload-guard.md:268](/Users/justin/window12-exam/docs/specs/telegram-egress-invisible-payload-guard.md:268), [telegram-egress-invisible-payload-guard.md:325](/Users/justin/window12-exam/docs/specs/telegram-egress-invisible-payload-guard.md:325), [telegram-egress-invisible-payload-guard.md:339](/Users/justin/window12-exam/docs/specs/telegram-egress-invisible-payload-guard.md:339), [invisible-payload.ts:64](/Users/justin/window12-exam/src/messaging/invisible-payload.ts:64), [invisible-payload.ts:76](/Users/justin/window12-exam/src/messaging/invisible-payload.ts:76), [invisible-payload.ts:91](/Users/justin/window12-exam/src/messaging/invisible-payload.ts:91), [invisible-payload.ts:109](/Users/justin/window12-exam/src/messaging/invisible-payload.ts:109).

   The spec repeatedly says the implemented guarantee is merely membership in `L/N/P/S/M`. The implementation additionally subtracts `Default_Ignorable_Code_Point` and five explicit blank glyphs. The multi-machine section then says drift is bounded to General Category membership and derives a fail-safe direction from that premise.

   A maintainer following the spec would audit only category changes and omit a runtime Unicode property that actually participates in every verdict. Therefore both the claimed predicate and the claimed bound/direction of version drift are unsupported.

6. **PRECISION — The spec’s live lint-population row describes the deleted lint, not the current one.**

   Evidence: [telegram-egress-invisible-payload-guard.md:327](/Users/justin/window12-exam/docs/specs/telegram-egress-invisible-payload-guard.md:327), [lint-telegram-egress-boundary.mjs:125](/Users/justin/window12-exam/scripts/lint-telegram-egress-boundary.mjs:125), [lint-telegram-egress-boundary.mjs:222](/Users/justin/window12-exam/scripts/lint-telegram-egress-boundary.mjs:222).

   The row says population membership requires building the API host, calling `fetch`, and referencing a body-carrying method, with a shrink-only ratchet. The current lint does not inspect body-carrying method references and contains no population ratchet. It scans host-marked direct fetch calls and emits violations.

   Thus method references can change—or the recognizer can silently lose a source—without the claimed ratchet firing. The supersession notices elsewhere do not supersede this live decision-table claim.

7. **PRECISION — Comments attribute plain-text fallback to Telegram, but fallback belongs to the adapter.**

   Evidence: [invisible-payload.ts:312](/Users/justin/window12-exam/src/messaging/invisible-payload.ts:312), [invisible-payload.ts:365](/Users/justin/window12-exam/src/messaging/invisible-payload.ts:365), [TelegramAdapter.ts:1411](/Users/justin/window12-exam/src/messaging/TelegramAdapter.ts:1411).

   Telegram rejects malformed entity markup; it does not itself successfully deliver the source as plain text. The local adapter catches the failed HTML attempt and issues a second request without `parse_mode`.

   The acknowledged over-refusal remains real on that adapter path: the door refuses before Telegram can return the parse error that would trigger the retry. But a direct `telegramFetch` caller receives only Telegram’s error. Statements saying Telegram “falls back to sending the source” are false and incorrectly assign responsibility for the recovery behavior.

## REGRESSION-CHECK

- **Unnumbered open — `answerCallbackQuery` / `editForumTopic` classification:** Still open. The product judgments remain explicit at [invisible-payload.ts:121](/Users/justin/window12-exam/src/messaging/invisible-payload.ts:121) and [invisible-payload.ts:137](/Users/justin/window12-exam/src/messaging/invisible-payload.ts:137). The test title claiming the map is “exactly” all reader-visible methods remains stronger than that acknowledged policy judgment.

- **Unnumbered open — byte-oriented bodies classified by JavaScript wrapper:** Still open. [telegram-egress.ts:269](/Users/justin/window12-exam/src/messaging/telegram-egress.ts:269) refuses byte bodies without consulting `Content-Type`, although Telegram chooses JSON, form, or multipart parsing from the media type. The description is correct but incomplete: the door generally models wrapper type rather than the transmitted request representation.

- **1. Rendering shortcut:** Still open in both stated directions at [invisible-payload.ts:312](/Users/justin/window12-exam/src/messaging/invisible-payload.ts:312) and [invisible-payload.ts:323](/Users/justin/window12-exam/src/messaging/invisible-payload.ts:323). The over-refusal description is correct only when the adapter’s retry is included; Telegram itself does not perform the claimed fallback.

- **2. Surviving per-sender guard:** Still open exactly as described. The sole guard remains at [TelegramAdapter.ts:1401](/Users/justin/window12-exam/src/messaging/TelegramAdapter.ts:1401) before transfer to another machine.

- **3. Unicode table not vendored:** Still open, but its account is incomplete. Runtime Unicode escapes remain, while the spec incorrectly limits drift to General Category and omits the runtime `Default_Ignorable` dependency described in finding 5.

- **4. Relay refusal/unreachable conflation:** Still open exactly as described. [TelegramRelay.ts:134](/Users/justin/window12-exam/src/core/TelegramRelay.ts:134) recognizes only 422; other non-success statuses become `null`. The three pinning tests remain at [telegram-relay-refusal-status-conflation.test.ts:37](/Users/justin/window12-exam/tests/unit/telegram-relay-refusal-status-conflation.test.ts:37).

- **5. Lint limits:** The named blind-door, imported-URL, and renamed-`fetch` limitations remain. The description is not exhaustive: finding 3 identifies further direct-egress forms that the lint misses while retaining its categorical clean output.

- **6. Deliberately red family-audit assertion:** Still present as described at [standards-coverage-ratchet.test.ts:906](/Users/justin/window12-exam/tests/unit/standards-coverage-ratchet.test.ts:906) and [standards-coverage-ratchet.test.ts:923](/Users/justin/window12-exam/tests/unit/standards-coverage-ratchet.test.ts:923). Execution was unavailable because this copy has no installed test dependencies; statically, the expectation still demands `current` while its comment records Building and The Substrate as stale.     1	---
     2	slug: telegram-egress-invisible-payload-guard
     3	title: Telegram Egress — Refuse an Invisible Payload at Every Agent Funnel, with a Guard Call Present in Every Derived Sender File
     4	approved: true
     5	parent-principle: "Structure beats Willpower"
     6	approved-by: justin
     7	approved-at: 2026-08-10
     8	approval-channel: telegram/29723
     9	approval-provenance: >-
    10	  Justin's verbatim decision, 2026-08-10 17:12 PDT — "approved, for both the spec and the standard" —
    11	  relayed through the observer on the operator account. Recorded by the agent as a citation of the
    12	  operator's decision, NEVER as the agent's own authority. The agent did not and cannot self-approve.
    13	review-convergence: "2026-08-11T01:04:28.873Z"
    14	review-iterations: 14
    15	review-completed-at: "2026-08-11T01:04:28.873Z"
    16	review-report: "docs/specs/reports/telegram-egress-invisible-payload-guard-convergence.md"
    17	cross-model-review: "codex-cli:gpt-5.5"
    18	single-run-completable: true
    19	frontloaded-decisions: 6
    20	cheap-to-change-tags: 0
    21	contested-then-cleared: 0
    22	---
    23	
    24	# Telegram Egress — refuse an invisible payload at every agent funnel, with a guard call present in every derived sender file
    25	
    26	> **The title said "every EGRESS" until round 1 of convergence, and the external reviewer was right to
    27	> call it an overclaim: this spec's own limits section admits the derivation reaches only senders that
    28	> call `fetch` against the API host directly. "Every egress" is what a centralized boundary would give;
    29	> what this delivers is every egress the mechanism can SEE, plus an alarm when that set shrinks. Narrowed
    30	> at the title rather than defended in a footnote — the failure this whole document is about is claiming
    31	> a set is complete without deriving it, and I had done it again in the first line.**
    32	
    33	## Status
    34	
    35	**Spec written 2026-08-10 (window 12), AFTER the implementation, and that ordering is disclosed rather
    36	than hidden.** The work was built as a repair to review-pass-29 finding 1 under the window-12 charter,
    37	reached the commit gate, and the gate correctly demanded a Tier-2 spec. Writing the spec now is the honest
    38	response; declaring Tier 1 to route around the requirement was the alternative and was refused — the two
    39	prior source commits on this branch did exactly that (`declaredTier: 1` against `riskFloor: 2`,
    40	`belowFloor: true`), and review pass 28 convicted that decision on this same send path.
    41	
    42	**`approved:` is TRUE as of 2026-08-10, on Justin's verbatim decision relayed through the observer.** The
    43	citation in the frontmatter is the signature trail; the agent recorded the operator's decision and has no
    44	authority to make one. `review-convergence:` was **recorded on 2026-08-11 after fourteen rounds** and is in this
    45	document's frontmatter — approval of the CONTENT is the operator's act, convergence is the agent's process
    46	step, and writing that tag by hand before the rounds ran would have been a fabricated review inside the
    47	constitution. This paragraph said the step was still owed until review pass 37 finding 8 caught it
    48	contradicting the frontmatter directly above it.
    49	
    50	## Guarantee summary — SUPERSEDED 2026-08-11. Read this before citing the spec
    51	
    52	> **The heading below described the INTERIM, presence-based guard. That design is gone.** The guarantee is
    53	> now structural: `src/messaging/telegram-egress.ts` is the single door, and
    54	> `scripts/lint-telegram-egress-boundary.mjs` confines every Bot API `fetch` to it. What the lint proves
    55	> is exactly that confinement — it does NOT read the method map or maintain a sender ratchet, and the
    56	> sections below that say it does are pre-ship text (review pass 38 finding 6). The closed-world method
    57	> check now lives in the door itself, which refuses an unclassified method at runtime.
    58	>
    59	> Read the section *CMT-1246 shipped* for the current state, including the criterion that cannot be met
    60	> and the one that was not.
    61	
    62	### Historical: the interim, non-structural guard
    63	
    64	**Behavioural refusal is PROVEN BY INPUT for three funnels:** the adapter's API funnel, the adapter's
    65	tokenless-standby relay, and the lifeline's own funnel. Each is sabotage-proven to red only its own arms.
    66	
    67	**Four direct senders are PRESENCE-ONLY:** two setup-wizard greetings, the self-test probe, and the demo
    68	harness sender. The lint proves the guard call is in the file; **nothing executes an invisible payload
    69	through their real send function.** That is CMT-1248.
    70	
    71	**This is an interim, non-structural guard — an emergency repair with disclosure, not an architectural
    72	boundary.** Source-shape linting plus per-sender calls is what it is; CMT-1246 is the boundary, and **no
    73	future spec should reuse this pattern as a model without landing CMT-1246 first.**
    74	
    75	**Do not cite this spec as proof that all Telegram egress is behaviourally guarded.** It is not, and the
    76	distinction between the two groups is the single most likely thing for a future reader to flatten. Round 8
    77	of convergence named that risk explicitly, which is why this section sits above the argument rather than
    78	inside it.
    79	
    80	## The problem
    81	
    82	A message whose entire body is invisible — whitespace and/or zero-width characters — cannot inform a
    83	reader, and delivering it produces a "reply lost" escalation for content that never existed. That is not
    84	hypothetical: it is the live incident this guard was built for (a peer relay accepted a body of one ZERO
    85	WIDTH SPACE, failed with an empty error, burned nine retries over 4h17m, and emitted a user-facing "I had a
    86	reply for you but couldn't deliver it" notice; there was no reply).
    87	
    88	The refusal has been placed four times, and its scope over-claimed four times. Each over-claim was
    89	falsified by the next reader:
    90	
    91	| placement | claim written | falsified by |
    92	|---|---|---|
    93	| one HTTP route | "fixed at the point of sending" | pass 27, via a second route |
    94	| two routes | "both doors" | pass 28, via a third route |
    95	| `sendToTopic` | "the single chokepoint every Telegram send passes through" | pass 29, by executing `send()` |
    96	| `apiCall` | "the one function `fetch` is reached through" | second-pass reviewer, via the standby relay |
    97	
    98	**The root cause is one habit, not four mistakes: asserting the shape of a set instead of deriving its
    99	members.** Every repair in this window that HELD was a derivation; every one that failed was a
   100	hand-maintained list or an asserted enumeration.
   101	
   102	## The derived population
   103	
   104	Derived by MECHANISM — a file that builds the `api.telegram.org` URL and calls `fetch` — not by class name:
   105	
   106	| sender | send sites | state before |
   107	|---|---|---|
   108	| `src/messaging/TelegramAdapter.ts` | 14 `apiCall('sendMessage')` across 9 methods | 4 covered, via `sendToTopic` |
   109	| `src/lifeline/TelegramLifeline.ts` | 2, behind its OWN private funnel | **no guard at all** |
   110	| `src/server/routes.ts` (demo sender) | 1 direct `fetch` | none |
   111	| `src/commands/setup-wizard/codex-driver.ts` | 1 | none |
   112	| `src/commands/setup-wizard/gemini-driver.ts` | 1 | none |
   113	| `src/commands/test-as-self.ts` | 1 | none |
   114	
   115	**Six senders.** The lifeline was invisible to all four previous enumerations for one reason: each of them
   116	enumerated the adapter.
   117	
   118	## The design
   119	
   120	### 1. Refuse per EGRESS, not per function
   121	
   122	`TelegramAdapter` has **two** egress mechanisms, and this is the correction that cost the most to learn:
   123	
   124	- `apiCall` — the only path to `fetch`. Covers 14 sites.
   125	- the **tokenless-standby relay** (`!hasUsableBotToken && this.outboundRelay`) — hands the body to another
   126	  machine's router and **never enters `apiCall`**.
   127	
   128	A guard on `apiCall` alone leaves the relay uncovered. Relying on the receiving end is not sufficient
   129	either: the far route refuses with **400**, while `isRelayRefusal` recognises only **422**, so a CONTENT
   130	refusal would surface to the caller as `relay failed … router unreachable` — a transport lie about a
   131	reachable router, the exact conflation `TelegramRelay`'s own header records having fixed.
   132	
   133	This is **not** the duplication review pass 23 warns about (two copies closing the SAME case, masking each
   134	other's tests). These close DIFFERENT cases and each is independently provable.
   135	
   136	### 2. Key the refusal by method → field, not by a method set plus a hardcoded field
   137	
   138	```
   139	sendMessage      → text
   140	editMessageText  → text
   141	createForumTopic → name
   142	editForumTopic   → name
   143	```
   144	
   145	A forum topic's `name` is as reader-visible as a message body, and an invisibly-titled topic is worse — it
   146	persists in the topic list, unfindable. The two creating routes validate `name.trim().length >= 1`, and
   147	`trim()` does **not** remove zero-width characters (they are format controls, not whitespace), so two ZERO
   148	WIDTH SPACEs measure length 2 and pass. Verified by execution.
   149	
   150	`answerCallbackQuery` also carries `text` and is deliberately **excluded**: it renders a transient toast and
   151	an empty one legitimately dismisses the spinner. Refusing it would be an over-refusal, not a protection.
   152	
   153	### 3. Make the enumeration a check, not a memory
   154	> **Superseded.** This section describes the deleted per-sender lint, which derived a sender population
   155	> and ratcheted it. The current lint proves confinement to one door and nothing else; the enumeration it
   156	> replaced now lives in the door's runtime refusal of an unclassified method (pass 38 finding 6).
   157	
   158	`scripts/lint-telegram-egress-boundary.mjs` (which REPLACED `lint-telegram-send-funnel-guarded.mjs` when the door landed) confines egress rather than deriving the sender population from the mechanism and reads
   159	the method→field map **from the guard's own source** rather than keeping a second copy. A future sender
   160	joins the population by existing.
   161	
   162	**Why it text-parses the TypeScript source rather than importing the table as data** (asked at round 7, and
   163	the answer is a real trade rather than an oversight): the lint is plain `.mjs` run by `node` in the commit
   164	and CI chains, while the table lives in `.ts` — importing it would mean depending on `dist/`, and a lint
   165	that reads a STALE BUILD would report on a table that is not the one shipping, which is a worse failure than
   166	brittle parsing and precisely the class this branch keeps finding. The parse is **fail-closed**: if either
   167	declared set cannot be read, the lint exits non-zero rather than reporting clean, so a moved or renamed
   168	constant breaks the build loudly instead of silently emptying the population. Exporting the table as a
   169	JSON asset consumed by both runtime and lint is the better end state and rides **CMT-1246**, which already
   170	rewrites this boundary.
   171	
   172	**The classification is CLOSED-WORLD (added on a round-3 finding).** Before it, a method in the map was
   173	guarded and everything else was silently unguarded — so a future `sendPhoto` carrying a caption would enter
   174	the codebase unclassified and no check would say a word. Every method a sender calls must now be declared
   175	either reader-visible (with its field named) or explicitly bodyless (with the reason); anything in neither
   176	list FAILS as review-required. Proven both ways: injecting an unclassified `sendPhoto` reds naming that
   177	method, and emptying the bodyless declaration reds fail-closed rather than silently passing everything.
   178	
   179	Its own failure modes are closed, each found by an independent reviewer defeating an earlier version:
   180	block comments stripped file-wide; a local definition is not a call; the shared import is required; and a
   181	**shrink-only ratchet** pins the population, because a zero-tripwire only catches total matcher failure —
   182	splitting the host literal previously dropped a sender out silently and the lint reported "clean — 5".
   183	
   184	## Alternatives considered and rejected
   185	
   186	- **Keep the per-door checks and add a fifth.** Rejected: four enumerations, four over-claims. A per-door
   187	  check requires every future door to remember, which is the willpower the constitution's first standard
   188	  forbids.
   189	- **Guard only `apiCall` and let the far end refuse the relayed case.** Rejected: it reports a content
   190	  refusal as a transport failure (see §1).
   191	- **Keep a belt-and-braces copy in `sendToTopic`.** Rejected: two copies closing the same case mask each
   192	  other's tests (pass 23) — break either alone and nothing reds.
   193	- **Widen the guard to every method carrying a `text` param.** Rejected as over-refusal:
   194	  `answerCallbackQuery` legitimately sends an empty toast.
   195	- **A single shared, guarded Telegram request helper that every sender must call** (raised by the round-1
   196	  external reviewer, and it is the strongest alternative here). This is the design that would make "every
   197	  egress" **structurally** true instead of derivation-true: one function owns the HTTP call, the guard is
   198	  inside it, and a new sender cannot exist without going through it. **Not rejected on merit — held back on
   199	  blast radius, and the distinction matters.** It rewrites the call path of six files including the
   200	  lifeline's independent poller and two setup-wizard drivers, none of which currently share a client, and
   201	  it would land the same night a live hole was found. The lint plus per-egress guards close the hole now;
   202	  the boundary is the correct end state. **Tracked, not dropped:** **CMT-1246** — a registered, beacon-enrolled commitment with a deadline, not a marker in a document —
   203	  a registered commitment to introduce the shared client and then DELETE the per-sender guards. **Owner: Echo.
   204	  Acceptance criteria, so the marker is a commitment rather than a gesture:** (a) exactly one function in
   205	  the codebase issues an HTTP request to the Telegram API host, proven by the derived population collapsing
   206	  to one file; (b) every per-sender `assertTelegramPayloadVisible` call is DELETED, and the behavioural
   207	  suite still reds when the single remaining guard is removed; (c) the lint's assertion changes from
   208	  "every sender calls the guard" to "exactly one sender exists", which is a boundary check and is
   209	  path-complete by construction; (d) the vendored invisible-codepoint table lands with it, removing the
   210	  runtime Unicode dependency named in the multi-machine table above. Recorded here because a rejected alternative that
   211	  is actually the better design must not disappear into a commit message.
   212	
   213	## CMT-1246 shipped — what the criteria got right, and the one they could not anticipate
   214	
   215	The shared-client alternative above is no longer held back. It shipped on 2026-08-11 as
   216	`src/messaging/telegram-egress.ts`, and the design this spec's title describes — "a Guard Call Present
   217	in Every Derived Sender File" — is superseded by it. The title is left as written because it records
   218	what was approved; this section records what replaced it and why that was already sanctioned here.
   219	
   220	Against the four acceptance criteria, derived rather than asserted:
   221	
   222	- **(a) exactly one function issues an HTTP request to the Telegram API host** — MET.
   223	  `scripts/lint-telegram-egress-boundary.mjs` proves it by parse and fails if any other file reaches
   224	  the Bot API host. It also canary-tests its own URL recogniser before trusting a verdict, because a
   225	  recogniser that silently stops seeing turns a boundary lint into a permanent green light.
   226	- **(c) the lint's assertion becomes a boundary check** — MET. The predecessor lint is deleted.
   227	- **(b) every per-sender guard call is DELETED** — MET SEVEN OF EIGHT, and the eighth cannot be met.
   228	  The tokenless-standby relay egress hands the message to ANOTHER MACHINE; this process never makes a
   229	  request to the Telegram host, so the door cannot see it. Deleting that guard would open the hole the
   230	  spec's own §1 describes. The criterion was authored before that egress's nature was understood, and
   231	  the honest resolution is to name the exception rather than delete a guard to make a checklist even.
   232	  Of the seven removed, two were the funnel pre-format guards: execution showed every payload they
   233	  caught is still refused by the door and only the message changes, which is exactly the double-cover
   234	  the alternatives list rejects.
   235	- **(d) the vendored invisible-codepoint table** — NOT MET. Untouched; the predicate still uses runtime
   236	  `\p{...}` escapes, so it still depends on the host's Unicode version. Tracked as its own commitment
   237	  rather than folded into a claim of completion.
   238	
   239	## One term, used consistently: MECHANICALLY-VISIBLE (a term LOCAL to this spec)
   240	
   241	Round 3 asked for the distinction; round 5 correctly noted the document still slid between the two terms.
   242	**"Mechanically-visible" is this document's own term, not an industry or Unicode concept** — it names a specific implemented predicate and should not be read as a general standard for visibility. One term now carries the guarantee: **a payload is MECHANICALLY-VISIBLE when its reader-facing field
   243	contains at least one LETTER, NUMBER, PUNCTUATION MARK, SYMBOL, or MARK.**
   244	
   245	**That definition is POSITIVE, and round 6 is why.** It was subtractive — remove whitespace,
   246	`Default_Ignorable` and `Cf`, and treat whatever remained as visible. An external reviewer named that as an
   247	open world, and execution confirmed the hole: a payload of only a C0 control (`U+0001`, `U+0007`, `U+001B`),
   248	an unassigned code point, a private-use code point, a noncharacter, a lone combining mark, or a lone
   249	surrogate **ALL PASSED as visible** and would have been delivered. Every one renders as nothing or as tofu —
   250	the incident's exact harm on a wider input surface.
   251	
   252	**Subtracting the invisible is the same mistake as enumerating the senders: you can only remove the shapes
   253	you thought of.** Naming what COUNTS closes the world, including against whatever Unicode adds next. A mark
   254	attached to a base letter still passes, because the letter is content. **A LONE MARK ALSO PASSES** —
   255	review passes 30-31 measured the exclusion as an over-refusal of real text and admitted `\p{M}`. This
   256	sentence said the opposite until review pass 38 finding 5; it is the third pass to catch this claim in
   257	a spelling the previous sweep did not search, which is the argument for searching the CLAIM rather than
   258	one of its notations.
   259	
   260	**And the positive definition had its OWN false positives, found at round 10 and confirmed by execution:**
   261	five code points that are letters (`Lo`) or symbols (`So`) by General_Category and render as empty space —
   262	HANGUL FILLER, the two HANGUL CHOSEONG/JUNGSEONG FILLERS, HALFWIDTH HANGUL FILLER, and BRAILLE PATTERN
   263	BLANK. Each passed. A message of one HANGUL FILLER is the original incident wearing a letter's category.
   264	They are now subtracted from inside the positive set and pinned by fixtures. **Honest about what that
   265	is:** a subtraction has a tail, so a future category-positive blank code point would pass until it is
   266	added. That residual is accepted deliberately and named rather than papered over; the structural fix is the
   267	vendored, generated table under **CMT-1261**, which DERIVES blankness instead of listing it. That, and only that, is what
   268	the code asserts and what every acceptance criterion here means. Throughout this spec, **"reader-visible"
   269	names the PRODUCT INTENT** — the thing we are trying to protect. **The MECHANICAL GUARANTEE is narrower and
   270	is the only thing the code actually asserts:** the field contains at least one code point in
   271	`\p{L}\p{N}\p{P}\p{S}\p{M}` (marks included since review passes 30-31). Those are not the same claim — an unsupported glyph or a client-specific font can
   272	make a code point that PASSES this positive check still render as nothing to a particular reader, which is
   273	why the guarantee is mechanical rather than perceptual. Where this document says a payload is refused for having "no visible characters", read
   274	it as shorthand for the mechanical predicate; the guarantee has never been client-rendered visibility and
   275	must not be cited as though it were.
   276	
   277	## Signal vs authority
   278	
   279	**This is a HARD-INVARIANT VALIDATOR, and by the doc's own words that class is "not a decision point in the
   280	sense this principle applies to" — so it is exempt from the Signal-vs-Authority authority pattern rather
   281	than an instance of it.** Round 13 was right that calling it "authority" while claiming the exemption
   282	strained the vocabulary in both directions. It rejects malformed input at the API edge; it evaluates nothing
   283	about what a message means. **Structured refusal records are emitted anyway, for auditability rather than
   284	because the authority pattern compels them** — a validator that refuses silently is still a validator whose
   285	over-blocks nobody can find.
   286	
   287	It does refuse on paths that previously had no check: `editMessageText`, both lifeline sends, and forum-topic names had no guard before.
   288	The justification is not "no new authority"; it is grounded in the exception the doc actually names for this shape. **Round 12 was right that the fit was
   289	asserted rather than reconciled**, so it is reconciled here. The doc lists *"a deterministic policy evaluator
   290	for domains so constrained that all inputs can be enumerated"* — and arbitrary Unicode payloads are NOT
   291	enumerated, so that is the WRONG citation and this spec used it for four rounds. The correct one is
   292	**hard-invariant validation**: *"Typing and structural validators at the boundary of the system are not
   293	decision points in the sense this principle applies to — they don't evaluate messages, they reject malformed
   294	input. These belong at the API edge and are fine as brittle blockers."* That is exactly what this is — a
   295	structural validator sitting at the API edge, rejecting a payload that carries no content, evaluating
   296	nothing about what the message MEANS. A message of a single full stop passes,
   297	correctly. The lint's authority is a closed-world format invariant at a dev-process chokepoint.
   298	
   299	**Structured decision logging — the requirement this section MISSED until round 11.** `signal-vs-authority.md`
   300	states it plainly: *"Authorities must log their decisions in a structured form: which signals they received,
   301	what the conversation context was, which rule they applied, and what the outcome was."* This guard is
   302	blocking authority and logged nothing. The gap was raised at round 4, not acted on, and raised again at
   303	round 11 — seeing a finding and not acting on it is worse than not seeing it, and it is recorded that way.
   304	Every refusal now emits `{guard, outcome, method, field, rule, valueLength, engine, unicode}` through an
   305	injectable sink, the record is written BEFORE the throw so a caller that swallows the error cannot also
   306	swallow the record, a throwing sink can never convert a refusal into a delivery, and the payload itself is
   307	NEVER logged — length only, because an invisible payload is still user content. The decision also rides on
   308	the error, so a catcher can record it too.
   309	
   310	**On the doc's "conversation context" field, which this record OMITS — reconciled rather than quietly
   311	dropped (round 12).** The requirement exists so over-blocks and under-blocks become detectable. For a gate
   312	that weighs signals against a conversation, context is the evidence you need to judge whether it decided
   313	well. **This predicate is context-FREE by construction:** its verdict depends on the payload and nothing
   314	else, so no amount of conversational context could make an all-invisible payload the right thing to send,
   315	and none could explain a wrong decision. Recording a topic id would make the log look more compliant
   316	without making a single over-block or under-block more detectable. What DOES make them detectable is
   317	already there — the exact method, field, rule and payload length. And the sink is **injectable** precisely
   318	so a host that HAS correlation context can add it at the boundary where that context actually exists,
   319	rather than plumbing a topic id through six senders and a pure predicate to satisfy a field.
   320	
   321	## Decision points touched
   322	
   323	| decision point | classification | justification |
   324	|---|---|---|
   325	| **Refuse an outbound Telegram payload whose reader-visible field has no visible characters** | `invariant` | **Restated after round 1, and REPLACED after round 6.** The predicate is NOT "is this visible to a reader" — that depends on Unicode version, grapheme clustering, emoji modifiers and the rendering client, and is not settled. Nor is it the subtractive question it originally asked, which let eight non-printing categories through. What is closed and decidable is the POSITIVE question the code now asks: *does this string contain at least one letter, number, punctuation mark, symbol, or MARK* (`\p{L}\p{N}\p{P}\p{S}\p{M}`, resolved by the host engine's Unicode tables). **`\p{M}` was added at review passes 30-31**: excluding all marks over-refused real text, and the advance-width rationale for splitting Mn from Mc/Me was measured false on the host and withdrawn — a lone combining mark is content. This paragraph said L/N/P/S/M only until review pass 36 finding 7 caught the spec describing a predicate the code had stopped implementing. Deterministic for a given engine, no competing signal, and closed against categories nobody has thought of yet. There is no competing signal, no context that changes the answer, and no open-domain judgment about meaning — a single full stop passes, correctly. This is the **hard-invariant validation at the API edge** case (see *Signal vs authority* below, where round 12 corrected an earlier mis-citation of the enumerable-inputs exception), not a judgment point wearing an `invariant` label. |
   326	| **Which Telegram methods carry a reader-visible field** | `invariant`, as a **VERSIONED POLICY TABLE** | **Reclassified after round 1.** Calling this "a fact about the API" was wrong twice over: the Bot API can add or change methods, and the `answerCallbackQuery` exclusion is a product-behaviour judgment (an empty toast is *useful*), not a mechanical one. It is an invariant at RUNTIME — a closed code-defined map with no per-call judgment — but it is policy that carries a review trigger, not a timeless truth. **Review trigger:** any Bot API version bump, or any new `apiCall` method reaching a reader. The pinning test is what makes a silent drift impossible. |
   327	| **Whether a source file is a Telegram body-sender (the lint's population)** | `invariant` | Derived mechanically — builds the API host string AND calls `fetch` AND references a body-carrying method. No semantic judgment; a shrink-only ratchet makes a silent population loss loud. |
   328	
   329	> **Contested in both directions, per the standard.** None of the three is a competing-signals point dressed
   330	> as an invariant: none weighs evidence, none has an "it depends" case, and none can be right or wrong about
   331	> intent — only about characters, a code-defined map, and a mechanical file predicate. Conversely, none is
   332	> misfiled as a judgment-candidate: adding an arbiter to "does this string contain content" would be an LLM
   333	> call on a settled question, which *Intelligence Infers* would rightly refuse.
   334	
   335	## Multi-machine posture
   336	
   337	| surface | posture | note |
   338	|---|---|---|
   339	| the refusal predicate | `unified`, with a NAMED runtime dependency | **Corrected after round 2 — the first version overclaimed.** It is a pure function of the payload, but the predicate resolves through the host engine's Unicode tables, so "identical verdict on identical bytes" holds only while machines share a Unicode data version. **Restated at round 9, which caught this row still describing the SUPERSEDED subtractive design:** the drift that matters is no longer `Default_Ignorable`/`Cf` membership — it is **General_Category membership for `L`/`N`/`P`/`S`**, since those four categories are now what the code asks about. The residual is BOUNDED to code points whose L/N/P/S/M membership changed between Unicode releases (in practice, newly ASSIGNED code points: an unassigned point is not content on either version until it becomes a letter or symbol). An empty string, whitespace, ordinary text and emoji already assigned are decided identically on every version. **Direction of the residual, stated because it decides whether this is dangerous:** an older table has FEWER assigned letters/symbols, so an older machine REFUSES a payload made only of a newly-assigned character that a newer machine would send. That direction is fail-SAFE — the older machine withholds rather than delivering emptiness — which is why this is a named dependency rather than a blocker. **No runtime pin exists to cite, and I checked rather than assumed:** `engines.node` is `>=20.12.0` — a
   340	FLOOR, not a pin — CI runs Node 20, and this development machine runs Node 24, so a version spread is not
   341	hypothetical, it is the current state. The residual above is therefore live, bounded as described, and
   342	un-mitigated by any existing enforcement. Vendoring a generated table removes the dependency entirely and
   343	is the clean fix; it rides **CMT-1261** (it was CMT-1246's criterion (d), which shipped without it) and is NOT claimed here. |
   344	| the method→field map | `unified` | Compile-time constant shipped with the code. |
   345	| the lint | `unified` | Runs in CI and at commit time against the repository, not against machine state. |
   346	
   347	**No surface here is machine-local**, so no `machine-local-justification` marker is claimed — and the
   348	bidirectional check holds: `unified` is feasible for all three, because none is credential-bound or
   349	hardware-bound. The one adjacent thing that IS machine-local — a bot token and the topic ids it namespaces —
   350	is untouched by this change and is not a surface this spec introduces.
   351	
   352	## Frontloaded Decisions
   353	
   354	Every decision that would otherwise stop the build mid-run, resolved here:
   355	
   356	1. **Where the refusal sits** — refuse on the path-tested agent funnels; require guard-call PRESENCE in every derived direct-sender file until CMT-1248 makes them path-tested too. Not at a named "chokepoint" function. Resolved: two egress
   357	   mechanisms in the adapter (`apiCall` and the standby relay), one in the lifeline, four direct senders.
   358	2. **Whether to keep a second copy in `sendToTopic`** — no. Two copies closing the SAME case mask each
   359	   other's tests. The relay guard is not a second copy; it closes a DIFFERENT case, and each is
   360	   independently sabotage-proven.
   361	3. **Whether `answerCallbackQuery` is in scope** — no, on the over-refusal ground stated above.
   362	4. **Whether forum-topic names are in scope** — yes. Same class, different field, and swept inside this
   363	   change rather than left for later.
   364	5. **Throw vs silent drop** — throw. Both funnels already throw on a non-ok response, so it is the
   365	   established contract; a caller that swallows it drops an invisible message, which is the correct outcome.
   366	6. **Whether to raise the lint's population baseline automatically** — no. The ratchet is shrink-only and a
   367	   legitimate increase must be a deliberate edit in the same commit as the new sender.
   368	
   369	**Cheap-to-change-after tags claimed: none.** This ships live rather than dark, so no reversibility claim
   370	is being made and none needs contesting.
   371	
   372	## Open questions
   373	
   374	*(none)*
   375	
   376	## Known-open, tracked outside this spec
   377	
   378	**What a `CMT-` reference guarantees, since the term is local and a reader cannot verify it from this
   379	document** (round 13): a CMT is a row in the agent's durable commitment registry, created through an
   380	authenticated API that REFUSES creation without a follow-through choice — either enrolment in the recurring
   381	beacon with a real deadline, or an explicit written opt-out reason. Each carries an owner, a deadline, and a
   382	status; the beacon re-surfaces open ones on a cadence, and an overdue one is raised rather than forgotten.
   383	Failure becomes visible as an overdue open commitment in that registry, not as a silent lapse. The three
   384	below were created with 2026-08-17 deadlines and their ids were read back from the registry — an earlier
   385	attempt at the same three was REJECTED for lacking deadlines and would otherwise have been reported as
   386	tracked while existing nowhere.
   387	
   388	
   389	Two findings from convergence are real, are NOT closed by this change, and are registered as durable
   390	commitments rather than left as prose:
   391	
   392	- **CMT-1247 — the relay refusal-status mismatch is a protocol bug this guard only makes rarer.** The far
   393	  route answers **400** for a content refusal; `isRelayRefusal` recognises only **422**. The local guard
   394	  means an invisible payload no longer travels that path, but ANY other relay-side content refusal still
   395	  surfaces to a caller as "router unreachable". Normalizing the status/schema across that boundary is the
   396	  fix and it is out of scope here.
   397	- **CMT-1246 — LANDED 2026-08-11.** The paragraph below is the pre-ship reasoning, kept because it
   398	  states why the interim design was knowingly non-structural. Read it as history: the centralized client
   399	  exists (`src/messaging/telegram-egress.ts`), the derivation-plus-ratchet lint it criticises is deleted,
   400	  and the ship's true state against the four acceptance criteria is recorded in *CMT-1246 shipped* above —
   401	  including the one criterion that cannot be met and the one that was not. Review pass 36 finding 6 caught
   402	  this section still reading as though the work were pending, one screen after another section said it had
   403	  shipped; a spec that contradicts itself lets a maintainer trust whichever half suits them.
   404	- **The pre-ship reasoning: the centralized client is RISK RETIREMENT, not cleanup**, and round 5 was right to insist on
   405	  the distinction. The interim design is *knowingly non-structural*: it depends on source-shape derivation
   406	  plus a ratchet, and a ratchet catches a population SHRINKING, never a refactor semantically routing
   407	  around a guard that is still present in the file. **CMT-1246 is TIME-BOUND: its registered check-in is 2026-08-17, and it is the BLOCKING PREREQUISITE for any claim stronger than the one in the title**, and that is a
   408	  standing condition rather than an intention. **Stated consequence if it slips:** the guarantee in
   409	  this spec's title cannot be strengthened — "by presence at every derived sender" stays until CMT-1246
   410	  lands, and any future claim of path-complete egress coverage is unearned until it does. It carries the
   411	  vendored codepoint table with it, which also retires the Unicode dependency.
   412	
   413	## Maturation plan
   414	
   415	This change does **not** ship dark, and the reasoning matters: a dark invisible-payload guard would leave a
   416	live hole open while the fix sat inert, which is the state the incident already demonstrated is costly.
   417	Round 6 and round 10 each found a payload class that WAS being delivered — those are open holes today, not
   418	hypotheticals. It ships live, with the rollback in the section below reachable by deleting a small number of
   419	call sites and one lint entry.
   420	
   421	- **test-agent-live:** deploy to a throwaway agent via `/test-as-self` and drive an invisible payload
   422	  through the adapter's API funnel, its standby relay, and the lifeline funnel, confirming each refuses with
   423	  zero network calls AND that a structured refusal record is emitted. Then send ordinary text through the
   424	  same three and confirm delivery — a guard that refuses everything is not a guard. Verifies the feature is
   425	  alive before any real operator's traffic touches it.
   426	- **dev-agent-live:** live on this agent (echo) first, which is also the multi-machine case and therefore
   427	  the one that exercises the tokenless-standby relay path rather than only the direct-send shortcut. The
   428	  observable signal over 24h: zero user-visible "reply lost" notices whose body was empty, and any structured
   429	  refusal records that DO appear name a real method and field. **A zero-everywhere reading is not a pass** —
   430	  no refusals recorded is equally consistent with the guard never running, so the acceptance signal is the
   431	  fixtures continuing to red under sabotage, not the absence of production refusals.
   432	- **fleet:** after the dev-agent 24h window passes clean, in the next ordinary release. No per-agent flag:
   433	  the guard IS the change, and holding it back per-agent would mean the fleet keeps delivering invisible
   434	  payloads while the fix exists.
   435	- **graduation criterion:** one clean 24h window on this agent with no invisible-payload delivery and no
   436	  over-refusal of legitimate traffic (no report of a real message being rejected), PLUS the sabotage suite
   437	  still reddening on demand — 121 tests, both funnels and the lifeline path each proven to red only their
   438	  own arms. The over-refusal half is the one to watch, because this change widened what gets refused twice
   439	  (non-printing categories at round 6, blank glyphs at round 10).
   440	- **dark-window:** none for the refusal itself, per the reasoning above. The genuinely new-behaviour piece
   441	  carrying risk is the **widening** — categories that previously shipped and now do not — and its control is
   442	  not a dark window but the pinned fixtures plus the structured refusal record, which makes any over-refusal
   443	  visible and attributable the first time it happens rather than after a user reports a missing message.
   444	
   445	## Rollback
   446	
   447	Remove two guard calls in the adapter (funnel + relay), one in the lifeline, four one-line calls in the
   448	other senders, and one entry from the `lint` chain. No migration, no persisted state, no agent-state
   449	repair. Callers would resume delivering invisible payloads — the pre-change behaviour.
   450	
   451	## Acceptance criteria
   452	
   453	1. A payload that is not MECHANICALLY-VISIBLE is refused at **every path-tested agent funnel (proven by input, zero network calls)** and **a guard call is present in every lint-detected direct sender FILE (presence proven; behavioural refusal NOT proven)**. The word "guarded" is reserved throughout for input-proven paths.
   454	   Those are two different strengths and the criterion states both rather than averaging them into one word.
   455	   **Said without hedging: for the four direct command-file senders, nothing today executes an invisible
   456	   payload through their real send function — that is CMT-1248, and until it lands "presence" means the
   457	   call is in the file, nothing more.**
   458	   **Amended twice. Round 3 exposed a gap; round 4 caught the amendment CONTRADICTING the criterion it
   459	   amended — requiring "every derived egress, proven by input" while admitting most were not. Resolved by
   460	   closing the gap where it could be closed and stating the guarantee exactly where it could not.**
   461	
   462	   **Path-tested by input (3 of 3 funnels that carry agent traffic):** the adapter's API funnel, the
   463	   adapter's tokenless-standby relay, and the lifeline's own private funnel — each proven to refuse with
   464	   ZERO network calls and to deliver ordinary text, each sabotage-proven to red only its own arms.
   465	
   466	   **NOT path-tested (4 direct command-file senders — two setup-wizard greetings, a self-test probe, and a
   467	   demo-harness sender):** covered by the lint (the guard is called in the file) and by the shared guard's
   468	   unit tests, NOT by a test driving each real send function. **So the criterion reads, honestly: refusal
   469	   is PROVEN BY INPUT at every funnel carrying agent traffic, and PROVEN BY PRESENCE at the four direct
   470	   senders.** Tracked to closure as **CMT-1248**, not as a marker.
   471	2. Visible payloads still deliver, with the exact text asserted — discrimination, not shouting.
   472	3. Each egress guard is independently covered: removing one reds only its own arms.
   473	4. The over-refusal boundary holds: an empty `answerCallbackQuery` is not refused.
   474	5. The lint fails on a deleted, commented-out, decoyed, or unimported guard, and on a shrunken population —
   475	   each asserting its **specific failure string**, never a bare exit code.
   476	6. Full `lint` chain green; no pre-existing invisible-payload or window-10 test regresses.
   477	7. **Every refusal emits a structured decision** — method, field, rule, outcome, payload LENGTH (never the
   478	   payload), and the deciding engine + Unicode version, since the predicate is engine-resolved. Proven by
   479	   input, including that a throwing sink still refuses.
   480	8. **Boundary code points are pinned by fixtures that run on whatever engine executes them** (added on a
   481	   round-5 finding), so a Unicode-table divergence between the supported floor and the CI version reds a
   482	   test instead of being assumed away. The fixtures cover eight zero-width/ignorable boundary points, SEVEN
   483	   NON-PRINTING code points that the old subtractive predicate delivered (C0 controls, unassigned,
   484	   private-use, noncharacter, lone surrogate), and TEN positive controls that must still pass — a full
   485	   stop, a digit, an emoji,
   486	   a base letter carrying a combining acute, and a letter beside an ideographic space. "Control" here means
   487	   a TEST control, never a Unicode control character. The run records its engine, so a divergence is
   488	   attributable rather than mysterious.
   489	
   490	## Verification performed
   491	
   492	- 28 tests in `tests/unit/telegram-send-funnel-invisible-payload.test.ts`; **90 green** across it plus every
   493	  pre-existing invisible-payload and window-10 behavioural test.
   494	- Both egress guards sabotage-proven: removing the relay guard reds exactly its 7 arms with the funnel arms
   495	  green; removing the funnel guard reds exactly its 7 with the relay arms green.
   496	- All five reviewer escapes on the lint closed and re-proven by specific failure string.
   497	- Full `lint` chain exit 0; `tsc --noEmit` clean.
   498	
   499	## Known limits, stated rather than claimed as covered
   500	
   501	- **SEMANTIC BYPASS is the named residual risk, not a theoretical one.** The lint proves a guard is CALLED
   502	  in a sender file, **not that it sits on the path the send takes** —
   503	  a future refactor can satisfy the lint while routing around the guarded call. This is a real boundary
   504	  weakness, not a cosmetic one, and it is the reason the shared-client alternative below is the correct end
   505	  state rather than a nicety. Nothing in this spec should be read as claiming the lint derives guarded
   506	  egress PATHS; it derives guarded FILES. The per-path guarantee is carried entirely by tests.
   507	- A sender reaching Telegram by some mechanism other than a direct `fetch` to the API host falls outside
   508	  the derived population. The shrink ratchet makes a disappearance visible but cannot pre-empt a new shape.
   509	- Non-Telegram adapters (Slack, WhatsApp, iMessage) are entirely out of scope and are not claimed.
     1	import { describe, it, expect, vi, afterEach } from 'vitest';
     2	import { relayOutbound, isRelayRefusal } from '../../src/core/TelegramRelay.js';
     3	
     4	/**
     5	 * CMT-1247. `relayOutbound` classifies a holder response as a REFUSAL only on 422; every other
     6	 * non-ok status collapses to `null`, which the standby's send path reports as
     7	 * "telegram outbound relay failed (tokenless standby, router unreachable)".
     8	 *
     9	 * That is the conflation TelegramRelay's own header records having fixed for tone-gate nudges — a
    10	 * refusal reported as a transport failure is unanswerable, because the agent sees a network error
    11	 * instead of the rule and how to proceed. The fix was applied to 422 and the CONTRACT was left
    12	 * narrow, so any refusal the holder expresses with a different status still conflates.
    13	 *
    14	 * The invisible-payload guard is one such refusal: the holder-side route does not classify
    15	 * `InvisiblePayloadRefusedError` at all (it appears in neither routes.ts nor server.ts), so a
    16	 * content refusal there does not emerge as 422.
    17	 *
    18	 * These tests PIN the current behaviour rather than assert the desired one, so the suite stays
    19	 * green while the defect stays visible and precisely located. When CMT-1247 lands — by normalising
    20	 * the holder's content refusal to 422, which is the narrower change than widening this client to
    21	 * accept 400 (a status that legitimately also means "malformed request") — the second test is the
    22	 * one that must flip, and its message says so.
    23	 */
    24	const deps = (fetchImpl: typeof fetch) => {
    25	  vi.stubGlobal('fetch', fetchImpl);
    26	  return {
    27	    leaseHolder: () => 'holder-machine',
    28	    selfMachineId: 'standby-machine',
    29	    peerUrl: () => 'https://holder.invalid',
    30	    authToken: () => 'tok',
    31	    log: () => {},
    32	  } as unknown as Parameters<typeof relayOutbound>[3];
    33	};
    34	
    35	afterEach(() => vi.unstubAllGlobals());
    36	
    37	describe('relay refusal recognition — status contract (CMT-1247)', () => {
    38	  it('a 422 from the holder is carried back as an actionable refusal', () => {
    39	    const d = deps((async () => new Response(JSON.stringify({ error: 'tone-gate-advisory' }), { status: 422 })) as typeof fetch);
    40	    return relayOutbound(7, 'hello', undefined, d).then((r) => {
    41	      expect(isRelayRefusal(r)).toBe(true);
    42	      expect((r as { body: Record<string, unknown> }).body.error).toBe('tone-gate-advisory');
    43	    });
    44	  });
    45	
    46	  it('CURRENT, DEFECTIVE: a refusal expressed with any other status becomes indistinguishable from unreachable', async () => {
    47	    const f = vi.fn(async () => new Response(
    48	      JSON.stringify({ error: 'invisible-payload', refused: true }), { status: 400 },
    49	    ));
    50	    const d = deps(f as unknown as typeof fetch);
    51	    const r = await relayOutbound(7, '​', undefined, d);
    52	    // Prove the null came from the STATUS CLASSIFICATION, not from an early return before the
    53	    // request was ever made — otherwise this test would pass for a reason that has nothing to do
    54	    // with the defect it claims to pin.
    55	    expect(f, 'the holder must actually have been called').toHaveBeenCalledTimes(1);
    56	    // The holder said "refused", with a reason, in the body. The client cannot tell that apart from
    57	    // a dead router, so the standby will report "router unreachable" for a CONTENT refusal.
    58	    expect(
    59	      r,
    60	      'CMT-1247 fixed? Then the holder now expresses content refusals as 422 and this must become a '
    61	      + 'RelayRefusal — update this test rather than widening the client to accept 400.',
    62	    ).toBeNull();
    63	    expect(isRelayRefusal(r)).toBe(false);
    64	  });
    65	
    66	  it('a genuine transport failure is also null — which is exactly why the above is ambiguous', async () => {
    67	    const d = deps((async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch);
    68	    expect(await relayOutbound(7, 'hello', undefined, d)).toBeNull();
    69	  });
    70	});
     1	/**
     2	 * ROUTE-level tests for the invisible-payload refusal at the /telegram/reply chokepoint.
     3	 *
     4	 * ── Why this file exists separately ────────────────────────────────────────────────────────────
     5	 * `telegram-reply-invisible-payload.test.ts` tests the PREDICATE, and review pass 9 was right to
     6	 * make it import the shared definition rather than re-declare it — neutering
     7	 * `hasNoVisibleCharacters` now turns that file red. But pass 10 showed that was still not a
     8	 * regression test for the ROUTE: deleting the entire `if (hasNoVisibleCharacters(text))` block from
     9	 * `src/server/routes.ts` left all four predicate tests green. A file whose header called itself a
    10	 * regression test for a route never touched the route.
    11	 *
    12	 * That is the same defect one level along: the fix closed the demonstrated instance (the test had
    13	 * its own copy of the predicate) and then certified the class (that the route was regression-tested).
    14	 * The predicate being shared proves the two expressions agree; it says nothing about whether the
    15	 * route still calls it.
    16	 *
    17	 * ── Copied, not invented ───────────────────────────────────────────────────────────────────────
    18	 * This harness is `tests/unit/localhost-link-guard-route.test.ts` with the payloads changed. That
    19	 * file already tests a deterministic guard on THIS EXACT route, and pass 10 pointed at it directly.
    20	 * Adopting a proven pattern rather than authoring a fresh one is the whole lesson of this window:
    21	 * every fresh invention here has opened a new hole, and copying has not.
    22	 *
    23	 * Two details inherited from it that are load-bearing, and would have cost an hour to rediscover:
    24	 *   • The stateDir must be a fresh mkdtemp. A literal '/tmp' shares outbound-dedup.db across runs,
    25	 *     so a prior run's dedup record for these exact texts silently suppresses this run's sends —
    26	 *     which surfaces as a 200 with zero sendToTopic calls and reads exactly like a passing test.
    27	 *   • NO messagingToneGate is configured, deliberately. The refusal must hold independently of the
    28	 *     LLM authority; wiring a gate here would let the gate's verdict stand in for the guard's.
    29	 */
    30	
    31	import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
    32	import express from 'express';
    33	import type { AddressInfo } from 'node:net';
    34	import fs from 'node:fs';
    35	import os from 'node:os';
    36	import path from 'node:path';
    37	import { createRoutes } from '../../src/server/routes.js';
    38	import { SafeFsExecutor } from '../../src/core/SafeFsExecutor.js';
    39	
    40	describe('invisible-payload guard — /telegram/reply chokepoint', () => {
    41	  let server: { url: string; close: () => Promise<void> };
    42	  let sendToTopic: ReturnType<typeof vi.fn>;
    43	  let stateDir: string;
    44	
    45	  beforeEach(async () => {
    46	    stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'invisible-payload-'));
    47	    sendToTopic = vi.fn().mockResolvedValue({ messageId: 42, topicId: 12476 });
    48	    const ctx: any = {
    49	      telegram: { sendToTopic },
    50	      sessionManager: { clearInjectionTracker: vi.fn() },
    51	      config: { authToken: 't', stateDir, port: 0 },
    52	      stateDir,
    53	    };
    54	    const app = express();
    55	    app.use(express.json());
    56	    app.use(createRoutes(ctx));
    57	    server = await new Promise((resolve) => {
    58	      const srv = app.listen(0, () =>
    59	        resolve({
    60	          url: `http://127.0.0.1:${(srv.address() as AddressInfo).port}`,
    61	          close: () => new Promise<void>((r) => srv.close(() => r())),
    62	        }),
    63	      );
    64	    });
    65	  });
    66	
    67	  afterEach(async () => {
    68	    await server.close();
    69	    SafeFsExecutor.safeRmSync(stateDir, {
    70	      recursive: true,
    71	      force: true,
    72	      operation: 'tests/unit/telegram-reply-invisible-payload-route.test.ts',
    73	    });
    74	  });
    75	
    76	  async function reply(text: string) {
    77	    return fetch(`${server.url}/telegram/reply/12476`, {
    78	      method: 'POST',
    79	      headers: { 'Content-Type': 'application/json' },
    80	      body: JSON.stringify({ text }),
    81	    });
    82	  }
    83	
    84	  it('refuses the exact incident payload (a lone U+200B) and never sends', async () => {
    85	    const res = await reply('​');
    86	    expect(res.status).toBe(400);
    87	    const body = await res.json();
    88	    expect(body.error).toContain('no visible characters');
    89	    expect(sendToTopic).not.toHaveBeenCalled();
    90	  });
    91	
    92	  it('refuses the wider invisible class at the route, not only in the predicate', async () => {
    93	    for (const ch of ['‎', '⁡', '️', '­', '᠎', '﻿']) {
    94	      const res = await reply(ch);
    95	      expect(res.status, `U+${ch.codePointAt(0)!.toString(16).toUpperCase()} should be refused`).toBe(400);
    96	    }
    97	    expect(sendToTopic).not.toHaveBeenCalled();
    98	  });
    99	
   100	  it('refuses a whitespace-only body and never sends', async () => {
   101	    const res = await reply('   \n\t ');
   102	    expect(res.status).toBe(400);
   103	    expect(sendToTopic).not.toHaveBeenCalled();
   104	  });
   105	
   106	  // The direction that matters most: over-refusal eats real messages silently, which is a worse
   107	  // failure than the one this guard was built for — the user at least SEES a delivery error.
   108	  it('sends a message with real content', async () => {
   109	    const res = await reply('a genuine reply');
   110	    expect(res.status).toBe(200);
   111	    expect(sendToTopic).toHaveBeenCalledTimes(1);
   112	  });
   113	
   114	  it('sends a single full stop — minimal but visible', async () => {
   115	    const res = await reply('.');
   116	    expect(res.status).toBe(200);
   117	    expect(sendToTopic).toHaveBeenCalledTimes(1);
   118	  });
   119	
   120	  it('sends visible content padded with invisible characters', async () => {
   121	    const res = await reply('​x​');
   122	    expect(res.status).toBe(200);
   123	    expect(sendToTopic).toHaveBeenCalledTimes(1);
   124	  });
   125	});
