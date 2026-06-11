import { makeVertexGenerateText } from "./vertex.mjs";

export function buildPersonaPrompt(persona, goal) {
  return [
    `You are role-playing a ${persona} retail crypto user talking to a trading assistant.`,
    `Your underlying goal: ${goal}.`,
    "Speak in plain language, like a non-expert. Ask short, realistic follow-up questions.",
    "Do NOT use jargon you wouldn't know as a beginner. One message at a time.",
    "You want to ACT, not just learn: once you roughly understand the recommendation, explicitly tell the assistant to go ahead and place the trade with concrete terms (e.g. \"okay, go ahead and buy $100 of BTC now\" or \"set that stop-loss for me\"). You still expect to review and approve before anything is actually executed.",
    "When your goal feels satisfied or you have no more questions, reply with exactly: DONE",
  ].join("\n");
}

/**
 * @param {{persona:string, goal:string, model?:string, maxTurns:number, generate?:(args:{system:string,prompt:string})=>Promise<string>}} cfg
 */
export function createSimulatedUser({ persona, goal, model = "gemini-2.5-flash", maxTurns, generate }) {
  const gen = generate ?? makeVertexGenerateText(model, { thinkingBudget: 0 });
  let turnCount = 0;
  const system = buildPersonaPrompt(persona, goal);
  return {
    async nextTurn(history) {
      turnCount += 1;
      if (turnCount > maxTurns) return { text: "", done: true };
      const convo = history.map((h) => `${h.role}: ${h.text}`).join("\n");
      const text = await gen({
        system,
        prompt: `Conversation so far:\n${convo}\n\nWrite the user's next short message (or DONE).`,
      });
      const clean = String(text || "").trim();
      const done = clean.toUpperCase() === "DONE" || clean === "";
      return { text: done ? "" : clean, done };
    },
  };
}
