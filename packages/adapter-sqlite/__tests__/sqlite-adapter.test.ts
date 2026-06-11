import type { UUID } from '@elizaos/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SqliteDatabaseAdapter } from '../src';
import { load } from '../src/sqlite_vec';
import type { Database } from 'better-sqlite3';

// Mock the elizaLogger
vi.mock('@elizaos/core', async () => {
    const actual = await vi.importActual('@elizaos/core');
    return {
        ...actual as any,
        elizaLogger: {
            debug: vi.fn(),
            error: vi.fn(),
            info: vi.fn(),
            log: vi.fn(),
            success: vi.fn(),
            warn: vi.fn(),
        }
    };
});

// Mock sqlite_vec
vi.mock('../src/sqlite_vec', () => ({
    load: vi.fn()
}));

describe('SqliteDatabaseAdapter', () => {
    let adapter: SqliteDatabaseAdapter;
    let mockDb: any;

    beforeEach(() => {
        // Create mock database methods
        mockDb = {
            prepare: vi.fn(() => ({
                get: vi.fn(),
                all: vi.fn(),
                run: vi.fn(),
                bind: vi.fn()
            })),
            exec: vi.fn(),
            close: vi.fn()
        };

        // Initialize adapter with mock db
        adapter = new SqliteDatabaseAdapter(mockDb as Database);
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    describe('getRoom', () => {
        it('should return room ID when room exists', async () => {
            const roomId = 'test-room-id' as UUID;
            mockDb.prepare.mockReturnValueOnce({
                get: vi.fn().mockReturnValueOnce({ id: roomId })
            });

            const result = await adapter.getRoom(roomId);

            expect(mockDb.prepare).toHaveBeenCalledWith('SELECT id FROM rooms WHERE id = ?');
            expect(result).toBe(roomId);
        });

        it('should return null when room does not exist', async () => {
            mockDb.prepare.mockReturnValueOnce({
                get: vi.fn().mockReturnValueOnce(undefined)
            });

            const result = await adapter.getRoom('non-existent-room' as UUID);

            expect(result).toBeNull();
        });
    });

    describe('getParticipantsForAccount', () => {
        const mockParticipants = [
            { id: 'participant-1', userId: 'user-1', roomId: 'room-1' },
            { id: 'participant-2', userId: 'user-1', roomId: 'room-2' }
        ];

        it('should return participants when they exist', async () => {
            mockDb.prepare.mockReturnValueOnce({
                all: vi.fn().mockReturnValueOnce(mockParticipants)
            });

            const userId = 'user-1' as UUID;
            const result = await adapter.getParticipantsForAccount(userId);

            expect(mockDb.prepare).toHaveBeenCalledWith(expect.stringContaining('SELECT p.id, p.userId, p.roomId'));
            expect(result).toEqual(mockParticipants);
        });

        it('should return empty array when no participants exist', async () => {
            mockDb.prepare.mockReturnValueOnce({
                all: vi.fn().mockReturnValueOnce([])
            });

            const result = await adapter.getParticipantsForAccount('no-participants' as UUID);

            expect(result).toEqual([]);
        });
    });

    describe('getParticipantUserState', () => {
        const roomId = 'test-room' as UUID;
        const userId = 'test-user' as UUID;

        it('should return user state when it exists', async () => {
            mockDb.prepare.mockReturnValueOnce({
                get: vi.fn().mockReturnValueOnce({ userState: 'FOLLOWED' })
            });

            const result = await adapter.getParticipantUserState(roomId, userId);

            expect(mockDb.prepare).toHaveBeenCalledWith(
                'SELECT userState FROM participants WHERE roomId = ? AND userId = ?'
            );
            expect(result).toBe('FOLLOWED');
        });

        it('should return null when user state does not exist', async () => {
            mockDb.prepare.mockReturnValueOnce({
                get: vi.fn().mockReturnValueOnce(undefined)
            });

            const result = await adapter.getParticipantUserState(roomId, userId);

            expect(result).toBeNull();
        });
    });

    describe('setParticipantUserState', () => {
        const roomId = 'test-room' as UUID;
        const userId = 'test-user' as UUID;

        it('should successfully update user state', async () => {
            const runMock = vi.fn();
            mockDb.prepare.mockReturnValueOnce({
                run: runMock
            });

            await adapter.setParticipantUserState(roomId, userId, 'MUTED');

            expect(mockDb.prepare).toHaveBeenCalledWith(
                'UPDATE participants SET userState = ? WHERE roomId = ? AND userId = ?'
            );
            expect(runMock).toHaveBeenCalledWith('MUTED', roomId, userId);
        });

        it('should handle null state', async () => {
            const runMock = vi.fn();
            mockDb.prepare.mockReturnValueOnce({
                run: runMock
            });

            await adapter.setParticipantUserState(roomId, userId, null);

            expect(runMock).toHaveBeenCalledWith(null, roomId, userId);
        });
    });

    describe('searchKnowledge', () => {
        it('should use pure vector recall and return vector similarity scores', async () => {
            const allMock = vi.fn().mockReturnValueOnce([
                {
                    id: 'knowledge-1',
                    agentId: 'agent-1',
                    content: JSON.stringify({
                        text: 'Local SQLite knowledge document',
                        metadata: { source: 'rag/sqlite.md' }
                    }),
                    embedding: null,
                    createdAt: '2026-03-30T00:00:00.000Z',
                    vector_score: 0.62
                }
            ]);

            vi.spyOn(adapter, 'getCache').mockResolvedValue(undefined);
            vi.spyOn(adapter, 'setCache').mockResolvedValue(true);
            mockDb.prepare.mockReturnValueOnce({
                all: allMock
            });

            const results = await adapter.searchKnowledge({
                agentId: 'agent-1' as UUID,
                embedding: new Float32Array([0.1, 0.2, 0.3]),
                match_threshold: 0.3,
                match_count: 5,
                searchText: 'sqlite local rag'
            });

            const sql = mockDb.prepare.mock.calls[0][0];

            expect(sql).toContain('vector_scores');
            expect(sql).not.toContain('keyword_matches');
            expect(sql).not.toContain('combined_score');
            expect(allMock).toHaveBeenCalledWith(
                expect.any(Float32Array),
                'agent-1',
                'agent-1',
                0.3,
                5
            );
            expect(results).toEqual([
                expect.objectContaining({
                    id: 'knowledge-1',
                    similarity: 0.62,
                    content: expect.objectContaining({
                        text: 'Local SQLite knowledge document'
                    })
                })
            ]);
            expect(adapter.setCache).toHaveBeenCalled();
        });
    });

    describe('init and close', () => {
        it('should initialize the database with tables', async () => {
            await adapter.init();
            expect(mockDb.exec).toHaveBeenCalled();
            expect(load).toHaveBeenCalledWith(mockDb);
        });

        it('should close the database connection', async () => {
            await adapter.close();
            expect(mockDb.close).toHaveBeenCalled();
        });
    });
});
