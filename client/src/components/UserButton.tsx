import { Suspense, lazy, useState } from 'react';
import { Link, useLocation } from 'react-router';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/contexts/AuthContext';

// §7.9 — Notification bell. Moved here from the App-level fixed mount so it
// sits inside the same flex container as the Share button and the user-info
// chip. Auth-only (the endpoint requires auth), so co-locating with the
// authenticated `UserButton` branch tracks the right lifetime.
const NotificationCenter = lazy(() =>
  import('./NotificationCenter').then((m) => ({ default: m.NotificationCenter })),
);
import {
  User,
  LogOut,
  CreditCard,
  ShoppingBag,
  Settings,
  Sun,
  Moon,
  Upload,
} from 'lucide-react';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
  DialogClose,
} from '@/components/ui/dialog';
import { UpgradeDialog } from './UpgradeDialog';
import { useTheme } from '@/contexts/ThemeContext';
import { SettingsDialog } from './SettingsDialog';
import { useSubscriptionTier } from '@/hooks/useSubscriptionTier';
import { getIconColorStyle, isGradientTier } from '@/lib/iconColors';
import { GradientUserIcon } from './GradientUserIcon';
import { getUserDisplayName } from '@/lib/userDisplay';
import { useTranslation } from 'react-i18next';
import { ShareDialog } from './ShareDialog';
import { useToast } from '@/hooks/use-toast';

