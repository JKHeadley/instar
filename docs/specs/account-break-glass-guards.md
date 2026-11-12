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

The 11-11 npm work ran through a hand-written Playwright script, so the preflight never ran.

## Threat model (what this spec does and does not do)

This spec guards against a **confused or careless agent**: one that would follow a warning if the warning reached it. Every 11-11 failure was of that kind (a cut page read, unread notes, a wrong route chosen).

It does **not** contain an agent that is trying to get around it. Such an agent can post the code with `fetch` or curl, run its own JavaScript in the page, or edit its own config. Round 2 of review showed that real authority needs the code kept out of agent-readable stores and released only by a server-performed fill. That is a different, larger design, recorded below as follow-up F-A. The guards here are friction on the accidental paths, and the spec does not call them authority.

## Proposed design

### Guard 1. The page holds a recovery-code submit and says what it costs

- **Detector:** a form is about to be submitted that contains a **non-empty** input whose own label, name, placeholder or `autocomplete` value names a recovery or backup code. A heading or URL alone does not trigger it, so security-settings pages and factor pickers are not held (round-2 finding: heading matches would hold ordinary pages).
- **Hold points:** the `submit` event (capture phase), `HTMLFormElement.prototype.submit` and `requestSubmit` (patched by the init script, since `form.submit()` fires no event), and Enter in a form field.
- **What the agent sees:** a native `confirm()` dialog with the text: "instar: this submits a one-time recovery code to <origin>. Known cost: <cost from the shipped table, or 'unknown'>. Do this only if the operator approved this exact use. Check the credential's saved instructions first: a saved key or password may work." Dialogs are how the hold reaches every driver without a bearer token in the page:
  - Playwright MCP reports an open dialog as a modal state that must be handled before anything else happens.
  - Playwright scripts dismiss dialogs by default, so an unhandled dialog cancels the submit.
  - `chrome-js.sh` returns it in its result.
- **Release:** accepting the dialog lets the submit through. That is the agent's own judgment, made with the cost in front of it. The page writes a line to the browser console and the agent's audit (`account-break-glass` event: origin, time, accepted or dismissed). No code is logged.
- **Cost table:** `src/data/breakGlassCosts.ts`, keyed by origin. It starts with npm (72-hour publishing and token hold; npm changelog 2026-09-09, observed 2026-11-07). Unknown origins say "cost unknown".

### Guard 2. A credential's saved instructions travel with it

- **What counts as instructions:** a Bitwarden custom field named `instructions`, or the `notes` of a Bitwarden **login** item (type 1). Never the `notes` of a secure-note item (type 2): there the notes are the secret value (`BitwardenProvider.ts`). In the local vault, a sibling key `<key>__instructions` (a dot would nest, per `secret-get.mjs`). The Bitwarden provider gains code to read custom fields and login-item notes, which it does not read today.
- **When it prints:** only when the item has instructions. Plain tokens with none (the auth token, most API keys) print nothing extra.
- **How:** the reader writes the full text to a 0600 file under `.instar/state/credential-instructions/` and prints to stderr the path, byte count and the full text, wrapped as untrusted data (`<credential-instructions item="…" untrusted>…</credential-instructions>`), after `SecretRedactor`. Nothing is cut; the file holds the whole text even if stderr is dropped.
- **Not authority:** instructions are data and never stand in for an approval.
- **Readers covered:** `secret-get.mjs` and `secret-drop-retrieve.mjs` (Secret Drop has no notes, so it prints nothing), and the Bitwarden provider's `get`.

### Guard 3. The page safety script runs on every Playwright route

