/** @typedef {import("./types.d.ts").CapturedStep} CapturedStep */

/**
 * Incremental SSE frame parser. Lifted in shape from scripts/eval-classifier.mjs classifyOne.
 * @param {(evt: any) => void} onEvent
 */
export function createSseParser(onEvent) {
  let buffer = "";
  let done = false;
  return {
    push(text) {
      buffer += text;
      let i = buffer.indexOf("\n\n");
      while (i !== -1) {
        const frame = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        for (const line of frame.split("\n")) {
          if (!line.startsWith("data:")) continue; // ignore ": keepalive" comments
          const data = line.slice(5).trim();
          if (!data) continue;
          if (data === "[DONE]") {
            done = true;
            onEvent({ type: "done" });
            continue;
          }
          try {
            onEvent(JSON.parse(data));
          } catch {
            /* non-JSON data line — skip */
          }
        }
        i = buffer.indexOf("\n\n");
      }
    },
    isDone() {
      return done;
    },
  };
}

/**
 * Drive one turn over the streaming endpoint. Calls onStep synchronously for each
 * ProcessingStep so the caller can drive the approval gate while the stream stays open.
 * Aborts after `timeoutMs` (if given) and returns what was captured with `timedOut: true` —
 * e.g. when a real agent suspends at the approval gate and never sends `[DONE]`.
 * @returns {Promise<{steps: CapturedStep[], assistantText: string, error: string|null, done: boolean, timedOut: boolean}>}
 */
export async function streamTurn({ server, agentId, roomId, text, userInfoCookie, messageClassification, authToken, signal, onStep, fetchImpl, timeoutMs }) {
  const doFetch = fetchImpl ?? fetch;
  const url = `${String(server).replace(/\/$/, "")}/${agentId}/message/stream`;
  const body = JSON.stringify({
    text,
    roomId,
    userName: "AgentSim",
    name: "AgentSim",
    ...(messageClassification ? { messageClassification } : {}),
  });
  // The SSE endpoint resolves authenticated identity ONLY from a verified RS256 Bearer JWT
  // (verifyBearerJwt in client-direct/auth) — the user_info cookie does not authenticate.
  // Without the Bearer header an anonymous user is force-rerouted to REGULAR (runtime.ts),
  // so the CEX workflow / approval gate never fires.
  const headers = { "Content-Type": "application/json", Cookie: userInfoCookie };
  if (authToken) headers.Authorization = `Bearer ${authToken}`;
  /** @type {CapturedStep[]} */
  const steps = [];
  let assistantText = "";
  // A turn's final text arrives BOTH as streamed `token` deltas AND as one or more
  // `intermediate_response`/`action_response` events carrying the COMPLETE memory text (the same
  // content the persisted memory / a real client renders once). Blindly appending all of them
  // triple-counted the response in the captured transcript (verified: agent persists the plan once,
  // the old capture had it 3×), which then made the judge penalize phantom "repeated 3×" output.
  // Dedup: collapse identical response texts, and let a fuller response REPLACE the streamed prefix.
  const seenResponses = new Set();
  let error = null;
  let timedOut = false;
  // The server rebirths an unknown/deleted room under a NEW id and announces it via
  // {type:"room_created"} — the SPA adopts the new id for subsequent turns; so must callers of
  // streamTurn (return it), or every turn lands in its own isolated room.
  let effectiveRoomId = roomId;
  const controller = new AbortController();
  if (signal) signal.addEventListener("abort", () => controller.abort(), { once: true });
  const timer = timeoutMs ? setTimeout(() => controller.abort(), timeoutMs) : null;
  const parser = createSseParser((evt) => {
    if (evt.type === "step" && evt.step) {
      steps.push(evt.step);
      onStep?.(evt.step);
    } else if (evt.type === "token" && typeof evt.text === "string") {
      assistantText += evt.text;
    } else if ((evt.type === "intermediate_response" || evt.type === "action_response") && evt.response) {
      const t = String(evt.response.text ?? evt.response.content?.text ?? "").trim();
      if (t && !seenResponses.has(t)) {
        seenResponses.add(t);
        const cur = assistantText.trim();
        if (!cur || t.includes(cur)) {
          assistantText = t; // authoritative full text supersedes the streamed prefix (token deltas)
        } else if (!cur.includes(t)) {
          assistantText += `\n${t}`; // a genuinely distinct response (e.g. a multi-action turn) — append
        }
        // else: t already contained in what we have → skip (duplicate emission)
      }
    } else if (evt.type === "room_created" && evt.roomId) {
      effectiveRoomId = String(evt.roomId);
    } else if (evt.type === "error") {
      error = typeof evt.error === "string" ? evt.error : evt.error?.message ?? "stream error";
    }
  });
  try {
    const res = await doFetch(url, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });
    if (!res.ok || !res.body) {
      return { steps, assistantText, error: `HTTP ${res.status}`, done: false, timedOut, roomId: effectiveRoomId };
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    while (!parser.isDone()) {
      const { value, done } = await reader.read();
      if (done) break;
      parser.push(decoder.decode(value, { stream: true }));
    }
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
  } catch (err) {
    if (controller.signal.aborted) timedOut = true;
    else throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
  return { steps, assistantText, error, done: parser.isDone(), timedOut, roomId: effectiveRoomId };
}
