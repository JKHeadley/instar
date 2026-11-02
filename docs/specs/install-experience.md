---
title: "One easy, independent way to install Instar: any AI door, any address, phone optional"
related-specs: "owner-authentication.md, hosted-relay.md"
slug: "install-experience"
author: "echo"
parent-principle: "The User Experience Is the Product — Reachability, Responsiveness, and Coherence Are Sacred"
eli16-overview: "install-experience.eli16.md"
status: "draft"
lessons-engaged: "Migration Parity; The Agent Is Always Reachable; a send result is not a delivery; Mobile-Complete Operator Actions; never probe with a mutating call"
review-convergence: "2026-11-02T18:36:18.256Z"
review-iterations: 6
review-completed-at: "2026-11-02T18:36:18.256Z"
review-report: "docs/specs/reports/install-experience-convergence.md"
cross-model-review: "codex-cli:gpt-6-astra"
single-run-completable: true
frontloaded-decisions: 6
cheap-to-change-tags: 0
contested-then-cleared: 0
---

**Part 1 of 3.** This spec covers the installer, AI doors, addresses, reachability and first tasks. It ships without the other two. [`owner-authentication.md`](owner-authentication.md) replaces the PIN for risky actions and adds creating the next agent. [`hosted-relay.md`](hosted-relay.md) adds the optional relay and phone-first install.

## 1. Problem

Operator direction, 2026-11-02 (topic 135786): take a holistic look at installing Instar, now that the iPhone app exists. Use the app for early messaging and authentication, use an AI tool the person already has, offer a one-liner with few choices, explain plainly what an agent is, walk the person through first tasks, let AI do the work, strengthen authentication and PIN handling, and let an existing agent create the next one. Operator's review focus: user friendly and secure; leverages the app but supports multiple independent paths.

### 1.1 What exists today

Read from `main` at v1.3.1605 and checked by review:

- `npx instar` needs Node. `Prerequisites.ts` checks 18+, while `engines` and a dependency need 20.12. The interactive prompt offers Claude Code and Codex only; Gemini is flag-only. For `pi-cli` and `grok-build`, the binary selection in `runSetup` falls through to the Claude path. A non-TTY run silently picks Claude Code, and a machine with neither tool exits with an error.
- The Claude wizard is a 2,132-line skill. Codex and Gemini use code drivers on `setup-wizard/state-machine.ts`, which has no persistence. The skill never mentions the app and states "Messaging is NOT optional".
- The app is TestFlight only.
- Pairing gates on a Cloudflare named tunnel at three points: mint and redeem (`namedTunnelActive()`) and `stableOrigin()`. Redeem also needs a Telegram owner DM or a dashboard PIN session. Tailscale names are added after pairing.
- Push uses the operator's own Apple key and fires after a Telegram hub post.
- `dashboardPin` is six digits, reversible and readable by the agent (normally a vault reference, not plaintext in config), and per machine. `routes.ts` compares it at eight sites; roughly 50 sites gate on it through `checkMandatePin` or similar. `POST /dashboard/unlock` returns `authToken` plus an operator session, and five front-ends depend on the token. `fix dashboard`, credential rotation and an LLM-composed upgrade notice can each put the PIN in Telegram. Limits are 5 per IP and 20 global per 5 minutes, and behind a tunnel every caller is loopback, so strangers can lock the owner out.
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
4. A first result that demonstrably reaches the person's channel or screen within minutes, with no new account beyond the AI door's sign-in.
5. An install slot for owner setup that later parts can fill without changing the flow.

**Measure of success:** human actions, minutes and disk from first command to first delivered result, per path (section 9).

## 4. Ways in

All paths run the same installer. Each states what it depends on.

| Way in | First human step | Depends on |
|---|---|---|
| One-liner alone | Run the command | Nothing hosted after install; the download host must be up at install time |
| Existing AI tool | Paste one sentence into Claude Code, Codex or another harness | The tool, and the contract in 4.3 |
| npm | `npx instar@latest` | Node already installed |
| iPhone app | Install on the computer, then scan its QR code on the same network or over a private address | The App Store or TestFlight app |

