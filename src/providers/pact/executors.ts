import type { ProviderExecutors } from "../../core/types.ts";

/**
 * PACT has no local executors: action dispatch is handled by PactService
 * inside ActionRunner (spec §4.4). The empty map keeps the provider
 * catalog-only while satisfying the generated executor-registry contract.
 */
export const executors: ProviderExecutors = {};
