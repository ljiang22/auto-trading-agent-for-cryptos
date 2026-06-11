/**
 * Authenticated HTTP client for the Eliza agent API.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { buildAuthHeaders, fetchJson, normalizeBaseUrl } from "./http.mjs";
import { postStream } from "./sse.mjs";
import {
    createTranscriptState,
    ingestEvent,
    recordClientCall,
} from "./transcript.mjs";
import { createCombinedHookHandler } from "./hooks.mjs";

/**
 * @typedef {import("./auth.mjs").AuthSession} AuthSession
 */

export class AgentClient {
    /**
     * @param {{ agentBaseUrl: string, session: AuthSession, agentId: string }} config
     */
    constructor(config) {
        this.agentBaseUrl = normalizeBaseUrl(config.agentBaseUrl);
        this.session = config.session;
        this.agentId = config.agentId;
        /** @type {import("./transcript.mjs").TranscriptState | null} */
        this._latencyTranscript = null;
    }

    authHeaders(extra = {}) {
        return buildAuthHeaders(this.session, {
            Accept: "application/json",
            ...extra,
        });
    }

    async getMe() {
        return fetchJson(`${this.agentBaseUrl}/authentication/me/`, {
            method: "GET",
            headers: this.authHeaders(),
        });
    }

    async listAgents() {
        const data = await fetchJson(`${this.agentBaseUrl}/agents`, {
            method: "GET",
            headers: this.authHeaders(),
        });
        return Array.isArray(data?.agents) ? data.agents : [];
    }

    /**
     * @param {string} name
     */
    async createRoom(name) {
        const data = await fetchJson(
            `${this.agentBaseUrl}/agents/${this.agentId}/rooms`,
            {
                method: "POST",
                headers: this.authHeaders({ "Content-Type": "application/json" }),
                body: JSON.stringify({ name }),
            },
        );
        if (!data?.room?.id) {
            throw new Error(`Failed to create room "${name}"`);
        }
        return data.room.id;
    }

    /**
     * Optional direct HTTP call using the same session.
     * @param {{ method?: string, path: string, body?: unknown }} req
     */
    async request(req) {
        const method = req.method || "GET";
        const url = `${this.agentBaseUrl}${req.path.startsWith("/") ? "" : "/"}${req.path}`;
        const init = {
            method,
            headers: this.authHeaders(
                req.body != null ? { "Content-Type": "application/json" } : {},
            ),
        };
        if (req.body != null && method !== "GET") {
            init.body = JSON.stringify(req.body);
        }
        return fetchJson(url, init);
    }

    /**
     * @param {string} roomId
     * @param {Record<string, unknown>} messagePayload
     * @param {{ hooks?: string[], approvalTemplates?: Record<string, unknown> | null, caseDef?: Record<string, unknown>, timeoutMs?: number }} [options]
     */
    async sendMessage(roomId, messagePayload, options = {}) {
        const transcript = createTranscriptState();
        await this._streamMessage(roomId, messagePayload, options, transcript);
        return transcript;
    }

    /**
     * Plan continuation turn ("yes" / "approve all remaining steps").
     * @param {string} roomId
     * @param {string} text
     * @param {{ hooks?: string[], approvalTemplates?: Record<string, unknown> | null, caseDef?: Record<string, unknown>, timeoutMs?: number }} [options]
     */
    async sendContinuation(roomId, text, options = {}) {
        const transcript = createTranscriptState();
        await this._streamMessage(
            roomId,
            { text, userName: "AgentTestHarness", name: "AgentTestHarness" },
            options,
            transcript,
        );
        return transcript;
    }

    /**
     * @param {string} roomId
     */
    async getActiveWorkflow(roomId) {
        return fetchJson(
            `${this.agentBaseUrl}/agents/${this.agentId}/${roomId}/active-workflow`,
            {
                method: "GET",
                headers: this.authHeaders(),
            },
        );
    }

