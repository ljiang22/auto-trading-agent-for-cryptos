import { useTranslation } from "react-i18next";
import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { toast } from 'sonner';
import { ArrowLeft } from 'lucide-react';
import { API_BASE_URL, API_ENDPOINTS, COUNTRIES } from '@/lib/constants';
import { ANALYTICS_API_BASE_URL } from '@/lib/api';
import { useTheme } from '@/contexts/ThemeContext';
import { ONBOARDING_PENDING_EMAIL_KEY } from '@/lib/onboarding';

const FAIL_REDIRECT_URL = '/signup';
const SUCCESS_REDIRECT_URL = '/signin';

interface FormData {
  dob: string;
  first_name: string;
  middle_name: string;
  last_name: string;
  institution: string;
  job_title: string;
  phone_number: string;
  email: string;
  password: string;
  password2: string;
  phone_country_code: string;
}

function displayErrorMessages(
  errorJson: Record<string, Array<{ message: string }>>,
  prefix: (field: string, message: string) => string
) {
  Object.keys(errorJson).forEach(key => {
    const groupedMessage = errorJson[key].map(error => error.message).join(' ');
    toast.error(prefix(key.toUpperCase(), groupedMessage), {
      duration: 12000,
    });
  });
}

async function syncRegistrationToLocal(payload: {
  email: string;
  referral_code?: string;
  user_id?: string;
}) {
  const response = await fetch(
    `${ANALYTICS_API_BASE_URL}/authentication/registration-completed/`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      credentials: 'omit',
      body: JSON.stringify(payload),
    }
  );

  if (!response.ok) {
    const fallbackMessage = `Local registration sync failed with status ${response.status}`;
    try {
      const errorData = await response.json();
      throw new Error(errorData?.error || fallbackMessage);
    } catch {
      throw new Error(fallbackMessage);
    }
  }
}

