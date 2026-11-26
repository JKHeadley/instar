# Relay phone status

## What Changed

The optional relay has a read-only device status handler for an already-paired phone. It checks the current agent assignment, owner authority, lease and device key before accepting the signed request.

## What to Tell Your User

The phone status work is in place for testing. New phone enrollment through the relay remains closed.

## Summary of New Capabilities

An explicitly composed relay listener can serve one signed device status request for the phone associated with the verified assignment. Default startup keeps it off.

## Evidence

Synthetic signed enrollment, revocation, wrong assignment and lease timing checks passed. The signed HTTP test verified that the route rejects requests outside its scope.
