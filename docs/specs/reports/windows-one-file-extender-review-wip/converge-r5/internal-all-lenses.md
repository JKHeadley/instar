# Round 5: internal review, all six lenses (draft 5, "smallest safe form")

Reviewer: one internal pass covering security, adversarial, scalability, integration/deployment (with multi-machine posture), decision-completeness and lessons-aware. Read only. Spec: `docs/specs/windows-one-file-extender.md` (draft 5). Parent: `docs/specs/mac-qr-pairing.md`. Code claims checked against this worktree's `src/`, `site/` and `.github/`, plus one live `gh release list` on the instar repo.

Not re-raised: the "The Person Decides" exception (app required). The spec's reasoning still holds against the source. No dashboard presence approval exists, and an operator session or a Telegram button proves the conversation, not a person.

## Round-4 check-off

### security-adversarial.md (5 design, 10 precision)

| Finding | Status | Note |
|---|---|---|
| F1 jobs bypass `/computers` (session input, token reading) | Resolved | The claim is narrowed to "a filter, not an isolation boundary". It now uses the existing origin credential, a taint on `POST /sessions/:name/input` and an honest limit in the consent text. The credential has its own problem (R5-D2). |
| F2 owner orders have no order number | Resolved, with a gap | It now has a purpose string, device id, fingerprint and an exactly-next order number. A held raise still survives a Lower that was not owner-signed (R5-D4). |
| F3 slot squatting | Moot | Beacon and orders slots removed. |
| F4 agent-made raise prompts | Resolved | A raise needs either an owner-started raise or a tray request signed with `d` within the last 2 minutes. |
| F5 Look only reads credentials | Resolved | Honest text, plus a credential-folder list the person can lift. |
| P1 frames not bound to the connection | Resolved | Signatures cover the handshake transcript hash. A domain tag is still missing (R5-P14). |
| P2 beacon binding | Moot | |
| P3 lease-holder restart sync | Moot | Single writer on the home machine. A narrower restore case remains (R5-P7). |
| P4 Full-control limit on owner orders | Resolved | "A home machine that refuses to pass an owner order on is outside what v1 protects" is stated. |
| P5 names are chosen by the attacker | Partly | The spec says safeguards "do not rely on them alone" and shows the fingerprint. The display still frames the names as fact (R5-P5). |
| P6 old-home release must verify the move | Moot | |
| P7 approval bound to the scanned `d` | Resolved | |
| P8 residual injection paths | Partly | Web pages, email and tool output are named. "Only connect a PC you are sitting at" did not make it into the phone line. |
| P9 drop scope | Resolved | The drop is used only during pairing, with a paste fallback. |
| P10 `issueSessionToken` citation | Moot | The token was removed. |

### integration-scalability.md (8 design, 10 precision)

| Finding | Status | Note |
|---|---|---|
| D1 squatting | Moot | |
| D2 drop 60/min budget | Moot | |
| D3 sealing to `d` | Moot | Sealed to the one-time key `k`, as on the Mac. |
| D4 mint/redeem gates and quick tunnel | Partly | The mint branch and dropping the quick tunnel are specified. The redeem route still has the approval/lease gate and writes `DeviceRegistry` (R5-D3). |
| D5 restart gate | Moot | |
| D6 MeshRpc 5 s and duplicate exec | Resolved | `callId` dedupe, accept-now, collect by id. |
| D7 file relay is new | Resolved | |
| D8 audit replicated | Resolved | Audit is machine-local on the home machine. `computerExtenders` is on compliance hold. |
| P1 `RECONCILER_ALLOWLIST` worded backwards | Not resolved | R5-P1. |
| P2 session-token details | Moot | Superseded by the origin credential (R5-D2). |
| P3 dark-gate lint and `/features` entry | Not resolved | R5-P2. |
| P4 live read and 404 mapping | Resolved | |
| P5 posture declarations | Partly | R5-P4. |
| P6, P7, P8, P9 (orders, slot encoding, beacon lifecycle, cost) | Moot | |
| P10 per-session fairness | Resolved | "Taking sessions in turn". |

### decision-lessons.md (6 design, 8 precision)

