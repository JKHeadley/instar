# Side effects of dormant native consent actions

The dormant signed intake recognizes separate challenge and confirmation actions. Both require an owner phone signature, an encrypted record bound to the endpoint, and the current exact disclosure. The presence envelope uses the Host accepted by the device authenticator.

- Bearer requests, extra fields, moved challenges, stale previews, missing source evidence and replay fail closed. The challenge expires, and a lost reply can be recovered with a new review and challenge.
- Challenge issuance and confirmation share the existing single-use presence store. Successful confirmation returns a proof reference and leaves the copy permit path untouched.
- The paths use the existing machine-local channel and exchange lease. Each response is encrypted, marked no-store and cleared by the exchange disposer.
- The production server and disposable copy pilot leave the consent service unset. Exact route matching prevents fallthrough to the pilot service.
- Other agents and owners gain no new live surfaces. Reverting removes the reserved endpoints without migrating data.

Independent review concurred with the signed Host, exact encrypted paths, and disabled production and pilot surfaces.
