# Native remote desktop: first Mac target

<!-- bump: minor -->

## What Changed

An explicitly enabled development Mac can now offer its logged-in desktop through an Instar dashboard viewer. A local ScreenCaptureKit and CGEvent helper provides display and human input. Every session requires the dashboard PIN, browser key proof, target identity pinning and a scoped ten-minute grant. One controller at a time; Stop, expiry and server restart close display and input. The phone viewer fills the screen, keeps gestures on the remote surface, and offers trackpad and direct modes. Continuous native capture uses hardware H.264 when the browser can decode it, with a JPEG fallback. The stream tolerates dropped frames and short capture failures, while persistent native helpers avoid per-action process startup. The npm release builds and includes one universal Mac helper for Apple silicon and Intel. The feature is dark by default and returns 503 on unsupported hosts.

## What to Tell Your User

On an enabled Mac, open its Instar dashboard Machines page and choose “Open this machine.” Enter the dashboard PIN. Use one finger to move and tap, two fingers to scroll, or switch to Direct mode; choose Stop when finished. The first test covers the Mac where Echo is installed. Mama PC's Windows desktop and other machines require their own host adapters and live tests before their buttons can appear. This is an initial quality pass; physical phone checks and measured latency are still needed before claiming AnyDesk-level smoothness.

## Summary of New Capabilities

- Native, browser-based operator remote desktop on an explicitly enabled development Mac.
- PIN-only operator entry, target identity pinning, single controller, bounded display/input and immediate local revocation.

## Evidence

Unit, HTTP integration, production-boot E2E and live macOS capture/input/revoke checks are recorded in the feature tests and the side-effects artifact. Full-suite completion is required before release.
