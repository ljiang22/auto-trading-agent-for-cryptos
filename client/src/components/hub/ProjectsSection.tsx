import { Package } from "lucide-react";
import { useTranslation } from "react-i18next";

export const ProjectsSection = () => {
  const { t } = useTranslation();

  return (
    <div className="w-full py-8">
      {/* Empty state - ready for future content */}
      <div className="flex flex-col items-center justify-center py-16 px-4">
        <div className="w-full max-w-md text-center space-y-4">
          <div className="w-20 h-20 mx-auto rounded-full bg-gray-100 dark:bg-gray-800 flex items-center justify-center">
            <Package className="h-10 w-10 text-gray-400 dark:text-gray-500" />
          </div>
          <h4 className="text-lg font-semibold text-gray-900 dark:text-white">
            {t("hub.projects.emptyTitle")}
          </h4>
          <p className="text-sm text-gray-600 dark:text-gray-400">
            {t("hub.projects.emptyDescription")}
          </p>
        </div>
      </div>

      {/* Grid layout ready for future project cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6 hidden">
        {/* Project cards will go here */}
      </div>
    </div>
  );
};
