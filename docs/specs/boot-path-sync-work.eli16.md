# Less waiting at server start — Plain-English Overview

> The one-line version: two jobs the agent's server does when it starts no longer hold up everything else while they run.

## The problem in one breath

An instar agent's server does all its work on one thread, so anything slow on that thread makes everything else wait. Recordings of Echo's main computer on 21 November 2026, taken while it kept freezing, showed two start-up jobs using that thread more than they needed to. This change was split out of the conversation-list freeze fix (pull request 3598) so each can be reviewed on its own.

## What already exists

- **The code map ("Cartographer")** — at start-up the server rebuilds a small file for every folder and source file in the project, thousands of files, so it can describe the code to the agent later. It already pauses between files so other work can run.
- **The Node check** — at start-up the server checks which installed copies of Node (the program it runs on) can load its database library, then points a fixed shortcut at the best one. It did this by starting a test program for each copy, one after another, while the server waited.

## What this changes

- **The code map** now compares each small file with what is already on disk and rewrites only the ones whose contents changed, which is usually none. Each file's read, compare and write still happen in one step, so a summary saved at the same moment cannot be overwritten.
- **The Node check** now runs its test programs in the background, at most four at once, and the start-up step uses their answers. A test program that has not answered after 10 seconds is stopped and counted as unable to load the library. Other callers (the background helper process and the setup command) behave as before.

## The safeguards

- Nothing is decided differently: the same copy of Node is chosen from the same answers.
- If the background check cannot run, the start-up step checks for itself, as it always has.
- A revert restores the old behaviour exactly; there is no saved state or setting.

## What is not changed

If a copy of Node is replaced on disk (for example by a Homebrew upgrade) in the few seconds between the background check and the choice, the choice can rest on the old answer. That window existed in a different form before, and the next start corrects it.

## What you need to decide

Nothing.
