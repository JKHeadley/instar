# Side-Effects Review — A stand-in owner chat for throwaway agents

**Version / slug:** `throwaway-owner-chat`
**Date:** `2026-11-21`
**Author:** `Echo (identity session, topic 144636)`
**Second-pass reviewer:** `independent reviewer subagent (see below)`

## Summary of the change

Tier 2. Adds a test-only stand-in for the owner's private Telegram chat that exists only on a single-machine throwaway agent in a temporary folder with no owner (docs/specs/throwaway-owner-chat.md, converged in 6 rounds, approved by Echo on the Chief of Staff's decision 1d8498bd). New: `src/server/throwawayOwnerChat.ts` (conditions, the stand-in, its log and shut-off sweep), `src/server/throwawayOwnerChatRoutes.ts` (three loopback, master-token routes), `src/messaging/ownerChatTap.ts` (the `OwnerChatSurface` seam and the shared Approve/Decline tap wording). Changed: `src/server/AgentServer.ts` (owner DM, owner presence and the Approve/Decline handlers now go through the owner-chat seam; Telegram behaviour unchanged; routes mounted only for a live stand-in; machine pairing blocked for a home that used it), `src/messaging/TelegramAdapter.ts` (tap wording moved into the shared module, same words), `src/server/machineRoutes.ts` (`pairBlocked` refusal in `/api/pair`), `src/commands/machine.ts` (`instar pair` / `instar join` refuse on such a home), `src/core/types.ts` (optional `liveTest.throwawayOwnerChat.enabled`), `src/data/state-coherence-registry.json` (one machine-local row), `src/data/awareness/throwaway-owner-chat.md`. About 700 lines of source and 600 of tests.

## Decision-point inventory

- `evaluateStandIn` four conditions — add — invariant facts read from the agent's own files; refuse on any.
- Stand-in route gate (`standInCallerAllowed`) — add — master bearer exactly, no device header, no Origin, own loopback host.
- Shut-off for good vs unsure — add — a definitely-false fact shuts off and sweeps; a failed read only withholds one use.
- `/api/pair`, `instar pair`, `instar join` — modify — refused for a home that ever built the stand-in (and `/api/pair` also while it is not off).
- `approvalPath()` owner presence (`telegramOwnerPresent`) — modify — true for a live-or-unsure stand-in on an agent with no Telegram; unchanged with Telegram.
- Telegram Approve/Decline taps — pass-through — same checks, same words, now read from `ownerChatTap.ts`.

---

## 1. Over-block

The conditions refuse some legitimate test homes: a throwaway with a disabled messaging entry left in its config, one created with a paired device already in it, one whose record expired mid-run (shut off for good; a new throwaway is needed), and one whose home folder was copied from another agent. Each refusal is logged with its condition, and the remedy is always "make a fresh throwaway", which is the intended workflow. The route gate refuses a test that sends an `Origin` header (a browser page) or uses a dashboard session instead of the agent token; a test must use curl or similar with the agent token, which the awareness entry shows.

## 2. Under-block

A determined process running as the same user can forge the stand-in's own state file, copy keys, or build a temp-folder agent by hand; the spec says plainly that the conditions stop accidental and single-edit paths, not such a process, which already holds the machine signing keys and bearer token. A raw port-forward on this computer that rewrites Host to `localhost:<port>` and adds no forwarding headers passes the loopback check; it needs local process access and the bearer is still required. A listed path that is not an agent home has no identity to compare; an identity file that exists but cannot be read makes the use unsure, never a non-match.

## 3. Level-of-abstraction fit

The stand-in sits at the owner-chat seam, the lowest layer at which the approval flows can be fed without a second code path: the flows call `ownerDM` and the handler slots exactly as they do with Telegram, and the stand-in reuses the production handlers and the shared tap wording. The location and expiry facts reuse `ThrowawayAgentGuard` (with a stricter real-path check, explained in the spec); the loopback check reuses `ownLoopbackHost`; the bearer check reuses `bearerMatches` (guarded against its "no token configured" true).

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [ ] No — this change produces a signal consumed by an existing smart gate.
- [ ] No — this change has no block/allow surface.
- [ ] Yes — but the logic is a smart gate with full conversational context (LLM-backed with recent history or equivalent).
- [x] Yes, deterministic by design on an irreversible safety boundary (not brittle judgment).

