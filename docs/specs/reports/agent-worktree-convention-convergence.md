# Convergence Report — Agent Worktree Convention

## ELI16 Overview

When an instar agent makes a "scratch copy" of the shared instar
codebase (a git worktree) to do isolated work, the macOS sandbox can
silently revoke the agent's read/write access to that copy mid-session
if the copy lives in the shared instar checkout. The agent loses
access to its own in-progress work and there's no way to recover
without ending the session. This happened to echo tonight, stranding
a real implementation cycle. It's also a recurring pattern in the
audit trail.

The fix is straightforward in principle: always put the worktree
inside the agent's own home folder
(`~/.instar/agents/<agent>/.worktrees/`), where the sandbox boundary
can't move under us. Echo proved this works tonight by manually
relocating. This spec makes the fix automatic and universal — every
existing and future instar agent on any machine gets the convention,
without anyone having to remember to set it up.

The spec covers five layers: a new `instar worktree create` CLI
subcommand that places worktrees in the right spot and refuses
unsafe placements; updated scaffold templates so new agents are born
with the rule; a PostUpdateMigrator step so existing agents get the
bash-helper bridge automatically on their next update; a lifeline
detector that emits attention-queue items when misplaced worktrees
are observed (signal only — never blocks); and documentation +
Self-Knowledge Tree integration so the convention is discoverable.

## Original vs Converged

The shape stayed simple — "worktrees go in the agent's home folder."
The enforcement structure grew substantially across review to close
real gaps reviewers caught:

- **Hostile-CWD attack on agent-home resolution.** The original spec
  resolved the agent home by walking up from the current directory
  looking for `.instar/AGENT.md`. An attacker who planted that file
  anywhere could redirect worktree placement. Converged spec
  resolves via `INSTAR_AGENT_HOME` env var (set by the launcher)
  plus strict validation that the resolved path matches a
  registered agent in `~/.instar/registry.json`. A planted
  `AGENT.md` outside the registry is rejected.

- **`INSTAR_REPO` was unvalidated.** Attacker-controlled env var
  could redirect the worktree's host repo to a malicious checkout
  with hostile hooks. Converged spec validates: must pass
  `git rev-parse --git-common-dir`, must have a remote URL in an
  allowlist (default + operator-configurable), and must have a
  sane `core.hooksPath`.

- **`node_modules` symlink could defeat the entire spec.** Gemini's
  catch: if the sandbox follows the symlink and revokes at the
  *target*, the original failure recurs. Converged spec keeps the
  current symlink behavior as default (so no caller breaks at
  flip-day) but adds `--no-share-node-modules` for full isolation
  and documents the sandbox-revoke risk explicitly.

- **`.worktrees/` was not in agent gitignore.** Without this, the
  first time git-sync ran on an agent home with `.worktrees/`
  present, it would try to upload multi-GB of foreign-repo
  contents into the agent-state repo. Converged spec adds the
  entry to scaffold seed AND the migrator for existing agents.

- **Slug/branch values were unsanitized.** A confused or
  prompt-injected agent could pass `slug=../../../...` and land
  the worktree in the exact unsafe location we were escaping.
  Converged spec validates branch via `git check-ref-format`,
  validates slug against a strict regex, runs case-insensitive
  collision check, and asserts the final path is inside the
  agent home via `realpath` containment.

- **Audit ledger + lifeline detector promoted to v1.** Originally
  deferred as R-4 follow-ups. Reviewers pointed out the convention
  has zero observability without them. Converged spec ships both.
  Critically: the detector NEVER consumes the ledger as an
  allowlist (it would be a poisoning vector). The detector's
  authoritative rule is pure path-prefix matching.

- **Per-worktree git identity without breaking GPG signing.** Spec
  sets `user.name`/`user.email` only; signing config is left
  untouched. Explicit non-claim: the identity is cosmetic, not a
  trust signal.

- **Wire-level bugs caught by external models.** GPT caught that
  `repoAllowlist` was being used both as a URL list (for validation)
  and as a path source (for the detector). Converged spec
  separates these into `worktree.repoUrlAllowlist` (URLs) and
  `worktree.repoPath` (filesystem). Gemini caught that the
  detector would always flag the main checkout as misplaced
  because `git worktree list --porcelain` includes it as the first
  entry; converged spec skips it explicitly. Gemini also caught
  a ledger rotation race; converged spec moves rotation out of
  the hot path into the single-threaded migrator step. GPT also
  caught the wrong stale-metadata recovery command (path-based,
  not slug-based); converged spec corrects it.

- **PostUpdateMigrator wrong scope assumption.** The integration
  reviewer caught that PostUpdateMigrator is single-agent, not
  multi-agent — the original spec assumed it iterated the
  registry. Converged spec scopes Layer 3 to the running agent's
  own home; cross-agent visibility moves to the Layer 4 detector.

