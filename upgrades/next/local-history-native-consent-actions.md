# Prepare private Face ID challenge and confirmation requests

## What Changed

The internal consent endpoints can exchange a challenge and a signed confirmation over the same private connection as the copy preview.

## What to Tell Your User

The app still keeps copying conversation history turned off.

## Evidence

The signed HTTP tests cover a successful presence signature, replay, wrong Host, stale disclosure and missing ownership. The production server fixture verifies that the routes stay off in the disposable pilot.
