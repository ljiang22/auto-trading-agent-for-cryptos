import {
  type Action, type HandlerCallback, type IAgentRuntime,
  ServiceType,
} from "@elizaos/core";
import { recoverCompiledStrategy } from "../strategy/engine/compiledStrategyMemory";
import { compileNlToDsl } from "../strategy/nlToDSL";
import type { StrategyDSL } from "../strategy/strategyDSL";
import type { StrategyInstance } from "../strategy/engine/strategyInstance";

interface EngineLike {
  armStrategy(userId: string, dsl: StrategyDSL): Promise<StrategyInstance>;
  setStatus(userId: string, instanceId: string, status: "paused" | "armed" | "stopped"): Promise<StrategyInstance | null>;
  listForUser(userId: string): Promise<StrategyInstance[]>;
}

function getEngine(runtime: IAgentRuntime): EngineLike | undefined {
  return runtime.getService(ServiceType.STRATEGY_ENGINE) as unknown as EngineLike | undefined;
}

export function renderStrategyTable(instances: StrategyInstance[]): string {
  if (instances.length === 0) return "_No strategies. Compile one with `compile_strategy`, then `arm_strategy`._";
  const rows = instances.map((i) => {
    const sym = i.dsl?.universe?.symbols?.[0] ?? "?";
    const pos = `${i.position.base_qty}@${i.position.avg_entry_price}`;
    return `| \`${i.instance_id}\` | ${i.status} | ${sym} | ${pos} | ${i.position.realized_pnl_usd.toFixed(2)} | ${i.last_fill_at ?? "—"} | ${i.next_eval_at} |`;
  });
  return [
    "**[PAPER MODE — no real money]** Your strategies:",
    "| ID | Status | Symbol | Position | Realized PnL | Last Fill | Next Eval |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}

export const armStrategyAction: Action = {
  name: "arm_strategy",
  description:
    "**ARM A STRATEGY (paper auto-execution)** — Use when the user wants to start/arm/run a compiled trading strategy for automatic paper execution. Trigger: 'arm this strategy', 'start the strategy', 'arm it', 'run my DCA'. Recovers the last compiled strategy. Paper-only; live is downgraded. Requires the one-time approval.",
  examples: [
    [{ user: "{{user1}}", content: { text: "arm this strategy" } }, { user: "{{user2}}", content: { text: "Arming for paper auto-execution", action: "arm_strategy" } }],
    [{ user: "{{user1}}", content: { text: "start my DCA strategy" } }, { user: "{{user2}}", content: { text: "Arming", action: "arm_strategy" } }],
  ],
  handler: async (runtime, memory, _state, options, callback?: HandlerCallback) => {
    const engine = getEngine(runtime);
    if (!engine) {
      await callback?.({ text: "The strategy engine is not enabled on this agent.", action: "arm_strategy" });
      return { success: false };
    }
    const opts = (options ?? {}) as Record<string, unknown>;
    let dsl = (opts.compiledStrategy as StrategyDSL | undefined) ?? null;
    // Primary recovery: user-scoped runtime cache written by compile_strategy
    // (room-independent — survives the SSE room-remap between compile and arm).
    if (!dsl) {
      try {
        const cached = await runtime.cacheManager?.get?.(`last_compiled_strategy:${String(memory.userId)}`);
        if (typeof cached === "string") dsl = JSON.parse(cached) as StrategyDSL;
        else if (cached && typeof cached === "object") dsl = cached as StrategyDSL;
      } catch { /* fall through to other channels */ }
    }
    // Secondary: room-scoped memory (works when compile + arm share a room).
    if (!dsl) {
      const mems = await runtime.messageManager.getMemories({ roomId: memory.roomId, count: 50, tableName: "messages", agentId: runtime.agentId });
      dsl = recoverCompiledStrategy(mems);
    }
    // Fresh-compile fallback: prefer an explicit strategy NL passed by the
    // decomposer (parameters.description / naturalLanguage), else the message text.
    if (!dsl) {
      const nl =
        typeof opts.description === "string" ? opts.description
        : typeof opts.naturalLanguage === "string" ? opts.naturalLanguage
        : typeof memory.content?.text === "string" ? memory.content.text
        : "";
      if (nl && /dca|rsi|strategy|buy the dip|take profit|stop loss|dip/i.test(nl)) {
        const compiled = compileNlToDsl(nl, { locale: "en", owner: String(memory.userId), venue: "paper" });
        if (compiled.ok) dsl = compiled.strategy;
      }
    }
    if (!dsl) {
      await callback?.({ text: "I couldn't find a compiled strategy. Please `compile_strategy` first, then arm it.", action: "arm_strategy" });
      return { success: false };
    }
    const wasLive = dsl.identity.mode === "live" || dsl.identity.status === "live";
    const inst = await engine.armStrategy(String(memory.userId), dsl);
    const note = wasLive ? " (downgraded from live to **paper** — live auto-execution is not permitted)" : "";
    await callback?.({
      text: `**[PAPER MODE — no real money]** Armed strategy \`${inst.instance_id}\`${note}. It will evaluate every ${dsl.operations.evaluation_interval_seconds}s.`,
      action: "arm_strategy",
      metadata: { success: true, instance_id: inst.instance_id, mode: "paper" },
    });
    return { success: true, instance_id: inst.instance_id };
  },
};

function lifecycleAction(name: "pause_strategy" | "resume_strategy" | "stop_strategy", status: "paused" | "armed" | "stopped", verb: string): Action {
  return {
    name,
    description: `**${verb.toUpperCase()} A STRATEGY** — Use when the user wants to ${verb} a running strategy ('${verb} my strategy', '${verb} it'). Affects paper auto-execution only.`,
    examples: [[{ user: "{{user1}}", content: { text: `${verb} my strategy` } }, { user: "{{user2}}", content: { text: `${verb}ing`, action: name } }]],
    handler: async (runtime, memory, _state, options, callback?: HandlerCallback) => {
      const engine = getEngine(runtime);
      if (!engine) { await callback?.({ text: "The strategy engine is not enabled.", action: name }); return { success: false }; }
      const userId = String(memory.userId);
      const opts = (options ?? {}) as Record<string, unknown>;
      let instanceId = typeof opts.instance_id === "string" ? opts.instance_id : null;
      if (!instanceId) {
        const list = await engine.listForUser(userId);
        const candidates = list.filter((i) => i.status === "armed" || i.status === "paused");
        if (candidates.length === 1) instanceId = candidates[0].instance_id;
        else if (candidates.length === 0) { await callback?.({ text: "You have no active strategies.", action: name }); return { success: false }; }
        else { await callback?.({ text: `You have ${candidates.length} active strategies; specify which by ID. Use \`list_strategies\`.`, action: name }); return { success: false }; }
      }
      const updated = await engine.setStatus(userId, instanceId, status);
      if (!updated) { await callback?.({ text: `No strategy \`${instanceId}\` found for you.`, action: name }); return { success: false }; }
      await callback?.({ text: `**[PAPER MODE — no real money]** Strategy \`${updated.instance_id}\` is now **${updated.status}**.`, action: name, metadata: { success: true, status: updated.status } });
      return { success: true, status: updated.status };
    },
  };
}

export const pauseStrategyAction = lifecycleAction("pause_strategy", "paused", "pause");
export const resumeStrategyAction = lifecycleAction("resume_strategy", "armed", "resume");
export const stopStrategyAction = lifecycleAction("stop_strategy", "stopped", "stop");

export const listStrategiesAction: Action = {
  name: "list_strategies",
  description: "**LIST STRATEGIES (read)** — Use when the user wants to see their running/armed strategies and status ('show my strategies', 'list strategies', 'what's running'). Read-only.",
  examples: [[{ user: "{{user1}}", content: { text: "show my running strategies" } }, { user: "{{user2}}", content: { text: "Listing", action: "list_strategies" } }]],
  handler: async (runtime, memory, _state, _options, callback?: HandlerCallback) => {
    const engine = getEngine(runtime);
    if (!engine) { await callback?.({ text: "The strategy engine is not enabled.", action: "list_strategies" }); return { success: false }; }
    const list = await engine.listForUser(String(memory.userId));
    await callback?.({ text: renderStrategyTable(list), action: "list_strategies", metadata: { success: true, count: list.length } });
    return { success: true, count: list.length };
  },
};
