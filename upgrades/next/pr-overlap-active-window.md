# Upgrade Guide — vNEXT

<!-- bump: patch -->
<!-- internal-only -->

## What Changed

The commit overlap advisory asks GitHub for recently updated open pull requests and allows up to 20 seconds for the lookup. It reports an unknown result if the response exceeds the scan limit.

## Evidence

A live 300-PR lookup timed out under the old eight-second budget. The active-window lookup returned 245 pull requests in about 12 seconds. The overlap suite covers the scan-limit warning.