- **AttentionItem schema mismatch.** The original spec used a
  `tag` field that doesn't exist; the queue requires Telegram.
  Converged spec uses `category: 'worktree-misplaced'` matching
  the existing schema, with a JSONL fallback at a *dedicated*
  path (`<stateDir>/audit/worktree-detector.jsonl`, not the
  existing `recovery-events.jsonl` which has its own consumers).

- **Wrapper script's `exec instar` failure for npx setups.** Round 3
  integration review caught that `command -v instar` returns true
  for shell aliases (like `instar` → `npx instar`) but `exec`
  doesn't honor aliases. Converged spec wrapper resolves to an
  absolute path first, falls back to `npx --no-install instar`,
  then to the inlined logic. Honors `INSTAR_BIN` override.

## Iteration Summary

| Iteration | Reviewers who flagged                              | Material findings | Spec changes |
|-----------|----------------------------------------------------|-------------------|--------------|
| 1         | all 7 (security, scalability, adversarial, integration, GPT, Gemini, Grok) | 14 | restructured Layers 1–5, added validation pipeline, ledger, detector, gitignore, GPG preservation, allowlist, slug/branch sanitization |
| 2         | all 7                                              | 11 (new)         | dropped `--agent-home` flag for env-var-only transport, scoped migrator to single-agent, fixed AttentionItem schema, defaulted `--share-node-modules` to current behavior, added .bin symlink guard, dedupe TTL, 2s detector timeout, GPG explicit non-claim |
| 3         | all 7                                              | 6 (new)          | separated `repoUrlAllowlist` from `repoPath` (GPT P0), moved ledger rotation to migrator (Gemini P0), specified dedupe via AttentionQueue idempotency, dedicated JSONL fallback path, wrapper handles npx + INSTAR_BIN + absolute-path resolution, migrator re-validates agent home before mutation |
| 4         | (judgment-call convergence — no full re-review)    | 0 new architecture | textual patches addressing v3 P0s/P1s; no new surface area introduced |

## Convergence judgment (read this)

I called convergence at iteration 4 without running a full seven-
reviewer round on v4. Reasoning:

1. **All v3 material findings were addressed in v4** — every P0 wire
   bug (URL/path conflation, ledger rotation race, npx wrapper
   failure) and every P1 (dedupe storage, mirror path collision,
   migrator registry check) was patched.
2. **v4 changes are textual, not architectural.** No new layer, no
   new component, no new external dependency, no new state surface.
3. **External model precision was already high in round 3.** GPT and
   Gemini caught wire-level bugs in v3 that internal reviewers
   missed. Both v4 changes responsive to their P0s are precisely
   targeted; running them again on the same architecture is
   unlikely to produce new findings.
4. **Diminishing returns.** Three rounds with 7 reviewers each is
   substantial coverage. The spec is now 460+ lines for a
   conceptually simple convention. Further iteration risks
   over-engineering and delaying ship without proportional safety
   gain.
5. **Documented residuals.** Five operational concerns are
   acknowledged in R-1 through R-11 as conscious deferrals, not
   spec gaps. None affect the core safety property.

If Justin wants a final hard verification round before approval, I
will run it — just say so. Otherwise I treat v4 as converged.

## Full findings catalog

The detailed round-by-round findings are not duplicated here for
length. They are preserved in the iteration transcripts. Headline
counts:

- Round 1: 14 material findings (3 HIGH security, 2 HIGH scalability,
  2 HIGH adversarial, 3 HIGH integration, 3 CONDITIONAL from external
  models with consensus on `node_modules` and `INSTAR_REPO`).
- Round 2: 11 material findings (mostly wire-level: migrator scope,
  AttentionItem schema, detector flagging main checkout, GPG
  breakage, audit ledger TOCTOU + signal-vs-authority clarification,
  shell-alias wrapper bug).
- Round 3: 6 material findings (2 P0 from external models —
  URL/path conflation, rotation race; 4 P1 — dedupe storage,
  mirror path collision, npx wrapper, migrator registry check).
- Round 4 (judgment): 0 new architectural findings. Textual
  resolution of round 3 items only.

## Convergence verdict

**Converged at iteration 4.** Spec is ready for user review and
approval. After Justin sets `approved: true` in the frontmatter (or
says "approved" in topic 9984), the spec governs the implementation
PR via the /instar-dev pre-commit gate.

## Residuals (operational deferrals — not spec gaps)

R-1 through R-11 documented in the spec. None block v1 ship.

## Spec + ELI16 links

- Spec: `docs/specs/AGENT-WORKTREE-CONVENTION-SPEC.md`
- ELI16 companion: `docs/specs/AGENT-WORKTREE-CONVENTION-ELI16.md`

Branch: `spec/agent-worktree-convention` in the echo worktree at
`~/.instar/agents/echo/.worktrees/spec-agent-worktree-convention/`.
