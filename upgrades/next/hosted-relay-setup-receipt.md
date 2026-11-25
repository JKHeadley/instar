# Turn a one-time relay code into an agent address

## What Changed

The disposable client redeems a code over the verified relay connection and accepts only a hostname in the configured relay domain.

## What to Tell Your User

The code finds the agent. Ownership is verified separately. The optional relay remains off.

## Evidence

The secure loopback test exercises real redemption. The locator checks reject extra fields, wrong domains and oversized responses.
