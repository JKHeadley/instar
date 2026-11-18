# Round 4: security and adversarial review (draft 4)

Reviewer: internal security + adversarial lens. Read only. Spec: `docs/specs/windows-one-file-extender.md` (draft 4), parent `docs/specs/mac-qr-pairing.md`. Code claims checked against the worktree's `src/`.

## Round-3 security/adversarial findings: status in draft 4

| Round-3 finding | Status | Note |
|---|---|---|
| PC cannot check the phone's approval of a raise (clean-door 1) | Resolved, with a gap | Phone presence key pinned; the PC verifies the raise itself. Raise frames have no order number, so they can be replayed (F2). |
| Update check pins signer by name (clean-door 2) | Resolved | Identity-validation OID, Microsoft root, RFC 3161 timestamp, fixed manifest address, newer-than-installed check. |
| Sessions reading outside content can run commands (clean-door 3; lessons caller carrier) | Partly | Jobs get no token, but any bearer holder can type into an owner session, and the token sits in an environment other same-user processes can read (F1). |
| Tech-support scams (clean-door 4) | Resolved, with a gap | Sign-in notice, per-session toast and named owner were added. The names shown are still chosen by the attacker (P5). |
| Remote-control blocklist had blocking power | Resolved | Now a warning plus a longer wait, also shown on the phone. |
| Revocation depends on the lease holder | Resolved by redesign, with a gap | One home machine and a restart sync rule. A home machine that is the lease holder syncs with nobody (P3). |
| Sequence per connection or per generation | Resolved, with a gap | Per connection. Frames are not bound to the connection (P1). |
| The MAC protects nothing under Full control | Resolved | Stated beside the MAC. |
| Continued operation during a partition (codex 1) | Partly | The home machine holds both the socket and the decision, and phone orders go through the drop. Anyone who knows `d`, including the agent, can squat that orders slot, and the cache is best effort (F3). |
| Switches overstated the capability split (codex 2) | Resolved, with a gap | Two modes now. "Look only is a real limit" overstates what reading files allows (F5). |
| Address failover vs machine-local codes (codex 3) | Resolved | Redemption happens on the home machine. |
| Drop payload limit (codex 4) | Resolved | About 1,100 chars at most; anything larger is refused. My arithmetic gives under 1,000, which is consistent. |

## DESIGN findings

### F1. The jobs-cannot-command-the-PC guarantee can be bypassed in two ways (§Agent side, "Who may call"; decision point "Who may call /computers")

The spec says scheduled jobs and other sessions "have no such token and are refused in v1, so a hostile email read by a job cannot become a command on the PC". Two existing paths defeat this:

1. **Typing into the owner's session.** `POST /sessions/:name/input` (`src/server/routes.ts:13067`) takes the agent bearer token and types up to 100 KB into any running session. Every job session holds that token. A job that has read a hostile email can type "run this on the PC" into the owner's live conversation session, and that session then calls `/computers` with its own genuine token. The "home machine checks the token's session" step passes, because the token really is that session's.
2. **Reading the token.** The new token would reach the session the way session tokens do today, as a tmux environment variable (`-e INSTAR_AUTH_TOKEN=...`, `SessionManager.ts` around line 8510). Any process running as the same OS user can read it, including a job session or an `npm` postinstall script started by any session (`tmux show-environment -t <session>`, `ps eww`). A bearer secret in a shared-user environment shows which session a call came from. It does not prove the call came from the owner's turn.

