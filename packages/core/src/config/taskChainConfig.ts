import type { ChainOrchestratorConfig } from "../core/types.ts";

/**
 * Task Chain Configuration
 * This is the single source of truth for task chain execution settings
 */
export const TASK_CHAIN_CONFIG = {
    /**
     * Chain Orchestrator Settings
     */
    orchestrator: {
        /** Enable parallel execution of independent tasks */
        enableParallelExecution: true,

        /** Maximum time (ms) a single task can run before timing out */
        taskTimeoutMs: 300000, // 5 minutes

        /** Enable task chain supervision after each level execution */
        runSupervisorAfterLevel: true,

        /** Maximum number of times the supervisor may modify the chain (prevents infinite loops) */
        maxSupervisorModifications: 3,
    } as ChainOrchestratorConfig & { runSupervisorAfterLevel?: boolean; maxSupervisorModifications?: number }
} as const;

/**
 * Get orchestrator configuration with optional overrides
 */
export function getOrchestratorConfig(
    overrides?: Partial<ChainOrchestratorConfig & { runSupervisorAfterLevel?: boolean; maxSupervisorModifications?: number }>
): ChainOrchestratorConfig & { runSupervisorAfterLevel?: boolean; maxSupervisorModifications?: number } {
    return {
        ...TASK_CHAIN_CONFIG.orchestrator,
        ...overrides,
    };
}
