---
title: "Done and Ignore for a Needs-you item from the owner's phone"
slug: "mobile-attention-choices"
author: "echo"
parent-principle: "Mobile-Complete Operator Actions"
eli16-overview: "mobile-attention-choices.eli16.md"
status: "draft"
approved: true
approved-by: "echo, under its standing grant, for Justin's report (Telegram topic 134088, 2026-11-06 14:11-14:15 PST, screenshot of \"Something other than the lifeline called my Telegram intake\" with no machine and no Hide or Ignore)"
review-convergence: "2026-11-06T22:40:00.000Z"
review-iterations: 1
review-completed-at: "2026-11-06T22:40:00.000Z"
review-report: "docs/specs/reports/mobile-attention-choices-convergence.md"
---

## 1. Problem

The app's Needs-you list mixes two kinds of row. Health problems (`/mobile/health-issues`) carry `machine` and the quick actions Hide for a while, Hide from me and Ignore. Attention items (`/attention`, for example the lifeline intake guard's "Something other than the lifeline called my Telegram intake") carried neither on the phone. The server already stamps attention rows with `machineId` and `machineNickname`, but the app didn't read them. There is no device route to settle an attention item: `PATCH /attention/:id` is token-only. So that row named no machine and offered no way to act, against "every warning has a path to act".

## 2. Design

- `POST /mobile/attention/:id/choice {choice: 'done' | 'ignore'}`. Allowed for owner phones (device-signed, `ownerOnly`, in the `health-choices` bucket with the health quick actions, 12 per minute) and for the agent's token. It runs the dashboard's own `PATCH /attention/:id` over loopback: `done` → `DONE`, `ignore` → `WONT_DO`, with a resolution naming the phone. So that route's rules hold: write admission on a standby, the not-found answer, closing the Telegram topic. A refusal is worded for a person, never a raw code.
- App: a Needs-you row reads `machineNickname`, shown as "On Mac Studio" under the row and in its sheet. Its sheet offers Done and Ignore (Ignore asks once). An older agent answers `device-not-allowed`, and the app says it needs the update and points to Ask or the console.
- No Face ID: these are the same weight as the health quick actions, which need only the device signature. Settling an item changes no permission and starts or ends nothing. Someone holding the unlocked phone can already ignore a health problem.

Attention items have no "hide for a while", so the phone doesn't offer it. Done and Ignore are the dashboard's own two endings.

## Decision points touched

| Decision | Classification | Justification |
|---|---|---|
| Allowlist admits the route for active owner devices | invariant | Exact path pattern; the existing device model |
| `done`/`ignore` mapped to `DONE`/`WONT_DO` | invariant | A fixed table to the dashboard's statuses |

## Maturation plan

- **test-agent-live:** unit, integration and e2e below.
- **dev-agent-live:** after release, Done on a real Echo item from the simulator app, then the item gone from `GET /attention?status=OPEN`.
- **fleet:** ships with the device allowlist; no switch.
- **graduation criterion:** Justin settles one real Needs-you item from the phone.
- **ladder:** not applicable: no switch, a route beside the health quick actions under the same device rules.

## Open questions

*(none)*

## 4. Security

One new device route for owner phones, with the device signature only, no presence proof, matching the health quick actions it sits beside. Worst case from someone holding an unlocked phone: an open item is closed or ignored. The item stays in the store with its status, and the dashboard can reopen it. It can't settle another machine's item: it runs this machine's PATCH, which answers 404 for one it doesn't hold.

## 5. Multi-machine posture

Machine-local by design: it settles the item on the machine the phone reached, as the phone reads `/attention` there (no `scope=pool`). machine-local-justification: the item store is per machine, and the pooled remote-ack path is the dashboard's, needing a bound operator.

## 6. Tests

- Unit (`tests/unit/mobile-attention-choice.test.ts`): the exact PATCH body, refusals before any call, the words, the allowlist rule. The owner-route list in `tests/unit/mobile-session-terminal.test.ts` gains the path.
- Integration (`tests/integration/mobile-attention-choice.test.ts`): production auth and device pipeline. Owner allowed, MSP and unsigned refused, a phone on the raw PATCH refused.
- E2E (`tests/e2e/mobile-attention-choice-alive.test.ts`): a production boot without Telegram, a real local item, a real paired phone, and Ignore lands as `WONT_DO`.
- App: machine parsing, Ask's conversation key, the words.

## 7. Agent awareness and migration parity

`CapabilityIndex` adds the route to `mobileHealthIssues`'s endpoint list. No CLAUDE.md change: the existing Mobile app routes bullet covers health quick actions, and this is the same surface.

## 8. Rollback

Revert. The app then says the agent needs the update when Done or Ignore is tapped.
