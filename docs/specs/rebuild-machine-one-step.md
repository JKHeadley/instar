---
title: "Rebuild any machine in one step"
slug: "rebuild-machine-one-step"
author: "echo"
tier: 3
status: "draft"
eli16-overview: "rebuild-machine-one-step.eli16.md"
parent-principle: "An Instar Agent Is Always a Multi-Machine Entity"
sibling-principles: "Structure > Willpower; Verify the State, Not Its Symbol; Self-Heal Before Notify; Close the Loop; No Silent Degradation to Brittle Fallback; Bounded Blast Radius; Symmetric Transport Proof; Bounded Accumulation"
parent-incident: "Post-mortem: the Mac Studio outage of 19–20 November 2026 (Echo document 59c4af4d-1fd2-4885-b0ea-7205b3b1be74, version 8). Approved by the owner in Telegram topic 145840, message 145918 (2026-11-20, about 10:33 PST): 'The postmortem is approved. We need to start on this work desperately.' The approved document contains fix-table item 12 and Drill 2 quoted below; the outage repair run that writes this spec was started under that approval."
scope: "Post-mortem issue D1; fix-table items 12 and 13; new findings N1 (the rebuilt Studio could not reach its peers over SSH and verified remote spawn was unavailable) N3 (an automatic update silently wiped an emergency local patch), N5 (macOS privacy grants reset), N7 (wrong runtime Node version) and N8 (Local Verify peers and machine references in state files lost)"
sibling-projects: "no-data-loss-on-machine-death (items 6–11, 16, 19 and the drill) and takeover-ready-pool (items 1–5, 14, 15, 17, 18 and the readiness gate)"
related-specs: "takeover-ready-pool.md (in review), no-data-loss-on-machine-death.md (in review), mutual-ssh-autobootstrap.md, server-down-remote-recovery.md, cross-machine-secret-sync-spec.md, session-pool-activation-at-pairing.md, agent-identity-continuity-on-expansion.md, MULTI-MACHINE-BOOTSTRAP-ROBUSTNESS-SPEC.md, subscription-signin-ledger.md, playwright-profile-registry.md, account-machine-matrix.md, identity-security-piece2b-owner-record-store.md, mac-local-network-access.md, GRACEFUL_UPDATES.md"
review-convergence: "2026-11-20T20:07:22.007Z"
review-iterations: 6
review-completed-at: "2026-11-20T20:07:22.007Z"
review-report: "docs/specs/reports/rebuild-machine-one-step-convergence.md"
cross-model-review: "codex-cli:gpt-6.2-astra"
single-run-completable: true
frontloaded-decisions: 10
cheap-to-change-tags: 0
contested-then-cleared: 64
clean-door-anthropic-review: "claude-code:claude-fable-5"
approved: true
approved-by: "echo, 2026-11-20, after reading the convergence report; basis: owner-approved outage repair run (Telegram topic 145840, message 145918: 'The postmortem is approved. We need to start on this work desperately.'). The spec amends neither the constitution nor a CODEOWNERS path, so the agent approves it (Rule 82)."
---

# Rebuild any machine in one step

## Problem statement

On 20 November 2026 the Mac Studio, which had been the lead machine for Echo and Luna, was erased
and reinstalled after a failed macOS upgrade. Rebuilding it took about two hours of expert hand work
by an agent session on the laptop (run log `.instar/studio-restore-run.md` on the laptop), and the
rebuild was still incomplete the next morning. Post-mortem issue **D1**: there is no "rebuild this
machine" path. Every step had a trap, and several traps caused new incidents.

| Step | What was done by hand | Trap or loss |
|---|---|---|
| Access | Owner turned on Remote Login and typed the login password; a temporary passwordless sudo rule was added | The sudo rule had to be remembered and removed at the end |
| Tools | Xcode command line tools, Homebrew, Node, git, tmux, jq, gh, Claude Code, Codex, pi, gemini, cloudflared, Tailscale | Homebrew's Node links a shared `libnode`. The official standalone Node was gone, and Local Verify's recovery tests went red on `main` hours later because they copy `process.execPath` (fb-9a79b2bd-249) |
| Code | Agent home rebuilt from GitHub plus a rescued mirror of 1,489 branches and 21 unsaved files | Five untracked custom safety hooks were gone for good. The `JKHeadley` git remote was missing. The Instar app's source had no remote at all (B11) |
| Secrets | The vault (69 keys) copied and re-keyed into the Studio keychain | The keychain is locked for SSH sessions. `instar join` with a full config fails because the new machine has no secrets yet |
| Pairing | `instar pair` on the laptop, join on the Studio; later the Mini by hand | Machine lists are pairwise. The Mama PC and the M5 Pro never learned the new Studio and kept a pool listing the dead one; the Mama PC then held every Telegram send for 8 hours (A9) |
| References | `PENDING_NEW_STUDIO_ID` hand-edited into `preferredAwakeMachineId` and `remoteDesktop.frontMachineId` on every machine; the old id revoked on each machine by hand | Every machine-id reference in every config was a hand edit |
| State | About 106 agent state files copied from a laptop backup; 24 record streams of the old Studio copied the next morning | Local Verify settings, the green-PR merge floor, the owner's Telegram id, the confirmed private group, the owner record, the paired phones and the hub topic ids were each found missing only when something failed (B1, B9, B10). No pull request merged for about 14 hours |
| Start | Luna's server stopped on purpose | The fleet watchdog reloaded it. Luna's fresh server took her lead on first boot with no Claude login, created four duplicate hub topics and posted job-failure notices |
| Tunnels | Named-tunnel credentials restored; one tunnel id mistyped | Unnoticed until a manual check |
| Accounts | A helper signed the Studio in to 14 accounts with the existing sign-in procedure | 10 of 14 unattended, 4 needed the owner. Each login folder also needed its project-trust entry written by a hand script (`trust-home.py`) |
| Machine access | none | **N1.** After the rebuild the Studio had no SSH trust with any other machine and verified remote spawn was unavailable. `GET /machines/ssh-health` on the Studio today: every pair `mutual: false`, `enrollmentState: ssh-bootstrap-blocked`, `bootstrapFailures: mutual-ssh-mesh-500` for the laptop and the Mini, while the top-level field reads `ready: true` |
| Guards | A disk-growth guard and a memory watchdog written by hand as LaunchAgents | Exist only as local files; nothing records that a machine needs them |
| Patches | Emergency fixes patched by hand into the laptop's installed code, `.instar/bin/node` and the tmux environment | **N3.** An automatic update at 10:23 on 2026-11-20 replaced the installed code and silently wiped one patch. Earlier that morning a restart rewrote `.instar/bin/node` and silently undid another, so a theory was "tested" for twenty minutes without the patch |
| Browsers | none | Echo's signed-in browser profiles exist only on the laptop (B12) |
| Done? | The session declared the run complete at 03:10 | It was not: the lead moved about 19 times overnight, and the missing items surfaced one at a time over eight hours |

Found later on 20 November, after the run was declared complete:

- **N5.** The macOS privacy grants were reset by the reinstall: Automation (node controlling Chrome),
  Accessibility, Screen Recording and Local Network. Without Local Network, `node` gets `EHOSTUNREACH`
  to peers on the home network while `curl` from the shell reaches them, so every check run from a shell
  looked healthy.
- **N7.** The rebuilt Studio's runtime Node is 22.23.5 while the helper machines run 24.14.1, so Local
  Verify's test-runner fingerprint no longer matches between the Studio and its helpers.
- **N8.** `monitoring.localVerify.peers` was lost, and the notification preferences still list the dead
  machine in `offlinePeers`.

Nothing in Instar knows the full list of what a machine of an agent must have, so nothing could say
"this rebuilt machine is ready" or "it is missing these six things". The owner's standard, in the
approved post-mortem, is that an agent on several machines never becomes unreachable and never loses
critical data because one machine went down, proven by a monthly "wipe and rebuild" drill in which
"one command rebuilds it" (post-mortem, "What we change", Drill 2 and item 12).

### Goals

1. **One step.** From a fresh operating system install, a surviving member of the agent's pool
   rebuilds the machine into a verified member of the pool in one run, started by one command or by
   the agent from a conversation. Every step a person must do is physical or personal, declared in
   code with the reason, and listed before the run starts.
2. **Every member learns.** Admitting a machine, or replacing a dead one, reaches every member of the
   pool, including members only another member can reach (item 13).
3. **Machines can act on each other again.** SSH in both directions and verified remote spawn are
   re-established and proven per direction (N1).
4. **Nothing local is lost silently.** A local emergency patch is declared. On every update or
   supervisor rewrite it either survives, is retired because the release really contains its fix, or
   holds the update loudly. An undeclared change to installed code is always saved before anything
   overwrites it, and the agent is told (N3).
5. **Ready is proven, not declared.** A readiness report checks every item on the critical list against
   the live machine and the pool, and the monthly wipe-and-rebuild drill proves the whole path.

### Non-goals

- Deciding what is critical, replicating it, the folder backup, the repository registry and
  browser-profile coverage: `no-data-loss-on-machine-death` §1–§7. This spec **consumes** them.
- The takeover-readiness gate, the replacement record and conversation re-homing:
  `takeover-ready-pool` R2, R5, R6. This spec **calls** them and adds admissions to R5's signed
  membership records (item 13).
