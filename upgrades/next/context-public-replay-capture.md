<!-- internal-only -->

## What Changed

Added a manual Claude capture adapter for the checked-in synthetic replay plan. Each captured answer records a parse outcome (valid, json-parse-failed, or schema-invalid with the validator's reason), so an ungradeable answer can be told apart from a wrong one.

## What to Tell Your User

This is a development-only evaluation tool.

## Summary of New Capabilities

The project team can capture public replay answers and provider-reported usage after its configured route passes a confinement probe.
