import { useState, useEffect, useCallback } from "react";
import type { TaskChainData } from "@/components/TaskChainBubble";
import { apiClient } from "@/lib/api";

export interface FavoriteTaskChain {
    favoriteId: string;
    id: string;
    name: string;
    originalName: string;
    description: string;
    taskChain: TaskChainData;
    createdAt: number;
    lastUsedAt?: number;
    source?: "favorite" | "shared";
    shareCode?: string;
    sharedAgentId?: string;
    isPublic: boolean;
}

export interface SharedTaskChain {
    shareId: string;
    shareCode: string;
    agentId: string;
    favoriteId?: string | null;
    chainId: string;
    name: string;
    originalName: string;
    description: string;
    taskChain: TaskChainData;
    createdAt: number;
}

const ensureTaskChainData = (favorite: any): TaskChainData => {
    const rawTaskChain = favorite?.taskChain;

    if (rawTaskChain && typeof rawTaskChain === "object") {
        const tasks = Array.isArray(rawTaskChain.tasks)
            ? rawTaskChain.tasks
            : [];

        return {
            id: rawTaskChain.id ?? favorite?.chainId ?? favorite?.id ?? "",
            name: rawTaskChain.name ?? favorite?.name ?? "",
            description:
                rawTaskChain.description ?? favorite?.description ?? "",
            originalRequest: rawTaskChain.originalRequest,
            tasks,
        } satisfies TaskChainData;
    }

    return {
        id: favorite?.chainId ?? favorite?.id ?? "",
        name: favorite?.name ?? "",
        description: favorite?.description ?? "",
        tasks: [],
    } satisfies TaskChainData;
};

const normalizeFavorite = (favorite: any): FavoriteTaskChain => {
    const createdAtValue =
        typeof favorite?.createdAt === "number"
            ? favorite.createdAt
            : Number.parseInt(favorite?.createdAt ?? "", 10);

    const lastUsedAtValue =
        typeof favorite?.lastUsedAt === "number"
            ? favorite.lastUsedAt
            : favorite?.lastUsedAt
              ? Number.parseInt(favorite.lastUsedAt, 10)
              : undefined;

    return {
        favoriteId: favorite?.favoriteId ?? favorite?.id ?? "",
        id: favorite?.id ?? favorite?.chainId ?? "",
        name: favorite?.name ?? "",
        originalName: favorite?.originalName ?? favorite?.name ?? "",
        description: favorite?.description ?? "",
        taskChain: ensureTaskChainData(favorite),
        createdAt: Number.isFinite(createdAtValue)
            ? createdAtValue
            : Date.now(),
        lastUsedAt: Number.isFinite(lastUsedAtValue)
            ? lastUsedAtValue
            : undefined,
        source: "favorite",
        isPublic: Boolean(favorite?.isPublic),
    } satisfies FavoriteTaskChain;
};

const normalizeSharedTaskChain = (share: any): SharedTaskChain => {
    const createdAtValue =
        typeof share?.createdAt === "number"
            ? share.createdAt
            : Number.parseInt(share?.createdAt ?? "", 10);

    return {
        shareId: share?.shareId ?? share?.id ?? "",
        shareCode: share?.shareCode ?? "",
        agentId: share?.agentId ?? "",
        favoriteId: share?.favoriteId ?? undefined,
        chainId: share?.chainId ?? share?.taskChain?.id ?? "",
        name: share?.name ?? share?.taskChain?.name ?? "",
        originalName: share?.originalName ?? share?.name ?? "",
        description: share?.description ?? share?.taskChain?.description ?? "",
        taskChain: ensureTaskChainData(share),
        createdAt: Number.isFinite(createdAtValue)
            ? createdAtValue
            : Date.now(),
    } satisfies SharedTaskChain;
};

