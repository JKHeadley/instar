# Commit the pnpm dependency build allowlist — Plain-English Overview

> The one-line version: a fresh checkout could not install with pnpm at all, because nobody had ever recorded which dependency build steps are allowed to run — so this commits that list.

## The problem in one breath

Anyone cloning this repo and running the install command the project's own documentation tells them to run gets a hard failure. The installer stops with an error naming thirteen dependencies whose build steps it refused to run, and exits non-zero. Nothing gets built. The reason is that newer versions of the installer will no longer run a dependency's setup script unless someone has explicitly approved it, and no such approval was ever committed to the repository.

## Why nobody noticed

This is the interesting half. The automated build pipeline installs with a *different* package manager — one that has no such approval gate and just runs every setup script. So the pipeline has always been green, and its greenness says nothing whatsoever about the path a new contributor or a new agent is instructed to take. The failure only appears on a real machine following the real documentation, and the person who hits it fixes it locally and moves on, so it never gets reported.

I hit it and confirmed it against the current released version rather than assuming: the install exits with code 1, listing all thirteen.

## What already exists

- **A working install path via the other package manager** — used by the build pipeline, unaffected by any of this, and it already runs every one of these setup scripts today.
- **Two committed lock files, one per package manager** — they can drift apart independently. This change does not touch that.
- **A generated placeholder file** — the installer helpfully writes a template listing the thirteen packages, but every value is left as the literal words "set this to true or false". That template is not a decision: with it in place the install still fails. It was also never committed, so it exists only on machines where somebody already hit the error.

## What this adds

One committed file recording an explicit yes-or-no decision for each of the thirteen packages, which makes the install succeed.

Nine get a yes. Each of those has a setup step that produces something real: a compiled native component, or a downloaded program for this specific machine type. Without them the package is not merely unbuilt — it is broken when something tries to use it. These include the database layer, the image library, the search-model runtime, and the tunnel program.

Three get a no. One only checks the machine meets minimum requirements, one prints a notice, and one produces nothing this project needs. Declining them costs nothing.

## Is this a security decision?

Partly, and it deserves a straight answer. Approving a setup script means allowing that package to run code on your machine at install time. So this list is worth reading rather than rubber-stamping.

But it is not an *expansion* of what already runs. The build pipeline installs with the package manager that has no gate, so all thirteen of these scripts already execute today, unreviewed. Writing nine of them down as approved and three as declined leaves strictly less running than before, with the reasoning recorded next to each entry. That is the argument for the specific choices, and it's why each line carries a comment saying what its script actually does.

## The safeguards

- **A guard test** that fails if the file is deleted, if any of the nine required entries is missing or flipped to no, or if any value is left as placeholder text instead of a real yes or no. Each of those failure modes was deliberately triggered to confirm the test actually catches it, rather than trusting that it would.
- **A pinned location.** The same list placed in the project's main configuration file is silently ignored by the installer — I tried it, and the install still failed with all thirteen still refused. So the test also asserts the list is *not* kept there, which stops a future tidy-up from moving it somewhere that looks like configuration but does nothing.

## What this deliberately does not decide

The deeper question is which package manager this project actually uses. Right now the documentation says one, the pipeline uses the other, and both lock files are committed. That is a genuine choice with consequences for contributors and for the pipeline, and it belongs to the operator rather than to me. Fixing the install does not settle it, and I have not pretended otherwise. <!-- tracked: ACT-1613 -->

## What you actually need to decide

Whether the nine approvals are the right nine. Everything else here is mechanical.
