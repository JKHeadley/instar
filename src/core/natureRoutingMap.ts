/**
 * Nature-axis routing MAP — a pure, read-only composition of the shipped routing
 * data (docs/specs/nature-axis-routing.md, FD11 "readable canary"). It answers a
 * single operator question: for every known internal job-kind, which door + model
 * does it use, and what is its full ordered fallback tier list?
 *
 * This module is DATA-ONLY and SIDE-EFFECT-FREE. It reads exported maps from
 * `llmBenchCoverage` (the four routing chains, the job-kind→nature registry, the
 * label→model-id registry, the door taxonomy, the critical-gate set, and the
 * per-component untrusted-input classification) and `componentCategories` (the
 * known-component list + categories) and composes them into a display structure.
 * It performs ZERO writes, mutates NO config, and changes NO routing behavior —
 * it only DESCRIBES the maps the resolver already uses. It backs
 * `GET /intelligence/routing/chains`.
 *
 * Injection-exposure display: three shipped signals — per-position `injectionSafe`
 * (a door that must not take an injection-exposed call, e.g. Groq), per-component
 * `LLM_UNTRUSTED_INPUT` (does the component judge attacker-controllable content), and
 * the per-component FD5b `LLM_ROUTING_INJECTION_EXPOSURE` classification (exposed + the
 * user/model/tool input channels), surfaced when that map is present on the base.
 */
import {
  NATURE_ROUTING_DEFAULT_CHAINS,
  LLM_ROUTING_NATURE,
  ROUTING_LABEL_TO_MODEL_ID,
  CLI_ROUTING_DOORS,
  METERED_ROUTING_DOORS,
  NATURE_ROUTING_CRITICAL_GATES,
  LLM_UNTRUSTED_INPUT,
  LLM_ROUTING_INJECTION_EXPOSURE,
  type RoutingChain,
  type RoutingDoor,
  type TaskNature,
  type ChainPosition,
} from '../data/llmBenchCoverage.js';
import { knownComponents, categoryForComponent, type ComponentCategory } from './componentCategories.js';

/** One resolved chain position for display: the door + concrete model id + static flags. */
export interface RoutingMapPosition {
  /** The access path to a model (CLI harness or metered API). */
  readonly door: RoutingDoor;
  /** `cli` (an installed harness) or `metered` (a paid API door). */
  readonly doorClass: 'cli' | 'metered';
  /** The chain position's benchmark label / tier hint. */
  readonly label: string;
  /** The concrete model id (label resolved via ROUTING_LABEL_TO_MODEL_ID; a tier hint passes through). */
  readonly modelId: string;
  /** `false` only when this door must NOT take an injection-exposed call (FD5b; e.g. Groq WRITE). */
  readonly injectionSafe: boolean;
  /** A real-spend door gated behind Increment B's money/PIN go-live. */
  readonly moneyGated: boolean;
  /** Vault secret name backing a metered door (Increment B). */
  readonly keyRef?: string;
  /** doc-tree / cartographer components may never route to any claude-code door (R6). */
  readonly claudeBanned: boolean;
  /**
   * Metered doors are DEFINED but always skipped (unavailable) in Increment A — so
   * this position does not actuate today. Purely informational.
   */
  readonly skippedInIncrementA: boolean;
}

/** A full chain (FAST/SORT/JUDGE/WRITE): its ordered position list. */
export interface RoutingMapChain {
  readonly chain: RoutingChain;
  readonly positions: readonly RoutingMapPosition[];
}

/** One known component's routing entry. */
export interface RoutingMapComponent {
  readonly component: string;
  readonly category: ComponentCategory;
  /** The task nature (A/B/D/E) — null when the component is unmapped (legacy category routing). */
  readonly nature: TaskNature | null;
  /** The routing chain — null when unmapped. */
  readonly chain: RoutingChain | null;
  /** A fail-closed critical gate: no available door ⇒ throw, never fall through (FD6). */
  readonly criticalGate: boolean;
  /** Does the component judge attacker-controllable content? true / false(+reason) / null(=unclassified). */
  readonly untrustedInput: boolean | null;
  /** When `untrustedInput` is false, the argued reason for the exemption. */
  readonly untrustedInputReason?: string;
  /**
   * FD5b injection-exposure classification: whether the component's LLM call can carry
   * attacker-controllable content, and via which channel(s) (user / model / tool). Present
   * only when the shipped FD5b `LLM_ROUTING_INJECTION_EXPOSURE` map is on the base.
   */
  readonly injectionExposure?: {
    readonly exposed: boolean;
    readonly channels: { readonly user: boolean; readonly model: boolean; readonly tool: boolean };
    readonly reason?: string;
  };
  /** The CURRENTLY-enforced legacy framework (live, optional — injected by the route). */
  readonly enforcedFramework?: string;
  /** The ordered resolved chain for this component ([] when unmapped). */
  readonly route: readonly RoutingMapPosition[];
}

