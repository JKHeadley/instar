---
title: "One easy, independent way to install Instar: any AI door, any address, phone optional"
slug: "install-experience"
author: "echo"
parent-principle: "The User Experience Is the Product — Reachability, Responsiveness, and Coherence Are Sacred"
eli16-overview: "install-experience.eli16.md"
status: "draft"
---

## 1. Problem

Operator direction, 2026-11-02 (topic 135786): take a holistic look at installing Instar, now that the iPhone app exists. Use the app for early messaging and authentication, use an AI tool the person already has, offer a one-liner with few choices, explain plainly what an agent is, walk the person through first tasks, let AI do the work, strengthen authentication and PIN handling, and let an existing agent create the next one. Operator's review focus: user friendly and secure; leverages the app but supports multiple independent paths.

### 1.1 What exists today

Read from `main` at v1.3.1605 and checked by review:

- `npx instar` needs Node. `Prerequisites.ts` checks 18+, while `engines` and a dependency need 20.12. The interactive prompt offers Claude Code and Codex only; Gemini is flag-only. For `pi-cli` and `grok-build`, the binary selection in `runSetup` falls through to the Claude path. A non-TTY run silently picks Claude Code, and a machine with neither tool exits with an error.
- The Claude wizard is a 2,132-line skill. Codex and Gemini use code drivers on `setup-wizard/state-machine.ts`, which has no persistence. The skill never mentions the app and states "Messaging is NOT optional".
- The app is TestFlight only.
- Pairing gates on a Cloudflare named tunnel at three points: mint and redeem (`namedTunnelActive()`) and `stableOrigin()`. Redeem also needs a Telegram owner DM or a dashboard PIN session. Tailscale names are added after pairing.
- Push uses the operator's own Apple key and fires after a Telegram hub post.
- `dashboardPin` is six digits, reversible and readable by the agent (normally a vault reference, not plaintext in config), and per machine. `routes.ts` compares it at eight sites; about 52 sites gate on it through `checkMandatePin` or similar. `POST /dashboard/unlock` returns `authToken` plus an operator session, and five front-ends depend on the token. `fix dashboard`, credential rotation and an LLM-composed upgrade notice can each put the PIN in Telegram. Limits are 5 per IP and 20 global per 5 minutes, and behind a tunnel every caller is loopback, so strangers can lock the owner out.
- The protected lifeline is keyed on a Telegram topic, and the cold-start fallback delivers through Telegram. An install with no channel has no reachability floor.
- The doorway registry answers `503 registry-unavailable-no-instar-source` on end-user installs.
- Creating another agent or machine means terminal commands.

### 1.2 Baseline run

2026-11-02, Linux under WSL, published 1.3.1605, empty home directory, stopped at sign-in. This is a best case: Node, tmux, Claude Code, Codex and `gh` were already installed, and the network was fast. **No phone and no complete install were tested.**

| Measure | Result |
|---|---|
| Time from command to sign-in | about 4 minutes |
| Choices before sign-in | 3: package install, runtime, terminal theme |
| Disk used before sign-in | 2.1 GB (mostly the unconditional browser download and npm cache) |
| What the person read first | npm deprecation warnings, a note about `--dangerously-skip-permissions`, then "Secret Management" |
| Explanation of what an agent is before sign-in | none |

## 2. Standing rules

Operator decisions, 2026-11-02. They are constraints.

- **R1. Every AI door.** Subscriptions, Grok Build, any API model access and local models are planned for.
- **R2. Always an independent path.** A complete install exists with no Instar-hosted service and no phone.
- **R3. The hosted service is optional and open source where at all possible.**
- **R4. A phone tap replaces the PIN for risky actions, and the phone is not required.**
- **R5. Cloudflare is not required.** Other address options are offered, and the agent sets up whichever is chosen.
- **R6. The person only provides credentials when needed**, through a very easy interface. The agent does the rest.
- **R7. Both generations.** 1.x is the main path until 2.0 proves itself.

## 3. Goals

1. One installer behind every way in, with one state machine and resumable steps.
2. Three questions at most in the common case: name, purpose and, only when ambiguous, which AI door.
3. A plain explanation before anything technical is asked.
4. A first result the person actually receives within minutes, with no new account beyond the AI door's sign-in.
5. An owner credential that the agent cannot read or use, available from a phone or a computer.
6. The next agent or machine created by asking the existing agent, with the owner's approval.

