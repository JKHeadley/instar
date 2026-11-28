# iPhone build reporting

## What Changed

An optional build number in a signed device registration is saved with that pairing. Owner device and Needs You reads can return the last reported build.

## What to Tell Your User

After an updated iPhone app reports in, the agent can tell which build it reported. A phone using an older build can continue to connect.

## Summary of New Capabilities

The owner can read the last reported app build on the existing device routes and on the signed Needs You response for their pairing. The report has no effect on permissions or approval status.

## Evidence

Registry, signed request, and disposable server lifecycle regressions cover the report and its compatibility behavior.
