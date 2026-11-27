---
title: "Organization recovery copy"
slug: "org-recovery-copy"
author: "echo"
parent-principle: "The User Experience Is the Product — Reachability, Responsiveness, and Coherence Are Sacred"
eli16-overview: "org-recovery-copy.eli16.md"
status: "approved"
approved: true
approved-by: "echo, under the standing operator rule that only constitution changes need Justin (memory: only-constitution-changes-need-justin). No constitution file is touched. Feature approved by Justin: topic 141385, 2026-11-16 13:12 PST (easy-setup brief build step 6, recovery copy)."
review-convergence: "2026-11-17T00:45:35.119Z"
review-iterations: 5
review-completed-at: "2026-11-17T00:45:35.119Z"
review-report: "docs/specs/reports/org-recovery-copy-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
---

# Organization recovery copy

## Problem statement

Justin approved "easy setup for new people" on 2026-11-16 at 13:12 PST (topic 141385). Build step 6 ends with "recovery copy". The organization key that signs every policy version lives on one machine (`org/published/<orgId>.signing-key`, `org-pack-and-join` §A). If that Mac is lost, the organization today starts over under a new id and everyone joins again.

This was first part of `org-members-and-keepers`. Its review rounds kept finding problems in one place: a machine that might come back still holds the key, and nothing here can stop it from publishing. So it was split out with that lesson as its starting point. **This spec does not try to fence a key that may still be in use.** It recovers only when the person states that the old machine is retired, and it refuses when the old machine visibly answers. Every other case uses the honest path: start a new organization and move colleagues over.

## Goal

1. The admin saves a recovery copy: a file plus six words written down apart from it.
2. If the admin's Mac is gone for good, a new agent restores the organization from the copy, under the same organization and key. Colleagues' agents accept its next version as an ordinary update.
3. If the old Mac may come back, or was stolen, the app guides the admin to start a new organization instead. Each colleague can move with one tap.

## Design

### A. Making the copy

- `POST /mobile/org/recovery-copy` (owner device, only on the machine holding the organization key) returns `instar-org-recovery.json`:
  `{ v: 1, orgId, orgName, fingerprint, kdf: { name: 'scrypt', N: 2^17, r: 8, p: 1, salt }, cipher: 'aes-256-gcm', nonce, ciphertext, tag }`.
  The ciphertext holds the organization private key, the current bundle, the copying agent's own member key (`selfMemberKey`: a string, or `null` when the copying agent had none; required in every copy, and a copy without the field is refused as malformed), so recovery can retire that entry, and the registries from `org-members-and-keepers` (`members.json`, `invites.json` hashes, `keepers.json`). The four header fields are bound in as additional data. scrypt at these costs needs about 128 MB, so both sides pass `maxmem` of 256 MB. A file with other scrypt costs is refused as malformed, which bounds scrypt's memory. Registries at their limits (15,500 entries, each with two names of up to 120 characters, so up to about 700 bytes of names in multi-byte text plus about 300 bytes of keys and fields) come to at most about 16 MB of JSON, so a copy may be up to 24 MB of base64 ciphertext. Making a copy refuses anything larger. `/mobile/org/recover` gets its own body parser, mounted before the general 12 MB one, taking bodies up to 32 MB. Copy creation that hits the limit answers 413 with a plain line for the app. Every encoded field is checked as a string before it is decoded: base64 characters only, salt exactly 24 characters, nonce 16, tag 24, ciphertext at most 24 MB.
- The key is derived from a six-word phrase (the 2048-word English list in `@scure/bip39`, about 66 bits, chosen with crypto randomness). The phrase is shown once; spacing and case are ignored when typed back. The app saves the file where the person chooses, and says "Write these six words down and keep them apart from the file."
- The app suggests a fresh copy after every 50 published versions, because §C's version jump is sized from the copy.

### B. Recovering

`POST /mobile/org/recover { file, phrase, retired: true }` (owner device, on any agent that publishes no organization and is not a member of a different one) runs these steps in order, and installs nothing until all of them pass:

1. **Retirement.** `retired: true` is required. The app asks for it with: "Is your old Mac gone, wiped, or never going to run Instar again? If it might come back, start a new organization instead." Without it, the answer is 400 `retirement-required`.
2. **Decrypt and check** (wrong phrase: 403 `wrong-phrase`; 5 tries per hour per agent, counted in memory, so a restart resets the count: the file itself is the real secret). The key inside must match the header's fingerprint, the bundle's record must verify against that key, and its `orgId` must match the header.
3. **The old address is tried**: `GET /org/pack/current` on the decrypted bundle's `updateOrigin`, 10 s, with the update check's address rules. It counts as **alive** only if it answers a record that verifies against the organization key. That shows the old address still serves an authentic organization record; it does not prove the original publisher is running, but recovering while it does would be unsafe either way. Any other answer does not count. That includes a 404 (a wiped Mac with Instar reinstalled, or a named tunnel that now points at this recovering agent), a tunnel provider's error page, a timeout, and a DNS failure.
   If the copy has no `updateOrigin` (updates were off), there is nothing to try. The app then says: "There's no address to check, so this relies on your answer that the old Mac is gone."
 When the old address is alive, recover answers 409 `old-machine-answers` ("Your organization's main agent still answers at <address>. Recover only when it's gone; otherwise start a new organization.").