**Measure of success:** human actions, minutes and disk from first command to first delivered result, per path (section 12).

## 4. Ways in

All paths run the same installer. Each states what it depends on.

| Way in | First human step | Depends on |
|---|---|---|
| One-liner alone | Run the command | Nothing hosted. Available first |
| Existing AI tool | Paste one sentence into Claude Code, Codex or another harness | The tool, and the non-interactive contract in 4.3 |
| npm | `npx instar@latest` | Node already installed. Stays as an independent path |
| iPhone app, with relay | Tap "Create my agent" | The App Store release and the relay. **Unavailable before phase 6** |
| iPhone app, without relay | Install on the computer first, then scan its QR code | A private address (section 6) |

Windows runs through the same installer inside WSL. Enabling WSL needs an administrator prompt and a reboot; the PowerShell companion records progress in the Windows user profile and resumes after the reboot through one per-user logon task, which it removes when done.

### 4.1 The installer

- **Published and verifiable.** `instar.sh/install` and `install.ps1`, with the same bytes in the npm package and a detached signature checked by the bootstrap where a verifier exists. The script takes **no parameter that sets ownership**.
- **Plain consent.** It says what it will install and asks once. `--yes` is explicit. It never runs `sudo` without saying so. This replaces `GUIDED-SETUP-SPEC` principle 7 by name: installing with stated consent is allowed; silent installs stay forbidden.
- **Checks first.** Disk space with a plain refusal, supported platform, and existing tools, including common version-manager locations, because `curl | sh` runs without the person's shell profile. It asks before installing a second copy of anything.
- **Installs the chosen AI door.** No agent exists yet, so the deterministic installer does this. When it can't, it stops with a plain next step and a resume point.
- **Default home.** `~/.instar/agents/<name>`, never the current directory, so the macOS protected-folder refusal can't surprise anyone.
- **Deterministic before sign-in.** Until an AI door is signed in, no model may be available. These steps are fixed text.
- **Order.** Explain, ask name and purpose, set up the owner proof, sign in, then everything else. Browser download and secret storage happen only when something needs them; the Telegram setup is one such trigger.
- **Quiet output.** Package warnings go to a log. The note about running without per-action permission prompts stays, in plain words, as part of the explanation.

### 4.2 One state machine and resume

`state-machine.ts` becomes the single owner of steps for every door. It gains action kinds for door install, door sign-in, owner enrollment, address setup and first result, plus a completion ledger at `.instar/state/install-progress.json`. Each step is idempotent and records its completion after verifying its result.

The Claude skill shrinks to voice and guidance only after a before-and-after comparison of the same scenarios shows no quality loss. Until then both flows remain.

### 4.3 Non-interactive contract

An AI tool has no terminal to answer prompts, so the installer accepts an answers file. A harness can supply name, purpose and door. **Anything with external effect (owner enrollment, address choice, relay use, door sign-in) is never accepted from the harness.** The installer prints a one-time local link or QR code, and the person confirms there. A wrong or prompt-injected harness can therefore waste time, but can't choose the owner.

### 4.4 The explanation

Shown by the installer and repeated by the agent in its own voice:

> An Instar agent is an AI that lives on your computer and works for you around the clock. It remembers what you tell it, does work on a schedule, keeps its promises, and asks you before anything risky.

## 5. AI doors

Setup asks "which AI do you want to use?", offering what it detects first. Each door declares a contract:

- **Detect** and **Signed in.** Signed in is proven by one live authenticated call. `claude auth status` is not proof, because it reports signed in for expired sessions. An unreadable credential store (such as a locked keychain) reads `unknown`: setup says "can't tell" and never re-signs in over a possibly working login.
- **Install**, by the deterministic installer.
- **Sign in**, through browser or device login, an API key through Secret Drop, or nothing for a local model.
- **Runs sessions:** which harness carries agent sessions.
- **Runs internal checks:** proven by a recorded benchmark, with its cost per turn.
- **Spending:** subscription, metered or local.

| Door type | Examples | Setup rule |
|---|---|---|
| Subscription through its own harness | Claude Code, Codex, Gemini CLI, Grok Build | Provider-native sign-in only. Grok keeps its separate interactive opt-in and unknown-billing note |
| API key | OpenRouter, direct provider keys | **Not offered until the money layer is live and a limit is set in the same flow.** Until then setup says so in one sentence |
| Local model | Ollama, LM Studio, llama.cpp | Check RAM or VRAM against model size, and measure CPU speed. Marked "not yet" until proven |

