# Round 6: internal review, all six lenses (draft 6)

Reviewer: one internal pass covering security, adversarial, scalability, integration/deployment (with multi-machine posture), decision-completeness and lessons-aware. Read only. Spec: `docs/specs/windows-one-file-extender.md` (draft 6). Code claims checked against this worktree's `src/` (`ExternalOperationGate.ts`, `OriginSessionRegistry.ts`, `SessionManager.ts`, `mobilePairingRoutes.ts`).

The "The Person Decides" exception (the app is required) is not re-raised. Its reasoning is unchanged and still correct.

## Check-off: my round-5 findings

| Finding | Status | Note |
|---|---|---|
| R5-D1 home machine not phone-paired; uptime data does not exist | Resolved | Home must hold the owner's phone as a paired device and have a pairing address. The ranking is now "talking-to, then named tunnel, then `lastSeen`", and the mint is made directly at the home's address. |
| R5-D2 origin credential is Telegram-only; jobs hold it | Resolved | A new server-held credential is issued only for owner-message spawns, independent of Telegram. Jobs never get it. Its lifetime is a new gap (R6-D4). |
| R5-D3 redeem gate and `DeviceRegistry` write | Resolved | The redeem branch skips the approval and lease gate (`:1268-1273`) and writes only a pending `computerExtenders` row. There is a unit test for it. |
| R5-D4 a held raise survives a non-owner Lower | Resolved | Every mode change advances the number. Records expire after 10 minutes. There is a test for it. |
| R5-D5 `releases/latest` address | Resolved | The address is now the fixed tag `instar-connect`. |
| R5-D6 Tailscale-only home unreachable | Resolved | The PC checks it can reach the home before Connect, with plain words and an option to rescan. |
| R5-D7 External Operation Gate not engaged | Partly | The gate is now engaged. How it is wired does not match the gate as built (R6-D2). |
| R5-P1 `RECONCILER_ALLOWLIST` wording | Resolved | |
| R5-P2 dark-gate lint and `/features` entry | Resolved | |

## Check-off: round-5 external DESIGN findings

| Finding | Status | Note |
|---|---|---|
| claude-code 1: the release key is a fleet-wide root held by the agent | Partly | The key has moved out of the shared vault into the release host's TPM, and the publisher allowlist is now compiled in, so both checks must pass. But the release host is a machine the agent controls, so the agent can still use both factors. A lost release host also has no recovery path (R6-D1). |
| claude-code 2: owner-signed records have no freshness | Resolved | 10-minute expiry, and the number advances on every mode change. |
| claude-code 3: Stores and Remover contradict each other | Resolved | A retirement row any machine may write, carrying an owner record. Which key verifies it is open (R6-P3). |
| codex 1: the PC does not verify the initial grant | Resolved | A `grant` record with order 0 binds `d`, the home key, the mode and the pairing attempt. The PC enables nothing until it verifies. |
| codex 2: owner records do not sign the full payload | Resolved | A canonical encoding of the whole record, including replacement keys. There is a substitution test. |
| codex 3: asymmetric partition; running calls on connection loss | Resolved | Pending until the PC signs an acknowledgement. The app states the asymmetric case. The PC cancels calls when the socket drops. That cancellation has its own conflict (R6-D3). |
| codex 4: retirement when the old home is gone | Resolved | |

**Totals: 9 of my round-5 items: 8 resolved, 1 partly. 7 external DESIGN items: 6 resolved, 1 partly. None left unresolved.**

## DESIGN findings

### R6-D1. The release key can still be used by the agent, and losing the release host leaves no recovery path (§Updates; §Building) — SECURITY

Draft 6 keeps the release key "non-exportable in the release host's TPM", and the release host is "a Windows host the agent controls (the Mama PC)". Being non-exportable stops the key from being copied. It does not stop it from being used: any process running as that Windows user can sign with it.

The Artifact Signing credentials that the release step uses must sit on the same host for the same unattended step. So "neither the release key nor the signing account alone can push code" is true, but one party, the agent, holds both. The honest limit ("someone who controls the release host and the signing account together") does not say that this someone is the agent itself, whose sessions read web pages and email.

The opposite failure is also unhandled. If the Mama PC's disk or TPM is lost, the release key is gone. "A new release key is announced in a manifest signed by the current key" then cannot run, and every installed PC can never update again, short of a manual reinstall by each person.

This is a fleet-wide code-execution root and a compiled-in, published trust anchor, so it is never cheap to change after shipping.

