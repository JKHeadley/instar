/** Synthetic executable module plans for loader tests, never production rendering evidence. */
import { ACCOUNTS_CONSOLE_ASSETS } from '../design/harness/accountsConsoleAssets.js';
export function syntheticAccountsTargetFiles(label: string): Record<string, string> {
  const mark = JSON.stringify(label);
  const files: Record<string, string> = {};
  for (const asset of ACCOUNTS_CONSOLE_ASSETS) files[asset.file] = `synthetic ${label} ${asset.file}`;
  Object.assign(files, {
    'dashboard/console/accounts-model.js': `export function buildAccountsPage(){return {marker:${mark}}}`,
    'dist/server/accountsReadRoutes.js': `export function createAccountsReadHandlers(){const h=(_req,res)=>res.json({marker:${mark}});return {pool:h,subscriptionPool:h,subscriptionRelogin:h,inUse:h}}`,
    'dist/core/SubscriptionPool.js': `export class SubscriptionPool {getAvailability(){return {state:'ready'}}list(){return []}}`,
    'dist/core/InUseAccountResolver.js': `export class InUseAccountResolver {async resolve(){return {activeAccountId:null}}}`,
    'dist/core/SubscriptionReloginOperatorConfig.js': `export function describeSubscriptionReloginConfig(){return {}}export function readOnDiskSubscriptionReloginBlock(){return {}}`,
    'dist/server/browserStatusRead.js': `export function createBrowserStatusRead(){return (_req,res)=>res.json({marker:${mark},kind:'browser'})}`,
    'dist/server/healthBaseRead.js': `export function buildHealthBase(){return {base:{marker:${mark},status:'degraded'},isDegraded:true}}export function healthProjectProjection(){return {}}export function formatUptime(){return 'synthetic'}`,
    'dist/server/mobileHealthRoutes.js': `export function mountMobileHealthRoutes(router){router.get('/mobile/health-issues',(_req,res)=>res.json({marker:${mark}}))}`,
    'dist/server/workBoardRoutes.js': `export function registerWorkBoardRoutes(router){router.get('/work-board',(_req,res)=>res.json({marker:${mark}}))}`,
    'dist/core/WorkBoardService.js': `export class WorkBoardService {rebuild(){}}export const DEFAULT_WORK_BOARD_SETTINGS={};`,
    'dist/server/stopGate.js': `export const GATE_ROUTE_VERSION=1,GATE_ROUTE_MINIMUM_VERSION=1;`,
  });
  return files;
}
