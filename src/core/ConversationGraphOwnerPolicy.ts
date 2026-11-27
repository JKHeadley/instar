/** Actual disk PIN policy, independent of cached runtime/config counters.
 * Generation is structural authority metadata, never a hash of the secret PIN.
 */
import fs from 'node:fs';
import path from 'node:path';
import {LiveConfig} from '../config/LiveConfig.js';
import {assertDashboardPinGenerationBinding} from './DashboardPinGeneration.js';
import {SecretStore} from './SecretStore.js';

export interface ConversationGraphOwnerPolicySnapshot {pin:string;generation:string}
export interface ConversationGraphOwnerPolicyOptions {stateDir:string;secrets?:SecretStore;forceFileKey?:boolean}
const generationPattern=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function diskConfig(stateDir:string):Record<string,unknown>{
 const file=path.join(stateDir,'config.json');const stat=fs.lstatSync(file);
 if(!stat.isFile()||stat.isSymbolicLink())throw new Error('graph-owner-policy-config-invalid');
 const value=JSON.parse(fs.readFileSync(file,'utf8'));if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('graph-owner-policy-config-invalid');return value;
}
function actualPin(config:Record<string,unknown>,options:ConversationGraphOwnerPolicyOptions):string|null{
 const raw=config.dashboardPin;
 if(raw===undefined||raw===null||raw==='')return null;
 if(typeof raw==='string'){if(raw==='(check your config)')throw new Error('graph-owner-policy-pin-unavailable');return raw;}
 if(raw&&typeof raw==='object'&&!Array.isArray(raw)&&Object.keys(raw).length===1&&(raw as {secret?:unknown}).secret===true){
  const value=(options.secrets??new SecretStore({stateDir:options.stateDir,forceFileKey:options.forceFileKey})).get('dashboardPin');
  if(typeof value!=='string'||!value||value==='(check your config)')throw new Error('graph-owner-policy-pin-unavailable');return value;
 }
 throw new Error('graph-owner-policy-pin-invalid');
}
/** Actual PIN login can validate a legacy credential before owner-authorized
 * first-use generation initialization. This read never mints a generation. */
export function readConversationGraphOwnerCredential(options:ConversationGraphOwnerPolicyOptions):string|null{
 const config=diskConfig(options.stateDir);assertDashboardPinGenerationBinding(options.stateDir,config.dashboardPinGeneration);return actualPin(config,options);
}
/** Promotion/read callback: it NEVER creates a missing generation. */
export function readConversationGraphOwnerPolicy(options:ConversationGraphOwnerPolicyOptions):ConversationGraphOwnerPolicySnapshot|null{
 const config=diskConfig(options.stateDir);assertDashboardPinGenerationBinding(options.stateDir,config.dashboardPinGeneration);const pin=actualPin(config,options);
 if(!pin)return null;
 const generation=config.dashboardPinGeneration;
 if(generation===undefined)return null;
 if(typeof generation!=='string'||!generationPattern.test(generation))throw new Error('graph-owner-policy-generation-invalid');
 return{pin,generation};
}
/** Invoke only at first actually authenticated owner feature use. An old PIN
 * with no generation is migrated by the REAL atomic PIN writer, preserving its
 * raw vault reference. Invalid existing generations are never silently reset. */
export function initializeConversationGraphOwnerPolicy(options:ConversationGraphOwnerPolicyOptions&{liveConfig:LiveConfig}):ConversationGraphOwnerPolicySnapshot|null{
 if(!(options.liveConfig instanceof LiveConfig)||path.resolve(options.liveConfig.stateDirectory)!==path.resolve(options.stateDir))throw new Error('graph-owner-policy-writer-mismatch');
 const config=diskConfig(options.stateDir);assertDashboardPinGenerationBinding(options.stateDir,config.dashboardPinGeneration);const pin=actualPin(config,options);if(!pin)return null;
 if(config.dashboardPinGeneration!==undefined)return readConversationGraphOwnerPolicy(options);
 options.liveConfig.set('dashboardPin',config.dashboardPin,{initializeDashboardPinGeneration:true});
 const policy=readConversationGraphOwnerPolicy(options);if(!policy)throw new Error('graph-owner-policy-initialization-unconfirmed');return policy;
}
