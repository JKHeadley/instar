---
title: "One easy, independent way to install Instar: any AI door, any address, phone optional"
slug: "install-experience"
author: "echo"
parent-principle: "The User Experience Is the Product — Reachability, Responsiveness, and Coherence Are Sacred"
eli16-overview: "install-experience.eli16.md"
status: "draft"
---

## 1. Problem

Operator direction, 2026-11-02 (topic 135786): take a holistic look at installing Instar, now that the iPhone app exists. Use the app for early messaging and authentication, use an AI tool the person already has, offer a one-liner with few choices, explain plainly what an agent is, walk the person through first tasks, let AI do the work, strengthen authentication and PIN handling, and let an existing agent create the next one.

### 1.1 What exists today

Read from `main` at v1.3.1605:

- `npx instar` requires Node 20 first. The interactive prompt offers Claude Code and Codex only (`promptForFramework`). Gemini is flag-only. For `pi-cli` and `grok-build`, the wizard's binary selection in `runSetup` falls through to the Claude path, so those doors are not setup paths today (confirm during build).
- The Claude wizard is a 2,132-line skill; Codex and Gemini use separate code drivers. The skill never mentions the app and states "Messaging is NOT optional".
- The app is TestFlight only.
- `POST /mobile/pairing-codes` answers `409 stable-address-required` unless a Cloudflare named tunnel with a hostname is active. Tailscale names are added after pairing (`docs/specs/mobile-multi-route.md`) and cannot be the first address.
- Push uses the operator's own Apple key (`docs/specs/mobile-push.md`).
- `dashboardPin` is six digits, plaintext in `.instar/config.json`, per machine. `POST /dashboard/unlock` returns `authToken` alongside the operator session. `fix dashboard` and credential rotation send the PIN in Telegram. Limits: 5 per IP and 20 global per 5 minutes.
- The doorway registry answers `503 registry-unavailable-no-instar-source` on a pure end-user install, so it cannot drive setup choices yet.
- Creating another agent or machine means terminal commands (`instar init`, `instar pair`, `instar join`).

### 1.2 Baseline run

2026-11-02, Linux under WSL, published 1.3.1605, empty home directory. Stopped at sign-in. This is a best case: Node, tmux, Claude Code, Codex and `gh` were already installed, and the network was fast. **No phone and no complete install were tested.**

| Measure | Result |
|---|---|
| Time from command to sign-in | about 4 minutes |
| Choices before sign-in | 3: package install, runtime, terminal theme |
| Disk used before sign-in | 2.1 GB (includes the npm cache and browser download) |
| What the person read first | npm deprecation warnings, then a note about `--dangerously-skip-permissions`, then "Secret Management" |
| Explanation of what an agent is before sign-in | none |

Sign-in and secret storage come before the agent's name or purpose. A complete run with a phone and a real sign-in remains to be measured (section 11).

## 2. Standing rules

Operator decisions, 2026-11-02. They are constraints, not open questions.

- **R1. Every AI door.** Subscriptions, Grok Build, any API model access and local models are all planned for.
- **R2. Always an independent path.** A complete install exists with no Instar-hosted service and no phone.
- **R3. The hosted service is optional and open source where at all possible.**
- **R4. A phone tap replaces the PIN for risky actions, and the phone is not required.**
- **R5. Cloudflare is not required.** Other address options are offered, and the agent sets up whichever is chosen.
- **R6. The person only provides credentials when needed**, through a very easy interface. The agent does the rest.
- **R7. Both generations.** The design applies to 1.x and 2. 1.x stays the main path until 2.0 proves itself.

## 3. Goals

1. One installer behind every way in, with one state machine and resumable steps.
2. Three questions at most in the common case: name, purpose and, only when ambiguous, which AI door.
3. A plain explanation before anything technical is asked.
4. A first visible result within minutes, with no new account or password beyond the AI door's sign-in.
5. An owner credential that the agent cannot read, usable from a phone or a computer.
6. The next agent or machine created by asking the existing agent.

**Measure of success:** human actions and minutes from first command to first useful result, measured on clean machines per path (section 11).

## 4. Ways in