    /**
     * @param {string} roomId
     * @param {Record<string, unknown>} body
     */
    async postHumanInputApproval(roomId, body) {
        const transcript = this._latencyTranscript;
        const started = Date.now();
        const offsetMs = transcript ? started - transcript.startedAt : 0;
        try {
            const result = await fetchJson(
                `${this.agentBaseUrl}/agents/${this.agentId}/human-input/approval`,
                {
                    method: "POST",
                    headers: this.authHeaders({ "Content-Type": "application/json" }),
                    body: JSON.stringify(body),
                },
            );
            if (transcript) {
                recordClientCall(transcript, {
                    kind: "human_input_approval",
                    confirmationLevel: body?.confirmationLevel,
                    offsetMs,
                    durationMs: Date.now() - started,
                    ok: true,
                });
                transcript.markers.humanInputResolved = true;
            }
            return result;
        } catch (err) {
            if (transcript) {
                recordClientCall(transcript, {
                    kind: "human_input_approval",
                    confirmationLevel: body?.confirmationLevel,
                    offsetMs,
                    durationMs: Date.now() - started,
                    ok: false,
                });
            }
            throw err;
        }
    }

    /**
     * @param {string} roomId
     * @param {Record<string, unknown>} messagePayload
     * @param {{ hooks?: string[], approvalTemplates?: Record<string, unknown> | null, caseDef?: Record<string, unknown>, timeoutMs?: number }} options
     * @param {import("./transcript.mjs").TranscriptState} transcript
     */
    async _streamMessage(roomId, messagePayload, options, transcript) {
        this._latencyTranscript = transcript;
        const onEvent = createCombinedHookHandler(options.hooks || [], {
            client: this,
            roomId,
            approvalTemplates: options.approvalTemplates ?? null,
            caseDef: options.caseDef || {},
            transcript,
        });

        const url = `${this.agentBaseUrl}/${this.agentId}/message/stream`;
        const timeoutMs =
            options.timeoutMs ?? options.caseDef?.expect?.maxDurationMs ?? null;
        const signal =
            typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
                ? AbortSignal.timeout(timeoutMs)
                : undefined;

        try {
            await postStream(
                url,
                {
                    roomId,
                    userName: messagePayload.userName || "AgentTestHarness",
                    name: messagePayload.name || "AgentTestHarness",
                    ...messagePayload,
                },
                this.authHeaders(),
                async (event) => {
                    ingestEvent(event, transcript);
                    await onEvent(event);
                },
                { signal },
            );
        } catch (err) {
            if (
                signal &&
                (err?.name === "TimeoutError" || err?.name === "AbortError")
            ) {
                transcript.errorMessage = `stream timeout after ${timeoutMs}ms`;
                return transcript;
            }
            throw err;
        } finally {
            this._latencyTranscript = null;
        }

        return transcript;
    }

    /**
     * @param {string} roomId
     * @param {Record<string, unknown>} body
     */
    async postCexApproval(roomId, body) {
        const transcript = this._latencyTranscript;
        const started = Date.now();
        const offsetMs = transcript ? started - transcript.startedAt : 0;
        try {
            const result = await fetchJson(
                `${this.agentBaseUrl}/agents/${this.agentId}/cex-workflow/approval`,
                {
                    method: "POST",
                    headers: this.authHeaders({ "Content-Type": "application/json" }),
                    body: JSON.stringify({
                        threadId: roomId,
                        ...body,
                    }),
                },
            );
            if (transcript) {
                recordClientCall(transcript, {
                    kind: "cex_approval",
                    confirmationLevel: body?.confirmationLevel,
                    offsetMs,
                    durationMs: Date.now() - started,
                    ok: true,
                });
            }
            return result;
        } catch (err) {
            if (transcript) {
                recordClientCall(transcript, {
                    kind: "cex_approval",
                    confirmationLevel: body?.confirmationLevel,
                    offsetMs,
                    durationMs: Date.now() - started,
                    ok: false,
                });
            }
            throw err;
        }
    }

