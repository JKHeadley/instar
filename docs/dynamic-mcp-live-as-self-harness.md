# Dynamic MCP — Live-as-Self Test Harness

> The **Live-User-Channel Proof** for the Dynamic MCP Lifecycle. A user-facing
> feature is not "done" until a user-role session has driven it end-to-end through
> its **real** user surface (Telegram), in a live environment, **before** the
> operator is ever asked to test. This runbook is that proof for dynamic MCP.
>
> **Operator standard (verbatim):** *"part of this development cycle should be a
> plan to test this feature fully using the test-as-self method… use Playwright with
> the custom profile that's logged into my Telegram so that you can test the feature
> by sending messages through Telegram as me… this should always be part of every
> feature testing plan."* And: *"I also want to verify that it both loads on demand
> and offloads when the work requiring the MCP is done — these thorough test
> scenarios should be the default standard."*

This is a **deterministic runbook the agent executes itself** (via the Playwright
MCP) — not a promise and not a thing the operator runs. It is **gated** only on one
external prerequisite the agent cannot self-provision: a browser profile logged into
the operator's Telegram. Everything else is automatable.

The CI-side complement already exists and runs on every build — the
`FULL LIFECYCLE: lean baseline → load on demand → offload when done → back to lean`
test in `tests/unit/dynamic-mcp-service.test.ts`. This harness drives the **same**
state transitions through the **real** Telegram surface + a **real** session restart,
which the unit test (faked host primitives) cannot.

---

## Prerequisite (the one gate) — a Telegram-logged-in Playwright profile

The harness needs a Playwright **profile** whose browser session is logged into the
operator's Telegram Web, registered in the Playwright Profile Registry. Verify first
(Know Before You Claim):

```bash
curl -H "Authorization: Bearer $AUTH" \
  "http://localhost:4042/playwright-profiles/resolve?service=telegram"
# → {"profile": null}  ⇒ NOT set up yet, the harness cannot run
# → {"profile": {...}}  ⇒ ready
```

To set it up (operator does this once, on the machine that will run the harness):

1. The operator opens `https://web.telegram.org` in a dedicated browser profile and
   logs in (their account).
2. Register that profile's user-data-dir:
   ```bash
   curl -X POST -H "Authorization: Bearer $AUTH" \
     http://localhost:4042/playwright-profiles \
     -H 'Content-Type: application/json' \
     -d '{"id":"justin-telegram","description":"Operator Telegram Web — live-as-self testing"}'
   curl -X POST -H "Authorization: Bearer $AUTH" \
     http://localhost:4042/playwright-profiles/justin-telegram/accounts \
     -H 'Content-Type: application/json' \
     -d '{"service":"telegram","identity":"<operator handle>","owner":"operator","vaultRefs":[],"loginMethod":"web-session"}'
   ```
3. Re-run the `resolve` check above — it should now return the profile.

> **Know Your Principal:** this profile is **operator-owned**. Acting *as* the
> operator through it is authorized ONLY for this explicitly-mandated test-as-self
> flow against demo/non-destructive surfaces. The harness sends only benign test
> prompts; it never takes a consequential action as the operator.

---

## Test environment

- Run on a **throwaway / demo topic**, never a live operator conversation, for the
  volatile/permission scenarios (Live-User-Channel Proof standard).
- Enable the feature for the test only: `.instar/config.json` →
  `sessions.dynamicMcp.enabled: true` (+ `keepWarm: ["threadline"]`, and for the
  idle-offload scenario `sessions.dynamicMcp.sweep: { enabled: true, dryRun: false,
  idleOffloadMs: 60000 }` — a short idle window so the sweep fires within the test).
  Restart the target session so it picks up the lean baseline.
- The agent drives Telegram Web through the registered profile using the Playwright
  MCP (`browser_navigate`, `browser_snapshot`, `browser_type`, `browser_click`).

---

## Scenario matrix (the PASS/FAIL the proof records)

