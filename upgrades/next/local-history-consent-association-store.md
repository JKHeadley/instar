# Durable private association for a copy approval card

## What Changed

The internal staging coordinator can keep one exact Work Board card revision linked to one saved preview across restart.

## What to Tell Your User

Real conversation history copying remains paused.

## Summary of New Capabilities

The unmounted association helper keeps metadata only. It grants no authority.

## Evidence

Real staging tests cover exact replay, wrong owner, preview or revision, and recovery under a fresh staging instance.