Pi is the candidate harness for API and local doors, and needs a live proof in phase 5. If it fails, API doors route through Codex CLI provider configuration where a proof passes, and local doors stay "not yet". The doorway manifest ships in the package.

**Internal checks on a first install.** Background gates fail closed, so a weak or rate-limited door could hold the first message. Each door's first-hour posture is declared: heuristic-first where allowed, off-Claude per the existing provider-fallback policy where available. The credential wall and self-stop floors never relax. The person is told plainly when a door can't carry gates.

## 6. Addresses

The agent sets up the chosen option. The person only signs in where needed, through a link.

| Option | Needs | Away from home | Hosted service |
|---|---|---|---|
| Tailscale | Free account, app on phone | Yes | No |
| Own Cloudflare or domain | Account and domain | Yes | No |
| No address | Telegram, Slack or WhatsApp | Through that service | No |
| Same network only | Agent-held certificate, pinned by the phone at pairing | No | No |
| Instar relay | Nothing | Yes | Yes, or the person's own copy |

**Default:** Tailscale when the person has it or will sign in, the relay after phase 6 when they want none of that, and no address when they already use a messaging service.

**Pairing change.** All three gates (mint, redeem, `stableOrigin()`) accept any proven own name, with the stored device origin following. The proof that this process answers on the name stays. Quick tunnels remain refused for phones.

**Same network.** The agent terminates TLS itself with its own certificate. The phone pins it through the pairing link and the code in 8.2.

## 7. Hosted relay

Open source, self-hostable by changing one address, never required, and deployed only in phase 6.

1. **Addresses:** a stable name routed to the agent by **TLS passthrough**. The relay reads only the server name. The agent holds its own certificate and private key.
2. **Rendezvous:** one-time codes so a phone and computer can find each other. Ten-minute life, nothing kept after use. **A rendezvous code is never ownership proof**, because a malicious relay could hand one to two parties.
3. **Push:** forwarding content-free alerts. The phone fetches the title directly from the agent.

**Honest limits.** A relay that controls the DNS for a name could obtain a certificate for it, so:

- The app pins the agent's certificate key at pairing. A substituted one fails loudly.
- Agents monitor certificate transparency for their name and alert the owner.
- **In a browser on a relay address, the dashboard is view-only.** Passkeys bind to the origin, so they can't protect against the origin itself. Risky actions go to the phone, or use a private address.

**Failure.** If the relay is down, the agent keeps running. The app tries other routes first and names the relay only when all fail.

**Limits.** One free name per owner, ten at most. 60 pushes per device per day and a per-agent ceiling at the relay. A signed owner request removes a name.

**Disclosed exception to independence.** Apple accepts alerts for the App Store app only when signed with the key of the team that owns the app. Independent users keep the app, which updates when opened, and get alerts through Telegram or Slack, or build the app themselves. They are told this when they choose independence.

## 8. Owner authentication

### 8.1 One rule: every owner proof is a signature

The owner record lists public keys only. Every proof produces a signature over a server-rendered action. The agent holds no owner private key, so nothing it can read grants authority.

| Proof | Key lives | Works with |
|---|---|---|
| Phone app, with Face ID | Secure Enclave | Any route |
| Passkey: Touch ID, Windows Hello, security key, QR from a phone | Authenticator | Dashboard at a registered address, not a relay address |
| Passphrase | Derived in the browser from the passphrase (Argon2id, 256 MiB, at least 3 passes, with stored salt), minimum length enforced | Any browser, including a one-time link |
| Recovery key | Generated on the phone or browser, shown once, never sent to the agent | Recovery only |

The agent stores only the public key and salt, so the secret never reaches the machine.

| Action | Accepted |
|---|---|
| View the dashboard | PIN session or any proof |
| Risky action: approvals, money, arming, remote desktop, revoking, creating an agent, changing the owner record | A signature from any proof above except the recovery key. **Per owner, the PIN stops working for these the moment that owner holds one proof** |

