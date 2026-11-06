## What Changed

Remote Slack history now binds its owner check to the key and person that actually signed the request. It rereads live device, revocation, named-owner and pairing/native authority before each holder dial and after formatting, using the exported mobileOwnerDeviceAdmission helper.

## What to Tell Your User

If you remove a phone's access while it is waiting for Slack history from another machine, the waiting read now checks that change before showing the history. It also stops if the phone's key or person changes, its owner loses that role, or pairing is turned off.

## Summary of New Capabilities

No new route. Remote history checks the actual signed phone identity, current owner profile and recorded revocation before each holder connection and before returning content. The shared admission helper is available to other private phone-read routes. Sends and remote attachment downloads are unchanged.

## Evidence

Focused signer/registry/real-ledger and transport tests, plus actual HTTP held-response races in tests/integration/mobile-slack-holder-proxy.test.ts. Production boot wiring is covered by tests/e2e/mobile-slack-holder-proxy-alive.test.ts. No real-device or deployment proof is claimed.
