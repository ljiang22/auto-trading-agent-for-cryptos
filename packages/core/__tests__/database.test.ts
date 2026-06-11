/* eslint-disable no-dupe-class-members */
import { DatabaseAdapter } from "../src/database.ts";
import {
    type Memory,
    type Actor,
    type Account,
    type Goal,
    GoalStatus,
    type Participant,
    type Relationship,
    type UUID,
    type FavoriteTaskChainRecord,
    type FavoriteTaskChainCreateInput,
    type SharedTaskChainRecord,
    type SharedTaskChainCreateInput,
} from "../src/types.ts";

class MockDatabaseAdapter extends DatabaseAdapter {
    getMemoryById(_id: UUID): Promise<Memory | null> {
        throw new Error("Method not implemented.");
    }
    async getMemoriesByIds(
        memoryIds: UUID[],
        _tableName?: string
    ): Promise<Memory[]> {
        return memoryIds.map((id) => ({
            id: id,
            content: { text: "Test Memory" },
            roomId: "room-id" as UUID,
            userId: "user-id" as UUID,
            agentId: "agent-id" as UUID,
        })) as Memory[];
    }
    log(_params: {
        body: { [key: string]: unknown };
        userId: UUID;
        roomId: UUID;
        type: string;
    }): Promise<void> {
        throw new Error("Method not implemented.");
    }
    getActorDetails(_params: { roomId: UUID }): Promise<Actor[]> {
        throw new Error("Method not implemented.");
    }
    searchMemoriesByEmbedding(
        _embedding: number[],
        _params: {
            match_threshold?: number;
            count?: number;
            roomId?: UUID;
            agentId?: UUID;
            unique?: boolean;
            tableName: string;
        }
    ): Promise<Memory[]> {
        throw new Error("Method not implemented.");
    }
    createMemory(
        _memory: Memory,
        _tableName: string,
        _unique?: boolean
    ): Promise<void> {
        throw new Error("Method not implemented.");
    }
    updateMemoryContent(_params: {
        id: UUID;
        tableName: string;
        content: Memory["content"];
    }): Promise<void> {
        throw new Error("Method not implemented.");
    }
    removeMemory(_memoryId: UUID, _tableName: string): Promise<void> {
        throw new Error("Method not implemented.");
    }
    removeAllMemories(_roomId: UUID, _tableName: string): Promise<void> {
        throw new Error("Method not implemented.");
    }
    countMemories(
        _roomId: UUID,
        _unique?: boolean,
        _tableName?: string
    ): Promise<number> {
        throw new Error("Method not implemented.");
    }
    countUserMessages(_params: {
        userId: UUID;
        tableName?: string;
        agentId?: UUID;
        since?: number;
    }): Promise<number> {
        return Promise.resolve(0);
    }
    getFavoriteTaskChains(_params: {
        userId: UUID;
        agentId: UUID;
    }): Promise<FavoriteTaskChainRecord[]> {
        return Promise.resolve([]);
    }
    getFavoriteTaskChain(_params: {
        favoriteId: UUID;
        userId: UUID;
        agentId: UUID;
    }): Promise<FavoriteTaskChainRecord | null> {
        throw new Error("Method not implemented.");
    }
    createFavoriteTaskChain(_params: FavoriteTaskChainCreateInput): Promise<FavoriteTaskChainRecord> {
        throw new Error("Method not implemented.");
    }
    removeFavoriteTaskChain(_params: {
        favoriteId: UUID;
        userId: UUID;
        agentId: UUID;
    }): Promise<void> {
        throw new Error("Method not implemented.");
    }
    updateFavoriteTaskChainName(_params: {
        favoriteId: UUID;
        userId: UUID;
        agentId: UUID;
        name: string;
    }): Promise<void> {
        throw new Error("Method not implemented.");
    }
    markFavoriteTaskChainUsed(_params: {
        favoriteId: UUID;
        userId: UUID;
        agentId: UUID;
        timestamp?: number;
    }): Promise<void> {
        throw new Error("Method not implemented.");
    }
    getSharedTaskChainByFavorite(_params: {
        favoriteId: UUID;
        userId: UUID;
        agentId: UUID;
    }): Promise<SharedTaskChainRecord | null> {
        throw new Error("Method not implemented.");
    }
    createSharedTaskChain(_params: SharedTaskChainCreateInput): Promise<SharedTaskChainRecord> {
        throw new Error("Method not implemented.");
    }
    getSharedTaskChainByCode(_shareCode: string): Promise<SharedTaskChainRecord | null> {
        throw new Error("Method not implemented.");
    }
    getGoals(_params: {
        roomId: UUID;
        userId?: UUID | null;
        onlyInProgress?: boolean;
        count?: number;
    }): Promise<Goal[]> {
        throw new Error("Method not implemented.");
    }
    updateGoal(_goal: Goal): Promise<void> {
        throw new Error("Method not implemented.");
    }
    createGoal(_goal: Goal): Promise<void> {
        throw new Error("Method not implemented.");
    }
    removeGoal(_goalId: UUID): Promise<void> {
        throw new Error("Method not implemented.");
    }
    removeAllGoals(_roomId: UUID): Promise<void> {
        throw new Error("Method not implemented.");
    }
    getRoom(_roomId: UUID): Promise<UUID | null> {
        throw new Error("Method not implemented.");
    }
    createRoom(_roomId?: UUID, _name?: string, _agentId?: UUID): Promise<UUID> {
        throw new Error("Method not implemented.");
    }
    getRoomById(_roomId: UUID): Promise<{ id: UUID; name?: string; createdAt: string } | null> {
        throw new Error("Method not implemented.");
    }
    removeRoom(_roomId: UUID): Promise<void> {
        throw new Error("Method not implemented.");
    }
    getRoomsForParticipant(_userId: UUID): Promise<UUID[]> {
        throw new Error("Method not implemented.");
    }
    getRoomsForParticipants(_userIds: UUID[]): Promise<UUID[]> {
        throw new Error("Method not implemented.");
    }
    addParticipant(_userId: UUID, _roomId: UUID): Promise<boolean> {
        throw new Error("Method not implemented.");
    }
    removeParticipant(_userId: UUID, _roomId: UUID): Promise<boolean> {
        throw new Error("Method not implemented.");
    }
    getParticipantsForAccount(userId: UUID): Promise<Participant[]>;
    getParticipantsForAccount(userId: UUID): Promise<Participant[]>;
    getParticipantsForAccount(
        _userId: unknown
    ): Promise<import("../src/types.ts").Participant[]> {
        throw new Error("Method not implemented.");
    }
    getParticipantsForRoom(_roomId: UUID): Promise<UUID[]> {
        throw new Error("Method not implemented.");
    }
    getParticipantUserState(
        _roomId: UUID,
        _userId: UUID
    ): Promise<"FOLLOWED" | "MUTED" | null> {
        throw new Error("Method not implemented.");
    }
    setParticipantUserState(
        _roomId: UUID,
        _userId: UUID,
        _state: "FOLLOWED" | "MUTED" | null
    ): Promise<void> {
        throw new Error("Method not implemented.");
    }
    createRelationship(_params: {
        userA: UUID;
        userB: UUID;
    }): Promise<boolean> {
        throw new Error("Method not implemented.");
    }
    getRelationship(_params: {
        userA: UUID;
        userB: UUID;
    }): Promise<Relationship | null> {
        throw new Error("Method not implemented.");
    }
    getRelationships(_params: { userId: UUID }): Promise<Relationship[]> {
        throw new Error("Method not implemented.");
    }
    db: any = {};

