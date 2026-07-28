# Side-Effects Review — self-stop-guard hook

**Version / slug:** `self-stop-guard`
**Date:** `2026-06-02`
**Author:** `echo`
**Second-pass reviewer:** `not required (Tier-1, signal-only additive hook; external cross-model capacity-blocked this session — codex absent, gemini 429)`

## Summary of the change

Adds `self-stop-guard.js`, a signal-only PreToolUse hook (sibling of `deferral-detector.js`) that scans outbound user messages for context/length stop-excuses ("maxed out context", "session too long", "start a fresh session", "good stopping point") and, on a match, injects a self-reminder that those are never valid stop reasons. Files: new `.instar/hooks/instar/self-stop-guard.js` + its embedded twin `getSelfStopGuardHook()` in `src/core/PostUpdateMigrator.ts` (+ `getHookContent` case, `migrateHooks` write, `builtinHooks` layout array); registration in `src/core/instarSettingsHooks.ts` (`INSTAR_BASH_PRETOOLUSE_HOOKS` → both init and migrate), `src/commands/init.ts` (new-agent write), `src/core/installCodexHooks.ts` (Codex PreToolUse chain); manifest entry via `scripts/generate-builtin-manifest.cjs`.

## Decision-point inventory

- `self-stop-guard: is this outbound message a context/length stop-excuse?` — **add** — a regex detector that, on match, injects `additionalContext`. Produces a SIGNAL; holds NO block/allow authority.

---

## 1. Over-block

**What legitimate inputs does this change reject that it shouldn't?** None — there is no block surface. The worst case is an over-FIRE (a harmless self-reminder injected when it shouldn't be). Concrete over-fire shapes: a message that legitimately contains a trigger phrase out of context — e.g. discussing this very feature ("I added a good-stopping-point detector"), or quoting the user. These inject a reminder into the agent's own turn; the message still sends unchanged and nothing is blocked. Mitigated by the completion/user-asked-to-stop allow-list, which suppresses the common legitimate cases.

---

## 2. Under-block

**What failure modes does this still miss?** (a) It only scans outbound communication commands (telegram-reply / send-*); a stop-excuse expressed in internal reasoning but never sent is not seen. (b) It does not cover the autonomous-stop-hook / session-end layer — that is a separate level (the user asked for checks "on multiple levels"; this is the pre-send level). (c) Novel phrasings outside the pattern set slip through (e.g. a creative euphemism for "I'm out of context"). These are acceptable: the hook reduces, not eliminates, the anti-pattern, and is one layer of several.

---

## 3. Level-of-abstraction fit

Correct layer. This is a low-level, cheap detector that produces a SIGNAL (an `additionalContext` injection into the agent's own context), exactly like its sibling `deferral-detector`. It does not attempt to be an authority — it never blocks. The "authority" that can actually hold/redirect a turn is the agent's own reasoning, which this feeds. It reuses the existing PreToolUse-Bash hook surface rather than inventing a new mechanism.

---

## 4. Signal vs authority compliance

**Required reference:** [docs/signal-vs-authority.md](../../docs/signal-vs-authority.md)

- [x] No — this change produces a signal consumed by an existing smart gate (the agent's own next-turn reasoning).

It writes `{ decision: 'approve', additionalContext: <reminder> }` — `approve` is unconditional; the hook can never block or delay a message. Brittle regex is acceptable precisely because it holds no authority: a false match costs one harmless reminder.

---

## 5. Interactions

- **Shadowing:** runs in the PreToolUse Bash matcher chain after `deferral-detector` and before `external-communication-guard`. All non-`dangerous-command-guard` hooks in the chain emit `approve`+`additionalContext` (never block), so it cannot shadow or be shadowed — each contributes additive context.
- **Double-fire:** a message containing both a defer-pattern and a stop-excuse triggers both `deferral-detector` and this hook; both inject context. That is additive and non-conflicting, not a harmful double-fire.
- **Races:** none — the hook is a stateless, pure stdin→stdout process. It writes no files and shares no state (logging was deliberately omitted to keep it ESM-host-safe and side-effect-free).
- **Feedback loops:** none — it injects context into the agent; the agent's resulting message is not re-fed to the hook in a loop (the injected reminder text is not itself a stop-excuse).

---

## 6. External surfaces

- Other agents on the machine: unaffected (per-session PreToolUse hook).
- Install base: ships to ALL agents on next update via `INSTAR_BASH_PRETOOLUSE_HOOKS` (init + migrate parity) and the Codex chain — intended.
- External systems: none — the hook never makes network calls and never touches Telegram/Slack/GitHub.
- Persistent state: none — writes nothing to disk.
- Timing/runtime: a sub-second `node` process per outbound command (5s timeout, same as deferral-detector). Negligible.

---

## 7. Rollback cost

Pure additive code change. Back-out = remove the `self-stop-guard.js` entry from `INSTAR_BASH_PRETOOLUSE_HOOKS` + the file writes + the manifest entry, ship as a patch. No persistent state, no data migration, no agent-state repair. Existing agents drop the hook on their next update (settings re-derive from the canonical list). No user-visible regression during the rollback window (the hook never blocked anything).

---

## Conclusion

The review produced no design changes — the hook was deliberately scoped signal-only and stateless from the start, mirroring the proven `deferral-detector` contract. The only residuals are harmless over-fires (mitigated by the allow-list) and the deliberate single-layer scope (pre-send only; the stop-hook layer is future work the user explicitly framed as "multiple levels"). Clear to ship as a Tier-1 additive guard.

## Second-pass review (if required)

Not required for a Tier-1 signal-only additive hook. External cross-model review was unavailable this session (codex CLI not installed; Gemini CLI returned 429 "exhausted capacity"). A cross-model pass by Codey (codex) is queued after his current keystone build.

## Evidence pointers

- 16 unit tests spawn the shipped hook end-to-end (`tests/unit/self-stop-guard.test.ts`) — both sides of the boundary, Claude `Bash` + Codex `exec_command`.
- Drift/parity green: `instar-settings-hooks`, `builtin-manifest`, `PostUpdateMigrator-pretooluse-parity`, `migration-parity-hooks`.
- Origin incident: 2026-06-02 early-close of a 12h autonomous run citing "maxed out context" (the behavior this guards).
