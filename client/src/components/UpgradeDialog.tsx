import { useState } from 'react';
import { Check, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose, DialogPortal, DialogOverlay, DialogContent, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { cn } from '@/lib/utils';
import { useToast } from '@/hooks/use-toast';
import { useTheme } from '@/contexts/ThemeContext';
import { useTranslation } from 'react-i18next';

type BillingPeriod = 'monthly' | 'annually';

interface PricingTier {
  name: string;
  monthlyPrice: number;
  annualPrice?: number;
  description: string;
  features: string[];
  stripeLink?: string;
  stripeLinkAnnual?: string;
}

interface UpgradeDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function UpgradeDialog({ open, onOpenChange }: UpgradeDialogProps) {
  const [billingPeriod, setBillingPeriod] = useState<BillingPeriod>('monthly');
  const [enterpriseDialogOpen, setEnterpriseDialogOpen] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const { toast } = useToast();
  const { theme } = useTheme();
  const { t } = useTranslation();
  const isDarkMode = theme === 'dark';
  const pricingCardClass = isDarkMode
    ? 'rounded-3xl p-8 flex flex-col bg-white/5 border border-white/10 transition-all duration-300 hover:bg-gradient-to-br hover:from-purple-600 hover:to-purple-700 hover:scale-105 hover:border-transparent group cursor-pointer'
    : 'rounded-3xl p-8 flex flex-col bg-white border border-slate-200 shadow-sm transition-all duration-300 hover:scale-105 hover:border-purple-200 hover:shadow-lg group cursor-pointer';
  const priceMutedClass = isDarkMode ? 'text-white/60' : 'text-slate-500';
  const featureBadgeClass = isDarkMode
    ? 'w-5 h-5 rounded-full flex items-center justify-center bg-white/10 group-hover:bg-white/20 transition-colors'
    : 'w-5 h-5 rounded-full flex items-center justify-center bg-purple-100 text-purple-600 group-hover:bg-purple-200 transition-colors';
  const featureTextClass = isDarkMode ? 'text-sm text-white/80 group-hover:text-white transition-colors' : 'text-sm text-slate-600 group-hover:text-slate-800 transition-colors';
  const pricingTiers: PricingTier[] = [
    {
      name: t('upgrade.tiers.plus.name'),
      monthlyPrice: 19,
      annualPrice: 179,
      description: '',
      stripeLink: 'https://buy.stripe.com/6oU5kF91H4Ztejh0k4eIw00',
      stripeLinkAnnual: 'https://buy.stripe.com/28EaEZcdT1Nhcb9eaUeIw02',
      features: t('upgrade.tiers.plus.features', { returnObjects: true }) as string[],
    },
    {
      name: t('upgrade.tiers.pro.name'),
      monthlyPrice: 149,
      annualPrice: 1390,
      description: '',
      stripeLink: 'https://buy.stripe.com/eVq9AVb9P8bF5ML1o8eIw01',
      stripeLinkAnnual: 'https://buy.stripe.com/6oU4gB5Pv8bF6QPd6QeIw03',
      features: t('upgrade.tiers.pro.features', { returnObjects: true }) as string[],
    },
    {
      name: t('upgrade.tiers.enterprise.name'),
      monthlyPrice: 0,
      description: t('upgrade.customPricing'),
      features: t('upgrade.tiers.enterprise.features', { returnObjects: true }) as string[],
    },
  ];
  const companySizes = t('upgrade.companySizes', { returnObjects: true }) as string[];

  // Enterprise form data
  const [enterpriseForm, setEnterpriseForm] = useState({
    company_size: '',
    company_name: '',
    first_name: '',
    last_name: '',
    email: '',
    phone_number: '',
    description: '',
  });

  const calculatePrice = (tier: PricingTier) => {
    if (billingPeriod === 'annually') {
      return tier.annualPrice ?? tier.monthlyPrice * 10;
    }
    return tier.monthlyPrice;
  };

  const handleEnterpriseSubmit = async () => {
    // Validate required fields
    if (!enterpriseForm.company_size) {
      toast({
        title: t('upgrade.validation.companySizeTitle'),
        description: t('upgrade.validation.companySizeDescription'),
        variant: 'destructive',
      });
      return;
    }

    if (!enterpriseForm.company_name.trim()) {
      toast({
        title: t('upgrade.validation.companyNameTitle'),
        description: t('upgrade.validation.companyNameDescription'),
        variant: 'destructive',
      });
      return;
    }

    if (!enterpriseForm.first_name.trim()) {
      toast({
        title: t('upgrade.validation.firstNameTitle'),
        description: t('upgrade.validation.firstNameDescription'),
        variant: 'destructive',
      });
      return;
    }

    if (!enterpriseForm.last_name.trim()) {
      toast({
        title: t('upgrade.validation.lastNameTitle'),
        description: t('upgrade.validation.lastNameDescription'),
        variant: 'destructive',
      });
      return;
    }

    if (!enterpriseForm.email.trim()) {
      toast({
        title: t('upgrade.validation.emailTitle'),
        description: t('upgrade.validation.emailDescription'),
        variant: 'destructive',
      });
      return;
    }

    // Basic email validation
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(enterpriseForm.email)) {
      toast({
        title: t('upgrade.validation.invalidEmailTitle'),
        description: t('upgrade.validation.invalidEmailDescription'),
        variant: 'destructive',
      });
      return;
    }

    if (!enterpriseForm.phone_number.trim()) {
      toast({
        title: t('upgrade.validation.phoneTitle'),
        description: t('upgrade.validation.phoneDescription'),
        variant: 'destructive',
      });
      return;
    }

    setIsSubmitting(true);

    try {
      const response = await fetch('/api/enterprise-inquiry', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(enterpriseForm),
      });

      const data = await response.json();

      if (response.ok) {
        toast({
          title: t('upgrade.inquirySentTitle'),
          description: t('upgrade.inquirySentDescription'),
        });
        // Reset form
        setEnterpriseForm({
          company_size: '',
          company_name: '',
          first_name: '',
          last_name: '',
          email: '',
          phone_number: '',
          description: '',
        });
        setEnterpriseDialogOpen(false);
      } else {
        toast({
          title: t('upgrade.inquiryFailedTitle'),
          description: data.error || t('upgrade.inquiryFailedDescription'),
          variant: 'destructive',
        });
      }
    } catch (error) {
      toast({
        title: t('upgrade.inquiryFailedTitle'),
        description: t('upgrade.inquiryFailedDescription'),
        variant: 'destructive',
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPortal>
        <DialogOverlay />
        <DialogPrimitive.Content
          className={cn(
            "fixed left-[50%] top-[50%] z-50 translate-x-[-50%] translate-y-[-50%]",
            "max-w-[95vw] max-h-[95vh] w-full overflow-y-auto",
            "rounded-3xl p-0 supports-[backdrop-filter]:backdrop-blur-lg",
            "data-[state=open]:animate-in data-[state=closed]:animate-out",
            "data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
            "data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
            isDarkMode
              ? "border border-white/15 bg-[#0a0e27]/85 text-white shadow-[0_30px_80px_rgba(8,7,60,0.55)] supports-[backdrop-filter]:bg-[#0a0e27]/60"
              : "border border-slate-200 bg-white/50 text-slate-900 shadow-[0_20px_60px_rgba(15,23,42,0.18)] supports-[backdrop-filter]:bg-white/50"
          )}
        >
          {/* Close button */}
          <DialogClose className="absolute right-6 top-6 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none z-10">
            <X className={cn('h-6 w-6', isDarkMode ? 'text-white' : 'text-slate-500')} />
            <span className="sr-only">{t('common.close')}</span>
          </DialogClose>

          {/* Hidden DialogHeader for accessibility */}
          <DialogHeader className="sr-only">
            <DialogTitle>{t('upgrade.title')}</DialogTitle>
            <DialogDescription>{t('upgrade.description')}</DialogDescription>
          </DialogHeader>

          <div className={cn('p-12 space-y-12', isDarkMode ? 'text-white' : 'text-slate-900')}>
          {/* Billing toggle */}
          <div className="flex justify-center mb-12">
            <div
              className={cn(
                'inline-flex rounded-full border-2 p-1 backdrop-blur-sm',
                isDarkMode ? 'border-white/20 bg-white/5' : 'border-slate-200 bg-slate-100'
              )}
            >
              <button
                type="button"
                onClick={() => setBillingPeriod('monthly')}
                className={cn(
                  'px-6 py-2 rounded-full text-sm font-medium transition-all',
                  billingPeriod === 'monthly'
                    ? 'bg-purple-600 text-white shadow-sm'
                    : isDarkMode
                      ? 'text-white/70 hover:text-white'
                      : 'text-slate-600 hover:text-slate-900'
                )}
              >
                {t('upgrade.monthly')}
              </button>
              <button
                type="button"
                onClick={() => setBillingPeriod('annually')}
                className={cn(
                  'px-6 py-2 rounded-full text-sm font-medium transition-all',
                  billingPeriod === 'annually'
                    ? 'bg-purple-600 text-white shadow-sm'
                    : isDarkMode
                      ? 'text-white/70 hover:text-white'
                      : 'text-slate-600 hover:text-slate-900'
                )}
              >
                {t('upgrade.annually')}
              </button>
            </div>
          </div>

          {/* Pricing cards */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-8 max-w-7xl mx-auto">
            {pricingTiers.map((tier) => (
              <div
                key={tier.name}
                className={pricingCardClass}
              >
                {/* Price */}
                <div className="mb-6">
                  <div className="flex items-baseline gap-1 mb-4 h-[60px]">
                    {tier.name === t('upgrade.tiers.enterprise.name') ? (
                      <span className={cn('text-5xl font-semibold', isDarkMode ? 'text-white/90' : 'text-slate-900')}>
                        {t('upgrade.customPricing')}
                      </span>
                    ) : (
                      <>
                        <span className={cn('text-5xl font-bold', isDarkMode ? 'text-white' : 'text-slate-900')}>
                          ${calculatePrice(tier)}
                        </span>
                        <span className={priceMutedClass}>{billingPeriod === 'annually' ? t('upgrade.perYear') : t('upgrade.perMonth')}</span>
                      </>
                    )}
                  </div>
                  <h3 className={cn('text-2xl font-semibold mb-3', isDarkMode ? 'text-white' : 'text-slate-900')}>
                    {tier.name}
                  </h3>
                </div>

                {/* CTA Button */}
                <Button
                  onClick={() => {
                    if (tier.name === t('upgrade.tiers.enterprise.name')) {
                      setEnterpriseDialogOpen(true);
                    } else {
                      const link = billingPeriod === 'annually' && tier.stripeLinkAnnual
                        ? tier.stripeLinkAnnual
                        : tier.stripeLink;
                      if (link) {
                        window.open(link, '_blank');
                      }
                    }
                  }}
                  className={cn(
                    'w-full mb-6 h-12 text-base font-medium rounded-full border transition-all',
                    isDarkMode
                      ? 'bg-white/10 text-white hover:bg-white/20 border-white/20 group-hover:bg-white group-hover:text-purple-600 group-hover:border-transparent'
                      : 'bg-purple-600 text-white border-purple-600 hover:bg-purple-500'
                  )}
                >
                  {t('upgrade.getStarted')}
                </Button>

                {/* Features */}
                <div className="space-y-3 flex-1">
                  {tier.features.map((feature) => (
                    <div key={feature} className="flex items-start gap-3">
                      <div className="flex-shrink-0 mt-0.5">
                        <div className={featureBadgeClass}>
                          <Check className="w-3 h-3" />
                        </div>
                      </div>
                      <span className={featureTextClass}>{feature}</span>
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </div>
        </DialogPrimitive.Content>
      </DialogPortal>

      {/* Enterprise Contact Dialog */}
      <Dialog open={enterpriseDialogOpen} onOpenChange={setEnterpriseDialogOpen}>
        <DialogContent className="sm:max-w-2xl max-h-[90vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t('upgrade.inquiryTitle')}</DialogTitle>
            <DialogDescription>{t('upgrade.inquiryDescription')}</DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            {/* Company size and Company name */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="company-size">
                  {t('upgrade.companySize')} <span className="text-red-500">*</span>
                </Label>
                <select
                  id="company-size"
                  className="w-full px-3 py-2 border border-input bg-background rounded-md text-sm focus:outline-none focus:ring-2 focus:ring-ring"
                  value={enterpriseForm.company_size}
                  onChange={(e) => setEnterpriseForm({ ...enterpriseForm, company_size: e.target.value })}
                  required
                >
                  <option value="">{t('upgrade.companySizePlaceholder')}</option>
                  {companySizes.map((label, index) => {
                    const values = ['1-10', '11-50', '51-200', '201-500', '501-1000', '1000+'];
                    return (
                      <option key={values[index]} value={values[index]}>
                        {label}
                      </option>
                    );
                  })}
                </select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="company-name">
                  {t('upgrade.companyName')} <span className="text-red-500">*</span>
                </Label>
                <Input
                  id="company-name"
                  type="text"
                  value={enterpriseForm.company_name}
                  onChange={(e) => setEnterpriseForm({ ...enterpriseForm, company_name: e.target.value })}
                  required
                />
              </div>
            </div>

            {/* First name and Last name */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="first-name">
                  {t('upgrade.firstName')} <span className="text-red-500">*</span>
                </Label>
                <Input
                  id="first-name"
                  type="text"
                  value={enterpriseForm.first_name}
                  onChange={(e) => setEnterpriseForm({ ...enterpriseForm, first_name: e.target.value })}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="last-name">
                  {t('upgrade.lastName')} <span className="text-red-500">*</span>
                </Label>
                <Input
                  id="last-name"
                  type="text"
                  value={enterpriseForm.last_name}
                  onChange={(e) => setEnterpriseForm({ ...enterpriseForm, last_name: e.target.value })}
                  required
                />
              </div>
            </div>

            {/* Work email and Phone number */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="work-email">
                  {t('upgrade.workEmail')} <span className="text-red-500">*</span>
                </Label>
                <Input
                  id="work-email"
                  type="email"
                  placeholder={t('upgrade.workEmailPlaceholder')}
                  value={enterpriseForm.email}
                  onChange={(e) => setEnterpriseForm({ ...enterpriseForm, email: e.target.value })}
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="phone-number">
                  {t('upgrade.phoneNumber')} <span className="text-red-500">*</span>
                </Label>
                <Input
                  id="phone-number"
                  type="tel"
                  value={enterpriseForm.phone_number}
                  onChange={(e) => setEnterpriseForm({ ...enterpriseForm, phone_number: e.target.value })}
                  required
                />
              </div>
            </div>

            {/* Business needs description */}
            <div className="space-y-2">
              <Label htmlFor="business-needs">
                {t('upgrade.businessNeeds')}
              </Label>
              <Textarea
                id="business-needs"
                placeholder={t('upgrade.businessNeedsPlaceholder')}
                rows={6}
                value={enterpriseForm.description}
                onChange={(e) => setEnterpriseForm({ ...enterpriseForm, description: e.target.value })}
              />
            </div>
          </div>
          <div className="flex justify-end gap-3">
            <Button
              variant="outline"
              onClick={() => setEnterpriseDialogOpen(false)}
              disabled={isSubmitting}
            >
              {t('common.cancel')}
            </Button>
            <Button
              onClick={handleEnterpriseSubmit}
              disabled={isSubmitting}
            >
              {isSubmitting ? t('upgrade.sending') : t('common.submit')}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </Dialog>
  );
}
