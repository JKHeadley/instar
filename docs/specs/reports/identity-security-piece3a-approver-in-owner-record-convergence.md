# Convergence report: the approver mark in the owner record (piece 3a)

**Spec:** `docs/specs/identity-security-piece3a-approver-in-owner-record.md`
**Iterations:** 5. Four internal rounds, then the constitution check and one cross-model round (GPT-6.2 Astra, Headley Codex account).

## In plain words

Today any paired device can make itself able to approve risky actions, and on a Windows PC any program can do it silently. This piece moves "who can approve" into the signed ownership ledger your computers share. Only the owner's phone can add itself to it: the very first time with a code from the owner's private chat, after that by a phone already in the ledger. Devices that approve today keep working and are listed for the owner to check.

## Findings by round

| Round | Design findings | What changed |
|---|---|---|
| 1 | 8 | a proof checkable from the record; the app hashes what it signs; kept devices follow §3.6 unchanged; a lone agent gets a record-only key; signed revocation; fresh checks of every machine; key ids from the key; §3.3 restored |
| 2 | 3 | machines add their own keys at Basic; pairing carries the pinned genesis; a token revoke of an approver waits for the owner |
| 3 | 1 | forks from machine additions are merged at Basic; the claim needs a whole record |
| 4 | 0 | converged (precision: no new machine during a claim) |
| Constitution + Astra | 2 standards + 3 relevant | each limit's source stated; the no-switch decision cited; the plain-language summary corrected |

## What the design guarantees

- **No program can make itself an approver.** The first approver needs the owner's chat code; every later one needs an existing approver's Face ID.
- **Every machine checks the same signed record.** The proof of the first approver is checked against the record itself.
- **Devices that approve today keep working,** and the owner sees the list.

## Left for later

- 3b: the attested first approver without a private chat.
- 3c: the apps that sign record entries.
- 3d: recovery, and the person-acts rules.
