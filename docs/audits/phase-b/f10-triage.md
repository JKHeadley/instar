Verified count: 26 `.sh`/`.js`/`.mjs` files under `src/templates/`. Coverage claim: false as written; multiple `scripts/lint-*.js` files traverse `src/templates`, while the requested `tests/unit/*ratchet*.ts` set has zero direct template-decision ratchets by controlled search. Split for the 12 genuine decision surfaces: MUST-BE-SHELL 0, INCIDENTALLY-SHELL 12, UNKNOWN 0.

# Phase B Census: Template Decision Surfaces

## Controls

- Tree provenance: `git log -1 --format='%h %ci'` returned `2197591 2026-08-05 02:19:20 +0000`.
- Required control: `grep -rl CrashLoopPauser src | wc -l` returned `4`, so this is the expected lineage.
- Denominator command: `find src/templates -type f \( -name '*.sh' -o -name '*.js' -o -name '*.mjs' \) -print | sort | wc -l` returned `26`.
- Ratchet-glob control: `find tests/unit -maxdepth 1 -type f -iname '*ratchet*.ts' -print | wc -l` returned `18`; the same glob was then searched for template references.
- Known-lint control: `rg -n "lint-no-unfunneled-topic-creation|SCAN_DIRS|EXTENSIONS" scripts/lint-no-unfunneled-topic-creation.js` returned hits at `scripts/lint-no-unfunneled-topic-creation.js:3`, `scripts/lint-no-unfunneled-topic-creation.js:55`, and `scripts/lint-no-unfunneled-topic-creation.js:56`.

## Denominator

The 26 files are:

- `src/templates/hooks/build-stop-hook.sh`
- `src/templates/hooks/compaction-recovery.sh`
- `src/templates/hooks/dangerous-command-guard.sh`
- `src/templates/hooks/free-text-guard.sh`
- `src/templates/hooks/grounding-before-messaging.sh`
- `src/templates/hooks/intercept-imsg-send.js`
- `src/templates/hooks/model-tier-reconciler.js`
- `src/templates/hooks/model-tier-skill-entry.sh`
- `src/templates/hooks/session-start.sh`
- `src/templates/hooks/skill-usage-telemetry.sh`
- `src/templates/hooks/slack-channel-context.sh`
- `src/templates/hooks/telegram-topic-context.sh`
- `src/templates/scripts/convergence-check.sh`
- `src/templates/scripts/emit-session-clock.sh`
- `src/templates/scripts/git-sync-gate.sh`
- `src/templates/scripts/health-watchdog.sh`
- `src/templates/scripts/imessage-reply.sh`
- `src/templates/scripts/instar-watchdog.sh`
- `src/templates/scripts/instar-worktree-create.sh`
- `src/templates/scripts/load-assess.sh`
- `src/templates/scripts/secret-drop-retrieve.mjs`
- `src/templates/scripts/secret-get.mjs`
- `src/templates/scripts/serendipity-capture.sh`
- `src/templates/scripts/slack-reply.sh`
- `src/templates/scripts/telegram-reply.sh`
- `src/templates/scripts/whatsapp-reply.sh`

## Coverage Claim

The requested ratchet subset was checked with a controlled search. The glob contained 18 files, and the template-decision search over those files returned zero direct `src/templates` / `templates/hooks` / `templates/scripts` ratchets. The returned extension/import mentions were unrelated examples such as `tests/unit/standards-coverage-ratchet.test.ts:22` and `tests/unit/llm-attribution-ratchet.test.ts:23`.

The broader claim that zero lints cover these files is false:

- `package.json:31` wires the main lint chain.
- `scripts/lint-no-direct-destructive.js` says it AST-walks `.ts/.tsx/.js/.mjs/.cjs` in `src/`, `tests/`, and `scripts`, and greps `.sh` files for destructive git verbs (`scripts/lint-no-direct-destructive.js:16`-`scripts/lint-no-direct-destructive.js:21`). Its full scan includes `src` (`scripts/lint-no-direct-destructive.js:586`), `.js/.mjs` (`scripts/lint-no-direct-destructive.js:587`), shell files (`scripts/lint-no-direct-destructive.js:604`), and shell linting (`scripts/lint-no-direct-destructive.js:679`-`scripts/lint-no-direct-destructive.js:680`). Its allowlist names two template shell files, proving template files enter the lint path (`scripts/lint-no-direct-destructive.js:533`-`scripts/lint-no-direct-destructive.js:546`).
- `scripts/lint-no-unfunneled-topic-creation.js` scans `src`, `scripts`, and `templates` (`scripts/lint-no-unfunneled-topic-creation.js:55`), includes `.js/.mjs/.sh` (`scripts/lint-no-unfunneled-topic-creation.js:56`), walks those dirs (`scripts/lint-no-unfunneled-topic-creation.js:90`-`scripts/lint-no-unfunneled-topic-creation.js:93`), and filters explicit paths by those extensions (`scripts/lint-no-unfunneled-topic-creation.js:101`).
- `scripts/lint-no-unfunneled-headless-launch.js` scans `src`, `scripts`, and `templates` with `.js/.mjs/.sh` in scope (`scripts/lint-no-unfunneled-headless-launch.js:51`-`scripts/lint-no-unfunneled-headless-launch.js:52`) and walks them (`scripts/lint-no-unfunneled-headless-launch.js:71`-`scripts/lint-no-unfunneled-headless-launch.js:87`).
- `scripts/lint-no-unfunneled-credential-write.js` scans `src`, `scripts`, and `templates` (`scripts/lint-no-unfunneled-credential-write.js:66`) with `.js/.mjs/.sh` in scope (`scripts/lint-no-unfunneled-credential-write.js:67`) and walks them (`scripts/lint-no-unfunneled-credential-write.js:102`-`scripts/lint-no-unfunneled-credential-write.js:118`).
- `scripts/lint-no-unbounded-llm-spawn.js` scans `src`, `scripts`, and `templates` (`scripts/lint-no-unbounded-llm-spawn.js:63`) with `.js/.mjs` in scope (`scripts/lint-no-unbounded-llm-spawn.js:64`) and walks them (`scripts/lint-no-unbounded-llm-spawn.js:80`-`scripts/lint-no-unbounded-llm-spawn.js:96`).
- `scripts/lint-no-direct-llm-http.js` scans `.js/.mjs` in `src` (`scripts/lint-no-direct-llm-http.js:15`-`scripts/lint-no-direct-llm-http.js:17`, `scripts/lint-no-direct-llm-http.js:99`, `scripts/lint-no-direct-llm-http.js:117`), which includes `.js/.mjs` under `src/templates`.

These are generic chokepoint/hazard lints, not a dedicated inventory ratchet for template decision surfaces.

## Genuine Decision Surfaces

I count 12 genuine decision surfaces. The named twelve are numerically right only by accident: four named files are false positives, and four genuine blockers are absent from the named list.