**Fix.** Tie `/computers` admission to where the request came from, not only to a session secret:
- Reuse the existing per-session origin credential and native-hook proof (`INSTAR_ORIGIN_TOKEN`, `src/messaging/telegram-origin/OriginNativeHookProof.ts`, `OriginToolGuard.ts`). It already proves that a tool call came from a given native session incarnation through a PreToolUse hook. A new parallel token kind is not needed.
- Taint a session for `/computers` as soon as it receives text through the bearer `POST /sessions/:name/input` path, or through any input whose origin is not human-verified. The taint clears only when the next message arrives with a verified human origin (an app message with its device signature, a Telegram message from the owner, or the owner phone's signed session input).
- Add tests. A job types into the owner session, and the next `/computers` call is refused with a plain reason. A token copied from the session environment and replayed from another process is refused.
- If neither change is wanted, state the bypass as a residual risk in the consent text and in the approval ask. At present the spec claims the opposite.

### F2. Phone-signed owner orders have no order number, domain tag or PC binding, so an old raise can be replayed (§"Changing mode", §"Owner orders that do not depend on the home machine", §"Moving a PC")

A raise is "a frame signed by the owner's phone presence key", carried to the PC by the home machine. The home machine therefore keeps a valid signed raise. After the owner lowers the PC to Look only, the agent can send that same raise again, and the PC will accept it: the spec gives raises no sequence number, expiry or nonce. Only moves carry `moveSeq`. Ordering also goes wrong for honest traffic. A Lower that machines keep re-publishing "until the confirming row replicates back" can land after a newer raise and undo it. Nothing tells the PC which owner order is the latest.

The existing presence messages are separated by purpose but bound to a server challenge and host (`ownerPresenceMessage(version, deviceId, host, challenge)`, `src/server/mobileOwnerPresenceRoutes.ts:76`). That suits online server routes. The PC checks orders offline and cannot use a server challenge.

**Fix.** Every phone-signed order the PC verifies (approve-time mode, raise, Lower, Remove, move, phone-key change, rotation countersign) should be signed over a versioned purpose string, for example `instar-extender-order-v1`. The signed bytes should include `{pcDeviceId, d fingerprint, kind, mode, orderSeq, issuedAt}`. Use one monotonic `orderSeq` per PC, shared by every order kind and kept by the phone. The PC stores the highest number it has seen beside the mode and applies an order only if its number is higher. A Remove applies at any number. Add tests: replaying an earlier raise after a Lower is refused, and an old Lower arriving after a newer raise is ignored.

### F3. The address and orders slots can be squatted indefinitely, including by the agent the orders slot guards against; delivery is also best effort (§"Address beacon", §"Owner orders"; decision point "Whether the PC applies an owner order received outside the socket")

The slot name is "a hash of `d` and the current 120-second window". `d` is a public key. The QR showed it on screen, and the agent's own replicated `computerExtenders` store holds it, so every agent session can read it. Anyone who knows `d` can compute every future slot name. The drop is first-writer-wins: a PUT to an occupied slot gets 409, and a GET returns the first value (`mac-qr-pairing.md` §5). One junk PUT per window, well under the 60-a-minute rate limit, blocks the slot for that whole window, every window. So:

- The spec says a squatter can only "delay reconnection by a window". In fact they can block it for as long as they like.
- The orders slot exists so that the owner's Lower or Remove reaches a PC whose home machine will not pass it on. The party most likely to want it blocked, a misbehaving session on the home machine, can block it at no cost. Under Look only, where the agent cannot touch the PC, this is the only path that does not go through the agent. The owner's Remove would then depend on the agent being removed.
- The drop is Vercel Runtime Cache, which is "non-durable … may evict before the TTL" (`mac-qr-pairing.md` §5). The claim "cannot keep it working against the owner's order for more than about two minutes" holds only on a good day.

**Fix.**
- Seal a 32-byte pairing secret `s` into the pairing drop, from the phone to the PC. It is never sent to any machine and adds about 43 chars, well under the cap.
- Derive the phone-orders slots as H(`s`, "orders", window). The phone publishes there itself on the Face ID tap and re-publishes while the app is open or woken.
- The PC answers with an ack signed by `d` in H(`s`, "ack", window). The phone shows "Removed: confirmed by <PC>" only after that ack. Otherwise it says the PC has not confirmed yet and keeps trying. Under Full control the agent can forge the ack (P4); state that limit.
- Keep the machine re-publication in a separate, `d`-derived slot family as a second path for honest partitions.
- Give the address beacon a slot secret too, for example one sent to the PC in the first signed frame. That stops strangers who saw the QR from squatting it.
- Restate the guarantee as "best effort through a cache that can evict; confirmed only by the PC's ack". Add a test: a squatter fills the `d`-derived slots and the phone order still applies.

### F4. A misbehaving agent can trigger Face ID raise prompts itself (§"Changing mode": "the tray's Allow full control sends the request to the phone")

The tray's raise request reaches the phone through the home machine, the same agent whose access would rise. Nothing in the spec lets the phone tell a request made at the PC from one the agent made up. A session in Look only can push "<PC> asks for full control" to the owner's phone whenever it likes, timed to look plausible, for example right after the owner asked for a task that needs it. The owner, used to approving with Face ID, taps. The rule that only the phone can raise still holds, but the decision now comes from a prompt the agent wrote.

**Fix.** The phone shows a raise prompt only when one of two things is true:
- The owner started the raise in the app.
- The PC signed the request with `d`, over `{deviceId, nonce, issuedAt}`, within the last 2 minutes. The phone checks this against the `d` it scanned.

Under Look only the agent cannot sign with `d`, because it cannot run code on the PC. The prompt says "Requested at <PC> by the person using it" and never shows text the agent supplied. Requests the agent made up are refused, and the attempt is audited. Add tests for the agent-made request and the replayed PC request.

### F5. "Look only is a real limit" leaves out that reading files can hand over the person's accounts (§"What the agent can do", the honest capability statement and the consent text)

Look only can "list and read files the person can reach". That includes SSH private keys, `.aws/credentials`, `.git-credentials`, `.npmrc` tokens, Firefox `cookies.sqlite` and `logins.json` with `key4.db`, password-manager exports, recovery codes in Documents, and remote-desktop or VPN profiles. All of these are readable by the person's user. In a scam, Look only already gives an attacker the victim's accounts with nothing on the PC changed. The consent text "change nothing" is accurate, but calling it "a real limit" next to Full control's "anything you can do" invites a false sense of safety. Scammers will steer people toward Look only for exactly that reason ("it can only look").

**Fix.**
- Consent text for Look only: "The agent can read any file you can, including saved passwords, sign-in cookies and keys, and can see anything on your screen."
- Add a v1 default under Look only: refuse reads under a shipped list of credential stores (`.ssh`, `.aws`, `.azure`, `.git-credentials`, browser profile folders, password-manager data folders) with `protected-path`. The person can lift it with a sub-option, as with typing. This is a signal-level floor; it does not claim containment.
- Add a Windows test for a protected-path refusal.

## PRECISION findings

- **P1. Frames are not bound to their connection or purpose** (§"The PC checks the agent"). The sequence runs per connection, but the signed bytes do not include the connection's challenge. A party in the transport path (the quick or named tunnel ends TLS at Cloudflare) could replay frames from connection N on connection N+1 at the same sequence positions. Fix: sign `{purpose "instar-extender-frame-v1", connectionChallenge, seq, body}`. The domain tag also keeps any other message the home machine's mesh key signs from being accepted as a PC frame. Results from PC to agent are protected only by the tunnel's TLS; say so (they are untrusted data in any case).
- **P2. Beacon and move records need binding to their slot and freshness** (§"Address beacon"). Use the slot name as the HPKE `info` (as the Mac flow does), and reject `issuedAt` older than two windows. Otherwise an old signed address record, read from the public drop, can be written into a later slot to send the PC to a stale origin (DoS only, since the handshake still needs the home key).
- **P3. "(or is the lease holder)" lets a restarted home machine admit a PC without seeing other machines' pending-revocation rows** (§"Connection…", restart rule). Either require a sync with at least one other reachable machine when the home is the lease holder, or say this case relies on the phone-orders path (F3).
- **P4. The owner-order guarantee needs its Full-control limit stated where it is claimed** (§"Owner orders", decision point "applies an owner order received outside the socket"). Under Full control the agent can use PowerShell to rewrite the PC's state files. It can swap the pinned phone key, roll back `orderSeq`/`moveSeq`, patch the executable or forge the ack. The consent text admits this generally, but the "about two minutes" sentence and the decision-point evidence state the guarantee without that limit. Add: "against a cut-off or misbehaving home machine; not against an agent that has used Full control to change the PC".
- **P5. The names shown to the person are chosen by the attacker** (journey step 6, sign-in notice, toast). A scammer names the agent "Microsoft Support" and the owner "Windows Security". Frame every display as "an agent its owner named “…”" and show the key fingerprint words next to it. Consider refusing agent or owner names that contain a shipped list of brand and support words at seal time (a warning on the PC, not a block).
- **P6. Old-home release must verify the phone signature on the move row** (§"Moving a PC"). The old home machine "reads the move row and forwards calls instead of holding the PC". It should do that only after verifying the phone presence signature in the row. Otherwise any machine's unsigned move row makes the honest home stop holding the PC, which is a DoS, since the PC will not follow a move without a valid signature.
- **P7. The extender approval should bind to the PC that was scanned** (§"Pairing hand-off"). Before showing approve, the phone checks that the pending row's `d` equals the `d` it scanned. The presence signature should cover `d`'s fingerprint and the mode (F2's message format), so an agent cannot show the phone a different row.
- **P8. Another residual injection path** (§"Who may call", residual risk). Content that comes back from the PC (files, web pages the agent opened, screenshots of mail) goes into the very session that can command the PC. Also, an owner talked into "connecting" an attacker's machine, which a fake client following the published protocol could pose as, feeds attacker content straight into the owner's most powerful session. Name both next to the "owner pastes outside content" residual. The phone approval line should say "only connect a PC you are sitting at".
- **P9. The scope of the drop point's approval** (§"Address beacon"; `mac-qr-pairing.md` §5 invariants "dumb, short-lived, optional", approved by the operator for pairing). The Windows flow has no paste fallback, so pairing depends on the drop entirely, and address changes, moves and owner orders now go through it too. "Optional" no longer holds. Put this in the approval ask as a widening of an approved exception. Also name the namespace the route will use (the Mac route is `pair-mac-v1`).
- **P10. Code citation.** `issueSessionToken` is `MemoryPrivacy.issueSessionToken` (`src/users/MemoryPrivacy.ts:441`), called from `SessionManager.ts:8491`. It is not a `SessionManager` method.

design: 5, precision: 10