**Telegram is not owner proof.** A bot token is readable by the agent, so a button tap can't prove a human for risky actions. A Telegram-only person gets a one-time link to a passphrase or passkey page, served locally or through a temporary address, and never types a secret into chat. Telegram-only use without risky actions keeps working, and existing approvals carry over per section 15.

### 8.2 First-owner enrollment

This closes the gap where a fresh machine has no owner.

**With a phone:**

1. The installer shows a QR code holding the agent's address and public key, or the relay connects the two.
2. Phone and computer each display a code derived from **both** keys, at least 48 bits, shown as words.
3. The person types the computer's code into the phone, and the phone signs the owner record.
4. The agent pins the record only after that signature verifies.

**Without a phone:** the installer prints a one-time local link. The person opens it in a browser on that computer and creates a passkey or passphrase. Enrollment closes after the first success, and the link is single-use and loopback-bound. On a headless machine, it issues a short-lived link through the temporary address instead, protected by the same key-derived code shown in the terminal.

Both finish with the recovery key, generated client-side. The person confirms they saved it.

**An agent or harness cannot complete enrollment.** Local enrollment is still reachable by a program running as that user, so the installer prints the owner's public key fingerprint at the end, and a later change alerts every proof holder. This is covered by the limit in 8.6.

### 8.3 Approval requests

Tap prompts render **server-canonical text** bound to an action hash and expiry. The agent cannot author the wording. At most three requests per agent may be pending, and three declines in a row pause requests and alert the owner.

### 8.4 One owner across machines and agents

- **The owner record is a trust anchor beside `identity.json`.** It never travels through ordinary state sync.
- It is a signed hash chain with a rising version. Changes require a signature from an existing proof. Revocations are signed tombstones that can't be rolled back.
- A new machine or agent receives it only through a one-time code from an already enrolled machine, and asks the owner to approve with a proof.
- **Phones across machines.** The record lists device keys, so a phone paired once is accepted by every machine of that owner, closing the `401` on a tunnel move. Revoking a device is a record change that reaches every machine. A machine offline at revocation refuses owner actions on its return until it has synced.

### 8.5 PIN changes

- One funnel, `ownerProof`, replaces all PIN-gated sites. An inventory of every consumer is a phase-3 deliverable, and each moves in the same unit of work.
- The PIN stays for viewing only, stored as a slow hash in a worker so a burst can't block the server. The migrator stops re-minting one when the plaintext field is gone. The PIN is no longer put in Telegram or in LLM prompts.
- `POST /dashboard/unlock?v=2` returns only a scoped session: dashboard reads, with a fixed time limit, invalidated when the PIN changes. Operator routes need a proof. The old response stays for one minor series so all five front-ends and the app can move, using the session-only adapter already in `console/ui.js`.
- Client address comes from `CF-Connecting-IP` only on tunnel arrivals. A stronger proof bypasses the PIN limit, so strangers can't lock an owner out.
- A forgotten PIN is reset by a proof. The agent can't tell the person their PIN.

### 8.6 Recovery

- **New device:** approved from an existing proof.
- **Lost device:** the recovery key, which replaces the lost entry. This supersedes the recovery key in `MULTI-USER-SETUP-SPEC`, which is stored hashed and displayed by the agent.
- **Lost everything:** a local reset run on the machine. **72-hour wait**, with notices on every channel at the start, at 24 hours and at 1 hour. Any existing proof cancels it, and the action is audited. A program running as the same user could start this, which is why the wait and veto are mandatory.

### 8.7 Honest limit

The agent runs as the same operating-system user as the code that checks signatures, so it could change the owner record or that code. This design stops mistakes, confusion and casual misuse, and owner-record changes alert every proof holder. It does not defend against a deliberately hostile agent or a compromised machine. A separate user or OS-held custody is later work, and is already required for Instar 2.

## 9. Reachability without messaging

Messaging can't become optional until the floor has another carrier. The protected lifeline gains a dashboard and native-app conversation carrier, keyed the same way on a minted conversation id, and the cold-start fallback gains that delivery path. The first session and conversation are created by the installer. **Phase 1 cannot ship "messaging optional" without this.** The native conversation feature must be live on the fleet for this path, not development-gated.

## 10. Getting started

The agent's first message offers three tasks based on the stated purpose. Each needs no new account:

1. **A morning briefing** delivered on the person's channel, fired once right away.
2. **Memory:** tell it a preference, open a new conversation, and see it remembered.
3. **A promise:** a dated reminder that really fires.

