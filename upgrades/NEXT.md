# Upgrade Guide — vNEXT

<!-- bump: minor -->
<!-- Valid values: patch, minor, major -->
<!-- patch = bug fixes, refactors, test additions, doc updates -->
<!-- minor = new features, new APIs, new capabilities (backwards-compatible) -->
<!-- major = breaking changes to existing APIs or behavior -->

## What Changed

### Project-scope Phase 1b PR 1 — the drift checker

The first signal-producing piece of the project-scope feature lands in
this release. `ProjectDriftChecker` is a hardened, prompt-injection-aware
class that takes a spec + the files it claims to depend on and asks the
agent's intelligence provider whether the spec's premises still match
what's on disk. It returns one of four verdicts:

- `no-drift` — every premise still holds.
- `minor-drift` — naming or structural shift but the spec is still
  implementable as written.
- `premise-violated` — load-bearing premise no longer holds; spec needs
  revision before build.
- `manual-review-required` — the checker can't trust its own answer
  (over-budget, missing files, timeout, schema fail, fabricated
  citations). Routes to user attention instead of soft-passing.

Hardening matches PROJECT-SCOPE-SPEC § Phase 1.4: path-jailed file
reads, content wrapped in `<UNTRUSTED_SPEC_BODY>` and
`<UNTRUSTED_FILE_CONTENT>` delimiters that the system prompt explicitly
distrusts, structured-JSON output validated against an enum schema,
and — critically — every LLM-claimed citation is re-verified against
the bytes on disk before display. If the model fabricates evidence,
the verdict is downgraded; the digest never shows model-claimed text.

The drift checker is a **signal source**, not authority. Nothing calls
it yet — the round-runner (next PR) is the first consumer, and the
round-runner combines the drift signal with deterministic artifact
checks (`gh pr view`, CI status, frontmatter re-validation) before
deciding to start a round.

### Server supervisor — no more git-credential restart loop

Fixed a defect where the supervisor would enter an infinite restart
loop if its startup git operations (auto-pull, git-sync) hit a
credential problem. The supervisor sets `GIT_ASKPASS=/usr/bin/false`
to prevent interactive prompts, but when that failed git was falling
through to a terminal prompt — which hangs the bash command behind
"Username for 'https://github.com':" forever. The fix passes
`GIT_TERMINAL_PROMPT=0` to the tmux session env (`-e` flag on
`new-session`), which is the only path that survives an existing
tmux server.

Discovered on the author's running agent during Phase 1a gate
verification — the server had been restart-looping for several hours
silently behind a degradation note.

## What to Tell Your User

- **Drift detection is here**: I can now check whether a spec I wrote
  for you a week ago still matches what we built. If the code drifted
  out from under the spec, I'll notice and tell you before I start
  building. If anything looks fishy in the check itself, I escalate
  it to you instead of pretending everything is fine.

- **Server stability is better**: I fixed a problem where, if my
  credential cache went stale, my server could get stuck restarting
  itself in a loop. You wouldn't have noticed unless you were
  watching the logs, but now it can't happen.

## Summary of New Capabilities

- `ProjectDriftChecker` class — signal-only drift detection for
  project-scope rounds. Hardened against prompt injection and
  evidence fabrication. Returns `DriftVerdict` (no-drift /
  minor-drift / premise-violated / manual-review-required). Not
  user-callable yet — consumed by the round-runner in the next PR.
- `DriftVerdict` / `VerifiedCitation` types exported from
  `src/core/types.ts`.
- `IntelligenceOptions.timeoutMs` — additive option that providers
  may ignore; the drift checker enforces externally regardless.
- Server supervisor now passes `GIT_TERMINAL_PROMPT=0` to the tmux
  session env on every server spawn, preventing the credential-prompt
  restart loop.