- **Playwright MCP:** `@playwright/mcp` supports `--init-script <path>` (README of 0.0.85). The entry is written in several places, and every one gets the flag through one shared helper used by `PostUpdateMigrator`, `init` and `setup`: `.claude/settings.json`, the project scope of `~/.claude.json`, `.mcp.json`, and the Codex `config.toml`. `PlaywrightProfileRegistry`'s arg rewrite on profile activation keeps the flag (it goes through the same helper). The migration is idempotent: it adds the flag once and changes nothing else.
- **Agent-written scripts:** a launcher, `.instar/scripts/browser/account-browser.mjs <profile>`, opens a Playwright Profile Registry profile with the same script added through `addInitScript`. It is for Playwright profiles only; normal-Chrome profiles stay free of automation and keep `chrome-js.sh`. The npm script on 11-11 would have used it, because the browser skill and CLAUDE.md section name it as the way to open a registered profile.
- **`chrome-js.sh`:** unchanged, except that the hold response now prints the matched warning sentences themselves, so the load-bearing text is inside what the agent reads (P24), not only a fingerprint.
- **Linux and Windows drivers** (`xdrive.sh`, `ndrive.sh`) have no preflight today and stay uncovered; follow-up F-D.

## Decision points touched

| Decision point | Classification | Basis |
| --- | --- | --- |
| Hold a submit carrying a non-empty recovery-code input for the agent's dialog decision | judgment-candidate | Floor: the dialog fires and names the cost; an unhandled dialog cancels the submit. Arbiter: the agent, who must have an operator approval per the existing rules. |
| Print a credential's instructions | invariant | basis: enumerable-domain; evidence: printed only for an `instructions` field, login-item notes or `<key>.instructions`; never type-2 notes. |
| Add `--init-script` to the Playwright MCP entry | invariant | basis: external-constraint; evidence: `@playwright/mcp` documents `--init-script` as the only page hook it exposes. |

fixed-limits: none.

## Signals and what they prove (P20)

- **Recovery-code input.** Symbol: a non-empty input labelled as a recovery or backup code. State claimed: this submit spends a break-glass code. Corroboration: the input is in the form being submitted and has a value. Unmeasurable (an unlabelled code field): no hold; the existing full-page review in `chrome-js.sh` and the CLAUDE.md rule remain. Stated as a known gap.
- **Instructions present.** Symbol: the field exists. State: the item carries usage instructions. No inference beyond that.

## Multi-machine posture

- All three guards are code shipped identically to every machine. They keep no state, apart from audit lines that stay in each machine's log.
- Credential instructions follow their credential's existing sync rule. Bitwarden items are shared wherever Bitwarden is used. `<key>__instructions` syncs exactly when `<key>` does, so it stays off the fleet's default (secret sync off) and keys excluded by design (`google_passkey_*`) keep their instructions on the same machine as the key.

## Testing

- Unit: the detector on labelled, unlabelled and empty code inputs; the headings-only pages from round 2 (GitHub security settings, Google factor picker) not held; type-2 notes never printed; instructions printed in full with redaction.
- Integration: a local test page with a recovery-code form. A Playwright run through the launcher shows the dialog and the submit is cancelled when the dialog is dismissed. `form.submit()` and `requestSubmit()` are held too.
- Migration: each of the four entry locations gains `--init-script` once and is otherwise unchanged; a profile activation keeps it.

## Rollout and rollback

- On by default. `accountSafety.pageHold: false` turns off guards 1 and 3, and doing so records a degradation.
- Built-in browser scripts are overwritten on every update, so a downgrade restores the previous script.

## Follow-ups (registered as commitments when this ships)

- **F-A.** Server-held break-glass codes with an operator-approved, server-performed fill (real authority against a misbehaving agent).
- **F-B.** A recovery obligation after any break-glass sign-in, closed by an independently observed sign-in with another factor.
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
- Round 2 integration review (22:46): five places write the MCP entry, local-vault dots nest, the Bitwarden reader lacks custom fields, and secret sync is off on the fleet. Answered in guards 2 and 3 and the posture section.
- Round 2 (22:41): five flags (unmediated programmatic submits, pattern authority, 1-hour expiry, chunks-served proof, a dark approval store). Answered by scoping to a confused agent, holding `form.submit`, and removing the approval store, expiry and chunk proof.

## Open questions

*(none)*