**The app can't start a computer.** A phone-first start means the app gives the person the command to run on their computer, then connects to that install. Provisioning cloud computers from the app is out of scope. `hosted-relay.md` removes the private-address requirement.

Windows runs through the same installer inside WSL. Enabling WSL needs an administrator prompt and a reboot; the PowerShell companion records progress in the Windows user profile and resumes after the reboot through one per-user logon task, which it removes when done.

### 4.1 The installer

- **Published and verifiable.** `instar.sh/install` and `install.ps1`, with the same bytes in the npm package and a detached signature checked by the bootstrap where a verifier exists. The script takes **no parameter that sets ownership**.
- **Plain consent.** It says what it will install and that this creates a new agent ("to put an existing agent here, ask that agent"), and asks once. `--yes` is explicit. It never runs `sudo` without saying so. This follows `GUIDED-SETUP-SPEC` principle 7: stated consent counts, and silent installs stay forbidden.
- **Checks first.** Disk space with a plain refusal, supported platform, and existing tools, including common version-manager locations, because `curl | sh` runs without the person's shell profile. It asks before installing a second copy of anything.
- **Installs the chosen AI door.** No agent exists yet, so the deterministic installer does this. When it can't, it stops with a plain next step and a resume point.
- **It keeps running.** With consent, the installer sets up supervision and automatic start through the existing `instar autostart`, including WSL's start path. The explanation says plainly that the agent works while its computer is on and awake.
- **Default home.** `~/.instar/agents/<name>`, never the current directory, so the macOS protected-folder refusal can't surprise anyone.
- **Deterministic before sign-in.** Until an AI door is signed in, no model may be available. These steps are fixed text.
- **Order.** Explain, ask name and purpose, install and sign in to the AI door, start the local server, fill the owner slot (4.5), then reach the first result. Addresses and channels come when wanted. Browser download and secret storage happen only when something needs them; the Telegram setup is one such trigger.
- **Quiet output.** Package warnings go to a log. The note about running without per-action permission prompts stays, in plain words, as part of the explanation.

### 4.2 One state machine and resume

`state-machine.ts` becomes the single owner of steps for every door. It gains action kinds for door install, door sign-in, owner enrollment, address setup and first result, plus a completion ledger at `.instar/state/install-progress.json`. Each step is idempotent and records its completion after verifying its result.

The Claude skill shrinks to voice and guidance only after a before-and-after comparison of the same scenarios shows no quality loss. Until then both flows remain.

### 4.3 Non-interactive contract

An AI tool can't answer prompts, and a command that waits for a person inside a tool call hangs. So:

- The installer accepts an answers file for name, purpose, door and autostart consent. A harness can write it.
- At a step that needs the person (door sign-in, owner slot, address choice), the installer opens the browser itself, prints "finish in the window that opened", records `awaiting-person` in the ledger and **exits 0**. No link or token goes to output or logs.
- `instar install --resume` continues, and the harness polls the ledger's status.
- **With no browser on the machine**, the installer tells the person to run `instar install --resume` in their own terminal, for example over SSH. In that interactive mode it shows the AI door's device sign-in code, then the PIN or owner step, directly. The dashboard is then reached over a private address or an SSH tunnel, as the terminal explains.
- **Pages opened for the person need an installer-minted, single-use, short-lived token.** Source address grants nothing, because behind a tunnel every caller is loopback.

**Limit.** A program running as that user can read local state and open local pages, so this design stops accidents and casual injection rather than a determined local program. An ownership step taken this way is still visible to the person: the agent's first message states when the owner was set.

### 4.4 The explanation

Shown by the installer and repeated by the agent in its own voice:

> An Instar agent is an AI that lives on your computer and works for you around the clock. It remembers what you tell it, does work on a schedule, keeps its promises, and asks you before anything risky.

### 4.5 The owner slot

Until `owner-authentication.md` ships, this step shows the viewing PIN once, on the terminal or local dashboard, and sets the existing PIN-based approval. When that spec ships, the same step runs owner enrollment, in place, with no change to the surrounding flow.

