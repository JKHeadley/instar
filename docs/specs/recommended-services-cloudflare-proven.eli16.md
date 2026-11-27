# Cloudflare fixed address: switched on after its live test

## What this change is

Instar agents can offer to set up outside services for the person they work for. Each service has a "recipe", the steps the agent follows to set it up on its own. A recipe stays hidden on normal agents until it has been tried for real, end to end, on a throwaway test agent, so we never promise something that does not work.

The last of the nine recipes, "Cloudflare with your own domain", passed that test on November 16, 2026, on the exact code this change ships. A test agent was asked in Telegram for an address that never changes. It explained the terms, asked whose account and which address, took the person's yes with the PIN, and asked for the Cloudflare key through a one-time secure link. The server then made a tunnel and a web address on our own test domain, restarted, and its check confirmed the agent answered at that address from the public internet. Switching it off removed the address and the tunnel from Cloudflare and put the temporary address back. An earlier run on November 9 reached the same result.

This change marks the recipe as proven in the service list, so every agent can now offer it.

## What already exists

The recipe, the confirm page, the key route, the server's Cloudflare work, the check, the daily refresh and the switch-off are already merged and released. The other eight services were switched on the same way.

## What is new

One line in the service list names the proven recipe instead of "none". The tests that kept Cloudflare hidden now expect it to be available.

## Safeguards

Nothing happens without the person's yes on the confirm page. Buying a domain still needs the person's yes to the exact price first. The key is stored by the server and never printed, and the switch-off removes only what setup made. The proactive list of offers stays behind its own switch, still off by default. Undoing this is a one-line revert.

## What you need to decide

Nothing. This follows the existing rule: a recipe becomes available once its live test passes.
