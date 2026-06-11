import type React from 'react';
import { useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { toast } from 'sonner';
import { ArrowLeft } from 'lucide-react';
import { API_BASE_URL, API_ENDPOINTS } from '@/lib/constants';
import { ANALYTICS_API_BASE_URL } from '@/lib/api';
import { useTheme } from '@/contexts/ThemeContext';
import { useTranslation } from 'react-i18next';

export default function SignUpForm() {
  const [email, setEmail] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const referralCode = searchParams.get('ref') || '';
  const { theme } = useTheme();
  const { t } = useTranslation();
  const iconSrc = theme === 'light' ? '/sentiedge-icon.jpg' : '/sentiedge-icon.png';

  const syncEnrollmentToLocal = async (payload: { email: string; referral_code?: string }) => {
    const localResponse = await fetch(`${ANALYTICS_API_BASE_URL}${API_ENDPOINTS.AUTH.SIGNUP_TOKEN}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      credentials: 'omit',
      body: JSON.stringify(payload),
    });

    if (!localResponse.ok) {
      const fallbackMessage = `Local sync failed with status ${localResponse.status}`;
      try {
        const errorData = await localResponse.json();
        throw new Error(errorData?.message || fallbackMessage);
      } catch {
        throw new Error(fallbackMessage);
      }
    }
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setIsLoading(true);

    const promise = new Promise<string>(async (resolve, reject) => {
      try {
        const requestBody: { email: string; referral_code?: string } = { email };
        if (referralCode) {
          requestBody.referral_code = referralCode;
        }

        const response = await fetch(`${API_BASE_URL}${API_ENDPOINTS.AUTH.SIGNUP_TOKEN}`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          credentials: 'omit',
          body: JSON.stringify(requestBody)
        });

        const responseData = await new Promise(resolve => 
          setTimeout(() => resolve(response.json()), 1200)
        );

        if (response.status === 201) {
          let successMessage = (responseData as any).message || t('auth.signUp.linkSent');
          try {
            await syncEnrollmentToLocal(requestBody);
          } catch (localSyncError) {
            console.error('Local enrollment sync failed:', localSyncError);
            successMessage += t('auth.signUp.localSyncFailedSuffix');
          }
          resolve(successMessage);
        } else {
          reject((responseData as any).message || t('auth.signUp.sendLinkFailed'));
        }
      } catch (error) {
        reject(t('auth.signUp.networkError'));
      }
    });

    toast.promise(promise, {
      loading: t('auth.signUp.sendLinkLoading'),
      duration: 6000,
      success: (message) => message,
      error: (error) => {
        console.error('Sign up error:', error);
        return error;
      },
    });

    setIsLoading(false);
  };

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader className="space-y-1 text-center">
          <div className="flex justify-start mb-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => navigate('/')}
              className="flex items-center gap-2"
            >
              <ArrowLeft className="h-4 w-4" />
              {t("common.backToChat")}
            </Button>
          </div>
          <div className="mx-auto mb-4">
            <img
              src={iconSrc}
              alt="SentiEdge"
              className="h-12 w-12 mx-auto"
            />
          </div>
          <CardTitle className="text-2xl font-bold">{t("auth.signUp.title")}</CardTitle>
          <p className="text-sm text-muted-foreground">
            {t("auth.signUp.subtitle")}
          </p>
          {referralCode && (
            <p className="text-sm text-green-500 font-medium mt-2">
              {"✓ "}
              {t("auth.signUp.referralApplied", { code: referralCode })}
            </p>
          )}
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="email">{t("common.emailAddress")}</Label>
              <Input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                placeholder={t("auth.signUp.placeholder")}
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={isLoading}
              />
            </div>

            <Button
              type="submit"
              className="w-full"
              disabled={isLoading}
            >
              {isLoading ? t("auth.signUp.submitting") : t("auth.signUp.submit")}
            </Button>
          </form>

          <div className="mt-6 text-center text-sm">
            <span className="text-muted-foreground">{t("auth.signUp.alreadyMember")} </span>
            <Link
              to="/signin"
              className="text-primary hover:underline font-medium"
            >
              {t("auth.signUp.switchToSignIn")}
            </Link>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
