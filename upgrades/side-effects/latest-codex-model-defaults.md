# Side-effects review for latest Codex model defaults

The launch and topic-profile paths resolve a family selector against the reviewed package manifest. The authenticated config API validates model selectors, merges sibling entries, and publishes the new runtime value after saving it to disk.

## Decision points

- Model selection preserves caller and topic model precedence. The selector orders recognized release IDs numerically and gives the result to the existing compatibility and quota policies.
- Authenticated config writes refuse invalid or unavailable selectors. Published launch defaults and stale-pin warnings have no running-session authority.

## Over-block and under-block

A rejected API write leaves both config snapshots intact. If a reviewed catalog is unavailable at launch after a previous install, an exact model pin still resolves and an inherited family degrades to the existing built-in balanced model with a log entry. Older Codex versions retain the existing compatibility fallback.

## Level of abstraction, signal vs authority, and judgment

The packaged reviewed list is the selection authority. The probe output and stale pin warning are observational signals. No competing live signals are decided by the numeric ordering rule, which compares released versions in a single model family. See [Signal vs Authority](../../docs/signal-vs-authority.md).

## Interactions

The topic profile and interactive and headless launch paths resolve the current configuration. The existing CLI compatibility check and account quota policy still apply. A saved config update takes effect on the next launch. The new code neither starts scheduled probes nor changes the lifecycle of an existing session.

## External and operator surfaces

The profile API and dashboard can report the resolved default. A new launch can select a newer reviewed model. The release default is shared by equivalent releases and topic pins follow the existing transfer path. The configuration write remains scoped to its receiving machine.

## Rollback and verification

A config pin restores a specific default model for new launches. Before installing an older build, restore the previous config snapshot or replace saved family selectors with verified exact pins. Then use the existing application rollback. Focused unit, authenticated integration, and lifecycle tests cover the implemented behavior. Full Local Verify remains with the release verification owner.

## Configuration loader compatibility

The built-in selector applies at the launch and display reader. An absent saved model map stays absent in loaded config, and a saved map contains only the explicit entries. The runtime model fallback remains available without creating a saved pin or changing the generic loader's contract.