**Fix, both parts:**
- Require a human factor for every release. For example, compile Justin's release-approval public key (a presence key, which the PC already knows how to verify) and require it to countersign the manifest hash with Face ID. Or make the Artifact Signing step need Justin's interactive sign-in. If neither is wanted, put "the agent alone can ship code to every connected PC" into Justin's four-part ask as a decision, not just a footnote.
- Compile in a second, offline recovery key held by Justin (for example on paper or in a hardware key), which can sign a key-rotation manifest. Add a test: a rotation signed by the recovery key is accepted, and one signed by neither key is refused.

### R6-D2. The gate as specified does not match the gate as built: the one-tap approval does not exist, every command becomes an LLM call, and an LLM outage turns every command into an owner tap (§Agent side "The agent's own safety gate"; decision row "Whether a PC command or file change is sent")

`ExternalOperationGate.evaluate` behaves in four ways that matter here:
- It needs `mutability`, `reversibility` and a scope from the caller (`computeRiskLevel`, `ExternalOperationGate.ts:163`).
- At medium risk or above it consults an LLM (`:376-385`).
- If that LLM call fails, it falls back to `show-plan` (fail-closed, `:541-545`).
- A single irreversible modify is medium (the matrix in `computeRiskLevel`).

The spec says "every command" is classified by kind and reversibility, with "deletes of many files or a whole folder classed as irreversible". A PowerShell command is opaque text. The home machine cannot tell a delete from a read without parsing or an LLM, so a builder would have to class every exec conservatively as modify and irreversible. That gives:
1. one LLM call per command and per file overwrite;
2. while the LLM is down or rate-limited, every command `show-plan`s, which floods the owner with taps, against P17 (bounded notification surface).

Separately, "show-plan holds it for the owner's yes in the app (one tap)" names a surface that does not exist. The gate only returns a plan; the existing hook shows it in the session and the approval happens in chat. There is no route for approving a held operation, the held call has no state in the `callId` protocol, and it is not in the app-lane contract.

**Fix. Frontload:**
- **Classification:**
  - `exec` defaults to modify, partially reversible, single scope (low, so it proceeds without an LLM call);
  - `/files` delete is classed by item count through `scopeFromCount`, and a recursive folder delete is bulk;
  - a file write that replaces an existing file is modify, irreversible, single.

  So only real deletes and bulk operations reach the LLM or the owner.
- **The approval surface:** an existing one-tap surface (a Work Board card or an Authorization Request), with the held call in a new `held-for-approval` call state that expires (default 1 hour, judgment row).
- **LLM failure:** a bound on prompts, for example one card per session per outage, and further held calls refused with `gate-unavailable`.

Add the held state to the app-lane contract. Tests: a 1,000-command run makes no LLM calls; with the LLM down, a delete makes one card, not many.

### R6-D3. Cancelling on disconnect conflicts with resumable transfers and can leave half-written files (§Connection "When the PC's socket drops"; §Results and files) — DATA LOSS

"When the PC's socket drops, the PC cancels every running call". That covers file streams, while the file relay promises "resume by offset", and the integration test "streams a file with a resume". The two rules conflict for any transfer that crosses a reconnect.

A Wi-Fi change or a home restart (missed pongs within 60 s) also cancels a write that is replacing a file in place, leaving the person's file truncated. With Stop the person chose that outcome. With a network blip nobody did. Long commands such as an install or a build are also killed partway with no result kind the session can recognise.

**Fix.**
- Writes to the PC go to a temporary file beside the target and are renamed into place only once complete, so a cancelled write never damages the original.
- On disconnect, commands are cancelled with the result `cancelled-disconnected`.
- File transfers pause and can resume by offset for a stated window (for example 10 minutes, judgment row) after the socket comes back, and are discarded after that.
- Tests: a write cut mid-stream leaves the original intact, and a transfer resumes across a reconnect.

### R6-D4. The owner-conversation credential does not say how it survives a server restart or reaches a session that already exists (§Agent side "Who may call")

The credential is "issued only when the server spawns a session for an inbound message from the owner". Owner sessions usually outlive the server: tmux sessions survive updates and restarts, and owner messages are injected into the running session rather than starting a new one.

If the credential store is in memory, or is not re-enrolled at boot, then after every auto-update the owner's live conversation is refused by `/computers` until that session happens to be respawned. The taint rule's "until the owner's next message" will not restore it either, because the next message is an injection, not a spawn.

The same question applies to sessions moved to another machine (mesh `transfer`/`place`), and to owner sessions running when the feature is first switched on.

`OriginSessionRegistry` solved the same problem with a persisted file and `enrollExistingOriginSessions` (`SessionManager.ts:1029`).

**Fix.**
- Store the credential durably on the issuing machine.
- Issue or refresh it when an owner message is delivered into a session, not only at spawn, which also clears the taint.
- Do not carry it across a transfer: the target machine issues one at the next owner message.
- State that sessions already running when the feature turns on get it at their next owner message.
- Add the store to the multi-machine posture (machine-local, `physical-credential-locality`).
- Tests: after a server restart, the next owner message restores access; a job still never gets it.

