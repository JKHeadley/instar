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

Reading the notes made the key work on the first try. Every one of these was a willpower failure on a path where structure could have stopped it. The operator asked (topic 130715, 2026-11-11 21:25 PST) how to make sure this class of mistake does not happen again for any instar agent. The lesson is P25 in `docs/INSTAR-DESIGN-PRINCIPLES-AND-LESSONS.md`.

## What already ships (PR #2944, 2026-11-08)

- `account-page-safety.js` is a preflight in the macOS normal-Chrome wrapper (`chrome-js.sh`). It reads the full page, raises an `account-action-review` on recovery-code or hold language, and needs `--reviewed-page <fingerprint>` before caller code runs.
- The "Account actions: read before acting" rules (`src/data/accountActionSafety.ts`) are in every agent's CLAUDE.md and browser skill. They say recovery codes are break-glass, and that you read the whole page before acting.

Three gaps the 11-11 incident exposed:
1. The npm work ran through a hand-written Playwright script (CDP, profile `justin-npm`), not `chrome-js.sh`. The preflight never ran.
2. The preflight's acknowledgment is self-issued: the agent receives the fingerprint and can hand it back with any reason, without reading a chunk. On a recovery-code page it checks for no approval, though the rules require one.
3. The rule "recovery codes need operator approval" exists only as text.

## Design principle for this spec

The harm happens when a break-glass code is **submitted** to a service, not when it is read. So authority sits at the submit, inside the browser, where every driver passes. Reads only raise signals. This answers the round-1 finding (security, lessons, Standards gate) that a read gate is both broader than the harm and easy to route around (`bw get`, `node -e`, a code already in a transcript).

## Proposed design

### Guard 1. A recovery-code submit needs a single-use operator approval

- **Where it acts:** the page preflight (guard 3), on a page it classifies as a recovery/backup-code entry page. The existing classifier (URL paths such as `/login/recovery`, `/2fa/backup`, and field labels such as "Recovery code") is the detector.
- **What it requires:** before the submit or click goes through, an approval record bound to (service origin, account, page fingerprint), unused, unexpired (1 hour), and issued by the operator. The agent's own reason is never enough on these pages.
- **Where approvals live:** a new `account-break-glass` request type in the existing `AuthorizationRequestStore` (`state/authorization-requests.json`). Its request shows the service's known cost from a shipped table (`src/data/breakGlassCosts.ts`: npm = 72-hour publishing and token hold, from npm's 2026-09-09 changelog and the 2026-11-07 observation; unknown services say "cost unknown"). The cost comes from the table, never from the agent's text.
- **Consumption:** the preflight marks the record used in the same write that permits the submit. A second submit with the same record is refused.
- **Standing mandate:** the existing "exact-account login mandate" carve-out for Google backup-code repair (in `accountActionSafety.ts`, run by the specialized sign-in repair driver) stays. That driver records its mandate id in place of an approval id, and the preflight accepts it only for that driver and that account.
- **When the store is off** (dark on the fleet today): the hold stands. The agent tells the operator plainly what it needs and why, through its normal channel. This is the current rule's behaviour made structural; nothing gets less safe.
- **Read-side signal:** `secret-get.mjs`, `secret-drop-retrieve.mjs` and the Bitwarden provider print one stderr line when a key or field name matches recovery/backup/emergency-code wording: "this looks like a break-glass code; spending it needs an approval on the submit page". It never refuses the read.

### Guard 2. A credential's instructions travel with it

- **What counts as instructions:** a Bitwarden custom field named `instructions`, or the `notes` of a Bitwarden **login** item (type 1). Never the `notes` of a secure-note item (type 2), because that field is the secret value itself (`BitwardenProvider.ts`: type-2 notes are returned as the value). In the local vault, a sibling key `<key>.instructions`.
- **When it prints:** only when the item has instructions. Plain tokens with none (the auth token, most API keys) print nothing extra, so the common `secret-get.mjs authToken 2>/dev/null` path is unchanged.
- **How it prints:** the reader writes the full instructions to a 0600 file under `.instar/state/credential-instructions/`, and prints to stderr the file path, byte count, and the full text wrapped as untrusted data: `<credential-instructions item="…" source="bitwarden" untrusted>…</credential-instructions>`. The text first passes `SecretRedactor`, so a seed or code pasted into instructions is masked, with a note that a value was masked.
- **Never cut:** the text is printed in full. The file path is also printed, so a caller whose output is cut still has the whole text on disk. There is no size refusal and no invented size limit (round-1 finding: "too large for the caller's context" is not measurable by a script).
- **Not authority:** instructions are data. They can never stand in for a guard-1 approval, a guard-3 page review, or a guard-4 waiver, whatever they say.

