# Upgrade Guide — vNEXT

<!-- bump: patch -->
<!-- internal-only -->

## What Changed

The Gemini smoke tests use an empty temporary workspace and a private trust file. The browser and other verification tests keep the verifier's normal home. The existing Gemini launch and error checks still run when the CLI is installed.

Set `INSTAR_TEST_LIVE_GEMINI=1` from a trusted checkout with a dedicated OAuth login to exercise the live replies.

## Evidence

Both Gemini smoke files and the six real Chrome cases in the web chat file passed on the Laptop. The live Gemini replies were skipped because the disposable workspace had no OAuth credentials.
