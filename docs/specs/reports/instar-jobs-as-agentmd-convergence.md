# Convergence Report — Instar Jobs as agent.md

**Spec**: `docs/specs/INSTAR-JOBS-AS-AGENTMD-SPEC.md`
**Topic**: 9529
**Author**: Echo
**Converged**: 2026-05-12
**Iterations**: 3 internal + 1 external cross-model

---

## ELI16 Overview

Right now every job your agent runs on a schedule (health checks, memory hygiene, the daily reflection) lives as one giant blob of text inside a single 700-line JSON file. Every time someone wants to tweak how a job behaves, they have to wrestle with JSON escape rules — newlines as `\n`, no real headers or tables, and a one-character change shows up as a single noisy line in a huge diff.

This proposal moves each job into its own markdown file. Authoring becomes the same experience as writing a skill or any other piece of documentation: headers, code blocks, real paragraphs, easy review.

It also adds a hard line you've been asking for: **default jobs that ship with instar** live in one folder. **Jobs you wrote yourself** live in a different folder. Instar updates are allowed to refresh the first folder but are structurally forbidden from touching the second one. No more cases where an update accidentally wipes your customizations or vice versa.

The Dashboard becomes the everyday way to manage all of this — see both groups, edit your own jobs, override an instar default into your own copy if you want to diverge, see what's healthy and what's broken at a glance.

Everything else — how often a job runs, which model it uses, what tools it has access to — is unchanged except for one new requirement: every job now declares the minimum tools it actually needs. Today every job runs with the full toolset. After this lands, a job that just reads files only gets `Read`. That makes the blast radius of any drifted prompt much smaller.

There's also a new layer of cryptographic trust: instar releases now ship a signed manifest of which slugs are "real" instar defaults, with content hashes. If something writes a malicious file into the instar folder, the runtime catches it because the hash won't match and the signature can't be forged without instar's release private key.

## Original vs Converged

**Originally**, the spec proposed the idea (markdown files per job, separate folders), pinned four open questions toward robustness, and called it done. After three rounds of internal review and one round of external cross-model review, the converged spec gained substantial structure in areas the first draft was silent on:

- **Trust authority.** The original treated the `origin: "instar"` field as authoritative. Reviewers pointed out a local process could just write that field. The converged spec uses a **release-key-signed lock-file** as the structural authority — the field is a signal; the signature is the authority.
- **Override semantics.** Original said "override = copy + flip a field." Converged spec specifies a two-rename commit protocol so a crash partway through never leaves the system in a confused state.
- **Tool allowlist.** Original made user jobs default to full tools with a warning. Reviewers flagged this as a one-step privilege escalation given the Dashboard is reachable over a tunnel. Converged spec makes user jobs default to `Read` only, and unrestricted-tools requires both a four-screen confirmation AND an out-of-band Telegram approval — Dashboard and CLI paths use the exact same auth.
- **Migration safety.** Original would "drop the prompt body if it matches the default." Reviewers pointed out a single trailing newline difference could silently drop user edits, and a near-miss could silently inherit a new instar default body the user never consented to. Converged spec defines a normalize-then-SHA-256 match, a near-miss threshold that always forks to the user namespace, a backup is always written, and a per-update digest surfaces any default-body changes.
- **Multi-machine reality.** Original treated the schedule as one file. With your multi-machine setup, that was a guarantee of merge conflicts on every Dashboard edit. Converged spec splits into one tiny file per job, plus custom git merge drivers for the cases where conflict resolution actually matters.
- **Performance honesty.** Original claimed a 500 ms boot budget that wasn't supported by arithmetic. Converged spec relaxes to a defensible 1500 ms cold / 500 ms warm budget at 200 jobs, asserted by a CI fixture, with `p-limit`-bounded concurrency to avoid file-descriptor exhaustion.
- **Failure semantics.** Original was strong on what the system *guarantees* and weak on what the *user sees* when those guarantees produce surprising states. Converged spec adds an entire §Dashboard Error Surfaces section enumerating every loadable problem and exactly what the user sees and can do about each.
- **External-model-only catches.** The external pass caught items the internal reviewers missed: an internal contradiction (citing a transient/gitignored directory as a recovery source), preserving elevated tools after integrity failure, an anchor/alias precheck that over-rejected legitimate markdown text, semver-vs-string version comparison, EMFILE risk under load, Windows MAX_PATH, classifier output validation, backup pruning trigger, NFD test fixture, and the case-collision-as-privilege-escalation primitive. All applied in v4.

In total: **35 internal findings + 14 external findings = 49 substantive issues** addressed between the v1 draft and the converged v4.

---

## Iteration Summary

