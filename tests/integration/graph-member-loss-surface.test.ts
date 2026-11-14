import {it} from 'vitest';
import {runGraphMemberLossProductionEntry} from '../helpers/graph-member-loss-production-entry.js';
it.each(['surface-route','surface-route-resume','surface-route-restart','surface-route-before-native','surface-route-cancel','surface-route-shown','surface-route-left-out','surface-route-after-stage','surface-route-slow','surface-route-slow-lapsed'] as const)('removes a lost machine through the owner route: %s',runGraphMemberLossProductionEntry,120000);
