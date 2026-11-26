# Upgrade Guide for Local History Cleanup Directory Sync

## What Changed

Temporary copy cleanup now syncs its parent directory before recording the run as disposed.

## What to Tell Your User

Local history copying is still in development. This checkpoint preserves disk accounting when the filesystem cannot confirm cleanup.

## Summary of New Capabilities

There is no new app control to use.

## Evidence

Focused tests check successful cleanup and an injected directory sync error after removal.
