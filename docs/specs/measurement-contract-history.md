---
title: Retain measurement contract versions and corroborated baselines in the existing ledger
slug: measurement-contract-history
tier: 1
status: draft
---

# Retained measurement definitions

Numeric observations and evaluation hashes survive, but historical method/threshold definitions do not. Raw observations are pruned after90days, which can also remove a still-current recorded baseline. Extend the existing BlockerLifecycleLedger with additive metadata sidecars, not a new registry/database/collector. Current readiness remains advisory and ordinary services remain available.

## Write owner and integrity

At the existing D7 evaluation pass, archive the exact typed contract beside its origin, subject and existing SHA256 contract hash. Store first-archived and last-seen times, never invent an earlier capture time. Verify the hash against the exact serialized body. Keep the body immutable for that hash; an inconsistent existing row is a failure, not something to overwrite. Accept only the closed bounded contract schema (16KiB,16metrics, optional validated outcome metadata); no arbitrary prompt/message/context fields. Legacy numeric contracts are valid archives with explicitly absent outcome/method metadata.

Use CREATE TABLE IF NOT EXISTS metadata tables in the existing measurement database. Do not rewrite/migrate an existing table or change existing observation/evaluation keys. A revert stops using the sidecars; old code ignores them. This is an additive observation archive on an already-enabled measurement owner, not a fleet configuration migration or new control authority. Archive write failure cannot produce a fully recorded ready evaluation: expose insufficient evidence through the existing advisory scorer, while normal service continues.

## Baseline retention

A declared baseline snapshot is not measurement proof. Pin only a local baseline observation corroborated by an exact unambiguous existing-ledger read, matching origin/subject/metric/time/source/ref/descriptor/value/sample count and meeting its sample floor. Foreign, future, missing, tied or mismatched declarations cannot create a pin or recreate an observation. Keep proof reads independent: a prior pin does not override a later ambiguity or source mismatch.

Preserve the complete metric/timestamp collision set when any live pin references it: pruning must never remove conflicting evidence and manufacture an unambiguous baseline. Use an indexed baseline-reference sidecar. Existing90day observation pruning skips matching live pins via an exact indexed join, not a quadratic JSON scan. Refresh established retention pins whenever their exact immutable contract is current, even if newly conflicting evidence makes proof ambiguous. This refresh retains the collision set; it never supplies corroboration. Refresh last-seen only from the current evaluated contract. Old pins and metadata expire after180days without a current-contract sighting, in bounded batches; active contracts keep their corroborated baseline beyond90days. Evaluation and unpinned observation retention remain90days. No unlimited raw messages or decision payloads are retained.

Archive capacity is8192versions/64MiB of definition bodies globally and256versions per origin/subject, with at most16pins per version. Transactional usage counters and insert triggers enforce capacity. At capacity existing exact versions can refresh; new versions fail explicitly, with advisory evidence held rather than evicting live proof. Archive failure also retracts an already-ready slot to insufficient-evidence (identity/time retained), with a current read overlay if that write fails. Repeated same-slot INSERT OR IGNORE cannot restore readiness.

## Read and visual

Resolve metadata only for hashes actually present in the bounded subject history, plus the exact current hash. Verify stored JSON/hash on read; malformed or unavailable snapshots are gaps. Include a bounded newest version projection in measurement detail with exact missing/omitted counts. Distinguish not archived, archived but outside this read, and unreadable. Current targets remain labelled current; archived historical policies appear under their exact versions. No historical method is fabricated from a new definition, and no prior definition is called proof of improved outcomes.

The existing numeric view accepts older peers without snapshots as explicit unknown history. Keep its128KiB payload budget, reserving bounded space for method metadata before allocating points fairly. Missing older metadata never becomes a continuous comparison line. Parent/component and origin boundaries remain intact.

## Verification

Real SQLite tests: immutable/hash-checked snapshots; unknown-field rejection; exact valid baseline pin; no pin for forged/foreign/future/tied/undersampled data; active pin survives90day pruning; inactive180day cleanup; close/reopen durability; read/write failure explicit; old database opens without destructive migration. Verify archive failure with a real SQLite rejection trigger does not become ready. Exercise local/peer measurement reads, byte-budget omission counts and method labels. Test no ordinary-service or activation behavior is introduced.

## Original active carrier

Generic effort/job/decision authoring, missing-evidence claim/promotion enforcement, full deployment and user intelligibility remain original-run work, not certified by metadata retention alone.

> **CMT-001** — Complete topic139374: independent coverage for features, decisions, jobs, efforts and components; enforce missing-baseline claim/promotion holds; preserve versioned history; deploy parent/component trend views; verify real activity and understandable visuals; recurring review reports here with bounded corrective work. Report any remaining gap by the original November6 22:44Z ceiling.

<!-- tracked: CMT-001 -->

