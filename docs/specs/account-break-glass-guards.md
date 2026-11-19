---
title: "Account break-glass guards: exhaust the way in before spending last-resort access"
slug: "account-break-glass-guards"
author: "echo"
status: draft
created: 2026-11-11
eli16-overview: "docs/specs/account-break-glass-guards.eli16.md"
---

# Account break-glass guards

## Problem statement

Between 2026-11-07 and 11-11, one agent (Echo) made a run of mistakes on the operator's npm account:
- It spent a stored recovery code after a 300-character page read missed the suspension warning. npm held the account for 72 hours.
- It left the resulting signed-in session without adding a working second factor.
- It asked the operator to do the task by hand.
- It then failed with the saved virtual security key, because it never read the key's own stored notes. Those notes said to set the signature counter to the current unix time.

Reading the notes made the key work on the first try. The operator asked (topic 130715, 2026-11-11 21:25 PST) how to make sure this class of mistake does not happen again for any instar agent. The lesson is P25 in `docs/INSTAR-DESIGN-PRINCIPLES-AND-LESSONS.md`.

## What already ships (PR #2944, 2026-11-08)

- `account-page-safety.js`, a preflight in the macOS normal-Chrome wrapper (`chrome-js.sh`). It reads the full page, raises an `account-action-review` on recovery-code or hold language, and needs `--reviewed-page <fingerprint>` before caller code runs.
- The "Account actions: read before acting" rules (`src/data/accountActionSafety.ts`) in every agent's CLAUDE.md and browser skill.

- On Echo only (not shipped): a custom PreToolUse hook, `.instar/hooks/custom/lockout-guard.cjs` (2026-11-07), blocks a Bash command that both names recovery or backup codes and reaches a credential reader or browser driver. It blocks by word match, so on 2026-11-11 it also blocked a docs commit whose message named recovery codes. This spec does not ship it to the fleet: word-matching command text is the pattern-as-authority shape the Standards gate rejected in round 0. Once guard 1 lands, Echo's copy can be retired.

The 11-11 npm work ran through a hand-written Playwright script, so the preflight never ran.

## Threat model (what this spec does and does not do)

This spec guards against a **confused or careless agent**: one that would follow a warning if the warning reached it. Every 11-11 failure was of that kind (a cut page read, unread notes, a wrong route chosen).

It does **not** contain an agent that is trying to get around it. Such an agent can post the code with `fetch` or curl, run its own JavaScript in the page, or edit its own config. Round 2 of review showed that real authority needs the code kept out of agent-readable stores and released only by a server-performed fill. That is a different, larger design, recorded below as follow-up F-A. The guards here are friction on the accidental paths, and the spec does not call them authority.

## Proposed design

### Guard 1. The page holds a recovery-code submit and says what it costs

- **Detector:** a form is about to be submitted that contains a **non-empty** input whose own label, name, placeholder or `autocomplete` value names a recovery or backup code. A heading or URL alone does not trigger it, so security-settings pages and factor pickers are not held (round-2 finding: heading matches would hold ordinary pages).
- **Hold points:** a new self-executing init script, `account-submit-hold.js` (the existing `account-page-safety.js` is a function the wrapper calls with arguments, so it cannot be an init script). It listens on `window` in the capture phase for `submit` and for `click` on submit-type controls, and patches `HTMLFormElement.prototype.submit` and `requestSubmit`. When the form holds a filled recovery-code input, it asks first: `confirm()` is synchronous, so the answer is known inside the capture handler. On dismissal it calls `stopImmediatePropagation()` and `preventDefault()`, so no site handler sees the event and the site sends no request. On acceptance it does nothing further, and the original event carries on with the site's own handlers, validation and submitter; nothing is replayed. The patched `submit()` and `requestSubmit()` ask the same way and call the original on acceptance. One action asks once: the accepted dispatch is marked only for its own nested chain (the click, and the `submit` event that click or `requestSubmit()` produces), and the mark is cleared when that dispatch returns. A second submission of the same form, even in the same task, asks again. `installBrowserScripts` writes the file on every OS.
- **What the agent sees:** a native `confirm()` dialog with the text: "instar: this looks like it submits a one-time recovery code to <origin>. Known cost: <cost from the shipped table, or 'unknown'>. Do this only if the operator approved this exact use. Check the credential's saved instructions first: a saved key or password may work." Dialogs are how the hold reaches every driver without a bearer token in the page:
  - Playwright MCP reports an open dialog as a modal state that must be handled before anything else happens.
  - On the launcher route the launcher owns the decision. It registers its own `page.on('dialog')` handler before handing the page to the caller's code. For a break-glass dialog (recognised by its fixed `instar:` prefix) it prints the text to stderr and decides at once. It dismisses, unless the caller called `allowBreakGlass({ origin, account, reason })` on the launcher beforehand, in which case it accepts. An allowance is single-use: the next break-glass dialog on that origin consumes it, accepted or not, and it is dropped when the page leaves the origin. The account must be one of the accounts the Profile Registry binds to the launched profile. That checks the profile, not the page. So the dialog also shows the account the page is signing in to when the page shows one (an email or username field, or a displayed account name). When it cannot tell, it says "account on this page: unknown" and the agent's reason must address it. Either way it records the outcome itself. Because it settles the dialog first, a caller's blanket `d.accept()` handler finds the dialog already settled and cannot accept it. Non-instar dialogs are left to the caller.
  - `chrome-js.sh` (normal Chrome through osascript) gets no init script. There, a real modal would hang the osascript call, so that route keeps only the PR 2944 preflight.