- Installing an operating system. The person's steps begin at a logged-in desktop.
- Windows and Linux hosts in the first increments. macOS is the first host profile; the second
  (Windows/WSL, Echo's Mama PC) is increment 11.
- An agent with no surviving machine. That is a restore from the off-machine backup
  (`backup-off-machine-copy.md`).

## What already exists (and what this builds on)

Surveyed on origin/main (v1.3.1942, b61e7d3cd, 2026-11-20) and on the two sibling specs in review.

| Existing piece | What it does today | What it lacks for a rebuild |
|---|---|---|
| `instar pair` / `instar join` (`src/commands/machine.ts`) | Code-authenticated join; installs the agent identity from the sealed envelope; turns sharing on at the first pairing and carries the bot token sealed; scaffolds a machine-local `config.json`; installs **and starts** auto-start (`installAutoStart` without a no-start option) | Pairwise; no secrets before first start except the bot token; a fresh config; starts the server before anything is in place |
| `mergeRegistry` / `RegistrySyncDebouncer` | Lossless union of registries that travel in git | Echo's lease medium is local, so the registry does not travel |
| `takeover-ready-pool` R5 (in review) | `machine-replacement` record, end-to-end signed, owner-countersigned when an owner key exists; forwarded member to member; `poolDigest`; `pool-diverged` | Replacement only; the joiner still learns only the inviter's view |
| Cross-machine secret sync | Every `{secret:true}` field to every peer, end-to-end encrypted; push on provision, pull on miss; no revoke verb | Runs only once the server runs; a keychain backend cannot be read from an SSH session |
| Mutual SSH (`MutualSshRuntime`, `/machines/ssh-health`) | Per-machine Ed25519 key, pinned host key, per-direction proof, self-heal | Dev-gated, `dryRun: true` by default; bootstraps only between machines that already trust each other. The fallback status stub in `AgentServer.ts` (around line 6857) returns `ready: true` with no pairs even when readiness is required |
| `multiMachine.peerExecution`, `server-down-remote-recovery` route A | Forced-command SSH wrapper (`status`, `collect-diagnostics`, `stop-instar-server`, `hold-owned-instar-watchdog`, `start-instar-server`, `restore`) | Dev-gated, dry-run; the watchdog hold verb is fixed at 60 seconds and needs an enrolled recovery engine |
| Fleet watchdog (`instar-watchdog.sh`) | Reloads any installed agent LaunchAgent that is not running; skips plists named `*.DISABLED`; its Heal 1 reinstalls a missing shadow install with `"instar": "latest"` | Reloads an agent stopped on purpose; can overwrite a patched install |
| `subscription-signin` skill, sign-in repair, `account-machine-matrix.md` | Fresh per-machine sign-in without copying a login | Not driven by any rebuild; per-login project trust is a hand script |
| `UpdateChecker.applySelectedUpdate` / `rollback` | Installs into a candidate directory, validates it can start, promotes it, keeps a rollback | Promotion replaces every file without looking |
| Other writers of installed paths | `ServerSupervisor.preflightSelfHeal` (unpinned `npm install instar` and a `findNodePath()` re-point of `.instar/bin/node`), `ensureStableNodeSymlink` (re-picks the "most durable ABI-compatible" Node at each restart, Homebrew's among the candidates), `installAutoStart`, `migrateHooks`, `commands/install.ts`, `NativeModuleHealer` | Each overwrites a local change silently |
| Luna's `repatch-*.mjs` scripts and the `ai.instar.sagemind.repatch-local` LaunchAgent | Idempotent anchor-based re-application every 10 minutes, one restart if any re-applied | After the fact; a missing anchor is a log line; nothing knows a patch is obsolete |
| `no-data-loss-on-machine-death` (in review) | §1 owned repositories; §2 critical list and `GET /critical-state?scope=pool`; §3 departed machines' records; §4 folder backup generations; §7 browser coverage; §9 the drill | Measures a rebuild's result; does not perform one |
| `takeover-ready-pool` R2 (in review) | `TakeoverReadiness.evaluate()`, the `takeover-kit` record | Decides whether a machine may lead |

## Proposed design

```
 sponsor (a surviving member; a separate worker process)        target (fresh machine)
 ───────────────────────────────────────────────────────        ─────────────────────
 1 find     discover the target on the network; refuse a live member
 2 contact  person kit (Remote Login + password by Secret Drop); confirm the machine
 3 lock     take the run lock ON THE TARGET (epoch-fenced); unload old jobs; write the hold
 4 host     tools, standalone Node, host guards                  (once per host)
 5 admit    admission record; owner confirmation when required ─► every member
 6 agent    hold first; code; identity; bootstrap secrets; config; state; patches;
            install and start the service — held (no lead, no polling, no jobs, no topics)
 7 reach    SSH both ways, peer execution, tunnels, Tailscale, accounts
 8 report   readiness report; release the hold when the takeover rows pass
```

Shared conventions:

- **Resumable, idempotent steps.** Every step has `check` (reads the live state), `apply` and
  `verify`. A step whose check passes is skipped and recorded. A rerun resumes at the first step whose
  check fails; no step relies on the memory of an earlier one.
- **Out of the server's event loop.** The CLI command and the route only start or attach to a detached
  rebuild worker process (`instar rebuild-machine --worker <runId>`); no step runs inside an agent
  server. Hashing, copying and SSH streams run in that worker with a per-step wall-clock budget.
- **Supervised.** The run declares supervision tier 1 (`docs/LLM-SUPERVISED-EXECUTION.md`): after each
  step's `verify`, a small model reads the step's evidence and may annotate it or raise an attention
  item for the agent ("verify passed, but the account page names a different organisation than last
  time"). It never
  overrides `verify`: a step passes or fails on its deterministic `verify` alone. A step whose `apply`
  has failed its retries goes to an **agent repair turn** (a session work item with the step's evidence
  and its own brakes). When the repair is exhausted, the step becomes an owner **ask** only when its
  reason is in the closed person-only set (§7); a blocking row with no such reason gets one plain owner
  status line (§7); a non-blocking one stays an agent work item on the Work Board, retried daily with the
  next release or config change, and shown in the readiness report.
- **Every person step is declared.** Each step that can need a person declares `needsPerson` in code
  with what the agent tries first and the specific human-only reason (passkey, FileVault, a code on the
  owner's phone, a macOS prompt a background program cannot answer). `--plan` lists them; account rows
  are predicted from the account × machine matrix's last-known sign-in method and marked "may need you".
- **No secret on a command line or in a log.** Secrets move only through the vault, Secret Drop, secret
  sync or a sealed envelope; passwords and pairing codes reach remote programs on standard input or a
  pseudo-terminal, never in arguments. The run record stores names, never values. (The 20 November
  run printed a private key once and a master key once; both had to be replaced.)
- **All git mutations through `SafeGitExecutor`, all deletions through `SafeFsExecutor`.** Remote
  commands go through one `RebuildTransport` (§1), never ad-hoc `ssh` strings.

### 1. Starting a run: discovery, contact, lock

**Surface.** `instar rebuild-machine [--host <name-or-address>] [--replaces <machineId>]
[--agents <name,...>] [--plan] [--resume <runId>] [--abandon <runId>] [--rehearsal <scratchHome>]`
on a member of the agent's pool, and `POST /machines/rebuild` with the same fields, so the agent
starts it when the owner says "rebuild the Studio" in chat. The owner never runs the command. `--plan`
prints every step, what it changes, the predicted person steps and an estimate, and changes nothing.
Route inputs are validated: `runId` is a fixed-format id (it becomes a path), `--host` a hostname or
address, `--agents` names from the host's `hostedAgents`.

**Preconditions.** The new record kinds' gates must be on (§9). Machine access
(`multiMachine.mutualSsh` and `multiMachine.peerExecution`, both dev-gated and dry-run today) is not a
precondition: where it is off by policy, the run still rebuilds the machine, the continuity path is not
available (the sponsor uses the person kit), and row 11 reports "machine-to-machine access is turned off
on this agent" as a Needs-you defect naming the switches. Turning the two features on follows the
maturation ladder (test agents, then the development-agent cohort, then the fleet, each by a recorded
review decision); increment 8's guarded migration flips them on an agent of the cohort being promoted only
once every pair has fresh proof. Until increment 5b and that promotion, the continuity drill's fallback to
the person kit is a tracked item of this project (its owner), closed by increment 5b, not an open-ended
manual path.

**Finding the target.** The owner does not supply an address. The sponsor looks in this order and
records which way it found the machine: the name the owner used in chat matched against Bonjour
`_ssh._tcp` adverts on every LAN the pool's members see (the `<name>.local` the macOS Remote Login pane
shows); the LAN and Tailscale addresses recorded for the replaced machine; `--host` if given.

**Refusing a live machine.** Before any change, the sponsor reads the target's OS SSH host key, its
hardware identity, and any agent home on it answering `/health`. The run stops, and says which machine
it found, when the target is a member **of this agent** that is live by R5's rule (fresh signed liveness
within the takeover wait W, or the holder a member currently sees). A co-hosted agent that is live on
the same host (Echo live on the Studio when Luna's run starts) is expected and is not a refusal; it puts
the host stage into its check-only mode (§2). A rehearsal is scoped to its scratch home and refuses only
if that scratch home is live.

**Which SSH host key.** Continuity is defined by the **operating system's sshd host key**
(`/etc/ssh/ssh_host_ed25519_key.pub`), which survives an agent-folder wipe and is replaced by a
reinstall. Instar's own mutual-SSH keys live inside the agent folder (`<stateDir>/machine-ssh`) and are
wiped with it, so they cannot prove continuity. Every member therefore publishes its OS host-key
fingerprint in a record it signs (`host-key` record kind, written at boot and when the key changes), and
the admission record pins the new machine's.

**How the sponsor logs in.**

| Case | Login | Person kit |
|---|---|---|
| **Continuity** (agent folder wiped; the target presents the OS host key the pool recorded for the replaced machine) | through the peer-execution wrapper (route A), once cross-spec change C7 has moved its trust bundle outside the agent folder so it survives the wipe (until then: the reinstall row's login and kit). A new wrapper verb `rebuild-step` accepts only entries of the run's closed command table, signed by the sponsor with the current lock epoch; it is not a shell | none after C7, unless a host-stage step needs `sudo` (then the kit below, for the password only) |
| **Reinstall or new hardware** | password login over SSH as the login user | the kit below |

**The continuity route depends on cross-spec change C7.** The forced-command grant lines live in
`~/.ssh/authorized_keys` and survive a folder wipe, but everything the command they run depends on lives
in the agent folder today: the recovery runtime slot, `.instar/recovery/` (authority, runtime manifest,
proofs, admission and lease store, certification root) and the grant inventory that holds the members'
signing keys; `RecoveryMainBindings` and the fleet watchdog's `recovery_rule_state` also hard-code that
path. C7 (a change to `server-down-remote-recovery`'s route A, built by this project as increment 5b) moves that whole bundle to a
host-level root (`~/.instar/peer-exec/<agent>/`), with a migration that rewrites the existing `command=`
lines and the watchdog's path checks. Until C7 lands, the continuity path is unavailable, a drill uses
the person kit, and drill row R9 counts those asks so the improvement is measured when C7 ships.

**The `rebuild-step` verb is refused by the target itself on a live machine.** The wrapper accepts
`rebuild-step` (and the lock it needs) only when, on this host, the named agent has no running server, no
valid machine identity of its own, and no fresh signed liveness, or its home carries a hold for the same
run; and only for a signed `rebuild-run` record that names this host's OS host key. The sponsor's
live-machine refusal is therefore not the only check: a confused or compromised member cannot use the verb
to rewrite a working machine.

**The person kit.** At the fresh machine, listed by `--plan` before anything runs:

1. Finish the macOS setup and log in (the same account name keeps every path; a new one works but is
   slower).
2. Turn on Remote Login (System Settings → General → Sharing → Remote Login).
3. Open the Secret Drop link the agent sends to the phone. The page shows the machine name the sponsor
   found ("Mac-Studio.local") and asks the person to check it matches the Remote Login pane, says plainly
   that the password goes to that machine before the on-screen code confirms it, offers the cable option
   (Frontloaded Decision 9) for anyone who prefers not to, and asks for the login password.

**Confirming the machine before any agent secret moves.** The hardware identity a target reports about
itself (`IOPlatformUUID`) is a hint, never proof. What decides trust:

| Case | Proof | Owner step |
|---|---|---|
| Continuity | possession of the recorded OS host key, **and** the replaced machine was never revoked for cause (below) and is not live by R5's rule (no fresh signed liveness within W, not the holder; reaching it through the wrapper does not count), **and** the reported hardware id matches the replaced machine's | none (the continuity grant, §3) |
| Reinstall or new hardware | the code shown on the target's own screen, replied by the owner | one reply, which is also the admission approval |

**The code on the screen.** The code is generated **on the target** by the guard (below), never by the
sponsor, and never leaves the target in any form. The guard shows it through a one-shot LaunchAgent
bootstrapped into the logged-in user's desktop session (`launchctl bootstrap gui/<uid>`), which runs a
small dialog helper; a dialog started directly from an SSH session fails on macOS ("No user interaction
allowed", error -1713), so that path is not used. The owner's card says "reply approve followed by the code
on the Mac's screen". The check is **commit-reveal**, so neither side verifies alone: before the card is
sent, the guard gives the sponsor a commitment `C = SHA-256(code ‖ nonce ‖ guardKeyFingerprint)` with a
fresh 128-bit nonce it keeps in memory; the code and nonce are never written anywhere. The owner's reply
reaches the sponsor's server through the card flow. The guard enforces the order: it reveals the nonce only
**in exchange for a reply** (the sponsor submits the owner's reply; the guard records it, retires the
displayed code, and only then returns the nonce), so a reveal requested before the owner replies cannot
help anyone, because it spends that code. The sponsor checks `SHA-256(reply ‖ nonce ‖ guardKeyFingerprint)
= C` itself. An impostor host's guard cannot make a
wrong reply match, because it committed before seeing the reply; a session that reads `C` cannot recover
the code without the 128-bit nonce. After a reveal the nonce is spent: a mismatch shows a fresh code with
a fresh commitment, at most three times per run before the run pauses at the code step and says so (a
resume continues from that step with fresh codes). Codes use an alphabet without lookalike characters
(no 0/O, 1/I/L), since they are typed on a phone. Admission requires the
sponsor-side match. On the reinstall path this one
reply is both the admission approval and, when the replaced machine has Pending debt, the Amendment-6
owner activation (§3); no second card follows. Increment 5's tests cover the mechanism on a logged-in test
account, the "code and nonce exist only in the guard's memory and on the screen" property, and a
continuity run that completes with no `sudo` and no password.

**The login password.** Needed for the SSH login of the reinstall case and for the host stage's `sudo`.
It is held as a run-scoped secret record (`rebuild-secret`, encrypted to the sponsor's key and to the keys
of the takeover-eligible members that could resume the run, never to the target). When the guard is installed, the
sponsor also adds **run-scoped keys** to the login user's `authorized_keys`, one for the sponsor and one
for each resume-eligible member. They are written through `PeerAuthorizedKeys`, the only writer of
`authorized_keys` (with its lock and symlink checks), under a new `instar-rebuild-access` namespace; each
is forced to an argument-free per-run guard path (`~/.instar/rebuild/<runId>/guard`, which reads
`SSH_ORIGINAL_COMMAND`), carries no shell, no forwarding, and an `expiry-time=` at the run's deadline, rewritten through
`PeerAuthorizedKeys` whenever the deadline moves (person waiting time extends it), so an overnight wait
for the owner does not expire the keys a resume needs, and
is included in the removal and leave cleanup. It verifies a login with its own key and asks one designated successor to verify a login
with its key. These keys do not depend on peer execution, so every later stage, and any resume, logs in
with them. The guard refuses every entry once the agent is live on this host and not held for this run,
and the agent's server removes any `--run` key line for a run that is not open, at every boot and
whenever it applies a release or an abandon, so the keys cannot outlive their run even when the run
ended by an owner-signed release or was never acknowledged; and the password is **deleted as soon as the host stage verifies and the successor's login
has verified**; when no resume-eligible member other than the sponsor exists (a two-machine pool rebuilding
its dead member), as soon as the host stage verifies, and a later resume by another member asks for a
fresh Secret Drop (a person step `--plan` predicts). The run key is removed when the guard commits its terminal
record. Row 18 records the deletion. Deletion is a signed tombstone each
holder applies, and the report records it. `sudo` is fed the password on standard input, one command at a
time; the login keychain is unlocked for the run's own SSH session through a pseudo-terminal and locked
again afterwards. No passwordless sudo rule is written.

**The run lock lives on the target.** Every sponsor must reach the target, so the target arbitrates. The
first command atomically creates the lock file `~/.instar/rebuild/<agent>.lock` (`O_CREAT|O_EXCL`)
holding `{runId, sponsorMachineId, epoch, sponsorHeartbeatAt}`, and installs a small **guard** on the
target. Every later command runs through the guard, which refuses a command whose `{runId, epoch}` does
not match. The sponsor's worker renews `sponsorHeartbeatAt` every minute over its existing connection; the guard
stamps each renewal with the target's own clock, and the ten-minute test below reads that stamp, so clock
skew between machines cannot cause an early takeover. A
resumer may take the lock when the heartbeat is older than ten minutes, or at once when the old sponsor's
own server has signed a "worker exited" record for that run (the worker's supervisor writes it only when
the worker stops for good: finished, abandoned, or failed with no restart pending; a worker restarting
after its machine rebooted does not write it); the takeover is a compare-and-swap done by the guard under
an exclusive `flock` on the lock file, so two resumers cannot both win, and it bumps `epoch`.

**The target's keys exist from first contact.** When the guard is installed it generates the target's new
machine keys (the ones the agent will use; the later join step adopts these exact keys rather than minting
others) and its own guard key, fresh for each run and tagged with the `runId`, and persists them under
`~/.instar/rebuild/<runId>/` (outside the agent folder, so a reboot or a mid-run folder change keeps them).
At join the machine keys move into the agent folder, where they live from then on; the guard key and the
directory are deleted when the guard commits its terminal record, but only after the exact signed terminal
record has been written to `~/.instar/rebuild/terminal/<runId>.json`, outside the disposable directory.
Any resumer (or the target's own server, once its hold is gone) publishes that record idempotently, so a
sponsor that dies between the commit and the publish cannot leave the pool treating a released machine as
held; a test kills the sponsor right after the commit. A later run never adopts keys tagged
with another `runId`, so a folder wipe cannot bring back an old or revoked identity. The
guard key is bound before anyone relies on it: on the reinstall path by the owner's code reply (the card
carries the guard key's fingerprint, and the reply approves that fingerprint together with the machine
keys); on the continuity path by the SSH session itself: the sponsor reached the guard over a connection
pinned to the recorded OS host key (which only that installation holds; the key file is root-only, so
nothing on the target signs with it directly), and the sponsor signs the guard key's fingerprint into the
admission record. The first admission record
pins both. The guard then signs a **lock receipt** `{runId, epoch, sponsorMachineId}` with its key at each
grant or bump, so a receipt is never self-certifying. A reboot between approval and join keeps the keys,
and a test covers it. Another test reboots the target during the host stage with an old plist present and
checks that nothing of the agent starts.

**One host lock for shared pieces.** Besides the per-agent lock, the host stage (§2) takes a host-wide
lock (`~/.instar/rebuild/host.lock`, same mechanism). Two agents rebuilding a freshly erased host at the
same time therefore cannot both install Node, Homebrew, the fleet watchdog or the host guards: the second
waits, then rechecks under the lock and, finding the shared pieces present, runs check-only. A host lock
whose holder's heartbeat is ten minutes stale can be taken by any agent's run through the same
`flock` compare-and-swap, so a co-hosted agent is never blocked by a run whose pool never resumes.

**Fencing what the old sponsor started.** Command-table entries are classed `direct` or `delegated`. A
`direct` command runs as a child of the guard; on a takeover the guard stops every process group of the
older epoch before the new epoch's first command. A `delegated` command hands work to a system daemon
(`softwareupdate`, `installer`, `launchctl`, Homebrew under `sudo`), which no process-group kill reaches;
the new epoch's first action waits until that daemon is quiet (no install in progress, package receipts
stable for one minute) and then re-runs the step, which is idempotent. The fence claim is limited to that.

**Fencing what the old sponsor sends to the pool.** Every pool-side record the run issues
(`machine-admission`, `rebuild-release`, a revocation made by the run) carries `{runId, epoch}` and a
**guard commit**: the guard's signature over that exact record's digest, given once per record kind per
run. The guard commits one admission payload per run (a re-issued admission after a takeover is a new
commit at the new epoch that also voids the old one), so a peer that missed the takeover and later sees the
old sponsor's delayed admission finds no matching current commit and refuses it. A signature alone cannot
prove freshness, so **secret sync to a newly admitted machine starts only after the member obtains a
fresh confirmation from the guard**: the member sends a nonce, and the guard answers with the current
`{runId, epoch, admission digest}` signed with its key, serialized under the same `flock` as takeover and
abandon. **Scope:** this gate applies only to admissions that carry a `runId`, and only until the run's
release; an ordinary `instar join` (no guard) keeps today's secret sync, and after release sync is
ordinary again. It is cross-spec change C8 against cross-machine secret sync (push and pull), built in
increment 7 with its tests. A member that cannot reach the guard directly gets the confirmation relayed through any member that can,
carrying the requesting member's own nonce, so a relay cannot replay another member's confirmation; a
member that cannot get one at all defers delivery and is listed in the readiness report as "has not yet
delivered secrets to the new machine"; it never delivers on a commit alone. The target's own held server is
one such relay: the guard signs, so the relay need not be trusted, and members without a run key (a
remote member such as the Windows machine) use it. Once the run is
released, a verified `rebuild-release` (which carries the guard's terminal commit, or the owner-signed
fallback) replaces the fresh confirmation, so a member that was offline at release delivers on its return;
after an abandon nothing is delivered. Release and abandon are terminal and mutually exclusive at the
guard: it commits one of them once. If members nonetheless see both for one run (an owner-signed abandon
made during a partition while the guard committed a release), the outcome depends on what has already
happened, which each member records (`deliveredAfterRelease` per run, and whether the machine has held the
lease). **Before any member has delivered secrets after the release and before the machine has led,
abandon wins** on every member, whatever the order of arrival: the admission is revoked, which is the safe
outcome, and the owner gets one line saying the run was abandoned and can be re-run. **After a delivery,
or once the machine has held the lease,** nothing is revoked automatically: revoking cannot recall a
delivered secret, and revoking the only live lead would silence the agent. The machine becomes not
takeover-eligible (it keeps serving if it is the only live member), and the owner gets one line: keep
this machine, or remove it and rotate the named delivered secrets. **When the guard itself is the broken part**
(wedged or unreachable), the owner's one-tap clear from the readiness report produces an owner-signed
`rebuild-release` (or abandon) that members accept without a guard commit, and which also stands in for
the guard's confirmation for secret sync (row 3 then reads the secret-sync digest after release) (signed with the owner key; on an
agent with no owner key, the lease holder signs it together with the trust-request flow's record of the
owner's reply, which members verify as they verify that flow's other approvals); the guard records it when it is
next reachable and refuses anything later for that run.

**Run record.** The full record is `state/rebuild/<runId>/run.json` on the sponsor (steps with check,
apply and verify results, the person list, never a secret or the screen code). A secret-free
`rebuild-run` record carries the cursor, the pins (target address, OS host-key fingerprint,
`hardwareIdHash`) and the newest lock receipt, so a resumer refuses a target that no longer matches. The
record is a progress view; the lock on the target is the authority. Run records are kept until the run
is closed (released, abandoned, or failed and acknowledged); only closed runs are pruned, keeping the
newest 12 closed runs per agent.

**Transport.** `RebuildTransport` runs commands over SSH pinned to the recorded host key, through the
guard. Commands come from a closed table (install package X from source Y with integrity check Z, write
file F with content hash H, run step S). The table bounds what the sponsor intends to run; it is not a
sandbox against a compromised sponsor, and the guard only fences sponsors that follow the protocol. Every
installer names its integrity source (a published checksum, a signed package, or Homebrew's bottle hash).

**Multi-agent hosts.** A host may run several agents (the Studio runs Echo and Luna). The host stage (§2)
runs once per host, in full only when no other agent is live there. The agent stages run once per agent,
each sponsored by a member of **that** agent's pool, because one agent's sponsor can read neither another
agent's vault nor its pool, and admitting a machine to an agent is that agent's trust decision. Each
machine publishes `hostedAgents` (names and fingerprints) in its pool, so the host's report lists every
agent that lived there. For each co-hosted agent with a reachable surviving member, the sponsor sends that
agent a signed A2A notice ("your host was rebuilt"). The receiver treats it as a lead, never a trigger:
its own run starts only against a target its own pool recorded for its own member, and goes through its
own discovery, refusal and confirmation. A co-hosted agent's run needs the login password only to log in
(its own stages need no `sudo`), so it asks for one Secret Drop and, after a reinstall, its own code reply
(Frontloaded Decision 8). Until that agent's run installs its service, nothing installs it, and any old
plist of that agent is disabled (§4 step 1), so the fleet watchdog has nothing to reload.

**Rehearsal mode.** `--rehearsal <scratchHome>` rebuilds one agent into a scratch home on a machine that
keeps its live agent running, for the drill's rehearsals (`no-data-loss` §9). It skips the host stage;
uses a service label outside the fleet watchdog's `ai.instar.*` glob (`dev.instar-rehearsal.<agent>`),
its own port and state directory; never writes `.instar/bin/node`, the live agent's LaunchAgent or any
host guard; is excluded from Frontloaded Decision 7's scan; carries **no channel credentials** (stand-in
values for the bot token and tunnel credentials); and its server refuses to poll or send in rehearsal mode
whatever its files say. Its admission is checked against a throwaway pool record discarded with the
scratch home. Because of the stand-ins, a rehearsal has its own expected results for the rows that touch
real channels (row 3's secret digest is compared over the non-channel secrets only; R2's `getMe` and row
13's public hostname are recorded as "not exercised in rehearsal"), and the rehearsal report lists every
production check it did not exercise. Those checks are required in the next real-wipe drill.

**Abandoning.** `--abandon <runId>` always revokes the admission (revocation is the fence), deletes the
password, takes the guard's terminal commit and leaves the target's hold in place. If any secret may have
reached the target, it adds one line to the owner's list naming the secrets to rotate and offering to
rotate them. The list is generated, not fixed: every credential version in the bootstrap envelope (the
agent's auth token, the recovery bearer, the tunnel credentials, the backup key) plus every vault secret
version secret sync delivered to the target, read from secret sync's own delivery record.

### 2. The host stage

**Check-only when another agent is live.** Pieces shared by every agent on the host (the runtime Node,
the fleet watchdog, host guards, Homebrew) are installed or replaced only when no other agent is live on
the host. When one is (Luna's run after Echo's), the host stage only checks them and reports a mismatch
as a row; it never replaces a runtime or a service under a live agent.

**Which tools.** Every member publishes a secret-free **tool inventory** (name, version, source,
integrity hash, the install manifest's per-group digests and drifted paths (§6), and grant names) as its
own record kind `tool-inventory`, written only when its digest changes. It is
written at boot and when a tool binary's size or modification time changes (a cheap check run hourly in
the background, not a file watcher); heartbeats carry only its digest. The host stage installs the union
of: the tools the agent's configuration needs (each enabled framework's CLI, `gh` when Local Verify posts
statuses, `cloudflared` when a named tunnel is configured, Tailscale when a member advertises a Tailscale
address), the tools in the replaced machine's last inventory, and every dependency a declared host
addition names (§6). Each at the newest version any live member runs, except the runtime Node.

**The runtime Node.** The official standalone build, verified by its published checksum and by
`otool -L` showing only system libraries (the test `RecoveryRuntimeSlot` already applies). Its **exact
version** is the one named by the pool's Local Verify test-runner fingerprint (the runtime the helper
machines match against), else the version the replaced machine ran, else the lease holder's. The rebuilt
Studio got Homebrew's 22.23.5 while its helpers run 24.14.1, which broke fingerprint matching (N7); row 8
checks the exact version against the fingerprint.

`ensureStableNodeSymlink` and the supervisor's `findNodePath()` gain a **preference**, not a hard rule,
ranked **below** the existing native-module check (`pickDurableNodePath` keeps only a Node that can load
the shadow install's `better_sqlite3.node`): among ABI-compatible candidates they prefer a standalone build,
and they never move `.instar/bin/node` from a standalone build to a shared-`libnode` one. A machine that has only Homebrew or nvm Node keeps working
and reports one loud degradation ("this machine's Node is not the standalone build; recovery and Local
Verify's recovery tests need it") with self-heal: on machines that need it (the recovery runtime enabled,
or a Local Verify fingerprint present; not a download on every fleet update) a guarded migration installs
the standalone build at the fingerprint's version, rebuilds the native modules in a candidate through the
update worker, validates that the candidate starts, and only then re-points `.instar/bin/node` through the
funnel (§6), after the privacy-grant probe of the new binary (below). Making it a hard rule would make every fleet machine without a standalone
build fail at its next restart (`No real Node binary found outside managed symlink`). Xcode command line
tools are installed headless through `softwareupdate` with the label it lists, so no dialog appears.

**Co-hosted agents stay down until their own run.** Before the host stage installs or starts the fleet
watchdog, it writes a host-level suppression entry (`~/.instar/rebuild/suppress/<agent>`) for every
agent that is not live on this host and is not the agent being rebuilt, found two ways: the replaced
machine's `hostedAgents` (when it published one), **and** every agent that has an `ai.instar.<agent>*`
plist on the host (which covers a machine that died before `hostedAgents` existed, new hardware with no
list, and plists a Migration Assistant restore brought back). A test covers the Migration Assistant
case. The fleet watchdog skips a suppressed agent (it reloads nothing of it and heals nothing in its
home). The entry never edits that agent's files or plists; it is removed only by that agent's own run when
it writes its hold, and until then the host's report shows the agent as "not rebuilt here yet". This is
what stops a surviving plist of Luna's from being reloaded half-built while Echo's run sets up the host.

**Host guards.** Instar-shipped host services (the fleet watchdog, the disk steward's host pieces) and
every declared host addition (§6, such as the disk-growth guard and the memory watchdog) are installed and
proven running from the context they run in (launchd's desktop session, not the SSH shell), each by its
own self-test.

**macOS privacy grants (N5).** Automation (node controlling Chrome), Accessibility, Screen Recording,
Local Network and Full Disk Access are per-installation grants that macOS resets on a reinstall and lets
only a person give. The run requests only the grants an **enabled feature** of this agent needs
(Automation for the normal-Chrome browser feature, Screen Recording and Accessibility for remote desktop,
Local Network when any peer is reachable only on the LAN, Full Disk Access only for a feature that reads a
protected path); a grant the old machine held for a feature that is now off is listed, not requested.
Every grant is checked **without asking and from a process started the way the server is started**
(launchd), never from the SSH shell, because macOS ties the grant to the program:

| Grant | Probe (never raises a prompt) |
|---|---|
| Local Network | a launchd-started `node` opens a TCP connection to a peer's LAN address; `EHOSTUNREACH` while the same connection succeeds from the shell means the grant is missing |
| Automation (node → Chrome) | `AEDeterminePermissionToAutomateTarget` with asking off; when Chrome is not running the result is `unknown`, Chrome is never launched to probe, and the probe re-runs on the browser feature's next real launch of Chrome |
| Accessibility | `AXIsProcessTrusted()` for the runtime binary |
| Screen Recording | `CGPreflightScreenCaptureAccess()` for the runtime binary (no capture, so a locked screen cannot read as "missing") |
| Full Disk Access | a read of the protected path the feature uses |

Probes run during the host stage, again after any change of `.instar/bin/node`, and once a day; never on
every boot. Because the grant follows the binary, a new runtime is probed **before** `.instar/bin/node`
is switched to it; when a needed grant would be lost by the switch, the switch waits for the person row
instead of silently dropping the grant. Each missing grant is one person row with the exact words the
person will see ("System Settings → Privacy & Security → Local Network → turn on node"), what it covers
(macOS grants it to the Node program, so every agent process using that runtime shares it), and, where
macOS can raise the prompt itself, the run raises it so the person only taps Allow on the Mac. The grant
names each member holds are published in its `tool-inventory` record.

**What the agent tries before asking.** Automatic login after a power cut: set with `sysadminctl
-autologin` when FileVault is off; when FileVault is on, macOS refuses automatic login and the row says
so. Tailscale: the agent opens the node's login link in the owner's signed-in browser profile through the
existing sign-in procedure and approves the device there; only when that profile cannot complete it (a
passkey, a code on the phone) is it a person row.

### 3. Admission that every member learns (item 13)

**The admission record.** A rebuild has the sponsor issue a **`machine-admission`** record in the same
signed membership-record family as `takeover-ready-pool` R5's `machine-replacement`:

```
{ id, kind: "machine-admission", runId, newMachineId, newKeys, newKeyFingerprints,
  osHostKeyFingerprint, hardwareIdHash?, hostedAgents, replaces?: <machineId>, lockReceipt,
  admittedBy: <sponsor machineId>, authority: { kind: "owner-confirmed", approvalRef, ownerSignature? }
                                            | { kind: "standing-grant", grantRecordId }
                                            | { kind: "pairing-code-only" },
  issuedAt (HLC), signature (sponsor) }
```

A rebuild that replaces a machine issues R5's replacement record in the same run under the same
authority, and the two are **applied together or not at all**: the replacement record carries the
admission's digest and `runId`, and a member that receives one defers it until it has verified the other,
so no member ever sees the new identity active without its hold and its secret-delivery gate. The hold
state (held for run R, or released) is part of `poolDigest`, so row 1 detects a member that disagrees. Both are end-to-end signed over a canonical payload and verified on every hop against the
issuer's registry key, so a relayed record verifies. Forwarded member to member, directly or relayed,
deduplicated by `id`, idempotent on apply.

**Who may admit.** An admitted machine receives every agent secret through secret sync and may take
the lead.

- **Reinstall or new hardware:** `authority: owner-confirmed`. The sponsor opens a trust-request card
  (`POST /trust/requests`, new change kind `machine-admission`) naming the machine's nickname, model
  and the sponsor; the owner replies `approve` with the code shown on the target's screen (§1). The
  approval is bound to the new key fingerprints and the pinned host key and is valid for the life of
  the run (void when the run releases, fails or is abandoned, or when the fingerprints change); the card
  itself expires by the existing trust-card setting (`cardTtlDays`). When an owner key exists in the
  owner-record chain, the owner's reply is countersigned with it as R5 already requires.
- **Continuity (same installation: the target presents the OS host key recorded for the replaced
  machine):** `authority: standing-grant`. The owner gives one standing grant,
  `machine-replacement-continuity`, through the same card flow the first time a continuity replacement
  happens. The grant is itself a record signed with the owner key (or, with no owner key, by the owner's
  approved reply as recorded by the trust-request flow). Its scope: this agent; a replacement where the
  target proves possession of the replaced machine's recorded OS host key and reports the same hardware
  id; the replaced machine **not live by R5's rule (no fresh signed liveness within W, and not the holder
  any member sees) and never revoked by a person or for cause**. Reaching the target through the
  peer-execution wrapper does not count as liveness: the wrapper answers on a wiped home too. A person's `instar machines remove`, a revocation from the identity-recovery flow, or
  any revocation that names a reason other than "replaced" removes that machine from continuity for
  good, so a stolen or compromised machine cannot re-admit itself with its own key. A copied disk
  (Migration Assistant, Time Machine) that carries `/etc/ssh` is the stated residual: it needs the
  owner's own disk, and its hardware id differs unless it is the same Mac. The grant is revocable at any
  time. The offer says what it covers, what
  it does not (new hardware, a new install, a machine that is alive) and that it covers future
  replacements. **This needs R5 amended** to accept a valid, unrevoked standing-grant record in place of
  a per-replacement countersignature (cross-spec change C1, below). Receivers still refuse a
  replacement of a machine showing fresh signed liveness within W or that they see as holder (R5's own
  rule).
- **No owner recorded** (a new agent): `authority: pairing-code-only`, today's gate, recorded so the
  report shows it.

**The constitution's replacement-host rule (Amendment 6).** For Pending conversation information, the
multi-machine article accepts "an owned replacement host … only through authenticated owner activation,
a complete source manifest transferred durably, a monotonic fence and the archived activation chain", and
says a pinned key alone does not make a machine the replacement. This spec therefore separates two
things. **Admission** makes the target a new member; the continuity grant may do that. **Becoming the
replacement host for the replaced machine's Pending items** (its "Recorded here" debt) is never done by
the continuity grant. When the replaced machine has Pending debt, the run asks the owner's activation
card even on the continuity path (one reply), and records the other three parts: the source manifest is
the folder-backup generation's signed manifest (`no-data-loss` §4), the fence is the lock epoch plus the
replacement record's HLC, and the chain is the archived admission, replacement and release records. When
there is no Pending debt, nothing is inherited and no activation is needed. Debt the run cannot recover
stays named debt, as the article requires.

Ordinary `instar join` issues an admission too (increment 4). For a join, entering a pairing code minted
on a member is the existing operator act and stays sufficient where no owner key exists; with an owner
key, a join of new hardware gets the same card (one reply).

**The joiner learns the whole pool.** The sponsor's join reply carries the full signed membership set:
every applied admission, replacement and revocation record, each verifiable alone. The target applies
what it verifies and computes `poolDigest` (R5). Records for machines revoked more than 180 days ago are
folded into a signed checkpoint by the lease holder so the set does not grow without bound.

**Which path carries membership records.** Admission and replacement records travel on R5's own
membership forwarding, not on a WS2 kind, so they follow R5's rollout. Until R5's forwarding is live on
an agent, that agent's ordinary joins stay pairwise as today, and its rebuild waits at this step
(dependency table).

**Every member learns the joiner.** A member that verifies an admission adds the machine (with its
pinned host key) and forwards the record. The step's `verify` reads `poolDigest` from every member,
directly or by relay, and passes when every reachable member reports the same digest. A member reachable
by no route is listed ("has not learned the new machine yet", with its last-seen time), and R5's
divergence self-heal closes it when it returns. Before increment 4 lands in R5's record family, this
step cannot run and the rebuild waits (dependency table).

**Re-pointing references to a replaced machine.** Every config key that holds a machine id, including
inside arrays (`monitoring.localVerify.peers[].machineId`), carries the `machineRef` annotation in the
config-scope list (§4), and every **state file** field that holds one (for example the notification
preferences' `offlinePeers`, which still listed the dead Studio on 20 November) is declared the same way
in the state coherence registry. When a replacement applies, each member rewrites its own `machineRef`
values naming the old id to the new one, records the rewrite in its config history, and keeps every
unrelated entry. Verification is per member: each member reports, for its own references, that no value
names the replaced id and that the values it expected after substitution are present. Cross-member
equality is required only for `machineRef` values of `agent` scope (for example
`preferredAwakeMachineId`); `machine`-scope lists (a peer list in which A names B and B names A) are
checked against each member's own expectation. This replaces the `PENDING_NEW_STUDIO_ID` hand edits. Conversation ownership
moves through R6, not here.

**A replaced machine that comes back.** In the reinstall case its disk is gone. In the new-hardware case
the old machine may still exist with every secret. Its server, on seeing its own revocation from any
peer, stops polling, claiming and sending (R5's revocation fence). Because it may never see a peer, the
report carries a row "replaced machine fenced or secrets rotated", and the owner's list offers one
rotation of the bot token and bootstrap secrets when the old machine was not wiped.

### 4. The agent stage

Order matters. Each step's `check` reads the live target.

1. **The hold first, and nothing old can start.** This step runs **immediately after the lock is taken,
   before the host stage**, because the host stage installs and starts the fleet watchdog, which would
   otherwise reload an old plist. It touches only this agent's jobs; a co-hosted agent's jobs are left
   alone. Before any agent file lands, the sponsor (a) for every
   existing `ai.instar.<agent>` and `ai.instar.<agent>.*` job on the target, unloads it
   (`launchctl bootout gui/<uid>/<label>`, because launchd keeps a loaded job and its restart-on-exit
   setting brings it back whatever happens to the file), renames its plist to `*.DISABLED` (which the fleet
   watchdog skips), verifies with `launchctl print gui/<uid>/<label>` that the job is gone, and records
   each in the run record (at release each is replaced by the newly installed one or re-enabled from the
   register); a folder-only wipe or a Migration Assistant restore leaves those jobs in place, and they
   would start the server the moment code and config land; and (b) writes `<projectDir>/.instar/rebuild-hold.json`
   (`{runId, epoch, sponsorMachineId, createdAt}`). The file is not part of `config.json` and is excluded
   from snapshots and backups. The fleet watchdog's Heal 1 refuses to reinstall a home that has this file.
   The hold is then known three ways, and fails closed in each:
   - **The target's own server** counts itself held while its applied membership set contains its own
     `machine-admission` with a `runId` and no matching `rebuild-release`, whatever the local file says.
     Polling, scheduled jobs and sends are local acts no peer can refuse, so this is the check that stops
     them; the file is only the fast path for the first boot, before the membership set is applied.
   - **Every member** treats the admitted machine as held until it applies a `rebuild-release` for that
     run that carries the guard's terminal receipt (§1): members refuse its lease claim, ignore it as a
     takeover candidate (R2 reason `rebuild-in-progress`, cross-spec change C2) and refuse a singleton it
     tries to create.
   - **The guard** on the target grants the terminal receipt once, for release or for abandon.
2. **Code.** The agent home is restored from the owned-repository registry (`no-data-loss` §1): every
   remote the registry lists, under the same names (the `JKHeadley` remote is one), plus the pool
   mirror's private backup refs, so unpushed branches return. The comparison with the mirror is one
   digest of `git for-each-ref` per repository, not one round trip per branch. When a folder-backup
   generation (`no-data-loss` §4) exists for the replaced machine, its untracked files, candidate
   mirrors and the staged and unstaged worktree captures it holds are restored, with a per-path report
   of where each came from. Without one, the report says "untracked files of the old machine: not
   recoverable" rather than implying none existed.
3. **Identity.** A new machine identity (R5: a rebuilt machine is a new machine) and the agent identity
   from the sealed pairing envelope, through the join path in a **no-start** mode (the join's
   `installAutoStart` call is moved behind a flag this run sets).
4. **Bootstrap secrets.** The sealed envelope carries, beyond the bot token, every secret the server
   needs to start and reach its peers (the agent auth token, the recovery bearer, the tunnel credentials,
   each sealed to the new machine's encryption key. Folder-backup generations (`no-data-loss` §4) are not
   opened with a key carried here: each generation's data key is wrapped to the members current at backup
   time, and a fresh identity has no wrapper, so a surviving recipient either restores the selected
   generation onto the target itself or rewraps that generation's key to the approved target's key after
   the admission verifies; the test restores with the predecessor's private key unavailable. The rest
   arrives by secret sync once the server runs. The vault backend is chosen for the server's launch
   context: the keychain only when a canary secret is read successfully **by a process launchd
   started**; otherwise the headless key vault.
5. **Config from scopes.** `src/data/config-scope.json` gives every config key path one **scope**: `agent`
   (the same on every machine), `machine` (differs per machine; inherited by a successor), `secret`
   (resolved from the vault, never copied) or `derived` (computed at boot, never written); and,
   separately, an optional **reference annotation** `machineRef` (with a JSON path for ids inside arrays)
   for any field that holds machine ids. The two are independent: `monitoring.localVerify.peers` is
   `machine` scope with a `machineRef` annotation (inherited from the predecessor's snapshot, then id
   substitution); `preferredAwakeMachineId` is `agent` scope with a `machineRef` annotation (equal across
   members after substitution). A test restores asymmetric peer lists together with a shared
   `preferredAwakeMachineId`. An unlisted key is treated as `machine`, the conservative choice because it is never
   copied, and CI fails on it so it gets classified. The lint (`scripts/lint-config-scope.js`) reads
   the config type, `ConfigDefaults` **and every live config read** (`config.<path>` and the live-read
   helpers), because the settings lost on 20 November (`monitoring.localVerify.*`) are read untyped in
   `LocalVerifyService.ts`; increment 3 also types that block. This list is the field-level detail the
   sibling's state coherence registry references for its config categories; there is one source of
   truth (cross-spec change C4). Where `no-data-loss` §2's `agent-setting` record carries an agent-scope
   key, the record is the authority and this step only checks its digest.
   - `agent` values are compared across **every reachable member**, not copied from the lease holder.
     Where members agree, the value is applied. Where they disagree: a write of the default value (a
     join or scaffold write) never wins; a value a majority of reachable members hold beats a lone newer
     one; otherwise the newest non-default write wins. The disagreement is always a report row, so a lead
     machine that lost a setting does not pass its loss on.
   - `machine` values: every member publishes a secret-free **`machine-config-snapshot`** record (its
     machine-scope values and their digest). A successor inherits the replaced machine's last snapshot
     (its Local Verify lane shards, its peers list, its tunnel name, its nickname); a new machine takes
     the host profile's defaults. A value over 16 KB is replaced by its digest and reported.
6. **Start state, offline.** Before the server first starts, the sponsor writes the minimum it needs to
   start held and connect: the identity, the bootstrap secrets, the config, the membership set. It
   does **not** seed critical state yet.
7. **Install and start the service, held.** Only now is the agent's LaunchAgent installed and started
   (old plists were disabled in step 1, so the fleet watchdog had nothing to reload before now). The
   held server: never claims the lease;
   does not poll any channel; keeps its scheduler paused; creates no agent-scoped singleton (hub topics,
   private groups, owner-record genesis; `no-data-loss` §2's guard, unconditional while held); keeps
   its tunnel and its mesh connections up (it needs them to be checked and to replicate); and routes any
   notice it would send to the lease holder's attention queue. Members in a live rebuild run count as
   expected-absent for the pool's two-ready-machines rule and its "no takeover possible" notice (R1, R7;
   cross-spec change C3), which instead say "the Studio is being rebuilt", unpushed. If the server must
   be stopped on purpose, its plist is renamed `*.DISABLED`, which the fleet watchdog skips. In a
   **drill**, the target stays held until the drill conductor records a full pass of every acceptance
   row (`no-data-loss` §9), not only rows 1–7, so a failed restore check leaves the drill machine held;
   the drill's preflight already requires another healthy takeover-eligible member.
8. **Critical state.** With the held server running, record-backed categories arrive by normal
   replication (including the dead machine's streams, `no-data-loss` §3). Until `no-data-loss`
   increment 4 ships the `agent-setting` kind, a **seed copy** fills the file-backed categories: exactly
   the paths the state coherence registry lists for categories marked `agentScoped`, taken from the
   member whose digest the reachable members agree on, each written to a temporary name and renamed
   atomically, never overwriting a file whose provenance is not this run (tracked per path in the run
   record). The owner record is resupplied by peers (piece 2b), never seeded. The seed copy retires when
   `agent-setting` lands; a test asserts it is unused once the kind is live.
9. **Local patches and host additions.** The target receives every register entry (§6) that applies:
   its predecessor's patches (records signed by the replaced machine's retained key) and host additions,
   each applied and verified as §6 describes. Inheritance is automatic only on the continuity and
   reinstall paths (the same physical machine, replaced for no cause). On new hardware, or when the
   predecessor was revoked for cause, each inherited entry first goes to an agent review turn that reads
   its diff and reason and accepts, re-declares or drops it.

### 5. Reach and accounts

**Machine-to-machine access (N1).** For the target and every active member, in both directions:

- **SSH subsystem proof.** Mutual-SSH bootstrap between the target and each member, using the keys and
  host-key fingerprints carried in the admission record (not first-use trust). `verify` reads
  per-direction proof from `/machines/ssh-health` on **both** ends; proof older than the subsystem's
  freshness window is absent. The top-level `ready` field is not read. Two fixes ship with this: the
  fallback status stub in `AgentServer.ts` returns `ready: false` (reason `runtime-not-live`) whenever
  readiness is required, and `multiMachine.mutualSsh.requiredForEmployeeRole` is turned on for a pool
  only by a migration that first confirms every active pair has fresh proof both ways, so the flip
  never makes a healthy pool read not-ready. Today nothing outside the
  route reads `readinessRequired`; this spec makes row 11 its consumer and names it in the tests.
- **Verified remote spawn.** The forced-command peer-execution grant is installed on the target for each
  member and on each member for the target; the old machine's grants are revoked on every member
  (`revokeUnknown` against the applied replacement). `verify` runs `status` through the wrapper in both
  directions **and** exercises the production remote-session path in each direction: the sponsor asks the
  target to start a throwaway session on the sponsor, and the target asks a member to start one on the
  target, through the same spawn route a real cross-machine session uses; each fresh session answers a
  probe naming the machine it runs on, and is then closed (also when the probe fails). The sessions go
  through the normal spawn route, so the spawn cap and quota brake count them, on the lightest model tier. A `status` that passes while session creation
  fails is exactly the N1 gap, so both must pass.
- **Session reach.** One signed cross-machine message from a sponsor session to a throwaway session on
  the target and back through `/messages/send`, so the unknown-machine failure (post-mortem E2) is
  checked, not assumed.

**Tunnels.** The tunnel config is written from the machine-config snapshot (tunnel id and hostname) and
credentials from the bootstrap secrets; `verify` is HTTP 200 from `/health` **through the public
hostname**, and the response must carry the target's own machine id.

**Accounts.** For each account the account × machine matrix and the browser-coverage rows
(`no-data-loss` §7) mark as needed on a takeover-eligible machine, the run drives the existing
`subscription-signin` procedure on the target (normal browser, Google-account profile, no login copied),
unattended where it can. Before a Claude or Codex login home is used, the run writes that home's
project-trust entry for the agent folder, and checks it by a test session in that home reaching its
first prompt with no trust question. Each account ends `signed-in` (identity and organisation read on the
account's own page and compared, deterministically in `verify`, with the identity and organisation the
account × machine matrix expects, so a sign-in to the wrong account or organisation fails the step) or a
person row with its reason.

**One list for the person.** Every person row becomes **one** Needs-you item (dedupe key
`rebuild:<runId>:person`): one line per step, each phone-completable (a Secret Drop link, a card reply,
or a "do this on the Mac's screen" line quoting the words the person will see). Rows close on cause.
Typical macOS rows after this design: the person kit, the code reply (reinstall or new hardware), each
missing privacy grant (Local Network, Automation, Accessibility, Screen Recording; one tap each on the
Mac's screen), automatic login when FileVault is on, and each account that needs a passkey.

### 6. The local-patch register (N3)

**What it is.** A declared list of every deliberate local change to something Instar installs or
rewrites, in `.instar/local-patches/register.json`, replicated as a `local-patch` WS2 record kind.
Every entry is **signed by the declaring machine's key** and verified on every hop; bodies are
content-addressed and checked against their hash on fetch.

- **Patch** — a change to a managed path: a file in the shadow install, `.instar/bin/node`, the agent's
  LaunchAgent or systemd unit, a built-in hook, or the server's launch environment.
  ```
  { id, kind: "patch", reason, declaredBy, declaredAt, expiresAt, machines: [machineId],
    fixId, targets: [{ path, baseHash, patchedHash }],
    apply: { type: "diff", diff: <blob> } | { type: "script", script: <blob> },
    verify: <blob>  // a check that the patched behaviour is present, run against an install directory
  }
  ```
  A `diff` applies only exactly (no fuzz): the target file must equal `baseHash`, or the diff must apply
  without offset. A `script` follows the contract Luna's repatch scripts use: idempotent; exits 0 when
  already applied; never writes when its anchor is missing; prints a fixed marker when it wrote.
- **Host addition** — a local service, script or hook Instar does not ship: `{ id, kind:
  "host-addition", files: [path, hash], service?, dependsOnTools: [..], selfTest }`.

**Scope.** `machines` defaults to the declaring machine. A successor inherits its predecessor's entries
(the same slot; signed by the predecessor's retained key; §4 step 9 says when that needs a review turn).
Widening an entry to another of the agent's own admitted machines is the agent's decision, like merging
code (Rule 82; the owner's standing rule that no machine-level operation needs his input): the widening
is a new signed entry; on each named machine the **receiving machine's own agent review turn** reads the
diff or script and its reason and signs its acceptance before it applies there, after the patch's `verify`
passes on a candidate; and it is listed. No owner step. Declaring is the agent's own decision too. Every entry that touches
executable code is listed on the dashboard's "Local fixes in place" page with its age, and an entry past
its expiry is one passive line on the owner's Needs-you list.

**Declaring.** `instar patch declare --path <file> --reason <text> --fix-id <id> [--expires <days>]`
and `POST /local-patches` record the current hashes and the diff against the installed release's own
copy. A declaration is refused unless its `verify` **discriminates**: it must fail on the unpatched copy
and pass on the patched one, checked at declare time. For targets whose effect shows only in a running
process, the discriminating check is static and per target type: for `.instar/bin/node`, where the link
points and that binary's version and `otool -L` result; for the launch environment and a unit file, the
rendered environment or plist the funnel would write, compared key by key; the running server's startup
log line remains the proof that the patch is in effect after a restart. This is checked so a `verify` that always passes cannot make
retirement meaningless and one that always fails cannot hold every update. An entry declared from a
saved undeclared diff is marked "declared after detection" and goes to an agent review turn that reads
the diff, its time and the session that made it before the entry applies anywhere. A patch whose absence
would make a machine unsafe to lead (the `boot-claim-safety` patch is one) is declared
`blocksRelease: true`, and readiness row 15 then blocks the hold's release for it. Diffs and blobs pass
the credential-exposure guard before they are stored or replicated (a launch
environment can hold a secret) and are written mode 0600. The agent-awareness entry tells every agent:
an emergency change to installed code is declared the moment it is made.

**Every writer goes through one funnel.** `ManagedPathWriter` is the only code that writes a managed
path. Its callers: the updater's promotion and `rollback()`, `ServerSupervisor.preflightSelfHeal`
(including its `npm install` and its Node re-point), `ensureStableNodeSymlink`, `installAutoStart`,
`migrateHooks`, `commands/install.ts` and `NativeModuleHealer`. A lint fails CI on a write to a managed
path outside the funnel, and covers the shell templates under `src/templates/scripts/`: the fleet
watchdog's Heal 1 calls a small funnel helper, and refuses to reinstall a home whose register has live
patches, raising an item instead. Before every write the funnel compares the object on disk (a symlink's
destination included) with the last state it wrote or the install manifest, so a change made between
checks is caught at the moment it would be lost.

**Each write, by case.**

- **Undeclared change found.** Its diff is saved under `.instar/local-patches/undeclared/<path-hash>/<content-hash>/`
  (keyed by path and content, so a repeat is a no-op; scanned by the credential guard; 0600), the write
  proceeds, and one item goes to the agent's attention queue: "an unregistered change to <file> was saved
  and overwritten; declare it to keep it". Nothing is lost, and updates are never blocked by drift.
  Native build outputs (`node_modules/**/build/**`, `*.node`) are excluded from the manifest, and the
  manifest is recorded after the candidate's native rebuild, so a routine `npm rebuild better-sqlite3`
  is not drift.
- **Declared patch, fix included in the release.** Each release publishes `instar.includesFixes`: the
  **cumulative** set of every fix id in that release's history, so an update that skips versions still
  sees a fix shipped in between. A PR declares a fix id with a `Local-Patch-Fix: <id>` commit trailer;
  the publish step (`scripts/resolve-publish-version.mjs` gains the step) collects the trailers into
  `package.json`. The known fix ids live in the repository (`src/data/local-patch-fix-ids.json`): a PR
  that fixes a patched problem adds or cites the id there, and the lint checks every trailer against that
  file (CI cannot read agents' registers). Trailers go in the PR body so they survive the squash merge. Before
  retiring, the funnel runs the patch's `verify` against the **unpatched** candidate. If it passes, the
  patch is retired (entry moved to `retired` with the version; one attention line). If it fails, the
  release only carries part of the fix: the patch is treated as not included. **A rollback re-evaluates
  retired patches**: before a rollback candidate is promoted, every retired patch whose retiring version is
  newer than the candidate is reactivated and applied to the candidate (with its `verify`), so rolling back
  across `boot-claim-safety`'s fix does not silently remove that protection. A reactivated patch that does
  not apply exactly to the older candidate does not hold an emergency rollback: a patch without
  `blocksRelease` is listed loudly on the agent's attention queue and the rollback proceeds. **A rollback is
  never held** for a `blocksRelease` patch either, because a rollback is usually the way out of a release
  that will not start: it proceeds, the machine is marked not takeover-eligible (reason
  `patch-protection-missing`) until the fix is back (this blocks taking the lead from another eligible
  member, never keeping or re-taking the lease when no other eligible member is live, so the last machine
  standing is never left without a lead; a test covers it), the owner's list gets one line at once, and the agent
  gets a repair turn to re-base the patch onto the rolled-back release.
- **Declared patch, fix not included.** The funnel applies the patch to the candidate **before it is
  promoted**, then runs the patch's `verify` and the candidate's start validation with the patch in
  place. If both pass, the patched candidate is promoted and the server never boots unpatched. For a
  supervisor write (`.instar/bin/node`, the LaunchAgent, the launch environment) the patch is applied as
  part of the same write. A launch-environment patch is proven only by the running server's own startup
  log line naming the patch (the 09:49 lesson: a launcher patch is proven only by the process it
  launched).
- **Declared patch no longer applies** (the diff does not apply exactly, the script reports a missing
  anchor, or the patched candidate fails `verify` or start validation): **the update is held**; the
  current install keeps running unchanged. One item goes to the agent's attention queue. The agent
  re-declares the patch against the new release, retires it, or discards it. Self-heal and owner
  escalation are in "Self-heal and escalation" below. The hold is never released by a timer; the owner
  can release it with one tap ("update anyway; drops the fix <reason>").

**Expiry.** Each patch declares `expiresAt` (default 14 days). Expiry never removes a fix; it raises one
attention item until the agent renews it with a reason or retires it. Retired entries and their bodies
are archived after 90 days.

**The install manifest.** Recorded by the updater after promotion (`shadow-install/.instar-install-manifest.json`):
hashes of the managed paths only (the package's `dist/`, `.instar/bin/node`, the unit file, the built-in
hooks, the launch environment), with size and modification time so later checks rehash only what
changed. The full list stays on the machine (served on request to a peer over the authenticated
transport); the `tool-inventory` record carries only per-group digests (one for `dist/`, one per small
managed file), the release version and the drifted paths (when they exceed the kind's size, the record
carries their count, the first paths that fit and a `truncated` flag; the full list stays on the
machine), so a peer or successor sees drift without an
11,000-entry record. Each new record kind declares its own maximum entry size within
`REPLICATED_RECORD_MAX_ENTRY_BYTES` (80 KB) and registers it with the journal applier (whose default is
8 KB): `tool-inventory` 32 KB, `machine-config-snapshot` 64 KB (so a 16 KB value fits), `local-patch`
16 KB (bodies are fetched by hash, not carried), the membership and run records 8 KB. **The update worker** is new in increment 1: today
promotion runs inside the server (`UpdateChecker.applySelectedUpdate`). Increment 1 moves the candidate
install, the patch application, the manifest and the funnel's bulk compare for promotion and rollback
(about 11,000 `dist/` files) into a child process (`instar update-worker`), with a tested budget at
30,000 files, so none of it runs on the server's event loop. Single-file supervisor writes stay
in-process; each is a stat plus, for `.instar/bin/node`, the link's destination path and the binary's
size and modification time, never a hash of the 100 MB binary on the main thread. A machine with no manifest yet (before its next update) reports `unknown` for
the drift check, never "clean".

**Observe mode is not a weaker register.** On the dark rung the register applies declared patches to
candidates and saves undeclared diffs exactly as above; the only thing it does not do is **hold** an
update, with one exception: a `blocksRelease` patch that does not apply holds the update on every rung,
from the first, because promoting without it would leave a machine unsafe to lead. So declaring Luna's patches never leaves them unprotected (Frontloaded Decision 7).

**Interaction with the sibling specs.** `takeover-ready-pool` R3 names this register for its interim
boot-claim patch (fix id `boot-claim-safety`). Increment 1 ships the register first so that patch can be
declared at once (cross-spec change C5 corrects R3's owner and wording).

### 7. The readiness report and release

The final stage writes a document (`POST /docs`) and a JSON record (`GET /machines/rebuild/<runId>/report`).
Each row is `pass | fail | person-needed | unknown`, with the evidence read, when it was read, and
whether the evidence is the target's own report or read from a peer. A row passes only on evidence read
in this run; `unknown` is never ready.

| # | Row | Proven by | Releases the hold? |
|---|---|---|---|
| 1 | Membership | `poolDigest` equal on every reachable member, read on each member | yes |
| 2 | References | on every reachable member: no reference to the replaced id, its own expected references present, `agent`-scope references equal across members (§3) | yes |
| 3 | Secrets | canary read by a launchd-started process; secret-sync digest equal to a peer's | yes |
| 4 | Config | `agent`-scope digest equal across reachable members (or the disagreement row resolved) | yes |
| 5 | Critical state | every `takeoverRequired` and `agentScoped` category `present` with a matching digest (`GET /critical-state?scope=pool`, read from a peer) | yes |
| 6 | Takeover readiness | R2's `TakeoverReadiness.evaluate()` for the target, with `rebuild-in-progress` masked for this evaluation only | yes |
| 7 | Answers | the sponsor sends a probe to a throwaway session on the target through `/messages/send`; the session runs an owner-audience dry evaluation and answers with a tool call recorded in its transcript; the route is exempt from the hold and from the drill's zero-send count | yes |
| 8 | Runtime | Node is the standalone build (`otool -L`) at the exact version the pool's test-runner fingerprint names; every inventory tool present with its integrity hash | no |
| 8a | Privacy grants | each needed grant proven by its functional probe from a launchd-started process (§2); each missing one is a named person row | no (Local Network: yes when the target has any LAN-only peer, because without it the target cannot reach that peer) |
| 9 | Code | each owned repository present with every registry remote and its mirror's ref digest | no |
| 10 | Untracked files | restored from generation G, or "not recoverable", stated | no |
| 11 | Machine access | SSH proof and peer-execution `status` both ways for every active pair, read on both ends, **and** a fresh session started through the production remote-spawn path in each direction that answers naming the machine it runs on (run after the primary framework account is signed in) | no |
| 12 | Session reach | cross-machine message round trip | no |
| 13 | Tunnels | `/health` 200 through each public hostname, carrying the target's machine id | no |
| 14 | Accounts and browsers | each needed account `signed-in` by identity, or a person row | the agent's **primary framework account** (the one R2's check and row 7's session need): yes, and predicted in `--plan`; every other account: no |
| 15 | Local patches and host additions | each entry applied and verified | entries declared `blocksRelease`: yes; others: no |
| 16 | Guards | each host guard running under launchd with its self-test | no |
| 17 | Replaced machine | wiped (reinstall), fenced (seen its own revocation), or rotation offered | no |
| 18 | Login password | deleted from every holder of the run-scoped secret | no (checked at release) |

**Every known rebuild loss has a step and a row.** The report names each missing item by what it is,
never only a row number. The losses of 20 November, and where each is handled:

| Lost on 20 November | Restored by | Checked by row | Needs a person? |
|---|---|---|---|
| Local Verify settings and the green-PR merge floor | config scopes (`agent`) | 4 | no |
| `monitoring.localVerify.peers` (N8), lane shards | machine-config snapshot + `machineRef` rewrite | 2, 4 | no |
| Owner's Telegram id | config scopes (`agent`); owner record from peers | 4, 6 | no |
| Confirmed private-group record | critical state (`takeover-kit` / `agent-setting`) | 5, 6 | no |
| Paired phones | critical state (`paired-devices`) | 5 | no |
| Notification preferences (incl. `offlinePeers` naming the dead machine) | critical state; `machineRef` rewrite in state files | 2, 5 | no |
| Hub topic ids | critical state; singleton guard while held | 5, R13 | no |
| Git remote `JKHeadley`, unpushed branches | owned-repository registry and pool mirror | 9 | no |
| Untracked custom hooks | folder-backup generation | 10 | no (or "not recoverable", stated) |
| SSH trust with peers, verified remote spawn (N1) | reach stage | 11 | no |
| Signed-in browser profiles | sign-in procedure per account | 14 | per account (passkey, code on the phone) |
| Standalone Node at the pool's version (N7) | host stage selection rule | 8 | no |
| macOS privacy grants (N5) | host stage triggers the prompt | 8a | **yes**, one tap each on the Mac's screen |
| Local patches and host guards | register (§6), host additions | 15, 16 | no |

**Two verdicts.** **Takeover-ready** when rows 1–7 pass, together with the blocking parts of rows 8a
(Local Network where it applies), 14 (the primary framework account) and 15 (`blocksRelease` patches).
Then the guard grants its terminal receipt, the sponsor issues the signed `rebuild-release` carrying it,
the target's hold file is removed, the target becomes takeover-eligible, and one plain notice goes to the
owner through R7's notice path ("The Mac Studio is back in Echo's pool and can take over. Two things still
need you: …", the second sentence only when person rows remain). These are the rows whose failure would
let the machine lead mute, lead with the wrong state, lead unsafely or split the pool; R2 itself re-checks
real Telegram delivery after a claim. **Rebuild complete** when every row passes; until then each failing
non-blocking row is a Needs-you defect with its own self-heal (the subsystem's own repair, then an agent
repair turn), so a tunnel outage or one missing mirror never keeps a working spare out of the pool when
the pool may be down to one machine.

A `fail` or `unknown` in a blocking row keeps the hold and names the row. Time spent waiting on a person
step does not count toward the run's deadline. The hold is never released by a timer. **The owner is never
left unaware of a held machine:** when a blocking row's repair turns are exhausted, the owner's list gets
one plain status line, not an ask ("The Mac Studio is rebuilt but not yet allowed to take over: it cannot
read its secrets. I am still working on it."), and the same line appears for any blocking row still open
72 hours after the run started. A row becomes an owner **ask** only when its reason is in the closed
person-only set: `credential`, `approval`, `physical-act` (a tap or toggle on the machine), `passkey`,
`phone-code`, `captcha`. The repair turn picks a reason from that set or none; it cannot invent one.

## The monthly wipe-and-rebuild drill (the acceptance test)

The drill job, its canaries and its rehearsal-then-real progression are defined in `no-data-loss` §9.
This spec supplies the rebuild it runs (real wipes use the normal run; rehearsals use `--rehearsal`) and
declares that the drill's "drill role" for a rebuilt machine **is** this spec's rebuild hold, so there is
one leash, not two (cross-spec change C4). It adds these rows:

| # | Requirement | The drill passes when |
|---|---|---|
| R9 | One step | One run from one sponsor; every step after the person kit ran without a person except rows `--plan` predicted; each step's check, apply and verify recorded |
| R10 | Every member learned | `poolDigest` equal on every member, including one reachable only through a third (simulated on a throwaway pool when the real pool has none); `agent`-scope references equal across members; each member's machine-scope references equal its own pre-wipe values after id substitution |
| R11 | Machines can act on each other | SSH proof and peer-execution `status` both ways for every active pair, read on both ends, and a fresh remote-spawned session answering from the intended machine in each direction; a passing `status` with a failing session creation fails R11 |
| R12 | Local patches survive | A canary patch declared before the wipe is present and verified on the rebuilt machine; a canary undeclared edit on another member is saved under `undeclared/` and reported when a test update overwrites it |
| R13 | No half-built start | During the run the target never held the lease, never polled, created zero topics and sent zero notices except row 7's exempt probe (Telegram send log and lease history) |
| R15 | Privacy grants | Every grant the replaced machine held is proven on the rebuilt one by its functional probe from a launchd-started process, or is listed as a person row by name |
| R14 | Time | Unattended time recorded; the first passing real drill sets the baseline; a drill slower than twice the baseline is a defect (a regression signal, not a gate) |

A drill that wipes only the agent folder keeps the host key, so it runs on the continuity path and asks
the owner nothing unless an account needs a passkey.

## Dependencies on the sibling specs

| This spec needs | From | Fallback while absent |
|---|---|---|
| Membership-record family, its forwarding and `poolDigest` | `takeover-ready-pool` R5 | none: increment 4 waits for it; until R5's forwarding is live on an agent, that agent's ordinary joins stay pairwise as today (item 13 is open there until then) |
| `TakeoverReadiness.evaluate()` | `takeover-ready-pool` R2 | row 6 evaluates the four R2 checks directly (owner recorded, group confirmed, account signed in, conversation settings) from their own sources, labelled "R2 not live" |
| R7 notice path | `takeover-ready-pool` R7 | the release notice goes through the ordinary Attention Queue |
| Owned-repository registry | `no-data-loss` §1 | remotes from the replaced machine's last `machine-config-snapshot` and the home's own `.git/config` on any member |
| Critical list and `GET /critical-state` | `no-data-loss` §2 (increment 3) | none: row 5 is `unknown` and the hold stays; increment 9 waits for it |
| `agent-setting` kind | `no-data-loss` §2 (increment 4) | the seed copy (§4 step 8) |
| Departed machines' records | `no-data-loss` §3 | none needed for the rebuild; row 5 reports what is missing |
| Folder-backup generations | `no-data-loss` §4 | row 10 says "not recoverable" |
| Browser coverage | `no-data-loss` §7 | accounts from the account × machine matrix only |
| The drill job | `no-data-loss` §9 | the drill rows are run by hand from the rebuild report |

**Cross-spec changes this spec requires** (each is routed to the session that owns the sibling spec as
a concrete handoff, and the build of the dependent increment does not count as done until the sibling
text matches):

- **C1** (`takeover-ready-pool` R5): accept a valid, unrevoked owner-signed `machine-replacement-continuity`
  grant record in place of a per-replacement countersignature, under the scope in §3.
- **C1c** (`takeover-ready-pool` R5): `poolDigest` includes each member's hold state (held for run R, or
  released), and a replacement record carrying a `runId` is applied only together with its admission.
- **C2** (`takeover-ready-pool` R2): add `rebuild-in-progress` to the readiness reason codes, and treat a
  machine with an unreleased admission as not eligible.
- **C1b** (`takeover-ready-pool` R5): a revocation records its reason (`replaced`, `removed-by-person`,
  `identity-recovery`, `for-cause`), and every member publishes its OS host-key fingerprint (`host-key`
  record); only machines revoked as `replaced`, or unreachable and never revoked, are continuity-eligible.
- **C3** (`takeover-ready-pool` R1, R7): a member in a live rebuild run is expected-absent, reported as
  "being rebuilt", not pushed.
- **C4** (`no-data-loss` §2 and §9): the config split has one source (`config-scope.json`, referenced by
  the state coherence registry); `monitoring.localVerify.laneShards` is `machine` scope (it follows the
  hardware); the drill role for a rebuilt machine is this spec's hold; rehearsals use `--rehearsal`.
- **C5** (`takeover-ready-pool` R3): the register is owned by this spec, part 6, and its three outcomes
  (retire after verify, apply to candidate, hold) replace R3's wording.
- **C7** (`server-down-remote-recovery`, route A; that spec is not in review and has no other owner, so
  this project builds it as increment 5b): move the route's whole trust bundle (runtime
  slot, `.instar/recovery/` authority, runtime manifest, proofs, admission and lease store, certification
  root, grant inventory) to a host-level root `~/.instar/peer-exec/<agent>/`, with a migration rewriting
  existing `command=` lines and the fleet watchdog's `recovery_rule_state` paths, and add the `rebuild-step`
  verb with the target-side refusal above. The bundle is host-level state of that agent: agent removal,
`instar leave`, revocation of the machine (except a revocation with reason `replaced` while a rebuild run
for that host is open, which keeps the bundle until the new identity's admission applies, so the drill
does not delete its own access path; the drill therefore opens its run, and takes the target's lock,
before it revokes the old identity, and checks a continuity login after the revocation and before it
moves the home) and `--abandon` remove it and its `command=` lines through the
recovery installation's existing deactivation path, so no peer keeps a live grant on a host where the
agent is gone; C7's rollback moves the bundle back and restores the old lines. Until C7 lands, the
continuity path is unavailable.
- **C8** (`cross-machine-secret-sync-spec`): delivery to a machine whose admission carries a `runId` waits,
  until that run's release, for a fresh guard confirmation (direct or relayed with the member's own
  nonce), or is left to the sponsor's delivery; every other delivery is unchanged. Built by this project
  in increment 7.
- **C4b** (`no-data-loss` §5 and §9.3): `~/.instar/peer-exec/<agent>/` and `~/.instar/rebuild/` are
  host-level, not agent-folder, content: the real-wipe drill's quarantine leaves them in place, so the
  post-C7 drill reaches the continuity path.
- **C6** (`no-data-loss` §9.3): the real-wipe gate reads the capability entry `multiMachine.admissionRecords`
  that increment 4 registers.

## Decision points touched

| Decision point | Classification | Floor, arbiter and evidence |
|---|---|---|
| Reinstall or new hardware needs the owner's code reply before admission | invariant | basis: irreversible-consequence; evidence: an admitted machine receives every agent secret through secret sync, which has no revoke verb, and may take the lead; a delivered secret cannot be recalled |
| Continuity replacement proceeds on the standing grant | judgment-candidate | Floor: only when the target proves possession of the replaced machine's recorded OS host key, reports the same hardware id, and the replaced machine is unreachable past W and was never revoked by a person or for cause; never makes the target the Amendment-6 replacement host for Pending items; arbiter: the owner, who grants and can revoke the grant; evidence: the host key is a private key in `/etc/ssh` the pool recorded, not a value the target can choose |
| A hardware identity is a hint, never authority | invariant | basis: irreversible-consequence; evidence: `IOPlatformUUID` is shown by System Information and readable by any process, so it cannot gate a secret-delivering step; a host off macOS has no reliable one and is treated as new hardware |
| The login password may reach an impostor on the same network before the code is confirmed | judgment-candidate (accepted residual) | Floor: the target is found by the name the person confirmed against the Remote Login pane; no agent secret moves before the code reply; the password is deleted once the host stage verifies; arbiter: the owner, told of the residual on the Secret Drop page itself, who may choose "rebuild over cable" there (Frontloaded Decision 9) |
| A run on a live member of this agent is refused before any change; a co-hosted live agent puts the host stage in check-only mode | invariant | basis: irreversible-consequence; evidence: the host stage rewrites `.instar/bin/node` and host guards; on a live machine that breaks a working agent. Live means R5's rule (fresh signed liveness within W, or the holder), so a continuity drill's unreachable registry entry is not refused |
| The run lock is held on the target, epoch-fenced | invariant | basis: enumerable-domain; evidence: every sponsor must reach the target, so the target sees every contender; a stale sponsor's commands carry an old epoch and are refused |
| A resume may take the lock after the sponsor's heartbeat is ten minutes old, or at once on a signed "worker exited" record | judgment-candidate | Floor: the old sponsor's in-flight commands and pool records are refused by epoch, so a wrong takeover costs only a retried step; arbiter: the agent; ten minutes covers a sponsor whose machine is briefly asleep or rebooting (its worker restarts and renews), which is the case a shorter wait would wrongly take over from |
| The hold blocks lead, polling, jobs, singletons and notices until release | invariant | basis: irreversible-consequence; evidence: on 20 November Luna's half-built server took the lead, created four duplicate topics and posted job-failure notices; a posted message and a created topic cannot be unsent |
| The hold is pool-known and released only by a signed `rebuild-release` | invariant | basis: irreversible-consequence; evidence: a local flag is deleted by any config rewrite, and a machine that leads without its owner record or private-group record is mute (post-mortem A2) |
| Rows 1–7, plus Local Network (8a, where a peer is LAN-only), the primary framework account (14) and `blocksRelease` patches (15), block release; the rest do not | judgment-candidate | Floor: every row whose failure lets the machine lead mute, with wrong state, unsafely, or split the pool blocks; arbiter: the owner, who can clear the hold from the report with one tap; non-blocking rows are Needs-you defects with self-heal |
| Conflicting terminal records, before any delivery after release and before the machine has led: abandon wins on every member | invariant | basis: irreversible-consequence; evidence: delivering secrets to a machine whose run was abandoned cannot be undone, while revoking a machine that has received nothing and never led costs one re-run |
| Conflicting terminal records after a delivery or after the machine has led | judgment-candidate | Floor: no automatic revocation; the machine is not takeover-eligible but keeps serving if it is the only live member; arbiter: the owner (keep, or remove and rotate the named delivered secrets) |
| Patch widening rests on the receiving machine's agent review | judgment-candidate (accepted residual) | Floor: signed entry, discriminating `verify` on a candidate, listing on "Local fixes in place"; residual: a compromised or misled agent could accept a harmful widening, as it could merge harmful code; arbiter: the agent under Rule 82, with the owner able to see and revoke every listed entry |
| A rollback is never held by a patch | invariant | basis: irreversible-consequence; evidence: a rollback is usually the way out of a release that will not start, and holding it leaves the machine down; a missing `blocksRelease` fix instead makes the machine not takeover-eligible, which keeps it from leading unsafely |
| A held update for a declared patch that no longer applies | judgment-candidate | Floor: a declared fix is never overwritten silently; arbiter: the agent (re-declare, retire, discard), then the owner's one tap; a security release reaches the owner's list at once |
| An undeclared change is saved before any overwrite, then the write proceeds | invariant | basis: irreversible-consequence; evidence: the 10:23 update on 2026-11-20 overwrote an emergency fix with no copy; once saved, nothing is lost, and holding would add only an update outage |
| A fix id retires a patch only when the patch's own `verify` passes on the unpatched candidate | invariant | basis: irreversible-consequence; evidence: a release can carry only part of a fix, and retiring on a label would drop a working fix with no record of why |
| Widening a patch to another of the agent's own machines | judgment-candidate | Floor: a new signed entry; applied on each machine only after its discriminating `verify` passes there on a candidate; listed on "Local fixes in place"; revocable; arbiter: the agent, as for merging code (Rule 82); the owner sees the list |
| The `rebuild-step` verb on the peer-execution wrapper is accepted only on a host where the named agent is not live and has no identity of its own (or is held for the same run), for a signed run naming this host's OS host key | invariant | basis: irreversible-consequence; evidence: the verb runs command-table entries that write files and install software; on a live machine that rewrites a working agent, and the target is the only party that can see its own liveness without trusting the sender |
| The screen code is checked by commit-reveal: the guard commits with a 128-bit nonce before the card, the sponsor verifies after the reply; three codes per run | invariant | basis: irreversible-consequence; evidence: a six-character code is about 30 bits, so an exported plain hash is recovered in seconds and would let an agent tell the owner what to reply; and a check done only on the target lets an impostor host approve itself. Either failure admits a machine the owner never looked at, with every secret |
| A guard commit is required for every pool-side record of a run; an owner-signed release replaces it only when the guard is unreachable or wedged | invariant | basis: irreversible-consequence; evidence: an admission starts secret sync, and a delayed admission from a fenced sponsor accepted by a peer that missed the takeover would deliver every secret to a run no longer in control |
| Sponsor choice: the lease holder if it reaches the target, else the freshest takeover-eligible member that does | invariant | basis: enumerable-domain; evidence: the candidates are the live members and each one's reachability to the target is read, not guessed |
| The runtime Node must be the official standalone build, as a selection rule | invariant | basis: external-constraint; evidence: `RecoveryRuntimeSlot` refuses a non-standalone runtime (`recovery-node-standalone-runtime-required`) and Local Verify's recovery tests copy `process.execPath` (fb-9a79b2bd-249) |
| A config key without a scope fails CI; unlisted keys act as `machine` | invariant | basis: enumerable-domain; evidence: the key set is the config type, `ConfigDefaults` and the live config reads, all in source |
| Conflicting `agent` values across members | judgment-candidate | Floor: a write of the default value (a join or scaffold write) never wins; a value held by a majority of reachable members beats a lone newer one; otherwise the newest non-default write wins; a disagreement is always a report row, never silent; arbiter: the agent, which may pick another value with a reason |
| A blocking row with no person-only reason | invariant | basis: enumerable-domain; evidence: the person-only reasons are a closed set (`credential`, `approval`, `physical-act`, `passkey`, `phone-code`, `captcha`); anything else is the agent's to fix, and the owner gets a status line, not an ask |
| Patch expiry default 14 days | judgment-candidate | Floor: expiry never removes a fix, it only raises one item; arbiter: the agent, which renews with a reason; the post-mortem's patches were each meant to be superseded within days |
| Machine-config snapshot value cap 16 KB | judgment-candidate | Floor: an oversized value becomes its digest and is reported, never truncated; arbiter: a reviewed PR may give a key its own carrier |
| Membership checkpoint after 180 days | judgment-candidate | Floor: the checkpoint is signed by the lease holder and verifiable, and a member that needs an older record fetches it from any member's archive; arbiter: a reviewed PR; 180 days is past any plausible return of a revoked machine |
| `requiredForEmployeeRole` flips only after every active pair has fresh proof | invariant | basis: irreversible-consequence; evidence: flipping it while pairs read `mutual: false` (the Studio today) makes every machine not ready, an outage caused by the fix |
| A macOS privacy grant is a person step, proven only by a functional probe from the server's own launch context | invariant | basis: external-constraint; evidence: macOS lets only a person grant Automation, Accessibility, Screen Recording and Local Network, per program; a shell process can reach LAN peers while the server's `node` gets `EHOSTUNREACH` (N5) |
| The person list | invariant | basis: enumerable-domain; evidence: each step declares `needsPerson` in code; account rows are predicted from the matrix and marked "may need you", and graduation counts only rows that were not predicted |

## Fixed limits

- **Run lock takeover after ten minutes** without a sponsor heartbeat (one-minute renewals). The cost of
  a wrong takeover is bounded by the epoch fence; the counterexample is a sponsor stalled by a long
  Xcode download, whose worker still renews the heartbeat.
- **Step retries: three, backing off from 30 seconds**, then an agent repair turn. A five-minute network
  outage exhausts the retries; the repair turn resumes the run, so the run continues.
- **Patch expiry 14 days**, **snapshot value cap 16 KB**, **membership checkpoint after 180 days**:
  above.
- **Closed run records kept: the newest 12 per agent**; an open run is never pruned; retired patch
  entries archived after 90 days.
- **Owner approval validity: the life of the run**; the card uses the existing `cardTtlDays` setting.
- **No fixed limit on rebuild duration**: R14 records it against the baseline. Person waiting time does
  not count toward the run's internal deadline (which only bounds how long a step may run unattended).

## Frontloaded Decisions

1. **Push, not pull, for the first increments.** The sponsor drives the target over SSH after the person
   kit. A pull mode (a link opened on the fresh machine) needs a downloaded bootstrap binary; it is
   increment 11's work for machines without SSH (Windows).
2. **A rebuilt machine is always a new machine identity** (R5). Restoring old private keys would spread
   key material; the folder backup excludes it by design.
3. **The continuity standing grant is offered once**, the first time a continuity replacement happens
   (the first drill), with the offer wording the trust flow requires. Until granted, continuity
   replacements get the card like a reinstall.
4. **Tailscale.** The agent approves the new node through the owner's signed-in browser profile; a
   tailnet auth key is used if the owner ever provides one through Secret Drop. None is created on the
   owner's behalf.
5. **The seed copy is temporary**, removed by the increment that consumes `agent-setting`.
6. **The register replicates; patches apply per machine.** A patch applies to another machine only by a
   widening the receiving machine's own agent review turn accepts (§6), or to a successor by inheritance
   (§4 step 9).
7. **Echo's and Luna's existing hand-made patches and host additions** are declared by a
   `PostUpdateMigrator` step that runs in each agent's own home on its next update. It imports the scripts
   listed in that home's `repatch-all.mjs` `PATCHES` array (the convention Luna's script documents, not a
   name glob, so a stray file is not imported) as `script` patches of that machine, and every
   `ai.instar.<agent>.*` or `ai.instar.host.*` LaunchAgent Instar does not ship (excluding rehearsal
   labels) as a host addition. Imported entries are marked "imported, unreviewed": they keep applying, as
   the repatch scripts did, and each goes to one agent review turn that accepts, re-declares or drops it.
   `ai.instar.<agent>.repatch-local` is unloaded only after the register is applying patches for that
   agent (observe mode already applies, §6) and every imported script verified once on a candidate. Each
   agent's own register is the check. Echo's laptop HTTP/1.1 preload and the boot-hold patch are declared
   by the Echo session that owns them, with fix ids `http1-preload` and `boot-claim-safety`.
8. **Co-hosted agents are separate trust domains.** A co-hosted agent's rebuild asks for its own Secret
   Drop (for its SSH login only) and, after a reinstall, its own code reply. One agent never vouches for
   another's admission.
9. **"Rebuild over cable"** is offered on the Secret Drop page for an owner who prefers not to send the
   password over the network before the code step: the sponsor reaches the target over a Thunderbolt
   bridge or a USB-C network link, which no other host on the network can impersonate. The code step still
   follows the login, as on the network path; the cable removes the impersonation risk instead.
10. **Fix id trailer**: `Local-Patch-Fix: <id>`, an ASCII slug; `includesFixes` is an array of those
    slugs, cumulative and never shortened once published.

## Multi-machine posture

| Surface | Posture |
|---|---|
| `rebuild-run` record (cursor, pins, lock receipt) | unified: replicated record |
| Sponsor's full run record `state/rebuild/<runId>/run.json` | unified: summarised by the `rebuild-run` record and rebuilt by any resumer from live checks; included in the folder backup |
| Run lock, guard and lock receipts on the target | machine-local-justification: hardware-bound-resource — it arbitrates access to one physical machine and must live on that machine to see every contender; its receipts are unified through the records that carry them |
| Rebuild hold | unified: the admission and `rebuild-release` records are the authority on every member and on the target itself; the local file is a first-boot fast path |
| `machine-admission`, `machine-replacement`, `rebuild-release` records | unified: signed membership records on R5's forwarding |
| `host-key`, `machine-config-snapshot`, `tool-inventory` (with the install manifest's digests, drifted paths and grant names), `local-patch`, `rebuild-secret` records | unified: replicated records; `rebuild-secret` is encrypted to the sponsor and the resume-eligible members, never the target, and tombstoned when the host stage verifies |
| `hostedAgents` | unified: in each agent's own pool |
| Readiness report | unified: a document (documents sync) and a JSON record |
| Undeclared-change diffs | unified: included in the folder backup (`no-data-loss` §4), and announced to the agent at once |
| SSH host private keys and peer-execution grants | machine-local-justification: physical-credential-locality — an SSH private key and an `authorized_keys` grant live on one disk; fingerprints are unified through the `host-key` and admission records |
| macOS privacy grants | machine-local-justification: hardware-bound-resource — macOS records a grant for one installation and one program binary and lets only a person give it; which grants each member holds is unified through `tool-inventory` |
| Account sign-ins and browser profiles | machine-local-justification: physical-credential-locality — a login and a profile's cookies and passkeys are bound to one machine; coverage is unified through the matrix and `browser-coverage` records |
| Rehearsal scratch home | not agent state: a throwaway test home with stand-in credentials, discarded at the end of the rehearsal; its result is the drill report (unified, a document) |

## Verify the state, not its symbol

| Check | Symbol | State it claims | Corroboration | When unmeasurable |
|---|---|---|---|---|
| Machine identity | host key matches the pinned key, or the code reply matches | this is the replaced installation, or the machine the owner is standing at | possession of a private key, or a code only that screen showed | not admitted |
| Machine access | `/machines/ssh-health` pairs | each direction can run a command | `status` through the peer-execution wrapper from the source machine | `unknown`; row 11 open |
| Membership | `poolDigest` | every member has the same members | each member computes it from records it verified itself | an unreachable member is listed, not counted equal |
| Secrets | canary read | the server can read its secrets where it runs | the read is by a launchd-started process | `unknown`; hold stays |
| Tunnels | HTTP 200 | the public hostname reaches this server | the response carries the target's own machine id | `unknown`; row 13 open |
| Accounts | `signed-in` | the account works on this machine | identity read on the account's own page in that profile | `person-needed` or `unknown`, never pass |
| Patch applied | `patchedHash` | the fix is in effect | the patch's `verify`; for a launch-environment patch, the running server's startup log line | `unknown`; the update is held |
| Patch obsolete | fix id in `includesFixes` | the release contains the fix | the patch's `verify` passes on the unpatched candidate | not retired |
| Answers | probe answered | the machine can serve the owner | a tool call in the answering session's transcript | `unknown`; hold stays |

## Self-heal and escalation (Standard B)

- **The rebuild run** is a one-shot job. Its person item is raised for declared person steps only. A
  failing step: its own `apply` up to three times (backoff from 30 s, dedupe key
  `rebuild:<runId>:<step>`), then an agent repair turn (one session, wall-clock 30 minutes, at most two
  turns per step), then: an owner ask if the reason is in the closed person-only set; an owner status line
  if the row blocks release (and in any case for a blocking row open 72 hours); otherwise an agent work
  item retried daily. Breaker: the same step failing on three
  consecutive runs for the same agent escalates at once. Audit: `logs/rebuild.jsonl` (metadata only).
- **Undeclared change.** class: data-loss for the brief window before the diff is saved, so the save
  happens on the same tick as detection, before the overwrite (heal first, no wait); then one agent item.
  remediation-actions: save the diff, proceed. max-attempts: one save per (path, content). dedupe-key:
  `local-patch-undeclared:<path>:<hash>`. breaker: the same path drifting on five separate days opens one agent repair turn to find what keeps
  changing it; the owner hears only if that turn names a person-only reason (§7). max-notification-latency:
  the agent at once. audit-location: `logs/local-patches.jsonl` (paths and hashes only).
- **Held update for a declared patch.** class: recoverable (the current install keeps running; this is a
  deferred update, not a degraded service). self-heal: re-try the patch on each new candidate and after
  each re-declaration; an agent repair turn re-bases the patch (max-attempts 2 per release, wall-clock 30
  minutes each). exhausted when both repair turns fail or 24 hours pass with no re-declaration.
  max-notification-latency: the owner line at exhaustion; a release flagged as a security fix goes on the
  owner's list at once. This is an argued exception to the 300-second recoverable ceiling: that ceiling
  bounds a degradation the owner is living with, and a held update degrades nothing they can see; the
  arbiter is the decision-table row above. dedupe-key: `update-held:<version>`. breaker: three releases
  in a row held by the same patch escalate at once. audit-location: `logs/local-patches.jsonl`.

## Failure modes

| Failure | Result |
|---|---|
| Sponsor dies mid-run | The lock's heartbeat goes stale; a resume-eligible member resumes after ten minutes with a bumped epoch; each step re-checks live state; the run-scoped password record reaches it if the host stage had not yet verified |
| Target reboots mid-run | The hold file, the lock and the pool's admission all persist; a reboot before step 7 starts nothing, because old plists were disabled in step 1 and the new one is not yet installed |
| Owner declines the card | The run stops before any agent secret is sent; the target holds only tools; the password is deleted |
| A member is offline for days | Listed in row 1; R5's divergence self-heal closes it on return |
| The replaced machine comes back alive | A replacement of a machine with fresh liveness is refused (R5); the run stops at §3 |
| A stale address points at a live machine | Refused before any change (§1) |
| Two sponsors start at once | The second fails to create the lock on the target and reports the first run |
| A patch fails on a security release | Held; the owner's list says it is a security fix; one tap updates anyway |
| The lead machine lost a setting | `agent` values are compared across members; the disagreement is a report row |
| A step is missing from the critical list | The report cannot catch what the list does not name; the drill's canaries and the "lives only here" report (`no-data-loss` §5) are the backstop, and each drill miss adds a list entry |

## Maturation plan

- **ladder:** not applicable: each increment ships its own switch and adds its own entry to the feature ladders in the increment that introduces it
- **rollout:** dark (`--plan`, and the register in observe mode: it applies declared patches and saves
  diffs, and holds only for `blocksRelease` patches) → live on development agents → fleet, each step by a
  recorded review decision.
- **test-agent-live:** each increment's E2E builds a throwaway two-member pool on one host (two agent
  homes, two ports, a local `sshd` on a high port in a temporary home) and runs its rows; the lock, the
  hold and the code-reply paths each have a two-sponsor and a reboot test.
- **dev-agent-live:** the first real rebuild is a drill rehearsal on the Mac Mini, then a real wipe.
- **fleet:** after two consecutive passing monthly drills on Echo.
- **drill cadence:** the scheduled drill is monthly; a drill may also be run on demand, and graduation
  counts any two consecutive passing drills, so the project's done condition is not tied to the calendar.
- **graduation criterion:** a drill passes R9–R15 twice in a row with no person step that `--plan` did
  not predict.
- **dark-window:** at most 14 days per increment before going live on Echo or recording why not.

## Build increments (ordered)

1. **Local-patch register and the updater's three outcomes** (§6: the `instar update-worker` child
   process, signed register with discriminating `verify`, `instar patch declare`, install manifest,
   undeclared save-and-proceed, apply-to-candidate, the repo fix-id list and trailer lint, cumulative
   `includesFixes` with verify-before-retire, `blocksRelease`). Stops the next silent wipe;
   unblocks R3's patch.
2. **`ManagedPathWriter` and every writer behind it** (updater, rollback, supervisor preflight,
   `ensureStableNodeSymlink` with the standalone-Node selection rule, `installAutoStart`, `migrateHooks`,
   `install.ts`, `NativeModuleHealer`, the watchdog's Heal 1), with the lint over TypeScript and shell
   templates; the migration that declares existing patches and host additions (Frontloaded Decision 7).
3. **Config scopes** (`config-scope.json`, the lint over types, defaults and live reads, typing the
   `monitoring.localVerify` block, `machine-config-snapshot` records). Useful alone: it says today which
   settings a rebuild would lose.
4. **Admissions and full-pool learning** on R5's record family: `machine-admission`, the trust-request
   kind with the code reply, the continuity standing grant (after C1), `machineRef` rewriting, the
   capability entry `multiMachine.admissionRecords`; `instar join` issues admissions.
5. **Run skeleton**: the worker process, discovery, live-member refusal, the `host-key` records, the
   person kit and the on-screen code helper with commit-reveal, the guard with its per-run keys, the
   run-scoped keys for the sponsor and successors, the per-agent and host locks, guard commits, receipts
   and fresh confirmations, the run-scoped secret, the early hold and job unload, the run record and
   `rebuild-run` records, `--plan`, `--abandon`, `--rehearsal`.
5b. **C7, built by this project** (it has no other owner: `server-down-remote-recovery` is not in
   review): move route A's trust bundle to `~/.instar/peer-exec/<agent>/` with the `command=` and watchdog
   path migration, its removal on agent removal, leave, revocation and abandon, its rollback, and the
   `rebuild-step` verb with its target-side refusal. The takeover-ready rebuild does not need it; the
   drill's "asks the owner nothing" does, so drill graduation (two passing drills on the continuity path)
   is part of this project's done condition.
6. **Host stage**: tool inventory records, installs with integrity sources, the standalone Node, host
   guards, the agent's own means for automatic login and Tailscale.
7. **Agent stage**: the hold and `rebuild-release` (after C2, C3), code from the registry or its
   fallback, no-start identity, bootstrap secrets, the launch-context vault check, config from scopes,
   the held start, the seed copy, register entries.
8. **Reach**: mutual SSH and peer execution both ways from admission fingerprints, old-grant revocation,
   the status-stub fix and the guarded `requiredForEmployeeRole` migration, session reach, tunnels.
9. **Accounts and the readiness report**: sign-in per needed account, per-login project trust, the one
   person list, the report and its two verdicts, the release notice.
10. **Drill rows R9–R15** handed to the `no-data-loss` drill job (after C4, C6).
11. **Second host profile** (Windows/WSL) and the pull-mode entry for machines without SSH.

Each new WS2 kind (`rebuild-run`, `rebuild-release`, `machine-admission`, `machine-config-snapshot`,
`tool-inventory`, `local-patch`) is added to `JOURNAL_KINDS` with a rotation policy and its own gate in
the journal applier's kind map, dev-gated on (live on development agents, dark on the fleet) until the
fleet rung, in the increment that introduces it.

## Tests and evidence

Every increment carries the three test tiers and wiring-integrity tests for each injected dependency
(the funnel, the transport, the guard, the readiness evaluator). Semantic tests cover both sides of each
decision boundary: continuity versus reinstall versus a target reporting a stolen hardware id; a
patch whose fix is included and verifies, included but fails verify, not included, no longer applying;
an undeclared edit made between checks and caught by the funnel; two sponsors racing for the lock; a
reboot after every step of the agent stage with no lease claim, poll or topic; a hold with each of rows
1–7 failing in turn; the status stub returning `ready: false` when readiness is required; an impostor
guard that answers "match" to a wrong reply (refused by the sponsor-side reveal check); a delayed
admission reaching a member before it learns of a takeover (no secret delivered); a sponsor dying after
the password is deleted (the successor logs in with its run key); a rollback across a retired
`blocksRelease` patch (reactivated); and a remote session spawned and answered in each direction. The drill is
the acceptance evidence.

## Agent awareness

One entry, `src/data/awareness/rebuild-machine.md`: when the owner says a machine was erased, replaced
or rebuilt, the agent starts the rebuild from a surviving machine and sends the owner only the person kit
and the one list; when the agent changes installed code in an emergency, it declares the patch at once.
Two Registry First rows ("Is this rebuilt machine ready? / what is it missing?" →
`GET /machines/rebuild/<runId>/report`; "What local fixes are in place?" → `GET /local-patches`) sit
under a core heading, so they also need a `generateClaudeMd()` row and a `migrateClaudeMd()` step.

## Migration

- `localPatches` config block added by `migrateConfig()` in observe mode; the rebuild hold is a file,
  not a config key.
- The install manifest is written on the next update; until then the drift check reports `unknown`.
- `requiredForEmployeeRole` changes only through increment 8's guarded migration.
- The Frontloaded Decision 7 migration runs in each agent's own home.

## Rollback

Each increment ships behind its own switch. Turning the register off returns the updater to today's
behaviour after one attention line saying fixes are no longer protected. Admission, snapshot and
inventory records stay as inert records when their increments are turned off; `machineRef` rewrites
are not reverted (they point at a live machine). `--abandon` is the rollback for a run.

## Open questions

*(none)*

## Left behind

Precision items from the six review rounds, not iterated on (the build increments pick each up where it
applies; none changes what gets built):

- The run-key reaper should match on the `instar-rebuild-access` namespace plus the `runId` in the guard
  path, and `PeerAuthorizedKeys`' managed-line pattern must accept `expiry-time=`, with a cleanup test on
  an expiring line (increment 5).
- Members should refuse a rebuild admission that lacks a `runId` and guard commit (consistency; a
  malicious sponsor gains nothing it could not already fake).
- A run-key holder can spend the three screen codes with fake replies; this only pauses the run. Counting
  only replies that arrive through the card flow would close it.
- Row 18 should read "deleted, or tombstone pending on <members>" for members offline during the run.
- A short defined-terms block (W, R2/R5/R6, WS2, HLC, Needs-you, Rule 82, Amendment 6) and one paragraph on
  why the host stage is bespoke rather than Ansible, nix-darwin or MDM (no external control plane; the
  steps must integrate with the guard, signed records and secret flows). MDM/PPPC profiles could pre-grant
  Automation, Accessibility and Full Disk Access on managed Macs; this fleet is unmanaged personal Macs.
- Two co-hosted agents whose pools name different Node fingerprints: the first agent's choice stands and
  the second reports a check-only mismatch; a per-agent-home runtime is the later option.
- "No step relies on the memory of an earlier one" versus re-enabling disabled plists from the run record
  at release: release's check should read the live `*.DISABLED` plists.
- When the lease-holder-signed no-owner-key release is used, say how members distinguish it from a
  forged one beyond the trust-request record (they verify that flow's approval as for any other).
- A whole record over its kind's size limit (not just one value): carry digests and fetch on demand, as
  for the install manifest.
- An abandon that wins can remove a machine that had started serving only in the narrow
  before-delivery, never-led window; the pool fails over, and the owner line says so.

**Final-round fixes made at the round cap.** Round 6 (the cap for a Tier 3 spec) raised nine DESIGN
findings: three from the adversarial reviewer, one from the decision-completeness reviewer and five from
the external GPT-tier reviewer. All nine were fixed in the text rather than left open: co-hosted watchdog
suppression by plist as well as `hostedAgents`; `patch-protection-missing` never strands the last lead;
run-key expiry follows the deadline; the abandon-wins rule split by delivery and leadership; replacement
and admission applied together with hold state in `poolDigest`; the signed terminal record persisted
outside the disposable directory; config scope separated from the `machineRef` annotation; drill ordering
(run and lock before revocation); generation keys rewrapped by a surviving recipient. The adversarial and
decision-completeness reviewers verified their fixes; the five external findings' fixes were not
re-reviewed by the external model, and each increment's builder re-reads its section against them.
