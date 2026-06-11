import type React from 'react';
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react'
import { deleteCookie, getCookie, setCookie } from 'cookies-next';
import { ACCESS_TOKEN_KEY, REFRESH_TOKEN_KEY, USER_INFO_COOKIE_KEY, API_BASE_URL, API_ENDPOINTS, ADMIN_EMAILS } from '@/lib/constants';
import { apiClient } from '@/lib/api';
import { getCsrfToken, deleteAllAuthCookies } from '@/lib/cookieUtils';

export interface User {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
  institution?: string;
  job_title?: string;
  resolvedTier?: 'free' | 'plus' | 'pro' | 'enterprise';
}

interface AuthContextType {
  user: User | null;
  isAuthenticated: boolean;
  isAdmin: boolean;
  isLoading: boolean;
  login: (email: string, password: string) => Promise<{ success: boolean; message?: string }>;
  logout: () => Promise<void>;
  refreshAuth: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};

interface AuthProviderProps {
  children: ReactNode;
}

const SUBSCRIPTION_TIERS = ['free', 'plus', 'pro', 'enterprise'] as const;

const getDevTestEmail = (): string | null => {
  if (!import.meta.env.DEV) {
    return null;
  }
  const value = import.meta.env.VITE_TEST_USER_EMAIL;
  return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : null;
};

const getDevTestTier = (): User['resolvedTier'] => {
  const value = import.meta.env.VITE_TEST_USER_TIER;
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (SUBSCRIPTION_TIERS.includes(normalized as (typeof SUBSCRIPTION_TIERS)[number])) {
    return normalized as User['resolvedTier'];
  }
  return 'free';
};

const buildDevBypassUser = (email: string): User | null => {
  const devTestEmail = getDevTestEmail();
  if (!devTestEmail || email.trim().toLowerCase() !== devTestEmail) {
    return null;
  }

  return {
    id: `dev-test-${devTestEmail}`,
    email: devTestEmail,
    first_name: 'Test',
    last_name: 'User',
    resolvedTier: getDevTestTier(),
  };
};

const isResolvedTier = (value: unknown): value is NonNullable<User['resolvedTier']> =>
  value === 'free' || value === 'plus' || value === 'pro' || value === 'enterprise';

