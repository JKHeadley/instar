# Quoted Reply Design Scope

<!-- internal-only -->

## What Changed

The unimplemented quoted-reply design accepts loss of quote metadata through older App codecs as a disclosed compatibility limit. Known unavailable quotes use "Quoted message unavailable"; total marker loss may omit the chip. This removes the proposed transferable-evidence machinery while retaining exact base binding, masked source responses, existing stop authority and existing crash recovery. No product behavior changes in this documentation commit.

## Evidence

The bounded decision and independent review are recorded in `docs/specs/reports/quoted-replies-bounded-decision-20261123.md`. The spec and plain-English companion describe future behavior, not an executed feature. No runtime tests, full convergence, deployment or native acceptance is claimed.