### Guard 3. Every browser route runs the page preflight

The preflight becomes code inside the page, not a step the caller must remember:

- **The shared script:** `account-page-safety.js` is shipped as an init script. Installed in a page, it adds a capture-phase hold on `submit`, `click` on submit-type controls, and Enter in form fields, on pages it classifies as account or sign-in pages. A held action returns `account-action-review` to the driver and does not reach the page.
- **Playwright MCP:** `@playwright/mcp` supports `--init-script <path>` (documented in its README). A `PostUpdateMigrator` step adds `--init-script <agent>/.instar/scripts/browser/account-page-safety.js` to the existing `mcpServers.playwright` entry, and to new installs. The entry is otherwise left as it is.
- **Agent-written Playwright/CDP scripts:** a new launcher `.instar/scripts/browser/account-browser.mjs <profile>` starts a registered account profile and installs the init script with `addInitScript`. A PreToolUse hook on Bash raises a signal when a command connects Playwright or CDP to a Playwright Profile Registry profile directly (`connectOverCDP`, `launchPersistentContext` with a registered profile path): it names the launcher and the incident. It does not block (Signal vs. Authority). The structural part is that registered account profiles get their remote-debugging port from the launcher only; a direct launch outside it is visible in the browser ledger as a degradation.
- **`chrome-js.sh`:** keeps its current preflight, with the acknowledgment fixed. The wrapper records which chunk offsets it has served for each fingerprint and accepts `--reviewed-page` only after every chunk through `complete:true` has been served. On a recovery-code page, it additionally needs the guard-1 approval id.
- **Linux and Windows drivers** (`xdrive.sh`, `ndrive.sh`): not covered by this spec. They have no preflight today; they get the same init-script hold in a follow-up registered as a commitment when this ships. Stated here so "every driver" is not claimed.
- **Language:** the hold wording is English. On a registered account profile, a page whose `lang` is not English and has form fields raises the review advisory (the honest result is "unknown", so it asks for review rather than passing).

### Guard 4. A break-glass sign-in opens a recovery obligation

- **Trigger:** consuming a guard-1 approval (or a mandate) creates a commitment in `CommitmentTracker` before the submit is permitted: "prove a non-break-glass way into <service>/<account>".
- **Proof:** a sign-in through the launcher in a fresh, cookie-free browser context that reaches a signed-in page with no break-glass signal, recorded with the factor type used (password + virtual key, passkey, TOTP, OAuth). If a clean context cannot be made, the proof is recorded as `unknown` and the commitment stays open.
- **Close:** the commitment closes on a proof record or an operator waiver. It is re-surfaced on the normal commitment cadence until then. The working recovery session is left signed in while the proof runs.

### Guard 5. Before handing account work to the operator, see the routes

- **Who builds the list:** a server route, `GET /account-routes?service=<origin>`, lists what the agent holds for that service: vault and Bitwarden item names (never values), Playwright Profile Registry profiles, live browser sessions from the browser ledger, and saved keys. The agent adds only why each one fails.
- **How it is used:** the list is a signal into the existing outbound self-stop rule `B19_PARKED_ON_USER`, which already judges by meaning whether a message hands doable work back to the operator. It is never a separate hold.
- **Scope:** it applies to handing an account **task** to the operator. Approval requests (guard 1), waivers (guard 4), and the existing carve-outs for asking for a secret, a 2FA code or a CAPTCHA pass untouched (P12: required approvals must pass).

## Decision points touched

