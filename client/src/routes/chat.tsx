import { useParams, useNavigate } from "react-router";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import Chat from "@/components/chat";
import type { UUID } from "@elizaos/core";
import { apiClient } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Plus, MessageSquare } from "lucide-react";
import { generateChatRoomName } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/AuthContext";
import { LoginPrompt } from "@/components/auth/LoginPrompt";
import { useTranslation } from "react-i18next";

const isPublicAccessClient = () =>
    import.meta.env.VITE_PUBLIC_ACCESS_MODE === "1";

export default function AgentRoute() {
    const { agentId, roomId } = useParams<{ agentId: UUID; roomId?: UUID }>();
    const navigate = useNavigate();
    const [isCreatingRoom, setIsCreatingRoom] = useState(false);
    const [showLoginPrompt, setShowLoginPrompt] = useState(false);
    const { toast } = useToast();
    const { isAuthenticated } = useAuth();
    const { t } = useTranslation();

    // Fetch rooms for this agent if no roomId is provided
    const { data: roomsData, isLoading } = useQuery({
        queryKey: ["rooms", agentId],
        queryFn: () => apiClient.getRooms(agentId!),
        enabled: !!agentId && !roomId,
    });

    useEffect(() => {
        if (!agentId) return;

        // If we have a roomId, we're good to go
        if (roomId) return;

        // If no roomId and rooms are loading, wait
        if (isLoading) return;

        const rooms = roomsData?.rooms || [];

        if (rooms.length > 0) {
            // Navigate to the most recent room (first in the list)
            navigate(`/chat/${agentId}/${rooms[0].id}`, { replace: true });
        } else if (!isAuthenticated && !isPublicAccessClient()) {
            // If no rooms exist and user is not authenticated, show login prompt
            setShowLoginPrompt(true);
        }
        // If no rooms exist, we'll show the empty state UI below
    }, [agentId, roomId, roomsData, isLoading, navigate, isAuthenticated]);

    const handleCreateRoom = async () => {
        if (!isAuthenticated && !isPublicAccessClient()) {
            setShowLoginPrompt(true);
            return;
        }

        setIsCreatingRoom(true);
        try {
            const roomName = generateChatRoomName();
            const result = await apiClient.createRoom(agentId!, roomName);
            if (result.success) {
                navigate(`/chat/${agentId}/${result.room.id}`, { replace: true });
                toast({
                    title: t("chat.roomCreatedTitle"),
                    description: t("chat.roomCreatedDescription", { name: result.room.name }),
                });
            } else {
                console.error("Failed to create room:", result);
                toast({
                    variant: "destructive",
                    title: t("home.createRoomFailedTitle"),
                    description: t("home.createRoomFailedDescription"),
                });
            }
        } catch (error) {
            console.error("Failed to create room:", error);
            if (error instanceof Error && error.message.includes("Authentication required")) {
                setShowLoginPrompt(true);
            }
            toast({
                variant: "destructive",
                title: t("home.createRoomFailedTitle"),
                description: error instanceof Error ? error.message : t("home.unexpectedError"),
            });
        } finally {
            setIsCreatingRoom(false);
        }
    };

    const handleAnonymousRoomCreation = async () => {
        setIsCreatingRoom(true);
        try {
            const roomName = generateChatRoomName();
            const result = await apiClient.createRoom(agentId!, roomName);
            if (result.success) {
                navigate(`/chat/${agentId}/${result.room.id}`, { replace: true });
                toast({
                    title: t("chat.anonymousRoomCreatedTitle"),
                    description: t("chat.roomCreatedDescription", { name: result.room.name }),
                });
            } else {
                console.error("Failed to create anonymous room:", result);
                toast({
                    variant: "destructive",
                    title: t("home.createRoomFailedTitle"),
                    description: t("home.createRoomFailedDescription"),
                });
            }
        } catch (error) {
            console.error("Failed to create anonymous room:", error);
            toast({
                variant: "destructive",
                title: t("home.createRoomFailedTitle"),
                description: error instanceof Error ? error.message : t("home.unexpectedError"),
            });
        } finally {
            setIsCreatingRoom(false);
            setShowLoginPrompt(false);
        }
    };

    if (!agentId) return <div>{t("chat.noAgentSpecified")}</div>;
    
    // Show loading while we determine which room to use
    if (!roomId) {
        if (isLoading) {
            return <div className="flex items-center justify-center h-full">{t("chat.loadingRoom")}</div>;
        }
        
        // Show empty state if no rooms exist
        const rooms = roomsData?.rooms || [];
        if (rooms.length === 0) {
            return (
                <>
                    <div className="flex items-center justify-center h-full">
                        <div className="text-center space-y-6 max-w-md">
                            <div className="space-y-2">
                                <MessageSquare className="h-12 w-12 mx-auto text-muted-foreground" />
                                <h2 className="text-xl font-semibold">{t("chat.noRoomsTitle")}</h2>
                                <p className="text-muted-foreground">
                                    {t("chat.noRoomsDescription")}
                                </p>
                            </div>
                            <Button 
                                onClick={handleCreateRoom}
                                disabled={isCreatingRoom}
                                className="space-x-2"
                            >
                                <Plus className="h-4 w-4" />
                                <span>{isCreatingRoom ? t("chat.creatingRoom") : t("chat.createRoom")}</span>
                            </Button>
                        </div>
                    </div>
                    {showLoginPrompt && (
                        <LoginPrompt
                            onClose={() => setShowLoginPrompt(false)}
                            onAnonymous={handleAnonymousRoomCreation}
                        />
                    )}
                </>
            );
        }
        
        return <div>{t("chat.unableToLoadRoom")}</div>;
    }

    return (
        <>
            <Chat agentId={agentId} roomId={roomId} />
            {showLoginPrompt && (
                <LoginPrompt
                    onClose={() => setShowLoginPrompt(false)}
                    onAnonymous={handleAnonymousRoomCreation}
                />
            )}
        </>
    );
}