## 5. AI doors

Setup asks "which AI do you want to use?", offering what it detects first. Each door declares a contract:

- **Detect** and **Signed in.** Signed in is proven by one live authenticated call that is read-only and spends nothing, such as the pool's usage read or the Codex app-server read. `claude auth status` is not proof, because it reports signed in for expired sessions. An unreadable credential store (such as a locked keychain) reads `unknown`: setup says "can't tell" and never re-signs in over a possibly working login.
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

Pi is the candidate harness for API and local doors, and needs a live proof in phase 3. If it fails, API doors route through Codex CLI provider configuration where a proof passes, and local doors stay "not yet". The doorway manifest ships in the package.

**Internal checks on a first install.** Background gates fail closed, so a weak or rate-limited door could hold the first message. Each door's first-hour posture is declared: heuristic-first where allowed, off-Claude per the existing provider-fallback policy where available. The credential wall and self-stop floors never relax. The person is told plainly when a door can't carry gates.

## 6. Addresses

The agent sets up the chosen option. The person only signs in where needed, through a link.

| Option | Needs | Away from home | Instar-hosted service required |
|---|---|---|---|
| Tailscale | Free account, app on phone | Yes | No |
| Own Cloudflare or domain | Account and domain | Yes | No |
| No address | Telegram, Slack or WhatsApp | Through that service | No |
| Same network only | Agent-held certificate, pinned by the phone at pairing | No | No |

**Default rule:** use what the person already has. A messaging service in use needs no address. Otherwise, offer Tailscale, and name same-network as the choice for anyone who'd rather not make an account. `hosted-relay.md` adds a further option.

**Pairing change.** All three gates (mint, redeem, `stableOrigin()`) accept any proven own name, with the stored device origin following. A probe proves reachability, not the transport of a later redeem, so redeem checks a predicate per address type:

| Address type | Redeem accepted when |
|---|---|
| Cloudflare named tunnel | Today's check: tunnel active and Host matches |
| Tailscale serve | Arrives through this machine's own Tailscale HTTPS front, with Host matching |
| Same network | Direct TLS on the agent's own certificate |
| Own domain through another proxy | Only with a configured trusted proxy; forwarded headers are otherwise ignored |

Plain HTTP is refused for pairing. Quick tunnels remain refused for phones.

**The dashboard on a clean browser.** Loopback HTTP is allowed for the dashboard, including through SSH port forwarding, so no certificate trust is needed for local or headless first use. Other addresses use HTTPS with a certificate the browser already trusts, such as a Tailscale name. A self-signed same-network certificate is for the pinned app only.

**Same network.** The agent terminates TLS itself with its own certificate. A new version of the pairing link carries the certificate's public-key hash in the QR code on the computer's screen, and the phone checks it before redeeming and pins it. Until `owner-authentication.md` ships, a replaced certificate means pairing again. Older links stay valid for addresses with a public certificate.

**A local name that survives address changes.** The agent advertises `<agent>-<machine>.local` over mDNS and that name is the stored device origin, so a changed DHCP address doesn't break the phone. Device signatures bind to the name. Reconnection is tested after an address change and a restart.

## 7. Reachability without messaging

Messaging can't become optional until the floor has another carrier. The protected lifeline gains a dashboard and native-app conversation carrier, keyed the same way on a minted conversation id, and the cold-start fallback gains that delivery path. The first session and conversation are created by the installer. **Phase 1 cannot ship "messaging optional" without this.** Graduating `mobilePairing.native.enabled` to the fleet, including a live-channel proof, is a phase-1 exit criterion owned by the instar-developing agent. A no-channel install on phase 1 is reachable through the local dashboard, and through a phone once a private address exists.

**Browser conversation routes.** The native routes are device-signed today. Phase 1 adds PIN-session routes for creating a conversation, sending and reading history, plus a display acknowledgment tied to a specific reply, re-sent on reconnect. A lost acknowledgment leaves the state `stored, not yet seen`, never failed. Create and send carry a browser-generated operation id in a machine-wide namespace, with a payload hash. Any valid PIN session may retry it, a reused id with a different payload is refused, and entries expire on the native rules' retention bound. Otherwise they reuse the native rules for reservation, persistence before dispatch, replay and emergency stop. A lost response followed by a retry gives one conversation and one dispatch.