4. **Pick the starting bundle**: the copy's bundle, or the version this agent itself holds if it was a member and it is newer. (What the person sees about it is §B step 6.)
5. **Install, crash-safely.** Everything is first written into `org/published/recovery-staging/`. Then `org/published/<orgId>.recovered.json` is written (`{ copyVersion, at, stage: 'installing', source }`, temp + rename). Then the staged files are renamed into place, and the marker's `stage` becomes `'installed'`. At start, a marker still at `'installing'` finishes the renames. Every rule below that depends on the marker therefore holds from the first moment anything is in place. What gets installed:
   - The key goes to `org/published/<orgId>.signing-key`, and the newest bundle found goes to `published/current.json`, with `shareUpdates` as it was.
   - Keepers are restored into a separate file, `org/published/<orgId>.keepers.restored.json`, not `keepers.json`. The proposal checks never read it, so even code that predates this spec cannot accept them. "Turn back on" moves one entry into `keepers.json`. Invitation links are restored with `active: false` (`InviteEntry` already has `active`, and the token check requires it). The app lists each with "Turn back on" or "Leave off", because a keeper removed or a link cancelled after the copy must not return by itself.
   - The old publisher's own entry (the `selfMemberKey` in the copy) is set to `left`. The new agent registers itself at its first publish, as any publish does.
   - Members keep their states. Every entry that was `joined` in the copy gets the flag `unconfirmed: true`. Its state is still `joined`, so it counts toward the 500 like any joined entry, and confirming can never exceed the limit. These all drop the flag: a `state: 'left'` check-in (which moves it to `left`), "Confirm" (`POST /mobile/org/recovery/members/confirm { memberKey | all: true }`), and the ordinary remove and restore. Once the flag is gone, removal answers work as usual.
   - Restored keepers and links are listed in `GET /mobile/org/members` (`restoredKeepers`, and inactive links marked as restored). They are turned back on or dropped with `POST /mobile/org/recovery/keepers/{reactivate,discard} { publicKey }` and `POST /mobile/org/recovery/invitations/{reactivate,discard} { inviteId }` (owner device, `org-acts`). Reactivating a keeper goes through the same three-keeper limit as adding one. A removal made after the copy cannot be in the copy, so the page shows these entries as "Not confirmed since recovery" with "Confirm" and "Mark as gone", plus "Confirm all". While an entry is unconfirmed, its check-ins are accepted (name, version, last seen) but their answers leave out the `removal` field, so they neither raise nor clear a notice on the member's side. Removed and left entries stay removed and left.
6. **Newer versions from colleagues.** After the install, while the marker exists, `POST /mobile/org/recover-latest { bundle }` (owner device) accepts a bundle that verifies against the installed organization key. It runs under the publish lock and checks the marker again inside it. If the bundle is newer than `published/current.json`, it replaces that file (temp + rename) and sets the marker's `source` to `{ kind: 'colleague', label }`, where the label is what the person typed when adding it ("a colleague's agent" when they typed nothing). Both writes happen under the same lock; the marker is written last, so a crash between them shows the newer text with the older label, which is safe. The version jump is computed from that file at publish, so there is no second value to keep in step. Any member's app can export its applied bundle with `GET /mobile/org/current-bundle` (owner device). That returns the signed bundle only, never the member's own keys or token, and the app shows it as "Share this organization's current version". The app shows the text being kept and its source from the marker: "This is version 5, from Ana's agent" (the label typed when adding it), or "This is version 3, from your recovery copy. If newer versions were published after it, they are not here; read it before publishing."
7. **Publish.** The marker lasts across restarts and is removed only by the first publish. While it exists:
   - `POST /org/pack/propose` answers 409 `publish-after-recovery-first`;
   - `POST /org/invitations` answers the same, so no link carries the old address;
   - publish uses `published/current.json`'s version + 1000 instead of `previous + 1`, and keeps the found record's `maxIndependence`, `keepers` and `shareUpdates` unless the person changes them on the publish screen.

   The admin reviews the kept text (step 6) and publishes it as version `current + 1000`, and the app says why: members accept any higher version, and this lands above every version any member could hold unless more than 1000 were published after the highest one found. That publish sets `updateOrigin` to this agent's address when it changed.

### C. After recovery

- Members whose agents still fetch from the old address will not find it. The app offers a fresh invitation link to send them. Their agents take its bundle (a higher version from the same key, the existing join behaviour) and its token. Those who joined after the copy enroll again with that token.
- **Limit, stated plainly:** if the old machine does come back after a recovery the person called final, two machines hold the key. Members follow whichever address their agents last learned, and versions can conflict. This spec does not detect or fence that. The retirement question and the alive check are the guard. The answer to a stolen or returning key is the new-organization path.

