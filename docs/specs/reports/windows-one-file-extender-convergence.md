# Convergence Report — One file on a Windows PC extends the agent to that PC

## Cross-model review: codex-cli:gpt-6-astra

A real GPT-tier review ran through the agent's codex CLI in every round from 1 to 6. A clean-door Anthropic second read also ran (clean-door-anthropic-review: claude-code:claude-fable-5-2). It is not counted as cross-model.

## ELI10 Overview

Justin wants the easiest possible way to let his agent use a Windows computer: open a link on the PC, run one file, scan a code with the phone, done. Today there is no way to do this unless the agent already lives on that PC.

The spec describes one small program, Instar Connect. It is the same file for everyone and holds no secrets. The person chooses either "Full control" or "Look only", then approves with Face ID in the Instar app. From then on the agent can work on that PC. The PC is a new, restricted kind of device: the agent can drive it, but the PC has no power over the agent.

Each PC belongs to one of the agent's machines. Every message between the two is encrypted and signed, and the PC checks the owner's phone approval itself. Only Face ID on the owner's phone can raise "Look only" to "Full control", and each approval works once. Scam protections, a tray Stop button, a full remover and an audit log are built in. Every program update needs Justin's Face ID on each release.

The tradeoffs:
- The Instar app is required to connect a PC. That is a constitution exception, so it needs Justin's yes.
- A PC is unreachable while its machine is off.
- "Full control" really means full control. The spec says so plainly instead of offering switches that would suggest limits they cannot keep.

## Original vs Converged

- **Device type.** Originally the PC reused the Mac pairing and would have been an owner device. Because the agent runs as the PC's user, that would have let the agent approve itself. Now it is a separate, restricted device that is never written into the owner device list.
- **Which machine holds the PC.** Drafts 1-3 let any of the agent's machines hold the PC, under a pinned set of machine keys. Three rounds kept finding new problems with that: handing the PC between machines, a machine still holding a PC it had lost, and removals reaching machines late. Draft 4 bound each PC to one home machine.
- **The mailbox detour.** Draft 4 also added a standing mailbox on instar.sh for remote moves and owner orders, to answer the constitution check. That made round 4's findings rise: the mailbox could be blocked, old orders could be replayed, and it cost money at scale. Under the cut rule, draft 5 took the smallest safe form: the drop is used only while someone is pairing (with a paste fallback), and moving a PC is done at the PC.
- **What the agent may do.** Six switches became two modes, Full control and Look only, with honest wording about each. Look only also refuses the usual places passwords and keys are saved.
- **Phone approvals.** The PC itself checks every approval from the phone, starting with the first grant. Each approval signs its whole content, carries a number used once and expires. Any change of mode makes older approvals unusable.
- **Who can use the PC.** Callers were narrowed to the owner's own conversations. The spec states plainly that this is a filter, not a wall, because all of the agent's sessions run as one computer user.
- **What review added along the way:**
  - encryption end to end
  - call ids that survive a restart, so a call is never run twice
  - file checks made on the file actually opened
  - bulk deletes waiting for the owner's tap
  - safe file replacement
  - antivirus handling
  - releases that need Justin's Face ID

## Iteration Summary

| Iteration | Reviewers who flagged | Design findings | Left behind | Spec changes |
|-----------|-----------------------|-----------------|-------------|--------------|
| 1 | security-adversarial, scalability, integration-decision, codex, clean-door | 50 total (not split by class) | — | draft 2 |
| 2 | scalability-and-plan, codex, clean-door | 36 total (not split by class) | — | draft 3 |
| 3 | all lenses, codex 4, clean-door 4 | about 20 of 25 | — | draft 4 plan |
| 4 | security-adversarial 5, integration-scalability 8, decision-lessons 6, codex 4, clean-door 5 | about 28 (rose) | 36 precision | cut rule: draft 5, smallest safe form |
| 5 | all-lenses internal 7, codex 4, clean-door 3 | 14 | 23 precision | draft 6 |
| 6 | all-lenses internal 4, codex 3, clean-door 4 (1 overlap) | 10 | 15 precision | final edit at the cap |

Standards-Conformance Gate (signal-only):
- Round 1: ran, 10 flags.
- Round 2: ran, 6 flags.
- Round 3: ran, 5 flags.
- Round 4: ran, 3 flags, then 2.
- Round 5: ran, 1 flag.
- Round 6: ran, 1 flag.
- Final, 2026-11-18T23:45:41Z: ran against all 100 standards, 1 flag. The flag is "The Person Decides": the app is required. It is kept on purpose as a named exception for Justin's yes.

