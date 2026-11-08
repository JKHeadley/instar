#!/usr/bin/env node
/** Initial root creation only. Never rotates/replaces an installed root. */
import {bootstrapRecoveryCertificationRoot} from '../dist/recovery/RecoveryAuthoritySetup.js';
try {
  const [mode,publicPinFile]=process.argv.slice(2);
  // Requiring host configuration prevents a generic development invocation from
  // quietly creating production signing authority in a checkout or /tmp.
  const secretDirectory=process.env.INSTAR_RECOVERY_RELEASE_HOST_SECRET_DIRECTORY;
  if(mode!=='bootstrap'||!secretDirectory||!publicPinFile)throw new Error('recovery-release-host-secret-store-required');
  bootstrapRecoveryCertificationRoot({secretDirectory,publicPinFile});
  console.log('Initial recovery certification root prepared in the configured release-host secret store. Review and ship ONLY the public pin through the normal authenticated release. Agents cannot use it until that release is installed. The existing Instar release root was not changed.');
}catch(error){console.error(error instanceof Error&&/^recovery-[a-z-]+$/.test(error.message)?error.message:'recovery-root-bootstrap-unavailable');process.exitCode=1;}
