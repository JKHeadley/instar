# CrossReview Synthesis: INSTAR-JOBS-AS-AGENTMD-SPEC.md

**Doc**: `/Users/justin/Documents/Projects/instar/.instar/worktrees/topic-9529-jobs-as-agentmd/docs/specs/INSTAR-JOBS-AS-AGENTMD-SPEC.md`
**Date**: 2026-05-12
**Review ID**: 20260512-091404
**Models**: GPT 5.4, Gemini 3.1 Pro, Grok 4.1 Fast

---

## Verdicts

| Model | Score | Status |
|-------|-------|--------|
| GPT 5.4 | 8/10 | CONDITIONAL |
| Gemini 3.1 Pro | 9.5/10 | APPROVE |
| Grok 4.1 Fast | 9/10 | APPROVE |

Two approve, one conditional. GPT was the harshest reviewer; its issues were substantive bugs not caught by internal review.

---

## Consensus (multiple models flagged independently)

### C-1 — Git merge driver gap (GPT + Grok)

The spec promises "higher `instarVersion` wins on merge" and "`.instar/jobs/instar/**` conflicts resolve to update's content" at the prose level only. Without an actual custom git merge driver, git produces conflict markers by default. Both models independently called this out as the strongest unresolved item.

**Resolution in v4:** Custom merge drivers shipped with the npm package, installed via `instar git-config install`, `.gitattributes` written into the agent's repo on first run. Drivers verify signature before accepting either side. CI tests against real git.

### C-2 — `instarVersion` ordering is not semver (GPT)

Single-reviewer but high-severity. Naive string compare misorders `0.9.0` vs `0.29.0`.

**Resolution in v4:** Semver via the `semver` npm package.

---

## Unique findings (single model, all substantive)

### GPT — Internal contradiction on recovery source

"Reset to shipped default" cited `instar.new/` as the recovery source, but `instar.new/` is transient and gitignored. Once an update completes, it's gone — the "reset" action would fail silently or recover from nothing.

**Resolution in v4:** Recovery source is the permanent `dist/scaffold/templates/jobs/instar/<slug>.md` inside the installed npm package, OR `instar update apply --force-refresh-defaults`. `instar.new/` explicitly disclaimed as a recovery source.

### GPT — Acknowledge-and-run-anyway preserved elevated allowlist

V3 preserved the manifest-declared allowlist on hash-mismatch acknowledge. GPT pointed out that running `git-sync` with `Bash` *after its integrity has failed* is exactly the wrong default — that's when you most want minimal tools.

**Resolution in v4:** On acknowledge, `toolAllowlist` clamps to `[Read]` plus attention-queue alert on each fire. Trust failure should never preserve elevated tools.

### GPT — Anchor/alias precheck over-rejects

V3's precheck refused any raw text containing `&` or `*`. This rejects literal markdown text like `description: "Bash & Read"` or `description: "matches *.md"`.

**Resolution in v4:** Anchor/alias rejection runs on the parsed YAML document via the loader's warning hook, never on raw text.

### GPT — Migration completion predicate gaps

V3 predicate didn't check for orphan manifests, unresolved case-collisions, or duplicate-effective scheduled jobs.

**Resolution in v4:** Predicate extended with three additional clauses; Dashboard "Confirm migration complete" surfaces which clause fails and what the operator needs to fix.

### Gemini — Case-collision as privilege escalation

V3's symmetric skip-both rule on case-folding collision let a user-namespace file disable an instar default just by case-folding to the same name. That's a privilege escalation primitive: a user (or attacker) drops `Health-Check.md` into the user namespace and the real `health-check.md` stops running.

**Resolution in v4:** On collision, `origin === "instar"` wins; the user-namespace entry is skipped. Same-origin collisions (only via direct FS manipulation) skip both.

### Gemini — EMFILE on cold boot

Unbounded `Promise.all` over `readFile` will hit OS file-descriptor limits at 500+ jobs. Default soft limit on macOS is 256.

**Resolution in v4:** `p-limit` at concurrency 32 in the boot path.

### Gemini — Dashboard vs CLI auth asymmetry

V3 made CLI `unrestrict` require OOB Telegram approval but only required four-screen click-through on the Dashboard. With a phished bearer token, the Dashboard is the weak link.

**Resolution in v4:** Both paths require BOTH ops-gate AND OOB Telegram approval. Four screens are informational scaffolding around the OOB step, not a substitute.

### Gemini — Windows MAX_PATH

