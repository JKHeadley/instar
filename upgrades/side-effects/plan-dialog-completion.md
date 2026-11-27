# Plan dialog ownership

## Summary

Tier 1. Delayed completion closes only the panel that initiated the action and refreshes Plans even if the panel was dismissed. The change is confined to the renderer and fixtures.

## Signal and authority

The existing plan and round state supply the displayed label. The existing server still determines eligibility, records permission, and controls execution. The acknowledgement action, round index and request payload remain unchanged.

## Over-block and under-block

A disconnected panel skips the delayed close. Plans still refreshes after the result. A panel still on screen can complete its existing close and refresh flow. Success and stale-plan conflict responses use the same panel ownership check.

## Interactions and multi-machine posture

The fix uses the DOM panel returned by the shared sheet and applies only to replaced or closed panels. It changes no device or machine routing, storage, or startup behavior. Existing plans and mixed-version installs remain readable. Tests exercise the existing request and delayed results with the owning panel open or replaced.

## Rollback

Revert the browser changes. Recorded decisions and configuration need no migration or repair.

## Independent review

Concur with the review. Reviewer `/root/plans_review` verified against `ed6804ffc` that the acknowledgement eligibility, request action, and round payload remain intact. Current main returns the actual sheet panel and disconnects it synchronously when replaced. The delayed success and conflict timers both use that panel identity.

## Evidence

On main base `ed6804ffc`, all 33 focused renderer tests, 50 Projects API integration tests and one production Work Projects lifecycle test passed.