/** The full read-only routing map. */
export interface NatureRoutingMap {
  readonly doors: { readonly cli: readonly RoutingDoor[]; readonly metered: readonly RoutingDoor[] };
  readonly chains: readonly RoutingMapChain[];
  readonly components: readonly RoutingMapComponent[];
  /** Which injection-exposure signal the display is sourced from. */
  readonly injectionExposureSource: 'FD5b-exposure-map' | 'untrusted-input-flag';
  readonly note: string;
}

/** The canonical chain order for display. */
const CHAIN_ORDER: readonly RoutingChain[] = ['FAST', 'SORT', 'JUDGE', 'WRITE'];

/** Resolve a chain position's `model` label to a concrete id (FD-LABEL); a tier hint passes through. Pure. */
function resolveModelId(pos: ChainPosition): string {
  return ROUTING_LABEL_TO_MODEL_ID[pos.door]?.[pos.model] ?? pos.model;
}

/** Compose one display position from a chain position. Pure. */
function toMapPosition(pos: ChainPosition): RoutingMapPosition {
  const doorClass: 'cli' | 'metered' = CLI_ROUTING_DOORS.has(pos.door) ? 'cli' : 'metered';
  return {
    door: pos.door,
    doorClass,
    label: pos.model,
    modelId: resolveModelId(pos),
    injectionSafe: pos.injectionSafe !== false, // undefined ⇒ safe; only explicit false ⇒ unsafe
    moneyGated: pos.moneyGated === true,
    keyRef: pos.keyRef,
    claudeBanned: pos.claudeBanned === true,
    skippedInIncrementA: METERED_ROUTING_DOORS.has(pos.door),
  };
}

/** Resolve a component's untrusted-input classification for display. */
function untrustedFor(component: string): { flag: boolean | null; reason?: string } {
  const raw = LLM_UNTRUSTED_INPUT[component];
  if (raw === true) return { flag: true };
  if (raw && typeof raw === 'object') return { flag: false, reason: raw.false };
  return { flag: null }; // undeclared
}

/**
 * Build the full nature-axis routing map. Pure — reads exported static maps and an
 * optional live `enforcedFrameworkFor` callback, writes nothing, mutates nothing.
 */
export function buildNatureRoutingMap(opts?: {
  /** Optional live resolver for the CURRENTLY-enforced legacy framework of a component. */
  enforcedFrameworkFor?: (component: string) => string | undefined;
}): NatureRoutingMap {
  // Pre-compose the four canonical chains once (each component reuses these).
  const chainPositions: Record<RoutingChain, readonly RoutingMapPosition[]> = {
    FAST: NATURE_ROUTING_DEFAULT_CHAINS.FAST.map(toMapPosition),
    SORT: NATURE_ROUTING_DEFAULT_CHAINS.SORT.map(toMapPosition),
    JUDGE: NATURE_ROUTING_DEFAULT_CHAINS.JUDGE.map(toMapPosition),
    WRITE: NATURE_ROUTING_DEFAULT_CHAINS.WRITE.map(toMapPosition),
  };

  const chains: RoutingMapChain[] = CHAIN_ORDER.map((chain) => ({
    chain,
    positions: chainPositions[chain],
  }));

  const components: RoutingMapComponent[] = knownComponents().map((component) => {
    const nc = LLM_ROUTING_NATURE[component];
    const nature = nc ? nc.nature : null;
    const chain = nc ? nc.chain : null;
    const { flag, reason } = untrustedFor(component);
    const enforcedFramework = opts?.enforcedFrameworkFor?.(component);
    const ie = LLM_ROUTING_INJECTION_EXPOSURE[component];
    return {
      component,
      category: categoryForComponent(component),
      nature,
      chain,
      criticalGate: NATURE_ROUTING_CRITICAL_GATES.has(component),
      untrustedInput: flag,
      ...(reason ? { untrustedInputReason: reason } : {}),
      ...(ie
        ? {
            injectionExposure: {
              exposed: ie.exposed,
              channels: {
                user: ie.inputShape.userContent,
                model: ie.inputShape.modelContent,
                tool: ie.inputShape.toolContent,
              },
              ...(ie.reason ? { reason: ie.reason } : {}),
            },
          }
        : {}),
      ...(enforcedFramework ? { enforcedFramework } : {}),
      route: chain ? chainPositions[chain] : [],
    };
  });

  return {
    doors: {
      cli: [...CLI_ROUTING_DOORS],
      metered: [...METERED_ROUTING_DOORS],
    },
    chains,
    components,
    injectionExposureSource: 'FD5b-exposure-map',
    note:
      'Read-only routing MAP: for each internal job-kind, its nature/chain and the ordered ' +
      'fallback door+model list. Describes the shipped nature-routing chains — it does NOT ' +
      'reflect live actuation (nature routing is dev-gated/dryRun) and changes no behavior. ' +
      'Metered (paid-API) doors are skipped in Increment A. Spend/PIN controls are out of scope.',
  };
}

/** Look up a single component's routing entry (for the `?trace=<component>` drill-down). */
export function traceComponent(
  component: string,
  opts?: { enforcedFrameworkFor?: (component: string) => string | undefined },
): RoutingMapComponent | undefined {
  return buildNatureRoutingMap(opts).components.find((c) => c.component === component);
}
