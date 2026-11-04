# Side-Effects Review — installer fixes found by a live run on fresh Linux

**Version / slug:** `install-live-fixes`
**Date:** `2026-11-03`
**Author:** `Echo`
**Second-pass reviewer:** `independent subagent; concern raised (search order), fixed, then concurred (see the end of this file)`

## Summary of the change

After #2645 merged, `instar install` was run end to end in a fresh Ubuntu 24.04 container (LXD on Cirrus, a non-root user with sudo, Node 22 installed with the installer's own suggested line). The run found four defects, fixed here. Driven by `docs/specs/install-experience.md`.

1. **`gitWorks()` was false on every machine.** It asked SafeGitExecutor for `--version`, which SafeGitExecutor refuses as an unknown pre-verb flag; in the instar source tree the source-tree guard also refused it. Every install stopped at "Your agent needs git". Now it runs `git version` from the temp folder.
2. **git was not installed on Linux.** A fresh image can lack git. On Linux with a package manager the tools step now installs it the way it installs tmux, and names the command when it can't.
3. **A Claude Code installed to `~/.local/bin` read as missing.** The installer uses `npm install -g --prefix ~/.local` when the global npm folder isn't writable, and Claude Code's own native installer also uses `~/.local/bin`. A login shell adds that folder to PATH only if it existed at login, and the binary finder never looked there. `detectFrameworkBinaryUncached` now checks `~/.local/bin/<name>` last, so it is used only when no copy exists anywhere else.
4. **The agent's config was readable by every user.** With Ubuntu's 002 umask the new agent's `config.json` was 664, holding `authToken`, `dashboardPin` and any pasted Claude token. The installer's last step now makes it 600. A file written later by atomic rename can lose that; that general config-writer issue is filed separately.

## Decision-point inventory

- Whether git works — modify — same verdict, now computed correctly.
- Whether to install git — add — Linux only, same consent and sudo rules as tmux.
- Which binary detection picks — modify — `~/.local/bin` is now a candidate.

## 1. Over-block

None added. Fixing `gitWorks` removes a false block on every machine.

## 2. Under-block

The 600 mode is set once at the end of the install; a later atomic rewrite by another writer can widen it again (filed separately).

## 3. Level-of-abstraction fit

The `~/.local/bin` candidate is in the one shared detector, so the server, setup and installer agree on where a framework binary lives.

## 4. Signal vs authority compliance

No message is gated.

## 4b. Judgment-point check

None.

## 5. Interactions

- Binary detection: `~/.local/bin` is the LAST candidate, after the system folders and the npm-prefix, nvm and asdf copies. An agent that finds a copy anywhere else keeps it, so no running agent switches binaries. A Mac can hold both (on the Studio, a native 2.1.317 in `~/.local/bin` off PATH and an npm 2.1.316 in `/usr/local/bin` on PATH). The first version of this change put `~/.local/bin` first and would have silently switched such agents. The reviewer caught it, and it now only fills the case where nothing else was found.
- `gitWorks` is used only by the installer.

## 6. External surfaces

`sudo apt-get/dnf/yum install -y git`, inside the installer only, after consent.

## 6b. Operator-surface quality

The git message now names the exact command on Linux.

## 7. Multi-machine posture (Cross-Machine Coherence)

machine-local-justification: physical-credential-locality. Local binaries and a local file mode.

## 8. Rollback cost

Revert the commit.

## Conclusion

Safe to ship. Each fix was found and then re-verified in the same live run.

## Evidence pointers

- Live run, fresh Ubuntu 24.04 container, 2026-11-03 07:20–07:31 UTC. Before the fixes: stopped at "needs git", then at "couldn't install Claude Code" although `~/.local/bin/claude --version` printed 2.1.317. After them: the install completed with a pasted token; `sessions.credentials.anthropic` was `{kind:"oauth-token"}` with no legacy field; `~/.claude.json` held `hasCompletedOnboarding`, project trust and `enableAllProjectMcpServers`; `~/.claude/settings.json` held `skipDangerousModePermissionPrompt`; the config was still 600 after the server had run 75 s; and `claude --dangerously-skip-permissions` in the agent folder opened straight to its prompt with no first-run screen.
- Tests: `tests/unit/install-flow.test.ts` (real `gitWorks()` on the test machine; config mode), `tests/unit/detectFrameworkBinary.test.ts` (`~/.local/bin` found with it off PATH).

## Class-Closure Declaration

- defect class: `unbounded-self-action`
- closure: `n/a`
- reason: installer steps and a detection candidate, not a self-triggered loop.

## Second-pass review

Independent subagent, 2026-11-03. **Concern raised:** `~/.local/bin` placed before the system folders would switch the Studio's agents from `/usr/local/bin/claude` (2.1.316, on PATH) to an off-PATH `~/.local/bin/claude` (2.1.317). Fixed by moving it after the system folders; the reviewer then **concurred**, and noted that it still preceded the npm-prefix, nvm and asdf copies. That leftover was also closed: it is now the last candidate. The git check, the Linux git install and the config mode were judged fine.
