# Convergence Report — Documents from any computer: a team invite opens a computer, no app needed

**Spec:** [docs/specs/member-browser-any-computer.md](../member-browser-any-computer.md)
**Slug:** `member-browser-any-computer`
**Converged at:** 2026-11-20T21:22:15Z
**Iterations:** 6 (the Tier 2 cap)
**Final-round design findings:** 2, fixed at the cap without another round (see Convergence verdict)

## Cross-model review: codex-cli:gpt-6.2-astra

A real GPT-tier external pass ran through the agent's codex CLI in all six rounds, each on the spec text as it stood. A clean-door Anthropic second read (`claude-code:claude-fable-5`, not cross-family) also ran in all six rounds. Gemini was not available (`gemini-not-authed`).

## ELI10 Overview

Team members can comment on the agent's documents today only through the Instar iPhone app, or from a computer they linked with that app. People without the app are shut out. Until that's fixed, documents stay switched off for everyone except development agents.

This spec reuses the invite link the owner already sends a new team member. Opened on a computer, the link offers "Use this computer instead". The computer makes its own key, and the owner reads out a code that appears only on the owner's phone. The member types it, and that browser can read and comment on their documents. It can't reach chats or anything else. The safety step is the same one that protects a member's phone today: nothing gets in without the owner's code. The computer stays in while it's used, up to 90 days, and the agent can remove one when the owner asks.

The trade-off: a browser key isn't a passkey, so no fingerprint is needed per comment. The spec explains why a passkey would add little here: the agent serves the page, so a touch can't prove what was signed. It also keeps the final say with the owner: documents don't go to everyone until the owner taps Approve on that trade-off.

## Original vs Converged

