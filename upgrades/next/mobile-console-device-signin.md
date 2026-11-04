# The phone opens the dashboard without the PIN

## What Changed

An owner's paired phone (Instar iPhone app) can open the agent's dashboard console without typing the dashboard PIN. After the owner's Face ID or passcode, the app signs a one-time server challenge with a second Secure Enclave key that only signs after that check, receives a one-minute single-use ticket bound to that phone and address, and the console trades it once at `POST /dashboard/console-ticket` for the same token a PIN unlock returns. It never returns the operator session, so actions that need the PIN still ask for it. New device routes: `POST /mobile/device/presence-key`, `POST /mobile/console-ticket/challenge`, `POST /mobile/console-ticket` (owner phones only, TLS or loopback only). Audit: `.instar/state/mobile-console-tickets.jsonl` (metadata only). Off switch: `mobilePairing.consoleTicket.enabled: false`. MSP phones, phones without a passcode, and older app builds keep the PIN box.

## Evidence

Unit, integration and end-to-end tests cover single use, expiry, Host binding, revocation between mint and redeem, MSP refusal, replay after restart, the off switch, the throttle and the audit. A real-browser run against a throwaway agent opened the real console signed in with a valid ticket and showed the PIN box for a used, unknown or revoked one; its first run found and fixed a Host-comparison defect for phones paired on an IP address. The app's 158 unit tests pass. The no-second-prompt path on a real Secure Enclave runs first on the operator's phone and falls back to the PIN box if it fails.

## What to Tell Your User

Opening the dashboard from the Instar app on your phone no longer asks for the PIN after Face ID. Anything that changes something important still asks for the PIN. If the app ever says to pair the phone again, that restores PIN-free opening.

## Summary of New Capabilities

Owner phones open the console signed in, using a single-use ticket backed by a Face ID-gated key the agent verifies itself.
