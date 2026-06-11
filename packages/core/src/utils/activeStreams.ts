/**
 * Per-room SSE stream-liveness tracking + per-user side-channel.
 *
 * Why this exists: when a long-running comprehensive analysis finishes, the
 * runtime persists a Memory and tries to push it through the SSE callback.
 * If the user has already navigated away or closed the tab, the SSE stream
 * is dead and the memory is silent — the user never sees the result land.
 * The data is in the DB and the report is in S3, but from the user's POV
 * the analysis "vanished."
 *
 * This registry tracks which rooms have at least one live SSE listener.
 * Client-direct registers/unregisters on stream open/close. The runtime
 * checks before delivery so it can tag `metadata.deliveryStatus` on the
 * persisted memory — frontends can use that flag to render an unread badge
 * on chat history load.
 *
 * Multi-tab safe: the value is a Set of connectionIds. Two tabs on the same
 * room both register; closing one doesn't mark the room as dead while the
 * other is still listening.
 *
 * Lives on the runtime instance (`__activeStreams`) so it's per-process
 * and survives across handler calls. Lost on process restart (acceptable —
 * SSE connections die on restart anyway).
 *
 * Fix 12 (2026-05-22) extends the registry with a per-(room, connection)
 * record holding `{ userId, send }`. The `send` callback writes a single
 * SSE `data:` frame on that exact connection. This lets out-of-band
 * server-side events (kill-switch revoke, future delivery hints) reach a
 * live UI without standing up a separate pub/sub. Callsites that don't
 * provide a writer still register as before — `emitEventToUser` simply
 * skips connections with no `send` wired up.
 */
type SseSendFn = (event: Record<string, unknown>) => void;

interface ConnectionRecord {
    userId?: string;
    send?: SseSendFn;
}

type ActiveStreamsRegistry = Map<string, Map<string, ConnectionRecord>>;

interface RuntimeWithActiveStreams {
    __activeStreams?: ActiveStreamsRegistry;
}

function registry(runtime: unknown): ActiveStreamsRegistry {
    const r = runtime as RuntimeWithActiveStreams;
    if (!r.__activeStreams) {
        r.__activeStreams = new Map();
    }
    return r.__activeStreams;
}

/**
 * Register a fresh SSE stream listening to `roomId`.
 *
 * `userId` and `send` are optional for backward compatibility: legacy
 * callsites that only care about liveness can omit them. The kill-switch
 * SSE notification path uses both — `userId` to filter by owner and
 * `send` to push the `kill_switch_revoked` event onto the live wire.
 */
export function markStreamOpen(
    runtime: unknown,
    roomId: string,
    connectionId: string,
    userId?: string,
    send?: SseSendFn
): void {
    const reg = registry(runtime);
    let conns = reg.get(roomId);
    if (!conns) {
        conns = new Map();
        reg.set(roomId, conns);
    }
    conns.set(connectionId, { userId, send });
}

/** Mark a previously-registered SSE stream as closed. Idempotent. */
export function markStreamClosed(
    runtime: unknown,
    roomId: string,
    connectionId: string
): void {
    const reg = registry(runtime);
    const conns = reg.get(roomId);
    if (!conns) return;
    conns.delete(connectionId);
    if (conns.size === 0) {
        reg.delete(roomId);
    }
}

/**
 * True iff at least one SSE stream is currently listening to `roomId`.
 * Used by the runtime at workflow-completion time to decide whether the
 * final response will reach the user via SSE or only via persisted memory.
 */
export function isStreamAliveForRoom(
    runtime: unknown,
    roomId: string
): boolean {
    const conns = registry(runtime).get(roomId);
    return !!conns && conns.size > 0;
}

/**
 * Fix 12 — push a structured event to every live SSE connection owned by
 * `userId`. Returns the count of connections written to. Used by the
 * kill-switch endpoint to notify the client that pending approvals were
 * revoked so the approval modal can be dismissed without waiting for a
 * memory poll. Each `send` is wrapped in try/catch so one dead socket
 * cannot stop delivery to the other tabs.
 */
export function emitEventToUser(
    runtime: unknown,
    userId: string,
    payload: Record<string, unknown>
): number {
    const reg = registry(runtime);
    let count = 0;
    for (const conns of reg.values()) {
        for (const record of conns.values()) {
            if (record.userId && record.send && String(record.userId) === String(userId)) {
                try {
                    record.send(payload);
                    count += 1;
                } catch {
                    // Swallow — a broken SSE socket shouldn't block the
                    // others, and the connection will be removed by its
                    // own res.on('close') handler shortly anyway.
                }
            }
        }
    }
    return count;
}