- **Release:** on the launcher route, `allowBreakGlass({ origin, account, reason })` before the submit. Under MCP, `browser_handle_dialog` with accept. Either way it is the agent's own judgment, made with the cost in front of it, and the reason it gives must name the operator's approval. No code is logged anywhere. The launcher records an `account-break-glass` audit event (origin, time, outcome, reason). On the MCP route the dialog text and the agent's answer are in the session transcript, which is the record.
- **Cost table:** `src/data/breakGlassCosts.ts`, keyed by origin. It starts with npm (72-hour publishing and token hold; npm changelog 2026-09-09, observed 2026-11-07). Unknown origins say "cost unknown".

### Guard 2. A credential's saved instructions travel with it

- **What counts as instructions:** a Bitwarden custom field named `instructions`. Never an item's `notes`: on a secure-note item (type 2) the notes are the secret value, and `BitwardenProvider.set()` writes the value into `notes` on any existing item, so login-item notes can hold a secret too. This spec also fixes `set()` to write `login.password` on a login item. In the local vault, a sibling key `<key>__instructions` (a dot would nest, per `secret-get.mjs`). The Bitwarden provider gains code to read custom fields, which it does not read today.
- **When it prints:** only when the item has instructions. Plain tokens with none (the auth token, most API keys) print nothing extra.
- **Notes pointer:** when a Bitwarden login item has non-empty `notes` and no `instructions` field, the reader prints one stderr line, without the notes themselves: "this item has notes that may hold usage instructions; read them with `bw get item <id>` and move any instructions into an `instructions` field". On 11-11 that line would have pointed at the counter instruction.
- **Migration of known items:** Echo moves the instructions on the npm item ("npmjs.com - jkheadley") into an `instructions` field, leaving the notes as they are. The incident reproduction test is listed under Testing.
- **How:** the reader writes the full text to a 0600 file under `.instar/state/credential-instructions/` and prints to stderr the path, byte count and the full text, wrapped as untrusted data (`<credential-instructions item="…" untrusted>…</credential-instructions>`), after `SecretRedactor`. Nothing is cut; the file holds the whole text even if stderr is dropped.
- **Not authority:** instructions are data and never stand in for an approval.
- **Readers covered:** `secret-get.mjs` (local vault, `<key>__instructions`) and `secret-drop-retrieve.mjs` (Secret Drop has no notes, so it prints nothing). For Bitwarden: `BitwardenProvider.get` only finds the agent's own scoped items and runs inside the server, so it cannot carry instructions to the agent. The 11-11 item was an operator login item read with plain `bw get item`. So this spec adds an agent-facing reader, `.instar/scripts/bw-item.mjs <name-or-id>`, which returns one field (`--field password|totp|username`) on stdout and prints the item's `instructions` field and the notes pointer on stderr. The browser skill and CLAUDE.md name it as the way to read an operator Bitwarden item. Plain `bw get item` stays possible and is not covered, which the spec states.

### Guard 3. The page safety script runs on every Playwright route

