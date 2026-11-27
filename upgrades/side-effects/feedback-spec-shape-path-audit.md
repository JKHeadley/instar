# Side-effects review — feedback spec draft path audit

**Date:** 2026-10-27  
**Author:** Echo

## Change and decision points

When the feedback executor receives a `spec-drafted` result whose change set fails the existing one-file shape check, it records the relative paths and change types in the existing bounded feedback audit before ending the attempt. The publication decision and rejection reason are unchanged. Two test-only changes stabilize the Telegram cleanup and follow-me route fixtures.

## Over-block and under-block

The one-file shape gate still makes the same decision from the same change set. The new audit cannot reject a valid draft or publish an invalid one. Audit persistence is diagnostic only and does not become an input to later admission or publication.

## Data exposure and abstraction

The record contains attempt ID, relative path, and change type, without file contents. It uses the existing bounded audit sanitization and retention path. Recording before workspace cleanup preserves the evidence that was previously lost. The executor is the right layer because it has the rejected change set and owns that cleanup sequence.

## Interactions and multi-machine posture

The audit remains local to the machine that ran the attempt, like existing executor audit events. It does not change work-item state, retry cadence, approval, safety checks, or remote delivery. The Telegram cleanup and route test changes touch only their test fixtures.

## Verification and rollback

The focused feedback test verifies a rejected extra file and its path audit. The focused Telegram and route tests passed, as did TypeScript and the full unit, integration, and end-to-end suites. Reverting the executor change removes the new diagnostic event without a migration; existing audit records remain readable.
