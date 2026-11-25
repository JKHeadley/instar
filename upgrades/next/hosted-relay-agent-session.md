# Connect the agent to the disposable relay

## What Changed

The agent-side adapter signs the relay's control challenge and connects an admitted stream to the local TLS listener.

## What to Tell Your User

The optional relay remains off. The reusable agent connection is being tested locally.

## Evidence

A disposable integration test uses the agent adapter and the relay service to verify end-to-end TLS and shutdown.