- **Who can invite.** The first draft let team admins invite computers. The code has no admin invite path, so only the owner's phone can invite. The waiting code is also taken off the PIN dashboard, which the agent itself can unlock. That change ships for every agent, and it protects team phones too.
- **Telling the owner.** The draft claimed the owner was notified. The code didn't do that for team devices. The owner now gets a push with check letters, and a reminder before a computer's 90 days end.
- **Every machine.** Round 2 tried to set one computer up on every machine's address at once ("siblings"). The review found that this brought back the chained-enrollment problems in a smaller form. It was replaced by one address per computer, with a way back from any other address. A machine rebuilt at the same address takes its computers back over through a replicated adopt row, even with a new machine identity. That is the 2026-11-20 Studio case.
- **Staying in.** The first draft had a fixed 30 days and then a re-invite: a monthly ask of the owner. Now each use extends it (written about weekly, only by the computer's home machine), up to 90 days. The limits are replicated rows the owner can change through the agent, for everyone or for one person. They apply only at admission, and rows are judged against fixed bounds, so machines always agree.
- **Older machines.** Review found that an older machine treats an unknown team-log row as a gap and holds every team phone. So the new rows have their own types, and nothing writes them until every pool machine advertises that it reads them. The advert is sticky, so a machine that's only asleep doesn't block.
- **Expiry and crashes.** Expiry no longer writes a permanent revocation, so a machine that hasn't seen a renew can't end a computer for good. Confirm has a commit point, a reconcile step, and a separate route that the old phone-confirm route refuses.
- **The release condition.** The documents spec's Decision 14 said documents wait for "the passkeys project". This is that project, but it doesn't use passkeys. So accepting browser keys in their place is put to the owner as one Approve/Decline when the fleet turn-on is proposed. The agent doesn't settle it.

## Experience fit

- **Goal.** The source is the documents spec's Decision 14, which records the operator's 2026-11-10 request. The goal: a team member reads and comments from any computer, without the app, safely. The operator also wants minimum effort and plain words.
- **Ordinary journey.** The owner invites as usual, gets one push, checks the check letters, and reads out one code. The member types it and is in. The member's other paths are covered: rejoining after a rebuild needs no new invite, and a member at the limit, holding a spent link, or opening a link on the wrong machine each gets a plain page. Owner effort per computer: one code at join, and at most one re-invite every 90 days, with a reminder.
- **Contrasting cases.** A guest only reads. A member lowered to guest keeps reading. A removed person's computers end. A stranger holding a copied link gets no code.
- **Evidence limits.** The owner-ask load is not measured, and the graduation criterion asks for it. Safari's storage eviction may shorten the real lifetime, and that is stated to members.

## Iteration Summary

| Iteration | Reviewers who flagged design issues | Design findings (approx., before de-duplication) | Precision findings (approx.) | Spec sections changed |
|---|---|---|---|---|
| 1 | security, adversarial, integration, decision-completeness, lessons-aware, codex, clean-door, SCG | 27 | 21 | rewrite (owner-only inviter, separate confirm, owner notice, PIN fix, limits as settings, origin gap) |
| 2 | all six internal + codex + clean-door | 19 | 22 | siblings introduced, then dropped; renew rules; limits basis |
| 3 | security+adversarial, integration+scalability, decision+lessons, codex | 11 | 14 | lease rules, rebuild adoption, per-person limits, Send limit, fleet decision |
| 4 | all three combined + codex + clean-door | 8 | 16 | distinct event types, replicated adopt, limits ordering, held code, landing |
| 5 | integration+scalability, codex | 5 | 13 | all-peers write gate, expiry writes nothing, commit point, old route refusal |
| 6 | integration+scalability, decision+lessons, codex | 6 (2 internal, 4 codex) | 12 | advert carrier, sticky advert, intended bind, Forget clears drafts (fixed at cap) |

Rounds 1 and 2 ran six separate internal reviewers. Rounds 3 to 6 ran the same six perspectives as three combined reviewers (security+adversarial, integration+scalability, decision-completeness+lessons-aware), each following both perspective templates. The internal reviewers ran on the authoring session's model (Claude Opus 5.5). Standards-Conformance Gate: ran every round. Round 1: 6 flags; round 2: 7; round 3: 10; round 4: 9; round 5: 8; round 6: 7. None was degraded.

## Proportion

This is Tier 2: security-sensitive, touching identity and access and replicated state. It changes a spec of about 400 lines that governs roughly 8 build steps. It used 6 of 6 rounds. ⚠ That effort is high for one feature. It went mostly to multi-machine correctness: older readers, rebuild identity, renewal ordering. One design direction, siblings, was tried and dropped in round 2.

## Left behind

See the spec's `## Left behind` section. In short:
- **Fixed at the cap, not re-reviewed:** advert carrier, sticky advert, intended bind in the pending record, Forget clearing drafts.
- **Accepted stated limits:** rollback after enrollment, Send while the home machine isn't serving, the relayed lookalike page, one address per computer.
- **Declined with reasons:** Send forwarding, one-tap owner approval, an automatic re-invite, derived limit values.
- **Precision:** an RFC 8628 note, a clock-skew message, coarse location instead of an IP, a note on the frozen pair-link format, splitting §3.5.
- **Feedback queue:** fb-8dc58d7e-9d2 and fb-ac5cd939-bd7.

## Full Findings Catalog

### Round 1
## Round 1 — scalability (internal)
1 [PRECISION] linkStillValid reads DeviceRecord; branch on record joinedVia, test survive sweep.
2 [PRECISION] pending TTL/cleanup = team phones; pending not counted in allowance.
3 [PRECISION] name the rate limiter (reuse redeem limiter).
4 [DESIGN low] cross-machine allowance race → sweep forgets newest over 3.
5 [PRECISION] computers field: one pass grouped by person.
## Round 1 — decision-completeness (internal)  counts: frontloaded 7, cheap 1, contested-cleared 1
- [DESIGN] 3/4/30 limits: citing parent is circular; named arbiter (mobilePairing.browser settings) does not exist — constants hard-coded. → make defaults + real arbiter (config override floor).
- [DESIGN] Only owner may invite (ownerDevice() teamRoutes 214-222); no manageTeam path; existingPersonKey mint writes no event. → inviter = owner; fix §2/§3.1.
- [DESIGN] limit-reached message offloads to member → page names computers, owner/agent removes or code-authorized replace.
- [DESIGN] renewal: inviter naming; does renewal free slot?
- [DESIGN] "week ahead" reminder: where it lives (page-computed).
- [DESIGN] §4 app suggestion with no tracked handoff → tracked commitment or drop.
- [PRECISION] arbiter wording; address source cf-connecting-ip only via tunnel.
## Round 1 — codex-cli:gpt-6.2-astra (external)
**Verdict: SERIOUS ISSUES**

- **DESIGN — Enrollment authority (§§2, 3.1–3.3).** The draft lets a `manageTeam` admin issue an “another device” invite for an existing person. Team Roles §4.1 explicitly reserves that operation for the owner. Team Roles §3.4 also requires the inviter to retain authority at redeem and activation. The proposed confirm branch checks only the recipient’s tier and allowance. Keep existing-person enrollment owner-only, store the actual inviter and standing-event reference with each invite, and recheck both parties at redeem and confirm. A person’s latest event need not have been signed by the inviter.

- **DESIGN — Browser access after a machine switch (§§3.1, 5, 7, 10).** The browser stores its signing key in IndexedDB on the joining machine’s tunnel origin. Documents §§3.6 and 5.4 describe per-machine tunnel origins. A page opened on B’s origin cannot use A’s IndexedDB key. B accepting a replicated comment proves signature verification only. Specify a stable browser origin that routes to either machine, or require enrollment per origin. Test a fresh browser write through B after A goes offline.

- **DESIGN — Fleet release condition (§§1, 13, Maturation plan).** The draft says app-free commenting clears Decision 14. The approved Documents §13 Decision 14 explicitly keeps the fleet dark until the passkeys project ships. Record an approved amendment accepting invite-based enrollment as the replacement before declaring the release condition satisfied.

- **DESIGN — Concurrent enrollment (§§3.3, 5, 6).** With two live computers, two machines can each observe one free slot and confirm before either receives the other’s row. Rechecking locally at confirm permits four live computers. Serialize admissions per person if three is a hard limit, or specify the permitted overshoot and reconciliation behavior. Test simultaneous confirmations on different hosts.

- **DESIGN — Downgrade behavior (§§3.4–3.5, 12).** The validity rule rejects a binding whose scope exceeds the current tier, and the sweep forgets it. The test expects a member lowered to guest to keep reading. Choose one outcome. For continued reading, retain the binding and intersect its scope with the current tier on every request. Verify reads and refused writes both before and after the sweep.

## Round 1 — clean-door claude-code:claude-fable-5
**Note on provenance:** I am a Claude model (Fable 5), not a GPT-tier reviewer — the dispatch's framing is wrong on that point and I won't claim otherwise. I've applied the outside-perspective lens as asked, grounding everything in the inlined text only.

**Verdict: MINOR ISSUES** (one finding is DESIGN-classified on internal-consistency grounds)

**1. DESIGN — Who can read the held code? (§2 vs §3.1 steps 1/5)**
§3.1 step 1 allows an admin with `manageTeam` to invite; step 5 assumes "the inviter's People screen" shows the code. But the spec's own §2 annotates the code-read route (`GET /mobile/team/invites/:personKey`) as **owner phone**, while the team-roles context says admins approve members/guests via `GET /mobile/team/invites/:id` — a different route shape. As written, an admin-initiated invite may dead-end: the admin mints the link but cannot retrieve the confirmation code. Resolution: verify which tiers the code-read route actually serves and state it; if owner-only today, the spec must open it to admin inviters for members/guests (a buildable change).

**2. PRECISION — `inviterName` can name the wrong person (§3.3 item 1)**
For an `existingPersonKey` invite, no new log event is written (§2), so "the signer of the latest event that minted the link" may be a different admin than the one who minted the code. The page would say "Ask \<wrong person\> for your code." Resolution: record the requesting inviter in the `PairingCodeStore` entry at mint time and derive the name from that.

**3. PRECISION — Browser storage eviction shortens the 30-day link (§3.1 step 3)**
A non-extractable key in IndexedDB is subject to eviction: Safari deletes script-writable storage after ~7 days without site interaction; "clear site data" and private windows kill it immediately. Failure is graceful (re-invite), but the effective lifetime on Safari undercuts the feature's promise. Resolution: call `navigator.storage.persist()`, and state the limit and its recovery path in §3.1/§8.

**4. PRECISION — Older-peer rejection semantics (§3.4)**
"An older peer rejects the row as invalid" should state that rejection is content-level (row ignored/quarantined per the team-log rules) and does not break per-origin chain continuity or trigger the 2b gap/hold machinery — a new row shape must never hold the whole team on an un-updated machine.

**5. PRECISION — Pending-computer lifetime unspecified (§3.1 step 5)**
`expiresAt` is returned but no TTL is stated for how long an unconfirmed computer waits. State it.

Industry-pattern check: invite + out-of-band confirmation code is standard device enrollment (cf. Matrix/TOTP pairing); §13a's alternatives analysis is honest and complete for this architecture. No LLM-in-the-loop or consent-flow over-engineering — access decisions are fully deterministic, which is correct here.

## Round 1 — Standards-Conformance Gate: ran (6 flags)
102 {"parentPrinciple": "The Person Decides; the Agent Does the Rest (STANDARDS-REGISTRY). Rule 123: An Instar Agent Always Serves a Team. Instar Documents Frontloaded Decision 14 (docs/specs/instar-document-viewer.md \u00a713): documents stay dark on the fleet until a member can comment from a computer without the iPhone app.", "checkedAt": "2026-11-20T20:54:03.745Z", "verdict": "fit", "parentResolved": true, "reason": "The design directly applies the team standard by letting an inviter confirm a computer for a specific person and checking that person\u2019s current team role and existing documen
6
- Judgment Within Floors possible-violation : The draft gives no safety or capacity evidence for refusing a fourth live computer, a fifth replacement in an hour, or continued use of a managed computer after 30 days; each can be legitimate, and contextual judgment could admit it within evidenced resource bounds and the existing identity, scope, and revocation checks.
- Know Your Principal — An Unverified Identity Is a Guess possible-violation : The join page may identify the signer of the original person-add event as the inviter even when a different admin minted the current invite, directing the member to someone whose role in this enrollment has not been verified.
- Verify the State, Not Its Symbol possible-violation : The draft claims the inviter can distinguish the member’s pending computer by browser, address, and request age, although two computers on the same network can present identical browser descriptions and request codes at the same time.
- Cross-Machine Coherence — One Agent, Robust Under Degraded Conditions possible-violation : Two machines can each confirm a different host-bound invite against the same last available allowance before their binding rows replicate, so the local recheck cannot enforce the claimed pool-wide limit.
- An Instar Agent Is Always a Multi-Machine Entity possible-violation : The rollout explicitly permits an older installed machine to omit a valid computer binding and report the computer as revoked, so a member loses established access if that machine is the only one available.
- The Person Decides; the Agent Does the Rest possible-violation : At the device limit the page tells the member to find an old computer and remove it manually, even though the design already lets the agent perform that removal once the owner identifies the computer and authorizes it.
## Round 1 — lessons-aware (internal)
- [DESIGN high] F1 held team codes readable by any PIN session via GET /mobile/pairing-approvals (dashboardApprovals no role filter) → exclude team codes (foundation fix).
- [DESIGN med] F2 notifyOwnerPhones skips team devices (approvable false) → add contentless push/attention "X is waiting for a code".
- [DESIGN med] F3 30-day re-invite = monthly owner ask → sliding renewal on use, absolute cap.
- [DESIGN low] F4 limits arbiter does not exist → config setting.
- [PRECISION] F5 owner-only inviter. F6 confirm branch order / dashboard-pin stamp. F7 team phones labelled dashboard-pin (foundation, left behind→feedback). F8 held code memory-only, one machine.
## Round 1 — adversarial (internal)
- [DESIGN] confirm via /mobile/device/confirm blocked by device middleware for scoped browser without linkExpiresAt → own route /docs/_join/confirm.
- [DESIGN] branch order: svc.browser.activate / dashboard-pin → separate route avoids.
- [DESIGN] documentDeviceKeyAt / originCheck deviceStoodAt historical re-check uses verifyBrowserLink → add via branch; past comments must verify after unbind.
- [DESIGN] owner-only inviter; store inviter in PairingCodeStore at mint.
- [DESIGN] PIN session sees team codes (same as F1).
- [PRECISION] pending joined computer blocks owner browser setup (browser-setup-waiting); recover() ignore.
- [PRECISION] approvalPath/lease check on redeem: keep as team phones.
- [PRECISION] older machines answer unknown not revoked.
- [PRECISION] noteLinkReused only with pairing-approve enabled.
## Round 1 — security (internal)
- [DESIGN] owner-only inviter; drop admin reasoning §3.5.
- [DESIGN] no team-device notice exists (approvable false) → add one.
- [DESIGN] PIN session reads team codes → exclude.
- [DESIGN] GET /mobile/team/invites returns only deviceId/deviceName/code/expiresAt → bake absolute-time text into deviceName, no app change.
- [DESIGN] noteLinkReused conditional on pairing-approve + phone wording → call noteLinkTaken, computer wording, state dependency.
- [DESIGN] confirm branch ordering/dashboard-pin stamp.
- [DESIGN] team-invite shape must refuse boundTo owner/owner-browser and existing bindings.
- [PRECISION] null peek must go to codes.redeem (failed-redeem counting).
- [PRECISION] history.replaceState clearing fragment.
- [PRECISION] concurrent allowance.
- [PRECISION] bindTeamPhones skips team browsers — protected rule + test.
## Round 1 — integration (internal)
- [DESIGN] owner-only inviter (dup).
- [DESIGN] no team push; browser-approval subject wrong → new subject.
- [DESIGN] older peers: event dropped (knownEvents), ledger ok → role unknown → originCheck 'pending' not revoked; rolled-back machine holding local record sweeps it (linkStillValid fails) → replicated revoke + unbind, permanent.
- [DESIGN] deviceStoodAt (originCheck:99) + documentDeviceKeyAt need via branch.
- [DESIGN] site deploys separately → mintTeamLink adds &j=1 only when switches on; page shows button only with flag.
- [DESIGN] Standard A markers missing for pending record + held code.
- [PRECISION] invites route returns 4 fields → bake text in deviceName.
- [PRECISION] GET /mobile/browsers host/fingerprint from signed → put host+browserPublicKey in new row.
- [PRECISION] confirm ordering; dashboard-pin; wrong-codes DM wording.


### Round 2
## Round 2 — scalability
- [DESIGN] renew rows grow log re-read by teamStateAt per historical re-check → renew only when < idleDays-7d remains (~weekly); cache teamStateAt per access vector.
- [DESIGN] renews from several machines duplicate → lease holder only writes renews.
- [PRECISION] cache computerStanding verdict by (keyHash, log position, ledger len).
- [PRECISION] ending must write browser-unbind (deviceStoodAt needs it); test expiry path.
- [PRECISION] over-limit attention closes when back under.
## Round 2 — decision-completeness  counts: frontloaded 9, cheap 1, contested-cleared 2
- [DESIGN] range ceilings lack basis → state basis or drop ceilings.
- [DESIGN] instar.sh deploy has no route → confirm vercel auto-deploy or name owner; add to completion.
- [PRECISION] list other fixed limits in §6; overshoot rule row; dup agent-wide note; task 8 in build order; lease row evidence.
## Round 2 — codex-cli:gpt-6.2-astra
ok gpt-6.2-astra SERIOUS ISSUES None
**Verdict: SERIOUS ISSUES**

- **DESIGN — Sibling enrollment proves delegation, not physical device identity (§§3.6, 8, 13 decision 2).** The existing key signs a public key, host and nonce. Those fields establish which key it authorized. None establishes that both keys reside on one computer. The one-key-per-origin limit therefore bounds keys per group, while the owner is told it bounds computers. If each computer requires owner approval, retain one browser origin for the group or require owner approval for each independently enrolled key. If delegation is acceptable, expose that choice in the owner’s inventory and revise the allowance.

- **DESIGN — Send has contradictory route requirements (§§3.2, 12; Documents §§3.6a, 3.8).** The draft promises the fixed-template Send and requires every `/mobile/*` route to refuse a joined browser. The parent design delivers Send through the existing conversation send routes and expressly permits that scoped exception. Specify the exact exception or a document-scoped endpoint that invokes the same delivery checks. The live proof should verify one delivered message after a retry for both Telegram and app conversations.

- **DESIGN — Mutable settings can change historical verdicts (§§3.4–3.5; Documents §6).** Bind validation uses `idleDays`, and the renewal fold uses `maxDays`. Neither row records which policy applied. A peer rebuilding after a settings change can therefore reject a previously valid bind or calculate a different expiry for an old comment. Record the effective lifetime limits at admission and use immutable format bounds for replay. Test the same signed history before and after changing both settings.

- **DESIGN — Lease placement can strand a fresh invite (§§2, 3.3, 5; Team Roles §3.6).** The owner’s phone talks to the machine holding its local record. Its invite code is held in memory and bound to that host, while computer confirmation requires the lease holder. If those machines already differ at mint time, following the recovery instruction can produce another unusable link without any lease move. Arrange for computer-capable invites to be minted and confirmed on a reachable admission host, with the code readable through the owner’s phone. Test with the phone on A and the lease on B throughout.
## Round 2 — clean-door claude-code:claude-fable-5
ok claude-fable-5 MINOR ISSUES None
**Verdict: MINOR ISSUES**

The design is sound: a device-code-style enrollment anchored on the owner's existing invite, deterministic access decisions, no LLM in any loop, honest stated limits. Alternatives (§13a) are genuinely engaged, including refuting passkeys with a correct argument (the agent serves the page, so a touch doesn't prove what was signed). Findings:

**1. DESIGN — Relay variant of the intercepted-link threat is not covered (§3.2, §8).** The security table says an interceptor's redeem makes the member's own attempt fail and mismatched check letters warn the owner. That holds only if the attacker *copies* the link. If the attacker can intercept the delivery channel, they can instead hand the member a lookalike page that proxies the real flow: the attacker redeems with their own key, the fake page shows the attacker's check letters, the member reads them to the owner — they match — the member types the code into the fake page, and the attacker confirms. The member's redeem never fails because it never happens. The sibling documents spec explicitly stated the analogous relay for QR linking (§3.6a item 6) with mitigations; this spec omits the equivalent. Resolution: add it as a stated limit, carry over item 6's mitigations (include the requester's address alongside browser kind and time in the server-built waiting name; owner-facing line "only read the code to someone looking at a page on your agent's own address").

