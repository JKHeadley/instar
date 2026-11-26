# Secret Scan force-push handling

Fast-forward push and pull-request history keep the existing range. On a push with unknown or divergent ancestry, the scanner reads all history reachable from the exact head and checks every current file whose path the scanner normally skips. A range, enumeration or scanner failure still blocks the check. Rotation guidance requires the specific finding exit code. A broader fallback scan can take longer and can report older findings.

The workflow keeps exception validation, redaction, default-path coverage, and the pinned scanner. Tests use disposable local Git objects and synthetic scanner exit codes.

Supplemental scanning applies to the head tree. Historical versions of paths excluded by Gitleaks remain outside supplemental coverage.
