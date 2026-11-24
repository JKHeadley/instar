# Upgrade Guide for First Local History Claim Planning

## What Changed

The internal reader can calculate the first copy claim’s disk sizing inputs after it validates every selected file.

## What to Tell Your User

Local history copying is still in development. This checkpoint helps the server estimate the first write before it starts copying.

## Summary of New Capabilities

There is no new app control to use.

## Evidence

Focused tests use the fixed worker and verify existing-store planning, missing-store refusal and final EOF validation.
