# Lane L — outbound grounding guard coverage measurement

Measured 2026-08-23 UTC on branch `echo/w24-lane-l`, base/HEAD
`8e5b0d2c187cb52ddc9fed5fadff820f0ca30b03`. No Telegram request was made: all
dynamic measurements invoked the deployed PreToolUse hook as a classifier and did
not execute the prospective shell command. Topic `29723` was never used; inert
prospective commands named nonexistent test topic `999999`.

## Result

The bypass is real. The deployed guard refused a plain prospective
`telegram-reply.sh` command and allowed a base64 prospective command representing
the identical 39 message bytes. The guard checks the shell command string, not the
message that the relay ultimately decodes and sends. Its honest effectiveness is
therefore **partial coverage**, not “checks outbound messages.”

## Q1 — paired reproduction

At `2026-08-23T07:20:59.032164Z` I invoked the live deployed
`.instar/hooks/instar/grounding-before-messaging.sh` with a prospective plain relay
command containing a harmless 39-byte capability-claim fixture. The hook exited
`2` and reported one `CAPABILITY` issue. Control that could have disconfirmed the
refusal: exit `0`, or exit `2` caused by a different category.

At `2026-08-23T07:20:59.062390Z` I invoked the same hook with a prospective
`--stdin-base64` relay command. It exited `0` and printed `GROUNDED`. The decoded
message on both arms was 39 bytes with SHA-256
`0734b9bc379a1a5176dd73ac907ff7725231f9e8d007b76196ff7ffed74d996d`.
Control that could have disconfirmed the bypass: the encoded arm exiting `2` with
the same `CAPABILITY` issue.

The first attempted harness run at `2026-08-23T07:20:42Z` is excluded: macOS
lacked a `timeout` executable, so both arms exited `127` before reaching the hook.
The valid run used Python `subprocess.run(..., timeout=8)`.

The base64 path is designed, not adversarial. At source-inspection timestamp
`2026-08-23T07:21:55Z`, `src/templates/scripts/telegram-reply.sh:17,24-26,109-112`
documented and parsed `--stdin-base64`; lines `197-220` read and decoded the body.
Generated instructions recommend it at `src/scaffold/templates.ts:1745` and
`src/core/IdentityRenderer.ts:258-259`. Control: absence of the flag from the
script or instructions would have shown an unsupported route; both were present.

## Q2 — actual coverage boundary

The classifier matrix below was measured at `2026-08-23T07:21:38.251044Z` against
the deployed hook, with an 8-second timeout per case. “Checked/refused” means exit
`2` with `CAPABILITY`; “entered/allowed” means `GROUNDED` plus exit `0`; “not
entered” means exit `0` without `GROUNDED`.

| Send path / prospective input | Coverage | Measurement |
|---|---|---|
| relay argv with plain text | Checked/refused | exit 2, `CAPABILITY` |
| plain text piped to relay | Checked/refused | exit 2, `CAPABILITY` |
| plain heredoc piped to relay | Checked/refused | exit 2, `CAPABILITY` |
| base64 piped to relay `--stdin-base64` | Entered; message unchecked/allowed | exit 0, `GROUNDED` |
| raw shell POST to `/telegram/reply` with plain JSON | Checked/refused | exit 2, `CAPABILITY` |
| base64 shell decode piped into the same raw POST | Entered; message unchecked/allowed | exit 0, `GROUNDED` |
| shell command with fixture text but no recognized messaging token | Not entered | exit 0, no `GROUNDED` |
| MCP-shaped `send_message` payload with text but no `command`/`cmd` | Message unchecked | exit 0, no `GROUNDED` |
| in-process server/adapter send (`fetch`, `sendMessage`) | Unchecked by this guard | source boundary; no shell command to inspect |

The mechanism explains the rows. The deployed hook reads only `$1` or
`tool_input.command`/`tool_input.cmd`, recognizes messaging tokens in that command,
then pipes the **full command** to `convergence-check.sh`. The branch template has
the same command-wide behavior at
`src/templates/hooks/grounding-before-messaging.sh:17-20,35-40`.

