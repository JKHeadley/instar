# Per-area standards audits — ELI16

Instar already grades how many constitutional standards name a real guard, but
it uses one score for the whole registry. That lets large families hide a small
family falling to zero.

This change uses the registry's existing `family` field as the area list. Every
family gets a committed record saying when it was reviewed, the exact family
content reviewed, the immutable evidence file for that review, and the exact
fraction it may never fall below. CI checks every family independently as well
as the existing whole-registry score. Fractions are compared as integers, so a
small regression cannot disappear through four-decimal rounding.

The evidence is more than a file path. A JSON audit artifact names every family
and digest it accepts, hashes the convergence report, and is itself hashed by
the ledger. Editing the family, the evidence, or its report makes the record
stale. Family names cannot be renamed or removed to erase an old floor. Adding
a family is explicit and it cannot start below the existing 70% aggregate bar.

Time is handled differently from correctness. An old timestamp never makes CI
permanently red. A Monday workflow writes a visible summary and keeps one review-
due issue open after 90 days, but that age signal remains nonblocking. Content
freshness and measured floor regressions are the things with blocking authority.

A missing, empty, or Root-less registry now fails in a full checkout; a caller
with a deliberately partial checkout must say so explicitly. The foundational
Root family is deliberately included. Its only standard now names the real CI
ratchet that enforces it, so it measures 1/1; removing that citation fails instead
of being hidden inside the other 81 standards.
