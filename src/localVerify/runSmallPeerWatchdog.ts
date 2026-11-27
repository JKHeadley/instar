import { runSmallPeerWatchdog, type TrialStart } from './smallPeerWatchdog.js';
process.once('message', (args: TrialStart) => void runSmallPeerWatchdog(args));
