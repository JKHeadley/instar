# Convergence Report — No critical data or work is lost when a machine dies

**Spec:** [docs/specs/no-data-loss-on-machine-death.md](../no-data-loss-on-machine-death.md)
**Plain-English overview:** [docs/specs/no-data-loss-on-machine-death.eli16.md](../no-data-loss-on-machine-death.eli16.md)
**Slug:** `no-data-loss-on-machine-death`
**Converged at:** 2026-11-20, round 6 of 6 (the Tier 2+ cap), followed by two confirmation passes
**Iterations:** 6
**Final-round design findings:** 0 from the six internal reviewers. The external reviewer's last-pass findings were resolved but not re-read; see the banner.

## Cross-model review: codex-cli:gpt-6.2-astra

The external review was real, through the agent's own Codex CLI login, and ran on **every** round:
rounds 1 to 6, plus two confirmation passes after round 6, for 8 external reads. Every read finished
(`status: ok`), and none was cut short (`promptTruncated: false`). Context sent with each read: the
replicated-store foundation spec and the post-mortem. Round 1 also included the Disk Steward spec,
which later rounds dropped to stay within the context budget. Gemini was not signed in
(`gemini-not-authed`), so GPT was the only outside model family. The Anthropic clean-door reviewer
was available but not run; it would not have counted as a cross-model read.

**Read this before approving.** The external reviewer never returned a clean pass. Each read raised
3 to 7 new design findings, and each set was narrower than the one before: from "survivors can't
re-serve records at all" in round 1, down to "one rename keeps the scan's settle test true" in the
last. Every one was resolved in the spec. The four from the **final** read (scan settling, independent
acknowledgment of protected seals, message custody at the serving machine, serial commitment-number
grants) were resolved without another external read. They are recorded in the spec's Left behind
section, each with a named test that checks it during the build. The six internal reviewers found
zero design issues in round 6's confirmation pass.

## Standards-Conformance Gate

The gate ran on every round as an advisory input to the reviewers:

| Round | Flags |
|---|---|
| 1 | 7 |
| 2 | 6 |
| 3 | 12 (the gate saw a truncated copy) |
| 4 | 8 |
| 5 | 7 |
| 6 | 8 |

The lessons-aware reviewer engaged every flag. Most flags from round 4 on repeated ones already
ruled on: the recovery table, fixed timing defaults, and the 5-minute cap. Those were answered with
the reasoning recorded in that reviewer's round files. The ones that changed the design:

- the credential check's authority;
- the custody of candidate repositories;
- disappearance read as loss;
- grace-window expiry read as repair failure;
- the git nested-repository query;
- the replicated report naming single-copy items;
- legacy repository promotion;
- transcript protection relying on a dark feature.

## ELI10 Overview

On 19 November the Mac Studio, the main computer for Echo and Luna, failed a macOS upgrade and was
erased. Some work was lost for good, most importantly the Instar app's source code, which existed in
one folder on that one computer with no online copy. Much more survived only by luck. Thousands of
unsaved-to-GitHub changes, custom safety hooks, chat history, settings and sign-ins either lived only
there or did not come back when the computer was rebuilt. The owner put it plainly: "I dont track
this, you do."

This spec makes the agent track it. It keeps a list of every code project it owns, and copies every
line of work to the owner's other computers within minutes, and to private GitHub copies. It marks the
settings that must be the same everywhere as critical and checks them every 15 minutes. It lets
surviving computers pass on a dead computer's records, with proof that they are genuine. It backs up
each agent's whole folder, encrypted, to another of the owner's computers and test-restores it. It
keeps a "lives only here" list for every computer, so after a loss the agent can say exactly what
went with it. It keeps work copies from filling the disk and makes disk warnings reach a person. It
checks that every computer that might take over is signed in where the agent needs to work. Once a
month a drill wipes one computer's copy of the agent and rebuilds it to prove all of this.

The trade-offs are stated honestly. A few minutes of the newest work can still be lost in a truly
sudden loss; the spec states how much for each kind of data. Instar cannot stop Apple's installer; it
can warn first and take a fresh copy the moment one starts. Real wipes in the drill wait for a
separate fix, so rebuilt computers are recognised by every other computer. Until then the drill
rehearses into a separate folder.

## Original vs Converged

- **Originally**, a machine served only the records it wrote, and the spec simply said "survivors
  re-serve with the old key". **After review**, the spec builds the missing proof. The old journal
  records carry no signature, so the author now writes periodic signed seals. The receiving side is
  re-keyed by the true author, so relayed records are not credited to the relayer. A retirement
  checkpoint, made only at revocation, stops a stolen key from adding to history or backdating it.
  Old pre-seal records come back only by per-record agreement among survivors, and never for
  anything that grants authority.
