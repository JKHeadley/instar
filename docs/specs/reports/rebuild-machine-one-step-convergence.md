# Convergence Report — Rebuild any machine in one step

**Spec:** [docs/specs/rebuild-machine-one-step.md](../rebuild-machine-one-step.md)
**Slug:** `rebuild-machine-one-step`
**Converged at:** 2026-11-20 (round 6, the Tier 3 cap)
**Iterations:** 6
**Final-round design findings:** 9, all fixed in the text at the cap (see "Convergence verdict")

## Cross-model review: codex-cli:gpt-6.2-astra

A real GPT-tier external pass ran through the agent's codex CLI in **every** round (6 of 6, status `ok`,
context: the spec plus both sibling specs, no context-incomplete refusal). Gemini was not available
(`gemini-not-authed`). The Anthropic clean-door second read (`claude-code:claude-fable-5`) also ran every
round; it is disclosed separately as `clean-door-anthropic-review` and does not count as cross-model.

## ELI10 Overview

When one of an agent's computers is wiped, bringing it back today is two hours of careful hand work, and
things still go missing: on 20 November the rebuilt Mac Studio lost its merge settings, the owner's
Telegram id, the private-group record, the paired phones, a git remote, its signed-in browsers, its
privacy permissions, the right Node version and its ability to log in to the other machines, and two other
machines never even learned it was back. This spec turns the rebuild into one run, started by the agent
from any surviving machine. The owner only logs in at the new Mac, turns on Remote Login, gives the login
password through a phone link and replies with a code shown on the Mac's screen. Everything else happens
in a fixed, checked order, and the new machine is kept on a leash (no taking the lead, no Telegram, no
jobs, no topics, no notices) until a readiness report proves it can serve the owner.

Two related fixes come with it. When a machine joins or is replaced, every machine in the pool now learns
it through signed records passed member to member, and every setting that names the old machine is
re-pointed. And emergency fixes made by hand to installed code are recorded in a register, so an update
either keeps the fix, retires it only after checking the new release really contains it, or waits and says
so; an unrecorded change is always saved before anything can overwrite it.

The trade-offs: the design is large (eleven build increments), it depends on two sibling specs still in
review and on eight cross-spec changes, and a few owner steps remain that are truly physical or personal
(Remote Login, the password, the code, macOS privacy taps, passkeys). The monthly drill becomes ask-free
only after increment 5b moves the machines' repair access out of the agent folder.

## Original vs Converged

- **Trusting the new machine.** Originally a same-hardware rebuild was trusted by the hardware id the Mac
  reports about itself, which anyone can read and fake. Now continuity is proven by the operating system's
  SSH host key (a private key on that disk), and a reinstall is proven by a code generated on the Mac and
  checked by commit-reveal, so neither an impostor Mac nor an agent session can make a wrong reply pass.
- **The leash.** Originally a local config flag held the half-built machine. Now the hold is known to the
  whole pool through the signed admission and release records, the machine derives it from its own
  membership record, old services are unloaded before anything lands, and a host-level suppression keeps
  co-hosted agents (Luna) down until their own run. A broken guard can be cleared by the owner's tap.
- **One run at a time.** Originally a replicated last-writer-wins record "locked" the run. Now the lock
  lives on the target, takeovers are compare-and-swap with an epoch fence, every pool-side record carries
  a guard commit, secret delivery waits for a fresh guard confirmation, and conflicting terminal records
  resolve by whether secrets were already delivered.
- **The password.** Originally stored forever and synced everywhere. Now it is run-scoped, encrypted only to
  the sponsor and the members that could resume, and deleted as soon as the host stage passes, because
  run-scoped guard-forced keys carry every later stage.
- **Local patches.** Originally an undeclared change held every update. Now it is saved and the update
  proceeds; only a declared patch that no longer applies holds, a `blocksRelease` patch holds on every rung,
  retirement needs the patch's own discriminating check, rollbacks are never held, and every writer of an
  installed path goes through one funnel.
