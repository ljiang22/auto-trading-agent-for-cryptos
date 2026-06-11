/**
 * Per (user, room) execution mode remembered across CEX turns.
 */

export type CexExecutionMode = "paper" | "live" | "shadow";

const sessionByRoom = new Map<string, CexExecutionMode>();

function roomKey(userId: string, roomId: string): string {
    return `${userId}:${roomId}`;
}

export function setSessionExecutionMode(
    userId: string,
    roomId: string,
    mode: CexExecutionMode,
): void {
    sessionByRoom.set(roomKey(userId, roomId), mode);
}

export function getSessionExecutionMode(
    userId: string,
    roomId: string,
): CexExecutionMode | null {
    return sessionByRoom.get(roomKey(userId, roomId)) ?? null;
}

/** @internal */
export function __resetExecutionModeSessionForTests(): void {
    sessionByRoom.clear();
}