**Delivery, not a send result.** First-result success reads the delivery outcome record, because lease holds and gate holds both produce "job ran, person saw nothing". The installer waits for that record before declaring success.

**Live mechanisms required.** The dated reminder (`commitments.checkInReminder`) ships in dry-run today, so a stranger's first promise would silently never fire. Going live for new installs is a phase-1 exit criterion.

Then a guided second level: a scheduled email report, calendar, another computer, another agent. Each asks for credentials only when reached. Docs stop leading with "check my emails".

**Default jobs.** First-day job cost is measured in the live proof. Over 15% of a small plan's weekly quota, default jobs start after the first task completes rather than at install. Both branches get built.

## 11. The next agent

The person says "make me another agent" or "put yourself on my laptop". The agent asks: "The same me on another computer, or a new helper?"

**Creating an agent is a risky action.** It requires an owner proof, shows its quota cost first, checks the machine's load verdict, and is capped per owner. A misbehaving agent can't fork helpers without the owner.

- **New helper, same computer:** the agent runs the installer with the answers file. The owner approves once, which signs (ownerKey, new agent). That signature carries the sibling trust: no invite steps. This **amends** `a2a-pairing-invite-link.md` section 11.6, where same-owner pre-authorization covered only the Finish step. No agent-held key can produce it, and it is audited. Unrelated agents keep the invite flow.
- **Another computer:** the agent gives the one-liner plus a one-time code, or runs it itself if it can already reach the machine (`mutual-ssh-autobootstrap.md`). The person pastes the line, approves with a proof, and signs in to the subscription there.

Sign-in stays per machine. Claude logins are never copied, which matches the Account Follow-Me design.

## 12. Testing and proof

- **Unit and integration:** state machine and resume at every step; door contracts on both sides of "signed in"; pairing on each address type at all three gates; `ownerProof` for every proof type; unlock v2; PIN migration including no re-mint; owner-record chain, rollback refusal and tombstones; approval text binding, pending cap and decline pause; enrollment refusing harness input.
- **Wiring integrity:** every migrated PIN consumer reaches `ownerProof`, and a lint refuses new direct PIN comparisons.
- **E2E:** clean install per door and address, with feature-alive checks, including the lifeline with no channel.
- **Live-user-channel proof:** a stranger-shaped run per way in, on a clean machine and clean phone, recording actions, minutes and disk against 1.2. Includes the no-relay, no-phone path, which R2 makes mandatory.
- **Relay independence:** block the relay at the network level and show a self-hosted agent is unaffected. Certificate-pin failure is tested with a substituted certificate.
- **Wizard quality comparison** before the Claude flow retires (4.2).

## 13. Frontloaded Decisions

1. **Install address:** `instar.sh/install` and `install.ps1`. A published address is never deleted; if it moves, a permanent redirect stays.
2. **Passkeys across addresses:** v1 registers per address and can forward an approval to an already trusted device. Related Origin Requests are deferred.
3. **Dashboard on a relay address:** view-only (section 7).
4. **API and local doors:** the rule and Pi fallback in section 5. Both branches are buildable.
5. **Recovery wait:** 72 hours (8.6).
6. **Same network:** agent-held certificate pinned at pairing (section 6).
7. **Unlock response:** versioned (8.5).
8. **Default jobs:** the 15% rule (section 10).
9. **PIN retirement:** per owner, on first proof (8.1).