**2. DESIGN — Allowance enforcement by the sweep is ambiguous (§3.5, §5).** §5 defines over-limit forgetting only for the lease-race case, but the per-minute sweep sees any over-limit state identically — including one created by the owner *lowering* `maxPerPerson`. As written, an implementer can't tell whether lowering the config silently revokes owner-admitted computers. Specify: sweep enforces only race-created overflow (e.g., compare against the limit in force at admission), or lowering revokes with an attention item.

**3. PRECISION — "code cleared from history" (§8) is overstated.** `replaceState` clears the join page's entry, but the instar.sh pair page's history entry retains the fragment code. Spent codes are harmless; soften the claim.

**4. PRECISION — §3.6 sibling dance: B's side is underspecified.** B's page creates a key and navigates to `from=<A>` without checking `from` against the agent's origin list; abandoned flows leave orphan unbound keys at B. Add B-side origin validation; a sequence diagram would also help — the flow is essentially a hand-rolled OAuth-redirect pattern and naming that aids external readers.

No findings depend on truncated context; none was marked truncated.
## Round 2 — SCG ran (7 flags)
checked 102 degraded False fit weak
- Judgment Within Floors possible-violation : Section 3.5 gives no basis for the exact group-count and hourly-rate ranges or the idle and absolute lifetime ranges, so even the most permissive settings reject an authorized eleventh workstation, a twenty-first replacement in an hour, or continued use after 365 days, all cases where contextual approval could operate within independently justified resource and credential-safety floors.
- Verify the State, Not Its Symbol possible-violation : The daily renewal row stands in for the last actual use, so a member who uses a computer twice in one day can lose access before the promised idle interval has elapsed since the second use.
- Trust Is Earned by Work and Granted Only by the Person possible-violation : The proposed response to “let Mara use 5 computers” raises the allowance for everyone on the team even though the owner authorized the change only for Mara.
- An Instar Agent Always Serves a Team possible-violation : The limit-reached page reveals a member's computer inventory, including browser, operating system and join date, to an invite holder before the server has verified the holder as that member or established a share permitting the disclosure.
- Bounded Notification Surface — no feature may flood the user possible-violation : Each pending computer generates its own attention item and push, while pending computers are expressly excluded from the allowance, so a burst of valid redeems produces one owner notification per redeem.
- The Person Decides; the Agent Does the Rest possible-violation : The design says nothing changes on the owner's side, yet the owner must navigate to People, identify the waiting computer and relay a code for the member to type, even though the server already knows the member and pending key needed to present a one-tap approval.
- Cross-Machine Coherence — One Agent, Robust Under Degraded Conditions possible-violation : Confirmation checks the serving lease before several separate activation writes without binding those writes to the checked epoch, so a lease transfer after the check can let a stale holder finish an admission while the new holder admits another computer.
## Round 2 — lessons-aware
- [DESIGN high] siblings + storage clear: one-key-per-origin blocks recovery; root lost.
- [DESIGN med] dashboard-path redeem no lease check vs confirm requires lease → dead end.
- [PRECISION] 90-day re-invite burden unmeasured → owner reminder; ranges advisory; dup note; "once per maxDays"; check letters are identification not secret; how member gets link.
## Round 2 — security
- [DESIGN] row validity depends on local config (idleDays/maxDays/maxPerPerson) → fixed caps in rows; maxPerPerson only at admission.
- [DESIGN] sibling origin list/unproven key/fold rules.
- [DESIGN] lease check too late (redeem standby → confirm never).
- [PRECISION] #sib must not overwrite key; PIN decline of team devices; attention visible to PIN (check letters only); renew bound per machine.
## Round 2 — adversarial
- [DESIGN] expiry-by-stale-machine permanent revoke.
- [DESIGN] siblings lack ledger activation.
- [DESIGN] one-key-per-origin vs recovery.
- [DESIGN] handshake strands on dead/older machine.
- [PRECISION] sibling possession; relay page / j=1 unauthenticated → show host; attention close on restart/lease; signing domains.
## Disposition: DROP siblings (round-2 design class concentrated there; codex r1 option "require enrollment per origin"). Home machine = single writer for renew/expiry; no lease requirement; overshoot accepted (resource bound).
## Round 2 — integration (late; reviewed v2 with siblings)
- [DESIGN] peer stable origin not readable live → moot (siblings dropped).
- [DESIGN] siblings have no key source → moot.
- [DESIGN] documents.computers config machine-local + not patchable → replicated computer-limits team-log row + POST /team/computer-limits (bearer).
- [DESIGN] standby-started join dead-ends; held code local → same machine minted/held; lease-loss expiry message stated.
- [PRECISION] pair-link spec "frozen" note for j; PushSubject vs attention item (fixed: raiseReachNotice); awareness README rules; stale-line migration pattern.