    // Mock method for getting memories by room IDs
    async getMemoriesByRoomIds(params: {
        roomIds: `${string}-${string}-${string}-${string}-${string}`[];
        agentId?: `${string}-${string}-${string}-${string}-${string}`;
        tableName: string;
    }): Promise<Memory[]> {
        return [
            {
                id: "memory-id" as UUID,
                content: "Test Memory",
                roomId: params.roomIds[0],
                userId: "user-id" as UUID,
                agentId: params.agentId ?? ("agent-id" as UUID),
            },
        ] as unknown as Memory[];
    }

    // Mock method for searching memories
    async searchMemories(params: {
        tableName: string;
        roomId: `${string}-${string}-${string}-${string}-${string}`;
        embedding: number[];
        match_threshold: number;
        match_count: number;
        unique: boolean;
    }): Promise<Memory[]> {
        return [
            {
                id: "memory-id" as UUID,
                content: "Test Memory",
                roomId: params.roomId,
                userId: "user-id" as UUID,
                agentId: "agent-id" as UUID,
            },
        ] as unknown as Memory[];
    }

    // Mock method for getting account by ID
    async getAccountById(userId: UUID): Promise<Account | null> {
        return {
            id: userId,
            username: "testuser",
            name: "Test Account",
        } as Account;
    }