Framework wiring is bounded by tool shape. Claude installs this guard only in the
Bash matcher (`src/core/instarSettingsHooks.ts:47-60`); its MCP matcher contains
only `external-operation-gate.js` (`:105-116`). Codex wires the guard on `.*`, but
the guard still extracts only `command`/`cmd` (`src/core/installCodexHooks.ts:93-100`).
The server also has direct `/telegram/reply` and in-process send funnels (for
example `src/server/routes.ts:15316-15338` and `sendMessage`/`fetch` callsites in
`src/monitoring`, `src/commands/server.ts`, and `src/core/TelegramRelay.ts`); this
PreToolUse shell-command guard cannot observe their message bodies.

Absence-search control: at `2026-08-23T07:21:38Z`,
`rg -n "convergence-check\\.sh"` found the known positive at
`src/templates/hooks/grounding-before-messaging.sh:36,40`. The identical query over
`src/templates/scripts/telegram-reply.sh`, `src/server/routes.ts`, and
`src/messaging/TelegramAdapter.ts` returned no matches. Control that would have
disproved the boundary: a convergence-check call in the relay, route, or adapter;
none was found.

## Q3 — withheld diagnostic information

Confirmed, with precision: the hook has the whole command in `INPUT` and the
checker has it in `CONTENT`, so the matched bytes are available at decision time.
The `grep -q` predicates retain only a boolean, and the refusal emits only a
category plus generic guidance. It neither captures nor prints the matched
substring. Source inspected at `2026-08-23T07:21:55Z`:
`src/templates/hooks/grounding-before-messaging.sh:40-51` forwards category output,
while `.instar/scripts/convergence-check.sh` uses `grep -qiE` without emitting a
match token. Control: a `grep -o` capture or refusal field naming the token would
have disconfirmed this; neither exists.

The self-probing failure is also confirmed. At approximately
`2026-08-23T07:21:20Z`, a read-only command that printed the prospective relay
command and piped it into `grep -E` was blocked by the outer PreToolUse hook before
`grep` ran. Its refusal again named only `CAPABILITY`. Control: any grep output
would have proved execution; there was none, and the tool reported “Command blocked
by PreToolUse hook.” An agent must therefore inspect source piecemeal or encode an
inert fixture merely to diagnose the classifier.

## Q4 — bounded fix assessment

Two fixes must not be conflated:

1. **Diagnostic fix (bounded):** capture and name a short escaped matched substring
   in each refusal. This fixes blind iteration, but not coverage.
2. **Coverage fix (bounded at the Telegram relay, not globally):** after
   `telegram-reply.sh` has assembled and base64-decoded `MSG` (after line 220), run
   the checker on `MSG` before preflight/network I/O. That preserves the documented
   base64 capability and makes all sanctioned relay forms converge on decoded
   bytes. Template, migration-parity, and unit/integration/E2E coverage are required
   before calling it fixed. Direct server/adapter/MCP sends remain outside it; a
   truthful global claim requires a shared server-side/send-funnel enforcement
   point and is larger than a bounded lane fix.

No guard behavior changed in this lane. This preserves the measurement-first
constraint and avoids turning a measured defect into an untested production claim.

## Effectiveness ledger

| Scope | Effective? | Meaning |
|---|---:|---|
| Plain recognized shell sends | `true` | Paired control refused known-bad plaintext. |
| Documented base64 relay sends | `false` | Same decoded bytes passed. |
| Non-shell/direct send funnels | `false` for this guard | They supply no shell command body. |
| Branch overall outbound coverage | `false` | No behavior change; source retains the boundary. |
| Deployed overall outbound coverage | `false` | Live hook reproduced bypass; nothing was deployed/restarted. |

“False” means the broad coverage claim is false, not that the guard catches
nothing. No result is `unmeasured`, and no result is labeled `fixed`.
