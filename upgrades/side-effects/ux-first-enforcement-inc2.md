# Side-effects review: UX-first enforcement increment 2

- Extends the deterministic PR lint with author/committer plus pusher scope, a verified refactor-only exemption, and a per-run exemption-rate artifact.
- Internal lint errors remain distinct and now make the merge-safety job fail, so native auto-merge cannot arm on an uncertain verdict.
- Fixes ELI16 companion resolution so an existing `.eli16.md` spec is never given a double suffix; historical duplicate companions are removed.
- No runtime user-facing behavior changes; proof is the real GitHub PR workflow and its uploaded artifact.
- The configured author scope is literal and reviewed alongside the kill switch; a pusher outside it is out of scope.