| Finding | Status | Note |
|---|---|---|
| D-1 decision rows contradict the text | Resolved | |
| D-2 slots | Moot | |
| D-3 jobs refused does not hold | Resolved | Stated as a filter, with its limit. The replace-or-add question is moot. |
| D-4 home offline and home choice | Resolved, with a new gap | Home is proposed, the person picks, and the agent sends one notice per outage. The candidate set ignores where the phone is paired (R5-D1). |
| D-5 republish breaker | Moot | |
| D-6 Vercel bill and widened exception | Moot | |
| P-1 head and tail | Resolved | |
| P-2 ellipsis | Resolved | |
| P-3 missing decision rows | Partly | The remote-control list is now given. The 15 s sign-in notice has no row (R5-P3). |
| P-4 restart sync | Moot | |
| P-5 machine-local justification reason | Partly | Design choice 2 now gives the real reason (the agent cannot add trusted keys). The posture line still cites only locality. Acceptable under the three allowed keys. |
| P-6 frontmatter and four-part ask | Resolved | |
| P-7 funnel measurement | Resolved | |
| P-8 quick-tunnel limits | Moot | |

### external-claude-code.md (8)
Resolved: 2 (replay), 3 (removal rule), 4 (publisher rotation, now a release-key-signed list; the manifest URL itself is wrong, R5-D5), 5 (drop optional again), 6 (alternative design discussed in design choice 2), 7 (residual injection). Moot: 1 (orders slot), 8 (restart gating).

### external-codex-cli.md (4)
Resolved: replay binding; the token-isolation claim narrowed. Moot: delivering moves to connected PCs (no remote move); the two-minute bound.

**Check-off totals (59 items): resolved 28, partly 6, not resolved 2, moot 23.**

## DESIGN findings

### R5-D1. The home machine can be one where the owner's phone is not paired, and no 7-day uptime record exists (§Which machine is home; §Device class; §Connection "directly to the home machine")

The spec assumes several things:
- The phone's request can be forwarded to any machine that has a pairing address.
- The mint can be "made on the chosen machine (forwarded over mesh RPC)".
- Approval on that machine's `POST /mobile/extenders/:id/approve` "accepts only a presence-signed approval from the owner's paired phone".

Phone authentication is machine-bound. `MobileDeviceKeyLedger.ts` (header): "The ledger GRANTS NOTHING: device authentication stays machine-bound". The parent spec's posture says "A phone can mint only on the machine its device record lives on" (mac-qr-pairing, Multi-machine posture). The presence key lives on the per-machine `DeviceRecord` (`mobilePairingRoutes.ts:1054-1056`, `d.presenceKey`). The ledger does not hold it.

When the person picks a home where their phone has no device record, three things fail:
- that home cannot verify the extender approval;
- the mint route's `principalOf(req)` device check cannot be satisfied by a mesh-forwarded call;
- the phone's pending-row read and direct Lower/Remove have no authenticated route there.

A builder must stop and choose between restricting candidates and inventing cross-machine phone authority. The second is an identity decision and is never cheap.

Separately, the default ranking is wrong about its data. "Longest unbroken uptime over the past 7 days (from the machine registry)" names a field that does not exist. The registry entry has `lastSeen` (`src/core/types.ts:2374`). The only online-run tracker is `SustainedOnlineTracker`, which is in-memory and resets at boot.

**Fix.**
- Home candidates are machines that hold an active device record for this owner phone with a presence key on file, and that have a pairing address.
- In the normal case the home is the machine the phone is talking to. A different machine is offered only if the phone is paired there too.
- Rank by an existing signal, for example the machine's pool role (always-on or lease-holding) and `lastSeen`. Alternatively, specify a new persisted uptime record and its posture.
- Add a unit test that picking a machine without the phone's record is refused with plain words ("Your phone isn't connected to <machine>").

### R5-D2. The caller credential exists only on Telegram agents, and jobs hold it too (§Agent side "Who may call")

The filter uses "the server's existing per-session origin credential (`OriginSessionRegistry`...)". Two facts from `src/` change what gets built.

