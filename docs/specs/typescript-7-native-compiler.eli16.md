# Faster type-checking and builds with TypeScript 7 — plain-English overview

## What this change is

Instar is written in TypeScript. Before any of it can run, a program called the TypeScript compiler checks every file for type mistakes and then turns the code into plain JavaScript. That check runs on every commit, every lint, every build and in every CI run, and it was slow: about 68 seconds to check, and about 93 seconds to build, on our development machine.

Microsoft has rewritten that compiler as a natively compiled program (written in Go). It is now the official release, TypeScript 7. This change switches our type-check and build over to it.

## What we measured

On the same machine and the same code:

- Type-checking: 68 seconds before, 15 seconds after.
- Building: 93 seconds before, 23 seconds after.
- The JavaScript the new compiler produces is byte-for-byte identical to the old compiler's output, in every one of the 1,963 JavaScript files. The shipped program does not change at all.
- We tested that it still catches mistakes by adding a deliberate type error: it caught it and failed, as it should.

## Why the old version stays installed too

Several of our own checking scripts don't just run the compiler; they use it as a library to read and understand our code. TypeScript 7 doesn't offer that library in the same form yet. So both stay installed side by side: the old version as the code-reading library, the new one for checking and building. Our scripts name the new one directly, so there's no ambiguity about which one runs.

## Safeguards

- Nothing users or agents run changes, because the JavaScript output is identical.
- The full lint and build pass, plus the tests that depend on how we build or read code.
- The old compiler is still installed, so anyone can run a cross-check with it at any time.
- Undoing it is a one-commit revert with no data or state to repair.

## What a reader needs to decide

Nothing beyond whether faster checks are worth adding one more development tool. This is a development-tooling change with no effect on running agents.
