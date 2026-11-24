# Upgrade Guide — vNEXT

<!-- bump: patch -->
<!-- internal-only -->

## What Changed

The Claude key and reviewer sign-in tests run with a controlled login environment. The fake key-checking command checks its environment and arguments directly, and the tests clean up their temporary files.

## Evidence

The two unit files cover ordinary and hardened reviewer calls, missing credentials, configured-key delivery, command argument exclusion and rejection handling.

All 14 expected unit cases passed with a synthetic token supplied to the test runner. The focused invocation completed in 17.35 seconds including setup.
