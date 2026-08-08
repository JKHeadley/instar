FEASIBLE-WITH-CHANGES - the convergence decision can be moved into TypeScript-owned code, but not by relying on the existing server outbound route alone: the current hook is an external PreToolUse command that fires before Bash runs and outside the server process.

# Grounding

Tree provenance control:

- `git log -1 --format='%h %ci'` returned `2197591 2026-08-05 02:19:20 +0000`.
- `grep -rl CrashLoopPauser src | wc -l` returned `4`, so the required control is positive.

# 1. What Decision It Actually Makes

There are two decisions in the target pair.

`grounding-before-messaging.sh` first decides whether the pending Bash tool input looks like outbound messaging. Its trigger regex is:

```regex
(telegram-reply|send-email|send-message|POST.*/telegram/reply|POST.*/message|/reply)
```

Source: `src/templates/hooks/grounding-before-messaging.sh:17-20`.

If that trigger does not match, the hook exits 0 with no output. If it matches, it:

- prints `.instar/AGENT.md` as "PRE-MESSAGE GROUNDING" when present (`src/templates/hooks/grounding-before-messaging.sh:21-33`);
- runs `.instar/scripts/convergence-check.sh` over the full tool input (`src/templates/hooks/grounding-before-messaging.sh:35-41`);
- if the check exits nonzero, writes the check output to stderr and exits `2`, which is the blocking path (`src/templates/hooks/grounding-before-messaging.sh:43-52`);
- otherwise prints `=== GROUNDED - Proceed with message. ===` (`src/templates/hooks/grounding-before-messaging.sh:56`).

`convergence-check.sh` reads stdin into `CONTENT`, accumulates issue strings, and exits `1` when `ISSUE_COUNT > 0`, otherwise `0` (`src/templates/scripts/convergence-check.sh:22-24`, `src/templates/scripts/convergence-check.sh:224-237`). The header says "7 criteria" (`src/templates/scripts/convergence-check.sh:9-17`), but the actual script has 8 blocking checks plus 1 signal-only check.

Blocking patterns:

1. `CAPABILITY`: blocks limitation claims such as "unfortunately I can't", "I'm unable", "not possible/available/supported", "I don't have access/a way", and "this is not possible/available/supported". Regex: `src/templates/scripts/convergence-check.sh:27`; block text: `src/templates/scripts/convergence-check.sh:28`.

2. `COMMITMENT`: blocks durable promises such as "I'll make sure/ensure/guarantee/always/never forget", "I promise", "I commit to", "I will always", "you can count on me to", "I'll remember to/this", and "from now on I'll". Regex: `src/templates/scripts/convergence-check.sh:36`; block text: `src/templates/scripts/convergence-check.sh:37`.

3. `SETTLING`: blocks empty-result acceptance such as "no data/results/information available/found/exists", "nothing to report/happened/was found", "there is/are no", "couldn't/could not find any/the", "appears to be empty", and "no relevant/matching/applicable". Regex: `src/templates/scripts/convergence-check.sh:42`; block text: `src/templates/scripts/convergence-check.sh:43`.

4. `EXPERIENTIAL`: blocks first-person experiential claims such as "I can see/noticed/observed/felt/sensed/perceived", "looking at this/the/your", "from what I've seen/read/observed", and "I've reviewed/examined/analyzed/inspected the/your/this". Regex: `src/templates/scripts/convergence-check.sh:48`; block text: `src/templates/scripts/convergence-check.sh:49`.

5. `SYCOPHANCY`: blocks reflexive agreement/apology phrasing such as "you're absolutely/totally/completely right", "I completely/totally/fully agree/understand", "great question/point/observation", "I apologize for", "sorry ... mistake/confusion/error/oversight", and "excellent/great/wonderful/fantastic point/question/idea/suggestion". Regex: `src/templates/scripts/convergence-check.sh:54`; block text: `src/templates/scripts/convergence-check.sh:55`.

