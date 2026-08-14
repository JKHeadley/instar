# Split Messaging Gate Lint - Plain-English Overview

The one-line version: the build lint that catches permanently-off `messaging.*` feature switches now also catches the same key when it is written as two literal string pieces joined with `+`.

## The Problem

Instar has a lint named `lint-no-unreachable-messaging-gate`. Its job is narrow but important: if code asks LiveConfig for a key under `messaging.*` with a default of `false`, that feature can be structurally impossible to turn on from the normal top-level config shape. That is especially risky because default-off features are often safety, delivery, or follow-through systems. The code may look guarded and configurable while the actual key path leaves it dark forever.

The shipped lint caught the plain form:

```ts
liveConfig.get('messaging.actionClaim.enabled', false)
```

It did not catch an equivalent split-literal form:

```ts
liveConfig.get('messaging.' + 'actionClaim.enabled', false)
```

That means a source edit could accidentally or intentionally spell the same unreachable key in a way the lint could not see.

## What This Adds

The scanner now parses the first argument to `.get(...)` when that argument is made only of string literals joined by `+`. It folds those literal pieces into one key before applying the existing rule. If the folded key starts with `messaging.` and the default argument remains the literal `false`, the lint reports the line.

The scope is deliberately small. It does not evaluate variables, function calls, computed values, or template expressions like `` `messaging.${name}` ``. Those cases are not constant literals, so the lint leaves them alone instead of guessing.

## Safeguards

The old whole-literal behavior still works. A non-messaging key such as `monitoring.burnDetection.enabled` still does not report. A key mentioned only in a comment is ignored. A messaging key with a `true` default still does not report, because the bug being guarded is specifically a default-off feature staying unenableable.

The change is implemented in the lint script and tested directly through `scanText`, so the failure mode is visible before touching the real tree. The shipped lint produced zero hits on the split-key reproduction, which is recorded as one reproduction failure. After the fix, the same reproduction reports the offending line and the real repository scan is clean.

## What You Need To Decide

This PR asks whether literal-only folding is the right size of protection for this bug class. It closes the reproduced bypass without turning the lint into a broad JavaScript evaluator.