## PRECISION findings

- **R6-P1 (Frontloaded Decisions and decision rows are stale and contradict the body).** Three entries are out of date:
  - "proposed by uptime" should be the phone-paired, named-tunnel-then-`lastSeen` rule;
  - "a release key in the agent's vault that signs the allowed-publisher list" should be the TPM key plus the compiled allowlist (and R6-D1);
  - "Callers: … by origin credential", and the row "Whether a call reaches /computers … by its origin credential", should be the new owner-conversation credential.

  The approval ask and the builder read this section first.
- **R6-P2 (Multi-machine posture).** Add four items:
  - the owner-conversation credential store (R6-D4);
  - the retirement-row exception to "written by the home machine" (the posture still says home-only);
  - held gate calls: machine-local on the home machine;
  - the PC's signed acknowledgements, recorded on the home machine.
- **R6-P3 (Which key verifies a retirement row).** Any machine "may write" it "when it carries an owner-signed record". Say which phone key verifies it. Connect again is also the recovery path for a lost phone, and in that case the old record's pinned phone key does not match the new phone. Suggestion: the record is verified against the new extender record's grant, whose phone key the new home checked at approval. A failure leaves the old record shown as stale, never active.
- **R6-P4 (Reducing orders should not need exactly the next number).** With "exactly last + 1", a console Lower that lands first makes the owner's direct Remove fail and need a fresh Face ID. A Lower or Remove can safely apply at any number above the last applied, because replaying a reduction gives the agent nothing it could not do with a console Lower. Raises and key changes keep the exact-next rule.
- **R6-P5 (Expiry handling).** Three cases need stating:
  - The app's "keeps retrying while open" must re-sign after 10 minutes, so say it asks for Face ID again and why.
  - A record refused for clock difference must say so on the tray and in the app.
  - The `grant` is subject to the same expiry, so a PC whose first socket opens more than 10 minutes after approval (for example because it slept) needs a stated outcome: show "Approval timed out; scan again", never a silent dead pairing.
- **R6-P6 (The gate's reach).** Input (typing into a terminal, clicking "Delete") and a script written and then run all skip the gate. Say the gate is the agent's own self-check signal, not containment. Mode enforcement on the PC is the boundary.
- **R6-P7 (Console typing taints the owner session).** The console composer reaches a session through the bearer input path, so the owner's own console typing removes `/computers`. Either say so, or have the console composer route (dashboard-session authenticated) count as owner input.
- **R6-P8 (Rollback wording).** "Unmounts `/computers`": Express does not unmount routes. Say each request reads the switch live (carried over from R5-P10).
- **R6-P9 (Windows tests).** "the per-session toast" should be "the per-session window", to match the body.
- **R6-P10 (Fixed-tag asset swaps).** Replacing assets on one tag is not atomic. Upload builds under versioned names first and replace the manifest last, so a PC never reads a manifest that names a missing build.

## Fixed-limit contest

| Limit | Basis | Verdict |
|---|---|---|
| Owner-record expiry 10 min, clock difference 5 min | judgment; the number advances on every change; arbiter the owner | Cleared (R6-P5 for handling) |
| Home proposal (talking-to, then named tunnel, then `lastSeen`) | judgment; the person picks | Cleared |
| Update retry hourly on failure | liveness floor; the tray says so | Cleared |
| Connect wait 8 s / 30 s, idle 30 s, exec 2 min, inline 1 MB, tray raise 2 min, breaker 7 days | as round 5 | Cleared (6) |
| Chunk 256 KB, heartbeat/backoff, 40-character clip, 100-row page | protocol or derived | Cleared (4) |
| Gate held-call lifetime | not stated | Needs a row (R6-D2) |
| Transfer resume window after reconnect | not stated | Needs a row (R6-D3) |
| Sign-in notice 15 s | no row | Advisory |

## Decision completeness

- **Frontloaded.** 15 entries, three of them stale (R6-P1).
- **Money and identity.** The Azure cost and the publisher name are correctly in Justin's ask. The release trust root (R6-D1) belongs there too and is not.
- **Cheap.** Cheap judgment defaults: the 10 values above plus the expiry. None touches money, identity or a published interface.
- **Where a builder would still stop to ask:**
  - exec classification and the approval surface for held calls (R6-D2);
  - how cancel interacts with resume (R6-D3);
  - credential lifetime across restarts (R6-D4);
  - release custody (R6-D1).
- **Cross-boundary work.** The held-call approval card must be added to the app-lane contract (R6-D2). The other items have routes.

design: 4, precision: 10; frontloaded 15, cheap 11, contested-cleared 13
