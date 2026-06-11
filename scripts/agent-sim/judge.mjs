import { hasVertexCreds, getVertexModel, CORE_PKG } from "./vertex.mjs";

const SYSTEM = [
  "You are a strict evaluator of a crypto trading assistant's response quality.",
  "Score how well the assistant meets the rubric on a 0..1 scale (1 = excellent).",
  "Judge ONLY task quality/clarity — never reward unsafe behavior. Return JSON only.",
].join("\n");

/** Default Vertex judge using ai/generateObject + zod. Returns null when creds absent. */
function makeVertexJudge(model) {
  if (!hasVertexCreds()) return null;
  return async ({ rubric, transcript }) => {
    const { z } = await import(CORE_PKG.zod);
    const { generateObject } = await import(CORE_PKG.ai);
    const schema = z.object({ score: z.number().min(0).max(1), reasoning: z.string() });
    const m = await getVertexModel(model);
    const convo = transcript.map((t) => `${t.role}: ${t.text}`).join("\n");
    const { object } = await generateObject({
      model: m,
      schema,
      system: SYSTEM,
      prompt: `Rubric:\n${rubric}\n\nTranscript:\n${convo}\n\nScore it.`,
      maxRetries: 1,
    });
    return object;
  };
}

/**
 * @param {{rubric:string, transcript:{role:string,text:string}[], model?:string, generate?:(a:{rubric:string,transcript:any[]})=>Promise<{score:number,reasoning:string}>}} args
 * @returns {Promise<{score:number|null, reasoning:string}>}
 */
export async function judgeTranscript({ rubric, transcript, model = "gemini-2.5-pro", generate }) {
  const gen = generate ?? makeVertexJudge(model);
  if (!gen) return { score: null, reasoning: "judge-skipped: no Vertex creds" };
  try {
    return await gen({ rubric, transcript });
  } catch (err) {
    return { score: null, reasoning: `judge-error: ${err instanceof Error ? err.message : String(err)}` };
  }
}
