# Side-effects review for the local job definition preview foundation

**Status** Internal foundation for independent review. No route or cohort is enabled.

## Summary and decision points

The reader observes the configured legacy catalog, portable import journal and manifest inventory under explicit input and row limits. It reuses both production validators and checks file identity, contents metadata, directory confinement and stability before reporting the observed loader disposition. Its output has a fixed list of fields. A candidate manifest remains unknown until its production materialization can be verified. The reader carries no job authority and has no scheduler reference.

## 1. Over-block

An unsupported path, unread manifest, changing directory or bounded input cut can withhold a legacy selection that the loader could establish. The reader reports unknown when a competing source cannot be independently excluded. Reporting a verified selection does not imply migration mapping or scheduler state.

## 2. Under-block

Pinned regular-file checks and a final stability pass detect observed changes. This internal reader alone does not supply a verified cross-process filesystem snapshot, a worker termination boundary, or an authorization boundary. Keep it outside normal request handling until the reviewed route, worker, and confinement proof are in place.

## 3. Level-of-abstraction fit

This is a source observer. It uses the existing loader validation rules and preserves existing selection and scheduling as the authority.

## 4. Signal vs authority compliance

Loader-effective, suppressed and unknown are observations about source inputs. The result cannot publish a job, choose an accountable principal, or authorize controller work. See [Signal vs Authority](../../docs/signal-vs-authority.md).

## 4b. Judgment-point check

Ownership and migration mapping remain unresolved. A later reviewed owner process handles choices that require judgment.

## 5. Interactions

No production writer, scheduler, registration, or config is changed. The test exercises production loader parity on fixtures, including duplicate legacy occurrences and portable ownership.

## 6. External surfaces

The module has no external surface, logs or network calls. A future private route must authenticate before reading and recheck at serialization. The output omits source paths, execution values, comparison digests and raw errors.

## 6b. Operator-surface quality

There is no new operator surface in this slice. A future owner Jobs view must distinguish verified loader observation, scheduler state and unresolved migration.

## 7. Multi-machine posture

The result is internal serving-machine evidence. Pool coverage is unchecked and contains no peer identifiers, counts or aliases.

## 8. Rollback cost

Removing the observer needs no data recovery. It writes no durable state.

## Conclusion

The observer can support targeted implementation and differential tests. Worker admission and termination, robust rooted confinement, scheduler generation proof, exact materialization, response limits and pagination, and owner authorization remain activation gates.

## Class-Closure Declaration

No agent-authored-artifact defect. No new self-triggered controller.
