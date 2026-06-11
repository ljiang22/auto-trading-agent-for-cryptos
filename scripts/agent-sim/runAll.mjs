import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { runScenario } from "./runScenario.mjs";
import { streamTurn } from "./sseClient.mjs";
import * as approvalDriver from "./approvalDriver.mjs";
import { applyEnvironment } from "./environment.mjs";
import { createSimulatedUser } from "./simulatedUser.mjs";
import { judgeTranscript } from "./judge.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const SCENARIO_DIR = join(REPO_ROOT, "tests", "scenarios");

export function parseArgs(argv) {
  const m = new Map();
  for (let i = 2; i < argv.length; i += 1) {
    const tok = argv[i];
    if (!tok.startsWith("--")) continue;
    const [k, inline] = tok.slice(2).split("=", 2);
    if (inline !== undefined) m.set(k, inline);
    else if (argv[i + 1] && !argv[i + 1].startsWith("--")) {
      i += 1;
      m.set(k, argv[i]);
    } else m.set(k, true);
  }
  return {
    server: typeof m.get("server") === "string" ? m.get("server") : "http://127.0.0.1:3000",
    userEmail: typeof m.get("user-email") === "string" ? m.get("user-email") : null,
    agent: typeof m.get("agent") === "string" ? m.get("agent") : null,
    agentName: typeof m.get("agent-name") === "string" ? m.get("agent-name") : null,
    simMode: Boolean(m.get("sim-mode")),
    out: typeof m.get("out") === "string" ? m.get("out") : join(SCENARIO_DIR, "sim_results.json"),
  };
}

export function summarize(results) {
  const safetyFailures = results.filter((r) => !r.safety.pass);
  const table = results
    .map((r) => `  ${r.scenarioId}/${r.variant}: safety=${r.safety.pass ? "PASS" : "FAIL"} judge=${r.judgeScore ?? "n/a"}`)
    .join("\n");
  return { exitCode: safetyFailures.length ? 1 : 0, table, safetyFailures };
}

async function resolveAgentId(server, args) {
  if (args.agent) return args.agent;
  const res = await fetch(`${String(server).replace(/\/$/, "")}/agents`);
  const data = await res.json();
  const list = data.agents ?? data;
  if (args.agentName) return list.find((a) => a.name === args.agentName)?.id ?? list[0]?.id;
  return list[0]?.id;
}

function loadScenarios() {
  return readdirSync(SCENARIO_DIR)
    .filter((f) => /^scenario_\d+\.json$/.test(f))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(SCENARIO_DIR, f), "utf8")));
}

export async function main(argv = process.argv) {
  const args = parseArgs(argv);
  if (!args.userEmail) {
    console.error("Missing --user-email (paper-trading test user).");
    process.exit(2);
  }
  const agentId = await resolveAgentId(args.server, args);
  if (!agentId) {
    console.error(`No agent found at ${args.server}/agents`);
    process.exit(2);
  }
  const deps = { streamTurn, approvalDriver, applyEnvironment, createSimulatedUser, judgeTranscript };
  const scenarios = loadScenarios();
  const results = [];
  for (const scenario of scenarios) {
    for (const ec of scenario.environmentContext) {
      console.log(`▶ ${scenario.id} / ${ec.variant}`);
      results.push(await runScenario(scenario, ec.variant, { server: args.server, agentId, userEmail: args.userEmail, deps }));
    }
  }
  if (!existsSync(SCENARIO_DIR)) throw new Error(`missing ${SCENARIO_DIR}`);
  writeFileSync(args.out, JSON.stringify(results, null, 2));
  const sum = summarize(results);
  console.log(`\n=== sim summary ===\n${sum.table}`);
  console.log(`\nWrote ${args.out}`);
  if (sum.exitCode) console.error(`\n✖ ${sum.safetyFailures.length} safety failure(s) — failing the run.`);
  process.exit(sum.exitCode);
}

// run when invoked directly (not when imported by tests)
if (process.argv[1]?.endsWith("runAll.mjs")) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.stack : err);
    process.exit(1);
  });
}