1. **It is wired only when Telegram is enabled.** `SessionManager.setOriginLifecycle` has a single caller (`src/commands/server.ts:7867`), inside `if (originTelegramConfig)`, where `originTelegramConfig = config.messaging.find(m => m.type === 'telegram' && m.enabled)` (`:7798`). On an agent with no Telegram, `originLifecycle` is undefined and every session gets an empty `INSTAR_ORIGIN_TOKEN` (`SessionManager.ts:1083-1086`). That includes app-only agents, the population most likely to use a feature that requires the app. `/computers` would then refuse every caller and the feature would be dead.
2. **Jobs get the credential too.** Headless and job spawns issue origin tokens exactly like interactive sessions (`SessionManager.ts:5009` in `spawnSessionInternal`; interactive at `:5512`). The binding holds `sessionId`, harness, project and model (`OriginSessionRegistry.ts` `OriginSessionBinding`). It holds no conversation and no owner. "Identified by the origin credential" therefore identifies a session, not "a session serving the owner's own conversation".

**Fix.** Two decisions.
- Wire the origin registry for `/computers` independently of Telegram. The lifecycle would be created whenever `computers.enabled` is on, with its own posture line (machine-local per issuing machine, `physical-credential-locality`). Otherwise the spec must state that Telegram is required, which conflicts with the app-first story.
- Name the classifier that turns a verified binding into "owner conversation". For example: the session's record has no job slug and is bound to a conversation (a Telegram topic, app conversation or Slack channel) whose audience is the owner alone. Add tests: an app-only agent's owner session is admitted, and a job session holding a valid origin token is refused.

### R5-D3. The existing redeem route would refuse extenders on most homes, or write them into `DeviceRegistry` (§Device class; §Pairing hand-off)

The spec puts the extender branch on the **mint** route ("skips ... the Telegram approval path"). Redeem has the same gate and an incompatible write. `MOBILE_REDEEM_PATH` refuses with `approval-unavailable` when there is no approval path, or when the path is Telegram and this machine is not the lease holder (`mobilePairingRoutes.ts:1268-1273`). It does this before it reads the code. On success it calls `svc.devices.createPending(...)` with `role: 'owner'` by default (`:1312-1316`).

So an extender redeemed on a non-lease-holder home with Telegram approval is refused. If the gate were skipped, the extender would land in `DeviceRegistry`, breaking the spec's "never written to the per-machine `DeviceRegistry`" invariant that the deny-by-default walk depends on.

**Fix.**
- Specify a separate extender redeem (for example `POST /mobile/extenders/redeem`), or a branch that peeks the code's `deviceClass` before the approval gate.
- That path keeps `redeemHostEligible` and the local-TLS check, skips `approvalPath()` and the lease, and writes a pending row to the extender store only.
- Add a unit test: an extender code redeemed on a non-lease machine succeeds and leaves `DeviceRegistry` unchanged, and an owner code still gets `approval-unavailable` there.

### R5-D4. A raise that was held back survives a tray or console Lower (§The PC checks the agent "Owner-signed records"; §Lowering/Raising)

The order number advances only on owner-signed records. A Lower from the tray (local to the PC) or from the web console (sent by the home machine) does not advance it.

An honest sequence shows the problem:
1. The owner raises in the app while the PC is offline, so the home machine queues raise #n+1.
2. The person at the PC presses Lower in the tray.
3. The PC reconnects, receives raise #n+1 (still exactly last+1) and returns to Full control.

The person's most recent choice is overturned. A misbehaving home can do the same on purpose by withholding a raise. That defeats "the agent cannot raise its own access" against the one path the person controls directly. The spec's own "an old raise can never be replayed after a later Lower" holds only for owner-signed Lowers.

**Fix.** Any Lower the PC applies, whatever its source, advances the PC's order number. A raise also carries `issuedAt` and is refused after a stated window (default 5 minutes, judgment row; arbiter: the owner, who raises again). Add tests: queued raise, then tray Lower, then reconnect means the raise is refused; and console Lower, then held raise, means it is refused.

### R5-D5. The compiled-in update address resolves to the wrong release (§Updates)

`https://github.com/JKHeadley/instar/releases/latest/download/instar-connect-manifest.json` follows the repo's single "Latest" flag. Today that is `v0.17.14` from 2026-03-12 (`gh release list`). The repo also cuts `mac-app`, development, threadline and npm-version releases. Whichever release is marked Latest wins, and none of them carries the Connect manifest. Every fielded PC would get a 404, or another stream's asset.

