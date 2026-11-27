# Convergence Report — Local Verify: borrowed machines run unit-test slices in shadow (results never count)

**Spec:** [docs/specs/local-verify-borrowed-unit-slices.md](../local-verify-borrowed-unit-slices.md)
**Slug:** `local-verify-borrowed-unit-slices`
**Converged at:** 2026-11-18 (round cap, Tier 2: 6 rounds)
**Iterations:** 6
**Final-round design findings:** 6, from 4 sources. All were small, applied in one edit at the cap, and not re-reviewed. None concerns safety, security or data loss for the owner (see Convergence verdict).

## Cross-model review: codex-cli:gpt-6-astra

The GPT-tier pass ran through the codex CLI in all six rounds. Round 1's first attempt failed on a script path and was re-run on the round-1 text. A clean-door Anthropic second read (`clean-door-anthropic-review: claude-code:claude-opus-5-5`) also ran every round. It is not counted as cross-model, but it drove the two largest changes. Gemini was not available (`gemini-not-authed`).

## ELI10 Overview

Justin asked for spare machines, his laptop first and then an old Windows PC, to help test changes, even while he uses them, and to step back whenever he needs them. Measurements show this would not speed anything up today: the quick "unit" tests a borrowed machine can run are not what slows a test run down.

So this spec builds the path as practice only:

- **What runs.** A borrowed machine runs small slices of unit tests on code already merged to `main`. Its answers are compared with our own machines' answers, but they never decide anything. Seeded tests with known results check that it reports failures honestly.
- **Where it runs.** Tests run inside a small Linux virtual machine on his laptop (Lima), or a separate Linux system on Windows. That sandbox has a fixed CPU and memory size, cannot see his files, has no network for tests, and is wiped regularly. It stops and gives its memory back the moment he is busy or on battery.
- **His part.** One yes from his phone, written in his four-part plain form.
- **Also included.** The first, separate, part records how long each unit test takes, which every later speed-up needs.

## Original vs Converged

- **Results stopped counting.**
  - Originally: borrowed results would count toward merges, checked by sampling.
  - After round 1: shadow only, because counting meant running unreviewed code with merge authority on a personal machine. The measured gain was also near zero.
- **Only merged code runs.**
  - Originally: helpers ran pieces of PR verifies.
  - Now (round 6): helpers run only commits already on `main`, compared with `main` verifies. In a no-count phase, running unmerged code bought nothing and carried the largest risk.
- **The wall became a virtual machine.**
  - Rounds 2–3: a separate OS user, a sudo wrapper, a `pf` firewall and process limits.
  - Round 4 onward: a Linux sandbox virtual machine. It brought a hard memory ceiling, no file access, its own network and disposal by deletion, and needs no administrator step.
  - Round 5 added per-process walls: tests and the build have no network and a private file view, and only `npm ci` has filtered network. Without those, Windows' shared WSL kernel and network would have let tests reach the Echo agent on that PC, the Windows clipboard and the desktop.
- **Owner first.**
  - A governor watches his real use: the sandbox's own CPU is subtracted, and on Windows a Windows-side signal is used.
  - The sandbox stops itself on memory pressure, battery, pause or idle, and a hold-off prevents restart loops.
  - It checks that his disk has room for the sandbox to grow.
- **Honest measurement.**
  - Agreement is reported with and without the learned exclusion list, split by local outcome.
  - A seeded known-red canary measures false greens.
  - The result is a report to Justin after 20 counted runs (fallback: 3 weeks), with no automatic graduation.
- **Do no harm to the line.** The shadow client is detached from the `main` verifies it rides on. A test proves a failing client changes nothing about the record.

## Experience fit

- **Goal and source:** Justin, topic 130715, #143933, #143942, #143952 and #142464: use spare compute even while the machine is used, pull back for him, be robust, judge on evidence.
- **Ordinary journey:** one phone yes per machine, then nothing for him to do. He can pause it from his phone, and he gets a report.
- **Contrasting cases:** he gets busy (the slice stops, and the sandbox stops on memory pressure); the laptop sleeps (backoff); the sandbox walls fail (it refuses to start, and the dashboard shows why); a helper is broken (shown as incompatible, never hidden by the learned list).
- **Evidence limits:**
  - There is no speed gain in this spec, and the spec says so.
  - Several WSL and Lima behaviours come from reviewers' knowledge, not probes on these machines. The throwaway proofs check them first.
- **Fit:** an honest first step that delivers the measurements his "judge on evidence" asks for.

## Iteration Summary

| Iteration | Reviewers who flagged design issues | Design findings | Precision findings | Spec sections changed |
|-----------|-------------------------------------|-----------------|---------------------|-----------------------|
| 1 | all six internal + codex | ~45 (heavily duplicated) | ~35 | Rescoped to shadow-only; added unit duration recording; helper opt-in; acceptance checks |
| 2 | security, adversarial, integration, scalability, decision, lessons, codex, clean-door | ~18 | ~40 | Run-as mechanism, containment probes, caps, learned list on the helper, comparison rules |
| 3 | adversarial, security, decision, scalability, lessons, codex, clean-door | ~12 | ~30 | Scan narrowed (80% of files had been excluded); queue; caps mechanism; Windows signal |
| 4 | security, adversarial, integration, decision, scalability, lessons, codex | ~16 (3 distinct themes) | ~30 | Redesigned around a Linux sandbox VM (from the clean-door read) |
| 5 | security, adversarial, decision, codex, clean-door | 5 | ~25 | Per-process no-network test namespace; port forwards off; memory stops; host disk; prepare-then-poll |
| 6 | scalability (1), lessons (1), security (1, low), codex (3), clean-door (2) | 6 distinct | ~15 | Merged-only narrowing (applied before the round); Studio pairing; isolate the client from `main` verifies; answer binding; retrial mode; known-red canary; build order |

