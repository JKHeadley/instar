# Offline Source-Grounded Record Validation

<!-- internal-only -->

## What Changed

Added an internal command that validates captured general answers and judge records against committed schemas and a supplied capture manifest. It rejects malformed JSON, duplicate keys, invalid Unicode, oversized outputs, mismatched identities, unknown sources, incomplete criteria and invalid citation spans. Failed answers and judge errors remain separate. Input hashes demonstrate consistency, not authenticated source authority or a trusted scheduled-trial binding. The command does not call models or execute tools.

## Evidence

Invented unit, combined pipeline and real-command lifecycle checks cover the parser, actual schemas, exact source manifests, withheld citations, Unicode, missing outputs, redaction, BOM byte hashes and FIFO rejection. Independent review corrected encoding and bounded-read issues. Full repository verification remains in the shared throughput path. No semantic grading, blind model route, qualification, measured saving or activation is claimed.
