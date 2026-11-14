# Side-Effects Review — pairing "use the dashboard" messages carry a direct link

**Version / slug:** `pairing-refusal-direct-link`
**Date:** `2026-11-11`
**Author:** `Echo`
**Second-pass reviewer:** `not required`

## Summary of the change

Echo Bugs topic 10000002573 (Instar feedback fb-300d9f7d-6d3 and fb-9566b1d3-f4d). Justin pasted a Threadline pairing invite to Cora, an agent with no owner set. Cora replied "Open the Threadline tab on the dashboard to do this with your PIN. Paste the invite there." with no link. The standing rule is that an agent always gives a direct link.

Every pairing message that sent the operator to the dashboard now carries a direct link built from the agent's real address. The new helper `src/threadline/pairingDashboardLink.ts` reuses the existing `createOperatorLinkOriginResolver` (`src/server/dashboardPaths.ts`). When the tunnel is up the message gives the public link. With no tunnel it gives the local link and says plainly that it opens only on the agent's computer. While a configured tunnel is still starting it gives no link and says why. When the address is unknown it says so.

The paste link is `…/dashboard/console/#/people/agents?connect=paste`. The console's Other agents page (`dashboard/console/agents.js`) opens "Connect another agent" for that query, focuses the "I was sent one" box, and removes the query from the address. The invite is NOT put in the link. It is a one-time secret, and the dashboard's own rule is "never turned into a link".

