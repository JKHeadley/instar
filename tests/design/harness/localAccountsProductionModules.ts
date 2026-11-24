/** Explicit local-prototype modules. Never used as a target-mode fallback. */
import type { AccountsProductionModules } from './targetProductionModules.js';
export async function localAccountsProductionModules(): Promise<AccountsProductionModules> {
  const [accountsReadRoutes, subscriptionPool, inUseAccountResolver, subscriptionReloginOperatorConfig,
    browserStatusRead, healthBaseRead, mobileHealthRoutes, workBoardRoutes, workBoardService, stopGate, accountsModel] = await Promise.all([
    import('../../../src/server/accountsReadRoutes.js'), import('../../../src/core/SubscriptionPool.js'),
    import('../../../src/core/InUseAccountResolver.js'), import('../../../src/core/SubscriptionReloginOperatorConfig.js'),
    import('../../../src/server/browserStatusRead.js'), import('../../../src/server/healthBaseRead.js'),
    import('../../../src/server/mobileHealthRoutes.js'), import('../../../src/server/workBoardRoutes.js'),
    import('../../../src/core/WorkBoardService.js'), import('../../../src/server/stopGate.js'),
    import(new URL('../../../dashboard/console/accounts-model.js', import.meta.url).href),
  ]);
  return { accountsReadRoutes, subscriptionPool, inUseAccountResolver, subscriptionReloginOperatorConfig,
    browserStatusRead, healthBaseRead, mobileHealthRoutes, workBoardRoutes, workBoardService, stopGate, accountsModel } as unknown as AccountsProductionModules;
}
