<!-- bump: patch -->

## What Changed

The one-line install no longer fails on a computer that has the libvips image library, such as Omarchy. It used to stop within 30 seconds with no message, because a dependency of the memory-search library tried to compile itself and npm gave up on everything. The library moves to its next major version, which has no compile step; search results measured the same, so existing memory keeps working.

The installer, `instar init` and the prerequisites check now share one way to add system packages, and it now includes Arch Linux's pacman. `instar init` no longer runs Ubuntu's command on every Linux. Claude Code and Codex installed through mise are now found, which Omarchy's next release needs.

## What to Tell Your User

If you tried to install me on Omarchy, or on a computer with the libvips image library, and it stopped with no explanation, it works now. Arch Linux is supported by the installer as well.

## Summary of New Capabilities

- The one-line install works on Omarchy and on computers with libvips.
- The installer adds missing tools on Arch Linux.
- Claude Code and Codex installed through mise are found.

## Evidence

Fresh Omarchy 4.0.6 server, Node 26: before the change, the install exited 1 in 30 seconds with no message. With a package of this change and no workaround, it finished with exit 0 and a working pairing link. Claude sessions ran, the agent came back 28 seconds after a real reboot, and it answered over Tailscale through Omarchy's firewall. Search vectors from the old and new library match on five texts (worst cosine 0.9999997), on a Mac and on Omarchy. The pacman commands are covered by unit tests; stock Omarchy already has the tools they would add.
