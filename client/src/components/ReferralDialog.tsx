import { useState, useEffect } from 'react';
import { Copy, Check, Share2, Users } from 'lucide-react';
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useToast } from '@/hooks/use-toast';
import { apiClient } from '@/lib/api';
import { useTranslation } from 'react-i18next';

interface ReferralDialogProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

export function ReferralDialog({ open, onOpenChange }: ReferralDialogProps) {
    const [referralLink, setReferralLink] = useState('');
    const [referralCode, setReferralCode] = useState('');
    const [totalInvites, setTotalInvites] = useState(0);
    const [loading, setLoading] = useState(false);
    const [copied, setCopied] = useState(false);
    const { toast } = useToast();
    const { t } = useTranslation();

    useEffect(() => {
        if (open && !referralLink) {
            fetchReferralCode();
        }
    }, [open]);

    const fetchReferralCode = async () => {
        setLoading(true);
        try {
            const data = await apiClient.getReferralCode();
            setReferralCode(data.referralCode);
            setReferralLink(data.referralLink);
            setTotalInvites(data.totalInvites);
        } catch (error) {
            console.error('Failed to fetch referral code:', error);
            toast({
                title: t('referrals.errorTitle'),
                description: t('referrals.errorDescription'),
                variant: 'destructive',
            });
        } finally {
            setLoading(false);
        }
    };

    const copyToClipboard = async () => {
        try {
            // Modern clipboard API
            if (navigator.clipboard && window.isSecureContext) {
                await navigator.clipboard.writeText(referralLink);
            } else {
                // Fallback for older browsers or non-HTTPS
                const textArea = document.createElement('textarea');
                textArea.value = referralLink;
                textArea.style.position = 'fixed';
                textArea.style.left = '-999999px';
                textArea.style.top = '-999999px';
                document.body.appendChild(textArea);
                textArea.focus();
                textArea.select();
                document.execCommand('copy');
                textArea.remove();
            }

            setCopied(true);
            toast({
                title: t('referrals.copiedTitle'),
                description: t('referrals.copiedDescription'),
            });

            // Reset copied state after 2 seconds
            setTimeout(() => setCopied(false), 2000);
        } catch (error) {
            console.error('Failed to copy:', error);
            toast({
                title: t('referrals.copyFailedTitle'),
                description: t('referrals.copyFailedDescription'),
                variant: 'destructive',
            });
        }
    };

    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <div className="flex items-center gap-2">
                        <Share2 className="h-5 w-5 text-primary" />
                        <DialogTitle>{t('referrals.title')}</DialogTitle>
                    </div>
                    <DialogDescription>
                        {t('referrals.description')}
                    </DialogDescription>
                </DialogHeader>

                <div className="space-y-4 py-4">
                    {loading ? (
                        <div className="flex items-center justify-center py-8">
                            <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" />
                        </div>
                    ) : (
                        <>
                            {/* Referral Code Display */}
                            <div className="space-y-2">
                                <label className="text-sm font-medium text-muted-foreground">
                                    {t('referrals.codeLabel')}
                                </label>
                                <div className="flex items-center justify-center p-4 bg-muted rounded-lg">
                                    <span className="text-2xl font-bold tracking-wider text-primary">
                                        {referralCode}
                                    </span>
                                </div>
                            </div>

                            {/* Invite Stats */}
                            <div className="p-4 bg-gradient-to-r from-blue-500/10 to-purple-500/10 rounded-lg border border-blue-500/20">
                                <div className="flex items-center justify-center gap-3">
                                    <Users className="h-5 w-5 text-blue-400" />
                                    <div className="text-center">
                                        <p className="text-2xl font-bold text-foreground">
                                            {totalInvites}
                                        </p>
                                        <p className="text-sm text-muted-foreground">
                                            {t('referrals.inviteCount', { count: totalInvites })}
                                        </p>
                                    </div>
                                </div>
                            </div>

                            {/* Referral Link */}
                            <div className="space-y-2">
                                <label className="text-sm font-medium text-muted-foreground">
                                    {t('referrals.linkLabel')}
                                </label>
                                <div className="flex items-center gap-2">
                                    <Input
                                        value={referralLink}
                                        readOnly
                                        className="flex-1"
                                        onClick={(e) => (e.target as HTMLInputElement).select()}
                                    />
                                    <Button
                                        size="icon"
                                        variant="outline"
                                        onClick={copyToClipboard}
                                        className="shrink-0"
                                    >
                                        {copied ? (
                                            <Check className="h-4 w-4 text-green-500" />
                                        ) : (
                                            <Copy className="h-4 w-4" />
                                        )}
                                    </Button>
                                </div>
                            </div>

                            {/* Copy Button */}
                            <Button
                                onClick={copyToClipboard}
                                className="w-full"
                                size="lg"
                            >
                                {copied ? (
                                    <>
                                        <Check className="mr-2 h-4 w-4" />
                                        {t('common.copied')}
                                    </>
                                ) : (
                                    <>
                                        <Copy className="mr-2 h-4 w-4" />
                                        {t('referrals.copyLink')}
                                    </>
                                )}
                            </Button>

                            {/* Info Text */}
                            <p className="text-xs text-center text-muted-foreground">
                                {t('referrals.info')}
                            </p>
                        </>
                    )}
                </div>
            </DialogContent>
        </Dialog>
    );
}