- **Playwright MCP:** `@playwright/mcp` reads `PLAYWRIGHT_MCP_INIT_SCRIPT` (documented in the README of 0.0.85, beside `--init-script`). Instar sets that variable, pointing at the agent's own copy of `account-submit-hold.js`, in the environment of every session it spawns. That covers the Claude Code entries (`~/.claude.json`, `.mcp.json`) and survives Profile Registry arg rewrites. Codex passes only an allowlist of variables to its tool servers, so a migration also adds `env_vars = ["PLAYWRIGHT_MCP_INIT_SCRIPT"]` to every Playwright entry in the Codex `config.toml`; that is a variable name, not a per-machine path. Instar starts sessions in tmux, so the variable is passed explicitly with `tmux new-session -e`. It also keeps per-machine paths out of git-tracked `.mcp.json`. Sessions started by hand outside instar do not get it, and the spec says so.
- **Agent-written scripts:** a launcher, `.instar/scripts/browser/account-browser.mjs <profile>`, opens a Playwright Profile Registry profile with the hold added through `addInitScript`, and prints and records every dialog. Installing it does not make a script use it. So a PreToolUse hook on Bash (registered for existing agents by an idempotent `migrateSettings()` step and for new ones by `init`) raises a signal (never a block) when a command runs a script that opens a registered profile's directory with Playwright without the launcher, naming the launcher and the 11-11 incident. A script that ignores the signal is not covered, and the spec says so.
- **`chrome-js.sh`:** unchanged, except that the hold response now prints the matched warning sentences themselves, so the load-bearing text is inside what the agent reads (P24), not only a fingerprint.
- **Linux and Windows drivers** (`xdrive.sh`, `ndrive.sh`) have no preflight today and stay uncovered; follow-up F-D.

## Decision points touched

| Decision point | Classification | Basis |
| --- | --- | --- |
| Hold a submit carrying a non-empty recovery-code input for the agent's dialog decision | judgment-candidate | Floor: the dialog fires and names the cost; with no decision from the agent (no allowance on the launcher, no answer under MCP) the submit is dismissed, the conservative default. Arbiter: the agent, who must have an operator approval per the existing rules. |
| Print a credential's instructions | invariant | basis: enumerable-domain; evidence: printed only for a Bitwarden `instructions` field or a local `<key>__instructions`; never any `notes`. |
| Set `PLAYWRIGHT_MCP_INIT_SCRIPT` in spawned sessions | invariant | basis: external-constraint; evidence: `@playwright/mcp` 0.0.85 documents the variable; the environment reaches every MCP entry location. |
| Signal a direct Playwright launch of a registered profile | judgment-candidate | Floor: signal only. Arbiter: the agent. |

fixed-limits: none.

## Signals and what they prove (P20)

- **Recovery-code input.** Symbol: a non-empty input labelled as a recovery or backup code. State claimed: this submit may spend a break-glass code (a possible use, not proof that a code was consumed; the service decides that). Corroboration: the input is in the form being submitted and has a value; the dialog says "looks like". Unmeasurable, stated as known gaps: an unlabelled code field, and a single-page site that sends the code with `fetch` from a non-submit button. Neither is held; the CLAUDE.md rule remains.
- **Instructions present.** Symbol: the field exists. State: the item carries usage instructions. No inference beyond that.

## Multi-machine posture

- All three guards are code shipped identically to every machine.
- Audit events stay on the machine that wrote them. machine-local-justification: physical-credential-locality. They describe one machine's browser profile, whose cookies and sessions live on that disk.
- Instructions have the same posture as their credential, by design: they live beside it and go wherever it goes. A machine that cannot read the credential has no use for its instructions. The 0600 instruction file is a per-read cache, overwritten on each read.
- Credential instructions follow their credential's existing sync rule. Bitwarden items are shared wherever Bitwarden is used. `<key>__instructions` syncs exactly when `<key>` does, so it stays off the fleet's default (secret sync off) and keys excluded by design (`google_passkey_*`) keep their instructions on the same machine as the key.

## Testing

