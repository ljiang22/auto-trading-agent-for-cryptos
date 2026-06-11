import { useQuery } from "@tanstack/react-query";
import { Cog } from "lucide-react";
import { useState, Fragment } from "react";
import PageTitle from "@/components/page-title";
import { Button } from "@/components/ui/button";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { MobileTocToggleButton } from "@/components/MobileTocToggleButton";
import {
    Card,
    CardContent,
    CardFooter,
    CardHeader,
    CardTitle,
} from "@/components/ui/card";
import { apiClient } from "@/lib/api";
import { NavLink, useNavigate } from "react-router";
import type { UUID } from "@elizaos/core";
import { formatAgentName, generateChatRoomName } from "@/lib/utils";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/AuthContext";
import { LoginPrompt } from "@/components/auth/LoginPrompt";
import { useTranslation } from "react-i18next";

export default function Home() {
    const navigate = useNavigate();
    const { toast } = useToast();
    const [creatingRoom, setCreatingRoom] = useState<string | null>(null);
    const [pendingAgentId, setPendingAgentId] = useState<string | null>(null);
    const { isAuthenticated } = useAuth();
    const [showLoginPrompt, setShowLoginPrompt] = useState(false);
    const { t } = useTranslation();

    const query = useQuery({
        queryKey: ["agents"],
        queryFn: () => apiClient.getAgents(),
        // Agent list rarely changes; refetching every 5s wastes mobile bandwidth.
        // 5-min stale window matches what the sidebar already does.
        staleTime: 5 * 60 * 1000,
        refetchOnWindowFocus: false,
    });

    const agents = query?.data?.agents;

    const fetchExistingRooms = async (agentId: string) => {
        try {
            const result = await apiClient.getRooms(agentId);
            return result?.rooms ?? [];
        } catch (error) {
            console.error("Failed to load rooms before creating: ", error);
            return [];
        }
    };

    const createAndEnterRoom = async (agentId: string): Promise<boolean> => {
        setCreatingRoom(agentId);
        try {
            const roomName = generateChatRoomName();
            const result = await apiClient.createRoom(agentId, roomName);
            if (result.success) {
                navigate(`/chat/${agentId}/${result.room.id}`);
                return true;
            }

            toast({
                variant: "destructive",
                title: t("home.createRoomFailedTitle"),
                description: t("home.createRoomFailedDescription"),
            });
            return false;
        } catch (error) {
            if (error instanceof Error && error.message.includes("Authentication required")) {
                setPendingAgentId(agentId);
                setShowLoginPrompt(true);
            }
            toast({
                variant: "destructive",
                title: t("home.createRoomFailedTitle"),
                description: error instanceof Error ? error.message : t("home.unexpectedError"),
            });
            return false;
        } finally {
            setCreatingRoom(null);
        }
    };

    const startChatForAgent = async (agentId: string) => {
        const existingRooms = await fetchExistingRooms(agentId);
        if (existingRooms.length > 0) {
            navigate(`/chat/${agentId}/${existingRooms[0].id}`);
            return;
        }

        await createAndEnterRoom(agentId);
    };

    const handleStartChat = async (agentId: string) => {
        if (!isAuthenticated) {
            setPendingAgentId(agentId);
            setShowLoginPrompt(true);
            return;
        }

        await startChatForAgent(agentId);
    };

    const handleContinueWithoutLogin = async () => {
        if (!pendingAgentId) {
            setShowLoginPrompt(false);
            return;
        }

        const agentId = pendingAgentId;
        setShowLoginPrompt(false);
        const rooms = await fetchExistingRooms(agentId);
        if (rooms.length > 0) {
            navigate(`/chat/${agentId}/${rooms[0].id}`);
            setPendingAgentId(null);
            return;
        }

        const success = await createAndEnterRoom(agentId);
        if (success) {
            setPendingAgentId(null);
        }
    };

    return (
        <Fragment>
        <div className="flex flex-col gap-4 h-full">
            {/* Header with Sidebar Trigger */}
            <div className="sticky top-0 z-20 flex items-center gap-4 px-4 pt-4 bg-background">
                <SidebarTrigger data-tour="sidebar-toggle" className="md:hidden" />
                <MobileTocToggleButton />
                <PageTitle title={t("home.title")} />
            </div>
            <div className="px-4 pb-4">
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                {agents?.map((agent: { id: UUID; name: string }) => (
                    <Card key={agent.id}>
                        <CardHeader>
                            <CardTitle>{agent?.name}</CardTitle>
                        </CardHeader>
                        <CardContent>
                            <div className="rounded-md bg-muted aspect-square w-full grid place-items-center">
                                <div className="text-6xl font-bold uppercase">
                                    {formatAgentName(agent?.name)}
                                </div>
                            </div>
                        </CardContent>
                        <CardFooter>
                            <div className="flex items-center gap-4 w-full">
                                <Button
                                    variant="outline"
                                    className="w-full grow"
                                    onClick={() => handleStartChat(agent.id)}
                                    disabled={creatingRoom === agent.id}
                                >
                                    {creatingRoom === agent.id ? t("home.creating") : t("home.chat")}
                                </Button>
                                <NavLink
                                    to={`/settings/${agent.id}`}
                                    key={agent.id}
                                >
                                    <Button size="icon" variant="outline">
                                        <Cog />
                                    </Button>
                                </NavLink>
                            </div>
                        </CardFooter>
                    </Card>
                ))}
            </div>
            </div>
        </div>
        {showLoginPrompt && (
            <LoginPrompt
                onClose={() => {
                    setShowLoginPrompt(false);
                    setPendingAgentId(null);
                }}
                onAnonymous={handleContinueWithoutLogin}
            />
        )}
        </Fragment>
    );
}