| Decision point | Classification | Basis |
| --- | --- | --- |
| Permit a submit on a recovery-code page only with a single-use operator approval or a registered mandate | invariant | basis: irreversible-consequence; evidence: npm suspends publishing and token creation for 72 hours on any recovery-code use (observed 2026-11-07; npm changelog 2026-09-09). |
| Classify a page as a recovery-code entry page | judgment-candidate | Floor: shipped URL/label patterns trigger the hold; a non-English form page on an account profile is `unknown` and asks for review. Arbiter: the agent reading the full page, then the operator for approval. |
| Hold an account-page submit for review (non-recovery pages: suspension, lock, reset language) | judgment-candidate | Floor: full read of every chunk before the acknowledgment is accepted. Arbiter: the agent with the full text, citing any operator approval the page requires. |
| Read-side break-glass name signal | judgment-candidate | Floor: signal only, never refuses. Arbiter: the agent. |
| Print instructions with a credential | invariant | basis: enumerable-domain; evidence: printed only when an `instructions` field, login-item notes or `<key>.instructions` exists; never type-2 notes. |
| Close a recovery obligation | judgment-candidate | Floor: a fresh-context sign-in record or an operator waiver; `unknown` keeps it open. Arbiter: the operator for waivers. |
| Signal a direct Playwright/CDP connection to a registered profile | judgment-candidate | Floor: signal only. Arbiter: the agent, with the browser ledger degradation visible to the operator. |
| Feed the routes list to B19 | judgment-candidate | Floor: the server-built list; approvals and secret/2FA/CAPTCHA asks are out of scope. Arbiter: the existing B19 judgment. |

fixed-limits: approval lifetime 1 hour (judgment-candidate: long enough for one sign-in, short enough that a stale approval is not reused; the operator can re-approve).

## Signals and what they prove (P20)

- **Recovery-page classifier.** Symbol: URL path or field label. State claimed: this submit would spend a break-glass code. Corroboration: the shipped cost table for the origin, and the full page text. Unmeasurable: non-English or unlabeled form on an account profile → review.
- **Fresh sign-in proof.** Symbol: a launcher record. State claimed: a non-break-glass factor works. Corroboration: the context was created without cookies, and the factor type is recorded. Unmeasurable: `unknown`, obligation stays open.
- **Routes list.** Symbol: the server list. State claimed: what the agent holds. Corroboration: built by the server from registries, not written by the agent. Unmeasurable: a registry that fails to read is listed as `unknown`, never as "nothing held".

## Multi-machine posture

- Break-glass approvals: machine-local. machine-local-justification: physical-credential-locality — the approval binds to a page fingerprint in a browser profile whose cookies live on one machine's disk, and it is consumed by that machine's preflight. An approval on machine A cannot be spent on machine B.
- Recovery obligations: unified, through `CommitmentTracker`'s existing replication.
- Credential instructions: travel with the credential through the existing cross-machine secret sync (Bitwarden items are shared; `<key>.instructions` syncs with its key).
- The init script, launcher and hook are code, shipped identically to every machine.

## Rollout and rollback

- Each guard has a switch under `accountSafety.*` in config. Guard 1's hold and guard 3's init script default on; off means the current behaviour.
- Built-in browser scripts are always overwritten on update, so a downgrade restores the previous preflight.

## Frontloaded Decisions

- Authority sits at the submit, not the read.
- No per-field marker: the recovery page is detected in the browser, which every driver passes, so a vault marker would add a store without adding safety.
- Instructions source: custom field `instructions`, login-item notes, `<key>.instructions`; never type-2 notes.
- Guard 3 mechanism: init script (MCP `--init-script`, launcher `addInitScript`), plus a signal hook.
- Guard 4 enforcer: `CommitmentTracker`.
- Guard 5: signal into B19, scoped to task handoffs.
- Linux/Windows drivers: follow-up commitment, not this spec.

## Standards-Conformance Gate

- Round 0 (2026-11-11 21:31 PST): three flags (name-pattern authority, approval breadth, notes cut). Answered by moving authority to the submit and dropping the size cut.
- Round 1 (2026-11-11 22:33 PST): two flags (guard 3 relies on a helper; read approval broader than the harm). Answered by the init script and by gating the submit.

## Open questions

*(none)*