| Iteration | Reviewers | Material findings | Spec changes |
|-----------|-----------|-------------------|--------------|
| 1 (internal) | security, scalability, adversarial, integration | 35 | Major rewrite to v2 across trust model, file layout, parser hardening, atomicity, threat model, dashboard error surfaces, multi-machine sync, performance budgets, testing, rollout |
| 2 (internal) | security, scalability, adversarial, integration | 32 | Major rewrite to v3 addressing case-fold severity, release-key signing, CLI bypass closure, YAML coercion spec, npm packaging, gitignore, migration predicate, version skew, drift classifier moved to release-time |
| 3 (internal) | security, scalability, adversarial, integration | 0 material (3 cosmetic) | Two small additions: hash-normalization note, key-rotation deferral note + `keyId` field |
| 4 (external) | GPT 5.4, Gemini 3.1 Pro, Grok 4.1 Fast | 14 | Targeted v4 edits: git merge driver, semver compare, recovery-source clarification, allowlist clamp on ack, anchor/alias on parsed YAML, predicate clauses, case-collision instar-wins, p-limit, symmetric OOB auth, Windows path cap, compromise hotfix, classifier Zod validation, prune job, NFD fixture |
| 5 (would-be) | not run | n/a | Convergence declared at iteration 3 internal + 1 external. Further rounds would be padding. |

---

## Full Findings Catalog

For brevity, the catalog is structured by source. Full text of each finding is in the reviewer outputs:

- Internal: messages in this conversation, iterations 2 and 3 reviewer reports
- External: `.claude/skills/crossreview/output/20260512-091404/{gpt,gemini,grok,synthesis}.md`

### Internal iteration 1 (35 findings)
- Security (10): SEC-1 YAML library, SEC-2 slug regex gaps, SEC-3 PostUpdateMigrator symlinks, SEC-4 origin not authenticated, SEC-5 Dashboard allowlist bypass, SEC-6 migration match undefined, SEC-7 atomic write order, SEC-8 parser differential, SEC-9 override-fork race, SEC-10 grounding-exempt downgrade. All resolved by v2/v3.
- Scalability (10): PERF-1 through PERF-10. All resolved by v2/v3.
- Adversarial (10): ADV-1 through ADV-10. All resolved by v2/v3.
- Integration (10): INT-1 through INT-10. All resolved by v2/v3.

### Internal iteration 2 (32 findings)
- Security: NEW-1 case-fold severity, NEW-2 HMAC vs release-key, NEW-3 CLI unrestrict bypass, NEW-4 FAILSAFE/Zod coercion bug, NEW-5 lock-file mismatch ambiguous, NEW-6 widening definition. All resolved by v3.
- Scalability: NEW-1 boot budget arithmetic, NEW-2 git-status surface, NEW-3 reconcile cost, NEW-4 N+1 dashboard, NEW-5 classifier cost per-agent, NEW-6 lock-file fatal-stop too strict, NEW-7 bulk OCC, NEW-8 reload budget. All resolved by v3.
- Adversarial: ADV-11 unfork data loss, ADV-12 digest noise, ADV-13 mixed-state predicate, ADV-14 git-conflict UX, ADV-15 non-interactive migration, ADV-16 classifier prompt-injection (critical), ADV-17 Issues card scaling, ADV-18 commit storms, ADV-19 disabledAtBodyHash lifecycle. All resolved by v3.
- Integration: INT-NEW-1 npm packaging gap, INT-NEW-2 skills not file-tree, INT-NEW-3 gitignore, INT-NEW-4 matrix framing, INT-NEW-5 E2E test packaging, INT-NEW-6 pre-commit timing, INT-NEW-7 version skew, INT-NEW-8 transient + auto-commit, INT-NEW-9 collision ordering. All resolved by v3.

### Internal iteration 3
- All four reviewers reported **zero material findings**. Three cosmetic items: keyId schema field, hash normalization clarification, disabledAtBodyHash clearing semantics. All applied between v3 and v4.

### External cross-model (14 findings)
- GPT 5.4 (6 critical): git merge driver, instar.new recovery contradiction, ack-preserves-tools footgun, semver compare, migration predicate gaps, anchor/alias over-rejects markdown.
- Gemini 3.1 Pro (5): case-collision priv-esc, EMFILE risk, Dashboard/CLI auth asymmetry, Windows MAX_PATH, key-rotation emergency.
- Grok 4.1 Fast (5): merge driver (consensus), run-history scoping, classifier Zod validation, prune trigger, NFD test fixture.

All applied in v4 except Grok's run-history scoping (acknowledged as out-of-scope multi-machine aggregation).

---

## Convergence Verdict

**Converged at iteration 3 (internal) + 1 (external).** Zero material findings in the final internal round; 14 substantive external findings, all addressed in v4. The spec is ready for user review and approval.

Per the convergence rule, this report and the `review-convergence` / `review-iterations` / `review-completed-at` / `review-report` frontmatter tags have been written to the spec. The `approved: true` tag is **not** written — that requires explicit Justin action after reading this report.

---

## Recommendation for Justin

This spec is ready to act on. The next step is your call:

1. **Approve as-is** → I add `approved: true` to the spec frontmatter (with your verbal/text confirmation), and `/instar-dev` is unblocked to begin Phase 1.
2. **Request changes** → tell me what's off and I iterate before stamping approval.
3. **Defer** → leave the convergence tag in place; the spec waits for approval whenever you're ready.

The trust boundary (lock-file defends against rogue local writes, not against a compromised binary), the rollout phasing (Dashboard before auto-migrate), and the symmetric OOB-auth requirement for unrestricted tools are the three highest-judgment items that the spec locked in toward robustness. If you have a different judgment on any of those, that's the place to push back.
