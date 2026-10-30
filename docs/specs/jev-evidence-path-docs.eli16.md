# Jev evidence path correction: plain-English overview

## What this change is

When a scheduled job finishes and the Jev job-completion audit is switched on, a small evidence file is saved for later checking. The agent's capability card and the design spec both said those files live in `.instar/state/jev-supervision-evidence/`. They do not, and never did. The code that writes them puts them in `.instar/jev-supervision-evidence/`.

This matters because the agent trusts its card. On 2026-09-24 it looked in the documented folder, found nothing, and reported that the audit was broken, after about twenty minutes of chasing the wrong problem. The audit was fine and had 629 files on disk.

## What already exists

The writer works. The folder is already ignored by git. Only the words describing it are wrong.

## What is new

The card and spec now name the real folder. Agents already installed get their copy of the card corrected by the update migration, which is safe to run repeatedly. The folder name is now one named constant in the code, and a new test fails if the card or spec stops matching the path the writer actually uses.

## Why move the words and not the files

The alternative was moving the writer and every existing file into `state/`. That means a data migration on every machine for no user benefit. The audit is a dark research instrument, and correcting the documentation fully fixes the false report.

## Safeguards

No file moves, no behaviour changes, and nothing about the audit is switched on or off. If the change is wrong, a revert restores the old text, and at worst the wrong path comes back into a card.

## What the reader needs to decide

Nothing. This is a small, reversible correction.