- **Originally**, unpushed work older than a day was a loud defect. **After review**, copying
  happens within minutes, and the day is only when the owner hears. Notices are one line per
  computer, not hundreds. A sleeping laptop never produces a loss notice; a departed machine
  produces one notice, worded as debt from what survivors verified.
- **Originally**, the agent would push work to "the owner's GitHub account". **After review**, this
  was checked live: Echo's login (`EchoOfDawn`) cannot create repositories in the owner's personal
  account, and the Instar repository is public. So private repositories go in the agent's own
  account with the owner invited. Unfinished work on public projects goes to a private
  `<name>-backup` companion. A credential check runs before anything leaves. Repositories that are
  not provably the agent's, or that belong to a team member, never reach GitHub.
- **Originally**, settings were compared against the lead machine. **After review**, they are settled
  by time order across all machines, because in the outage the freshly rebuilt Studio took the lead
  with empty settings. A default value can never overwrite a real one. Weakening a safety setting
  needs the owner's proof, bound to that exact change. Hub topics are created only through a
  committed reservation, so a rebuild can never make duplicates.
- **Originally**, backups were wrapped to the machines in the pool. **After review**, keys are
  re-wrapped to a rebuilt machine when it is admitted. Without that it could not open its own
  backups. "Protected" now means one thing: a receipt-verified generation whose whole chain the
  receiver holds. The recovery point is stated as "complete through" a time.
- **Originally**, the drill wiped a folder. **After review**, it never runs on a live, unfrozen
  machine. It freezes at a quiet point, rehearses in a sandbox that cannot read the real home, refuses
  its own machine as a source, and counts copies per physical machine. It will not wipe while another
  machine's only backup lives there. Real wipes wait for the sibling track's identity fixes, so the
  drill cannot recreate the split pool.
- **Added during the run at the run lead's request:**
  - message history, as a new replicated kind;
  - commitment numbers that are never reused;
  - required secrets checked by name on every machine;
  - context-layer history;
  - the second remote-less app repository (`apps/instar-android`);
  - autonomous state files;
  - the Apple ID sign-in.

## Experience fit

