import test from "node:test";
import assert from "node:assert/strict";
import { createSseParser, streamTurn } from "./sseClient.mjs";

function collect(chunks) {
  const events = [];
  const parser = createSseParser((e) => events.push(e));
  for (const c of chunks) parser.push(c);
  return { events, done: parser.isDone() };
}

test("parses a step event in one chunk", () => {
  const { events } = collect(['data: {"type":"step","step":{"name":"Trading: risk check","status":"in_progress"}}\n\n']);
  assert.equal(events.length, 1);
  assert.equal(events[0].step.name, "Trading: risk check");
});

test("handles frame split across chunks", () => {
  const { events } = collect(['data: {"type":"to', 'ken","text":"hi"}\n\n']);
  assert.equal(events.length, 1);
  assert.equal(events[0].text, "hi");
});

test("ignores keepalive comment lines", () => {
  const { events } = collect([": keepalive\n\n", 'data: {"type":"token","text":"x"}\n\n']);
  assert.equal(events.length, 1);
});

test("[DONE] sets done and emits a done event", () => {
  const { events, done } = collect(["data: [DONE]\n\n"]);
  assert.equal(done, true);
  assert.equal(events[0].type, "done");
});

test("multiple data lines in one frame", () => {
  const { events } = collect(['data: {"type":"token","text":"a"}\ndata: {"type":"token","text":"b"}\n\n']);
  assert.equal(events.length, 2);
});

test("malformed JSON is skipped, not thrown", () => {
  const { events } = collect(["data: {not json}\n\n", 'data: {"type":"error","error":"boom"}\n\n']);
  assert.equal(events.length, 1);
  assert.equal(events[0].type, "error");
});

test("streamTurn sends Authorization Bearer + messageClassification when provided", async () => {
  let captured = null;
  const fakeFetch = async (url, init) => {
    captured = { url, init };
    return new Response("data: [DONE]\n\n", { status: 200, headers: { "Content-Type": "text/event-stream" } });
  };
  await streamTurn({
    server: "http://x",
    agentId: "a1",
    roomId: "r1",
    text: "buy btc",
    userInfoCookie: "user_info=abc",
    messageClassification: "CEX_WORKFLOW_MESSAGE",
    authToken: "tok123",
    fetchImpl: fakeFetch,
  });
  assert.equal(captured.url, "http://x/a1/message/stream");
  assert.equal(captured.init.headers.Authorization, "Bearer tok123");
  assert.equal(captured.init.headers.Cookie, "user_info=abc");
  const body = JSON.parse(captured.init.body);
  assert.equal(body.messageClassification, "CEX_WORKFLOW_MESSAGE");
  assert.equal(body.roomId, "r1");
});

test("streamTurn DEDUPES the final response (token + intermediate + action carry the same text) — captured ONCE", async () => {
  // Regression: the agent emits a turn's final text as streamed `token` deltas AND as
  // intermediate_response + action_response events (all the same content the persisted memory has
  // once). The old accumulator appended all three → the captured transcript had the plan 3× and the
  // judge penalized phantom repetition. Verified against the agent's stored memory (plan appears once).
  const full = "**Plan**: DCA BTC\n## Key Findings\n- plan emitted";
  const sse =
    `data: {"type":"token","text":"**Plan**: DCA BTC"}\n\n` +
    `data: ${JSON.stringify({ type: "intermediate_response", response: { text: full } })}\n\n` +
    `data: ${JSON.stringify({ type: "action_response", response: { text: full } })}\n\n` +
    "data: [DONE]\n\n";
  const fakeFetch = async () => new Response(sse, { status: 200 });
  const res = await streamTurn({ server: "http://x", agentId: "a1", roomId: "r1", text: "plan", userInfoCookie: "c", fetchImpl: fakeFetch });
  assert.equal(res.assistantText, full); // exactly one copy
  assert.equal((res.assistantText.match(/\*\*Plan\*\*/g) || []).length, 1);
});

test("streamTurn still CONCATENATES genuinely distinct response texts (multi-action turn)", async () => {
  const sse =
    `data: ${JSON.stringify({ type: "intermediate_response", response: { text: "Action A result" } })}\n\n` +
    `data: ${JSON.stringify({ type: "action_response", response: { text: "Final summary B" } })}\n\n` +
    "data: [DONE]\n\n";
  const fakeFetch = async () => new Response(sse, { status: 200 });
  const res = await streamTurn({ server: "http://x", agentId: "a1", roomId: "r1", text: "go", userInfoCookie: "c", fetchImpl: fakeFetch });
  assert.match(res.assistantText, /Action A result/);
  assert.match(res.assistantText, /Final summary B/);
});

test("streamTurn surfaces a room_created remap (server rebirths an unknown room under a NEW id)", async () => {
  // Protocol: when the posted roomId doesn't exist server-side, client-direct creates a NEW room,
  // emits {type:"room_created", roomId:<new>} and persists the turn THERE. The real SPA adopts the
  // new id for subsequent turns; the harness must too, or every turn lands in its own isolated room
  // (no recentMessages, no plan continuations — the bypass can never fire).
  const sse =
    `data: ${JSON.stringify({ type: "room_created", roomId: "room-new-42", roomName: "Chat" })}\n\n` +
    `data: {"type":"token","text":"hi"}\n\n` +
    "data: [DONE]\n\n";
  const fakeFetch = async () => new Response(sse, { status: 200 });
  const res = await streamTurn({ server: "http://x", agentId: "a1", roomId: "r1", text: "hello", userInfoCookie: "c", fetchImpl: fakeFetch });
  assert.equal(res.roomId, "room-new-42");
});

test("streamTurn returns the posted roomId when no remap happens", async () => {
  const fakeFetch = async () => new Response("data: [DONE]\n\n", { status: 200 });
  const res = await streamTurn({ server: "http://x", agentId: "a1", roomId: "r1", text: "hi", userInfoCookie: "c", fetchImpl: fakeFetch });
  assert.equal(res.roomId, "r1");
});

test("streamTurn omits Authorization header when no authToken", async () => {
  let captured = null;
  const fakeFetch = async (url, init) => {
    captured = { url, init };
    return new Response("data: [DONE]\n\n", { status: 200 });
  };
  await streamTurn({ server: "http://x", agentId: "a1", roomId: "r1", text: "hi", userInfoCookie: "user_info=abc", fetchImpl: fakeFetch });
  assert.equal("Authorization" in captured.init.headers, false);
});