### Round 3
## Round 3 — security+adversarial
- [DESIGN] "no serving lease" false: shared core keeps Telegram lease rule; leaseTick expires non-dashboard pending → exempt join route from Telegram rule; keep join-store ids; test A/B. FIXED.
- [DESIGN] renew never fires for idleDays ≤ 7 → renew after quarter window. FIXED.
- [PRECISION] middleware tier intersection for Send (fixed inline); boot step closing items (fixed); relay wording (fixed); peek leaks limit to link holder (harmless); one-address lifecycle case (added to §10).
## Round 3 — integration+scalability
- [DESIGN] leaseTick kills join pending (dup, fixed). [DESIGN] redeem core telegram lease (dup, fixed). [PRECISION] phone moving machines (stated); marker surface naming (fixed); vercel proof in build order (present step 8); awareness prose first line.
## Round 3 — decision+lessons
- [DESIGN] D1 rebuild at same address strands computers → home = machine serving row.host; adopt. FIXED. [DESIGN] D2 PIN fix gating → ungated. FIXED. [DESIGN] D3 ELI16 recovery wording. FIXED. [PRECISION] P1 soften, P2 reminder writer, P3 365 basis — fixed.
## Round 3 — codex
ok gpt-6.2-astra SERIOUS ISSUES None
**Verdict: SERIOUS ISSUES**

- **DESIGN — Renewal fails for supported settings (§§3.4–3.5, 13.4).** With `idleDays = 7`, renewal requires less than zero days remaining. An unexpired computer can never qualify, even with daily use. At the other extreme, once `expiresAt` equals `endsBy`, every qualifying request can append an identical renewal. Use a renewal interval shorter than the configured idle lifetime, append only when expiry advances, and state the resulting last-use guarantee. Test daily use with `idleDays` of 1, 7 and 30 and repeated requests at the hard cap.

