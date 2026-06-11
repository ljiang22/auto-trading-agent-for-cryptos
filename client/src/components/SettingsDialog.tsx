import { useState, useEffect, useRef } from 'react';
import { X, User, CreditCard, ExternalLink, Sparkles, KeyRound, Eye, EyeOff } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogPortal, DialogOverlay } from '@/components/ui/dialog';
import { Textarea } from '@/components/ui/textarea';
import { Input } from '@/components/ui/input';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { cn } from '@/lib/utils';
import { useAuth } from '@/contexts/AuthContext';
import { apiClient } from '@/lib/api';
import { useToast } from '@/hooks/use-toast';
import { useTheme } from '@/contexts/ThemeContext';
import { useSubscriptionTier } from '@/hooks/useSubscriptionTier';
import { getIconColorStyle, isGradientTier } from '@/lib/iconColors';
import { GradientUserIcon } from './GradientUserIcon';
import { TradingRiskLimitsTab } from './cex/TradingRiskLimitsTab';
import { InferredTraitsTab } from './cex/InferredTraitsTab';

// Import pricing tiers from UpgradeDialog
const pricingTiers = [
  {
    name: 'Plus',
    features: [
      'Hourly sentiment score updates (~5 minutes latency)',
      'Market insights & AI news briefs',
      'Dedicated engine for questions in cryptos',
      'Comprehensive On-Chain Data analysis and visualization',
      'Technical analysis on main cryptos and visualization',
      'Price movement prediction on main cryptos',
      'Comprehensive analysis on main cryptos',
      'Email support',
    ],
  },
  {
    name: 'Pro',
    features: [
      'Everything in Plus with even higher limits',
      'Hourly sentiment score updates with up to 2 years of historical data',
      'Longer memory and context',
      'Better models for all questions and analysis',
      'More tracked cryptos',
      'Weekly research report brief on cryptos',
      'Priority email support',
    ],
  },
  {
    name: 'Enterprise',
    features: [
      'Everything in Pro and more',
      'Hourly sentiment score updates with up to all historical data',
      '(Custom) API access',
      'Full weekly research report on cryptos',
      'Custom AI model fine-tuning & integration support',
      'Custom functionalities and design for our agent system',
      'Dedicated technical support',
    ],
  },
];

type NavigationTab = 'account' | 'payment' | 'trading' | 'trading-risk' | 'inferred-traits';

interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

type ExchangeFieldType = 'string' | 'secret';

interface ExchangeFieldDefinition {
  id: string;
  label: string;
  type: ExchangeFieldType;
  required: boolean;
  description?: string;
  placeholder?: string;
}

interface ExchangeAuthTypeDefinition {
  type: string;
  fields: ExchangeFieldDefinition[];
}

interface ExchangeRegistryEntry {
  id: string;
  name: string;
  defaultAuthType: string | null;
  authTypes: ExchangeAuthTypeDefinition[];
}

interface ExchangeAuthStatus {
  success: boolean;
  exchangeId: string;
  fieldPresent: Record<string, boolean>;
  fieldPreview: Record<string, string | null>;
  updatedAt: number | null;
  isDefault?: boolean;
}

/** exchangeId -> authType -> status (from GET /user/exchange-auths/:id?authType=) */
type ExchangeAuthsState = Record<string, Record<string, ExchangeAuthStatus | null>>;

/** exchangeId -> authType -> fieldId -> value */
type ExchangeInputFieldsState = Record<string, Record<string, Record<string, string>>>;

interface SubscriptionData {
  success: boolean;
  email: string;
  planName: 'Plus' | 'Pro' | 'Enterprise' | null;
  resolvedTier: 'free' | 'plus' | 'pro' | 'enterprise';
  primarySubscriptionId: string | null;
  primarySubscriptionNickname: string | null;
  primarySubscription: {
    id: string;
    status: string;
    cancelAtPeriodEnd: boolean;
    currentPeriodStart: number | null;
    currentPeriodEnd: number | null;
    items: Array<{
      id: string;
      priceId: string | null;
      productId: string | null;
      nickname: string | null;
      currency: string | null;
      unitAmount: number | null;
      interval: string | null;
      intervalCount: number | null;
    }>;
  } | null;
  customers: Array<{
    customerId: string;
    customerEmail: string | null;
    subscriptions: Array<{
      id: string;
      status: string;
      cancelAtPeriodEnd: boolean;
      currentPeriodStart: number | null;
      currentPeriodEnd: number | null;
      items: Array<{
        id: string;
        priceId: string | null;
        productId: string | null;
        nickname: string | null;
        currency: string | null;
        unitAmount: number | null;
        interval: string | null;
        intervalCount: number | null;
      }>;
    }>;
  }>;
}

