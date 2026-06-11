import { useMemo } from 'react';
import type { CSSProperties } from 'react';
import { useSidebar, SidebarTrigger } from '../components/ui/sidebar';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { ProjectsSection } from '../components/hub/ProjectsSection';
import { ReportsSection } from '../components/hub/ReportsSection';
import { TrendingSection } from '../components/hub/TrendingSection';
import { Package, FileText, TrendingUp } from 'lucide-react';
import { useTranslation } from 'react-i18next';

export default function HubPage() {
  const { state, isMobile } = useSidebar();
  const { t } = useTranslation();

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

  return (
    <div
      className="flex-1 min-h-screen w-full overflow-y-auto overflow-x-hidden transition-[width] duration-300"
      style={dynamicContentWidth}
    >
      {/* Header with Sidebar Trigger - Mobile Only */}
      <div className="sticky top-0 z-20 flex items-center gap-2 px-4 py-3 border-b border-slate-300 dark:border-white/20 backdrop-blur-md bg-background/80 md:hidden">
        <SidebarTrigger />
      </div>
      {/* Main content */}
      <main className="w-full pb-12 px-4 md:px-8 lg:px-12">
        {/* Header section */}
        <section className="py-8 md:py-12">
          <div className="max-w-6xl mx-auto" style={dynamicContentWidth}>
            <div className="text-center mb-8">
              <h1 className="text-4xl md:text-5xl font-bold text-gray-900 dark:text-white mb-4">
                {t("hub.title")}
              </h1>
              <p className="text-lg text-gray-600 dark:text-gray-400 max-w-2xl mx-auto">
                {t("hub.subtitle")}
              </p>
            </div>
          </div>
        </section>

        {/* Tabs section */}
        <section className="py-4">
          <div className="max-w-6xl mx-auto" style={dynamicContentWidth}>
            <Tabs defaultValue="projects" className="w-full">
              <TabsList className="grid w-full grid-cols-3 mb-8 h-auto p-1 backdrop-blur-md bg-white/50 dark:bg-white/10 border border-slate-300 dark:border-slate-700 shadow-md rounded-lg">
                <TabsTrigger
                  value="projects"
                  className="text-sm py-1.5 gap-2 border border-transparent data-[state=active]:shadow-xl data-[state=active]:bg-white dark:data-[state=active]:bg-gray-800 data-[state=active]:border-slate-300 dark:data-[state=active]:border-slate-600 data-[state=active]:scale-x-104 data-[state=active]:scale-y-105 transition-all duration-200"
                >
                  <Package className="h-4 w-4" />
                  {t("hub.tabs.projects")}
                </TabsTrigger>
                <TabsTrigger
                  value="reports"
                  className="text-sm py-1.5 gap-2 border border-transparent data-[state=active]:shadow-xl data-[state=active]:bg-white dark:data-[state=active]:bg-gray-800 data-[state=active]:border-slate-300 dark:data-[state=active]:border-slate-600 data-[state=active]:scale-x-104 data-[state=active]:scale-y-105 transition-all duration-200"
                >
                  <FileText className="h-4 w-4" />
                  {t("hub.tabs.reports")}
                </TabsTrigger>
                <TabsTrigger
                  value="trending"
                  className="text-sm py-1.5 gap-2 border border-transparent data-[state=active]:shadow-xl data-[state=active]:bg-white dark:data-[state=active]:bg-gray-800 data-[state=active]:border-slate-300 dark:data-[state=active]:border-slate-600 data-[state=active]:scale-x-104 data-[state=active]:scale-y-105 transition-all duration-200"
                >
                  <TrendingUp className="h-4 w-4" />
                  {t("hub.tabs.trending")}
                </TabsTrigger>
              </TabsList>

              <TabsContent value="projects" className="mt-0">
                <ProjectsSection />
              </TabsContent>

              <TabsContent value="reports" className="mt-0">
                <ReportsSection />
              </TabsContent>

              <TabsContent value="trending" className="mt-0">
                <TrendingSection />
              </TabsContent>
            </Tabs>
          </div>
        </section>
      </main>
    </div>
  );
}