All three run the same installer.

| Way in | First human step | Then |
|---|---|---|
| iPhone app | Tap "Create my agent" | Face ID creates the owner key. The app gives a one-line command for the computer. The conversation continues in the app |
| Existing AI tool | Paste one sentence into Claude Code, Codex or another harness | That tool runs the installer and explains each step, then offers the app and other channels |
| One-liner alone | Run the command | Talk to the agent in the dashboard, or add a messaging channel |

### 4.1 The installer

A small POSIX script (with a PowerShell companion that sets up WSL on Windows) checks for and installs Node and tmux, then runs the existing package. Exact address and packaging are open (section 12).

- **Deterministic before sign-in.** Until an AI door is signed in, no model may be available. These steps are fixed text and must not depend on one. If the person is already inside an AI tool, that tool does the explaining.
- **One state machine.** `src/commands/setup-wizard/state-machine.ts` becomes the single owner of steps for every door. The AI handles conversation and judgment, while step order and completion live in code. This retires the separate Claude wizard flow; the skill shrinks to voice and guidance.
- **Resumable.** Each step records completion. An interrupted install resumes at the first unfinished step.
- **Order.** Explain, then ask name and purpose, then sign in, then everything else. Browser download and secret storage happen only when something needs them.
- **Quiet output.** Package warnings go to a log. The note about running without per-action permission prompts stays, in plain words, as an explicit part of the explanation.

### 4.2 The explanation

Shown by the installer and repeated by the agent in its own voice:

> An Instar agent is an AI that lives on your computer and works for you around the clock. It remembers what you tell it, does work on a schedule, keeps its promises, and asks you before anything risky.

## 5. AI doors

Setup asks "which AI do you want to use?", offering what it detects first. Each door declares a small contract:

- **Detect:** is it installed, and is it signed in?
- **Install:** how the agent installs it.
- **Sign in:** browser or device login, an API key through Secret Drop, or nothing for a local model.
- **Runs sessions:** which harness carries agent sessions.
- **Runs internal checks:** whether it can carry background gates and sentinels, proven by benchmark rather than assumed.
- **Spending:** subscription, metered, or local.

| Door type | Examples | Setup rule |
|---|---|---|
| Subscription through its own harness | Claude Code, Codex, Gemini CLI, Grok Build | Provider-native sign-in only. Grok keeps its separate interactive opt-in and its honest unknown-billing note |
| API key | OpenRouter and direct provider keys | Collected through Secret Drop. **A spending limit is required before first use**, so this depends on the money layer in section 5.1 |
| Local model | Ollama, LM Studio, llama.cpp | Hardware check first, with honest guidance on what the model can handle. No key |

### 5.1 Known gaps

- **Pi as the harness for API and local doors is unproven.** The Pi spec supports `provider/model` configuration, and it refuses Anthropic providers by design. Live proof comes first. If it fails, this part needs another harness.
- **Internal checks on a weak model.** Background gates fail closed by design, so a local-only agent could hold messages constantly. Each door needs a benchmark result, and setup must state the outcome plainly.
- **Money caps ship dark and require explicit enabling.** API doors cannot be recommended to new users until a limit can be set during setup.
- **The door list must reach end-user installs.** The doorway manifest has to ship in the package.

## 6. Addresses

The agent sets up the chosen option. The person only signs in where needed, through a link.

| Option | Needs | Works away from home | Instar service involved |
|---|---|---|---|
| Instar relay | Nothing | Yes | Yes, or the person's own copy |
| Tailscale | Free account, app on phone | Yes | No |
| Own Cloudflare or domain | Account and domain | Yes | No |
| No address | Telegram, Slack or WhatsApp | Yes, through that service | No |
| Same network only | Local certificate trust (open) | No | No |

**Recommended defaults:** the relay when a stranger wants the app with no extra accounts, and Tailscale as the recommended self-hosted option.

**Required change:** pairing accepts any verified own name. `svc.namedTunnelActive()` stops being the only gate; the existing proof that this process answers on the name stays. Quick tunnels remain refused for phones, because their address changes.

## 7. Hosted relay

Open source, self-hostable by changing one address, and never required. It does exactly three things:

