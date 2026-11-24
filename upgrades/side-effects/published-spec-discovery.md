# Side-Effects Review for Published Spec Discovery

**Slug** Published spec discovery
**Date** 2026-11-23
**Author** Echo
**Second-pass reviewer** Root integration review

## Summary of the change

The private Work search can surface allowlisted spec paths from the current published default branch of the public Instar repository. A single GitHub query binds repository visibility, the commit, and the exact `docs/specs` tree. The response is bounded at 512 KiB and the provider requires fewer than 4,096 entries. An over-bound or unverified tree produces no claims. Results contain the verified path and commit, plus a link to that exact revision. The existing approved A1 spec enrolls versioned Git spec metadata in the discovery slice.

## Decision-point inventory

- The existing private Work session check applies before and after provider reads.
- The spec provider validates repository identity and visibility, commit identity, exact path, and regular blob mode before emitting a candidate.
- The Work console builds a versioned GitHub link from validated fields.

## 1. Over-block

A relevant file outside the reviewed three-path list, a former default-branch revision, or a content-only match does not appear. Search coverage identifies the allowlisted path scope. This source is optional and advisory.

## 2. Under-block

An unrelated spec name can match a common term. Results are labeled as published spec paths and carry no release, approval, ownership, or deployment claim. Visibility is checked for each lookup. A repository change after the response is subject to GitHub's access controls.

## 3. Level-of-abstraction fit

GitHub supplies the public repository and Git metadata. The provider emits observations for the existing Work search. It uses the existing GitHub GraphQL transport and token resolver.

## 4. Signal vs authority compliance

The filename matcher produces an advisory result. It cannot authorize work, act on any record, or prove absence beyond its named corpus. The existing Work session check retains authority over the private request. See [Signal vs Authority](../../docs/signal-vs-authority.md).

## 4b. Judgment-point check

This adds no new judgment point. The owner can open any result and decide whether it addresses the question.

## 5. Interactions

The existing conversation read still runs after all asynchronous providers and a fresh Work session check. PR and spec coverage are independent. A spec provider failure adds only an unavailable coverage entry.

## 6. External surfaces

An authenticated Work lookup may cause a fixed, bounded GraphQL metadata read from the existing GitHub endpoint. The phrase, conversation identifiers and device context stay local. The provider requests no file text, author or commit message and uses no fallback, persisted data, or logs.

## 6b. Operator-surface quality

The console identifies the source as allowlisted public Instar spec paths. It labels each link as a published spec path and displays partial or unavailable coverage through the existing coverage panel.

## 7. Multi-machine posture

No replicated state or machine coordination is added. A server without credentials or verified upstream public access shows unavailable. Every machine gets its evidence from the same public Git authority.

## 8. Rollback cost

Revert the provider and its Work wiring. No stored state or migration needs recovery.

## Conclusion

This slice adds advisory public links within A1's existing private Work session and metadata contract. Independent review checked the integrated source boundaries and the actual GitHub response shape. It found and closed the missing-file failure.

## Evidence pointers

The integrated focused runs passed 16 tests. The production lifecycle fixture boots the real server, gets a scoped dashboard session through its PIN route, and intercepts the existing GitHub HTTPS transport. It verifies a pinned locator, the same fixed outbound body for different owner phrases, private and invalid metadata behavior, and rejection of the master bearer. The browser test verifies that the shipped renderer builds the canonical HTTPS link and drops a traversal path. A TypeScript no-emit check passed. A fixed live GraphQL metadata request returned 2,574 entries and about 191 KiB. A separate GitHub tree read of the observed tree object reported the same entry count and explicit nontruncation. Neither probe sent a search phrase.

## Class-Closure Declaration

No agent-authored-artifact defect. No new self-triggered controller.