    // Other methods stay the same...
    async createAccount(_account: Account): Promise<boolean> {
        return true;
    }

    async getMemories(params: {
        roomId: UUID;
        count?: number;
        unique?: boolean;
        tableName: string;
    }): Promise<Memory[]> {
        return [
            {
                id: "memory-id" as UUID,
                content: "Test Memory",
                roomId: params.roomId,
                userId: "user-id" as UUID,
                agentId: "agent-id" as UUID,
            },
        ] as unknown as Memory[];
    }

    async getActors(_params: { roomId: UUID }): Promise<Actor[]> {
        return [
            {
                id: "actor-id" as UUID,
                name: "Test Actor",
                username: "testactor",
                roomId: "room-id" as UUID, // Ensure roomId is provided
            },
        ] as unknown as Actor[];
    }

    async updateGoalStatus(_params: {
        goalId: UUID;
        status: GoalStatus;
    }): Promise<void> {
        return Promise.resolve();
    }

    async getGoalById(goalId: UUID): Promise<Goal | null> {
        return {
            id: goalId,
            status: GoalStatus.IN_PROGRESS,
            roomId: "room-id" as UUID,
            userId: "user-id" as UUID,
            name: "Test Goal",
            objectives: [],
        } as Goal;
    }
}

// Now, let’s fix the test suite.

describe("DatabaseAdapter Tests", () => {
    let adapter: MockDatabaseAdapter;
    const roomId = "room-id" as UUID;

    beforeEach(() => {
        adapter = new MockDatabaseAdapter();
    });

    it("should return memories by room ID", async () => {
        const memories = await adapter.getMemoriesByRoomIds({
            roomIds: [
                "room-id" as `${string}-${string}-${string}-${string}-${string}`,
            ],
            tableName: "test_table",
        });
        expect(memories).toHaveLength(1);
        expect(memories[0].roomId).toBe("room-id");
    });

    // getCachedEmbeddings was removed; cache is now in-process LRU keyed by
    // sha256(text), tested in embedding.test.ts.

    it("should search memories based on embedding", async () => {
        const memories = await adapter.searchMemories({
            tableName: "test_table",
            roomId: "room-id" as `${string}-${string}-${string}-${string}-${string}`,
            embedding: [0.1, 0.2, 0.3],
            match_threshold: 0.5,
            match_count: 3,
            unique: true,
        });
        expect(memories).toHaveLength(1);
        expect(memories[0].roomId).toBe("room-id");
    });

    it("should get an account by user ID", async () => {
        const account = await adapter.getAccountById("test-user-id" as UUID);
        expect(account).not.toBeNull();
        expect(account.username).toBe("testuser");
    });

    it("should create a new account", async () => {
        const newAccount: Account = {
            id: "new-user-id" as UUID,
            username: "newuser",
            name: "New Account",
        };
        const result = await adapter.createAccount(newAccount);
        expect(result).toBe(true);
    });

    it("should update the goal status", async () => {
        const goalId = "goal-id" as UUID;
        await expect(
            adapter.updateGoalStatus({ goalId, status: GoalStatus.IN_PROGRESS })
        ).resolves.toBeUndefined();
    });

    it("should return actors by room ID", async () => {
        const actors = await adapter.getActors({ roomId });
        expect(actors).toHaveLength(1);
    });

    it("should get a goal by ID", async () => {
        const goalId = "goal-id" as UUID;
        const goal = await adapter.getGoalById(goalId);
        expect(goal).not.toBeNull();
        expect(goal?.status).toBe(GoalStatus.IN_PROGRESS);
    });
});