**Source.**
- The owner-approved post-mortem v8 (Justin, topic 145840, message 145918: "The postmortem is
  approved... make absolutely sure that these get saved to Git hub").
- "No, I dont track this you do" (topic 141385, message 145894).
- The team-support requirement.
- The operator's standing feedback that delivery and low token burn outrank gate strictness, and
  that reports should be plain.

**Ordinary journey.** The owner hears nothing while copying and repairs work. What can still reach
him is short:
- a sign-in link;
- one batched ask, covering repository invitations, passkey or two-factor sign-ins, and missing
  required secrets;
- pushed disk and pre-upgrade notices that include the single-copy count;
- one debt notice when a machine actually departs;
- a same-tick notice of possible forgery.

**Contrasting cases the reviewers checked:**
- a sleeping laptop versus a dead one;
- the owner's repository versus a team member's;
- a mirror that finished just before death versus one that did not;
- an owner reset to a default versus a blind default from a rebuilt machine;
- a rebuild that holds the lead with empty state.

**Evidence limits.** Not measured:
- the first-enable row count on Echo, designed to be one row per kind;
- how long the first backlog transfer takes;
- how many fleet repositories predate scope recording;
- real laptop sleep durations.

**Disposition.** Delivers the stated outcome. There are no needless repeat asks, and no coverage is
claimed beyond what the records support.

## Iteration Summary

| Round | Internal design findings (sec / scal / adv / integ / dec / lessons) | Internal precision | External (GPT) design | Spec changes |
|---|---|---|---|---|
| 1 | 64 (10 / 10 / 11 / 10 / 12 / 11) | 12 | 6 | Full rewrite. Built on the state registry; seals and key-history carriage; aggregated notices; work-in-progress capture; custody of candidates; quiet point; dry-run for irreversible actions; Defaults table |
| 2 | 31 (5 / 4 / 7 / 4 / 7 / 4) | 17 | 6 | Recovery points; HLC wording; default-is-never-a-value; singleton reservation; origin-keyed relaying; per-agent interim retirement; D3 home account changed to the agent's login; re-wrap on admission; debt wording |
| 3 | 18 (4 / 1 / 4 / 4 / 2 / 3) | 16 | 5 | Nested-repository descent; version-vector default guard; change-bound weakening proof; provisional checkpoint holds; anchoring rules; custody predicate; drill self-source refusal; rehearsal rule |
| 4 | 10 (1 / 2 / 1 / 3 / 2 / 1) | 15 | 5 | Custody defined on real data; Luna's rsync made safe; single home account; muting outbox; one "protected" definition; team-member scope; drill repositories |
| 5 | 5 (1 / 1 / 0 / 1 / 1 / 1) | 16 | 5 | Multi-signer acceptance; deep test gates irreversible steps; two-phase interim retirement; real-GitHub test lane; scope backfill rule |
| 6 | 1 (1 / 0 / 0 / 0 / 0 / 0) | 10 | 5 | Seal-holding evidence folded into the checkpoint; committed reservation; reflog recovery refs; complete-through recovery point; descriptor-safe removal; run-lead additions §2.2a |
| 6 confirmation (all six lenses) | 0 | 3 | 4, then 4 | Reflog refs by object id, mirror-only; message-log contract; commitment identity kept as the existing pair; scan reconciliation; independent acknowledgment; serving-side custody; serial number grants |

Per-round reviewer files (scratch, not committed) were kept under the session scratchpad
`ndl/r{1..6}-*.md`, `codex-r*.json` and `scg-r*.json`.

## Proportion

Tier 3 (cross-cutting, irreversible actions, security-sensitive). The spec is about 130 KB (740 reflowed lines) and
eleven build increments. It used 6 of 6 rounds plus two confirmation passes. ⚠ This is above the
usual effort, and that is proportionate to a spec covering 14 post-mortem issues and 8 fix items.
The externals' steady stream of narrower findings is the signal that the cap, not exhaustion of
findings, ended the review.

## Left behind

- Upgrade-margin multiplier basis (weak; it gates only a notice).
- Custodian-snapshot completeness rule (four rare conditions at once).
- Ask the custody question again when team access is turned on later. Envelopes already sent cannot
  be recalled, and §5 should say so.
- The temp and scratch exclusion for session evidence (repositories created through Instar's
  funnels register anywhere).
- The `anchored-by-single-machine` label on one-machine pools (the weakest label, accepted).
- The four resolutions from the final external read, which no further external read has checked:
  - scan settling compares passes;
  - protection needs an acknowledgment from an independent machine;
  - message custody is enforced at the serving machine;
  - commitment blocks are granted serially by the lease holder.

  Each has a named test. These go to the build as verification items in increments 4, 6 and 7.
- Routed to the run lead, not built here: items 13 and 17 (rebuilt-machine identity and machine-list
  learning) gate real-wipe drills. D15 opens a tracked weekly check once increment 11 merges.

## Full Findings Catalog

The full per-reviewer findings are too long to inline. By round:

- **Round 1:** security (trust roots in §3, setting authority, symlinks, rehearsal isolation, backup
  key); scalability (whole-folder rehash, seal write storm, unbounded scan, per-worktree homing,
  replication churn, identity growth, small-file blobs, transfer lane); adversarial (ownership
  bounds, lease-holder-as-truth, drill membership, pressure mode against exclusions, forks across
  incarnations); integration (census gaps in the registry, mixed-version seals, peer-copy
  ping-pong, interim job facts, migration and awareness, posture markers, key-material sort);
  decision (D8 branch, drill dependencies, singleton deadlock, fixed-limit inventory, completion
  condition); lessons (homing cadence versus notice, verified copy count, census, per-record lag,
  Sovereignty, Serves a Team, Amendment 1/6, upgrade floor, supervision, in-flight reaper PRs);
  external (unacknowledged seals, snapshot authentication, signer-dated validity, uncommitted work in
  external roots, D8 key, drill canary ordering).
- **Rounds 2–6:** see the Iteration Summary row for each round. Every DESIGN finding's resolution is
  in the spec text it names.

## Convergence Verdict

Converged at round 6, the cap. The six internal reviewers' final round, and a six-lens confirmation
pass on the post-round-6 text, found nothing that changes what gets built. The external GPT-tier
reviewer kept finding narrower race conditions through the end. All were resolved, and the last four
are recorded as resolved without a further external read, with tests named. Open questions: none.
Frontloaded decisions: 16 (D1–D16). Cheap-to-change-after tags: 0. Contested and cleared invariants: 19.

The spec is the agent's own to approve: it amends no constitution text or protected path. The
foundation spec's §6.1 amendment (D11) lands in that spec's text with increment 6.
