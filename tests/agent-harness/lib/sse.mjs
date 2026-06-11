/**
 * Parse Server-Sent Events from POST /:agentId/message/stream responses.
 */

/**
 * Parse one SSE chunk (between double newlines) into parsed data payloads.
 * @param {string} chunk
 * @returns {unknown[]}
 */
export function parseSseChunk(chunk) {
    const events = [];
    const lines = chunk.split("\n");
    for (const line of lines) {
        if (!line.startsWith("data:")) {
            continue;
        }
        const data = line.slice(5).trim();
        if (!data || data === "[DONE]") {
            continue;
        }
        try {
            events.push(JSON.parse(data));
        } catch {
            events.push({ type: "parse_error", raw: data });
        }
    }
    return events;
}

/**
 * Stream SSE events from a fetch Response body.
 * @param {Response} response
 * @returns {AsyncGenerator<unknown>}
 */
export async function* streamSseEvents(response) {
    if (!response.body) {
        throw new Error("No response body for streaming request");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
        while (true) {
            const { value, done } = await reader.read();
            if (done) {
                break;
            }
            buffer += decoder.decode(value, { stream: true });

            let splitIndex = buffer.indexOf("\n\n");
            while (splitIndex !== -1) {
                const chunk = buffer.slice(0, splitIndex);
                buffer = buffer.slice(splitIndex + 2);
                for (const event of parseSseChunk(chunk)) {
                    yield event;
                    if (event && typeof event === "object" && event.type === "error") {
                        return;
                    }
                }
                splitIndex = buffer.indexOf("\n\n");
            }
        }

        if (buffer.trim()) {
            for (const event of parseSseChunk(buffer)) {
                yield event;
            }
        }
    } finally {
        try {
            await reader.cancel();
        } catch {
            // ignore
        }
    }
}

/**
 * POST and consume all SSE events via callback or collection.
 * @param {string} url
 * @param {Record<string, unknown>} payload
 * @param {Record<string, string>} headers
 * @param {(event: unknown) => void | Promise<void>} onEvent
 * @param {{ signal?: AbortSignal }} [options]
 */
export async function postStream(url, payload, headers, onEvent, options = {}) {
    const response = await fetch(url, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            ...headers,
        },
        body: JSON.stringify(payload),
        signal: options.signal,
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`HTTP ${response.status} ${response.statusText}: ${text}`);
    }

    for await (const event of streamSseEvents(response)) {
        await onEvent(event);
        if (event && typeof event === "object" && event.type === "error") {
            break;
        }
    }
}