Paths covered (all in `src/threadline/PairingInviteTelegram.ts` unless named otherwise):
- the forwarded-invite refusal (Justin's case);
- refused button taps and expired buttons. A toast cannot hold a clickable link, so the link is posted in the invite's topic (else the Lifeline topic), at most once per invite every 10 minutes, and the toast points at it;
- the Finish prompt while Telegram approval is off;
- the "finishing by myself" notice ("unpair it…"). The shared core text (`packages/threadline-core/src/handshake.ts` and its byte-identical copy `src/threadline/pairingHandshake.ts`) gets an optional `unpairLine`. Without it the wording is unchanged, so other hosts see no difference;
- `TelegramAdapter`'s fallback reply when the pairing handler fails or is missing (`setPairingDashboardOrigin`, wired in `routes.ts`), and its no-handler tap toast, which now names the Other agents page.

Someone known NOT to be the approver (a configured or resolved approver exists and the sender is someone else) gets no dashboard address, in the chat or the toast: `NOT_OWNER_DASHBOARD_LINE` says the approver can do it on the dashboard. A group chat's other members are not handed the owner's door, even PIN-gated.

Agent awareness: `AGENT_CONNECT_DASHBOARD_LINK_LINE` in `src/scaffold/templates.ts` adds one line to the "Connect with another agent" CLAUDE.md section (direct link from `GET /tunnel`, `?connect=paste` for pasting, never the invite in a link). Migration parity: `PostUpdateMigrator.migrateClaudeMd` inserts it before step 6 for agents that already have the section, content-sniffed so re-runs are no-ops.

This change is stacked on PR #3087 (refused-invite receipts, `ForwardedInviteResult`, approver wording), which it keeps as is.

Tier 1. Size: 10 source files plus tests, about 170 lines of source. Effort: no spec rounds; written in one session, rebased onto #3087 in a second (two conflicts, resolved by keeping #3087's wording and return values).

## Decision-point inventory

No decision point is added or changed. Who may approve, what gets refused, and whether an invite is consumed all stay exactly as they were. Only the words of the refusal and a link change. One new behaviour sits next to a refusal: a refused tap posts one link message, rate-limited per invite. That is an output, not a gate.

---

## 1. Over-block

No block/allow surface. Over-block is not applicable.

---

## 2. Under-block

No block/allow surface. Under-block is not applicable. On coverage: the adapter's no-handler TOAST stays plain text (now "…on the dashboard's Other agents page…"). It fires only when pairing is not wired at all, and a toast cannot carry a link.

---

## 3. Level-of-abstraction fit

The link origin comes from the one shared resolver that other operator links already use (ScopeAccretionRatifier, the feedback factory, server.ts notices), so tunnel-state handling is not re-implemented here. The sentence lives in one helper shared by the pairing surface and the adapter fallback. The core handshake text stays host-neutral: the host passes its own line in.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

It changes message text and adds a link post. No gate is added or changed.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The link choice follows the existing resolver's enumerable states (public / local / pending).

---

## 5. Interactions

- **Shadowing:** none. The refusal checks run first and are unchanged. The link is built only after a refusal is decided.
- **Double-fire:** a refused tap now posts one message into the topic in addition to its toast. Repeated taps on the same invite within 10 minutes do not repost (unit-tested). An unverified caller (the agent's own Bearer) could trigger at most one post per invite per 10 minutes, plus one for unknown buttons. The post is a link that still needs the PIN.
- **Races:** the per-invite repost map is in memory; a restart only permits one more post.
- **Feedback loops:** none. The posts go through the normal `post()` path (which reports undelivered sends) and are not read back by pairing.
- **#3087's `refused` flag:** unchanged. Every refusal path still returns `{ outcome: 'refused', refused: true }`; only the sentence differs.
- **Migration:** the CLAUDE.md line is inserted only inside the Connect section and only before its step 6; absent the section or the step, it is skipped and recorded.
- **Shared text test:** the core/Instar handshake byte-identity test still passes; both copies were edited identically.

---

## 6. External surfaces

- Telegram: the wording of pairing refusals and prompts changes, and they now contain a URL. The URL is the dashboard page, which is PIN-gated. It never contains the auth token, the PIN or the invite.
- The console: `#/people/agents?connect=paste` opens the Connect sheet once. Without that query the page behaves as before.
- **Operator surface (Mobile-Complete Operator Actions):** this change exists to satisfy this rule. Every redirect now gives a phone-openable link when the tunnel is up, and says so plainly when no such link exists.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

1. **Leads with the primary action?** Yes. The link opens the Connect sheet with the paste box focused, so the operator lands on the action itself.
2. **Zero raw internals as primary content?** Yes. Nothing new is shown; the existing sheet is opened.
3. **Destructive actions de-emphasized?** No destructive action is added. The sheet is unchanged.
4. **Plain language + phone width?** Yes. The Telegram sentences are plain ("Paste the invite on the dashboard with your PIN: <link>"). The sheet's phone layout is unchanged.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

**Machine-local BY DESIGN.** The link uses the address of the machine that answered the invite, and the pairing flow that will accept the paste runs on that same machine. When pairing runs on another machine, the Other agents page already says so ("Pairing runs on …"), and the paste sheet is not opened there. No notices are new except the rate-limited tap link, which is posted by the machine that refused the tap. No durable state is added. No status surfaces change.

---

## 8. Rollback cost

Code plus one CLAUDE.md line. Revert and ship a patch. No persistent state. Agents already migrated keep the one instruction line, which stays accurate (the links it describes are standard dashboard routes); no repair needed. During the rollback window users would only see the old link-less wording again.

---

## Conclusion

Every pairing redirect to the dashboard now carries a direct, working link, or a plain statement of why there is none. The invite is never put in a link. Clear to ship.

---

## Second-pass review (if required)

Not required: no gate, sentinel, session lifecycle or messaging block/allow decision is touched.

---

## Evidence pointers

- Unit: `tests/unit/threadline/pairingDashboardLink.test.ts`, `tests/unit/threadline/PairingInviteTelegram.test.ts` (block "every dashboard redirect carries a direct link"), `tests/unit/pairing-invite-never-persisted.test.ts`, `tests/unit/console-agents.test.ts` (the paste link in jsdom), `tests/unit/threadline/pairing-handshake.test.ts` (byte identity).
- Integration: `tests/integration/pairing-invite-telegram-routes.test.ts` (no-owner refusal through the real routes, with and without a tunnel).
- E2E: `tests/e2e/threadline/pairing-handshake-production-path.test.ts` ("an agent with no owner set (Cora, Nov 11)…": a real AgentServer).

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect (the text is shipped source code, not a prompt, hook, config, skill or standard), and no self-triggered controller. Not applicable. The class "a dashboard redirect with no link" is closed in this surface by the shared helper. Tests assert that every path carries the link or the plain reason.

**unbounded-self-action — closure: n/a.** The one new post (a dashboard link after a refused or expired pairing tap) is a one-shot, user-driven reply, not a self-triggered loop: it fires only when a person taps a button, at most once per invite per 10 minutes. Matches the trace's `classClosure` block.