- **Release.** Originally every readiness row had to pass. Now two verdicts: takeover-ready (the rows that
  decide whether the machine could lead mute, wrong or unsafe, plus the primary account, Local Network and
  `blocksRelease` patches) and rebuild-complete (everything else, healed and tracked), so a tunnel outage
  never keeps a working spare out of the pool.
- **Coordinator additions.** N5 (privacy grants, probed without prompting from the server's own launch
  context), N7 (Node at the pool's fingerprint version, a preference ranked under the native-module check),
  N8 (Local Verify peers and machine references in state files) and a loss-coverage table mapping each
  20-November loss to its restoring step and report row.

## Experience fit

**Goal and source.** Fix-table item 12 of the approved post-mortem ("`instar rebuild-machine`: one command
that does what took two hours by hand") and Drill 2 ("One command rebuilds it. Afterwards nothing on the
'critical' list is missing and no duplicate topic or notice appears"), approved by the owner in Telegram
topic 145840, message 145918. The standing rule that the owner never runs commands or does agent-owned
setup comes from the agent's operator-handoff instructions and its feedback memory.

**Ordinary journey (reinstall).** The owner turns on Remote Login, fills in one Secret Drop link (which also
confirms the machine's name and offers the cable option), sends one code reply, and taps once for each
macOS privacy prompt and each passkey account. No addresses, no commands; the password is asked twice only
in the predicted small-pool resume case.

**Contrasting cases.** A second agent on the same Mac asks for its own password link and code reply, as its
own trust decision. The monthly drill asks nothing after increment 5b; until then it takes the kit and a
code reply each month, which the spec states and drill row R9 counts.

**Evidence limits.** No ask counts have been measured yet; whether each privacy grant takes exactly one tap
and how often a member waits to deliver secrets are designed, with tests and report rows, not observed.

**Disposition.** Every remaining ask is physical, personal or a genuine per-agent trust decision. No new
constitutional obligation was introduced. The Amendment-6 replacement-host rule is honoured by separating
admission from becoming the replacement host for Pending items, which always needs the owner's activation
(the same single code reply on a reinstall).

## Iteration Summary

| Iteration | Reviewers who flagged design issues | Design findings | Precision findings | Spec sections changed |
|-----------|-------------------------------------|-----------------|---------------------|-----------------------|
| 1 | security, scalability, adversarial, integration, decision, lessons, codex, clean-door | 79 | 33 | full rewrite (v2) |
| 2 | all six internal, codex, clean-door | 48 | 23 | §1 rewritten; §2 rewritten; §3, §4, §6, §7, decisions, posture, self-heal, FD7–9; N5/N7/N8 added |
| 3 | security, scalability, adversarial, integration, decision, codex, clean-door | 24 | 9 | §1 identity/lock/receipts, host lock, C7, rehearsal, abandon, manifest, Node, patches |
| 4 | security, adversarial, integration, decision, lessons, codex, clean-door | 15 | 12 | commit-reveal, per-run keys, password, C4b, C7 as 5b, rollback, row 11 |
| 5 | security, adversarial, integration, decision, lessons, codex, clean-door | 19 | 10 | reveal order, run keys via PeerAuthorizedKeys, C8, watchdog suppression, abandon wins, relays |
| 6 | adversarial (3), decision (1), codex (5) | 9 | 9 | all nine fixed at the cap; adversarial and decision fixes verified by their reviewers |

Standards-Conformance Gate: round 1 ran (6 flags); round 2 ran (8 flags); round 3 ran (6 flags; it noted
the spec was cut at its own input limit); rounds 4 and 5 unavailable: the agent server was down
(connection refused on port 4042, not restarted by this run); final check after round 6 ran (4 flags:
password-before-code is the accepted residual on the Secret Drop page; supervisor-vs-account check fixed by
a deterministic identity-and-organisation comparison in `verify`; maturation wording fixed to the ladder's
cohort and review decision; the continuity drill's manual fallback made a tracked item closed by
increment 5b).

Per-round models: internal reviewers ran as Claude subagents on the authoring session's model (Opus 5.5)
every round; externals `codex-cli:gpt-6.2-astra` (cross-model) and `claude-code:claude-fable-5`
(clean-door) every round. Externals were never delta-skipped: the body changed every round.

## Proportion

Tier 3 spec, about 1,300 lines; 6 rounds used of a 6-round cap. Large for a spec, in line with a change
that touches trust, secrets, membership and the updater across three specs.

## Left behind

See the spec's `## Left behind` section: ten precision items (reaper matching and the `expiry-time=` line
format, refusing rebuild admissions without a run id, fake replies spending codes, row 18 wording, a
defined-terms block and the bespoke-versus-Ansible/MDM paragraph, co-hosted Node fingerprint conflicts,
release re-reading live `*.DISABLED` plists, the no-owner-key release verification wording, whole-record
size overflow, and the narrow abandon-wins window), plus the record of the nine final-round fixes.

## Full Findings Catalog

The per-round, per-reviewer findings with their resolutions are kept beside the run in the session
scratchpad (`r1-*.md` to `r6-*.md`, `r*-codex-cli.json`, `r*-claude-code.json`, `scg-r*.json`), and
summarised here by theme:

- **Target authentication** (security, adversarial, lessons, codex, SCG; rounds 1–5): hardware id as
  authority → OS host key for continuity, commit-reveal screen code for reinstall, reveal only for a
  recorded reply, guard key bound through the pinned SSH session.
- **Locking and fencing** (all reviewers; rounds 1–6): LWW lock → on-target lock with flock CAS, epoch,
  guard-clock heartbeat, guard commits on pool records, fresh confirmations for secret delivery, relayed
  confirmations, signed terminal record persisted, abandon/release conflict rule.
- **The hold** (adversarial, integration, codex; rounds 1–6): local flag → pool-known hold, self-derived
  hold, early job unload with `launchctl bootout`, co-hosted watchdog suppression, owner-signed release.
- **Secrets and the password** (security, adversarial, lessons, codex; rounds 1–5): forever-synced password
  → run-scoped, deleted after the host stage; run-scoped guard-forced keys via `PeerAuthorizedKeys`;
  generated rotation list on abandon; generation keys rewrapped by a surviving recipient; C8.
- **Local patches** (all; rounds 1–5): undeclared drift no longer holds; signed register; discriminating and
  static checks; verify-before-retire with a repo fix-id list; cumulative `includesFixes`; widening by the
  receiving agent's review; rollback reactivation and never held; update worker; funnel over every writer.
- **Integration with existing code** (integration; rounds 1–5): `installAutoStart` starting early, the
  60-second watchdog hold, the `ready: true` status stub, dev-gated features, record-size limits, Node ABI
  selection, the route-A trust bundle (C7), the fleet watchdog's Heal 1.
- **Decision completeness** (decision; rounds 1–6): ten frontloaded decisions; 64 contested-then-cleared
  items; zero cheap-to-change tags; no open user decisions.

## Convergence verdict

Converged at round 6, the Tier 3 round cap. The design stopped changing in kind after round 4; rounds 5
and 6 found edge cases in that round's new mechanisms. Round 6 raised nine design findings (three
adversarial, one decision-completeness, five from the external GPT-tier reviewer). None was left open:
all nine were fixed in the spec text at the cap, the adversarial and decision-completeness reviewers
verified their four fixes, and the five external findings' fixes (replacement and admission applied
together with hold state in `poolDigest`, the signed terminal record persisted, scope separated from the
`machineRef` annotation, drill ordering before revocation, generation-key rewrap) were not re-reviewed by
the external model. Each increment's builder re-reads its section against them. The spec is ready to
approve and build, starting with increment 1.
