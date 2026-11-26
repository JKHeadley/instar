# Side-Effects Review — fixes from the first live Jev test

**Tier 1.** Spec: `docs/specs/recommended-services.md`. Dark: only a throwaway or development agent listing a recipe reaches any of it, and a revert undoes it.

## Summary

- A no no longer clears `keyStoredBySetup`, so a later yes can replace a dead key that setup stored itself.
- Three brief rules: no key in a shared folder, no disposable email address for an account, and close browser windows when done.
- The catalog test's comment and the spec's Left behind section record what the live run left open.

## 1. Over-block

No issue identified. This allows one replacement that was wrongly refused.

## 2. Under-block

- A session or any caller with the token can replace a key setup stored while nothing has shown it passing since the no, including during a provider outage, when a good key can't be told from a dead one. Only a key setup itself stored, and only under a fresh yes, is exposed. A key that was here first stays refused.
- The rules are prompt text, so a session can break them. The key-in-a-shared-folder rule doesn't replace the store-without-the-session work the catalog test still requires.
- A no still leaves a browser open and signed in if the session hadn't closed it. Recorded in the spec's Left behind.

## 3. Level-of-abstraction fit

The key's origin is state about the key, so it belongs with the setup state and shouldn't be cleared with the session's lifecycle fields.

## 4. Signal vs authority compliance

The refusal stays a deterministic check on recorded state and a real verify result. No new decision point. Reference: `docs/signal-vs-authority.md`.

## 5. Interactions

A pass still ends replacement, because `verified` is set when setup finds a good key at the start. Nothing else reads `keyStoredBySetup`.

## 6. External surfaces

None for any agent without `provingRecipes`.

## 6b. Operator-surface quality

No page or message changes. The brief's new rules are read by a session, not the person.

## 7. Multi-machine posture

Unchanged: setup state stays machine-local, with reason `physical-credential-locality`.

## 8. Rollback cost

A revert restores the refusal. No data migration.

## Live run, 2026-11-04

Rig: throwaway agent, real confirm page and PIN, real session and browser, real TypeSafe, local stand-in for Telegram with me as the person.

Settled from the earlier open list: `/v1/models` answers 200 for a good key and 401 for a deleted one. A reply after a long-dead session resumed the earlier conversation with its brief, though it can resume an older run and miss a newer yes. In this one run the key reached none of 304 scanned files (transcripts, hook logs, session files), and the scan found a planted copy. That session piped it carefully, and nothing structural made it do so.

Still open: real Telegram, a brand-new account, `dormant` giving no notice, the lease gap, and promises a session made for itself staying open when it's killed.

## Second-pass review

Not required: not on the high-risk list beyond a narrow state field, and dark. Not independently reviewed.

## Class-Closure Declaration (display-only mirror)

- defectClass: n/a
- closure: n/a
- reason: A single state field and prompt wording, with no loop or new surface.
