# The Machine care page

<!-- bump: patch -->

## What Changed

The dashboard has a new "Machine care" page (under Capacity, and linked from the Machines page). It says in one sentence per machine whether it is signed up for its weekly clean restart, when it last started, and whether a night is skipped. For the machine you opened it on, it has Sign up, Skip once, Change window and Restart now. Skip and Change window ask for your dashboard PIN. Sign up and Restart now send you a card in Telegram, and nothing happens until you tap it there. It works on a phone.

## What to Tell Your User

- **Machine care page**: "The dashboard now has a Machine care page. It shows each machine's restart status in one line, and for this machine you can sign it up, skip a night, change the restart hours or restart it now. Signing up and restarting still need your tap on the card I send you."

## Summary of New Capabilities

| Capability | How to Use |
|-----------|-----------|
| See and control a machine's weekly restart | Dashboard → Capacity → Machine care |

## Evidence

- Unit: `tests/unit/console-machine-care.test.ts`; integration: `tests/integration/console-static-serving.test.ts`; e2e: `tests/e2e/machine-maintenance-lifecycle.test.ts`.