export function UserButton() {
  const { user, isAuthenticated, logout, isLoading } = useAuth();
  const [upgradeDialogOpen, setUpgradeDialogOpen] = useState(false);
  const [settingsDialogOpen, setSettingsDialogOpen] = useState(false);
  const [shareDialogOpen, setShareDialogOpen] = useState(false);
  const location = useLocation();
  const { theme, setTheme } = useTheme();
  const { tier } = useSubscriptionTier();
  const { t } = useTranslation();
  const { toast } = useToast();

  // Get icon color based on subscription tier and theme
  const iconColor = getIconColorStyle(tier, theme === 'dark');
  const handleShareClick = () => {
    if (typeof window === 'undefined') {
      return;
    }

    if (!sharedChatContext.agentId || !sharedChatContext.roomId) {
      toast({
        title: 'Start a chat to share',
        description: 'Open a chat room first, then click Share to export a link or image.',
      });
      return;
    }

    setShareDialogOpen(true);
    window.dispatchEvent(new CustomEvent('sentiedge:share:clicked'));
  };

  const sharedChatContext = (() => {
    const match = location.pathname.match(/^\/chat\/([^/]+)\/([^/]+)/);
    if (!match) return { agentId: undefined, roomId: undefined };
    return { agentId: match[1], roomId: match[2] };
  })();

  if (
    location.pathname.startsWith('/shared/chat/') ||
    location.pathname.startsWith('/shared/room/')
  ) {
    return null;
  }

  if (isLoading) {
    return (
      <div className="fixed top-2 right-4 z-50 max-sm:top-0 max-sm:right-2">
        <div className="h-9 w-24 bg-muted animate-pulse rounded backdrop-blur-md" />
      </div>
    );
  }

  if (!isAuthenticated || !user) {
    return (
      <div className="fixed top-2 right-4 z-50 max-sm:top-0 max-sm:right-2 flex gap-2">
        <Button
          variant="ghost"
          size="sm"
          asChild
          className="h-9 px-3 backdrop-blur-md bg-white/50 dark:bg-white/10 border border-slate-200 dark:border-white/20 hover:bg-white/70 dark:hover:bg-white/20 hover:border-slate-300 dark:hover:border-white/30 transition-all shadow-md text-slate-900 dark:text-white"
        >
          <Link to="/signin">{t("userMenu.guest.signIn")}</Link>
        </Button>
        <Button
          size="sm"
          asChild
          className="h-9 px-3 backdrop-blur-md bg-blue-500/90 dark:bg-blue-600/90 border border-blue-600 dark:border-blue-500 hover:bg-blue-600 dark:hover:bg-blue-700 transition-all shadow-md text-white"
        >
          <Link to="/signup">{t("userMenu.guest.signUp")}</Link>
        </Button>
      </div>
    );
  }

  return (
    <>
      {/* Floating user button with glassmorphism */}
      <div className="fixed top-2 right-4 z-50 max-sm:top-0 max-sm:right-2 flex items-center gap-2">
        <Button
          variant="ghost"
          size="sm"
          data-tour="chat-share"
          className="h-9 px-3 gap-2 backdrop-blur-md bg-white/50 dark:bg-white/10 border border-slate-200 dark:border-white/20 hover:bg-white/70 dark:hover:bg-white/20 hover:border-slate-300 dark:hover:border-white/30 transition-all shadow-md text-slate-900 dark:text-white"
          onClick={handleShareClick}
        >
          <Upload className="h-4 w-4" />
          <span className="text-sm">Share</span>
        </Button>
        {/* Notification bell — same chrome (glass + border + h-9) as
            neighboring buttons. Lazy-loaded so the initial bundle stays
            slim; the placeholder reserves the slot width so the row
            doesn't jump on first paint. */}
        <Suspense
          fallback={
            <div
              className="h-9 w-9 rounded-md border border-slate-200 dark:border-white/20 bg-white/30 dark:bg-white/5"
              aria-hidden="true"
            />
          }
        >
          <NotificationCenter triggerClassName="relative inline-flex items-center justify-center h-9 w-9 rounded-md backdrop-blur-md bg-white/50 dark:bg-white/10 border border-slate-200 dark:border-white/20 hover:bg-white/70 dark:hover:bg-white/20 hover:border-slate-300 dark:hover:border-white/30 transition-all shadow-md text-slate-900 dark:text-white" />
        </Suspense>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              data-tour="user-menu"
              className="h-9 px-3 gap-2 backdrop-blur-md bg-white/50 dark:bg-white/10 border border-slate-200 dark:border-white/20 hover:bg-white/70 dark:hover:bg-white/20 hover:border-slate-300 dark:hover:border-white/30 transition-all shadow-md text-slate-900 dark:text-white"
            >
              {isGradientTier(tier) ? (
                <GradientUserIcon className="h-4 w-4" tier={tier} />
              ) : (
                <User className="h-4 w-4" style={iconColor} />
              )}
              <span className="text-sm max-sm:hidden">{getUserDisplayName(user)}</span>
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56 backdrop-blur-md bg-white/50 dark:bg-gray-900/80 border border-slate-200 dark:border-white/20 shadow-xl text-slate-900 dark:text-white">
            <DropdownMenuItem
              className="cursor-pointer"
              onSelect={() => setUpgradeDialogOpen(true)}
            >
              <CreditCard className="h-4 w-4 mr-2" />
              <span>{t("userMenu.upgradePlan")}</span>
            </DropdownMenuItem>
            <DropdownMenuItem
              className="cursor-pointer"
              onSelect={() => setTheme('light')}
            >
              <Sun className="h-4 w-4 mr-2" />
              <span>{t("userMenu.lightMode")}</span>
              {theme === 'light' && <span className="ml-auto text-xs">✓</span>}
            </DropdownMenuItem>
            <DropdownMenuItem
              className="cursor-pointer"
              onSelect={() => setTheme('dark')}
            >
              <Moon className="h-4 w-4 mr-2" />
              <span>{t("userMenu.darkMode")}</span>
              {theme === 'dark' && <span className="ml-auto text-xs">✓</span>}
            </DropdownMenuItem>
            <DropdownMenuItem className="cursor-pointer">
              <ShoppingBag className="h-4 w-4 mr-2" />
              <span>{t("userMenu.orders")}</span>
            </DropdownMenuItem>
            <DropdownMenuItem
              className="cursor-pointer"
              onSelect={() => setSettingsDialogOpen(true)}
            >
              <Settings className="h-4 w-4 mr-2" />
              <span>{t("userMenu.settings")}</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <Dialog>
              <DialogTrigger asChild>
                <DropdownMenuItem
                  onSelect={(e) => e.preventDefault()}
                  className="cursor-pointer text-red-600 focus:text-red-600"
                >
                  <LogOut className="h-4 w-4 mr-2" />
                  <span>{t("userMenu.signOut")}</span>
                </DropdownMenuItem>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>{t("userMenu.signOutTitle")}</DialogTitle>
                  <DialogDescription>{t("userMenu.signOutDescription")}</DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <DialogClose asChild>
                    <Button variant="outline">{t("common.cancel")}</Button>
                  </DialogClose>
                  <DialogClose asChild>
                    <Button onClick={() => { void logout(); }}>{t("userMenu.signOut")}</Button>
                  </DialogClose>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <UpgradeDialog open={upgradeDialogOpen} onOpenChange={setUpgradeDialogOpen} />
      <SettingsDialog open={settingsDialogOpen} onOpenChange={setSettingsDialogOpen} />
      <ShareDialog
        open={shareDialogOpen}
        onOpenChange={setShareDialogOpen}
        context={sharedChatContext}
      />
    </>
  );
}
