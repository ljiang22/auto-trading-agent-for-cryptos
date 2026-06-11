import { useTranslation } from "react-i18next";
import { useMemo, useState, useEffect, useCallback, useRef } from 'react';
import type { CSSProperties } from 'react';
import { useNavigate } from 'react-router-dom';
import { LandingPageHero } from '../components/landing/LandingPageHero';
import { DailyAnalysis } from '../components/landing/DailyAnalysis';
import { TrendingResearch, type TrendingTaskChain } from '../components/landing/TrendingResearch';
import { AgentToolsShowcase } from '../components/landing/AgentToolsShowcase';
import { SidebarTrigger, useSidebar } from '../components/ui/sidebar';
import { FavoriteTaskChainsDialog } from '../components/FavoriteTaskChainsDialog';
import { useFavoriteTaskChains, type FavoriteTaskChain } from '../hooks/useFavoriteTaskChains';
import { ONBOARDING_DEMO_ASK_EVENT } from '../lib/onboarding';

interface AgentSummary {
  id: string;
  name?: string;
}

export default function LandingPage() {
  const navigate = useNavigate();
  const [isCreatingChat, setIsCreatingChat] = useState(false);
  const { state, isMobile } = useSidebar();
  const [defaultAgent, setDefaultAgent] = useState<AgentSummary | null>(null);
  const agentFetchPromiseRef = useRef<Promise<AgentSummary | null> | null>(null);
  const [showFavoritesDialog, setShowFavoritesDialog] = useState(false);
  const { t } = useTranslation();
  const baseServerUrl = useMemo(
    () =>
      import.meta.env.VITE_SERVER_BASE_URL ||
      window.location.origin,
    []
  );
  const favoriteTaskChains = useFavoriteTaskChains(defaultAgent?.id);
  const { markAsUsed } = favoriteTaskChains;

  const dynamicContentWidth = useMemo(() => {
    if (isMobile) {
      return undefined;
    }
    const sidebarWidthVar =
      state === 'collapsed' ? 'var(--sidebar-width-icon)' : 'var(--sidebar-width)';
    return {
      maxWidth: `calc(100vw - ${sidebarWidthVar})`,
    } as CSSProperties;
  }, [isMobile, state]);

  const containerClassName = useMemo(() => {
    const base = 'flex-1 min-h-screen w-full overflow-x-hidden transition-[width] duration-300';
    return isMobile ? `${base} overflow-y-visible` : `${base} overflow-y-auto`;
  }, [isMobile]);

  const resolveDefaultAgent = useCallback(async (): Promise<AgentSummary | null> => {
    if (defaultAgent) {
      return defaultAgent;
    }

    if (agentFetchPromiseRef.current) {
      return agentFetchPromiseRef.current;
    }

    const fetchPromise = (async () => {
      const agentsResponse = await fetch(`${baseServerUrl}/agents`);
      if (!agentsResponse.ok) {
        throw new Error('Failed to fetch agents');
      }

      const agentsData = await agentsResponse.json();
      const agents = agentsData.agents || [];

      if (agents.length === 0) {
        console.error('No agents available');
        return null;
      }

      const defaultAgentRecord: AgentSummary = agents[0];
      setDefaultAgent(defaultAgentRecord);
      return defaultAgentRecord;
    })()
      .catch((error) => {
        console.error('Failed to resolve default agent:', error);
        throw error;
      })
      .finally(() => {
        agentFetchPromiseRef.current = null;
      });

    agentFetchPromiseRef.current = fetchPromise;
    return fetchPromise;
  }, [baseServerUrl, defaultAgent]);

  useEffect(() => {
    void resolveDefaultAgent();
  }, [resolveDefaultAgent]);

  // Auto-create chat session when user submits search
  const handleSearch = useCallback(
    async (
      query: string,
      files?: File[],
      options?: { shareCode?: string; favoriteTaskChain?: FavoriteTaskChain; onboardingDemo?: boolean }
    ) => {
      if (
        !query?.trim() &&
        (!files || files.length === 0) &&
        !options?.shareCode &&
        !options?.favoriteTaskChain
      ) {
        return;
      }

      try {
        setIsCreatingChat(true);

        const defaultAgentRecord = await resolveDefaultAgent();
        if (!defaultAgentRecord) {
          console.error('No agents available');
          return;
        }

        const roomResponse = await fetch(
          `${baseServerUrl}/agents/${defaultAgentRecord.id}/rooms`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: undefined }),
            credentials: 'include',
          }
        );

        if (!roomResponse.ok) throw new Error('Failed to create room');
        const roomData = await roomResponse.json();
        const room = roomData.room;

        if (options?.onboardingDemo) {
          navigate(`/chat/${defaultAgentRecord.id}/${room.id}`, {
            state: {
              onboardingDemo: { question: query },
            },
          });
        } else {
          navigate(`/chat/${defaultAgentRecord.id}/${room.id}`, {
            state: {
              initialMessage: query,
              initialFiles: files,
              initialShareCode: options?.shareCode,
              initialFavoriteTaskChain: options?.favoriteTaskChain,
            },
          });
        }
      } catch (error) {
        console.error('Error creating chat:', error);
        navigate('/agents');
      } finally {
        setIsCreatingChat(false);
      }
    },
    [baseServerUrl, navigate, resolveDefaultAgent]
  );

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{ question?: string }>).detail;
      const question = detail?.question?.trim();
      if (!question) {
        return;
      }
      void handleSearch(question, undefined, { onboardingDemo: true });
    };

    window.addEventListener(ONBOARDING_DEMO_ASK_EVENT, handler as EventListener);
    return () => {
      window.removeEventListener(ONBOARDING_DEMO_ASK_EVENT, handler as EventListener);
    };
  }, [handleSearch]);

  const handleTaskChainClick = useCallback((chain: TrendingTaskChain) => {
    if (!chain.shareCode) {
      alert(t('landing.alerts.trendingUnavailable'));
      return;
    }

    handleSearch('', undefined, { shareCode: chain.shareCode });
  }, [handleSearch, t]);

  const handleVoiceStart = () => {
    // This will be implemented with the voice recording functionality
    // For now, just show a message
    alert(t('landing.alerts.voiceUnavailable'));
  };

  const handleFavoriteTaskChain = useCallback(async () => {
    try {
      const agent = await resolveDefaultAgent();
      if (!agent) {
        alert(t('landing.alerts.noAgents'));
        return;
      }
      setShowFavoritesDialog(true);
    } catch (error) {
      console.error('Unable to prepare favorites dialog:', error);
      alert(t('landing.alerts.favoritesUnavailable'));
    }
  }, [resolveDefaultAgent, t]);

  const handleFavoriteSelect = useCallback(
    (favorite: FavoriteTaskChain) => {
      setShowFavoritesDialog(false);
      void markAsUsed(favorite.favoriteId);
      void handleSearch('', undefined, { favoriteTaskChain: favorite });
    },
    [handleSearch, markAsUsed]
  );

  return (
    <div
      className={containerClassName}
      style={dynamicContentWidth}
    >
      {/* Mobile Header with Sidebar Trigger */}
      <div className="sticky top-0 z-20 flex items-center gap-2 px-4 py-3 border-b border-slate-300 dark:border-white/20 backdrop-blur-md bg-background/80 md:hidden">
        <SidebarTrigger data-tour="sidebar-toggle" />
      </div>

      {/* Main content */}
      <main className="w-full pb-12 px-4 md:px-8 lg:px-12">
        {/* Hero section */}
        <section className="py-16">
          <LandingPageHero
            onSearch={handleSearch}
            onVoiceStart={handleVoiceStart}
            onFavoriteTaskChain={handleFavoriteTaskChain}
            containerStyle={dynamicContentWidth}
          />
        </section>

        {/* Daily analysis section */}
        <section className="py-8 border-t border-gray-200 dark:border-gray-700">
          <DailyAnalysis
            containerStyle={dynamicContentWidth}
          />
        </section>

        {/* Trending task chains section */}
        <section className="py-8 border-t border-gray-200 dark:border-gray-700">
          <TrendingResearch
            onTaskChainClick={handleTaskChainClick}
            containerStyle={dynamicContentWidth}
          />
        </section>

        {/* Agent tools showcase section */}
        <section className="py-8 border-t border-gray-200 dark:border-gray-700">
          <AgentToolsShowcase
            containerStyle={dynamicContentWidth}
          />
        </section>

        {/* Footer */}
        <footer className="py-12 px-6 border-t border-gray-200 dark:border-gray-700">
          <div className="max-w-6xl mx-auto" style={dynamicContentWidth}>
            <div className="flex flex-col md:flex-row items-center justify-between gap-4">
              <div className="text-center md:text-left">
                <h3 className="text-xl font-bold text-gray-900 dark:text-white mb-2">
                  SentiEdge
                </h3>
                <p className="text-sm text-gray-600 dark:text-gray-400">
                  {t("landing.footer.tagline")}
                </p>
              </div>
              <div className="flex items-center gap-6">
	                <button
	                  type="button"
	                  onClick={() => navigate('/faq')}
	                  className="text-sm text-gray-600 dark:text-gray-400 hover:text-blue-600 dark:hover:text-blue-400 transition-colors duration-200"
	                >
	                  FAQ
	                </button>
              </div>
            </div>
            <div className="mt-8 text-center text-xs text-gray-500 dark:text-gray-500">
              {t("landing.footer.copyright")}
            </div>
          </div>
        </footer>
      </main>

      {defaultAgent?.id && (
        <FavoriteTaskChainsDialog
          favoritesApi={favoriteTaskChains}
          open={showFavoritesDialog}
          onOpenChange={setShowFavoritesDialog}
          onSelect={handleFavoriteSelect}
        />
      )}

      {/* Loading overlay */}
      {isCreatingChat && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
          <div className="bg-white dark:bg-gray-800 rounded-lg p-6 flex flex-col items-center gap-4">
            <div className="animate-spin rounded-full h-12 w-12 border-4 border-blue-600 border-t-transparent" />
            <p className="text-gray-900 dark:text-white font-medium">
              Starting your conversation...
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
