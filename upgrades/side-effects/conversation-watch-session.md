# Side-Effects Review — Conversations: Watch the session

**Version / slug:** `conversation-watch-session`
**Date:** `2026-11-21`
**Author:** `echo`
**Second-pass reviewer:** `not required`

## Summary of the change

Tier 1. New pure module `dashboard/console/conversation-session.js` matches a conversation's source key (`telegram:<topic>` / `app:<key>`, from `make-card.js` `sourceKeyFor`) to a running or starting row of `GET /sessions?scope=pool` (by `conversationRef`, else the Telegram topic), preferring this machine's session and then the newest one. `conversations.js` shows one status line under a conversation's title with a "Watch the session" link to `#/work/sessions?s=<sessionKey>`, or a plain line saying that no session is running or that the list could not be read. The same line is added to the Chats conversation view (`chats.js` `loadLiveSession`, Telegram and app only). `console.js` probes `/conversation-graph/roots`: only a 503 `conversation-graph-off` marks the hierarchy off, and `nav-model.js` `doorHref` then sends the Conversations door, and the first page, to `#/work/chats` when Chats is available. An unknown answer keeps the hierarchy. The switched-off hierarchy page offers "Open Chats" instead of Try again. Rebuilds Justin's November 14 request from topic 140618, whose first version was lost. Unit tests and a page test have been added.

## Decision-point inventory

No decision-point surface. A read-only display line.

## 1. Over-block

No block/allow surface — not applicable.

## 2. Under-block

No block/allow surface — not applicable.

## 3. Level-of-abstraction fit

Display logic lives in a pure console model module, like the other console pages. It reads the existing pool session list that the Sessions page uses, so the link target and the row always agree. No server change.

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

No authority added or changed. The link only navigates; watching or typing into a session keeps the Sessions page's existing checks.

## 4b. Judgment-point check (Judgment Within Floors standard)

No competing-signals decision point.

## 5. Interactions

One extra `GET /sessions?scope=pool` read when a conversation opens (on either page), and one extra `GET /conversation-graph/roots` probe when the console starts. Without the operator's PIN proof, that probe answers either the off 503 or a refusal, and never returns conversation data. Door choice: the hierarchy door previously moved off Chats because Chats showed "No conversations yet" (PR 3232). That move is kept wherever the hierarchy is on. Chats is chosen only when the hierarchy is definitely off, where the alternative was a dead end. The Sessions page already polls that route. The read runs in the background and never delays the history. A 401 or 403 from it would clear the page's PIN unlock through the shared `read()` helper, the same as any other read on the page. `/sessions` accepts the dashboard's bearer, so that does not happen in normal use.

## 6. External surfaces

One line on the console's conversation page. No route, config, or outbound message is added or changed.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

1. **Leads with the primary action?** Yes. The link comes first on the line.
2. **Zero raw internals as primary content?** Yes. Machines show by name, never by id (tested).
3. **Destructive actions de-emphasized?** None.
4. **Plain language + phone width?** Yes. It is one short line.

## 7. Multi-machine posture (Cross-Machine Coherence)

Reads the pool-scoped list. A remote session links by its remote key, which the Sessions page already opens through the owning machine.

**Status surfaces:** none added or changed.

## 8. Rollback cost

Revert the commit.

## Conclusion

A small, read-only navigation aid that closes the first item of the app-parity request.

## Second-pass review (if required)

Not required: no gate, block, session lifecycle or watchdog.

## Evidence pointers

- `tests/unit/console-conversation-session.test.ts`: running, remote, two machines, legacy topic row, nothing running, list failure, wiring.
- `tests/unit/console-conversations-dom.test.ts`: the page renders the link and the not-running line; a switched-off hierarchy offers Open Chats.
- `tests/unit/console-front-doors.test.ts`: the door opens Chats only when the hierarchy is off and Chats is on.
- Live on the Studio at 1280x728 and 390x844 (branch console via a local proxy): the console lands on `#/work/chats`, the sidebar door points there, and the switched-off page offers Open Chats with no horizontal overflow.

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable.