6. `URL_PROVENANCE`: extracts URLs with `https?://[^ )"'>]+`, parses their host, and blocks URLs whose domains are not familiar. Extraction: `src/templates/scripts/convergence-check.sh:63`. Own configured tunnel host and parent-domain trust: `src/templates/scripts/convergence-check.sh:69-103`, `src/templates/scripts/convergence-check.sh:117-129`. Cloudflare quick tunnel trust: `src/templates/scripts/convergence-check.sh:130-133`. Static allowlist: `src/templates/scripts/convergence-check.sh:134-137`. Unknown URL accumulation and block text: `src/templates/scripts/convergence-check.sh:138-143`.

7. `TEMPORAL`: blocks stale-perspective phrasing such as "I used to think/believe/feel/assume", "back when I first/started/was new", "at that/the time I", "my early/earlier/initial/original/first understanding/thinking/view/perspective/approach", "I didn't yet understand", "before I learned/realized/discovered/knew", "I once/previously thought/believed/felt", and "this was before/when I". Regex: `src/templates/scripts/convergence-check.sh:150`; block text: `src/templates/scripts/convergence-check.sh:151`.

8. `SPEC_REVIEW_LINK`: blocks spec handoffs with no rendered `/view/<hex-or-uuid-ish>` link. It first detects a spec handoff when content references `docs/specs/...md`, or a GitHub PR URL plus the word `spec`/`specs`/`specification` (`src/templates/scripts/convergence-check.sh:162-167`). It then requires review/approval handoff language and absence of `/view/[0-9a-f-]{8,}` before adding the issue (`src/templates/scripts/convergence-check.sh:168-172`).

Signal-only pattern:

9. `time-awareness`: when the text asserts a session/run is done/over/complete/finished/wrapping up, the script scans `.instar/autonomous/*.local.md`; if an active time-box has more than 10% remaining, it appends `logs/time-awareness-signals.jsonl` and writes a stderr signal. It does not increment `ISSUE_COUNT`, so it does not block. Trigger regex and active-record scan: `src/templates/scripts/convergence-check.sh:183-214`. Log/stderr signal: `src/templates/scripts/convergence-check.sh:215-221`. Tests assert exit 0 on this path: `tests/unit/convergence-check-time-awareness.test.ts:73-84`.

# 2. TypeScript-Side Equivalent Surface

Outbound Telegram replies already flow through a TypeScript server route:

- `POST /messaging/preflight` is the inform-only deterministic preflight used by `telegram-reply.sh`; it validates `text`, resolves `messageKind`, runs `composeAdvisories` or `composeTimeClaimAdvisories`, writes the advisory audit, and returns `{ advisories }` (`src/server/routes.ts:14769-14858`).
- `telegram-reply.sh` calls that preflight before delivery for non-script senders, then withholds the send with a `NOT SENT - advisory...` message when advisories exist and no `--ack-advisory` is present (`src/templates/scripts/telegram-reply.sh:276-379`).
- `POST /telegram/reply/:topicId` validates `text`, length, metadata, dedup headers, system-template bypass, and sender metadata (`src/server/routes.ts:14867-14974`).
- That route calls `checkOutboundMessage(...)` before `ctx.telegram.sendToTopic(...)`, except for proxy/system/relay cases (`src/server/routes.ts:15039-15064`, `src/server/routes.ts:15080-15112`).
- `checkOutboundMessage` is the route adapter; it fires observe-only observers and delegates the decision to `evaluateOutbound` (`src/server/routes.ts:3151-3204`).
- `evaluateOutbound` is the res-free outbound decision chokepoint. It hard-blocks localhost links (`src/server/routes.ts:2531-2602`), hard-blocks outbound credentials (`src/server/routes.ts:2604-2627`), collects deterministic signals (`src/server/routes.ts:2631-2817`), calls `ctx.messagingToneGate.review(...)` (`src/server/routes.ts:2921-2934`), and maps the result to pass, advisory 422, or blocked 422 (`src/server/routes.ts:2991-3144`).
- `MessagingToneGate` is the TS class for the LLM-backed outbound gate (`src/core/MessagingToneGate.ts:1-18`, `src/core/MessagingToneGate.ts:1054-1074`).
- Existing deterministic signal detectors already live in TypeScript for B1-B7-style artifacts, explicitly as signal producers, not blockers (`src/core/GateSignalDetectors.ts:1-24`, `src/core/GateSignalDetectors.ts:27-57`, `src/core/GateSignalDetectors.ts:146-230`, `src/core/GateSignalDetectors.ts:233-258`).
- Existing advisory composition for automated outbound sends lives in `src/messaging/OutboundAdvisory.ts`; it is pure, deterministic, and non-blocking (`src/messaging/OutboundAdvisory.ts:1-19`, `src/messaging/OutboundAdvisory.ts:52-77`, `src/messaging/OutboundAdvisory.ts:92-178`).

