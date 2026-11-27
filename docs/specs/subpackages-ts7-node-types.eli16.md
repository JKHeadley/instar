# Two small packages build with the faster compiler too — plain-English overview

## What this change is

Besides the main program, the instar repository holds a few small packages that are published on their own, such as the core of the agent-to-agent messaging system (threadline-core) and a package called witness. When the main build moved to TypeScript 7, the natively compiled compiler, two of those packages turned out not to build with it: they produced over a hundred errors saying basic Node.js things like `Buffer` didn't exist.

The cause is a change in TypeScript 7. Older versions automatically picked up every type-definition package installed nearby; TypeScript 7 only uses the ones a project names. These two packages never named the Node.js definitions they rely on. Each now names them in one line of its settings.

## What we measured

- Errors under TypeScript 7: 135 → 0 and 61 → 0. Still zero under the older compiler.
- The program code they produce is exactly the same with either compiler.
- Each package's own tests pass however it is built (20 of 20, 65 of 65).

## What a reader needs to decide

Nothing; it removes a trap for whoever next moves these packages to the new compiler.