- **DESIGN — Delayed renewal can change a comment’s verdict (§§3.4–3.5, 7).** A renewal applies only to a “live” binding. The rule leaves the evaluation time unspecified. A peer can receive a timely renewal after the previous expiry, precisely when historical verification matters. Define liveness at the renewing machine’s signed acceptance time, verify that machine against the original binding, and evaluate comments at their recorded acceptance time and access vector. Replay the same history on a peer that stayed offline past expiry.

- **DESIGN — Send after a lease move has no defined path (§§3.3.2, 3.6, 10).** The browser signs on its home origin. The viewer spec §2 says Telegram Send returns `409 not-serving` on a standby. The proposed proof sends before changing machines, so it cannot establish delivery after failover. Specify how the home machine delivers an authenticated Send to the lease holder, or expose that availability limit in the page. Move the lease between commenting and sending in the proof.

- **DESIGN — The fleet release criterion changes (§13.9; viewer §§8, 13 decision 14).** The approved viewer spec explicitly requires the passkeys project to ship and identifies stronger signing as one purpose. “Split into their own project” establishes separate ownership of the work. It does not establish that app-free commenting alone supersedes that criterion. Keep development enrollment available under the dark gate and record an explicit decision accepting the WebCrypto signing tradeoff before treating the fleet blocker as cleared.
## Round 3 — claude clean-door
ok claude-fable-5 MINOR ISSUES None
**Verdict: MINOR ISSUES**

Nothing in the dispatch asserted an expected answer, so there was nothing to refute; all findings below are grounded in the inlined spec text.

**1. DESIGN — Renewal margin breaks for small `idleDays` (§3.5, §6).** The renew rule writes `browser-renew` only "when the computer's end is less than `idleDays − 7` days away," but the setting table allows `idleDays` of 1–365. For any `idleDays` ≤ 7 the threshold is zero or negative, so a renew is never written and an actively used computer silently expires `idleDays` after joining — contradicting §3.5's own claim that "a computer in use ends 7 to `idleDays` days after its last use" and the no-silent-degradation lesson. Resolution: floor the margin (e.g. `min(7, ceil(idleDays/2))`) or raise the setting's minimum to 8, and add a unit test at the boundary.

**2. PRECISION — Lease conditions on the join redeem are left implicit (§3.3.1 vs §5).** §5 says "admission needs no serving lease," while §3.3.1 says the factored redeem core keeps "the Telegram lease rule … where it applies today." The spec never states which approval-path/lease branch a computer redeem takes. If the shared core applies the Telegram-path lease check to join redeems, a lease move between mint and redeem strands the member on the minting machine. One sentence pinning the join route's approval-path condition (and a test for redeem on a non-lease-holding home machine) closes it.

**3. PRECISION — This is an inverted device-authorization flow; say so.** The design is close kin to RFC 8628 device-code grant and Bluetooth numeric comparison, with the code direction reversed (secret flows owner→device). Naming the parallel in §13a would help outside readers and makes the relay limit's shape (unauthenticated display channel) immediately recognizable rather than locally argued.

**4. PRECISION — The likeliest real-world failure is mundane key loss, not attack (§8).** Safari's ~7-day idle eviction plus users clearing storage means occasional members will lose keys and need re-invites repeatedly; `storage.persist()` is best-effort and frequently denied without install/bookmark signals. The spec states the limit but the owner-facing guidance (§9 awareness entry) should set the expectation so re-invites don't read as breakage.

**5. PRECISION — Raw IP in the owner-facing device name (§3.1 step 5)** is low-signal for non-technical owners; a coarse location or network name would serve the "does this match Mara?" judgment better.

The architecture itself is clear, the no-LLM-in-the-loop posture is right, and the §13a alternatives honestly cover the designs an outside reviewer would ask about.
## Round 3 — SCG (10 flags)
checked 102 degraded False fit fit
- Sovereignty — "I own what is mine" possible-violation : When the owner asks to let Mara use five computers, §3.5 raises the allowance for everyone, exceeding the recorded request even if the agent discloses the wider effect afterward.
- An Instar Agent Is Always a Multi-Machine Entity possible-violation : The browser key is origin-bound, but §3.1 also makes member access depend on that origin staying online, so directing the member back to an unavailable machine leaves a surviving machine unable to serve them through the joined browser.
- Judgment Within Floors possible-violation : The three-live and four-new-per-hour defaults block an owner-confirmed fourth workstation or fifth replacement in an hour without tying either count to measured resource exhaustion, so contextual admission within a measured resource ceiling could serve both cases.
- Judgment Within Floors possible-violation : The one-day minimum, 30-day idle default, 90-day absolute default and 365-day validity ceiling lack evidence for those exact cutoffs, rejecting legitimate policies ranging from a four-hour loan to a continuously used managed workstation authorized for longer than a year, which the owner could set within an evidenced credential-lifetime floor.
- Judgment Within Floors possible-violation : Limiting guesses protects member identity, but §§3.2–3.3 give no guessing budget that derives 30 failed redeems or destruction after three wrong confirmations, which can strand a genuine member who mistypes before entering the correct code and could instead receive owner-verified recovery within a hard guessing budget.
- Judgment Within Floors possible-violation : The 60-second confirmation window rejects a correctly signed request from a computer with a clock two minutes out without deriving that tolerance from replay exposure or supported clock skew, while a single-use server challenge could establish freshness deterministically.
- Bounded Notification Surface — no feature may flood the user possible-violation : Section 3.3 creates and pushes one attention item per pending computer while explicitly excluding pending computers from the allowance, so a batch of valid invites can generate a separate owner notification for every redemption.
- The Person Decides; the Agent Does the Rest possible-violation : The owner must open People, locate the waiting computer, and relay a code for the member to transcribe, although the decision the owner needs to make is whether to approve that specific pending key.
- Verify the State, Not Its Symbol possible-violation : Section 3.2 acknowledges that a relayed enrollment can show matching check letters and deliver the owner's code while binding the stranger's key, so successful confirmation cannot certify that the member controls the enrolled computer.
- Attributed Statements Trace to Their Source possible-violation : The draft attributes the computer-commenting report to Justin using a time and a paraphrase without his logged words and a checked pointer to that specific message.
Disposition: renew advance-only + timing rule; Send-after-lease-move stated limit w/ page text; fleet criterion: explicit acceptance + report to operator, fleet turn-on separate; per-person override added (sovereignty); confirm window 5min; attribution cites Decision 14 text. Rejected (with reason in spec §13a): one-tap approval instead of code; guessing budget derivation (existing constants).


### Round 4
## Round 4 — security+adversarial: [DESIGN] adopt not replicated / new machine id; [DESIGN] own-host is self-claim → computer-adopt row, home = newest signer by time, conflict attention. [PRECISION] revoked-signer bind stays valid; backdating within home-trust; signed host must equal record host; PIN regression test; per-person row clearing.
## Round 4 — integration+scalability: [DESIGN] limits fold order by seq wrong → signed time; [DESIGN] adopt verifiability (dup). [PRECISION] own host = redeemHostEligible incl Tailscale; keep set/code store → holdDashboardCode; !approval skip stated.
## Round 4 — decision+lessons (counts frontloaded 10, cheap 0, contested-cleared 4): [DESIGN] adopter verifiability (dup). [PRECISION] amend doc §8 too; objection window; 365 basis relabel; ELI16 trade-off.
## Round 4 — codex
ok gpt-6.2-astra SERIOUS ISSUES None
**Verdict: SERIOUS ISSUES**