The refusals are deterministic facts on a safety guard, the case Signal vs Authority reserves for deterministic logic: owner authority on a real agent is irreversible harm, and each condition is an enumerable fact (folder location, a config field, a file's presence), not a judgment over competing signals. The refusals only ever withhold the test fixture; they never block a real user's message, session or action.

## 4b. Judgment-point check (Judgment Within Floors standard)

No new static heuristic at a competing-signals decision point. The four conditions, the route gate and the shut-off rule are invariants on an irreversible safety boundary, each classified with basis and evidence in the spec's `## Decision points touched`. The byte budget, reserve, per-message cap and page size are labelled resource budgets that refuse rather than evict.

## 5. Interactions

- **Shadowing:** on a Telegram agent nothing changes: `ownerChat` is the adapter, `telegramOwnerPresent` is the old expression, and the handler loop assigns the same closures to the adapter. `mobileInboundScan` and `onHubPost` stay Telegram-only. A home whose config asks for the stand-in but has Telegram builds a stand-in object that is off at once and never writes a state file, so it never blocks pairing.
- **Double-fire:** on a home that ran the stand-in and later has Telegram, both surfaces hold the same handlers; only the stand-in's shut-off sweep calls them, once, and only for its own live `md:d:` buttons.
- **Races:** handlers are synchronous; a shut-off found inside `ownerDM` sweeps re-entrantly while the current send gets `null` ("not delivered"), which the pairing code already handles. `/api/pair` is refused from boot while the stand-in is not off, so a pairing cannot land between an unsure boot and the first recorded build.
- **Feedback loops:** none; the stand-in sends nothing outward.

## 6. External surfaces

No change on any agent that does not qualify: `ThrowawayOwnerChat.forBoot` returns null unless the config asks for it or the home ran it before, and no route is mounted. On a qualifying throwaway: three new loopback routes, two state files under `.instar/state/`, a boot log line, and machine pairing refused for the home's life. The Telegram tap words are unchanged (moved, byte-identical). Operator surface: none; this is a test fixture driven by a test process, not an operator action.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No operator surface — not applicable.

## 7. Multi-machine posture (Cross-Machine Coherence)

Machine-local by design (`hardware-bound-resource` in the spec): the stand-in exists only while the pool has exactly this one machine, machine pairing is refused in both directions for the life of a home that used it, and it shuts off for good if another machine appears anyway, so no second machine ever holds or lacks its state. No user-facing notices (it is a test log); its durable state is not tied to a topic; it generates no URLs. Status surfaces: none new or changed (`/health`, `/capabilities`, `/status`, `/channels` untouched).

## 8. Rollback cost

Revert the commit and ship a patch. Before running older code on a throwaway that used the stand-in, tear that throwaway down (older code ignores the state file that keeps machine pairing refused); throwaways are temporary test homes and expire on their own. No migration, no real-agent state, no user-visible regression.

## Conclusion

The review confirmed the design converged in the spec: the stand-in cannot exist on a real agent by any single edit or accident, runs the production approval code, and is fenced from other machines. The build added the seam on main so pieces 3a and 3d plug in with small, listed wiring changes. Clear to ship.

---

## Second-pass review (if required)

**Reviewer:** independent reviewer subagent
**Independent read of the artifact: concur**

Audited the code, not the artifact. Safety holds: a real agent's folder fails the fixed-temp-root real-path check (`throwawayOwnerChat.ts:140`, `FIXED_TEMP_ROOTS` is not env-derived) before any write; state is written only on a full pass (`:185`) or when it already exists (`:174`, `recordOff :294`), so a real agent with the switch on never gets a state file and is never pairing-blocked. Telegram taps are byte-identical (words, `editMessageReplyMarkup`, `sendToOwnerDM` text and return values via `ownerChatTap.ts`); `ownerDM`/`telegramOwnerPresent` are unchanged when `options.telegram` exists. Routes need the exact master bearer, no device/Origin header, own loopback Host. The sweep cannot loop (`off` set first; re-entrant sends get null). 40 unit tests pass. Non-blocking findings:
- Spec §2 says an unreadable other home "counts as not matching"; code makes it unsure (`:120` via `readJsonFile`). A stray file in `~/.instar/agents` (e.g. `.DS_Store`) gives ENOTDIR (verified) and withholds the stand-in on every use. Skip non-directories/ENOTDIR, or fix the spec.
- `loadLog` skips a torn last line, but the next `appendFileSync` joins onto it (`:450`), so that entry (possibly an `edit`) is lost on the next replay. Write a leading newline when the file does not end in one.
- `evaluateStandIn` reads config/state before the location check (`:133-134`), so a transient read error on a real agent with the switch on mounts the routes and makes `pairBlocked` (`AgentServer.ts`, which reads only `isOff()`) refuse pairing until the next gate call. Check location first.
- `finishShutOff` comment at `:310` says a malformed state is "treated as not swept", but it returns without sweeping.

**Author's resolution (after the second pass):** all four fixed. The other-home scan lists only folders and reads a not-a-folder path as "no identity" (`ENOTDIR` like `ENOENT`), while an identity file that exists but cannot be read stays unsure; the spec now says exactly that. The log starts a new line after a torn tail (unit test added). The location check now runs before any file read, so a real agent is always refused definitely. The comment was corrected. 41 unit tests pass.

---

## Evidence pointers

- `tests/unit/throwawayOwnerChat.test.ts` (37): each refusal, unsure vs off, shut-off sweep (runtime and boot), hook retry, bounds, budget reserve, intents and indeterminate, paging, tap outcome rules, command allowlist, route gate.
- `tests/unit/throwawayOwnerChat-pairing.test.ts` (3): `/api/pair` refusal and the lifetime marker.
- `tests/integration/throwaway-owner-chat.test.ts` (2): shut-off mid-run through the HTTP pipeline ends a carried pairing; tunnel host refused.
- `tests/e2e/throwaway-owner-chat-alive.test.ts` (2): production `AgentServer` boot: built, redeem, Approve tap, signed device read `active` with `approvedVia: 'telegram-dm'`, Decline tap; Telegram-configured boot refused with handlers on the adapter.

---

## Class-Closure Declaration (display-only mirror)

No agent-authored-artifact defect — not applicable. The shut-off sweep is a one-shot, self-limiting step (it runs once per shut-off, records `swept`, and re-runs at boot only while a registered hook failed), not a recurring self-triggered controller.
