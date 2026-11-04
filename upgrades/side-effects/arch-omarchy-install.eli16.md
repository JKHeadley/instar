# Instar installs on Arch Linux and Omarchy — plain-English overview

> The one-line version: the one-line install now works on Omarchy (and on any computer with the libvips image library), knows Arch Linux's package manager, and keeps finding Claude Code and Codex after Omarchy's next update.

## The problem in one breath

Omarchy is DHH's new Linux desktop, built on Arch Linux and aimed at people who work with AI coding agents. Justin asked whether Instar runs on it. On a real Omarchy server, the one-line install stopped after 30 seconds and printed no reason. Omarchy includes an image library called libvips. One of Instar's dependencies (an image tool called sharp, pulled in by the library that powers memory search) sees that library, tries to compile itself against it, fails, and npm gives up on the whole install. It is not really about Omarchy: a Mac or Linux machine with libvips installed fails the same way.

Two smaller gaps sat behind that. The installer could add missing tools only with Ubuntu's and Fedora's package managers, and Arch uses a different one, pacman. And a second setup path always ran Ubuntu's command, even where it does not exist.

## What already exists

- One function that picks the package-manager command, used by the installer for tmux, sqlite3 and git.
- A search for the Claude Code and Codex programs that already looks in the places other version managers use, because a background service does not see the same folders as a person's terminal.

## What this adds

- The memory-search library moves up one major version. The new version uses a newer sharp that has no compile step, so the failure is gone. I compared the two versions on the same texts, on a Mac and on Omarchy, and the search vectors match to within rounding, so existing memory keeps working.
- Arch's pacman joins the list, including the two packages Arch names differently. It refreshes the package list first, because a brand-new Omarchy has none and would otherwise say the package does not exist.
- The installer, `instar init` and the prerequisites check now share one function, so none of them runs an Ubuntu command on a machine that lacks it.
- The program search also looks in mise's folder. Omarchy 4.0 does not need this yet, but its 4.5 test versions move Claude and Codex there.

## The safeguards

- Existing computers behave exactly as before: apt is still checked first, and every place Instar already looked for Claude still wins over the new mise folder.
- Installing a package still needs the person at the keyboard or an already-unlocked sudo, as it does with apt today.
- Nothing is stored or migrated; undoing the change is a plain revert, and memory made with either library version works with the other.

## What the reader needs to decide

Nothing. This is a compatibility fix inside the existing install design. Remote desktop on Omarchy's Wayland screen comes separately.
