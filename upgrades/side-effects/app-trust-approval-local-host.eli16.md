# The approval test now pairs the Mac the way a real Mac pairs (ELI16)

## What was wrong

The end-to-end test for approving changes from the app stands up a whole agent server, pairs a pretend Mac with it, and then has that Mac approve a raise in what the agent may do. The Mac that created an agent is a special device: it is bound to the agent's own computer, so it only counts when it talks to the agent over that computer's own internal address (127.0.0.1), never over the internet.

The test marked its pretend Mac as that special device but left it talking over the internet address. The agent did the right thing and refused it ("device-unauthorized"), so the test failed on the merge line. The test was wrong, not the feature.

## What changed

The shared test helper now gives the pretend Mac the computer's own address when it marks it as the local Mac, and every later signed request and Touch ID signature uses that address, the same as the real app. Nothing in the product changed.

## Evidence

tests/e2e/trust-app-approval-alive.test.ts passes (1 of 1), and the integration test that uses the same helper is rerun.