1. **Addresses:** a stable name under an Instar domain routed to the agent.
2. **Rendezvous:** one-time codes so a phone and computer can find each other during install.
3. **Push:** forwarding content-free alerts. The phone fetches the title directly from the agent, as it does today.

It stores no conversations and holds no owner authority.

**Rules:**

- **Trust never depends on the relay.** The owner's public key travels inside the install command, and both screens show a short matching code. A malicious relay can deny service, but it cannot become the owner.
- **Encryption above the tunnel is required.** Phone requests are signed today but not separately encrypted, so traffic through an Instar-run tunnel could otherwise be readable at the tunnel provider. App-to-agent traffic needs end-to-end encryption before the relay carries it. A browser dashboard on a relay address has the same exposure and needs its own answer (section 12).
- **Failure.** If the relay is down, the agent keeps running. Other routes still work, and the app says plainly why it can't connect.
- **Abuse and cost.** Rate limits per name and per owner, plus a published removal path. Sizing and funding are open.

**Disclosed exception to independence:** Apple accepts alerts for the App Store app only when signed with the key of the team that owns the app. That key cannot be self-hosted, even when the relay code is open. Independent users keep the app, which updates when opened. For alerts they use Telegram or Slack, or build the app themselves. This must be stated at the moment they choose independence.

## 8. Owner authentication

### 8.1 Authority levels

| Action | Allowed proof |
|---|---|
| View the dashboard in a browser | PIN, passkey or phone approval |
| Risky action: approvals, money, arming, remote desktop, revoking | Phone signature, passkey or long passphrase. **Never the six-digit PIN once migration completes** |

### 8.2 The proofs

Any one is enough. A person can hold several, and none requires the relay.

1. **Phone app.** The existing Secure Enclave device key, with a Face ID prompt on risky actions. The agent's dashboard can request a tap on the phone.
2. **Passkey on the dashboard.** WebAuthn with Touch ID, Windows Hello or a security key, including scanning a QR code with a phone. This is new: today's passkey code signs in to Google accounts and does not protect the dashboard.
3. **Long passphrase.** For a machine with none of the above. It must be long enough to resist offline guessing of the stored hash.

### 8.3 PIN changes

- Stored only as a salted slow hash. Everything that reads it as plaintext changes, including `fix dashboard`, rotation messages and the agent guidance that says to read it.
- `POST /dashboard/unlock` stops returning `authToken`, and the browser gets a scoped session instead. This needs an audit of every dashboard call that uses the token.
- The agent can no longer tell the person their PIN. A forgotten PIN is reset by a stronger proof.
- A separate lockout rule, so strangers can't exhaust the shared limit and lock the owner out.

**A hash does not make six digits proof of a human.** The agent could crack its own stored copy in about a day. That is why section 8.1 removes the PIN from risky actions.

### 8.4 One owner

An owner record lists the owner's public keys. It replicates across machines through the existing mesh and is pinned when a new agent or machine is created, so there is no per-machine PIN and no repeat pairing. Adding a key requires a signature from an existing one.

### 8.5 Recovery

- **New device:** approved from an existing one.
- **Lost device:** a recovery code shown once at install, stored in the person's password manager and never by the agent.
- **Lost everything:** a local command run by someone physically at the machine, which tells the owner through every channel. A deliberate waiting period is open.
- **The agent can never reset owner proof on its own.**

### 8.6 Honest limit

The agent runs as the same operating-system user as the code that checks signatures, so it could change the owner record or the checking code. This design stops mistakes, confusion and casual misuse, and any owner-record change alerts the owner's other devices. It does not defend against a deliberately hostile agent or a compromised machine. Moving checks into a separate user or the OS keychain is later work.

## 9. Getting started

The agent's first message offers three tasks based on the stated purpose. Each needs no new account:

1. **A morning briefing** delivered on the person's channel, fired once right away as proof.
2. **Memory:** tell it a preference, open a new conversation, and see it remembered.
3. **A promise:** a dated reminder that really fires.

Then a guided second level: **a scheduled email report**, calendar, another computer, another agent. Each asks for credentials only when reached. Docs stop leading with "check my emails".

