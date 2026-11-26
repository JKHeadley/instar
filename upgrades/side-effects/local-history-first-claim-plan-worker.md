# Side-Effects Review for First Local History Claim Plan Worker

The existing fixed reader can optionally calculate the first claim's size after validating the entire prepared stream. It uses the real writer lock and store claim planner. Only bounded size inputs and the first file ID leave the child. No opaque token or plan can be executed outside the child.

## Over-block

Planning requires an existing verified store and the supported claim planner. Missing folders, stale artifacts, writer contention and malformed replies refuse. Ordinary preview requests retain their established response shape.

## Under-block

The output is a point-in-time estimate of logical content and allocation inputs. It does not provide calibrated physical headroom or validate later mutation. The writer scope ends when the worker finishes. An actual copy must revalidate the live artifact, writer lock and plan inside its own permit protocol.

## Abstraction fit and interactions

The reader owns full stream and final EOF validation. It saves only the first file's source identity during the stream. The writer-scoped store planner runs after validation and returns numeric sizing. Existing writer lock metadata effects remain. The mode does not create a destination store, create a source claim database, append messages or send a permit.

## Signal versus authority

Under docs/signal-vs-authority.md, exact file identity, EOF and verified framing are protocol facts. The size estimate informs resource accounting and supplies no consent or mutation permission.

## External surfaces and machine scope

One optional mode is available only to the internal fixed-child interface. No route, app control, installed migration, external I/O, or configuration is added. Work and private artifacts stay on the selected machine.

## Rollback

Reverting the mode preserves the original preview API and all existing data. No new durable state or copy authority depends on it.

## Class-Closure Declaration

The unbounded-self-action class does not apply. The existing one-shot reader uses the same child admission and exit. The optional planning step launches no extra worker or retry.

## Independent Review

The reviewer concurred with the EOF requirement, existing writer scope and bounded reply shape. The reviewer inspected source and tests without running them.