- **DESIGN — The fleet release condition changes (§13 decisions 8–9, §13a).** Documents decision 14 explicitly requires passkeys to ship. Documents §8 gives a second reason beyond app-free access: a browser script can silently sign with WebCrypto, while a passkey gesture prevents unattended signing. The draft acknowledges that difference. Repository ownership and an opportunity to object do not establish that the operator accepted the tradeoff. Keep development testing dark and obtain an explicit decision before marking the fleet blocker resolved.

- **DESIGN — Rebuild recovery lacks a verifiable successor (§§3.4–3.5, 5, 10).** Peers must accept renewals only from the original signer or a machine that adopted its hostname. Adoption is local, and the listed replicated events give peers no evidence that a new identity took over. The rebuild test wipes only the registry. The simplest resolution is to require the original pinned identity for recovery and require a fresh invite after identity loss. If transparent identity replacement is required, specify a signed transfer that also retires the previous writer.

- **DESIGN — An ordinary invite has no defined landing page (§3.1 steps 2 and 6, §10).** The join URL carries no document ID. The fallback promises “Your documents,” but documents §§3.6 and 3.9 define browser reads for an individual document, and the proposed scope opens no mobile list route. Define a browser-signed list filtered by document read permission, or finish enrollment with instructions to reopen the shared document link. Test starting from only the invite, including a member with no grants.

- **DESIGN — Mixed-version behavior is unproven (§§2, 3.4, 5, 15).** The cited compatibility rule covers unknown event types. The proposed joined binding reuses the already-known `browser-bind` type with different required fields. The inline evidence does not establish that an old reader skips it cleanly or that upgrading recovers it. Give joined bindings a distinct event type and test an actual old reader through ingestion, a subsequent ordinary access event, and upgrade.

- **PRECISION — The advertised expiry differs from the algorithm (§3.1 step 8, §3.5, §13 decision 4).** With default settings, use just before the renewal threshold leaves about 22½ days. Describe the displayed expiry date as authoritative and qualify the 30-day promise.
## Round 4 — claude
ok claude-fable-5 MINOR ISSUES None
**Verdict: MINOR ISSUES** — one DESIGN finding; the rest are precision-level.