**Who the dashboard speaks for.** Today the only conversation send route is device-signed. Phase 1 adds a browser send path behind a PIN session, and the PIN is readable by the agent. So dashboard messages are origin-tagged and never bind a verified operator. A no-channel, no-phone install has no verified operator until a channel or `owner-authentication.md` arrives, and operator-only conversational flows honestly wait.

## 8. Getting started

The agent's first message offers three tasks based on the stated purpose. Each needs no new account:

1. **A morning briefing** delivered on the person's channel, fired once right away.
2. **Memory:** tell it a preference, open a new conversation, and see it remembered.
3. **A promise:** a dated reminder that really fires.

**Delivery, not a send result.** Lease holds and gate holds both produce "job ran, person saw nothing", so success is defined per carrier:

| Carrier | Counts as delivered |
|---|---|
| Telegram, Slack, WhatsApp | The platform accepted it and returned a message id, read from the outbound outcome record |
| Dashboard or app | The reply is stored **and** a connected client confirmed displaying it |

With the dashboard closed and the phone disconnected, the state is `stored, not yet seen`. The installer says that and points to where to read it.

**A floor for the first minute.**

- The agent's first hello uses a fixed-template deterministic path that needs no LLM gate, like the cold-start fallback.
- The first task's result still passes normal gates, and the credential wall always applies.
- The installer waits at most 5 minutes. On timeout it sends a fixed "I'm here, my checks are slow" line, reports `unknown`, and says so. It never reports success on a guess and never stays silent.

**Live mechanisms required.** The dated reminder (`commitments.checkInReminder`) ships in dry-run today, so a stranger's first promise would silently never fire. Going live for new installs is a phase-1 exit criterion.

Then a guided second level: a scheduled email report, calendar, another computer, another agent (see `owner-authentication.md`). Each asks for credentials only when reached. Docs stop leading with "check my emails".

**Default jobs.** First-day job cost is measured in the live proof. Over 15% of a small plan's weekly quota, default jobs start after the first task completes rather than at install. Both branches get built.

## 9. Testing and proof

- **Unit and integration:** state machine and resume at every step, including `awaiting-person`; a full headless path with no browser on the target; substituted certificate refused at redeem; per-carrier delivery states with clients closed; token required on opened pages; door contracts on both sides of "signed in"; pairing on each address type at all three gates; no link or token in output in non-interactive mode; first-result timeout path.
- **E2E:** clean install per door and address, with feature-alive checks, including the lifeline with no channel.
- **Live-user-channel proof:** a stranger-shaped run per way in, on a clean machine and clean phone, recording actions, minutes and disk against 1.2, with `platform-accepted` and `client-displayed` reported separately. Includes the no-relay, no-phone path, which R2 makes mandatory.
- **Wizard quality comparison** before the Claude flow retires (4.2).

## 10. Frontloaded Decisions

1. **Install address:** `instar.sh/install` and `install.ps1`. A published address is never deleted; if it moves, a permanent redirect stays.
2. **API and local doors:** the rule and Pi fallback in section 5. Both branches are buildable.
3. **Same network:** agent-held certificate pinned at pairing, with an mDNS name as the stable origin (section 6).
4. **Default jobs:** the 15% rule (section 8).
5. **First-result limit:** 5 minutes, with the fixed-line fallback (section 8).
6. **Phone without a private address:** same network only until `hosted-relay.md` ships. Stated plainly in setup.

**Operator boundary.** Enabling the money layer needs the operator's PIN, and API doors wait on it. Nothing else here waits.

## 11. Decision points touched

