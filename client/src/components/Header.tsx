import { useState } from 'react';
import { Link } from 'react-router';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/contexts/AuthContext';
import { User, LogOut, CreditCard, ShoppingBag, Settings } from 'lucide-react';
import { SidebarTrigger } from '@/components/ui/sidebar';
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { UpgradeDialog } from './UpgradeDialog';
import { SettingsDialog } from './SettingsDialog';
import { useTheme } from '@/contexts/ThemeContext';
import { useSubscriptionTier } from '@/hooks/useSubscriptionTier';
import { getIconColorStyle, isGradientTier } from '@/lib/iconColors';
import { GradientUserIcon } from './GradientUserIcon';
import { MobileTocToggleButton } from './MobileTocToggleButton';
import { getUserDisplayName } from '@/lib/userDisplay';
import { useTranslation } from 'react-i18next';

export default function Header() {
  const { user, isAuthenticated, logout, isLoading } = useAuth();
  const [upgradeDialogOpen, setUpgradeDialogOpen] = useState(false);
  const [settingsDialogOpen, setSettingsDialogOpen] = useState(false);
  const { theme } = useTheme();
  const { tier } = useSubscriptionTier();
  const { t } = useTranslation();

  // Get icon color based on subscription tier and theme
  const iconColor = getIconColorStyle(tier, theme === 'dark');

  if (isLoading) {
    return (
      <div className="sticky top-0 z-20 flex justify-end items-center gap-2 p-4 border-b border-slate-300 dark:border-white/20 backdrop-blur-md bg-background/80">
        <div className="h-8 w-16 bg-muted animate-pulse rounded" />
        <div className="h-8 w-16 bg-muted animate-pulse rounded" />
      </div>
    );
  }

  return (
    <div className="sticky top-0 z-20 flex justify-between items-center gap-2 p-4 border-b border-slate-300 dark:border-white/20 backdrop-blur-md bg-background/80">
      <div className="flex items-center gap-2">
        <SidebarTrigger className="md:hidden" />
        <MobileTocToggleButton />
      </div>
      <div className="flex items-center gap-2">
      {isAuthenticated ? (
        <>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-9 px-3 gap-2"
              >
                {isGradientTier(tier) ? (
                  <GradientUserIcon className="h-4 w-4" tier={tier} />
                ) : (
                  <User className="h-4 w-4" style={iconColor} />
                )}
                <span className="text-sm max-sm:hidden">{getUserDisplayName(user)}</span>
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuItem
                className="cursor-pointer"
                onSelect={() => setUpgradeDialogOpen(true)}
              >
                <CreditCard className="h-4 w-4 mr-2" />
                <span>{t("userMenu.upgradePlan")}</span>
              </DropdownMenuItem>
              <DropdownMenuItem
                className="cursor-pointer"
                onSelect={() => setSettingsDialogOpen(true)}
              >
                <Settings className="h-4 w-4 mr-2" />
                <span>{t("userMenu.settings")}</span>
              </DropdownMenuItem>
              <DropdownMenuItem className="cursor-pointer">
                <ShoppingBag className="h-4 w-4 mr-2" />
                <span>{t("userMenu.orders")}</span>
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
                    <DialogDescription>
                      {t("userMenu.signOutDescription")}
                    </DialogDescription>
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

          {/* Upgrade Dialog */}
          <UpgradeDialog
            open={upgradeDialogOpen}
            onOpenChange={setUpgradeDialogOpen}
          />

          {/* Settings Dialog */}
          <SettingsDialog
            open={settingsDialogOpen}
            onOpenChange={setSettingsDialogOpen}
          />

        </>
      ) : (
        <>
          <Button
            variant="ghost"
            size="sm"
            asChild
            className="h-8"
          >
            <Link to="/signin">{t("common.signIn")}</Link>
          </Button>
          <Button
            size="sm"
            asChild
            className="h-8"
          >
            <Link to="/signup">{t("common.signUp")}</Link>
          </Button>
        </>
      )}
      </div>
    </div>
  );
}
