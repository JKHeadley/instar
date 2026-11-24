# Upgrade Guide — vNEXT

<!-- bump: patch -->

## What Changed

An enrolled disposable agent can show a private, serving-machine-only job migration preview. It uses the configured local catalog, keeps distinct definitions visible, and marks uncertain selection and ownership explicitly.

## What to Tell Your User

In the disposable test, you can open Jobs, select **Preview job migration**, and unlock to see the local definitions. The preview shows what the file loader could verify and which questions still need evidence. Opening it leaves jobs and schedules alone.

## Summary of New Capabilities

The Jobs preview uses the existing private console unlock. Continue with **Next page** as long as the observed catalog has not changed. The first test covers local source inventory and leaves live scheduler state and other machines unchecked.

## Evidence

Twenty-nine focused tests covered native browser interaction, private HTTP authorization, pagination at 251 definitions, changed-snapshot refusal and a production AgentServer fixture. Seventy-seven adjacent loader tests also passed. Qualification beyond the disposable reader is pending.
