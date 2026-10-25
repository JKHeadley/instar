# Side-Effects Review — sign-in repair uses single-use Google backup codes

**Version / slug:** `relogin-backup-codes`
**Date:** 2026-09-24
**Author:** Echo

## Summary of the change

Registry: `vaultBindings.backupCode` accepted. Browser observation: an input named/id `backupCodePin` reports kind `backup-code`. Driver: new optional dep `takeBackupCode`; `fill-backup-code` allowed in a repair for password accounts with a codes binding and a taker (enroll path unchanged); closed page class `google-backup-code-entry` and the agent offer include it under those conditions only. Runtime: passes `takeBackupCode` through; exports `takeFirstBackupCode` (take first 8-digit code, write the rest back). Server: wires it to the vault.

## Decision-point inventory

- Whether to offer `fill-backup-code` — `invariant`: structural (Google's exact field + binding present + taker present + password method); no judgment added. The agent chooser may pick it only when offered.

## 1. Over-block

None new; accounts without a binding behave exactly as before.

## 2. Under-block

A code is removed from the vault before typing; if the page then fails (network), that code is lost from the list though still valid at Google — accepted: the safe direction (never re-try a code that might be spent). The Bitwarden copy keeps the full original list; the local vault is the working list.

At most ONE code per drive: if Google rejects it, the page stays on the backup-code field and a second fill request throws `relogin-backup-code-rejected`, ending the attempt as transient. With the existing 3-attempt budget, one episode can spend at most 3 codes. `takeFirstBackupCode` rewrites the entry with only the remaining 8-digit codes; the entry is expected to hold codes only (that is how they are stored), so any other text in it would be dropped.

## 3. Level-of-abstraction fit

Consumption lives where secrets live (the server's vault); the driver only asks for one code; the offer floor is structural.

## 4. Signal vs authority compliance

No new authority. The fill is a floor-gated action like password/TOTP fills.

## 4b. Judgment-point check (Judgment Within Floors standard)

The existing agent chooser gains one more floor-gated token; floors unchanged otherwise.

## 5. Interactions

One repair at a time (seat lease) serialises vault writes. Redaction: the code never enters snapshots, observations or supervisor input (tested).

## 6. External surfaces

Google sees a normal backup-code sign-in. Codes are consumed; the operator may eventually need to generate a new set.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

No new surface.

## 7. Multi-machine posture (Cross-Machine Coherence)

`machine-local-justification: physical-credential-locality` — each machine's vault and profile are its own. Note: if the same codes list is synced to several machines, each machine consumes from its own copy; a code spent on one machine and later tried on another is rejected by Google and ends that attempt (one code per drive, so a stale list costs at most one rejected submit per attempt).

## 8. Rollback cost

Revert; an unused `backupCode` binding is ignored by older code.

## Second-pass review

Reviewer (subagent, 2026-09-24): **Concern raised** — (1) no leak, but the code was not added to the redaction set like password/TOTP; (2) wrong-field fill closed; (3) a rejected code could be re-offered, draining the list within maxSteps; (4) enroll unchanged; (5) artifact omitted (3) and the rewrite behaviour of `takeFirstBackupCode`.
Resolution: code added to the redaction set; one code per drive (`relogin-backup-code-rejected`, tested); artifact §2/§7 corrected. Concur.

## Conclusion

Small, floor-gated addition. Ship.

## Evidence pointers

`upgrades/next/relogin-backup-codes.md`.

## Class-Closure Declaration (display-only mirror)

`{defectClass: "unbounded-self-action", closure: "n/a", reason: "no new self-triggered action; one more floor-gated fill inside the bounded repair"}`