export default function RegistrationForm() {
  const { regToken } = useParams<{ regToken: string }>();
  const navigate = useNavigate();
  const { theme } = useTheme();
  const { t } = useTranslation();
  const iconSrc = theme === 'light' ? '/sentiedge-icon.jpg' : '/sentiedge-icon.png';
  const referralAutoFilledRef = useRef(false);

  const [validToken, setValidToken] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [formData, setFormData] = useState<FormData>({
    dob: '',
    first_name: '',
    middle_name: '',
    last_name: '',
    institution: '',
    job_title: '',
    phone_number: '',
    email: '',
    password: '',
    password2: '',
    phone_country_code: COUNTRIES[0].dialCode,
  });

  useEffect(() => {
    const checkToken = async () => {
      if (!regToken) {
        toast.error(t('auth.register.invalidLink'));
        navigate(FAIL_REDIRECT_URL);
        return;
      }

      // Backdoor for testing - bypass validation for test token
      if (regToken === 'test-backdoor') {
        setValidToken(true);
        toast.info(t('auth.register.testMode'), { duration: 3000 });
        return;
      }

      try {
        const response = await fetch(`${API_BASE_URL}${API_ENDPOINTS.AUTH.SIGNUP_CREATE}${regToken}/`, {
          method: 'GET',
          headers: {
            'Content-Type': 'application/json',
          },
          credentials: 'omit',
        });

        if (!response.ok) {
          toast.error(t('auth.register.invalidLink'));
          setValidToken(false);
          navigate(FAIL_REDIRECT_URL);
        } else {
          const data = await response.json();
          setValidToken(true);

          const nextValues: Partial<FormData> = {};
          if (data.email) {
            nextValues.email = data.email;
          }
          if (data.referral_code) {
            nextValues.job_title = data.referral_code;
            referralAutoFilledRef.current = true;
          }
          if (Object.keys(nextValues).length > 0) {
            setFormData(prev => ({
              ...prev,
              ...nextValues
            }));
          }
        }
      } catch (error) {
        toast.error(t('auth.register.verifyError'));
        navigate(FAIL_REDIRECT_URL);
      }
    };

    checkToken();
  }, [regToken, navigate, t]);

  useEffect(() => {
    const email = formData.email.trim();
    if (!email) return;
    const isValidEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
    if (!isValidEmail) return;

    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(
          `${API_BASE_URL}${API_ENDPOINTS.AUTH.REFERRAL_LOOKUP}?email=${encodeURIComponent(email)}`,
          {
            method: 'GET',
            headers: {
              'Content-Type': 'application/json',
            },
            credentials: 'omit',
            signal: controller.signal,
          }
        );

        if (!response.ok) return;
        const data = await response.json();
        if (!data?.referral_code) return;

        setFormData(prev => {
          if (prev.job_title && !referralAutoFilledRef.current) {
            return prev;
          }
          if (prev.job_title === data.referral_code) {
            return prev;
          }
          return {
            ...prev,
            job_title: data.referral_code
          };
        });
        referralAutoFilledRef.current = true;
      } catch (error) {
        if ((error as any)?.name !== 'AbortError') {
          console.error('Referral lookup error:', error);
        }
      }
    }, 500);

    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [formData.email]);

  const handleInputChange = (field: keyof FormData) => (
    e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>
  ) => {
    setFormData(prev => ({ ...prev, [field]: e.target.value }));
  };

  const handleReferralChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    referralAutoFilledRef.current = false;
    setFormData(prev => ({ ...prev, job_title: e.target.value }));
  };

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setIsLoading(true);

    if (formData.password !== formData.password2) {
      toast.error(t('auth.register.passwordMismatch'));
      setIsLoading(false);
      return;
    }

    // Replace empty optional fields with default values
    const submissionData = {
      ...formData,
      dob: formData.dob || "1900-01-01",
      first_name: formData.first_name || "12345",
      middle_name: formData.middle_name || "12345",
      last_name: formData.last_name || "12345",
      institution: formData.institution || "12345",
      job_title: formData.job_title || "12345",
      phone_number: formData.phone_number || "12345",
    };

    try {
      const response = await fetch(`${API_BASE_URL}${API_ENDPOINTS.AUTH.SIGNUP_CREATE}${regToken}/`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        credentials: 'omit',
        body: JSON.stringify(submissionData),
      });

      const responseData = await response.json();

      if (response.status !== 201) {
        displayErrorMessages(responseData, (field, message) =>
          t('auth.register.fieldError', { field, message })
        );
        return;
      }

      const normalizedEmail = formData.email.trim().toLowerCase();
      const rawReferralCode = formData.job_title.trim();
      const referralCodeForLocal = rawReferralCode && rawReferralCode !== '12345'
        ? rawReferralCode
        : undefined;
      const userIdCandidates = [
        (responseData as any)?.user_id,
        (responseData as any)?.id,
        (responseData as any)?.user?.id,
      ];
      const userIdForLocal = userIdCandidates.find(
        (value): value is string => typeof value === 'string' && value.trim().length > 0
      );

      try {
        await syncRegistrationToLocal({
          email: normalizedEmail,
          ...(referralCodeForLocal ? { referral_code: referralCodeForLocal } : {}),
          ...(userIdForLocal ? { user_id: userIdForLocal } : {}),
        });
      } catch (localSyncError) {
        console.error('Local registration sync failed:', localSyncError);
        toast.error(t('auth.register.localSyncFailed'));
      }

      try {
        window.localStorage.setItem(ONBOARDING_PENDING_EMAIL_KEY, normalizedEmail);
      } catch {
        // ignore storage failures (private mode, blocked, etc.)
      }

      toast.success('Registration successful! Please sign in.', { duration: 8000 });
      navigate(SUCCESS_REDIRECT_URL);
    } catch (error) {
      toast.error(`Registration error: ${error}`, { duration: 8000 });
    } finally {
      setIsLoading(false);
    }
  };

  if (!validToken) {
    return (
      <div className="flex min-h-screen items-center justify-center p-4">
        <Card className="w-full max-w-md">
          <CardContent className="pt-6">
            <div className="text-center">
              <p>{t('auth.register.verifying')}</p>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-2xl">
        <CardHeader className="text-center">
          <div className="flex justify-start mb-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => navigate('/')}
              className="flex items-center gap-2"
            >
              <ArrowLeft className="h-4 w-4" />
              {t('common.backToChat')}
            </Button>
          </div>
          <div className="mx-auto mb-4">
            <img
              src={iconSrc}
              alt="SentiEdge"
              className="h-12 w-12 mx-auto"
            />
          </div>
          <CardTitle className="text-3xl font-bold">{t('auth.register.title')}</CardTitle>
          <p className="text-muted-foreground">{t('auth.register.subtitle')}</p>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-6">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <Label htmlFor="first-name" className="text-muted-foreground">
                  {t('auth.register.firstName')} <span className="text-xs italic">{t('auth.register.optional')}</span>
                </Label>
                <Input
                  id="first-name"
                  type="text"
                  value={formData.first_name}
                  onChange={handleInputChange('first_name')}
                  disabled={isLoading}
                />
              </div>
              <div>
                <Label htmlFor="middle-name" className="text-muted-foreground">
                  {t('auth.register.middleName')} <span className="text-xs italic">{t('auth.register.optional')}</span>
                </Label>
                <Input
                  id="middle-name"
                  type="text"
                  value={formData.middle_name}
                  onChange={handleInputChange('middle_name')}
                  disabled={isLoading}
                />
              </div>
              <div>
                <Label htmlFor="last-name" className="text-muted-foreground">
                  {t('auth.register.lastName')} <span className="text-xs italic">{t('auth.register.optional')}</span>
                </Label>
                <Input
                  id="last-name"
                  type="text"
                  value={formData.last_name}
                  onChange={handleInputChange('last_name')}
                  disabled={isLoading}
                />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
              <div>
                <Label htmlFor="Date-of-Birth" className="text-muted-foreground">
                  {t('auth.register.dob')} <span className="text-xs italic">{t('auth.register.optional')}</span>
                </Label>
                <Input
                  id="dob"
                  type="text"
                  placeholder={t('auth.register.dobPlaceholder')}
                  value={formData.dob}
                  onChange={handleInputChange('dob')}
                  disabled={isLoading}
                />
              </div>
              <div className="md:col-span-2">
                <Label htmlFor="institution" className="text-muted-foreground">
                  {t('auth.register.company')} <span className="text-xs italic">{t('auth.register.optional')}</span>
                </Label>
                <Input
                  id="institution"
                  type="text"
                  value={formData.institution}
                  onChange={handleInputChange('institution')}
                  disabled={isLoading}
                />
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <Label htmlFor="job-title" className="text-muted-foreground">
                  {t('auth.register.referralCode')} <span className="text-xs italic">{t('auth.register.optional')}</span>
                  {formData.job_title && (
                    <span className="text-green-500 text-xs ml-2">✓</span>
                  )}
                </Label>
                <Input
                  id="job-title"
                  type="text"
                  value={formData.job_title}
                  onChange={handleReferralChange}
                  disabled={isLoading}
                  placeholder={t('auth.register.referralPlaceholder')}
                />
              </div>
              <div>
                <Label htmlFor="phone-number" className="text-muted-foreground">
                  {t('auth.register.phoneNumber')} <span className="text-xs italic">{t('auth.register.optional')}</span>
                </Label>
                <div className="flex gap-2">
                  <select
                    className="px-2 py-2 border border-input bg-background rounded-md text-sm w-16 overflow-hidden text-ellipsis"
                    value={formData.phone_country_code}
                    onChange={handleInputChange('phone_country_code')}
                    disabled={isLoading}
                    style={{ textOverflow: 'ellipsis' }}
                  >
                    {COUNTRIES.map(({ name, code, dialCode }) => (
                      <option key={code} value={dialCode}>
                        {dialCode} {name}
                      </option>
                    ))}
                  </select>
                  <Input
                    id="phone-number"
                    type="tel"
                    className="flex-1"
                    value={formData.phone_number}
                    onChange={handleInputChange('phone_number')}
                    disabled={isLoading}
                  />
                </div>
              </div>
            </div>

            <div>
              <Label htmlFor="email">{t('auth.register.email')}</Label>
              <Input
                id="email"
                type="email"
                required
                value={formData.email}
                onChange={handleInputChange('email')}
                disabled={isLoading}
              />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <Label htmlFor="password">{t('auth.register.password')}</Label>
                <Input
                  id="password"
                  type="password"
                  required
                  value={formData.password}
                  onChange={handleInputChange('password')}
                  disabled={isLoading}
                />
              </div>
              <div>
                <Label htmlFor="confirm-password">{t('auth.register.confirmPassword')}</Label>
                <Input
                  id="confirm-password"
                  type="password"
                  required
                  value={formData.password2}
                  onChange={handleInputChange('password2')}
                  disabled={isLoading}
                />
              </div>
            </div>

            <Button
              type="submit"
              className="w-full"
              disabled={isLoading}
            >
              {isLoading ? t('auth.register.submitting') : t('auth.register.submit')}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
