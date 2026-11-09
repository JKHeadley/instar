# Side-Effects Review — second AI subscription setup recipe, switching a provider on for one agent

**Tier 2 by risk** (changes which providers an agent may run on, an operator-only setting, after the owner's confirmed yes; touches a credential shared by every agent of the machine user), with second-pass review. Spec: `docs/specs/recommended-services.md` (catalog row `second-ai-door`; Yes), `docs/specs/install-experience.md` §5 (AI doors). ELI16: `docs/specs/recommended-services-second-door-recipe.eli16.md`. Proven live, then marked available in the same change.

**Size:** 4 source files (1 new), 5 test files (2 new); about 150 lines of source. **Effort:** no spec rounds; 1 commit attempt expected.

## Summary

- `aiDoors.ts` (new): `AiDoorSurface` (enabled, installed, signedIn, enable → boolean, disable → boolean), `mainDoor`, `secondDoorCandidates`, `withDoor` (null when the agent lists no providers, which means every provider is allowed, or already lists the door), `withoutDoor` (never removes the main door).
- `recipes.ts`: `second-door-v1`. `verify` is the real capability: a second door (not the main one) installed and signed in on this machine → pass ("this agent can move a conversation onto it"); none → fail + absent; unreadable → unknown. `sync`: list that signed-in door in this agent's `enabledFrameworks` when the agent lists providers and doesn't list it yet (so the dashboard's provider choice and the boot-time internal fallback chain include it from the next restart); otherwise nothing. `stop`: take back every door setup itself listed (remembered by the server), whatever was signed in before; never sign out. Brief: check first (and run the server step), install without admin rights, sign-in as the person's own tap, price and a yes before anything is bought, never sign out, and say what it gives without promising a running conversation moves by itself.
- `routes.ts`: the real surface (`detectDoorPath`, `proveDoorSignedIn`), one writer `setEnabledFrameworks` (config file + the server's own copies), and `state/recommended-services/doors-added-by-setup.json` recording which doors setup listed.
- `recommendedServiceRoutes.ts`: a switch-off now also clears `lastSyncAt`, `lastSyncAttemptAt` and `syncFailures`, so a later yes refreshes on the next regular check instead of a day after the refresh before the switch-off (found in this proof; affects every recipe with a refresh).
- `catalog.ts`: `second-ai-door` → `setupRecipe: 'second-door-v1'`; benefit text corrected to what it gives.

## Decision-point inventory

- `second-door-v1.verify` / `.sync` — add — door proofs (one live, read-only, free call each).
- `setEnabledFrameworks` — add — writes an operator-only setting, reached only through a recipe that needs a confirmed owner yes (`hasGrant`).

## 1. Over-block

- Only Claude Code and Codex count as doors (the install engine's doors). Gemini, Pi and Grok stay outside this recipe; an agent on one of those as main is treated as Claude-main for candidates. Recorded.
- A door signed in but not installed under the detected path is skipped by `sync`.

## 2. Under-block

- The fence on `enabledFrameworks` exists so a bearer token alone cannot choose a lane. This change reaches it only through `/sync`, which requires a standing grant from the owner's PIN-confirmed yes for `second-ai-door`; a session cannot create that grant. The values written are limited to the two known doors. `grok-build` cannot be enabled by this path.
- A second door that later signs out stays switched on (the check then fails, and the regular re-check machinery reports it). Routing paths already refuse an unauthed lane.
- What a second door gives in practice (second-pass finding): a conversation can be moved onto any installed, signed-in provider (a chat pin checks only that the program is installed, so that worked before this change); listing the door adds it to the dashboard's provider choice at once, and to the internal fallback chain, SessionManager's copy and the Claude ban from the next restart; headless fallback is unused today. A running conversation never moves by itself. The catalog, the brief and the ELI16 now say only what holds.
- On a Codex-main agent the second door is Claude: listing it lifts the process-wide Claude ban at the next restart, so Claude usage becomes possible. It sits within the owner's yes for this service; recorded.
- The Claude sign-in proof refreshes the token after a 401, which rotates the machine user's shared Claude login; that is the install engine's existing behaviour, so "read-only" is slightly too strong for that one path.

## 3. Level-of-abstraction fit

The proofs are the install engine's own (`doors.ts`), not a second copy. The writer is the one place this agent's switched-on frameworks change at runtime, so the file and the live copies cannot drift.

## 4. Signal vs authority compliance

- [x] No new block/allow surface over content. The new authority (switching a lane on) is gated by the owner's existing confirmed yes. Reference: `docs/signal-vs-authority.md`.

## 4b. Judgment-point check

No heuristic at a competing-signals point.

## 5. Interactions

- **Shared sign-in:** the machine user's provider logins are shared by every agent (and by the development agent on this machine). Nothing here signs in or out, so another agent's provider is never disturbed; the live proof confirmed the machine's Codex stayed signed in after the switch-off.
- **Main door:** never removed (`withoutDoor`), so a switch-off can't leave an agent with no lane.
- **Offers:** the row becomes available and joins the next list; its in-use probe is the same `verify`.
- **Pins and the dashboard:** a chat pin never consulted the list; the dashboard's provider choice reads it live.
- **Refresh:** once the check passes, the daily refresh runs `sync`, which changes nothing when the door is listed (`withDoor` returns null), so the config file is not rewritten. A door the operator removes by hand while the yes stands is listed again by the next daily refresh; recorded.
- **Config writes:** `writeConfigAtomic` preserves secret-reference placeholders; it writes a new file with default permissions, the same pattern the GitHub switch-off already uses.

## 6. External surfaces

- This agent's `enabledFrameworks` in `.instar/config.json`: a door appended by the server step after a yes (only where the agent lists providers), and taken back on a switch-off only if setup appended it.
- The confirm page answers for `second-ai-door` on every agent.
- **Operator surface (Mobile-Complete):** yes/no on the confirm page; the sign-in is a tap on a link; nothing API-only.

## 6b. Operator-surface quality

The session's closing message says what the person now has and how to use it ("ask me to move a conversation over"), not a promise of automatic failover.

## 7. Multi-machine posture

- A door's sign-in and this agent's switched-on list are **per machine by design** (`machine-local-justification: physical-credential-locality`): a login lives on one disk. Each machine takes its own yes, as for the other recipes.

## 8. Rollback cost

A revert removes the recipe and the writer; a door already switched on stays in the config (harmless, and the operator's to change). The catalog text returns to its old wording.

## Live proof (2026-11-08, throwaway `recsvc-bw-agent`, built from this branch, `enabledFrameworks: ['claude-code']`; real Telegram test group; Echo as the person)

| Step | Evidence |
|---|---|
| 00:49–00:52Z (first build): ask → explanation and yes page → yes → setup → Codex switched on → the agent said so → no with switch-off → off again; the machine's Codex still signed in | msgs 140–142, `door-explained-msg140.json`, `door-setup-done-msg142.json`, `door-row-after-pass.json`, `door-no-switchoff-response.json` |
| The agent twice promised automatic switching ("if Claude goes down, your agent switches to Codex and keeps working") | msgs 140, 142 → catalog, brief and docs corrected |
| 00:58–01:14Z (reworked build): a fresh yes found Codex already signed in → check passed ("can move a conversation onto it"), "already working" → the refresh waited a day because the earlier switch-off kept the last-refresh record → fixed (switch-off clears it) | `door2-*` files |
| 01:09–01:14Z (fixed build): no then yes → the next regular check (01:14:15Z) listed Codex for this agent, recorded as setup's | config `['claude-code', 'codex-cli']`, `doors-added-by-setup.json: ["codex-cli"]` |
| 01:15Z: no with switch-off → Codex taken back out of this agent's settings; its sign-in stays | `door4-no-response.json`, `door4-after-no.txt` (`enabledFrameworks ['claude-code']`) |

Not exercised: the person's sign-in tap (Codex was already signed in on this machine). It is the install engine's own sign-in step, and the brief tells the session to send it as one link.

## Class-Closure Declaration

- `unbounded-self-action` → closure `n/a` (negative declaration). Reason: no new self-triggered action; the server step runs on the session's call after a yes, and the check rides the existing bounded setup schedule.

## Second-pass review

Independent read (reviewer subagent, 2026-11-08), tests run. The fence holds: the writer is reachable only through `/sync` and the switch-off, both needing a standing grant from the owner's PIN-confirmed yes; only `claude-code`/`codex-cli` can be added; replay is idempotent. A switch-off never signs out and never removes the main door.

**Concern raised:** the artifact and ELI16 overstated what switching a door on does at runtime (chat pins never checked the list, headless fallback is unused, SessionManager and the boot-time gates keep the boot list). **Resolved:** the check now tests the real capability (signed in on this machine); listing is a secondary server step described as "dashboard at once, internal fallback from the next restart"; §2/§5 and the ELI16 corrected. Notes taken: the switch-off restores only what setup listed (the server remembers it), so an agent with no list keeps every provider allowed; the daily refresh no longer rewrites the config; the Claude-ban and token-refresh side effects are recorded in §2.