The concrete existing function/file closest to the server send decision is `evaluateOutbound` inside `src/server/routes.ts:2531`. But the convergence hook should not be moved only there, because it currently gates before the Bash command executes. The concrete TS-owned home I would choose is a new pure module, e.g. `src/messaging/PreMessageConvergenceGate.ts`, exporting something like:

```ts
evaluatePreMessageConvergence(input: string, opts: { projectDir: string; now?: Date }): {
  issues: Array<{ code: string; message: string }>;
  signals: Array<{ code: string; message: string }>;
}
```

Then a generated hook-executable JS wrapper would call that module and preserve the current stderr/exit-2 contract. Some detectors could later be shared with `OutboundAdvisory` or `MessagingToneGate`, but this hook's authority surface is distinct from the server route.

# 3. Thin Shell Shape

If the decision logic is moved into a hook-executable Node/compiled-JS wrapper, `grounding-before-messaging.sh` can be reduced to input forwarding only:

```bash
#!/bin/bash
set -euo pipefail

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$PWD}"
HOOK_JS="$PROJECT_DIR/.instar/hooks/instar/grounding-before-messaging.js"

if [ "$#" -gt 0 ]; then
  printf '%s' "$1" | node "$HOOK_JS"
else
  node "$HOOK_JS"
fi
```

That shim makes no messaging/convergence decision. The JS wrapper would parse either Claude-style argv content or Codex stdin JSON, print identity/context, invoke the TS-owned convergence function, write block reasons to stderr, and exit `2` on blocking findings.

Even thinner: update hook registration to call `node .../grounding-before-messaging.js` directly and delete the shell shim. Existing source already uses node hook commands for nearby PreToolUse hooks (`src/core/instarSettingsHooks.ts:57-75`; `src/core/installCodexHooks.ts:65-73`, `src/core/installCodexHooks.ts:99-101`).

# 4. What Breaks / Critical Context Question

The migration is not feasible if "move into TypeScript" means "put this in the existing server outbound route and remove the PreToolUse hook decision."

Reason: the hook fires as an external command before the Bash tool is allowed to run. The Claude settings template registers `bash .instar/hooks/instar/grounding-before-messaging.sh "$TOOL_INPUT"` as a blocking PreToolUse Bash hook (`src/templates/hooks/settings-template.json:25-38`). The shared Claude settings source also registers it as a Bash PreToolUse command, although currently with `blocking: false`, which conflicts with the "blocks via exit 2" premise and should be reconciled (`src/core/instarSettingsHooks.ts:46-56`). Codex's installer likewise registers it as an external PreToolUse hook, reading the hook event from stdin rather than running inside the server (`src/core/installCodexHooks.ts:23-27`, `src/core/installCodexHooks.ts:85-101`).

The server TS path executes later, only after `telegram-reply.sh` has started and posts to localhost. The script builds and sends `POST http://localhost:${PORT}/telegram/reply/${TOPIC_ID}` at `src/templates/scripts/telegram-reply.sh:488-503`. The route then gates and eventually sends with `ctx.telegram.sendToTopic` (`src/server/routes.ts:15047-15112`). A server-only migration would miss:

