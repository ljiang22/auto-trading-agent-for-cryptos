import type {
    IAgentRuntime,
    Actor,
    Content,
    Memory,
    UUID,
} from "./types.ts";

/**
 * Get details for a list of actors.
 */
export async function getActorDetails({
    runtime,
    roomId,
}: {
    runtime: IAgentRuntime;
    roomId: UUID;
}) {
    const participantIds =
        await runtime.databaseAdapter.getParticipantsForRoom(roomId);
    const actors = await Promise.all(
        participantIds.map(async (userId) => {
            const account =
                await runtime.databaseAdapter.getAccountById(userId);
            if (account) {
                return {
                    id: account.id,
                    name: account.name,
                    username: account.username,
                    details: account.details,
                };
            }
            return null;
        })
    );

    return actors.filter((actor): actor is Actor => actor !== null);
}

/**
 * Format actors into a string
 * @param actors - list of actors
 * @returns string
 */
export function formatActors({ actors }: { actors: Actor[] }) {
    const actorStrings = actors.map((actor: Actor) => {
        const header = `${actor.name}${actor.details?.tagline ? ": " + actor.details?.tagline : ""}${actor.details?.summary ? "\n" + actor.details?.summary : ""}`;
        return header;
    });
    const finalActorStrings = actorStrings.join("\n");
    return finalActorStrings;
}

/**
 * Format messages into a string.
 *
 * @param messages - list of messages
 * @param actors - list of actors
 * @param agentId - the agent's user id. Required for `preferSummaryForAgentTurns`
 *                  to know which memories are agent turns.
 * @param preferSummaryForAgentTurns - when true, agent-turn memories whose
 *                  `content.metadata.summary` is a non-empty string are
 *                  rendered using that summary instead of the full
 *                  `content.text`. User turns are always rendered with full
 *                  text. Default false preserves the historical behavior for
 *                  every existing caller.
 * @returns string
 */
export const formatMessages = ({
    messages,
    actors,
    agentId,
    preferSummaryForAgentTurns = false,
}: {
    messages: Memory[];
    actors: Actor[];
    agentId?: UUID;
    preferSummaryForAgentTurns?: boolean;
}) => {
    const messageStrings = messages
        .reverse()
        .filter((message: Memory) => message.userId)
        .map((message: Memory) => {
            const content = message.content as Content;
            const isAgent =
                agentId !== undefined && message.userId === agentId;
            const summaryRaw = (content as { metadata?: unknown })?.metadata
                && typeof (content as { metadata?: unknown }).metadata === "object"
                ? ((content as { metadata?: Record<string, unknown> }).metadata?.summary)
                : undefined;
            const summary =
                typeof summaryRaw === "string" && summaryRaw.length > 0
                    ? summaryRaw
                    : "";

            const messageContent =
                preferSummaryForAgentTurns && isAgent && summary
                    ? summary
                    : content.text;
            const messageAction = content.action;
            const formattedName =
                actors.find((actor: Actor) => actor.id === message.userId)
                    ?.name || "Unknown User";
            const timestamp = formatTimestamp(message.createdAt);

            const shortId = message.userId.slice(-5);

            return `(${timestamp}) [${shortId}] ${formattedName}: ${messageContent}${messageAction && messageAction !== "null" ? ` (${messageAction})` : ""}`;
        })
        .join("\n");
    return messageStrings;
};

export const formatTimestamp = (messageDate: number) => {
    const now = new Date();
    const diff = now.getTime() - messageDate;

    const absDiff = Math.abs(diff);
    const seconds = Math.floor(absDiff / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);

    if (absDiff < 60000) {
        return "just now";
    } else if (minutes < 60) {
        return `${minutes} minute${minutes !== 1 ? "s" : ""} ago`;
    } else if (hours < 24) {
        return `${hours} hour${hours !== 1 ? "s" : ""} ago`;
    } else {
        return `${days} day${days !== 1 ? "s" : ""} ago`;
    }
};
