import { RECOMMENDED_SERVICE_CATALOG } from './catalog.js';

/** The services a person can choose about (docs/specs/recommended-services.md, The catalog). */
export const RECOMMENDED_SERVICE_IDS: readonly string[] = Object.freeze(RECOMMENDED_SERVICE_CATALOG.map((row) => row.id));