**1. DESIGN — Renew verification after adoption is underspecified (§3.5, conflicts with §3.4's invariant).** A `browser-renew` "counts on every machine only if its signer is the binding's home (the machine whose identity accepted the bind row, **or the one that adopted it at that host**)." The first clause is verifiable from the replicated bind row's machine signature. The second is not: the spec defines no replicated, signed record of adoption, and the host→machine-identity mapping lives in registry state the spec elsewhere calls "display only" (§3.6). After a rebuild at the same address — the spec's own motivating scenario — the adopting machine signs renews under a new identity that peers have no stated way to tie to that host. Machines can then disagree on whether a renew counts, contradicting §3.4's "every machine reaches the same verdict on the same row," and `deviceStoodAt` on a peer could read a comment's computer as expired while the home machine serves it. **Resolution:** make adoption itself a machine-signed replicated row (a `host-claim` validated against the pool's signed machine/origin records), and state the tie-break when two machines claim one host.

**2. PRECISION — Spent-link / pending-window friction (§3.3.1, §5).** The link is consumed at redeem, but the code's lifetime is only "the pending lifetime pending team phones use," with boot expiry. An owner who misses the window costs the member a full new invite each try. State the concrete lifetime and the expected retry loop.

**3. PRECISION — Same-channel code delivery (§3.2, §8).** The owner sends the link "however they like"; nothing tells them the code should travel a different channel. When link and code share one compromised channel, the relay mitigations weaken further. Add one line of owner guidance (read it aloud; don't reply in the same thread as the link).

**4. PRECISION — Industry anchor and jargon (§13a, §3.3).** The flow is essentially an inverted OAuth 2.0 Device Authorization Grant (RFC 8628); naming that would orient outside readers and justify code-entropy/attempt parameters. Terms like "eligible host" and "attention item" are used before definition.

**Lens 6 (model-family blind spots):** no finding — the spec is deliberately model-free, every refusal deterministic and named; the consent ceremony is proportionate to an enrollment flow. The alternatives section (§13a) genuinely engages passkeys and chaining rather than rubber-stamping the chosen design; I agree with its rejections.
## Round 4 — SCG (9 flags)
checked 102 degraded False fit fit
- Judgment Within Floors possible-violation : The binding validator rejects lifetimes over 365 days even though every machine could enforce the same signed end date for an owner-authorized 366-day deployment; deterministic replication explains the need for a common rule but does not establish that ceiling.
- Judgment Within Floors possible-violation : A member who uses a computer daily must still rejoin after 90 days, while a member returning after 31 idle days loses access under the stated 30-day policy; the draft gives no evidence for either cutoff or explains why a lifetime chosen within the owner's security limits would be unsafe.
- A Safeguard Must Leave a Benefit possible-violation : The five-minute signature window rejects a legitimate confirmation from a computer whose clock is six minutes fast, while the draft credits the single-use code with preventing replay and identifies no additional protection that requires this window.
- Judgment Within Floors possible-violation : Bounding code guesses protects the member, but the draft gives no code-strength or attempt-budget evidence for dropping the pending computer after exactly three errors, which forces a member who corrects a third typo to obtain another invite.
- Bounded Notification Surface — no feature may flood the user possible-violation : The renewal sweep raises a separate owner attention item for every computer nearing expiry, so computers enrolled together can produce a burst where the standard requires one summary.
- Cross-Machine Coherence — One Agent, Robust Under Degraded Conditions possible-violation : A joined computer's Send action returns `409 not-serving` whenever a healthy peer holds the lease, and the prescribed recovery waits for the lease to return even though the current holder could receive a forwarded request.
- No Manual Work (user *or* agent) possible-violation : The renewal notice makes the owner remember to send a fresh invite and makes the member ask for one after expiry, although the agent knows the person, computer and deadline and could prepare the invitation for approval.
- Attributed Statements Trace to Their Source possible-violation : The draft credits Justin with raising the computer-access requirement while acknowledging that his message was lost, then treats an agent-written decision as the surviving evidence of what he said.
- Verify the State, Not Its Symbol possible-violation : A machine signature proves which machine recorded a binding, but §3.2 uses that fact to certify equal enrollment strength without establishing that the two flows provide equivalent evidence tying the member to the enrolled key.
Disposition: computer-* distinct event types; computer-adopt; limits by signed time; held via holdDashboardCode; landing 'You're set up'; fleet trade-off = explicit operator Approve/Decline at fleet turn-on (Decision 14 amended to require it); 365 relabel; ELI16 trade-off sentence. Not taken: one-tap owner approval (13a), forwarding Send to lease holder (stated limit), renewal invitation automation (owner reminder suffices).


### Round 5
## Round 5 — security+adversarial: 0 DESIGN; PRECISION adopt host/keyHash rules, origin-gone for adopt/renew, future-dated adopt — fixed.
## Round 5 — integration+scalability: [DESIGN] older machine gapsIn holds all team phones → all-peers capability write gate (fixed). [PRECISION] new comparator; unbind deviceId — fixed.
## Round 5 — decision+lessons (frontloaded 10, cheap 0, contested-cleared 5): 0 DESIGN; P1 blocker wording, P2 §6 rows, P3 reminder batching — fixed.
## Round 5 — codex
ok gpt-6.2-astra SERIOUS ISSUES None
**Verdict: SERIOUS ISSUES**

- **DESIGN — The legacy confirm route needs an explicit exclusion (§2, §3.3.1–2).** Both flows use the same held-code store. The spec says the join page uses a separate endpoint, but choosing an endpoint in the page does not restrict what the server accepts. Require `/mobile/device/confirm` to reject pending `team-invite` computers before consuming an attempt or changing state. Verify that the same pending computer can subsequently complete signed join confirmation.

- **DESIGN — The expiry sweep can permanently revoke a renewed computer (§3.5, §3.7).** A rebuilt home can receive the bind before the last renewal. If the original deadline has passed, adoption skips the apparently expired bind. If it already reconstructed the local record, its sweep can publish an irreversible unbind before the renewal arrives. Use the folded deadline to refuse expired requests, reserve permanent revocation for explicit removal, and reconsider adoption when either a renewal or its ledger activation arrives. Test both arrival orders across a rebuild.

- **DESIGN — Confirmation lacks crash recovery (§3.3.2, §5).** Confirm checks a single-use code, writes a ledger activation, activates a local record, then appends a binding. “Each step undone” supplies no recovery rule for process loss between durable writes or a lost success response. Define a durable commit point keyed by pending device ID, keep authorization conditional on the complete binding, and make same-key retries return the committed result. Test restart at each write boundary.

- **DESIGN — First-bind-wins omits joined keys (§3.4, §12).** The specified duplicate check consults `bindings` and `browserLinks`. Joined keys live in `computerLinks`. The local duplicate-pending test cannot establish replicated uniqueness. Apply one first-bind rule across all three maps and test conflicting bindings for the same key and different people in both delivery orders.

- **PRECISION — The confirmation instructions name two different events (§3.2, §3.3.2, §3.4).** The first two sections say `browser-bind`. The schema and older-reader rationale specify `computer-bind` and reserve `browser-bind` for phone-signed links. Correct both references and have the wiring test assert the exact event type.
## Round 5 — claude
ok claude-fable-5 MINOR ISSUES None
**Verdict: MINOR ISSUES** (one DESIGN finding; rest precision)

**1. DESIGN — §3.6 way-back page leaks the machine-address list to unauthenticated visitors, unreconciled with the parent spec's probing rules.** The "not set up for this address" state shows "one button per address of the agent's machines" to a browser with no key and no cookie — a wholly unauthenticated request. The documents spec treats tunnel hostnames as protectable (its `Referrer-Policy: no-referrer` exists "so a document's links can't leak … the tunnel's hostname") and answers every access miss `404 unknown-document` to prevent probing. This spec doesn't say whether the state renders before any authentication, whether it confirms the docId is real (an existence oracle a stranger with a guessed URL could use), or why enumerating every machine's address to anyone is now acceptable. Resolution: state explicitly when the state is shown; either render a generic page without the machine list, or declare machine addresses non-secret as an amendment to the parent's §8 and make the page identical for valid and invalid docIds.

**2. PRECISION — §3.3.9 join-page states omit resume-after-reload.** The code is spent at redeem, and the owner may take hours to read it out. A member who closes the tab while "waiting for Justin" dead-ends into a new invite — the costliest path, since every recovery here consumes an owner interaction. State that the page persists `deviceId` beside the key and resumes the waiting/code-entry state.

**3. PRECISION — reinvented industry pattern, unacknowledged.** This is essentially the OAuth device-authorization grant (RFC 8628) inverted, with a short-authentication-string-style comparison ("check letters"). The spec's concession that check letters identify the device but not the page is correct and matches the SAS literature on relay; citing the parallel in §13a would help outside readers and show the relay limit is inherent, not an oversight.

**4. PRECISION — §8 understates Safari's practical cost.** `navigator.storage.persist()` is generally not granted by Safari; 7-day eviction makes the 30/90-day lifetimes notional there, and each eviction costs an owner-mediated re-invite. Set the expectation in member-facing text (or recommend a browser where persistence holds).

**5. PRECISION — "check letters" are hex digits** (`7F3A-91C0`); rename or state the alphabet, since the flow depends on reading them aloud.

No model-family blind spot found: every decision is deterministic, no LLM in any access path, and the consent surface (one owner code) is proportionate — I looked for over-fencing and did not find it.
## Round 5 — SCG (8 flags)
checked 102 degraded False fit fit
- Judgment Within Floors possible-violation : The admission check can refuse a fourth legitimate computer or a fifth legitimate setup in an hour, but the draft gives no capacity or security evidence for those exact cutoffs; the agent could assess unusual demand within an evidenced resource ceiling and the owner's signed grant.
- Judgment Within Floors possible-violation : The 22–30-day inactivity expiry, 90-day maximum and 365-day validation ceilings can reject an authorized returning or continuously active member, and the draft gives no basis for those durations over risk-based renewal within an owner-approved expiry.
- A Safeguard Must Leave a Benefit possible-violation : The five-minute signature window rejects a legitimate computer whose clock is six minutes slow, although the draft credits the single-use code with preventing replay and names no additional protection the time check supplies.
- Cross-Machine Coherence — One Agent, Robust Under Degraded Conditions possible-violation : Two machines can each confirm a computer against the same last available allowance while partitioned because confirmation explicitly bypasses the serving lease and the draft gives neither machine a reserved slot or other fenced admission authority.
- An Instar Agent Is Always a Multi-Machine Entity possible-violation : A member loses Send whenever another machine holds the lease, although the origin-bound key only requires the home machine to authenticate the request and the draft gives no reason it cannot forward the authorized action.
- A Refusal Stays a Refusal — conservation of negative outcomes possible-violation : The join route spends a live non-team invite and reports that it expired or was already used, concealing that this request consumed a valid link on the wrong route.
- Bounded Notification Surface — no feature may flood the user possible-violation : The design pushes one owner notice per waiting computer while explicitly excluding pending computers from the allowance, so a burst of valid redemptions can generate one push per invite with no aggregate bound shown.
- Attributed Statements Trace to Their Source possible-violation : The draft credits Justin with the fleet-release condition after acknowledging that his original words were lost, using Decision 14 as evidence of his instruction where the standard requires his logged words or an explicit unknown-source attribution.
Disposition: old confirm route refuses team-invite pending; expiry writes nothing (fold-judged); commit point + reconcile; first-bind across 3 maps; way-back page identical for all ids, addresses not secret; tab resume; Safari expectation.


### Round 6
## Round 6 — security+adversarial: 0 DESIGN; PRECISION confirm/reconcile in gate wait list, activation wording, host sentence placement — fixed.
## Round 6 — integration+scalability: [DESIGN] advert carrier false (CapabilityRegistry is model-only, dev-gated) → seamlessnessFlags.teamLogComputerRows — fixed at cap. [PRECISION] last-known vs reachable (sticky decided).
## Round 6 — decision+lessons (frontloaded 10, cheap 0, contested-cleared 6): [DESIGN] gate ends computers / no way out → sticky advert, retired excluded, attention after a day, reworded 409 — fixed at cap. [PRECISION] ELI16 sentence, live machine definition — fixed.
## Round 6 — codex
ok gpt-6.2-astra SERIOUS ISSUES None
**Verdict: SERIOUS ISSUES**

1. **DESIGN — Rollback can interrupt existing team phones (§§5, 15).** Section 5 says an older reader treats an unknown event as a gap and holds every team phone on that machine. Section 15 says phone-linked computers are unaffected. The capability check protects the first write, but a downgraded reader still encounters rows already written. Persist the minimum reader version once the first `computer-*` row lands and enforce it during downgrade and machine join. Test rollback *after* enrollment, with an existing team phone and phone-linked computer making real requests.

2. **DESIGN — A sleeping peer can prevent recovery (§§3.5–3.6, 5).** Section 3.6 tells a member whose home machine is down to join on a surviving machine. Section 5 explicitly blocks redemption and renewal whenever a listed peer is unreachable. Under those rules, even a fully upgraded sleeping laptop can block the suggested recovery and let active computers expire. Use the last authenticated capability of each active machine, as team-roles §3.6 does, together with the persistent version floor above. Test admission and renewal while a known-compatible peer sleeps.

3. **DESIGN — Crash recovery lacks a durable admission decision (§3.3.2).** Ledger activation commits admission before `computer-bind` records the limits in force. The specified pending record stores the scope and host but omits `idleDays` and `endsBy`. If limits change before reconciliation, the spec gives recovery no authoritative lifetime to restore. Persist the complete intended bind alongside the commit. Test a restart between activation and bind with an intervening limits change, and verify the original expiry on both machines.

4. **DESIGN — Forget leaves shared-browser drafts unspecified (§§3.3.5, 8).** The viewer spec (§3.6) stores unsent comment text in `localStorage`. The proposed Forget operation specifies ledger revocation and unbind. Neither clears that text from a shared browser profile. Define local cleanup for the device’s drafts, key and pending join state. Test by forgetting a computer with an unsent comment, enrolling another person in the same browser profile, and checking that the first person’s draft is gone.
## Round 6 — claude
ok claude-fable-5 MINOR ISSUES None
**Verdict: MINOR ISSUES**

The design is sound from an outside view: the trust anchor (owner-read code, out-of-band) is the inverse of the OAuth device-authorization grant combined with a Bluetooth-style short-authentication-string check — solved patterns, correctly composed. Reusing the existing replicated log rather than importing a CRDT/queue library is the right call given the infrastructure already exists. §13a honestly covers the alternatives I would have raised (passkeys, chaining, stable address). No LLM-as-authority or consent-flow over-reach; every decision is deterministic.

**Findings:**

1. **DESIGN — §5 / §3.3.1, the `peers-updating` gate has no path to act.** No `computer-*` row is written until *every* live machine advertises `teamLog: computer-v1`, and an unreachable machine counts as not advertising. A retired-but-still-listed machine therefore makes `/docs/_join/redeem` answer 409 forever, while the member-facing text ("try again in a little while") claims a transient condition. The spec's own lesson ("every warning needs a path to act") and the team spec's "mark a retired machine as gone" pattern apply here but aren't wired in. Resolution: when the gate persists past some bound, raise one owner attention item naming the non-advertising machine and the retire action.

2. **PRECISION — §3.1 step 8 overpromises on Safari.** The page's end date is called "authoritative" and the member is promised "at least about 22 days," but Safari's ITP can evict script-writable storage after ~7 days of no visit (§8 acknowledges the eviction, §3.1 doesn't). Say the date bounds only the server side; the browser may forget sooner.

3. **PRECISION — §3.1 step 5 / §6.** The server-built device name embeds a User-Agent-derived description ("Chrome on macOS"). The §6 invariant forbids requester-written text on the owner's approval screen; specify that the UA is mapped to a fixed vocabulary, never echoed.

4. **PRECISION — §3.3.2.** The 5-minute confirm window tolerates skew, but no member-facing error is specified for a clock outside it; "no silent degradation" wants a plain reason ("your computer's clock looks wrong").

5. **PRECISION — clarity.** "Check letters" is a locally-coined name for a key-fingerprint SAS; one line tying it to the standard concept would help outside readers. §3.5's "Staying in" paragraph interleaves adoption, renewal cadence, dual-home detection, and backdating limits in one block — split it.

Finding 1 is the only item that changes behavior; the rest are left-behind candidates.
## Round 6 — SCG (7 flags)
checked 102 degraded False fit fit
- Judgment Within Floors possible-violation : The visible design carries forward limits of three live computers and four links per hour and imposes inactivity and 90-day expiry without deriving those boundaries; trusted shared-lab users can need a fourth computer, a fifth replacement in an hour, or continued use after day 90, all cases where contextual review could preserve the owner's authorization boundary.
- A Safeguard Must Leave a Benefit possible-violation : The five-minute signature window rejects a legitimate confirmation from a computer whose clock is six minutes slow, although §3.3.2 credits the single-use code with preventing replay and identifies no additional protection the time check supplies.
- Verify the State, Not Its Symbol possible-violation : The claim that the computer is bound to the intended member exceeds what confirmation proves, since §3.2 itself describes a relay in which the owner's code and the displayed check letters both match while someone else controls the enrolled key.
- An Instar Agent Is Always a Multi-Machine Entity possible-violation : Section 3.3.2 makes Send wait for the home machine to regain the lease, although the browser's origin-bound key explains where it must sign and supplies no reason the authenticated request cannot be forwarded to the current holder.
- The Agent Carries the Loop possible-violation : After a link is spent or expires, the recovery flow depends on the member asking for another link and the owner remembering to send it, even though the agent could prepare the replacement and surface the owner's approval.
- Operator-Surface Quality possible-violation : The owner's primary decision surface is a waiting-device entry led by a fingerprint prefix and containing an IP address, which makes technical identifiers primary content in an authorization decision.
- Attributed Statements Trace to Their Source possible-violation : The draft attributes the November 10 request and the quoted words “Split into their own project” to Justin using a topic and a derivative decision record while acknowledging that his original words were lost.
Disposition at cap: fixed (not re-reviewed): advert carrier, sticky advert + retired excluded + attention + 409 wording, complete intended bind in pending record, Forget clears drafts/key/pending, wording precision. Accepted as stated limit: rollback after enrollment holds that machine's team phones (deliberate operator act; heartbeat withdraws flag; attention names it). Declined with reasons in spec: forwarding Send to lease holder (same as phones), owner one-tap approval (13a), agent-prepared re-invite (owner reminder), limit-value derivations (owner-arbitrated judgment-candidates).


## Convergence Verdict

Converged at round 6, the Tier 2 cap. Round 6's internal security and adversarial reviewer found nothing at design level. The other internal reviewers raised two design findings and codex raised four. All six had clear, local fixes, and none was an open safety, security or data-loss hole. Each was fixed in the spec at the cap, listed in Left behind, and is covered by the build's tests. Two items are accepted as stated limits with reasons: a rollback after enrollment, and Send while the home machine isn't serving. Open questions: none. The spec is ready to approve and build. It amends the documents spec's Decision 14, and the trade-off it introduces (browser keys instead of passkeys) is put to the operator as an Approve/Decline before any fleet turn-on.