Each row: act through the **real** Telegram surface as the operator, then verify the
**real** server state. Record PASS/FAIL with evidence (the `GET /mcp/session` body +
the session's `model`/restart marker).

### S1 — Lean baseline (cold start)
1. Confirm the target session is freshly spawned with the feature on.
2. **Verify:** `GET /mcp/session/:topicId` → `servers: ["threadline"]`, `source:
   "baseline"`. The heavy server (playwright) is **absent**.
   **PASS** iff the session launched lean.

### S2 — Load on demand (autonomous-preapproved path)
1. With an active autonomous run on the topic (preapproved), the agent calls
   `POST /mcp/load {topicId, server:"playwright"}`.
2. **Verify:** response `applied`; the session restarted (`--resume`, conversation
   intact — confirm the thread continues, not a re-greet); `GET /mcp/session` now
   lists `playwright`, `source: "committed"`.
   **PASS** iff the heavy server loaded and the conversation survived the restart.

### S3 — Load on demand (interactive, operator-approval TAP path)
1. On a **non-preapproved** interactive topic, the agent calls `POST /mcp/load` →
   `needs-approval` + a server-minted nonce.
2. The agent calls `POST /mcp/approval-link` and **sends the operator the link over
   Telegram**.
3. **As the operator (via Playwright):** open the link, confirm the page shows the
   right server + topic and **no nonce**, type the dashboard PIN, tap Approve.
4. **Verify:** the page shows "Approved"; `GET /mcp/session` lists `playwright`. A
   second tap on the same link → 404 (single-use).
   **PASS** iff the operator-approved load completed via the tap and the agent could
   not self-approve (the C4 invariant — confirm a bearer-only `POST /mcp/approve/:id`
   without the PIN is 403).

### S4 — Offload when done (explicit)
1. After the work needing playwright is finished, the agent calls
   `POST /mcp/offload {topicId, server:"playwright"}`.
2. **Verify:** `applied`; session restarted; `GET /mcp/session` back to
   `["threadline"]`; the heavy child processes are gone — `GET /processes/mcp-reaper`
   (or `ps`) shows no orphaned Chromium for that session.
   **PASS** iff the server dropped **and** its leaked children were reclaimed (C1).

### S5 — Offload when idle (automatic sweep)
1. Load playwright (S2), then leave the session idle (no tool use) past
   `idleOffloadMs`.
2. **Verify:** the sweep fires, offloads playwright, and `GET /mcp/session` returns
   to lean **without** the agent being asked — the idle clock + mid-tool-use guard
   did the right thing (it must NOT offload while the pane shows active work).
   **PASS** iff idle → auto-offload → back to lean, and a busy session is left alone.

### S6 — Mid-tool-use safety
1. While the session is **actively** using a playwright tool, trigger an offload.
2. **Verify:** the offload **aborts** (`{status:"aborted", reason:"mid-tool-use"}`),
   no restart, nothing reaped.
   **PASS** iff a busy session is never yanked.

### S7 — Dark by default (regression)
1. Set `sessions.dynamicMcp.enabled: false`, restart.
2. **Verify:** every `/mcp/*` route → 503; the session launches with the **full**
   `.mcp.json` set (byte-identical to pre-feature). **PASS** iff off ⇒ no behavior
   change.

---

## Recording the proof

Capture, per scenario: the Telegram action (screenshot via `browser_take_screenshot`),
the `GET /mcp/session` body before/after, and the restart/process evidence. A run is
a **PASS** only when S1–S7 all pass. File the signed scenario matrix per the
Live-User-Channel Proof standard (`docs/specs/live-user-channel-proof-standard.md`)
**before** the `sessions.dynamicMcp.enabled` dev-gate flip — the operator should never
be the first to drive this feature.

> Until the Telegram profile prerequisite is met, this harness is **blocked at S2/S3
> live execution only**; S1/S7 (and the full deterministic lifecycle) are already
> proven by the CI unit/integration/e2e suite. The flip waits on the live run.
