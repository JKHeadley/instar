# Side-Effects Review — Secret Drop self-mint hardening

**Version / slug:** `secret-drop-self-mint-hardening`
**Date:** `2026-11-16`
**Author:** `Echo (security effort, topic 143781)`
**Second-pass reviewer:** `independent reviewer subagent (see below)`
**Spec:** `docs/specs/secret-drop-self-mint-hardening.md` (converged round 10, approved by the maintainer)

## Summary of the change

Class of problem: untrusted caller text, and the power to start a session, were reachable through a Secret Drop route authenticated only by loopback. Public detail stays at class level until installed.

- **New `src/server/secretDropMintPolicy.ts`** (pure rules): admission to the keyless route, the creator class, field-name rules, free-text cleaning, the untrusted-data wrapper, `#N` field references.
- **`SecretDrop.ts`:** every request stores its creator class (`master`, `owner-phone`, `dashboard`, `none`; default `none`). Only the first three keep a conversation. Keyless requests get half of the pending cap. The page shows a fixed warning and omits the description for unverified requests.
- **`routes.ts`:**
  - The key-gated mint route classifies its caller. The keyless route admits only this machine's own helper and is always `none`.
  - The validator cleans free text and applies the field-name rules per class.
  - The Telegram confirmation, the receipt inject/spawn and the stuck-consumer notice each check the stored class.
  - Session notices quote caller text as untrusted data.
  - `/secrets/pending` and `/secrets/retrieve` add `origin` and `fieldRefs`; retrieve returns an explicit shape.
  - A keyless request that names a conversation sends that conversation's live session one fixed, server-written line, at most hourly and never with a spawn.
- **`middleware.ts`:** `/secrets/retrieve` needs the PIN step-up for a dashboard session.
- **`mobileSecretsRoutes.ts`:** the phone's request is `owner-phone`, and unverified requests are left out of its duplicate check.
- **Helpers (`mcp-http-client.ts`, both call sites):** mint with the agent key, and fall back to the keyless route on no key, 401 or 403. `ThreadlineMCPServer` shows the server's `notice`.
- **`SessionManager.writePrivatePasteFile`:** every long session notice goes to a per-user 0700 folder that is checked before each write; any failure injects the notice inline instead.
- **Retrieve script:** accepts `#N`.
- **New awareness entry.**

## Decision-point inventory

- Creator class — add — deterministic, decided from server-checked facts and stored.
- Keyless route admission — add — deterministic.
- Session reach — modify — gated on the stored class at every sink.
- Field names and free text — modify — invariant classes refused or cleaned.
- Keyless share of the pending cap — add — floor at half the existing cap.

---

## 1. Over-block

- **A session started before this update, until it restarts.** Its requests are keyless.
  - They produce no "secret received" message. The session is told so in a plain line: a fixed notice to its live session, plus the answer field for current helpers.
  - Browser-password requests are refused with a plain message to restart.
  - Its requests show as unverified.
  - Links, the page, peer transfers and stored values work as before.
  - This is unavoidable: such a request cannot prove it is the agent, and treating an unproven caller as the agent is the vulnerability itself.
- **Field names.** A keyless request must use names that are safe in a command. Any request may not use `&`, `<`, `>`, a bare number, a reserved object key, a control character or a duplicate name. Ordinary names in any language are fine.
- **Pending cap.** More than 10 unread keyless requests get a plain 429 telling the caller to retrieve or cancel some.
- **Dashboard session reading a value** needs the PIN step-up (the scoped-session mode is dark today).
- **Installs with no key configured** make every request keyless (no receipts, no browser passwords). This is the existing no-key state, SEC-001.

## 2. Under-block

- **A same-user local process** can read the key and already controls the agent (SEC-018).
- **Wording of unverified requests.** The owner's phone and console lists still show their labels without an origin marker (the phone API is unchanged here). They never reach a session.
- **Prompt injection through verified requests** is reduced by quoting the caller text, not proven impossible.

## 3. Level-of-abstraction fit

- The class is decided once, at creation, and every sink reads the stored class.
- The rules live in one pure module.
- The paste-file fix is in the one shared notice writer, so it covers every long notice, not only Secret Drop's.

## 4. Signal vs authority compliance

- [x] Deterministic identity and format checks; no content judgment.

## 4b. Judgment-point check

The keyless cap is a fixed floor at half the existing cap; no new heuristic.

## 5. Interactions

- **Changes from the approved design (recorded):**
  - The `owner-phone` and `dashboard` classes keep their conversation. The design text dropped it, which would have silently broken the phone's and the console's receipt messages.
  - JSON answers keep the raw label plus an `origin` tag, so the dashboard reads normally. The untrusted-data wrapper is used in free-text session notices, where structure can be forged.
  - A request with no class defaults to keyless, so it fails closed.