**Operator boundaries.** These stop the run until the operator acts, and the design is unaffected by their outcome: deploying the relay and its cost ceiling (section 7's limits are the proposed defaults), and the App Store submission. Everything before phase 6 proceeds without them.

## 14. Decision points touched

| Decision point | Class | Justification, or floor and arbiter |
|---|---|---|
| Pairing requires a proven own name | invariant | Deterministic probe, no competing signals |
| Risky action requires an owner signature | invariant | Identity gate, verified cryptographically |
| Owner-record change requires an existing proof | invariant | Same |
| Enrollment refuses harness-supplied ownership | invariant | Structural: the answers file has no such field |
| Recovery wait and veto | invariant | Identity, fixed |
| Approval pending cap and decline pause | invariant | Bounded blast radius, fixed numbers |
| Door "signed in" verdict | invariant | One live call; an unreadable store yields `unknown` with no re-sign-in |
| Which door to offer first | judgment-candidate | Floor: only detected doors. Default: the harness running the installer. Arbiter: the setup flow. Fallback: ask the one question |
| Which address to recommend | judgment-candidate | Floor: the options table, relay only if deployed. Arbiter: the setup flow. Fallback: Tailscale |
| First tasks from purpose | judgment-candidate | Floor: the three named tasks. Arbiter: the agent. Fallback: offer all three |
| Local-model verdict for internal checks | invariant | Recorded benchmark threshold |
| Default-job start timing | invariant | Measured threshold |

**State versus symbol.** "First result delivered" reads the outcome record, not a send result. "Signed in" uses a live call. "Own name" uses a probe answered by this process. "Owner" uses a verified signature. Each reports `unknown` when it can't be measured and never treats that as success.

## 15. Rollout and migration

- **Existing agents.** `PostUpdateMigrator` moves the PIN to a hash idempotently and keeps it working. Risky actions accept the old PIN until that owner enrolls a proof, with a visible prompt to do so. The agent can offer enrollment conversationally through a one-time link. Nobody gets locked out.
- **Existing Telegram approvals** keep working for an owner with no proof yet, and stop for risky actions once one exists.
- **CLAUDE.md.** `migrateClaudeMd` rewrites the "read the PIN from config" guidance with a content-sniffed guard. The template gains next-agent triggers, the door list, address options and owner-proof guidance.
- **Backup.** The owner record contains only public keys and is backed up. Each new private key lives on the owner's device, never the machine. The progress ledger is not backed up.
- **Graduated rollout.** Each phase is development-agent-first. Any dry-run names its go-live condition and date in the phase's rollout note, so nothing is left dark by default. Off switches exist for relay use, approval prompts and unlock v2. The owner proof requirement has no off switch once an owner has enrolled; removal is a signed record change.

## 16. Delivery phases

Each ships on its own and leaves a working install.

1. **Install basics:** installer, reorder, plain output, one state machine, consent, disk checks, lazy browser download, door install, reachability without messaging, new first tasks, live reminders, delivery-checked first result.
2. **Addresses without Cloudflare:** pairing on any proven name, agent-run setup, same-network option.
3. **Owner authentication:** owner record, enrollment, phone, passphrase, passkey (last within the phase), `ownerProof` migration, unlock v2, recovery.
4. **Next agent by asking:** requires phase 3.
5. **All AI doors:** contracts, shipped door list, Pi proof, local checks. API doors wait on the money layer.
6. **Relay and phone-first:** relay, App Store release, "Create my agent".

## 17. Instar 2

Instar 2 has its own fresh-install design in open pull requests (instar-2 #178 to #181), and a draft on organizational approval with minimal phone handoffs (#185). The user-facing behaviors in sections 4 to 6, 8.1 to 8.3 and 10 to 11 are the shared contract. Section 8.7 is **not**: Instar 2 requires signing material in a store no worker can read from day one, so its custody is stronger. Each 1.x phase records what Instar 2 needs to match. Constitutional wording goes through the normal Instar 2 approval path.

## 18. Multi-machine posture

Default is unified. Surfaces that are machine-local carry a justification.

| Surface | Posture |
|---|---|
| Owner record | Unified, as a trust anchor through its own signed path (8.4) |
| Approval requests | Unified: raised and decided against the owner record, with results recorded on the machine holding the action |
| Paired-device list | Unified, through the owner record |
| Install progress ledger | machine-local-justification: physical-credential-locality (records setup of this disk's binaries and logins, and is meaningless elsewhere) |
| Door sign-ins | machine-local-justification: physical-credential-locality |
| Proven address names and agent TLS key | machine-local-justification: physical-credential-locality |
| Viewing PIN hash | Unified through the owner record, so one PIN opens every machine |
| Dashboard sessions | machine-local-justification: physical-credential-locality (session secrets bound to the issuing machine; the existing pool-link assertions cover cross-machine views) |

Single-machine agents are a no-op for replication.

## Open questions

*(none)*

## Left behind

- Scalability: exact local-model hardware thresholds are set during phase 5.
- Scalability: next-agent load check reuses the existing admission verdict, with details left to phase 4.
- Windows detail: `detectPlatform` returns `unknown` on win32 and gets corrected in phase 1.
