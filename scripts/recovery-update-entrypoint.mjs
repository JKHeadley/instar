#!/usr/bin/env node
// Installer-only bridge: never invoked from a recovery command or an HTTP body.
import {recoveryAutostartUpdatePhase} from '../dist/recovery/RecoveryAutostartUpdate.js';
import {recoveryFleetUpdatePhase} from '../dist/recovery/RecoveryFleetUpdate.js';
try {const phase=process.argv[2];if(phase?.startsWith('fleet-'))await recoveryFleetUpdatePhase(phase.slice(6),process.argv[3]);else await recoveryAutostartUpdatePhase(phase,process.argv[3]); }
catch(error){console.error(error instanceof Error&&/^recovery-[a-z-]+$/.test(error.message)?error.message:'recovery-update-incomplete');process.exitCode=1;}
