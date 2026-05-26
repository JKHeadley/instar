# Side-effects Review: Provider-neutral Robust Development Workflows

## 1. Behavior Surface

This change introduces provider-neutral workflow descriptors for robust project development, Instar development, and spec convergence. It also adds a checked-in drift baseline and an off-by-default built-in job template that can compare provider-neutral Instar development surfaces against practices that may have stayed local to one agent or provider.

## 2. User-visible Impact

Most users see no immediate runtime change. Agents that receive the updated source can discover the generic robust-development workflow and the Instar-specific overlay without depending on a Claude slash command. Instar-developing agents also gain an installable, disabled weekly drift audit template that can be enabled when they are actively maintaining Instar itself.

## 3. Safety and Authority

The descriptors are guidance, not new authority. For Instar source changes, the existing authority chain remains the approved spec, ELI16 overview, side-effects artifact, trace, and pre-commit gate. The new pre-commit rule treats `skills/**/workflow.descriptor.json` as in-scope, so future edits to these guidance surfaces must pass the same Instar development review process as skill and script changes.

## 4. Compatibility

The new generic robust-development descriptor is scoped to substantial project development work in any project. The Instar development and spec convergence descriptors remain scoped to recognized Instar source checkouts. The built-in job template is disabled by default and instructs non-Instar contexts to stay silent, so it should not add noise for ordinary agent installs.

## 5. Operational Concerns

The developer-tools drift audit reads `src/data/instar-dev-surface-baseline.json` and inventories checked-in development surfaces. It should surface only actionable drift, preferably through a private report or attention item. It must not autonomously rewrite workflows or gates during a scheduled job run.

## 6. Tests and Verification

Focused tests cover the workflow descriptors, drift baseline alignment, disabled job template, and the pre-commit gate's treatment of workflow descriptors as in-scope behavioral surfaces. The existing built-in manifest test remains part of the focused test run to detect accidental source/manifest drift.

## 7. Later-work Accounting

No untracked later-work is introduced by this change. The weekly drift audit is itself the guard against future capability drift: it should surface concrete migration candidates when useful developer practices appear outside the provider-neutral descriptors or Instar overlay.
