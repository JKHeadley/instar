<!-- bump: patch -->
<!-- internal-only -->

## What Changed

The locked-Mac proof build can keep its helper in a separate folder for one test build, so a hidden macOS permission record at the usual folder no longer blocks a proof. The proof build now always makes a helper that can be kept, and the proof driver records whether each person step was delivered. Nothing that ships to agents changes.