The address is compiled in and is the only update path. An error here strands every installed build permanently, so it is a published interface and never cheap.

The repo already solves this for the Mac app with a fixed tag: `site/src/pages/mac/appcast.xml.ts:11` uses `releases/download/mac-app/appcast.xml`.

**Fix.** Use a fixed tag, `https://github.com/JKHeadley/instar/releases/download/instar-connect/instar-connect-manifest.json`. The release step replaces the assets on that tag and never sets Latest. Add a release-gate check that the compiled-in URL returns the signed manifest.

### R5-D6. With a Tailscale-only home, the PC cannot connect unless it is on the owner's tailnet, and nothing says so (§Addresses; journey step 6)

The spec admits the home's Tailscale name ("The program never installs Tailscale"). A Tailscale HTTPS name resolves and routes only from a device on that tailnet. The PC would open the drop, show Connect, fail to redeem, and then loop on reconnect backoff. The parent flow warns here ("a Tailscale link opens only with Tailscale on"). This flow has no such step.

**Fix.**
- After opening the drop and before enabling Connect, the PC makes one reachability probe to the origin. On failure it shows plain words. For a Tailscale origin: "This PC can't reach <machine>. It's on a private network (Tailscale). Turn on Tailscale on this PC with the same account, or ask <agent> to set up a public address." Otherwise: "<machine> isn't answering."
- Prefer a named-tunnel machine among home candidates.
- Add a Windows test for the unreachable-origin message.

### R5-D7. PC commands and file deletes bypass the External Operation Gate (lessons L11; §What the agent can do)

L11 (Design-pipeline application): "Any spec proposing a new 'kind' of operation (write/modify/delete/read) must register classification rules", and agent-side caution on irreversible external effects runs through `ExternalOperationGate` (`src/core/ExternalOperationGate.ts`, `POST /operations/evaluate`).

`/computers/:id/exec` and file write/delete are irreversible operations on a person's machine. They are called by curl from a session, so neither the `mcp__*` PreToolUse gate nor the Bash destructive-command guards see the PowerShell inside. The incident L11 was born from, an agent wiping a user's mailbox, has a direct PC analogue: bulk file deletion.

Consent covers what the agent may do. It does not cover the agent's own self-check. The decision table even marks a PC command irreversible.

**Fix.**
- The home machine classifies each call before sending it: file delete and write are `delete`/`write`; exec is `modify` with reversibility `irreversible`.
- It evaluates the call through the existing gate under a service name `windows-pc`. `show-plan` and `block` reach the calling session as a refusal with the gate's reason. The gate is a signal with its own trust gradient, not a containment boundary.
- Read-only calls (screenshot, list, read) skip the gate.
- Add a unit test: a bulk delete is routed to `show-plan`.

## PRECISION findings

- **R5-P1 (Stores).** "a reconciler registration (listed in `RECONCILER_ALLOWLIST`)" is still self-contradictory. The allowlist names stores the reconciler does not cover (`ReplicatedStoreReconcilerWiring.ts:54`). Say: allowlisted with the reason "written only by the extender routes on the home machine; no CLI path".
- **R5-P2 (Config).** Classify `computers.enabled` for the dark-gate lint (`DARK_GATE_EXCLUSIONS` in `src/core/devGatedFeatures.ts`, or dev-gated with the default omitted), and register a `/features` entry so its effective state is truthful.
- **R5-P3 (Decision rows).** Two values still have no row. The 15 s sign-in notice (a UX constant; cheap). "Once per outage" for the home-offline notice: define an outage, for example from the first `home-offline` until the next successful call.
- **R5-P4 (Multi-machine posture).** Declare four things:
  - the origin credential: machine-local per issuing machine, `physical-credential-locality`, verified by the caller's own machine before forwarding;
  - where extender approve and redeem run: the home machine only, given R5-D1;
  - the result and ticket store for forwarded calls: machine-local on the home machine;
  - the per-PC order-number mirror.
