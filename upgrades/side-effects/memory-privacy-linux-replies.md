# Side-Effects Review — memory privacy: replies reach the server from Linux sandboxed sessions

**Version / slug:** `memory-privacy-linux-replies`
**Date:** `2026-11-04`
**Author:** `echo`
**Second-pass reviewer:** `not required — Tier 1: no new reach, no block/allow surface, Linux-only, opt-in feature`

## Summary of the change

Tier 1, 6 files, about 90 lines including tests and docs. Fixes fb-0fd50d5c-bad. With `memoryPrivacy.enabled: true` on Linux, a scoped session runs in bubblewrap with its own network namespace, and the sandbox's `NO_PROXY` lists `localhost`, so every reply script's curl went direct and failed with exit 7: memory was kept private but nobody got a reply. `src/core/memorySessionPolicy.ts` gains `prepareSessionCurlHome(scopeDir)`, which on Linux writes `<scope>/.curl/.curlrc` with `noproxy = ""` and returns that folder. `src/core/SessionManager.ts` passes it to scoped sessions as `CURL_HOME`, so curl sends `localhost` through the sandbox proxy, which already allows it (`localhost` is in `allowedDomains`). macOS and privacy-off sessions are unchanged. Effort: one commit attempt so far, no spec review rounds (the converged memory-privacy spec already says the session reaches localhost; this makes Linux match it).

## Decision-point inventory

- Memory-session launch (`SessionManager` scoped spawn) — modify — adds one environment variable on Linux; no allow/deny decision changes.

---

## 1. Over-block

No block/allow surface — over-block not applicable.

---

## 2. Under-block

No block/allow surface. On reach: the session gains nothing new. It could already run `curl --noproxy '' -x "$HTTP_PROXY" http://localhost:...` itself; this only makes the reply scripts do what the sandbox already permits. The proxy still filters by `allowedDomains`, and the server still accepts only the session's limited `mps_` token. The file boundary is untouched: in the live run the agent home's files stayed unreadable.

---

## 3. Level-of-abstraction fit

Right layer: the spawn already owns the session's environment (`TMPDIR`, `CLAUDE_CODE_TMPDIR`, `INSTAR_PORT`). Changing each reply script would need a migration for five scripts and would miss any curl the session runs on its own; `CURL_HOME` covers all of them from one place.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change has no block/allow surface.

It sets a transport setting for the session's curl; nothing is decided or refused.

---

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The platform check is an invariant: Linux sandboxes use a separate network namespace, macOS does not.

---

## 5. Interactions

- **Shadowing:** none; reply scripts run unchanged and pick up the setting from curl itself.
- **Double-fire:** none.
- **Races:** the file is rewritten at every spawn of that scope; two sessions on the same scope write identical bytes.
- **Feedback loops:** none.

---

## 6. External surfaces

Only agents with memory privacy turned on, on Linux. Their replies now reach Slack, Telegram, WhatsApp and the app again. No operator-facing actions.

---

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable.

---

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design: the file lives in the machine-local scope folder that the spec already keeps on one machine, and it describes this machine's sandbox. No notices, no URLs, no new status surfaces.

---

## 8. Rollback cost

Pure code change: revert and ship a patch. The leftover `.curl/.curlrc` in scope folders is inert without `CURL_HOME`.

---

## Conclusion

Clear to ship. It restores replies for Linux agents that opted in, without widening what the session can reach. Follow-up worth considering, not required here: the boot probe could also check that the server answers from inside the sandbox before reporting `sandboxReady: true`.

---

## Second-pass review (if required)

Not required (Tier 1, no block/allow surface, no new reach).

---

## Evidence pointers

Live on Hetzner mp-privacy-test (Ubuntu 24.04, Claude Code 2.1.318, a local stand-in for the model API so no account was used), real settings from `buildMemorySessionSettings`, real `slack-reply.sh` and `telegram-reply.sh`, stand-in server on 127.0.0.1:4040:
- Without the change: `curl: (7) Failed to connect to localhost port 4040`, slack rc=1, server saw nothing.
- With `CURL_HOME`: "Sent 22 chars to channel C123ABC", "Sent 9 chars to topic 42"; server saw `/slack/reply/C123ABC`, `/messaging/preflight`, `/telegram/reply/42`, each with `Bearer mps_scoped`; reading the agent home's notes file still failed with Permission denied.
- Proxy without its credentials answers 407, which an earlier probe read as an empty reply.
Tests: `tests/unit/memory-session-policy.test.ts`, `tests/integration/memory-privacy-spawn.test.ts`.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable.
