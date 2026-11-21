# Side effects: inbound messages can no longer act as keystrokes in a session (SEC-137)

In plain words: before any text is typed into a session's terminal, carriage returns become ordinary newlines and every other invisible control character (except tab and newline) is dropped, so a message cannot press keys.

Tier 1. Size: 2 source files edited (`SessionManager.ts`, `server.ts`), 1 new helper file, 1 new and 2 extended unit test files.

## What changes for running agents
- `SessionManager.rawInject`, which every inbound message (Telegram, WhatsApp, iMessage, Slack, app, A2A, jobs) and every first-party injection passes through, now calls `neutralizeTerminalControls(text)` right after the existing paste-marker strip.
- `\r\n` and a lone `\r` become `\n`. A message that contained `\r` therefore becomes multi-line and is delivered as ONE bracketed paste with its tag at the top, instead of being split into two turns.
- C0 controls other than tab and newline (including NUL, BS, ESC, Ctrl-C, Ctrl-U), DEL, and C1 controls (U+0080–U+009F) are removed. Nothing else changes: printable text, emoji, combining marks and every script pass byte-for-byte.
- The A2A live-session typing path (`tmuxOps.sendKeys` in `src/commands/server.ts`, used when a peer agent's message is typed straight into a running session) now cleans the text with the same `sanitizeTypedText` before typing it.
- The pending first-message record (`pendingInjects.record` at spawn) now stores the cleaned text, so the fresh-Codex first-message match in `rawInject` compares the same text it types. The cleaning gives the same result when run twice, so recovery re-injection is unchanged.
- A single-line message containing a tab now goes through the bracketed paste instead of being typed key by key (a typed tab can trigger completion).
- The separate control-key path (`performTmuxInjectionEffect`'s deliberate key sends, such as Escape or interrupt issued by instar itself) does not go through `rawInject` and is unchanged.
- First-party injections pass through too; they never carry these bytes, so nothing they send changes.

## Signal vs authority
Input normalisation at the typing boundary. It refuses nothing and grants nothing.

## Rollback
Revert the commit. No state change.

## Tests
- `tests/unit/headless-spawn-reroute.test.ts` "SEC-137 repro" (the security-review job's test; fails on main 11204dab6, passes here): 54 pass.
- `tests/unit/headless-spawn-reroute.test.ts`: the repro now also checks the text still arrives with CR turned into a newline; a new test checks a tab goes through the paste: 55 pass.
- `tests/unit/terminal-control-bytes.test.ts` (new): 7 pass (cleaner, shared sanitiser, idempotence, A2A wiring source check).
- `tests/unit/session-manager-pending-inject-wiring.test.ts`: new test that the recorded first message is the cleaned form: 18 pass.
- Also pass: `SessionManager-injection`, `paste-stuck-detection`, `session-injection-verify`, `session-manager-confined-reroute`, `session-manager-first-party-inject`, `session-manager-hotpath-helpers-async`, `session-manager-pending-inject-wiring`, `telegram-message-injection`, `resume-follows-account-dead-pane`, `session-watchdog-timed-sleep-and-notice`.

## Second-pass review

**Reviewer:** independent Claude reviewer subagent (two rounds). Round 1 raised two blocking items: the A2A live-session typing path in `server.ts` was not cleaned, and the queued first-message record kept the raw text while the match compared the cleaned text. Both are fixed here. Round 2 verdict: concur, no blocking items.

Non-blocking notes from round 2, carried forward:
- The provider adapters' input-injection helpers type raw text but have no live delivery caller today; routing them through `sanitizeTypedText` is a follow-up so wiring them later cannot reopen this.
- The A2A path still types multi-line and tab text key by key with no bracketed paste. Converging it with `rawInject`'s paste logic is a follow-up.
- `injectMessage` rewrites text before `rawInject` (existed before this change).