- **R5-P5 (Names).** Frame the displayed names as "an agent its owner calls '…'". Put the fingerprint words beside them on the sign-in notice and toast, not only at Connect.
- **R5-P6 (Console Lower/Remove with the home offline).** The app path is specified (retry while open). The console path is not. State that the console refuses with `home-offline` and plain words, since the PC is not reachable by the agent then either.
- **R5-P7 (Home restored from backup).** A home restored from a backup older than a Remove could accept a PC that was offline at removal time, before its own rows come back from peers. Either refuse extender handshakes after a restore until one journal pull from a peer has applied, or state the residual.
- **R5-P8 (Forwarded calls).** State three things: the `callId` dedupe lifetime (the call's lifetime plus a margin); how long uncollected results and tickets stay on the home machine (Disk Steward floor, then a stated age); and that the calling session's end, Stop and Lower cancel by `callId`. Name the new `MeshCommand` variants (`MeshRpc.ts:28`) and their RBAC.
- **R5-P9 (Routes).** The extender approve needs a presence challenge endpoint (as the `owner-presence` routes have, `mobilePairingRoutes.ts:2716-2721`) and entries in the device-route table. `/computers/link` must sit outside the bearer middleware and authenticate only the extender signature.
- **R5-P10 (Rollback wording).** Express cannot unmount routes. Say "every `/computers` request reads the switch live and refuses with `feature-off`".
- **R5-P11 (Release key custody).** The release key that signs the allowed-publisher list sits in a vault that every session of the agent can read as the same OS user. With it, plus a GitHub release write and any Artifact Signing identity (US$10 a month, the attacker's own ID), an attacker could ship code to every fielded PC whose server asks it to update. State this. Require that any change to the publisher list is a four-part ask to Justin. Consider keeping the release key off the agent's machines.
- **R5-P12 (Connect again).** State that the PC deletes the old CNG key and state only after the new approval completes, and that the old home closes on seeing the new home's revocation row.
- **R5-P13 (Order number start).** State that approval sets the order number to 0, so the first raise is 1, and that the phone learns the current number from the home's mirror before signing.
- **R5-P14 (Frame domain tag).** Add a versioned purpose string (`instar-pc-frame-v1`) to frame signatures. Other machine-key signatures could then never be read as a PC frame.

## Fixed-limit contest

| Limit | Basis | Verdict |
|---|---|---|
| Connect wait 8 s / 30 s | judgment; floor never instant; arbiter the person | Cleared |
| Typing idle 30 s | judgment; courtesy; the person can lift it | Cleared |
| Exec time 2 min | judgment; the caller states it; Stop always works | Cleared |
| Inline 1 MB | judgment; head and tail kept; ticket | Cleared |
| Tray raise valid 2 min | judgment; PC signature is the floor | Cleared |
| Breaker 7 days, then hourly | judgment; never gives up on its own | Cleared |
| Chunk/frame 256 KB | protocol constant; resumable | Cleared |
| Heartbeat 30 s / 2 missed; backoff 1 s to 5 min | liveness floors | Cleared |
| Name clip 40 characters | derived from the 2,048 cap; ellipsis shown | Cleared |
| Audit page 100 rows | cursor, not a cap | Cleared |
| "7 days unbroken uptime" for the home proposal | claims a data source that does not exist | Not cleared (R5-D1) |
| Update URL `releases/latest` | published interface, compiled in | Not cleared (R5-D5) |
| Sign-in notice 15 s | no row | Advisory (R5-P3) |

## Decision completeness

- **Frontloaded.** 15 entries in Frontloaded Decisions. Money (Azure, about US$10 a month) and identity (publisher name) both go to Justin as the four-part ask. That is correct.
- **Cheap.** Cheap-to-change judgment defaults behind the dark window: wait times, the remote-control list, the credential-folder list, idle time, the tray-raise window, exec time, inline size, the breaker and the home heuristic. None of them touches money, identity or a published interface, except the home candidate set (R5-D1, identity) and the update URL (R5-D5, published interface). Those two are not cheap.
- **Where a builder would still stop to ask:**
  - which machines may be home (R5-D1);
  - how the caller filter works on a non-Telegram agent (R5-D2);
  - which redeem route an extender uses (R5-D3);
  - whether a tray Lower invalidates a queued raise (R5-D4).
- **Cross-boundary work.** The app lane (contract file, commitment, build number), Android, team sharing and the hosted relay each have a route and a place on the list.

design: 7, precision: 14; frontloaded 15, cheap 9, contested-cleared 10
