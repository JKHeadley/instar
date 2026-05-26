# Upgrade Guide — vNEXT

<!-- bump: minor -->
<!-- Valid values: patch, minor, major -->
<!-- patch = bug fixes, refactors, test additions, doc updates -->
<!-- minor = new features, new APIs, new capabilities (backwards-compatible) -->
<!-- major = breaking changes to existing APIs or behavior -->

## What Changed

Instar now ships provider-neutral development workflow descriptors for robust project work, Instar source work, and spec convergence. This gives non-Echo and non-Claude agents a discoverable contract for the same development discipline Echo has been using: worktree-aware isolation, spec-first planning, side-effects review, evidence, verification, and trace-backed delivery.

The Instar-specific overlay remains context-gated to recognized Instar source checkouts, while the generic robust-development descriptor can apply to substantial work in any project. Workflow descriptor edits are now covered by the Instar development pre-commit gate, so future drift in these surfaces requires the same reviewed trace path as skill and script edits.

The release also ships an off-by-default weekly developer-tools drift audit template. It compares checked-in provider-neutral development surfaces against practices that may have stayed local to one agent or provider, then surfaces actionable drift without autonomously rewriting workflows.

## What to Tell Your User

Instar is getting better at sharing its own development discipline across agents. When an agent is doing serious project work, it has clearer guidance for planning, isolating changes, checking side effects, and proving the result. When an agent is specifically evolving Instar, it still follows the stricter Instar development path.

There is also a quiet weekly audit template for Instar maintainers. It is off unless enabled, and its job is to notice when useful development practices have drifted into one agent's local habits instead of becoming available to all qualified Instar agents.

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| Robust project development workflow descriptor | Available in the checked-in skills surface for substantial project work. |
| Instar development overlay descriptor | Available in recognized Instar source checkouts for Instar evolution work. |
| Spec convergence workflow descriptor | Available in recognized Instar source checkouts for approved spec preparation. |
| Developer-tools drift audit template | Installed as a built-in job template and disabled by default. |
| Descriptor pre-commit coverage | Automatic when workflow descriptor files are staged in an Instar source commit. |

## Evidence

Validated with focused unit tests for descriptor shape, baseline alignment, disabled job template coverage, and pre-commit handling of workflow descriptors. Ran the full lint command and build. The build scan included the new developer-tools drift audit template; local lock-file signing skipped only because this worktree does not have the release private key.
