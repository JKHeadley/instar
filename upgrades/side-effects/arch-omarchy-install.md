# Side-Effects Review — Instar installs on Arch Linux and Omarchy

**Version / slug:** `arch-omarchy-install`
**Date:** `2026-11-03`
**Author:** `Echo`
**Second-pass reviewer:** `not required (no gate, sentinel, session lifecycle or messaging decision touched)`

## Summary of the change

Topic 136848 tested Instar on Omarchy 4.0.6 (DHH's Arch Linux + Hyprland desktop) on a fresh Hetzner server. Driven by `docs/specs/install-experience.md` (one easy install on any computer).

1. **`npx instar install` failed in 30 seconds and said nothing.** Omarchy installs a system libvips. `sharp@0.34.5`, pinned by `@huggingface/transformers` 3.x, then chooses a source build, the build fails, npm aborts the whole install, and npx prints no reason. Any Mac or Linux machine with libvips hits this. `@huggingface/transformers` moves to `^4.3.2`, whose `sharp ^0.35` has no install script. Only the package range changes; `EmbeddingProvider` is untouched.
2. **The installer now knows pacman.** `packageInstallCommand` knew apt-get, dnf and yum. It now returns `sudo pacman -Sy --needed --noconfirm ...`, mapping the names Arch spells differently (`sqlite3` to `sqlite`, `gh` to `github-cli`). `-y` is deliberate: a fresh Omarchy has no package databases, so `-S` answers "target not found" (seen live, including from Omarchy's own Tailscale installer). The function moves to `src/core/packageInstall.ts` so the installer, `instar init` and the prerequisites check share it.
3. **`instar init` no longer runs apt on every Linux.** Its tool auto-install ran `sudo apt install -y <pkg>` unconditionally; it now uses the shared helper and skips the attempt when no known package manager exists.
4. **The prerequisites check** runs the right command per package manager (it hardcoded `sudo apt install -y tmux` / `gh`), and reports "can't auto-install" instead of a command that cannot work.
5. **Tools installed through mise are found.** `detectFrameworkBinary` searched asdf shims and nvm folders but not mise shims. Omarchy 4.0 keeps its claude and codex launchers in `~/.local/bin`, which was already searched, so 4.0.6 works without this. Omarchy 4.5 release candidates move them to mise shims in `~/.local/share/mise/shims`, and this keeps Instar working across that update (honours `MISE_DATA_DIR` and `XDG_DATA_HOME`). Searched last, after `~/.local/bin`, so every location Instar already searched keeps priority.

## Decision-point inventory

- Which package-manager command the installer, init and the prerequisites check run: modify; pacman added, init and prerequisites follow the shared helper.
- Which `claude` or `codex` an agent runs: modify; a mise shim is a new candidate, after every existing candidate.
- Which embedding library version every agent runs: modify; major bump, output measured identical (below).

## 1. Over-block

None. The change only adds candidates and commands where there were none.

## 2. Under-block

npm still prints nothing when some other dependency's install script fails; that is npm's behaviour and outside this change. Other package managers (zypper, apk, xbps) still return null, which keeps today's "install it yourself" message. Arch derivatives without `sudo` still return null, as before.

## 3. Level-of-abstraction fit

One pure helper decides the package command for every caller, replacing three copies (one of them apt-only). Binary detection stays in the one existing function. The sharp failure happens inside npm before any Instar code runs, so a dependency change is the only layer that can fix it: Instar cannot catch it or print a better message.

## 4. Signal vs authority compliance

No decision point gates information or behaviour. Not applicable.

## 4b. Judgment-point check

None.

## 5. Interactions

- **Machines with both apt and pacman** (rare): apt-get wins, as it is checked first; unchanged for every existing machine.
- **A machine that has `claude` both in a system folder and as a mise shim:** the existing earlier candidates still win, so no existing agent changes which binary it runs. Only machines where the shim is the sole copy change.
- **The Omarchy account switcher:** an explicit `CLAUDE_CONFIG_DIR` (which Instar's subscription pool sets per account) takes precedence over Omarchy's active-account choice, per Omarchy's manual, so pooled sessions keep their account.
- **Arch's partial-upgrade warning:** `-Sy pkg` refreshes the package list without upgrading the rest of the system, which Arch discourages in general because a new package can need newer libraries than are installed. The packages involved (tmux, sqlite, git, github-cli) are low-risk, the alternative on a fresh Omarchy is outright failure, and a full `-Syu` from an installer would upgrade the person's kernel without asking.
- **Embeddings on existing agents:** agents take the new library at their next update, and their stored vectors stay valid. Same model and options, compared on five texts (short, long, Japanese with emoji, one letter): transformers 3.8.1 vs 4.3.2 on the Mac, worst cosine 0.9999997, largest component difference 2.1e-07; 3.8.1 on the Mac vs 4.3.2 on Omarchy (Node 26), also 0.9999997. Memory use and speed came out slightly better. Model files stay in the same cache.
- **`instar init` on a machine with no package manager:** previously ran a failing `sudo apt …`; now returns null and init reports the tool as missing, the same outcome without the failed command.

## 6. External surfaces

The installer may now run `sudo pacman -S --needed --noconfirm <pkg>` on Arch, the same consent model as the existing apt/dnf lines (interactive terminal or cached sudo only).

## 7. Multi-machine posture

Machine-local by design: package installation and binary detection describe the machine they run on.

## 8. Rollback cost

A revert restores the previous behaviour; nothing is migrated or stored, and vectors made by either library version work with the other.

## Tests

- `tests/unit/install-flow.test.ts`: pacman commands for tmux, sqlite (Arch name), git + gh (`github-cli`).
- `tests/unit/detectFrameworkBinary.test.ts`: a shim under `~/.local/share/mise/shims` is found with no PATH help; `MISE_DATA_DIR` wins when set.
- Existing embedding tests (`tests/unit/vector-search.test.ts`, `tests/unit/EmbeddingProvider-idle-unload.test.ts`, `tests/e2e/hybrid-search-lifecycle.test.ts`).
- Live on Omarchy 4.0.6, Node 26.12, Hetzner cx33. Before: `npx -y instar@latest install` exit 1 in 30 s, no message. After, with a tarball of this branch and no workaround: `sharp` 0.35.5, install exit 0, ending with the pairing link on the agent's Tailscale address. Claude sessions ran (headless and interactive) through Omarchy's launcher; a real reboot brought the agent back in 28 s with nobody logged in. `tailscale serve` reached it through Omarchy's firewall from another machine (HTTP 200).
- The `pacman` lines themselves were not exercised by the install: stock Omarchy already has tmux, sqlite3 and git. `pacman -Sy` then `-S tailscale` was run by hand on the box; the commands are covered by unit tests only.