    /**
     * @param {string} roomId
     * @param {Record<string, unknown>} body
     */
    async postTaskChainApproval(roomId, body) {
        const transcript = this._latencyTranscript;
        const started = Date.now();
        const offsetMs = transcript ? started - transcript.startedAt : 0;
        try {
            const result = await fetchJson(
                `${this.agentBaseUrl}/agents/${this.agentId}/task-chain/approval`,
                {
                    method: "POST",
                    headers: this.authHeaders({ "Content-Type": "application/json" }),
                    body: JSON.stringify({
                        threadId: roomId,
                        ...body,
                    }),
                },
            );
            if (transcript) {
                recordClientCall(transcript, {
                    kind: "task_chain_approval",
                    offsetMs,
                    durationMs: Date.now() - started,
                    ok: true,
                });
            }
            return result;
        } catch (err) {
            if (transcript) {
                recordClientCall(transcript, {
                    kind: "task_chain_approval",
                    offsetMs,
                    durationMs: Date.now() - started,
                    ok: false,
                });
            }
            throw err;
        }
    }
}

/**
 * Collapse whitespace for alias matching (e.g. "CryptoTrader" ↔ "Crypto Trader").
 * @param {string} name
 */
function normalizeAgentNameForLookup(name) {
    return String(name).toLowerCase().replace(/\s+/g, "");
}

/**
 * @param {Array<{ id?: string, name?: string }>} agents
 * @param {string} agentName
 */
function findAgentByName(agents, agentName) {
    const exact = agents.find(
        (a) => String(a.name).toLowerCase() === agentName.toLowerCase(),
    );
    if (exact) {
        return exact;
    }
    const normalized = normalizeAgentNameForLookup(agentName);
    return agents.find(
        (a) => normalizeAgentNameForLookup(a.name) === normalized,
    );
}

/**
 * @param {string} agentBaseUrl
 * @param {string | null} agentId
 * @param {string | null} agentName
 * @param {AuthSession} [session]
 */
export async function resolveAgentId(agentBaseUrl, agentId, agentName, session) {
    if (agentId) {
        return agentId;
    }
    const base = normalizeBaseUrl(agentBaseUrl);
    const headers = session ? buildAuthHeaders(session) : {};
    const data = await fetchJson(`${base}/agents`, {
        method: "GET",
        headers,
    });
    const agents = Array.isArray(data?.agents) ? data.agents : [];
    if (agents.length === 0) {
        throw new Error("No agents found at /agents");
    }
    if (agentName) {
        const match = findAgentByName(agents, agentName);
        if (!match) {
            const available = agents.map((a) => a.name).join(", ");
            throw new Error(
                `Agent name not found: ${agentName}. Available: ${available}`,
            );
        }
        return match.id;
    }
    if (agents.length === 1) {
        return agents[0].id;
    }
    const available = agents.map((a) => `${a.name} (${a.id})`).join(", ");
    throw new Error(
        `Multiple agents found. Use --agent-id or --agent-name. Available: ${available}`,
    );
}

/**
 * @param {string | null} filePath
 */
export async function loadApprovalTemplates(filePath) {
    if (!filePath) {
        return null;
    }
    const absolutePath = path.isAbsolute(filePath)
        ? filePath
        : path.join(process.cwd(), filePath);
    const raw = await fs.readFile(absolutePath, "utf8");
    return JSON.parse(raw);
}

/**
 * Build POST body for message/stream from a suite case.
 * @param {Record<string, unknown>} caseDef
 */
export function buildMessagePayload(caseDef) {
    const message = caseDef.message || {};
    const compose = caseDef.compose || {};
    const text =
        typeof message.text === "string"
            ? message.text
            : typeof compose.previewText === "string"
              ? compose.previewText
              : compose.action
                ? `Execute ${compose.action}`
                : "";

    const payload = {
        text,
        ...(message.attachments ? { attachments: message.attachments } : {}),
        ...(message.language ? { language: message.language } : {}),
    };

    if (compose.action) {
        payload.composedAction = compose.action;
        payload.composedParams = compose.params ?? {};
        if (compose.preApproved === true) {
            payload.composedPreApproved = true;
        }
    }

    return payload;
}