- **Existing tests updated deliberately** (none loosened):
  - SecretDrop tests that expect a kept conversation now say the request was made with the key.
  - The phone tests expect `owner-phone`.
  - The at-rest and browser-route integration tests mint with the agent key, as the helper now does.

## 6. External surfaces

- Mint answers may add `receiptNotice` and `notice`.
- Pending and retrieve answers add `origin` and `fieldRefs`.
- Retrieve's answer is an explicit field list.
- The keyless route refuses browser-shaped and foreign-host requests with 403.

## 6b. Operator-surface quality

- Every refusal a pre-update session can hit is a plain sentence saying what to do.
- The page warns the person filling in an unverified request.

## 7. Multi-machine posture

- Machine-local by design: the keyless route and its admission, and the pending requests.
- Current main (SEC-057) excludes Secret Drop values from SecretSync. Durable records and their stored class stay on the receiving machine and survive restart. Peer transfer still creates a new drop on its receiving agent.
- The newer durable-delete-first consume flow and its retry/reporting helper are preserved.

## 8. Rollback cost

Revert and ship a patch. Old code ignores the stored class. Long notices return to the shared temp folder.

---

## Conclusion

The class is closed. A caller without the agent's key cannot get its words into a session, start one, or direct a secret to a browser site, and pre-update sessions are told plainly what to do. The second pass concurs on the core; its findings are fixed or named above. Clear to ship.

---

## Second-pass review

**Reviewer:** independent reviewer subagent (Claude, fresh context, read the diff and the console/middleware code)

**Independent read: concur on the core hardening, with concerns, now resolved.** It verified every sink, the class decision (including dashboard sessions, device keys, session tokens and the no-key state) and the long-notice path.

Its findings, and what was done:
- **Fixed:** the console's chosen conversation was silently dropped for dashboard requests. Dashboard now keeps it.
- **Fixed:** the restart notice's hourly slot was spent before checking for a live session. It is now spent only on delivery, and the wording is neutral, so a stranger cannot use it to claim a request was made.
- **Fixed:** a stale key (403) now falls back instead of failing.
- **Fixed:** keyless requests could fill the shared pending cap. They now have their own half.
- **Fixed:** `#N` order could differ for bare-number names. Bare-number names are now refused.
- **Named in §2:** labels in the phone and console lists, and installs with no key configured.

Its test gaps are closed with source checks that every session sink tests the stored class, a delivery test for the notice, and a cap test.

---

## Evidence pointers

- **Unit:** `secret-drop-mint-policy.test.ts`, `private-paste-file.test.ts`, `request-secret-helper-routing.test.ts`, plus new cases in `SecretDrop.test.ts`. 103/103 across those and the updated SecretDrop, hardening and phone files.
- **Integration:** `tests/integration/secret-drop-self-mint-hardening.test.ts`, 14 tests. Run against the previous code, 11 of the original 12 failed; the twelfth covers unchanged behaviour.
- **E2E:** `tests/e2e/secret-drop-self-mint-hardening-alive.test.ts`, 2 tests on the real server.
- **Existing tests in the area:** unit and integration (store-first, at-rest, trust gate, phone secrets, browser routes) and e2e (store-first lifecycle, phone secrets alive, console home) all pass.
- Integration and e2e files were run as temporary unit-config copies on 2026-11-16; Local Verify runs them under their own configs.
- `tsc --noEmit` clean.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable (a code defect in Secret Drop's trust boundary, closed by the tests above).


## Follow-up (Local Verify, 2026-11-17)

`writePrivatePasteFile`'s outer catch now carries the `@silent-fallback-ok` annotation with its reason (it logs, and the caller injects the notification inline instead), satisfying the silent-fallback ratchet. No behaviour change.

## Approved continuation and current-main reconciliation (2026-11-17)

Justin approved building and shipping in topic 143457 at 09:58 PST. The earlier maintainer-approved implementation was already in PR #3269. This continuation merges current main, preserves its machine-local Secret Drop storage and consume ordering, and retains the release fragment in upgrades/next. A fresh independent reviewer found no authentication or session-sink regression. Two helper selector issues were found and fixed: numbered selectors are printed with shell quotes, and option-like stored names are offered by position instead of colliding with helper flags. The real helper is exercised through a shell using synthetic values. The baseline hash is refreshed for the combined helper.

Fresh second-pass verdict after the selector fixes: **Concur.** No remaining authentication or session-sink concerns; shell-level helper test covers option-like names and quoted references. The reviewer also noted the required fixture-cleanup funnel; that cleanup now uses SafeFsExecutor. Targeted units: 84/84 in the four-file pass and 22/22 in the selector/policy pass; tsc --noEmit passes. Full verification is pending on the shared runner.
