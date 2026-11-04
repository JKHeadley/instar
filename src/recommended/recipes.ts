/**
 * Setup recipes for recommended services (docs/specs/recommended-services.md, The agent owns setup).
 *
 * A recipe is a proven head start, not the limit: its brief hands a session the whole job, and the
 * session researches and adapts when a provider's flow has changed. Its `verify` is the end-to-end
 * check that decides whether the service works. A service is only available once its recipe is
 * proven, and until then only an agent that lists it under `recommendedServices.provingRecipes` can
 * reach it.
 */
import type { CatalogRow } from './catalog.js';
import { RECOMMENDED_SERVICE_CATALOG } from './catalog.js';

export interface VerifyResult {
  result: 'pass' | 'fail' | 'unknown';
  detail: string;
}

export interface RecipeDeps {
  readSecret: (name: string) => string | null;
  fetch?: typeof fetch;
}

export interface SetupRecipe {
  id: string;
  service: string;
  /** The one secret this recipe may store, through POST /recommended-services/:id/key. */
  secretName: string;
  brief: (context: { port: number }) => string;
  verify: (deps: RecipeDeps) => Promise<VerifyResult>;
}

const RULES = (service: string, port: number): string => `
Rules that apply whatever you find:
- This job is entirely yours until the check below passes. The person only approves decisions, such as a payment, or supplies a credential. They never open a browser, fetch a key, visit a provider's site, run a command, edit a file or follow steps.
- If a provider's flow has changed from what this says, research it and adapt. Routine failures are yours to diagnose, retry and repair, quietly.
- Credentials only ever come through a one-time Secret Drop link, never chat or a file. Ask for one thing at a time, in plain words.
- If you have to hold a key for a moment, keep it in your session's private temporary folder, never a shared one, and delete it as soon as it's stored.
- Whose account is the person's choice: you can fully manage their own accounts, use accounts of your own, or both. Follow what they have said. If they haven't said, ask once and present both as good options.
- Never open an account on a disposable or temporary email address, because the account is lost when that inbox goes. If you have no lasting address to use, say so and ask for the smallest thing you need.
- Close any browser window you opened as soon as you're done with it. A no can end this session without warning, and whatever is still open stays open.
- Talk to the person in this conversation's topic, $INSTAR_TELEGRAM_TOPIC. It is yours for this job, and replies there reach you.
- No spending and no permission grants without their yes. Nothing checks your browser clicks, so this is on you: stop and ask before any page that charges or grants.
- Your calls to this server need the header "Authorization: Bearer $INSTAR_AUTH_TOKEN".
- Just before you activate or store anything, read GET http://localhost:${port}/recommended-services and find this service. If grantedHere is false, the person has said no or this machine isn't authorized: stop, change nothing more, and end.
- When you think it works, call POST http://localhost:${port}/recommended-services/${service}/verify with the header "X-Instar-Request: 1". Only result "pass" means done. Then tell the person, in one plain message, that it works and what it means for them.
- If you run out of options, tell them what you tried in plain words, and name the smallest thing you need. Never hand it back as steps.
`;

export const SETUP_RECIPES: readonly SetupRecipe[] = Object.freeze([
  {
    id: 'jev-v1',
    service: 'jev',
    secretName: 'typesafe_api_key',
    brief: ({ port }) => `The person said yes to Jev from TypeSafe. Set it up.

What's known, as of 2026-11-04: the console at console.typesafe.ai offers "Sign in or create an account through Google or your email". API keys have been reported under API Keys in that console. Reaching it needs a normal browser, because plain fetches were refused. Use the agent's browser profiles (GET http://localhost:${port}/playwright-profiles) and the normal-chrome browser when automation is refused.

Store the key as a plain text body, and don't print it:
curl -s -X POST http://localhost:${port}/recommended-services/jev/key -H "Authorization: Bearer $INSTAR_AUTH_TOKEN" -H "X-Instar-Request: 1" -H "Content-Type: text/plain" --data-binary @-
It refuses to replace a key that was here before setup started. Your own key can be corrected until it passes.

Before anything costs money, confirm the current price with the person. Features that use Jev turn on separately as each is proven, so don't promise the efficiency gains yet.
${RULES('jev', port)}`,
    verify: async ({ readSecret, fetch: doFetch = fetch }) => {
      const key = readSecret('typesafe_api_key');
      if (!key) return { result: 'fail', detail: 'No key is stored yet.' };
      try {
        const res = await doFetch('https://api.typesafe.ai/v1/models', { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15_000) });
        if (res.ok) return { result: 'pass', detail: 'TypeSafe accepted the key.' };
        if (res.status === 401 || res.status === 403) return { result: 'fail', detail: `TypeSafe refused the key (${res.status}).` };
        return { result: 'unknown', detail: `TypeSafe answered ${res.status}.` };
      } catch {
        return { result: 'unknown', detail: 'TypeSafe could not be reached.' };
      }
    },
  },
]);

export function recipeFor(row: CatalogRow): SetupRecipe | null {
  return SETUP_RECIPES.find((r) => r.id === row.setupRecipe) ?? null;
}

/**
 * The catalog this agent sees: recipes it has chosen to prove become available here, and nowhere else.
 * `allowed` answers true only on a throwaway agent or the development agent, so one stray config value on
 * a fleet agent can't offer an unproven recipe to a real person.
 */
export function catalogWithProving(proving: readonly string[] | undefined, allowed: () => boolean): readonly CatalogRow[] {
  if (!proving?.length || !allowed()) return RECOMMENDED_SERVICE_CATALOG;
  return RECOMMENDED_SERVICE_CATALOG.map((row) => {
    const recipe = SETUP_RECIPES.find((r) => r.service === row.id && proving.includes(r.id));
    return recipe ? { ...row, setupRecipe: recipe.id } : row;
  });
}
