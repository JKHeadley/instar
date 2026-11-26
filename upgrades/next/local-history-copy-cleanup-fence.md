# Upgrade Guide for Local History Copy Cleanup

## What Changed

Staging keeps disk charges for registered temporary copy folders until it can verify that cleanup has settled.

## What to Tell Your User

The local history flow is still in development. This checkpoint preserves disk accounting after an interrupted run.

## Summary of New Capabilities

There is no new app control to use.

## Evidence

Focused checks cover restart, exact namespace cleanup, a recreated namespace, and ordinary upload cleanup.
