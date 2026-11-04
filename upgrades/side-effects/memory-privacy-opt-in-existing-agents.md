# Side-Effects Review — Memory privacy: never restrict an existing agent

**Version / slug:** `memory-privacy-opt-in-existing-agents`
**Date:** 2026-11-04
**Author:** echo
**Second-pass reviewer:** independent reviewer subagent, fresh context

## Summary of the change

Justin's decision, 2026-11-04: an update must not restrict an existing agent. Memory privacy is now on only when `memoryPrivacy.enabled` is exactly true, which only an owner sets. The migration writes false where it is missing. With it off, boot does no probe or install, and ends any session still inside the boundary.

## Decision-point inventory

- `wireMemoryPrivacy` config: unset now reads as off. This one value feeds every existing check.
- `migrateConfig`: writes false only where the value is missing.
- `retireBoundedSessionsWhenPrivacyOff`: ends sessions that have a scope folder, only when privacy is off.

## 1. Over-block

Removes blocks. An opted-in agent is unchanged, and a test proves it still refuses when it has no sandbox.

## 2. Under-block

This is the accepted cost. An older agent serving several people does not separate their facts until its owner opts in, which brings back the leak the feature closed. Justin chose this.

A machine joined to an opted-in agent has no copy of the setting, because `config.json` is not in the mesh repo, so it would serve unprotected after failover. That is a privacy boundary, so new agents do NOT start with it on, which narrows Justin's decision until failover keeps the setting. An owner who opts in must set it on every machine, and the agent's CLAUDE.md says so. Making failover keep the setting is the follow-up.

## 3. Level-of-abstraction fit

The default is decided once, where config enters the feature, so no consumer has to know about it. The class default in `MemoryPrivacy` stays for direct unit use, and the wiring is its only production constructor.

## 4. Signal vs authority compliance

No new judgment. A setting decides.

## 4b. Judgment-point check (Judgment Within Floors standard)

No judgment points.

## 5. Interactions

- Boot wires privacy from config loaded before the migration runs, so a missing value must already read as off. Without that, the first boot after an update would restrict the agent.
- The boot step ends bounded sessions, and the next message starts an ordinary one. It runs before the reap log is wired, so those ends are in the server log only. A failed end is logged, and that session stays bounded until it ends.
- An owner who opts in must restart, because boot is what runs the probe.

## 6. External surfaces

An update no longer installs Linux packages on an agent with privacy off, and no longer raises a sandbox alert there.

## 6b. Operator-surface quality (Operator-Surface Quality standard)

The agent's CLAUDE.md now says it is opt-in, and tells it to say plainly that facts are not separated until the owner opts in.

## 7. Multi-machine posture

Per machine. The setting does not travel, so an opt-in is per machine.

## 8. Rollback cost

Revert the commit. The written false values stay, so agents remain off, which is the safe direction.

## Class-Closure Declaration (display-only mirror)

Not an agent-authored-artifact defect. The new tests are the regression guard. The boot step is one-shot, not a self-triggered loop.

## Conclusion

Agents go back to how they worked. Owners who ask get the protection, on each machine they set it.

## Second-pass review

**Reviewer:** independent reviewer subagent, fresh context.
First pass: changes needed. It found no path that restricts an upgraded agent, and three gaps. Non-interactive setup and the wizard did not write the setting: moot, because no creator writes it now. A Linux agent with privacy off still ran the sudo install and raised a false alert: fixed with a test. A joined machine loses the setting: resolved by keeping new agents off, on review coordination's instruction not to ship new agents default-on with that gap.
Second pass: approve, with no regressions found. That read came before the last revision, which only removed the new-agent writes and changed wording, so that revision was not re-read by the reviewer. Tests cover it.

## Evidence pointers

`tests/unit/memory-privacy-existing-agents.test.ts`, `tests/e2e/memory-privacy-existing-agent-lifecycle.test.ts` (an upgraded agent in a group topic with no sandbox). First verify is the full suite on this head.