Standards-Conformance Gate: ran every round, with 8, 11, 6, 8, 7, 7 and 4 advisory flags. The later rounds' flags were Judgment Within Floors on starting values; reviewers refuted them as design-class each round and their reasons are in the Fixed limits table. One round-4 flag, the WSL disk cap, led to a fix.

Models: internal reviewers on claude-opus-5-5; cross-model codex-cli gpt-6-astra; clean-door claude-code claude-opus-5-5.

## Full Findings Catalog

Every reviewer's full findings for each round are in the agent home at `.instar/state/scaling/converge-borrowed/r{1..6}-{security,adversarial,integration,scalability,decision,lessons}.md` and `r{1..6}-{codex,claude}.json`, with the gate output in `r{1..6}-gate*.json`. The design themes and their resolutions:

- **Counting results with merge authority on a personal machine:** shadow only.
- **No measured gain:** stated; unit duration recording first; count preconditions.
- **Unit durations not recorded:** A.
- **Run-as mechanism, home readability, caps that did not apply, `pf` persistence:** superseded by the sandbox VM.
- **Shared WSL kernel and network (Echo distro, clipboard, desktop, vsock):** per-process network and mount namespaces, seccomp `AF_VSOCK`, `builder` rules by user id, probes with positive controls.
- **Port forwarding to the owner's localhost:** off, and checked from the host.
- **Memory not returned:** the sandbox stops; hold-off against loops.
- **Host disk filling:** host-disk margin check.
- **Scan excluding 80% of files:** narrowed to call sites and literals in the test file and its direct imports, and reclassified as an efficiency hint.
- **Learned list unable to readmit, hiding a broken helper:** re-trials, a signed retrial mode, reporting with and without the list, an incompatible line.
- **Comparison inflated by slice exit codes:** per-file comparison, slice errors counted once.
- **Preparation dropping slices:** prepare-then-poll.
- **Windows signal forgery and the restart conflict:** written into Echo's distro.
- **Unmerged code on the helper:** merged-only.
- **The shadow client disturbing `main` verifies:** detached, all failures caught, test of identical records.
- **Answer not bound to its request:** signed identifiers and exact file set.
- **False greens unmeasurable on green `main`:** seeded known-red canary.

## Proportion

Tier 2: 435 spec lines plus an ELI16 companion; 6 of 6 rounds used. ⚠ That is heavy for a change with no speed gain. The weight came from a real problem: running code on someone's personal machine without harming him. Two redesigns (shadow-only, then the VM) cut the surface each time.

## Left behind

- 4 MB result cap: the derivation is stated (producer `parseVitestJson` caps, consumer parse time). Accepted.
- Optional: a process namespace for slices, and refusing `main` commits older than N days. Not taken; merged code only, inside the sandbox.
- macOS `pf` and other per-user mechanisms are no longer used; nothing is left behind there.
- WSL behaviours (`--resize` without administrator rights, memory reclaim) are checked on the throwaway proof before the Windows rung.
- Count-mode design (PR checks, sampling, authority) is deliberately left to a later spec with stated preconditions.

## Convergence verdict

Converged at round 6, the Tier 2 cap. Round 6 raised 6 small design findings:

- the Studio pairing;
- isolating the shadow client from `main` verifies;
- binding the answer to its request;
- a retrial mode;
- a known-red canary;
- the build order with its reason.

None concerns the owner's safety, security or data. Each makes the shadow measurement correct or keeps it from disturbing the line, and each was applied in one edit at the cap without a seventh round. Adversarial, decision-completeness and integration reported 0 design findings in round 6.

The spec is ready for approval by the Chief of Staff (session echo-chief-of-staff). The build starts after PR 3451 merges. The first of its two PRs (unit durations) is small and live.

## Approval fold-in (2026-11-18, after the Chief of Staff's approval at 15:08 PST)

The Chief of Staff gave maintainer approval with three fold-ins from the constitution check. None blocks the build, since this is the shadow-only phase. Each is now in the spec.

1. **Judgment Within Floors.** Three limits are now stated as practice-phase defaults with their reasons, and the 20-run report re-measures each:
   - the 1 GB-per-worker cap;
   - the 5-file re-trial size;
   - the quarter-of-files incompatibility line.
2. **Signal vs Authority.** The literal scan is kept as a hard safety floor for the owner's personal machine, on top of the sandbox walls. That reverses round 6's reclassification as an efficiency hint. Every hit is recorded with its matched line (`scan-hit`) and listed in the report, so false blocks are visible.
3. **Never Silently Cut.** A result over 4 MB is refused whole, never truncated, counted as `result-oversize` and named in the report. Both sides of the derivation are stated: `parseVitestJson`'s 400-character failure cap on the producer side, and parse time on the consumer side.

`approved: true` is set, citing that message.