export const AuthProvider: React.FC<AuthProviderProps> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const hasCheckedAuthRef = useRef(false);
  const adminEmailSet = ADMIN_EMAILS.split(",")
    .map((email: string) => email.trim().toLowerCase())
    .filter(Boolean);
  const isAdmin = !!user?.email && adminEmailSet.includes(user.email.toLowerCase());

  const broadcastAuthChange = (authenticated: boolean) => {
    if (typeof window === 'undefined') {
      return;
    }

    window.dispatchEvent(
      new CustomEvent('sentiedge:auth-changed', {
        detail: { isAuthenticated: authenticated },
      }),
    );
  };

  const broadcastHistoryCleared = (authenticated: boolean) => {
    if (typeof window === 'undefined') {
      return;
    }

    window.dispatchEvent(
      new CustomEvent('sentiedge:history-cleared', {
        detail: { isAuthenticated: authenticated },
      }),
    );
  };

  // Check for existing authentication on mount
  useEffect(() => {
    if (hasCheckedAuthRef.current) {
      return;
    }
    hasCheckedAuthRef.current = true;
    checkAuthStatus();
  }, []);

  // Auto-cleanup anonymous history every 24 hours
  useEffect(() => {
    const CLEANUP_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours in milliseconds

    const cleanupTimer = setInterval(async () => {
      // Only cleanup if user is not authenticated
      if (!isAuthenticated) {
        try {
          const result = await apiClient.clearAnonymousHistory({ force: false });
          if (result.cleaned) {
            // Clear all cookies and refresh the page
            deleteAllAuthCookies();

            setTimeout(() => {
              window.location.reload();
            }, 1000);
          }
        } catch (error) {
          console.error('❌ Auto-cleanup: Failed to clear anonymous history:', error);
        }
      }
    }, CLEANUP_INTERVAL);

    // Cleanup timer on unmount
    return () => {
      clearInterval(cleanupTimer);
    };
  }, [isAuthenticated]); // Re-run when authentication status changes

  const finalizeLogin = async (userData: User) => {
    setUser(userData);
    setIsAuthenticated(true);
    setCookie(USER_INFO_COOKIE_KEY, JSON.stringify(userData));

    broadcastAuthChange(true);
    broadcastHistoryCleared(true);
  };

  const getStoredTierFromCookie = (): User['resolvedTier'] | null => {
    const userInfoCookie = getCookie(USER_INFO_COOKIE_KEY);
    if (!userInfoCookie) {
      return null;
    }
    try {
      const parsed = typeof userInfoCookie === 'string' ? JSON.parse(userInfoCookie) : userInfoCookie;
      return isResolvedTier(parsed?.resolvedTier) ? parsed.resolvedTier : null;
    } catch {
      return null;
    }
  };

  const checkTierChangeOnLogin = async (baseUser: User, previousTier: User['resolvedTier'] | null) => {
    if (!baseUser.email) {
      return;
    }

    try {
      const subscription = await apiClient.getSubscriptionStatus(baseUser.email);
      const latestTier: User['resolvedTier'] = isResolvedTier(subscription?.resolvedTier)
        ? subscription.resolvedTier
        : 'free';

      if ((previousTier ?? 'free') !== latestTier) {
        console.info('Tier changed on login', {
          email: baseUser.email,
          from: previousTier ?? 'free',
          to: latestTier,
        });
      }

      const syncedUser: User = {
        ...baseUser,
        resolvedTier: latestTier,
      };
      setUser(syncedUser);
      setIsAuthenticated(true);
      setCookie(USER_INFO_COOKIE_KEY, JSON.stringify(syncedUser));
    } catch (error) {
      console.warn('Tier check failed on login:', error);
    }
  };

  const checkAuthStatus = async () => {
    const hadAuthState = isAuthenticated || !!user;
    const userInfoCookie = getCookie(USER_INFO_COOKIE_KEY);

    if (!userInfoCookie) {
      clearAuthData({ emitEvents: hadAuthState });
      setIsLoading(false);
      return;
    }

    try {
      const response = await apiClient.getMe();

      if (response?.user) {
        await finalizeLogin(response.user as User);
        return;
      }

      clearAuthData({ emitEvents: isAuthenticated || !!user });
    } catch (error) {
      const status = (error as { status?: number } | null)?.status;
      if (status === 401) {
        const cookieUserInfo = getCookie(USER_INFO_COOKIE_KEY);
        if (cookieUserInfo) {
          try {
            const parsed = typeof cookieUserInfo === 'string'
              ? JSON.parse(cookieUserInfo)
              : cookieUserInfo;
            const parsedEmail = typeof parsed?.email === 'string' ? parsed.email : '';
            const devBypassUser = buildDevBypassUser(parsedEmail);
            if (devBypassUser) {
              await finalizeLogin({
                ...devBypassUser,
                ...parsed,
                email: devBypassUser.email,
                resolvedTier: devBypassUser.resolvedTier,
              } as User);
              return;
            }
          } catch (parseError) {
            console.error('Error parsing local user info for dev bypass:', parseError);
          }
        }
        clearAuthData({ emitEvents: hadAuthState });
        return;
      }

      if (import.meta.env.DEV) {
        try {
          const userInfo = getCookie(USER_INFO_COOKIE_KEY);
          if (userInfo) {
            const parsedUser = typeof userInfo === 'string' ? JSON.parse(userInfo) : userInfo;
            await finalizeLogin(parsedUser as User);
            return;
          }
        } catch (parseError) {
          console.error('Error parsing local user info during dev fallback:', parseError);
        }
      }

      console.error('Error verifying auth status:', error);
      clearAuthData({ emitEvents: hadAuthState });
    } finally {
      setIsLoading(false);
    }
  };

  const clearAuthData = ({ emitEvents = true }: { emitEvents?: boolean } = {}) => {
    deleteCookie(ACCESS_TOKEN_KEY);
    deleteCookie(REFRESH_TOKEN_KEY);
    deleteCookie(USER_INFO_COOKIE_KEY);
    setUser(null);
    setIsAuthenticated(false);

    if (emitEvents) {
      broadcastAuthChange(false);
      broadcastHistoryCleared(false);
    }
  };

  const login = async (email: string, password: string): Promise<{ success: boolean; message?: string }> => {
    const previousTier = user?.resolvedTier ?? getStoredTierFromCookie();
    const devBypassUser = buildDevBypassUser(email);
    if (devBypassUser) {
      await finalizeLogin(devBypassUser);
      return { success: true };
    }

    try {
      const response = await fetch(`${API_BASE_URL}${API_ENDPOINTS.AUTH.LOGIN}`, {
        method: 'POST',
        credentials: 'include',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ email, password })
      });

      const responseData = await response.json();

      if (response.ok) {
        // Cookies should be set by the server, but we can also handle client-side if needed
        if (responseData.user) {
          const loginUser = responseData.user as User;
          await finalizeLogin(loginUser);
          await checkTierChangeOnLogin(loginUser, previousTier);
        }
        return { success: true };
      } else {
        return { success: false, message: responseData.message || 'Login failed' };
      }
    } catch (error) {
      console.error('Login error:', error);
      return { success: false, message: 'An error occurred while logging in. Please try again later.' };
    }
  };

  const logout = async () => {
    // Get CSRF token for the logout requests
    const csrftoken = getCsrfToken() || '';
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(csrftoken ? { 'X-CSRFToken': csrftoken } : {}),
    };

    // Call BOTH backends in parallel. Each does a job the other can't:
    //   - Django (api.sentiedge.ai/api/authentication/logout/) does any
    //     server-side cleanup it owns (session invalidation, refresh-token
    //     blocklist, audit logging).
    //   - Node agent (same origin as the SPA, e.g. staging.sentiedge.ai)
    //     issues `Set-Cookie ...; Max-Age=0; Domain=sentiedge.ai` for
    //     access_token / refresh_token / user_email / user_info, which is
    //     what actually evicts the httpOnly cookies from the browser. Django
    //     returns 200 here but its cookies don't get cleared (verified via
    //     Playwright on 2026-05-16 — UI logout left the user authenticated
    //     for every requireAuth route until the Node endpoint also fired).
    //
    // Promise.allSettled so one backend being down or slow does not block
    // the local cleanup (deleteAllAuthCookies + setUser(null) + broadcasts).
    const nodeLogoutUrl =
      (typeof window !== 'undefined' && window.location?.origin
        ? window.location.origin
        : '') + API_ENDPOINTS.AUTH.LOGOUT;
    const results = await Promise.allSettled([
      fetch(`${API_BASE_URL}${API_ENDPOINTS.AUTH.LOGOUT}`, {
        method: 'POST',
        credentials: 'include',
        headers,
      }),
      fetch(nodeLogoutUrl, {
        method: 'POST',
        credentials: 'include',
        headers,
      }),
    ]);
    results.forEach((r, i) => {
      if (r.status === 'rejected') {
        const label = i === 0 ? 'Django' : 'Node';
        console.error(
          `❌ Logout request to ${label} failed (continuing client cleanup):`,
          r.reason
        );
      }
    });

    // Do not clear anonymous history on logout; only auto-cleanup after inactivity

    // Comprehensive cookie cleanup
    deleteAllAuthCookies();

    // Clear auth state
    setUser(null);
    setIsAuthenticated(false);

    // Broadcast auth change event
    broadcastAuthChange(false);
    broadcastHistoryCleared(false);
  };

  const refreshAuth = async () => {
    try {
      const response = await fetch(`${API_BASE_URL}${API_ENDPOINTS.AUTH.REFRESH}`, {
        method: 'POST',
        credentials: 'include',
      });

      if (response.ok) {
        const responseData = await response.json();
        if (responseData.user) {
          setUser(responseData.user);
          setIsAuthenticated(true);
          setCookie(USER_INFO_COOKIE_KEY, JSON.stringify(responseData.user));
        }
      } else {
        clearAuthData();
      }
    } catch (error) {
      console.error('Refresh auth error:', error);
      clearAuthData();
    }
  };

  const value: AuthContextType = {
    user,
    isAuthenticated,
    isAdmin,
    isLoading,
    login,
    logout,
    refreshAuth,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};