Model disclosure:
- Internal reviewers ran as Claude Opus 5.5 subagents (rounds 4-6; rounds 1-3 per the WIP notes). Lenses were combined into 3 agents in round 4 and 1 agent in rounds 5-6. The same round-5 agent was asked again in round 6, so its check-off of its own findings is auditable.
- Externals ran every round on codex-cli gpt-6-astra and clean-door claude-fable-5-2. The spec body changed every round, so neither external pass was skipped.

## Proportion

Tier 2: security-sensitive, a new device class and a published binary, about 230 spec lines. It used 6 rounds, the cap. Design findings were 50 → 36 → about 20 → about 28 → 14 → 10. Round 4's rise triggered the cut rule. The final edit, which fixes round 6's 10 design findings, was not reviewed by another round, because round 6 was the cap. The constitution check was re-run on it.

## Left behind

Accepted at the cap. Every round-6 design finding was fixed in the final edit; none was accepted unfixed. What remains:

- **The round-6 fixes have not been re-reviewed.** They are:
  - frame encryption
  - durable call ids with an unknown outcome after a restart
  - file checks on the resolved path
  - bulk deletes held for the owner
  - safe file replacement with a resume window
  - the conversation credential refreshed on each owner message
  - tray raises turned off after Full control
  - antivirus handling
  - Justin's Face ID required on each release

  The builder's /instar-dev second pass is where they first meet a reviewer.
- **The app is required to connect a PC** (constitution exception). It goes to Justin as part of the approval.
- **Each release needs Justin's Face ID.** This adds one standing tap per release for him and is part of what his yes covers.
- **PowerShell commands and typing under Full control are not screened.** That is honest and stated: Full control means the agent can do anything the person can.
- **The caller filter is not an isolation boundary** between the agent's own sessions. This is stated in the consent text.
- **A PC is unreachable while its home machine is off.** Moving it means Connect again at the PC. The agent tells the owner once per outage.
- **The quick-tunnel limit is inherited from pairing** (install-experience §6, approved). Free addresses for every agent come with the hosted relay spec.
- **Look only refuses a list of credential folders** (a denylist). The reviewer suggested a list of allowed folders instead. The denylist is a floor, and the person can lift it.
- **Alternatives** (OpenSSH certificates, Tailscale SSH, embedding MeshCentral or RustDesk) are not weighed in the spec. Each needs an install, an admin step or a separate identity model, against the one-file, no-admin requirement.
- **Wording and long-tail items** (precision): the rest are in the round reports under docs/specs/reports/windows-one-file-extender-review-wip/converge-r4, converge-r5 and converge-r6.

Tracked items named in the spec, not built here:
- Android app support (Android lane).
- Team sharing of a PC (easy-setup project).
- Same-network and hosted-relay addresses.
- The full-wipe test on Justin's third machine (graduation step).
- The signing request to Justin (after approval).

## Full Findings Catalog

Per round, per reviewer, with resolutions:

- Rounds 1-3: docs/specs/reports/windows-one-file-extender-review-wip/converge-r1, converge-r2 and converge-r3, plus scg-round1 to scg-round3.
- Round 4:
  - converge-r4/security-adversarial.md
  - converge-r4/integration-scalability.md
  - converge-r4/decision-lessons.md
  - converge-r4/external-codex-cli.md
  - converge-r4/external-claude-code.md
  - scg-round4.md
- Round 5: converge-r5/internal-all-lenses.md, which includes the check-off of all 59 round-4 items, plus converge-r5/external-*.md.
- Round 6: converge-r6/internal-all-lenses.md (check-off of round 5: 15 resolved, 2 partly) and converge-r6/external-*.md. The round-6 design items and their fixes are listed under Left behind.

## Experience fit

- **Source:** Justin, topic 144319, 2026-11-18 13:57 PST: "a single file that can be run on a Windows machine that gives an agent access".
- **The ordinary journey:** open a link, run the file, pick a mode, scan with the app, Connect, Face ID. There is no admin prompt, no account, no settings and no typed code. The round-4 lessons reviewer found that it delivers the outcome, except while the home machine is offline. Draft 6 added a plain message to the owner for that case.
- **Contrasting cases:**
  - An owner without the app is offered app pairing first.
  - A PC that cannot reach the home machine is told why, in plain words.
  - A scammer-driven connection gets a warning and a wait, and lasting notices on the PC afterwards.
- **Evidence limit:** nothing has been measured with real people yet. The graduation criterion measures where people drop off during pairing in the live proofs.

## Convergence verdict

Converged at round 6, the cap, under the cut rule, in its smallest safe form. Round 6 found 10 design findings, down from 14 in round 5. All 10 were fixed in a final edit that was not re-reviewed. The only remaining constitution flag is the app-required exception, which goes to Justin. Open questions: none.

The spec is ready for Justin's review. His approval covers the design and two named items:
- the app required to connect a PC
- his Face ID on each release

The signing cost (about US$10 a month) is asked of him separately after approval.
