# Docs coverage: class tier back above its floor — Plain-English Overview

> The one-line version: a red check on `main` is fixed by writing the missing
> documentation, not by lowering the bar.

## The problem in one breath

A check called "Docs Coverage" runs on every pull request. It counts the source files
that define a class and asks how many are described in the documentation site. On
2026-10-08 a merge added a new class file with no documentation, and the class score
slipped from 55% to 54%, one half-point under the 55% floor. Since then every open pull
request has failed that check, whatever it changed.

## How the check counts

- A file counts as a "class" when it sits directly in one of 18 source folders and its
  name starts with a capital letter. What the file exports does not matter.
- A class is "documented" when its name appears in two or more documentation pages,
  "partial" (worth half) when it appears in one, and "undocumented" otherwise.
- Only the README and the documentation site pages are read.

## What this change adds

One new reference page, "Threadline Module Reference", that describes the
agent-to-agent modules one at a time: what each is for, what its main methods do, and
where the server uses it. It also says plainly which modules are tested library code
that the server does not start today. Three existing pages gain short entries for the
classes that had no documentation at all, including the one that tipped the score.

## What it does not change

No source code, no tests, no thresholds. The 55% floor is untouched.

## The result

The class score moves from 54% (290 documented, 412 partial, of 911) to 57% (338
documented, 371 partial). That is 27 points of headroom in the script's own counting,
so the next undocumented class will not turn the check red again.

## What to watch

The check matches names as plain text. A page that only lists a name would raise the
score without helping a reader. Every entry added here was written from the source
file, and each says what the module does and where it is wired.
