import type React from 'react';
import { useState } from 'react';
import { useNavigate, useLocation, Link } from 'react-router';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { useAuth } from '@/contexts/AuthContext';
import { useTheme } from '@/contexts/ThemeContext';
import { toast } from 'sonner';
import { ArrowLeft } from 'lucide-react';
import { REDIRECT_URL_ON_LOGIN_SUCCESS } from '@/lib/constants';
import { useTranslation } from 'react-i18next';

export default function SignInForm() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isLoading, setIsLoading] = useState(false);

  const navigate = useNavigate();
  const location = useLocation();
  const { login } = useAuth();
  const { theme } = useTheme();
  const { t } = useTranslation();

  const from = (location.state as any)?.from?.pathname || REDIRECT_URL_ON_LOGIN_SUCCESS;
  const iconSrc = theme === "light" ? "/sentiedge-icon.jpg" : "/sentiedge-icon.png";

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setIsLoading(true);

    try {
      const result = await login(email, password);
      
      if (result.success) {
        navigate(from, { replace: true });
        toast.success(t('auth.signIn.success'));
      } else {
        setPassword('');
        toast.error(result.message || t('auth.signIn.failed'));
      }
    } catch (error) {
      console.error('Sign in error:', error);
      toast.error(t('auth.signIn.unexpectedError'));
    } finally {
      setIsLoading(false);
    }
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
          <CardTitle className="text-2xl font-bold">{t("auth.signIn.title")}</CardTitle>
          <p className="text-sm text-muted-foreground">
            {t("auth.signIn.subtitle")}
          </p>
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
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={isLoading}
              />
            </div>
            
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <Label htmlFor="password">{t("common.password")}</Label>
                <Link
                  to="#"
                  className="text-sm text-primary hover:underline"
                >
                  {t("auth.signIn.forgotPassword")}
                </Link>
              </div>
              <Input
                id="password"
                name="password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={isLoading}
              />
            </div>

            <Button
              type="submit"
              className="w-full"
              disabled={isLoading}
            >
              {isLoading ? t("auth.signIn.submitting") : t("auth.signIn.submit")}
            </Button>
          </form>

          <div className="mt-6 text-center text-sm">
            <span className="text-muted-foreground">{t("auth.signIn.notMember")} </span>
            <Link
              to="/signup"
              className="text-primary hover:underline font-medium"
            >
              {t("auth.signIn.join")}
            </Link>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