### D. Starting a new organization (the other path)

- The app's Organization tab offers "Start a new organization" on any agent, with one line on when to use it ("Your old Mac was stolen, or might come back").
- This publishes as a first publish (a new `orgId` and key), the existing flow.
- For members: an agent can belong to one organization at a time, so the join screen for an agent that is a member of another organization offers "Leave <old> and join <new>". It is one tap that sends the existing leave, then the join, each as its own owner-device request. If the join fails after the leave succeeded, the screen says so and offers the join again; the old policy is already gone at that point, and the screen says that too.

## Decision points touched

| Decision point | Classification | Why |
|---|---|---|
| Recovery needs the person's retirement statement | invariant | Basis: irreversible-consequence; evidence: two machines holding one organization key cannot be detected or fenced in this version; only the person knows whether the old machine is gone. |
| Old address counts as alive only when it serves a record signed by the organization key | invariant | Basis: enumerable-domain; evidence: a signature check has one answer; a 404 or an error page can come from a reinstalled machine, a tunnel provider or this agent itself. |
| Restored keepers and links stay inactive, and restored joined members unconfirmed, until reconfirmed | invariant | Basis: irreversible-consequence; evidence: a keeper can publish to every member, so authority removed after the copy must not return silently. |
| Recovery-copy, recover and leave-then-join need an owner-device request | invariant | Basis: irreversible-consequence; evidence: each moves the organization key or changes the agent's rules; same trust level as the existing `ownerOnly` organization acts. |

## Open questions

*(none)*

## Acceptance

1. Unit: the copy round-trips with the phrase (any spacing or case) and is refused with any other; a changed header or cost setting, a wrong-length salt, nonce or tag, or a missing `selfMemberKey` is refused; a copy with registries at their limits round-trips.
2. Unit: alive detection. A verified record is alive; a 404, an HTML 530, a 502, a timeout and a DNS failure are not; a copy with no `updateOrigin` skips the check and the app says so.
3. Unit: restore. Keepers and invites come back inactive; removed members stay removed; joined members come back unconfirmed, and their check-in answers carry no `removal`; invitations are refused until the first publish, which is the installed version + 1000 and carries the new origin.
4. Integration: an admin publishes v3, saves a copy, publishes v4 and v5 and removes a member; a second agent recovers (old address stubbed as unreachable), is given the v5 bundle by a member, shows v5's text and publishes it as v1005; a member holding v5 takes it from a fresh link as an update with the same text; the member removed after the copy shows as unconfirmed, and its notice is not cleared; recover against a stubbed live old address answers 409.
5. E2E alive: on the production boot path `/mobile/org/recovery-copy` and `/mobile/org/recover` refuse the bearer, and recover without `retired: true` answers 400.

## Maturation plan

- **test-agent-live:** two throwaway agents on the Studio: one publishes and saves a copy, then is stopped and its tunnel removed; the second recovers; one throwaway member follows. Target 2026-11-19, owner echo.
- **dev-agent-live:** Echo's pilot organization: save a copy, verify it opens. Target 2026-11-20, owner echo.
- **fleet:** the next release after dev-agent-live. Owner echo, review due 2026-11-27. An agent that never publishes is unchanged.
- **graduation criterion:** one real recovery drill with the Monroe Institute pilot's copy, without members rejoining by hand.
- **dark-window:** none: nothing happens until an owner saves a copy or recovers.
- **ladder:** not applicable: no staged rollout of its own, it rides the release train and a revert undoes it

## Multi-machine

The copy is made on the machine holding the key, and recover writes to the machine it runs on. On a multi-machine agent, after recovery the key machine is the one that recovered (this follows the forwarding in the `org-members-and-keepers` multi-machine follow-up <!-- tracked: CMT-1873 -->).

> **Carrier (frozen excerpt — the work the multi-machine deferral marker points at):** <!-- tracked: CMT-1873 -->
> **CMT-1873** — "Build the multi-machine part of org-members-and-keepers: forward /org/checkin, /org/pack/propose, /org/pack/current, admin device routes and /org/draft to the key machine over MeshRpc, and copy member key, token, enrolled, pending rejoin and removal notices to peers via org-apply and org-state-pull"

## Rollback

Revert the code: copies already saved stay valid files that a later version can open; a recovered organization keeps working as an ordinary published organization. Restored keepers that were never turned back on stay in `keepers.restored.json`, which older code never reads, so a revert cannot reactivate them. A revert made before the first post-recovery publish loses the version jump; the marker file is left for a later version to finish. A revert made while restored members are still unconfirmed lets older code answer their check-ins with `removal: null`, which could clear a removal notice made after the copy; the person then marks that member as gone again. So the app asks the admin to confirm restored members before anything else, and this is stated as a limit. No migration.

## Out of this spec

Detecting or fencing a returning key, key rotation, and a copy that refreshes itself.
