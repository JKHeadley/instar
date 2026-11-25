# Studio worktree dependency provider review

## Iteration summary

- Round 1. Independent safety and adversarial review identified unpinned seed contents and writable aliases. Integration and scalability review identified nonrelocatable links and rename collisions. Decision completeness and lessons review identified the legacy symlink fallback and missing post-publication failure handling. Standards-Conformance Gate ran against 102 standards. The separate Codex CLI returned an error before producing findings.
- Round 2. The revision introduced digest custody, no-replace publish, private fallback and explicit readiness failure. Reviewers identified ambient configuration, preprovisioned helper validation, measured timing and remaining fallback cases. The separate Codex CLI again returned an error.
- Round 3. Independent reviewers concurred with pinned helper and sanitized installation inputs. The decision review requested a distinct read-only preflight and explicit integrity-failure handling. The final wording makes both explicit, binds rollout to physical-space and native readiness measurements, and spells out maturation. Standards-Conformance Gate ran against 102 standards. Its findings on parent standards, unsupported recipe variants and fleet graduation were addressed in the final wording. The separate Codex CLI returned an error on all three attempts.
- Final integration constraint. The ordinary pnpm workspace seed contains a link outside the copied graph. A root-only seed removed the workspace link but revealed an unresolved optional native package link. The implementation must continue to refuse that seed. Rollout depends on the pinned-toolchain candidate passing the unmodified confinement check.

## Experience fit

The operator asked for the normal checkout command to adopt shared dependencies. CLI integration comes before the existing SQLite and Husky checks and retains ordinary command entry and readiness. Fast shared provisioning remains opt-in until a real installed command and physical storage verification pass. Existing checkout migrations are a separate activity-gated operation.

## Fixed limits

No new numeric limit. The provider shares the existing checkout lock deadline. A real Studio checkout must show an improvement within that established time budget before the flag is enabled.

## Scope

Dark CLI implementation. Workspace paths and store entries must be verified independently on each physical host. This review supplies neither a live migration result nor a production enablement result.
