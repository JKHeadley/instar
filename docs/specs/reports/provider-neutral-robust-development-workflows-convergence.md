# Convergence Report: Provider-Neutral Robust Development Workflows

## ELI16 Summary

The spec started as a narrow Codex parity fix for `/instar-dev` and
`/spec-converge`. Review changed that framing. The better design is a two-layer
workflow system: a generic robust development workflow for any substantial
project work, plus an Instar-specific overlay for changing Instar itself.

Echo reviewed the draft against the live repo and confirmed that artifact
emission is already provider-neutral through `write-trace.mjs`; the gap is
discoverability and phase guidance. Justin then broadened the goal: strong
development practices should not be restricted to Instar if they are useful for
any project.

## Review Iterations

| Iteration | Reviewer | Material Finding | Resolution |
| --- | --- | --- | --- |
| 1 | Codey self-audit | Codex lacks `/instar-dev` and `/spec-converge` invocation guidance. | Drafted provider-neutral invocation spec. |
| 2 | Echo | Artifact emission already works cross-harness; focus on discoverability and guidance. | Rescoped away from rebuilding trace emission. |
| 3 | Justin | Worktrees and robust strategies should generalize beyond Instar. | Split generic robust workflow from Instar overlay. |
| 4 | Echo | Worktree hygiene and sandbox-survival are different motivations; drift audit should ship as a template. | Added conditional placement rules, gate-protected descriptors, and built-in drift audit. |

## Convergence Verdict

Converged for implementation. The approved slice is:

- Add provider-neutral workflow descriptors.
- Add the built-in off-by-default developer drift audit job template.
- Add a checked-in baseline manifest for the audit.
- Include descriptor edits in the Instar pre-commit gate's in-scope set.

This report represents a bootstrapping convergence path: the exact provider-neutral
workflow being specified is the mechanism that will make future Codex-led
convergence less manual.

