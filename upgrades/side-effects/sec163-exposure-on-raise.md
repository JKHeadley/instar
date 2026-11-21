# Side effects: switching public exposure on through the API needs the owner's approval (SEC-163)

In plain words: anyone holding the agent's API token could switch on the agent's public tunnel or join the agent network (the relay), with no approval. Now switching either on is a loosening, like SEC-162's guard-off: it is refused, and the owner gets the existing approval card. Switching exposure off stays free.

Tier 1. Stacked on SEC-162 (PR 3614), whose loosening check and approval-card list it extends. Size:
- source files: `src/core/TrustRaiseGuard.ts`, `src/server/routes.ts`, `src/core/trustJourney/TrustJourneyRuntime.ts`, `src/threadline/ThreadlineMCPServer.ts`, `src/threadline/mcp-http-client.ts`, `src/threadline/ThreadlineMcpHttpService.ts`, `src/threadline/mcp-stdio-entry.ts`, `src/scaffold/templates.ts`, `src/core/PostUpdateMigrator.ts`, `src/knowledge/TreeGenerator.ts`, `src/recommended/recipes.ts`
- 1 awareness entry
- 1 new unit test file
- updated integration and end-to-end tests

## What changes for running agents
- **What counts as switching exposure on.** `exposureOnRaises` joins `configPatchRaises` and checks three things:
  - the tunnel going from off to on. It is on unless set false, so a block replaced by a non-object turns it on.
  - the relay going from off to on. It is on only when set true.
  - the relay's visibility widening while it is on: private, then unlisted, then public. An unknown value ranks widest.

  The check uses the same one-level merge the route writes, and it reaches every caller: `PATCH /config`, the bearer single-path writer, and the trust journey.
- **Two paths that wrote the relay switch themselves now go through the card:**
  - `POST /threadline/pairing/enable`, the connect-to-network route. With the relay off, it opens the owner's card for exactly `threadline.relayEnabled: true`, answers 403 and writes nothing. Called again after the owner's yes, it switches pairing on and restarts as before. With the relay already on, nothing changes.
  - The agent-network tool's `enable` action. When joining or widening is a loosening, it opens the card through the server's `POST /trust/requests` over loopback, using the same pattern as the tool's other server calls, and writes nothing. If it cannot reach the server, it refuses and writes nothing.
- **The person hears about the card.** The 403 from `POST /threadline/pairing/enable` carries a `sayToPerson` sentence. Both callers already show that field:
  - the dashboard's switch-on button (`enableWords`)
  - the agent's own connect step 1

  Step 1 now handles the 403: the agent says the sentence, waits for the person's yes, then calls again, instead of polling for five minutes. A content-sniffed `migrateClaudeMd()` step gives existing agents the new step 1, marked by `AGENT_CONNECT_STEP1_APPROVAL_MARKER`. The self-knowledge node for that section grows from 1,400 to 1,600 tokens, so the whole procedure still arrives; managed nodes are refreshed on every update.
- **The Cloudflare recommended-services recipe keeps a tunnel off.** Its first setup is the owner's confirmed act, and still writes the named tunnel on. Its daily refresh rewrote the block on, which switched back on a tunnel the owner had switched off since. A refresh now leaves a switched-off tunnel off.
- **What the card can carry.** Under `tunnel` and `threadline`, a card may carry only their switches: `tunnel.enabled`, `threadline.relayEnabled` and `threadline.visibility`. That is enforced by one rule, `approvableConfigPatch`, read by the request parser and the apply step. A card can never carry a relay address, a tunnel token, a hostname or any other setting under those blocks.
- **Unchanged:**
  - Switching exposure off.
  - Narrowing visibility.
  - Tuning the other relay settings.
  - The tunnel when it is already on, which is its default.
  - Every setup flow, because the setup commands write the settings file directly:
    - creating an agent: `init`, which the Mac and Windows apps call
    - the installer, which only switches the tunnel off
    - the server recording the default-on tunnel at its first start
    - pairing a first phone

## Which app paths are affected
The Chief of Staff searched all 45 branches of the app repository (iPhone, Mac, Android and Windows) on 2026-11-21:
- No app calls the settings interface, the connect-to-network route or `pairing/enable`.
- The only way an app switches exposure is the owner feature switch, `POST /mobile/permissions/features/<id>`, signed by the paired phone. The iPhone and the Mac use it, and so does Android, through its owner-approve path. Windows only reads that list.

So the one visible change is this: switching the relay or the tunnel on from the owner's phone feature list now asks for one approval tap on that phone. This is the same as SEC-162, for the same reason. Under `docs/specs/trust-journey.md` decision 4, a phone confirmation is evidence, never authority for a loosening. Agent creation in the Mac and Windows apps goes through the setup command, and is unaffected.

## Known limits
Other exposure settings under the same blocks are not judged here, because SEC-151 (PR 3613) puts them in its table of operator-only settings, which the API refuses outright:
- the named-tunnel token, config file and hostname
- the relay address
- the first-contact policy

This change and SEC-151 together close the class. Until 3613 merges, those settings are still open to the key.

## Not in this change
Switching public publishing on is not judged here: it publishes nothing by itself, since each public page is its own request. Whether to treat it as exposure too is left to the Chief of Staff.

## Signal vs authority
It adds no authority. It routes the two exposure switches to the existing owner card.

## Rollback
Revert the commit. No state is written.

## Second-pass review
An independent reviewer worked over three rounds, reading the real code paths. Round one found that the agent's own connect step and the dashboard's switch-on button did not understand the new 403. The agent would have polled for five minutes and then told its person it failed, and the dashboard showed the raw error code. Fixed with `sayToPerson`, a step-1 change and its migration. The same round found that the Cloudflare recipe's daily refresh switched a tunnel back on, which is fixed, and that the other levers in the same blocks are covered by SEC-151. Round two checked the migration order and the self-knowledge budget, which is 5,655 characters against 6,400. Round three: concur. Its two minor points are applied: the agent waits only when a card was actually sent, and a refresh with the tunnel off touches nothing at Cloudflare.

## Tests
- `tests/unit/sec163-exposure-on-raise.test.ts` (new). It reproduced the gap first: 7 of 9 cases failed on the old code. It covers:
  - every switch-on and widening path, and the single-path writer
  - what stays free
  - exactly what a card may carry
  - the exact list of affected feature switches
  - that both direct writers go through the card
- `tests/unit/sec162-guard-off-raise.test.ts`: the affected-toggle list now includes switching the relay on.
- `tests/unit/threadline-connect-enable.test.ts` (+1): a pre-SEC-163 step 1 is upgraded once.
- `tests/unit/console-agents.test.ts` (+1): the dashboard shows the card sentence on the 403.
- `tests/unit/recommended-services-cloudflare-recipe.test.ts` (+1): the daily refresh leaves a switched-off tunnel off.
- These pass on the M5: `TrustRaiseGuard`, `bearer-config-write`, `feature-action-applier`, `feature-registry-apply-and-operator`, `ThreadlineMCPServer-relay`, `threadline/ThreadlineMCPServer`, `threadline-connect-enable`, `auth-middleware-threadline-exact-routes`.
- Updated for Local Verify, not run by hand on the M5:
  - `tests/integration/threadline-pairing-enable-route.test.ts`: the owner's yes is played by writing the switch; a new case checks that the key alone is refused and nothing is written.
  - `tests/e2e/threadline/pairing-enable-without-restart.test.ts`: refused first, then the owner's yes, then the same restart story.
  - `tests/integration/trust-raise-refusal-routes.test.ts`: the ungoverned-key case uses publishing, and a new case checks that the tunnel is refused.