- all hook-triggered command forms that never call `/telegram/reply`, such as `send-email`, `send-message`, raw `POST .../message`, and broad `/reply` matches (`src/templates/hooks/grounding-before-messaging.sh:19-20`);
- the before-tool identity injection (`src/templates/hooks/grounding-before-messaging.sh:24-33`);
- the ability to stop the Bash command before it executes via PreToolUse exit `2` (`src/templates/hooks/grounding-before-messaging.sh:43-52`);
- any server-down or wrong-port case where no TS route is reachable, because the current shell check is local-file based.

The hook does run outside the server process. That does not mean TS ownership is impossible, because Node hook commands already exist and are installed (`src/core/instarSettingsHooks.ts:57-75`; `src/core/installCodexHooks.ts:65-73`). It means the migration must produce a hook-executable artifact from TS-owned source, or deliberately use an HTTP endpoint and accept a changed fail posture. Raw in-process TS functions are not available to the PreToolUse hook unless compiled/bundled into a local JS entrypoint or invoked through a runtime such as `tsx` that installed agents can rely on.

Additional source drift to fix if migrating:

- `src/templates/hooks/grounding-before-messaging.sh` reads only `$1` (`src/templates/hooks/grounding-before-messaging.sh:17`), but the PostUpdateMigrator embedded copy already has Codex stdin JSON parsing (`src/core/PostUpdateMigrator.ts:12679-12691`). A single TS source would eliminate that drift.
- The checked-out `.claude/settings.json` in this worktree does not currently include `grounding-before-messaging.sh`; it has only AskUserQuestion, MCP, Write/Edit/MultiEdit, session, event, and permission hooks (`.claude/settings.json:3-37`, `.claude/settings.json:70-91`, `.claude/settings.json:200-210`). The installation templates/sources do include it, so absence in this worktree should be treated as local registration drift, not absence from the product.

# 5. Cost Estimate

Verdict cost: medium, mostly because hook-runtime semantics and generated-template drift matter more than the regex port itself.

Likely files touched:

- Add `src/messaging/PreMessageConvergenceGate.ts` or equivalent pure TS module.
- Add or replace a hook executable template, likely `src/templates/hooks/grounding-before-messaging.js`, or keep `src/templates/hooks/grounding-before-messaging.sh` as the no-decision shim above.
- Reduce or remove `src/templates/scripts/convergence-check.sh`, or leave it as a compatibility shim that invokes the compiled JS evaluator.
- Update `src/core/PostUpdateMigrator.ts` embedded hook/script generation and migration SHA/overwrite behavior.
- Update `src/commands/init.ts` installation paths if script names change.
- Update `src/core/instarSettingsHooks.ts`, `src/templates/hooks/settings-template.json`, and `src/core/installCodexHooks.ts` if the hook command changes from Bash to Node.
- Update manifest generation/tests if built-in hook/script inventory changes.
- Replace shell-level tests with TS unit tests plus wrapper contract tests: current coverage directly executes the shell templates (`tests/unit/convergence-check.test.ts:27-45`, `tests/unit/convergence-check-sibling-trust.test.ts:23-40`, `tests/unit/convergence-check-time-awareness.test.ts:21-41`, `tests/unit/grounding-hook-block-stderr.test.ts:23-42`).

Risk:

- High if the logic is moved only into `evaluateOutbound`/`MessagingToneGate`: it loses PreToolUse coverage and is a behavioral regression.
- Medium if implemented as TS-owned, hook-executable JS: regex parity, URL allowlist parity, filesystem config parsing, time-awareness logging, stdout/stderr, and exit-code behavior all need parity tests.
- Low-to-medium for the steady state after migration: a single TS-owned evaluator should reduce drift between `src/templates`, `PostUpdateMigrator`, init, and Codex/Claude hook contracts.
