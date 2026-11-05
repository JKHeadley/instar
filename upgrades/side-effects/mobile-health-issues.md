# Side effects: what a degraded agent means for the person

1. Over-block: none. This is a read-only route and display. It gates nothing.
2. Under-block: a wrongly declared `internal` row would hide a real problem from Fleet and Home. It still shows in the details, and `/health` still says degraded. Rows are reviewed in the table; an unknown id is never quiet.
3. Level of abstraction: the table sits with monitoring, the route with the other mobile reads. Reading `/health` over loopback avoids a second copy of its rules.
4. Signal vs. authority: signal only. Matching is on stable ids, never message text. Nothing is blocked, retried or alerted because of this table.
5. Interactions: `/health` is unchanged, so hook-lib, lifeline, peers and health-check see the same answer. A new `health` source on Home adds one read per tick, cached for 5 s on the server. The Fleet reads it every 30 s per agent, inside its own 20-per-minute bucket. Console `systems` tile now opens the new page; the legacy tab stays linked from it. The Sessions page gains an `ask` parameter that only fills a text box; nothing is sent until the person presses send.
6. Rollback: revert the commit. No state, no migration beyond one CLAUDE.md bullet, which stays harmless.
7. Privacy: owner phone or bearer only. A raw `reason` is never served; evidence is the narrative `/health` already shows publicly, scrubbed and capped.

## 6. External surfaces

One new owner-only phone route, a CLAUDE.md line, a console page, and a Home row. Nothing leaves the machine.

## 6b. Operator-surface quality

1. Leads with the primary action: yes. A problem that affects the person is the first thing under the headline, open, with the fix and "Ask the agent about this" as its buttons. Home's row links straight to it.
2. Zero raw internals as primary content: yes. Titles and details are plain sentences from the table. A reporter's id appears only inside the question text, as a reference for the agent. An unsorted item's title is the agent's narrative, already plain language.
3. Destructive actions de-emphasized: n/a, this page has no destructive action, only links.
4. Plain language and phone width: yes. Checked at phone size in the simulator for the app; console page uses the shared card and button classes.

## 7. Multi-machine posture

Machine-local, like `/health`: each machine answers for itself. The app and console read the machine they are connected to. A problem on another machine shows on that machine's own answer; the Machines list still shows whether it is up.

## 8. Rollback cost

Revert the commit. Nothing durable is written. The app falls back to public `/health` shown as not sorted.

## Second-pass review

**Reviewer:** codex-cli, one read of the full diff (2026-11-05)

**Independent read of the artifact: did not concur on the first read; findings below fixed or answered.**

- `SessionManager.verifyInjection` also meant "still undelivered": fixed by splitting a new id, declared user-affecting.
- `GitSync.*` covered conflicts that need a person: fixed. The broad families were removed; only reviewed ids are listed, the rest fall to the safe default. Same for Threadline, MultiMachine, Handoff and Quota.
- Paths in evidence: fixed, replaced with plain words.
- `internalOnly` quietens an id the table doesn't name: kept. That flag is the reporter's own declaration that the event is internal observability, so the id is not unknown. It can never quieten a declared row.
- The unnamed-problem row only appears when nothing else explains degraded, so a future new reason beside an internal event would be masked: accepted. A test pins every reason in the `/health` handler, so adding one fails until it is named here.

A second read found more rows that claimed more than their reports say. All removed or reworded: lockfile, quota, session spawn and Threadline encryption rows now fall to the safe default; the Enter row no longer claims success; the jev row is one exact id; the pin test now compares the whole first condition of `/health`.

A third read asked for four wording fixes, all made: the relay row, the stop-check row, and two rows removed to the safe default.

A fourth read found three wording overclaims, all fixed. Findings had shrunk from design faults to single phrases, so I stopped there. The reviewer did not state concurrence on the final text.

The reviewer confirmed: `/health` shape unchanged, owner and bearer authorization correct, `?ask` only fills a text box, internal rows stay out of Home's count.

**Follow-up from the verify run (2026-11-05):** three test floors caught real slips: a raw scroll on the Health page (now the shared helper), a fallback mark on the wrong line, and a test that named the old legacy Health link.