`.unfork-backups/<slug-100>-<iso8601>.md` could exceed the legacy 260-char path limit on Windows.

**Resolution in v4:** Backup filenames cap slug at 80 chars + compact ISO 8601; advisory log on Windows for any slug >80 chars.

### Gemini — Key rotation emergency procedure

V3 deferred key rotation to a follow-up spec but had no answer for compromise *before* rotation ships.

**Resolution in v4:** Explicit hotfix path — new `keyId`, new bundled public key, prior `keyId` lock-files become signature-invalid, auto-updating agents migrate trust on first boot post-hotfix.

### Grok — Drift classifier output needs runtime Zod validation

Strict release-time prompt template ≠ guaranteed well-formed output. Model can return unexpected text.

**Resolution in v4:** Zod-validate `significantChanges` array on every lock-file load. Malformed entries drop silently with a degradation event; the corresponding alert still fires (per signal-only invariant).

### Grok — Backup pruning trigger unspecified

V3 stated 30-day / last-10 policy but had no trigger mechanism.

**Resolution in v4:** Built-in low-priority job `unfork-backup-prune` runs daily; opportunistic pruning on Dashboard page-load.

### Grok — NFC test fixture missing

V3 stated NFC normalization but had no explicit NFD-input rejection test for macOS HFS+/APFS quirks.

**Resolution in v4:** Test #6 expanded with explicit NFD-encoded-on-disk fixture asserting both regex rejection and NFC-form lookup miss.

### Grok — Run history scoping ambiguity

Dashboard shows a run-history side panel but `state/jobs/runs/` is per-machine/untracked. Multi-machine users see only the local machine's history.

**Resolution:** Acknowledged as a known limitation; the spec's existing run-record observability gives per-machine hashes, multi-machine aggregation is out-of-scope for this release.

---

## Divergence

No substantive disagreement between models. GPT was the most critical, Gemini and Grok more positive, but no model contradicted another. The differences were in *what they probed*, not in *what they concluded*.

---

## Model strengths observed

- **GPT 5.4** — Found internal contradictions (`instar.new/` recovery source), enforcement gaps (prose vs protocol-level), and concrete bugs (anchor/alias regex over-rejecting markdown). Most useful for spec-text-as-code review.
- **Gemini 3.1 Pro** — Found privilege-escalation primitives (case-collision skip-both), OS-level realities (EMFILE, Windows MAX_PATH), and architectural asymmetries (auth path differences). Most useful for cross-platform and security-architecture review.
- **Grok 4.1 Fast** — Found operational completeness gaps (pruning triggers, runtime validation of release-time artifacts, test-fixture absences). Most useful for "did you actually write the test/job/handler" gut check.

What none of the three engaged deeply with: the drift-classifier injection design (interesting given GPT and Grok both reviewed it without comment — that's signal that the architectural shift to release-time + signal-only is genuinely robust), and the Phase 4-before-5 reordering (Gemini and Grok skipped this entirely, GPT engaged tangentially).

---

## Actionable Recommendations (all applied in v4)

1. **Custom git merge drivers** for `instar.lock.json` and `.instar/jobs/instar/**` with `.gitattributes` integration. [GPT, Grok]
2. **Semver comparison** for `instarVersion`. [GPT]
3. **Recovery source clarified** — `dist/scaffold/templates/jobs/instar/<slug>.md`, not `instar.new/`. [GPT]
4. **Clamp allowlist to `[Read]`** on hash-mismatch ack. [GPT]
5. **Anchor/alias rejection** runs on parsed YAML, not raw text regex. [GPT]
6. **Migration completion predicate** extended with three additional clauses. [GPT]
7. **Case-collision: instar-origin wins**. [Gemini]
8. **`p-limit` at 32** in the boot path. [Gemini]
9. **Symmetric OOB authorization** for Dashboard and CLI unrestrict paths. [Gemini]
10. **Windows backup-path length cap.** [Gemini]
11. **Compromised-key hotfix procedure.** [Gemini]
12. **Zod validation of `significantChanges`.** [Grok]
13. **Daily prune job for unfork backups.** [Grok]
14. **NFD fixture in test #6.** [Grok]

---

## Convergence Verdict

**Converged.** All material findings from internal review (iterations 2 and 3) AND from cross-model external review (this round) are addressed in v4. The spec is ready for user review and approval.

The cross-review surface produced 14 net-new findings beyond what internal Claude-family reviewers caught. That is the value of the /crossreview as the final round, as the agent's MEMORY.md asserts.
