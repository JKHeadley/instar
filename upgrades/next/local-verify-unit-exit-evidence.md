# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

When the unit test process exits unsuccessfully without a reported failed test, the verifier keeps its exit status, signal, and bounded diagnostic output in the private failure artifact. It also keeps the installed reporter’s unhandled-error summary when available.

## What to Tell Your User

A test run that stops without naming a failed test now leaves more evidence to diagnose the worker failure.

## Summary of New Capabilities

The existing private failure artifact can show unit process diagnostics.