- Unit: the detector on labelled, unlabelled and empty code inputs; the headings-only pages from round 2 (GitHub security settings, Google factor picker) not held; type-2 notes never printed; instructions printed in full with redaction.
- Integration: a local test page with a recovery-code form whose submit handler sends a request, and a submit button whose click handler sends one. Through the launcher and through MCP with the variable set: dismissal produces zero requests, and `form.submit()` and `requestSubmit()` are held too. A script with a blanket accept listener still gets the dialog text printed.
- Hook lifecycle: after a migration run on an existing agent's settings, the hook is registered once, and a Bash command that opens a registered profile directly produces the signal.
- Acceptance path: through the launcher with an allowance, exactly one request is sent, with the right submitter, and no second dialog, for click, Enter, `submit()` and `requestSubmit()`. A second attempt without a new allowance is dismissed.
- Wiring: the running Playwright MCP server process (not just the session) has `PLAYWRIGHT_MCP_INIT_SCRIPT` set, for a Claude Code session and for a Codex session, and the file it names exists on Mac and Linux.
- Incident reproduction: `bw-item.mjs "npmjs.com - jkheadley"` prints the counter instruction after migration, and the notes pointer before it.
- Two consecutive `requestSubmit()` calls in one task ask twice; a same-origin page for a different account shows that account in the dialog.

## Rollout and rollback

- Maturation ladder: first a throwaway test agent (the integration tests above), then development agents (Echo) on by default, then the fleet. The fleet step is a judgment on the maturation board, with the held-page and dialog audit from Echo as its evidence, not a fixed count of days.
- The rollout to Echo starts only after the operator approves the F-B and F-D deferrals with dates (P10). That request goes out in the morning, not at night.

- `accountSafety.pageHold: false` turns off guards 1 and 3, and doing so records a degradation.
- Built-in browser scripts are overwritten on every update, so a downgrade restores the previous script.

## Follow-ups (registered as commitments when this ships)

P10 asks for principal approval for deferrals that risk recurrence. F-B (partly covered above) and F-D go on the operator's morning list for that approval, with dates. F-A is outside the threat model, so it is not a deferral.

- **F-A.** Server-held break-glass codes with an operator-approved, server-performed fill (real authority against a misbehaving agent).
- **F-B.** A recovery obligation after any break-glass sign-in, closed by an independently observed sign-in with another factor. Until then, on the launcher route an accepted dialog also opens a commitment through the server API (from the launcher, outside the page): "prove a non-break-glass way into <origin>". It resurfaces on the normal cadence. F-B replaces it with an independent check.
- **F-C.** Routes inventory for account handoffs, as an input to the B17 false-blocker rule.
- **F-D.** The same page hold for the Linux and Windows drivers.

## Frontloaded Decisions

- Threat model: a confused agent; containment of an agent working around the guards is F-A.
- The dialog is the release path. There is no in-page approval store.
- No per-field vault marker.
- Instructions sources as listed in guard 2.

## Standards-Conformance Gate

- Round 0 (21:31): three flags, answered by dropping name-pattern authority and the notes cut.
- Round 1 (22:33): two flags. Answered by covering the init-script route and holding at the submit.
- Round 6 (23:17, the last round allowed): one gate flag (default dismissal, answered in round 5) and four design findings, two of them safety-related: guard 2 had no reader on the incident path (plain `bw get item`), and Codex does not pass the variable to its Playwright server. Also: a same-task resubmission shared one ask, and the profile's account is not the page's account. All four are fixed above, but no further round reviewed the fixes.
- Round 5 (23:11): three gate flags (default dismissal as authority, the one-week bar, instructions posture) and three GPT-6 findings (accepted-event path, allowance scope, hook migration). Answered: ask synchronously before cancelling and never replay; single-use, account-bound allowances; migrateSettings registration with a lifecycle test; graduation by maturation review. Default dismissal is the floor of a judgment-candidate, with the agent as arbiter, not the detector's authority.
- Round 4 (23:02): three gate flags (blanket accept, symbol vs state, maturation ladder) and three GPT-6 findings (dialog ownership, instructions still in notes, deferral approval timing). Answered with a launcher-owned dialog decision, a notes pointer and migration of the npm item, "looks like" wording, the maturation ladder, and approval before rollout.
- Round 3 (22:57): six design findings from the internal reviewer, three from GPT-6. Answered with a new init script that stops site handlers, `PLAYWRIGHT_MCP_INIT_SCRIPT`, no notes as instructions, a launcher-side audit, an honest coverage statement and the interim commitment.
- Round 2 integration review (22:46): five places write the MCP entry, local-vault dots nest, the Bitwarden reader lacks custom fields, and secret sync is off on the fleet. Answered in guards 2 and 3 and the posture section.
- Round 2 (22:41): five flags (unmediated programmatic submits, pattern authority, 1-hour expiry, chunks-served proof, a dark approval store). Answered by scoping to a confused agent, holding `form.submit`, and removing the approval store, expiry and chunk proof.

## Open questions

*(none)*