| File | Decision it makes | Triage |
| --- | --- | --- |
| `src/templates/hooks/free-text-guard.sh` | Blocks `AskUserQuestion` when the question asks for free-text credentials/identity-like input and is not a multi-choice decision (`src/templates/hooks/free-text-guard.sh:33`-`src/templates/hooks/free-text-guard.sh:72`, `src/templates/hooks/free-text-guard.sh:78`-`src/templates/hooks/free-text-guard.sh:93`). | INCIDENTALLY-SHELL. Move JSON parsing and regex policy to TS/JS; keep a thin stdin-to-node hook command. |
| `src/templates/hooks/grounding-before-messaging.sh` | Blocks Bash messaging commands when `convergence-check.sh` returns issues (`src/templates/hooks/grounding-before-messaging.sh:19`-`src/templates/hooks/grounding-before-messaging.sh:20`, `src/templates/hooks/grounding-before-messaging.sh:36`-`src/templates/hooks/grounding-before-messaging.sh:52`). | INCIDENTALLY-SHELL. The command hook must remain reliable for blocking, but detection and convergence orchestration can be TS/JS. |
| `src/templates/hooks/dangerous-command-guard.sh` | Blocks catastrophic commands always, and risky commands at safety level 1 (`src/templates/hooks/dangerous-command-guard.sh:24`-`src/templates/hooks/dangerous-command-guard.sh:28`, `src/templates/hooks/dangerous-command-guard.sh:30`-`src/templates/hooks/dangerous-command-guard.sh:51`, `src/templates/hooks/dangerous-command-guard.sh:55`-`src/templates/hooks/dangerous-command-guard.sh:112`). | INCIDENTALLY-SHELL. Evidence supports command-hook blocking rather than HTTP (`docs/CLAUDE-CODE-FEATURE-INTEGRATION-AUDIT.md:160`-`docs/CLAUDE-CODE-FEATURE-INTEGRATION-AUDIT.md:165`), but I found zero evidence that the pattern/config logic itself cannot be TS/JS behind that command. |
| `src/templates/hooks/intercept-imsg-send.js` | Blocks direct `imsg send`, Messages AppleScript, and indirect iMessage send attempts from Bash (`src/templates/hooks/intercept-imsg-send.js:29`-`src/templates/hooks/intercept-imsg-send.js:36`, `src/templates/hooks/intercept-imsg-send.js:41`-`src/templates/hooks/intercept-imsg-send.js:64`). | INCIDENTALLY-JS/TS. Already JS; the regex/policy can become a TS module used by the hook command. |
| `src/templates/hooks/build-stop-hook.sh` | Blocks the owning session's Stop while a build is active and reinforcement budget remains; non-owner sessions and terminal phases are approved (`src/templates/hooks/build-stop-hook.sh:11`-`src/templates/hooks/build-stop-hook.sh:16`, `src/templates/hooks/build-stop-hook.sh:22`-`src/templates/hooks/build-stop-hook.sh:25`, `src/templates/hooks/build-stop-hook.sh:65`-`src/templates/hooks/build-stop-hook.sh:87`, `src/templates/hooks/build-stop-hook.sh:100`-`src/templates/hooks/build-stop-hook.sh:141`). | INCIDENTALLY-SHELL. State read, owner match, and reinforcement update can be TS/JS. Current settings show Stop routed through a Node command hook (`src/templates/hooks/settings-template.json:172`-`src/templates/hooks/settings-template.json:179`). |
| `src/templates/scripts/convergence-check.sh` | Exits non-zero to stop outbound messaging when heuristic quality issues are present (`src/templates/scripts/convergence-check.sh:1`-`src/templates/scripts/convergence-check.sh:7`, `src/templates/scripts/convergence-check.sh:26`-`src/templates/scripts/convergence-check.sh:57`, `src/templates/scripts/convergence-check.sh:155`-`src/templates/scripts/convergence-check.sh:172`, `src/templates/scripts/convergence-check.sh:224`-`src/templates/scripts/convergence-check.sh:235`). | INCIDENTALLY-SHELL. Regex checks and URL/config parsing can move to TS; this script can become a compatibility wrapper. |
| `src/templates/scripts/git-sync-gate.sh` | Stops/skips the git-sync job when repo/remote/sync-work preconditions are not met; otherwise proceeds and writes conflict severity (`src/templates/scripts/git-sync-gate.sh:5`-`src/templates/scripts/git-sync-gate.sh:7`, `src/templates/scripts/git-sync-gate.sh:18`-`src/templates/scripts/git-sync-gate.sh:25`, `src/templates/scripts/git-sync-gate.sh:50`-`src/templates/scripts/git-sync-gate.sh:53`, `src/templates/scripts/git-sync-gate.sh:55`-`src/templates/scripts/git-sync-gate.sh:84`). | INCIDENTALLY-SHELL. Scheduler gate and git-state/conflict classifier can move to TS and the safe git path. |
| `src/templates/scripts/imessage-reply.sh` | Refuses to send iMessage unless the server validates recipient/message and returns a single-use token (`src/templates/scripts/imessage-reply.sh:13`-`src/templates/scripts/imessage-reply.sh:19`, `src/templates/scripts/imessage-reply.sh:79`-`src/templates/scripts/imessage-reply.sh:112`, `src/templates/scripts/imessage-reply.sh:115`-`src/templates/scripts/imessage-reply.sh:120`). | INCIDENTALLY-SHELL, but session-local actuation is required. Server iMessage send is unsupported because AppleScript Automation permission does not propagate through LaunchAgent (`src/messaging/imessage/IMessageAdapter.ts:226`-`src/messaging/imessage/IMessageAdapter.ts:233`, `src/messaging/imessage/NativeBackend.ts:9`-`src/messaging/imessage/NativeBackend.ts:11`). The wrapper can still be a TS/JS session-local CLI. |
| `src/templates/scripts/telegram-reply.sh` | Refuses misplaced flag-shaped args after topic id, blocks live credential exposure, withholds tone-advisory sends until revise/ack, and blocks reasonless overrides/terminal tone denials (`src/templates/scripts/telegram-reply.sh:160`-`src/templates/scripts/telegram-reply.sh:192`, `src/templates/scripts/telegram-reply.sh:550`-`src/templates/scripts/telegram-reply.sh:570`, `src/templates/scripts/telegram-reply.sh:571`-`src/templates/scripts/telegram-reply.sh:584`). | INCIDENTALLY-SHELL. Flag-order validation and HTTP outcome classification can move to TS/JS. |
| `src/templates/scripts/slack-reply.sh` | Blocks Slack send on malformed delivery id, absent spawned-session binding, and server tone-gate denial; delivery-in-flight is treated as idempotent success (`src/templates/scripts/slack-reply.sh:97`-`src/templates/scripts/slack-reply.sh:117`, `src/templates/scripts/slack-reply.sh:171`-`src/templates/scripts/slack-reply.sh:189`, `src/templates/scripts/slack-reply.sh:190`-`src/templates/scripts/slack-reply.sh:199`). | INCIDENTALLY-SHELL. Message shaping, id validation, and HTTP status classification can move to TS/JS behind a CLI wrapper. |
| `src/templates/scripts/whatsapp-reply.sh` | Blocks WhatsApp send on server tone-gate denial; 408 is ambiguous and exits 0 (`src/templates/scripts/whatsapp-reply.sh:73`-`src/templates/scripts/whatsapp-reply.sh:82`, `src/templates/scripts/whatsapp-reply.sh:83`-`src/templates/scripts/whatsapp-reply.sh:92`). | INCIDENTALLY-SHELL. Decision is server-side; script can be a thin CLI wrapper. |
| `src/templates/scripts/serendipity-capture.sh` | Refuses capture when disabled, over rate limit, invalid input/patch, or potential secrets are present (`src/templates/scripts/serendipity-capture.sh:52`-`src/templates/scripts/serendipity-capture.sh:64`, `src/templates/scripts/serendipity-capture.sh:107`-`src/templates/scripts/serendipity-capture.sh:139`, `src/templates/scripts/serendipity-capture.sh:166`-`src/templates/scripts/serendipity-capture.sh:170`, `src/templates/scripts/serendipity-capture.sh:181`-`src/templates/scripts/serendipity-capture.sh:199`, `src/templates/scripts/serendipity-capture.sh:205`-`src/templates/scripts/serendipity-capture.sh:220`). | INCIDENTALLY-SHELL. Argument validation, rate limiting, patch validation, and secret scanning can move to TS/JS. |