export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps) {
  const [activeTab, setActiveTab] = useState<NavigationTab>('account');
  const [subscriptionData, setSubscriptionData] = useState<SubscriptionData | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [supportMessage, setSupportMessage] = useState('');
  const [isSubmittingSupport, setIsSubmittingSupport] = useState(false);
  const [tradingEnabled, setTradingEnabled] = useState(false);
  const [isSavingTradingEnabled, setIsSavingTradingEnabled] = useState(false);
  const [secretFieldVisibility, setSecretFieldVisibility] = useState<Record<string, boolean>>({});
  const [exchangeInputFields, setExchangeInputFields] = useState<ExchangeInputFieldsState>({});
  const [exchangeAuths, setExchangeAuths] = useState<ExchangeAuthsState>({});
  const [exchangeEditMode, setExchangeEditMode] = useState<Record<string, boolean>>({});
  const [isSavingToken, setIsSavingToken] = useState(false);
  const [isExchangeAuthsLoading, setIsExchangeAuthsLoading] = useState(false);
  const [exchanges, setExchanges] = useState<ExchangeRegistryEntry[]>([]);
  const tradingLoadRequestIdRef = useRef(0);
  const { user } = useAuth();
  const { toast } = useToast();
  const { theme } = useTheme();
  const { tier } = useSubscriptionTier();
  const isDarkMode = theme === 'dark';

  // Get icon color based on subscription tier and theme
  const iconColor = getIconColorStyle(tier, isDarkMode);
  const surfaceClass = isDarkMode
    ? 'bg-white/5 border border-white/10'
    : 'bg-white border border-slate-200 shadow-sm';
  const subtleTextClass = isDarkMode ? 'text-white/60' : 'text-slate-600';
  const headingTextClass = isDarkMode ? 'text-white' : 'text-slate-900';
  const dividerClass = isDarkMode ? 'border-white/10' : 'border-slate-200';
  // Fetch subscription data when dialog opens
  useEffect(() => {
    if (open && user?.email) {
      fetchSubscriptionData();
    }
  }, [open, user?.email]);

  const fetchSubscriptionData = async () => {
    if (!user?.email) return;

    setIsLoading(true);
    try {
      const data = await apiClient.getSubscriptionStatus(user.email);
      setSubscriptionData(data);
    } catch (error) {
      console.error('Failed to fetch subscription data:', error);
    } finally {
      setIsLoading(false);
    }
  };

  // Get current plan info
  const getPlanInfo = () => {
    const resolvedTier = subscriptionData?.resolvedTier ?? 'free';
    if (resolvedTier === 'free') {
      return {
        planName: 'Free',
        renewalDate: null,
        features: [
          'Basic crypto analysis',
          'Limited queries per day',
          'Standard response time',
        ],
      };
    }

    const subscription = subscriptionData?.primarySubscription;
    const planName =
      resolvedTier === 'enterprise'
        ? 'Enterprise'
        : resolvedTier === 'pro'
          ? 'Pro'
          : 'Plus';

    // Get features for this plan
    const planFeatures = pricingTiers.find(tier => tier.name === planName)?.features || [];

    // Format renewal date
    const renewalDate = subscription?.currentPeriodEnd
      ? new Date(subscription.currentPeriodEnd * 1000).toLocaleDateString('en-US', {
          month: 'short',
          day: 'numeric',
          year: 'numeric',
        })
      : null;

    return {
      planName: `SentiEdge ${planName}`,
      renewalDate,
      features: planFeatures,
      cancelAtPeriodEnd: subscription?.cancelAtPeriodEnd ?? false,
    };
  };

  const loadExchanges = async (requestId?: number): Promise<ExchangeRegistryEntry[]> => {
    try {
      const response = await apiClient.getExchanges();
      const list: ExchangeRegistryEntry[] =
        response?.success && Array.isArray(response.exchanges) ? response.exchanges : [];
      if (typeof requestId === 'number' && requestId !== tradingLoadRequestIdRef.current) {
        return [];
      }
      setExchanges(list);

      return list;
    } catch (error) {
      console.error('Failed to load exchanges and auth status:', error);
      if (typeof requestId === 'number' && requestId !== tradingLoadRequestIdRef.current) {
        return [];
      }
      setExchanges([]);
      setExchangeAuths({});
      return [];
    }
  };

  const refreshTradingEnabled = async () => {
    try {
      const response = await apiClient.getTradingEnabled();
      setTradingEnabled(response?.success ? Boolean(response.enabled) : false);
    } catch {
      setTradingEnabled(false);
    }
  };

  const hasDefaultExchange = () => {
    return Object.values(exchangeAuths).some((byType) =>
      Object.values(byType ?? {}).some((s) => s?.isDefault)
    );
  };

  const handleToggleTrading = async () => {
    if (isSavingTradingEnabled) return;
    const next = !tradingEnabled;

    if (next && !hasDefaultExchange()) {
      toast({
        title: 'Cannot enable trading',
        description: 'atleast configure one exchange to enable trading',
        variant: 'destructive',
      });
      return;
    }

    setIsSavingTradingEnabled(true);
    try {
      const resp = await apiClient.setTradingEnabled(next);
      setTradingEnabled(resp?.success ? Boolean(resp.enabled) : next);
    } catch (error) {
      console.error('Failed to update trading enabled:', error);
      toast({
        title: 'Error',
        description: 'Failed to update trading setting.',
        variant: 'destructive',
      });
      await refreshTradingEnabled();
    } finally {
      setIsSavingTradingEnabled(false);
    }
  };
  
  const fetchExchangeAuths = async (listOverride?: ExchangeRegistryEntry[], requestId?: number) => {
    const list = listOverride ?? exchanges;
    if (typeof requestId === 'number' && requestId !== tradingLoadRequestIdRef.current) {
      return;
    }
    setIsExchangeAuthsLoading(true);
    if (!list.length) {
      setExchangeAuths({});
      setExchangeInputFields({});
      setExchangeEditMode({});
      setIsExchangeAuthsLoading(false);
      return;
    }

    try {
      const authMap: ExchangeAuthsState = {};
      const nextInputFields: ExchangeInputFieldsState = {};

      for (const exchange of list) {
        if (typeof requestId === 'number' && requestId !== tradingLoadRequestIdRef.current) {
          return;
        }
        authMap[exchange.id] = {};
        nextInputFields[exchange.id] = {};

        try {
          const response = await apiClient.getExchangeAuths(exchange.id);
          const isDefault = response.isDefault ?? false;
          const exchangeAuthsData = 'exchangeAuths' in response ? response.exchangeAuths : null;

          const flatData =
            !exchangeAuthsData &&
            'fieldPresent' in response &&
            'fieldPreview' in response &&
            typeof (response as Record<string, unknown>).fieldPresent === 'object' &&
            typeof (response as Record<string, unknown>).fieldPreview === 'object'
              ? {
                  fieldPresent: (response as Record<string, unknown>).fieldPresent as Record<string, boolean>,
                  fieldPreview: (response as Record<string, unknown>).fieldPreview as Record<string, string | null>,
                  updatedAt: (response as Record<string, unknown>).updatedAt as number | null,
                }
              : null;

          const targetAuthType = exchange.defaultAuthType ?? exchange.authTypes[0]?.type;

          for (const option of exchange.authTypes) {
            const authType = option.type;
            const data =
              exchangeAuthsData?.[authType] ??
              (flatData && authType === targetAuthType ? flatData : null);
            if (!data) {
              authMap[exchange.id][authType] = null;
              nextInputFields[exchange.id][authType] = Object.fromEntries(
                option.fields.map((f) => [f.id, ''])
              );
              continue;
            }
            const status: ExchangeAuthStatus = {
              success: true,
              exchangeId: exchange.id,
              fieldPresent: data.fieldPresent ?? {},
              fieldPreview: data.fieldPreview ?? {},
              updatedAt: data.updatedAt ?? null,
              isDefault,
            };
            authMap[exchange.id][authType] = status;
            const fieldsForAuthType: Record<string, string> = {};
            for (const field of option.fields) {
              const key = field.id;
              const hasSaved = Boolean(status.fieldPresent[key]);
              const preview = status.fieldPreview[key];
              const hasPreview = typeof preview === 'string' && preview.length > 0;
              fieldsForAuthType[key] = hasSaved && hasPreview ? preview : '';
            }
            nextInputFields[exchange.id][authType] = fieldsForAuthType;
          }
        } catch {
          for (const option of exchange.authTypes) {
            authMap[exchange.id][option.type] = null;
            nextInputFields[exchange.id][option.type] = Object.fromEntries(
              option.fields.map((f) => [f.id, ''])
            );
          }
        }
      }

      if (typeof requestId === 'number' && requestId !== tradingLoadRequestIdRef.current) {
        return;
      }
      setExchangeAuths(authMap);
      setExchangeInputFields(nextInputFields);
      setExchangeEditMode({});
    } catch (error) {
      console.error('Failed to fetch exchange auths:', error);
      setExchangeAuths({});
      setExchangeInputFields({});
    } finally {
      setIsExchangeAuthsLoading(false);
    }
  };

  const getAuthTypeTitle = (authType: string) => {
    switch (authType) {
      case 'oauth_access_refresh_token':
        return 'OAuth tokens';
      case 'api_key_name_secret':
        return 'API Keys';
      default:
        return authType;
    }
  };

  const handleSaveExchangeAuth = async (
    exchange: { id: string; name: string },
    option: ExchangeAuthTypeDefinition
  ) => {
    if (isSavingToken) return;
    setIsSavingToken(true);
    const authType = option.type;
    try {
      const authStatus = exchangeAuths[exchange.id]?.[authType];
      const fieldPresent = authStatus?.fieldPresent ?? {};
      const fieldPreview = authStatus?.fieldPreview ?? {};
      const inputForAuthType = exchangeInputFields[exchange.id]?.[authType] ?? {};

      const allEmpty = option.fields.every((field) => {
        const rawValue = inputForAuthType[field.id] ?? '';
        return rawValue.length === 0;
      });

      const hadAnySavedForOption = option.fields.some((field) => fieldPresent[field.id]);

      // Determine operation type: delete vs save, with early validation exits.
      let shouldDelete = false;
      let payload: Record<string, string | undefined> = {};

      if (allEmpty) {
        // Either delete existing auth, or nothing to do if there was no saved auth.
        if (!hadAnySavedForOption) {
          toast({
            title: 'Nothing to save',
            description: 'Enter credentials before saving.',
            variant: 'destructive',
          });
          return;
        }
        shouldDelete = true;
      } else {
        // Build payload for non-empty fields and skip unchanged previews.
        const nextPayload: Record<string, string | undefined> = {};
        for (const field of option.fields) {
          const rawValue = inputForAuthType[field.id] ?? '';
          if (!rawValue) continue;

          const preview = fieldPreview[field.id];
          if (typeof preview === 'string' && preview.length > 0 && rawValue === preview) {
            continue;
          }

          nextPayload[field.id] = rawValue;
        }

        if (Object.keys(nextPayload).length === 0) {
          toast({
            title: 'Nothing to save',
            description: 'Enter at least one new or updated field before saving.',
            variant: 'destructive',
          });
          return;
        }

        const missingRequired = option.fields
          .filter((f) => f.required)
          .filter((f) => !(nextPayload[f.id] && nextPayload[f.id]!.length > 0) && !fieldPresent[f.id]);
        if (missingRequired.length > 0) {
          toast({
            title: 'Missing required fields',
            description: `Please provide: ${missingRequired.map((f) => f.id).join(', ')}`,
            variant: 'destructive',
          });
          return;
        }

        payload = nextPayload;
      }

      if (shouldDelete) {
        await apiClient.deleteExchangeAuths(exchange.id, authType);
        toast({
          title: 'Deleted',
          description: `${exchange.name} credentials deleted.`,
        });
      } else {
        const payloadStrings = Object.fromEntries(
          Object.entries(payload).filter(
            (e): e is [string, string] => typeof e[1] === 'string' && e[1] !== ''
          )
        ) as Record<string, string>;
        await apiClient.setExchangeAuths(exchange.id, [{ authType, ...payloadStrings }]);
        toast({
          title: 'Saved',
          description: `${exchange.name} credentials saved.`,
        });
      }

      await fetchExchangeAuths();
      await refreshTradingEnabled();
      setExchangeEditMode((prev) => ({
        ...prev,
        [exchange.id]: false,
      }));
    } catch (error) {
      console.error('Failed to save exchange credentials:', error);
      toast({
        title: 'Error',
        description: 'Failed to save credentials.',
        variant: 'destructive',
      });
    } finally {
      setIsSavingToken(false);
    }
  };

  const handleSetDefaultExchange = async (exchangeId: string, displayName: string) => {
    const statuses = exchangeAuths[exchangeId];
    const isDefault = statuses && Object.values(statuses).some((s) => s?.isDefault);
    if (isDefault) {
      return;
    }

    try {
      await apiClient.setDefaultExchange(exchangeId);
      await fetchExchangeAuths();
      await refreshTradingEnabled();
      toast({
        title: 'Default exchange updated',
        description: `${displayName} is now the default exchange.`,
      });
    } catch (error) {
      console.error('Failed to set default exchange:', error);
      toast({
        title: 'Error',
        description: 'Failed to update default exchange.',
        variant: 'destructive',
      });
    }
  };

  useEffect(() => {
    if (!open) return;
    (async () => {
      const requestId = ++tradingLoadRequestIdRef.current;
      const list = await loadExchanges(requestId);
      await fetchExchangeAuths(list, requestId);
      await refreshTradingEnabled();
    })();
  }, [open]);

  useEffect(() => {
    if (!open || activeTab !== 'trading' || isExchangeAuthsLoading) return;
    if (exchanges.length > 0) return;
    (async () => {
      const requestId = ++tradingLoadRequestIdRef.current;
      const list = await loadExchanges(requestId);
      await fetchExchangeAuths(list, requestId);
      await refreshTradingEnabled();
    })();
  }, [open, activeTab, isExchangeAuthsLoading, exchanges.length]);

  // When an exchange is in edit mode, keep inputs enabled until the user clicks outside
  // that exchange's card. Clicking outside will disable the inputs again.
  useEffect(() => {
    const isAnyEditing = Object.values(exchangeEditMode).some(Boolean);
    if (!isAnyEditing) return;

    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      if (!target) return;

      setExchangeEditMode(prev => {
        let changed = false;
        const next: Record<string, boolean> = { ...prev };

        for (const [exchangeId, isEditing] of Object.entries(prev)) {
          if (!isEditing) continue;
          const withinExchange = target.closest(`[data-exchange-id="${exchangeId}"]`);
          if (!withinExchange) {
            next[exchangeId] = false;
            changed = true;
          }
        }

        return changed ? next : prev;
      });
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [exchangeEditMode]);

  const planInfo = getPlanInfo();
  const isPaidTier = (subscriptionData?.resolvedTier ?? 'free') !== 'free';

  const navigationItems = [
    { id: 'account' as NavigationTab, label: 'Account', icon: User },
    { id: 'trading' as NavigationTab, label: 'Trading', icon: KeyRound },
    { id: 'trading-risk' as NavigationTab, label: 'Risk Limits', icon: KeyRound },
    { id: 'inferred-traits' as NavigationTab, label: 'Inferred Traits', icon: User },
    { id: 'payment' as NavigationTab, label: 'Payment', icon: CreditCard },
  ];

  const handleManageBilling = () => {
    window.open('https://billing.stripe.com/p/login/6oU5kF91H4Ztejh0k4eIw00', '_blank');
  };

  const handleSupportSubmit = async () => {
    if (!supportMessage.trim()) {
      toast({
        title: 'Please enter your message',
        description: 'Support message cannot be empty',
        variant: 'destructive',
      });
      return;
    }

    setIsSubmittingSupport(true);

    try {
      await apiClient.submitFeedback(`[Billing Support] ${supportMessage}`);
      toast({
        title: 'Message sent!',
        description: 'Our support team will get back to you soon via email.',
      });
      setSupportMessage('');
    } catch (error) {
      console.error('Failed to submit support message:', error);
      toast({
        title: 'Failed to send message',
        description: 'Please try again later or email support@sentiedge.ai directly.',
        variant: 'destructive',
      });
    } finally {
      setIsSubmittingSupport(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPortal>
        <DialogOverlay />
        <DialogPrimitive.Content
          className={cn(
            "fixed left-[50%] top-[50%] z-50 translate-x-[-50%] translate-y-[-50%]",
            "max-w-[90vw] max-h-[90vh] w-full h-full",
            "overflow-hidden rounded-3xl supports-[backdrop-filter]:backdrop-blur-lg",
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
            "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
            "data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
            "flex",
            isDarkMode
              ? "border border-white/15 bg-[#0a0e27]/85 text-white shadow-[0_30px_80px_rgba(8,7,60,0.55)] supports-[backdrop-filter]:bg-[#0a0e27]/60"
              : "border border-slate-200 bg-white/50 text-slate-900 shadow-[0_20px_60px_rgba(15,23,42,0.18)] supports-[backdrop-filter]:bg-white/50"
          )}
        >
          {/* Sidebar Navigation */}
          <div
            className={cn(
              "w-64 p-6 border-r",
              isDarkMode
                ? "bg-[#0a0e27]/50 border-white/10 text-white"
                : "bg-white/75 border-slate-200 text-slate-900"
            )}
          >
            <h2
              className={cn(
                "text-xl font-semibold mb-6",
                isDarkMode ? "text-white" : "text-slate-900"
              )}
            >
              Settings
            </h2>
            <nav className="space-y-1">
              {navigationItems.map((item) => {
                const Icon = item.icon;
                // Apply subscription color only to User icon
                const isUserIcon = item.icon === User;
                const iconStyle = isUserIcon ? iconColor : undefined;
                return (
                  <button
                    type="button"
                    key={item.id}
                    onClick={() => setActiveTab(item.id)}
                    className={cn(
                      "w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors",
                      isDarkMode
                        ? activeTab === item.id
                          ? "bg-white/10 text-white"
                          : "text-white/60 hover:text-white hover:bg-white/5"
                        : activeTab === item.id
                          ? "bg-slate-900 text-white"
                          : "text-slate-600 hover:text-slate-900 hover:bg-slate-100"
                    )}
                  >
                    {isUserIcon && isGradientTier(tier) ? (
                      <GradientUserIcon className="h-4 w-4" tier={tier} />
                    ) : (
                      <Icon className="h-4 w-4" style={iconStyle} />
                    )}
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </nav>
          </div>

          {/* Main Content */}
          <div className="flex-1 overflow-auto">
            {/* Close button */}
            <DialogClose className="absolute right-6 top-6 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none z-10">
              <X className={cn('h-6 w-6', isDarkMode ? 'text-white' : 'text-slate-500')} />
              <span className="sr-only">Close</span>
            </DialogClose>

            <div className="p-12">
              {/* Account Tab */}
              {activeTab === 'account' && (
                <div className="max-w-3xl">
                  <h1 className={cn('text-3xl font-semibold mb-8', headingTextClass)}>Account</h1>

                  {isLoading ? (
                    <div className="flex items-center justify-center py-12">
                      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-purple-600"></div>
                    </div>
                  ) : (
                    <div className="space-y-8">
                      {/* Subscription Info */}
                      <div className={cn('rounded-lg p-6', surfaceClass)}>
                        <div className="flex items-start justify-between mb-4">
                          <div>
                            <div className="flex items-center gap-2 mb-2">
                              <Sparkles className={cn('h-5 w-5', isDarkMode ? 'text-purple-400' : 'text-purple-500')} />
                              <h2 className={cn('text-xl font-semibold', headingTextClass)}>
                                {planInfo.planName}
                              </h2>
                            </div>
                            {planInfo.renewalDate && (
                              <p className={cn('text-sm', subtleTextClass)}>
                                {planInfo.cancelAtPeriodEnd
                                  ? `Your plan expires on ${planInfo.renewalDate}`
                                  : `Your plan auto-renews on ${planInfo.renewalDate}`}
                              </p>
                            )}
                          </div>
                          {isPaidTier && (
                            <Button
                              onClick={handleManageBilling}
                              variant="outline"
                              className={cn(
                                'border px-4',
                                isDarkMode
                                  ? 'bg-white/10 text-white border-white/20 hover:bg-white/20'
                                  : 'bg-white text-slate-900 border-slate-300 hover:bg-slate-100'
                              )}
                            >
                              Manage
                              <ExternalLink className="h-4 w-4 ml-2" />
                            </Button>
                          )}
                        </div>

                        {/* Plan Features */}
                        {planInfo.features.length > 0 && (
                          <div className="mt-6">
                            <p className={cn('text-sm font-medium mb-3', isDarkMode ? 'text-white/80' : 'text-slate-700')}>
                              {isPaidTier
                                ? `Thanks for subscribing to ${planInfo.planName}! Your plan includes:`
                                : 'Free plan includes:'}
                            </p>
                            <div className="space-y-2">
                              {planInfo.features.map((feature, index) => (
                                <div key={index} className="flex items-start gap-2">
                                  <div className="flex-shrink-0 mt-0.5">
                                    <div className={cn('w-4 h-4 rounded-full flex items-center justify-center', isDarkMode ? 'bg-purple-600/20' : 'bg-purple-100')}>
                                      <div className={cn('w-2 h-2 rounded-full', isDarkMode ? 'bg-purple-600' : 'bg-purple-500')}></div>
                                    </div>
                                  </div>
                                  <span className={cn('text-sm', subtleTextClass)}>{feature}</span>
                                </div>
                              ))}
                            </div>
                          </div>
                        )}

                        {/* Upgrade CTA for free users */}
                        {!isPaidTier && (
                          <div className={cn('mt-6 pt-6 border-t', dividerClass)}>
                            <Button
                              onClick={() => {
                                onOpenChange(false);
                                // Trigger upgrade dialog (you'll need to pass this as a prop)
                              }}
                              className="w-full bg-purple-600 hover:bg-purple-700 text-white"
                            >
                              Upgrade Plan
                            </Button>
                          </div>
                        )}
                      </div>

                      {/* User Info */}
                      <div className={cn('rounded-lg p-6', surfaceClass)}>
                        <h3 className={cn('text-lg font-semibold mb-4', headingTextClass)}>User Information</h3>
                        <div className="space-y-3">
                          <div>
                            <p className={cn('text-sm mb-1', isDarkMode ? 'text-white/50' : 'text-slate-500')}>Email</p>
                            <p className={cn('text-sm', headingTextClass)}>{user?.email}</p>
                          </div>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )}

              {/* Payment Tab */}
              {activeTab === 'payment' && (
                <div className="max-w-3xl">
                  <h1 className={cn('text-3xl font-semibold mb-8', headingTextClass)}>Payment</h1>

                  <div className="space-y-6">
                    {/* Billing Management */}
                    <div className={cn('rounded-lg p-6', surfaceClass)}>
                      <h3 className={cn('text-lg font-semibold mb-4', headingTextClass)}>Billing Management</h3>
                      <p className={cn('text-sm mb-4', subtleTextClass)}>
                        Manage your payment methods, billing history, and invoices through Stripe.
                      </p>
                      <Button
                        onClick={handleManageBilling}
                        className="bg-purple-600 hover:bg-purple-700 text-white"
                      >
                        Manage Billing
                        <ExternalLink className="h-4 w-4 ml-2" />
                      </Button>
                    </div>

                    {/* Help */}
                    <div className={cn('rounded-lg p-6', surfaceClass)}>
                      <h3 className={cn('text-lg font-semibold mb-4', headingTextClass)}>Need Help with Billing?</h3>
                      <p className={cn('text-sm mb-4', subtleTextClass)}>
                        Have questions about your subscription, invoices, or payment methods? Send us a message and we'll get back to you soon.
                      </p>
                      <Textarea
                        placeholder="Describe your billing question or issue..."
                        value={supportMessage}
                        onChange={(e) => setSupportMessage(e.target.value)}
                        className={cn(
                          'min-h-[120px] resize-none mb-4',
                          isDarkMode
                            ? 'bg-white/5 border-white/20 text-white placeholder:text-white/40'
                            : 'bg-white border-slate-200 text-slate-900 placeholder:text-slate-500 shadow-inner'
                        )}
                        disabled={isSubmittingSupport}
                      />
                      <Button
                        onClick={handleSupportSubmit}
                        disabled={isSubmittingSupport}
                        className="w-full bg-purple-600 hover:bg-purple-700 text-white"
                      >
                        {isSubmittingSupport ? 'Sending...' : 'Send to Support'}
                      </Button>
                    </div>
                  </div>
                </div>
              )}

              {/* Trading Tab */}
              {activeTab === 'trading' && (
                <div className="max-w-3xl">
                  <h1 className={cn('text-3xl font-semibold mb-8', headingTextClass)}>Trading</h1>

                  <div className="space-y-6">
                    <div className={cn('rounded-lg p-6', surfaceClass)}>
                      <div className="flex items-start justify-between gap-6">
                        <div>
                          <h3 className={cn('text-lg font-semibold mb-1', headingTextClass)}>Enable Trading</h3>
                          <p className={cn('text-sm', subtleTextClass)}>
                            Enable trading actions for your account. Requires a configured default exchange.
                          </p>
                        </div>
                        <div className="flex flex-col items-center gap-1">
                          <button
                            type="button"
                            disabled={isSavingTradingEnabled}
                            aria-disabled={!tradingEnabled && !hasDefaultExchange()}
                            onClick={() => {
                              if (isSavingTradingEnabled) return;
                              handleToggleTrading();
                            }}
                            className={cn(
                              'relative inline-flex h-6 w-11 items-center rounded-full border transition-colors duration-150',
                              isSavingTradingEnabled
                                ? 'bg-slate-400/20 border-slate-400/30 cursor-not-allowed opacity-70'
                                : !tradingEnabled && !hasDefaultExchange()
                                  ? 'bg-slate-400/20 border-slate-400/30 cursor-not-allowed opacity-70'
                                : tradingEnabled
                                  ? 'bg-emerald-500 border-emerald-400 shadow-[0_0_16px_-4px_rgba(16,185,129,0.6)]'
                                  : 'bg-amber-400/30 border-amber-400/70'
                            )}
                          >
                            <span
                              className={cn(
                                'inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform duration-150',
                                tradingEnabled ? 'translate-x-5' : 'translate-x-1'
                              )}
                            />
                          </button>
                          <span className={cn('text-xs font-medium', subtleTextClass)}>
                            {tradingEnabled ? 'On' : 'Off'}
                          </span>
                        </div>
                      </div>
                    </div>

                    {isExchangeAuthsLoading ? (
                      <div className={cn('rounded-lg p-6', surfaceClass)}>
                        <div className="flex items-center justify-center py-8">
                          <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-purple-600"></div>
                        </div>
                      </div>
                    ) : exchanges.length === 0 ? (
                      <div className={cn('rounded-lg p-6', surfaceClass)}>
                        <p className={cn('text-sm', subtleTextClass)}>
                          No exchanges available right now. Please try reopening settings.
                        </p>
                      </div>
                    ) : (
                    exchanges
                      .slice()
                      .sort((a, b) => {
                        const aStatuses = exchangeAuths[a.id] ?? {};
                        const bStatuses = exchangeAuths[b.id] ?? {};
                        const aIsDefault = Object.values(aStatuses).some((s) => s?.isDefault);
                        const bIsDefault = Object.values(bStatuses).some((s) => s?.isDefault);
                        if (aIsDefault !== bIsDefault) {
                          // Put the exchange with default auth first
                          return aIsDefault ? -1 : 1;
                        }
                        return a.name.localeCompare(b.name);
                      })
                      .map((exchange) => {
                        const statuses = exchangeAuths[exchange.id] ?? {};
                        const hasAnySaved = Object.values(statuses).some(
                          (s) => s && Object.values(s.fieldPresent ?? {}).some(Boolean)
                        );
                        const isDefault = Object.values(statuses).some((s) => s?.isDefault);

                        return (
                          <div
                            key={exchange.id}
                            data-exchange-id={exchange.id}
                            className={cn('rounded-lg p-6', surfaceClass)}
                          >
                            <div className="flex items-start justify-between mb-4">
                              <div>
                                <h3 className={cn('text-lg font-semibold mb-1', headingTextClass)}>{exchange.name}</h3>
                                <p className={cn('text-sm', subtleTextClass)}>
                                  Save {exchange.name} credentials here. For safety, we only show previews after saving.
                                </p>
                              </div>
                              <div className="flex items-center gap-3">
                                <div className="flex flex-col items-center gap-1">
                                  <button
                                    type="button"
                                    disabled={!hasAnySaved || isSavingToken}
                                    onClick={() => {
                                      if (!hasAnySaved || isSavingToken) return;
                                      handleSetDefaultExchange(exchange.id, exchange.name);
                                    }}
                                    className={cn(
                                      'relative inline-flex h-6 w-11 items-center rounded-full border transition-colors duration-150',
                                      !hasAnySaved
                                        ? 'bg-slate-400/20 border-slate-400/30 cursor-not-allowed opacity-50'
                                        : isDefault
                                          ? 'bg-emerald-500 border-emerald-400 shadow-[0_0_16px_-4px_rgba(16,185,129,0.6)]'
                                          : 'bg-amber-400/30 border-amber-400/70'
                                    )}
                                  >
                                    <span
                                      className={cn(
                                        'inline-block h-4 w-4 transform rounded-full bg-white shadow transition-transform duration-150',
                                        isDefault ? 'translate-x-5' : 'translate-x-1'
                                      )}
                                    />
                                  </button>
                                  <span
                                    className={cn(
                                      'text-xs font-medium',
                                      hasAnySaved ? subtleTextClass : 'opacity-50 cursor-not-allowed'
                                    )}
                                  >
                                    Default
                                  </span>
                                </div>
                              </div>
                            </div>

                          <div className="space-y-6">
                            {exchange.authTypes
                              .slice()
                              .sort((a, b) => {
                                const aIsDefault = exchange.defaultAuthType && a.type === exchange.defaultAuthType;
                                const bIsDefault = exchange.defaultAuthType && b.type === exchange.defaultAuthType;
                                if (aIsDefault === bIsDefault) return 0;
                                return aIsDefault ? -1 : 1;
                              })
                              .map((option, optionIndex) => {
                              const optionStatus = exchangeAuths[exchange.id]?.[option.type];
                              const optionHasAnySaved =
                                !!optionStatus &&
                                option.fields.some((field) => optionStatus.fieldPresent?.[field.id]);
                              return (
                                <div
                                  key={option.type}
                                  className={cn(optionIndex > 0 ? `pt-6 border-t ${dividerClass}` : '')}
                                >
                                  <div className={cn('text-sm font-medium mb-3', headingTextClass)}>
                                    {getAuthTypeTitle(option.type)}
                                    {exchange.defaultAuthType && option.type === exchange.defaultAuthType && (
                                      <span className={cn('ml-2 text-xs', subtleTextClass)}>(Default)</span>
                                    )}
                                  </div>

                                  <div className="space-y-3">
                                    {option.fields.map((field) => {
                                      const previewFromAuth = optionStatus?.fieldPreview?.[field.id] ?? null;
                                      const hasPreview =
                                        typeof previewFromAuth === 'string' && previewFromAuth.length > 0;
                                      const isEditing = !!exchangeEditMode[exchange.id];
                                      const fieldVisibilityKey = `${exchange.id}:${option.type}:${field.id}`;
                                      const showSecret =
                                        field.type === 'secret' && Boolean(secretFieldVisibility[fieldVisibilityKey]);

                                      return (
                                        <div key={field.id} className="space-y-2">
                                          <div className={cn('text-sm font-medium', headingTextClass)}>
                                            {field.label}
                                          </div>
                                          <div className="relative">
                                            <Input
                                              type={field.type === 'secret' ? (showSecret ? 'text' : 'password') : 'text'}
                                              placeholder={field.placeholder ?? ''}
                                              value={exchangeInputFields[exchange.id]?.[option.type]?.[field.id] ?? ''}
                                              onChange={(e) => {
                                                const nextValue = e.target.value;
                                                setExchangeInputFields((prev) => {
                                                  const prevForExchange = prev[exchange.id] ?? {};
                                                  const prevForAuth = prevForExchange[option.type] ?? {};
                                                  return {
                                                    ...prev,
                                                    [exchange.id]: {
                                                      ...prevForExchange,
                                                      [option.type]: { ...prevForAuth, [field.id]: nextValue },
                                                    },
                                                  };
                                                });
                                              }}
                                              onBlur={() => {
                                                if (exchangeEditMode[exchange.id]) return;
                                                if (typeof previewFromAuth === 'string' && previewFromAuth.length > 0) {
                                                  setExchangeInputFields((prev) => {
                                                    const prevForExchange = prev[exchange.id] ?? {};
                                                    const prevForAuth = prevForExchange[option.type] ?? {};
                                                    return {
                                                      ...prev,
                                                      [exchange.id]: {
                                                        ...prevForExchange,
                                                        [option.type]: { ...prevForAuth, [field.id]: previewFromAuth },
                                                      },
                                                    };
                                                  });
                                                }
                                              }}
                                              className={cn(
                                                field.type === 'secret' ? 'pr-10' : '',
                                                isDarkMode
                                                  ? 'bg-white/5 border-white/20 text-white placeholder:text-white/40'
                                                  : 'bg-white border-slate-200 text-slate-900 placeholder:text-slate-500 shadow-inner'
                                              )}
                                              disabled={isSavingToken || (hasPreview && !isEditing)}
                                            />
                                            {field.type === 'secret' && (
                                              <button
                                                type="button"
                                                onClick={() => {
                                                  setSecretFieldVisibility((prev) => ({
                                                    ...prev,
                                                    [fieldVisibilityKey]: !prev[fieldVisibilityKey],
                                                  }));
                                                }}
                                                className={cn(
                                                  'absolute right-2 top-1/2 -translate-y-1/2 p-1 rounded',
                                                  isDarkMode ? 'text-white/70 hover:text-white' : 'text-slate-500 hover:text-slate-800'
                                                )}
                                                aria-label={showSecret ? 'Hide field value' : 'Show field value'}
                                                disabled={isSavingToken}
                                              >
                                                {showSecret ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                                              </button>
                                            )}
                                          </div>
                                          {field.description && (
                                            <div className={cn('text-xs', subtleTextClass)}>{field.description}</div>
                                          )}
                                        </div>
                                      );
                                    })}

                                    <div className="flex items-center gap-3">
                                      <Button
                                        variant="outline"
                                        onClick={() => {
                                          setExchangeInputFields((prev) => {
                                            const prevForExchange = prev[exchange.id] ?? {};
                                            const cleared: Record<string, string> = {};
                                            for (const field of option.fields) {
                                              cleared[field.id] = '';
                                            }
                                            return {
                                              ...prev,
                                              [exchange.id]: {
                                                ...prevForExchange,
                                                [option.type]: cleared,
                                              },
                                            };
                                          });
                                          setExchangeEditMode((prev) => ({
                                            ...prev,
                                            [exchange.id]: true,
                                          }));
                                        }}
                                        disabled={isSavingToken || !optionHasAnySaved}
                                        className={cn(
                                          isDarkMode
                                            ? 'bg-white/10 text-white border-white/20 hover:bg-white/20'
                                            : 'bg-white text-slate-900 border-slate-300 hover:bg-slate-100'
                                        )}
                                      >
                                        Delete
                                      </Button>
                                      <Button
                                        variant="outline"
                                        onClick={() => {
                                          const isEditing = !!exchangeEditMode[exchange.id];
                                          if (!isEditing) {
                                            setExchangeEditMode((prev) => ({
                                              ...prev,
                                              [exchange.id]: true,
                                            }));
                                            return;
                                          }

                                          // Cancel edit: restore existing credentials from previews and exit edit mode
                                          const optionStatus = exchangeAuths[exchange.id]?.[option.type];
                                          const previews = optionStatus?.fieldPreview ?? {};
                                          setExchangeInputFields((prev) => {
                                            const prevForExchange = prev[exchange.id] ?? {};
                                            const restored: Record<string, string> = {};
                                            for (const field of option.fields) {
                                              const preview = previews[field.id];
                                              restored[field.id] =
                                                typeof preview === 'string' && preview.length > 0 ? preview : '';
                                            }
                                            return {
                                              ...prev,
                                              [exchange.id]: {
                                                ...prevForExchange,
                                                [option.type]: restored,
                                              },
                                            };
                                          });
                                          setExchangeEditMode((prev) => ({
                                            ...prev,
                                            [exchange.id]: false,
                                          }));
                                        }}
                                        disabled={isSavingToken || !optionHasAnySaved}
                                        className={cn(
                                          isDarkMode
                                            ? 'bg-white/10 text-white border-white/20 hover:bg-white/20'
                                            : 'bg-white text-slate-900 border-slate-300 hover:bg-slate-100'
                                        )}
                                      >
                                        {exchangeEditMode[exchange.id] ? 'Cancel' : 'Edit'}
                                      </Button>
                                      {(() => {
                                        const optionInput = exchangeInputFields[exchange.id]?.[option.type] ?? {};
                                        const hasAnyNonEmptyInput = option.fields.some(
                                          (field) => (optionInput[field.id] ?? '').length > 0
                                        );
                                        const hasChangedNonEmptyField = option.fields.some((field) => {
                                          const value = optionInput[field.id] ?? '';
                                          if (!value) return false;
                                          const preview = optionStatus?.fieldPreview?.[field.id];
                                          return !(typeof preview === 'string' && preview.length > 0 && value === preview);
                                        });
                                        const hasDeleteIntent = !hasAnyNonEmptyInput && optionHasAnySaved;
                                        const hasPendingSaveAction = hasChangedNonEmptyField || hasDeleteIntent;
                                        return (
                                          <Button
                                            onClick={() => handleSaveExchangeAuth(exchange, option)}
                                            disabled={isSavingToken}
                                            className={cn(
                                              hasPendingSaveAction
                                                ? 'bg-purple-600 hover:bg-purple-700 text-white'
                                                : isDarkMode
                                                  ? 'bg-transparent text-purple-300 border border-purple-400/70 hover:bg-purple-500/10'
                                                  : 'bg-white text-purple-700 border border-purple-500 hover:bg-purple-50'
                                            )}
                                          >
                                            {isSavingToken ? 'Saving...' : 'Save'}
                                          </Button>
                                        );
                                      })()}
                                    </div>

                                  </div>
                                </div>
                              );
                            })}

                            {/* <div
                              className={cn(
                                'text-xs leading-relaxed',
                                isDarkMode ? 'text-white/50' : 'text-slate-500'
                              )}
                            >
                              Do not paste passwords, 2FA codes, private keys, or seed phrases here.
                            </div> */}
                          </div>
                        </div>
                      );
                    }))}
                  </div>
                </div>
              )}

              {/* §7.3 — Trading Risk Limits tab */}
              {activeTab === 'trading-risk' && (
                <div className="max-w-3xl">
                  <TradingRiskLimitsTab />
                </div>
              )}

              {/* F2 — Inferred Traits tab (memory-poisoning transparency). */}
              {activeTab === 'inferred-traits' && (
                <div className="max-w-3xl">
                  <InferredTraitsTab isDarkMode={isDarkMode} />
                </div>
              )}

            </div>
          </div>
        </DialogPrimitive.Content>
      </DialogPortal>
    </Dialog>
  );
}
