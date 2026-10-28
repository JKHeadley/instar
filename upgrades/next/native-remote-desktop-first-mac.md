# Native remote desktop: first Mac target

<!-- bump: minor -->

## What Changed

An explicitly enabled development Mac can now offer its logged-in desktop through an Instar dashboard viewer. A local ScreenCaptureKit and CGEvent helper provides display and human input. Every session requires the dashboard PIN, verified operator Telegram challenge, browser key proof, target fingerprint confirmation and scoped ten-minute grant. One controller at a time; Stop, expiry and server restart close display and input. The feature is dark by default and returns 503 on unsupported hosts.

## What to Tell Your User

On an enabled Mac, open its Instar dashboard Machines page and choose “Open this machine.” Enter the dashboard PIN, approve the short code sent to your private Telegram DM by replying in your verified topic, and compare the target fingerprint. Use Stop when finished. This first test covers the Mac where Echo is installed. Mama PC's Windows desktop and other machines require their own host adapters and live tests before their buttons can appear.

## Summary of New Capabilities

- Native, browser-based operator remote desktop on an explicitly enabled development Mac.
- Verified Telegram step-up, target identity pinning, single controller, bounded video/input and immediate local revocation.

## Evidence

Unit, HTTP integration, production-boot E2E and live macOS capture/input/revoke checks are recorded in the feature tests and the side-effects artifact. Full-suite completion is required before release.