## Named-List Corrections

Named files that are genuine blockers:

- `free-text-guard.sh`
- `grounding-before-messaging.sh`
- `dangerous-command-guard.sh`
- `intercept-imsg-send.js`
- `build-stop-hook.sh`
- `convergence-check.sh`
- `imessage-reply.sh`
- `serendipity-capture.sh`

Named false positives:

- `session-start.sh`: injects startup context and exits open if config/port/health are unavailable (`src/templates/hooks/session-start.sh:1`-`src/templates/hooks/session-start.sh:12`, `src/templates/hooks/session-start.sh:20`-`src/templates/hooks/session-start.sh:48`).
- `model-tier-reconciler.js`: explicitly says it "never blocks the turn" and exits 0 on missing prerequisites/failures (`src/templates/hooks/model-tier-reconciler.js:4`-`src/templates/hooks/model-tier-reconciler.js:10`, `src/templates/hooks/model-tier-reconciler.js:19`, `src/templates/hooks/model-tier-reconciler.js:135`-`src/templates/hooks/model-tier-reconciler.js:136`).
- `instar-watchdog.sh`: monitors, self-heals, and escalates failures; that is recovery/escalation, not refusal of a user/tool action (`src/templates/scripts/instar-watchdog.sh:6`-`src/templates/scripts/instar-watchdog.sh:15`, `src/templates/scripts/instar-watchdog.sh:133`-`src/templates/scripts/instar-watchdog.sh:179`, `src/templates/scripts/instar-watchdog.sh:338`-`src/templates/scripts/instar-watchdog.sh:390`).
- `emit-session-clock.sh`: explicitly says "Signal-only: pure stdout, never blocks" and exits 0 for unsupported modes (`src/templates/scripts/emit-session-clock.sh:2`-`src/templates/scripts/emit-session-clock.sh:4`, `src/templates/scripts/emit-session-clock.sh:40`-`src/templates/scripts/emit-session-clock.sh:77`).

Genuine blockers absent from the named list:

- `telegram-reply.sh`
- `slack-reply.sh`
- `whatsapp-reply.sh`
- `git-sync-gate.sh`

Boundary cases I did not count:

- `instar-worktree-create.sh`: fallback path is constrained to `$INSTAR_AGENT_HOME/.worktrees/$SLUG` and exits on usage/preconditions (`src/templates/scripts/instar-worktree-create.sh:6`-`src/templates/scripts/instar-worktree-create.sh:12`, `src/templates/scripts/instar-worktree-create.sh:50`-`src/templates/scripts/instar-worktree-create.sh:79`), but the shell fallback accepts zero alternate destination parameter to refuse.
- `secret-drop-retrieve.mjs`: exits non-zero on usage/HTTP/shape/missing-field errors and preserves secrets when a `--run` command fails (`src/templates/scripts/secret-drop-retrieve.mjs:42`-`src/templates/scripts/secret-drop-retrieve.mjs:45`, `src/templates/scripts/secret-drop-retrieve.mjs:115`-`src/templates/scripts/secret-drop-retrieve.mjs:159`, `src/templates/scripts/secret-drop-retrieve.mjs:178`-`src/templates/scripts/secret-drop-retrieve.mjs:198`). I treat that as secret-handoff error/consume semantics, not an enforcement block of an attempted external action.
- `secret-get.mjs`: emits zero secret bytes on errors (`src/templates/scripts/secret-get.mjs:34`-`src/templates/scripts/secret-get.mjs:38`, `src/templates/scripts/secret-get.mjs:91`-`src/templates/scripts/secret-get.mjs:105`, `src/templates/scripts/secret-get.mjs:129`-`src/templates/scripts/secret-get.mjs:143`), but this is retrieval failure/containment behavior, not a policy block.

## Other Non-Blocking Template Files

- `src/templates/hooks/compaction-recovery.sh`: context injection after compaction (`src/templates/hooks/compaction-recovery.sh:1`-`src/templates/hooks/compaction-recovery.sh:14`, `src/templates/hooks/compaction-recovery.sh:460`-`src/templates/hooks/compaction-recovery.sh:493`).
- `src/templates/hooks/model-tier-skill-entry.sh`: signal writer for model-tier escalation, fail-closed by exiting 0 (`src/templates/hooks/model-tier-skill-entry.sh:4`-`src/templates/hooks/model-tier-skill-entry.sh:12`, `src/templates/hooks/model-tier-skill-entry.sh:16`-`src/templates/hooks/model-tier-skill-entry.sh:23`, `src/templates/hooks/model-tier-skill-entry.sh:45`-`src/templates/hooks/model-tier-skill-entry.sh:50`).
- `src/templates/hooks/skill-usage-telemetry.sh`: appends telemetry for skill invocations (`src/templates/hooks/skill-usage-telemetry.sh:1`-`src/templates/hooks/skill-usage-telemetry.sh:10`, `src/templates/hooks/skill-usage-telemetry.sh:39`-`src/templates/hooks/skill-usage-telemetry.sh:43`).
- `src/templates/hooks/slack-channel-context.sh`: injects Slack context and exits open when prefix/server conditions are absent (`src/templates/hooks/slack-channel-context.sh:1`-`src/templates/hooks/slack-channel-context.sh:9`, `src/templates/hooks/slack-channel-context.sh:16`-`src/templates/hooks/slack-channel-context.sh:21`, `src/templates/hooks/slack-channel-context.sh:48`-`src/templates/hooks/slack-channel-context.sh:58`).
- `src/templates/hooks/telegram-topic-context.sh`: injects Telegram topic context and exits open when prefix/config/server conditions are absent (`src/templates/hooks/telegram-topic-context.sh:1`-`src/templates/hooks/telegram-topic-context.sh:14`, `src/templates/hooks/telegram-topic-context.sh:34`-`src/templates/hooks/telegram-topic-context.sh:55`, `src/templates/hooks/telegram-topic-context.sh:85`-`src/templates/hooks/telegram-topic-context.sh:99`).
- `src/templates/scripts/health-watchdog.sh`: recovery script for server health, exits non-zero only when required tooling is unavailable (`src/templates/scripts/health-watchdog.sh:1`-`src/templates/scripts/health-watchdog.sh:7`, `src/templates/scripts/health-watchdog.sh:20`-`src/templates/scripts/health-watchdog.sh:23`, `src/templates/scripts/health-watchdog.sh:42`-`src/templates/scripts/health-watchdog.sh:63`).
- `src/templates/scripts/load-assess.sh`: diagnostic verdict, exits 0 (`src/templates/scripts/load-assess.sh:1`-`src/templates/scripts/load-assess.sh:25`, `src/templates/scripts/load-assess.sh:86`-`src/templates/scripts/load-assess.sh:113`).

## Bottom Line

The audit claim is overstated. The denominator is correct at 26 files. I also count 12 genuine blocking/scheduling decision surfaces, but not the named twelve: `session-start.sh`, `model-tier-reconciler.js`, `instar-watchdog.sh`, and `emit-session-clock.sh` are false positives, while `telegram-reply.sh`, `slack-reply.sh`, `whatsapp-reply.sh`, and `git-sync-gate.sh` are missing from the named set. The zero-coverage claim is false because multiple repo lints traverse `src/templates` and include `.sh`/`.js`/`.mjs`, although the `tests/unit/*ratchet*.ts` subset lacks a dedicated template-decision ratchet by controlled search.