| Decision point | Class | Justification, or floor and arbiter |
|---|---|---|
| Pairing requires a proven own name | invariant | Deterministic probe, no competing signals |
| Door "signed in" verdict | invariant | One live call; an unreadable store yields `unknown` with no re-sign-in |
| Which address to recommend | invariant | Fixed rule in section 6 |
| Local-model verdict for internal checks | invariant | Recorded benchmark threshold |
| Default-job start timing | invariant | Measured threshold |
| First-result timeout | invariant | Fixed limit and template |
| Which door to offer first | judgment-candidate | Floor: only detected doors. Default: the harness running the installer. Arbiter: the setup flow. Fallback: ask the one question |
| First tasks from purpose | judgment-candidate | Floor: the three named tasks. Arbiter: the agent. Fallback: offer all three |

## State versus symbol

"First result delivered" reads the outcome record, not a send result. "Signed in" uses a live call. "Own name" uses a probe answered by this process, which shows observed reachability, not exclusive control; one machine fronting a name remains a stated deployment rule. Each reports `unknown` when it can't be measured and never treats that as success.

## 12. Rollout and migration

- **Existing agents.** Installer changes don't touch installed agents. `PostUpdateMigrator` delivers the pairing change and config defaults. `migrateClaudeMd` adds the door list and address options with a content-sniffed guard.
- **Graduated rollout.** Each phase goes through a throwaway test agent, then the development agent, then the fleet. Any dry-run names its go-live condition and date in the phase's rollout note, so nothing is left dark by default.
- **Backup.** The progress ledger is not backed up.

## 13. Delivery phases

Each ships on its own, and each has a complete fresh-install acceptance scenario.

1. **Install basics:** installer, reorder, plain output, one state machine, consent, disk checks, lazy browser download, door install, reachability without messaging, new first tasks, live reminders, delivery-checked first result. **Accept:** clean machine, one-liner, Claude Code or Codex. The installer-opened page is already unlocked by its token, and the PIN is shown there for later use. First result displayed in the dashboard, and a reminder fires after the terminal closes and after a reboot.
2. **Addresses without Cloudflare:** pairing on any proven name, agent-run setup, same-network option. **Accept:** phone paired over Tailscale and over same-network, using today's dashboard PIN session for redeem.
3. **All AI doors:** contracts, shipped door list, Pi proof, local checks. API doors wait on the money layer. **Accept:** each proven door installs and delivers a first result; an unproven door says "not yet".

## 14. Instar 2

Instar 2 has its own fresh-install design in open pull requests (instar-2 #178 to #181). The user-facing behaviors in sections 4 to 6 and 8 are the shared contract. Each 1.x phase records what Instar 2 needs to match.

## Multi-machine posture

| Surface | Posture |
|---|---|
| Install progress ledger | machine-local-justification: physical-credential-locality (records setup of this disk's binaries and logins, and is meaningless elsewhere) |
| Door sign-ins | machine-local-justification: physical-credential-locality |
| Proven address names and agent TLS private key | machine-local-justification: physical-credential-locality |
| Native-conversation lifeline | Unified: one conversation identity, owned by the serving machine, using the existing pool routing |

Single-machine agents are a no-op.

## Maturation plan

- **test-agent-live:** a throwaway test agent installs on a clean machine for each door and address option, with the delivery and resume checks passing.
- **dev-agent-live:** the operator runs the one-liner and the AI-tool path on a clean machine and phone, reaching a displayed first result. Actions, minutes and disk are recorded against the baseline.
- **fleet:** the new installer becomes the published `instar.sh/install` and the default of `npx instar`.
- **graduation criterion:** a stranger-shaped run per way in reaches a first result with no operator help, in fewer human actions than the baseline, and 14 days pass on the development agent with no install-related attention item left open.
- **dark-window:** the installer has no dark form, because it reaches only new installs. Pairing and browser routes are development-gated for at most 30 days, with the go-live condition above, and then raise a maturation item.

## Open questions

*(none)*

## Left behind

- Standards gate: headless setup needs a terminal, and installing needs a computer. A first install on a computer can't be phone-only, so this is accepted; everything after it is phone-completable.
- Exact local-model hardware thresholds are set during phase 3.
- `detectPlatform` returns `unknown` on win32 and gets corrected in phase 1.
- `checkMandatePin`-family count differs by grep (44 to 52); the owner spec's inventory settles it.