export interface FavoriteTaskChainsApi {
    favorites: FavoriteTaskChain[];
    isLoading: boolean;
    error: Error | null;
    addFavorite: (
        taskChain: TaskChainData,
        customName?: string,
        options?: { isPublic?: boolean }
    ) => Promise<FavoriteTaskChain | null>;
    removeFavorite: (favoriteId: string) => Promise<void>;
    updateFavoriteName: (favoriteId: string, newName: string) => Promise<void>;
    updateFavoriteVisibility: (
        favoriteId: string,
        isPublic: boolean
    ) => Promise<FavoriteTaskChain | null>;
    markAsUsed: (favoriteId: string) => Promise<void>;
    isFavorite: (chainId: string) => boolean;
    getFavoriteByChainId: (
        chainId: string
    ) => FavoriteTaskChain | undefined;
    searchFavorites: (query: string) => FavoriteTaskChain[];
    getFavorites: () => FavoriteTaskChain[];
    getFavoritesByLastUsed: () => FavoriteTaskChain[];
    shareFavorite: (favoriteId: string) => Promise<SharedTaskChain | null>;
    fetchSharedChainByCode: (shareCode: string) => Promise<SharedTaskChain | null>;
}

export function useFavoriteTaskChains(agentId?: string): FavoriteTaskChainsApi {
    const [favorites, setFavorites] = useState<FavoriteTaskChain[]>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<Error | null>(null);

    useEffect(() => {
        let isMounted = true;

        if (!agentId) {
            setFavorites([]);
            setIsLoading(false);
            return () => {
                isMounted = false;
            };
        }

        setIsLoading(true);
        setError(null);

        apiClient
            .getFavoriteTaskChains(agentId)
            .then((response) => {
                if (!isMounted) return;

                const fetchedFavorites = Array.isArray(response?.favorites)
                    ? response.favorites.map(normalizeFavorite)
                    : [];
                setFavorites(fetchedFavorites);
            })
            .catch((err) => {
                if (!isMounted) return;

                console.error("Failed to load favorite task chains:", err);
                setFavorites([]);
                setError(err instanceof Error ? err : new Error(String(err)));
            })
            .finally(() => {
                if (isMounted) {
                    setIsLoading(false);
                }
            });

        return () => {
            isMounted = false;
        };
    }, [agentId]);

    const addFavorite = useCallback(
        async (
            taskChain: TaskChainData,
            customName?: string,
            options?: { isPublic?: boolean }
        ): Promise<FavoriteTaskChain | null> => {
            if (!agentId) {
                throw new Error(
                    "agentId must be provided to add favorite task chains"
                );
            }

            try {
                const response = await apiClient.addFavoriteTaskChain(agentId, {
                    chainId: taskChain.id,
                    name: customName || taskChain.name,
                    originalName: taskChain.name,
                    description: taskChain.description,
                    taskChain,
                    isPublic: Boolean(options?.isPublic),
                });

                const favorite = normalizeFavorite(response.favorite);
                setFavorites((prev) => [
                    favorite,
                    ...prev.filter((item) => item.favoriteId !== favorite.favoriteId),
                ]);
                return favorite;
            } catch (err) {
                console.error("Failed to add favorite task chain:", err);
                return null;
            }
        },
        [agentId]
    );

    const removeFavorite = useCallback(
        async (favoriteId: string) => {
            if (!agentId) {
                throw new Error(
                    "agentId must be provided to remove favorite task chains"
                );
            }

            try {
                await apiClient.deleteFavoriteTaskChain(agentId, favoriteId);
                setFavorites((prev) =>
                    prev.filter((favorite) => favorite.favoriteId !== favoriteId)
                );
            } catch (err) {
                console.error("Failed to remove favorite task chain:", err);
            }
        },
        [agentId]
    );

    const updateFavoriteName = useCallback(
        async (favoriteId: string, newName: string) => {
            if (!agentId) {
                throw new Error(
                    "agentId must be provided to update favorite task chains"
                );
            }

            try {
                await apiClient.updateFavoriteTaskChainName(
                    agentId,
                    favoriteId,
                    newName
                );

                setFavorites((prev) =>
                    prev.map((favorite) =>
                        favorite.favoriteId === favoriteId
                            ? { ...favorite, name: newName }
                            : favorite
                    )
                );
            } catch (err) {
                console.error("Failed to update favorite task chain:", err);
            }
        },
        [agentId]
    );

    const updateFavoriteVisibility = useCallback(
        async (favoriteId: string, isPublic: boolean) => {
            if (!agentId) {
                throw new Error(
                    "agentId must be provided to update favorite task chains"
                );
            }

            try {
                const response =
                    await apiClient.updateFavoriteTaskChainVisibility(
                        agentId,
                        favoriteId,
                        isPublic
                    );

                if (response?.favorite) {
                    const updated = normalizeFavorite(response.favorite);
                    setFavorites((prev) =>
                        prev.map((favorite) =>
                            favorite.favoriteId === favoriteId ? updated : favorite
                        )
                    );
                    return updated;
                }

                return null;
            } catch (err) {
                console.error(
                    "Failed to update favorite task chain visibility:",
                    err
                );
                throw err instanceof Error ? err : new Error(String(err));
            }
        },
        [agentId]
    );

    const markAsUsed = useCallback(
        async (favoriteId: string) => {
            if (!agentId) {
                throw new Error(
                    "agentId must be provided to mark favorite task chains"
                );
            }

            try {
                const response = await apiClient.markFavoriteTaskChainUsed(
                    agentId,
                    favoriteId,
                    Date.now()
                );

                const updatedTimestamp = response.lastUsedAt;

                setFavorites((prev) =>
                    prev.map((favorite) =>
                        favorite.favoriteId === favoriteId
                            ? {
                                  ...favorite,
                                  lastUsedAt: updatedTimestamp,
                              }
                            : favorite
                    )
                );
            } catch (err) {
                console.error("Failed to mark favorite task chain as used:", err);
            }
        },
        [agentId]
    );

    const shareFavorite = useCallback(
        async (favoriteId: string) => {
            if (!agentId) {
                throw new Error(
                    "agentId must be provided to share favorite task chains"
                );
            }

            try {
                const response = await apiClient.shareFavoriteTaskChain(
                    agentId,
                    favoriteId
                );

                if (response?.share) {
                    return normalizeSharedTaskChain(response.share);
                }

                return null;
            } catch (err) {
                console.error("Failed to share favorite task chain:", err);
                throw err instanceof Error ? err : new Error(String(err));
            }
        },
        [agentId]
    );

    const fetchSharedChainByCode = useCallback(
        async (shareCode: string) => {
            try {
                const response = await apiClient.getSharedTaskChainByCode(
                    shareCode.toUpperCase()
                );

                if (response?.share) {
                    return normalizeSharedTaskChain(response.share);
                }

                return null;
            } catch (err) {
                console.error("Failed to fetch shared task chain:", err);
                throw err instanceof Error ? err : new Error(String(err));
            }
        },
        []
    );

    const isFavorite = useCallback(
        (chainId: string) => favorites.some((fav) => fav.id === chainId),
        [favorites]
    );

    const getFavoriteByChainId = useCallback(
        (chainId: string) => favorites.find((fav) => fav.id === chainId),
        [favorites]
    );

    const searchFavorites = useCallback(
        (query: string): FavoriteTaskChain[] => {
            if (!query.trim()) {
                return favorites;
            }

            const lowerQuery = query.toLowerCase();
            return favorites.filter((fav) =>
                fav.name.toLowerCase().includes(lowerQuery) ||
                fav.originalName.toLowerCase().includes(lowerQuery) ||
                fav.description.toLowerCase().includes(lowerQuery)
            );
        },
        [favorites]
    );

    const getFavorites = useCallback(
        (): FavoriteTaskChain[] =>
            [...favorites].sort((a, b) => b.createdAt - a.createdAt),
        [favorites]
    );

    const getFavoritesByLastUsed = useCallback(
        (): FavoriteTaskChain[] =>
            [...favorites].sort((a, b) => {
                const aTime = a.lastUsedAt || a.createdAt;
                const bTime = b.lastUsedAt || b.createdAt;
                return bTime - aTime;
            }),
        [favorites]
    );

    return {
        favorites: getFavorites(),
        isLoading,
        error,
        addFavorite,
        removeFavorite,
        updateFavoriteName,
        updateFavoriteVisibility,
        markAsUsed,
        isFavorite,
        getFavoriteByChainId,
        searchFavorites,
        getFavorites,
        getFavoritesByLastUsed,
        shareFavorite,
        fetchSharedChainByCode,
    };
}