**Default job load.** Measure what background jobs cost a new account in the first day. If a small plan loses meaningful quota before a first result, default jobs must start later or lighter. This needs measurement before any decision.

## 10. The next agent

The person says "make me another agent" or "put yourself on my laptop". The agent asks one question: "The same me on another computer, or a new helper?"

- **New helper, same computer:** the agent runs the installer non-interactively, with owner keys pinned from the start. A new conversation appears. Because one owner vouches for both, sibling agents connect without the invite steps; an owner signature replaces those taps. Unrelated agents keep the existing invite flow.
- **Same or new agent, another computer:** the agent gives a one-liner with a one-time code, or runs it itself if it can already reach the machine (`docs/specs/mutual-ssh-autobootstrap.md`). The person pastes the line, approves once, and signs in to the subscription on that machine.

Sign-in stays per machine. Claude logins are never copied, which matches the Account Follow-Me design. Quota for a second agent is shared by default and must be disclosed.

## 11. Testing and proof

- **Unit and integration:** installer state machine, resume at every step, door contracts, pairing on each address type, unlock without `authToken`, PIN hash migration, owner-record signing, and relay failure.
- **E2E:** clean-environment install for each door and address option, with feature-alive checks.
- **Live-user-channel proof:** a stranger-shaped run per way in, on a clean machine and a clean phone, recording human actions and minutes against the baseline in section 1.2. Includes the no-relay, no-phone path, which R2 makes mandatory.
- **Relay independence test:** block the relay at the network level and show that a self-hosted agent is unaffected.

## 12. Open questions

1. Install address, and whether the installer lives on `instar.sh`.
2. A passkey is tied to one web address, and an agent can have several across machines. Options: register per address, use Related Origin Requests, or send the approval to an already trusted device. **This is the main unsolved design problem.**
3. Encryption for a browser dashboard on a relay address.
4. Pi or another harness for API and local doors.
5. Waiting period for physical-access recovery.
6. Relay funding, limits and terms.
7. Same-network option: how a phone trusts a local certificate.
8. When the App Store release happens, which also depends on Apple's review.

## 13. Delivery phases

Each phase ships on its own and leaves a working install.

1. **Install basics, no relay:** installer script, step reorder, messaging made optional, one state machine, plain output, the app mentioned in setup, new first tasks.
2. **Addresses without Cloudflare:** pairing on Tailscale and own domains, with the agent doing the setup.
3. **Next agent by asking.**
4. **All AI doors:** door contract, shipped door list, Pi proof, local-model checks. API doors wait on spending limits.
5. **Owner authentication:** passkeys, phone approvals, PIN hashing, recovery.
6. **Relay and phone-first:** relay with encryption, App Store release, "Create my agent".

## 14. Rollout and migration

- **Migration Parity.** Existing agents receive CLAUDE.md guidance and config through `PostUpdateMigrator`. PIN hashing is an idempotent migration that keeps the current PIN working. Risky actions accept the old PIN during a stated transition, which ends only when an owner has a stronger proof, so nobody gets locked out.
- **Agent Awareness.** The template gains next-agent triggers, the door list, address options, and owner-proof guidance.
- **Graduated rollout.** Each phase is development-agent-first, dry-run where it changes authority.
- **Off switches.** Relay use, the passkey requirement and the new unlock response each have their own.

## 15. Instar 2

Instar 2 has its own fresh-install design in open pull requests (instar-2 #178 to #181), and a draft on organizational approval with minimal phone handoffs (#185). The behaviors in sections 4 to 10 are the shared contract. 1.x builds them first, per R7. Each 1.x phase records what Instar 2 needs to match, and the Instar 2 design work cross-checks against this contract. Any constitutional wording goes through the normal Instar 2 approval path.

## 16. Multi-machine

- Installer and door sign-ins are per machine.
- The owner record replicates (section 8.4) and must be signature-checked on receipt.
- Each machine proves its own address names, as it does today.
- Single-machine agents are a no-op for replication.
- Relay names belong to a machine, and moving serving between machines must not require re-pairing. The app's existing route list handles this and needs a live proof.
