'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { Role, SessionPayload, UserDto } from '@rr/types';
import { ApiError, apiGet, apiPost } from './api';

export type Profile = SessionPayload['profile'];

interface RegisterInput {
  fullName: string;
  email: string;
  phone?: string;
  password: string;
  role?: Role;
}

interface AuthContextValue {
  user: UserDto | null;
  profile: Profile;
  loading: boolean;
  refresh: () => Promise<void>;
  login: (email: string, password: string) => Promise<UserDto>;
  register: (input: RegisterInput) => Promise<UserDto>;
  logout: () => Promise<void>;
  homePath: string;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function homePathFor(role: Role | undefined | null): string {
  switch (role) {
    case 'DRIVER':
      return '/dashboard';
    case 'MECHANIC':
    case 'WORKSHOP':
    case 'TOWING_PARTNER':
      return '/mechanic';
    case 'OPERATIONS':
      return '/operations';
    case 'ADMIN':
      return '/admin';
    default:
      return '/login';
  }
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<UserDto | null>(null);
  const [profile, setProfile] = useState<Profile>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const data = await apiGet<SessionPayload>('/api/auth/me');
      setUser(data.user);
      setProfile(data.profile);
    } catch (err) {
      if (err instanceof ApiError && (err.status === 401 || err.code === 'UNAUTHENTICATED')) {
        setUser(null);
        setProfile(null);
      } else if (err instanceof ApiError && err.code === 'NETWORK_ERROR') {
        // keep previous state; API may still be booting
      } else {
        setUser(null);
        setProfile(null);
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const login = useCallback(async (email: string, password: string) => {
    const data = await apiPost<SessionPayload>('/api/auth/login', { email, password });
    setUser(data.user);
    setProfile(data.profile);
    return data.user;
  }, []);

  const register = useCallback(async (input: RegisterInput) => {
    const data = await apiPost<SessionPayload>('/api/auth/register', input);
    setUser(data.user);
    setProfile(data.profile);
    return data.user;
  }, []);

  const logout = useCallback(async () => {
    try {
      await apiPost('/api/auth/logout');
    } finally {
      setUser(null);
      setProfile(null);
    }
  }, []);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      profile,
      loading,
      refresh,
      login,
      register,
      logout,
      homePath: homePathFor(user?.role),
    }),
    [user, profile, loading, refresh, login, register, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

/** Client-side guard: renders `fallback` while loading and redirects when the role does not match. */
export function useRequireRole(
  roles: Role[] | null,
  allowAnonymous = false,
): { allowed: boolean; ready: boolean } {
  const { user, loading } = useAuth();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (loading) return;
    if (!user) {
      if (allowAnonymous) {
        setReady(true);
        return;
      }
      window.location.replace('/login');
      return;
    }
    if (roles && !roles.includes(user.role)) {
      window.location.replace(homePathFor(user.role));
      return;
    }
    setReady(true);
  }, [loading, user, roles, allowAnonymous]);

  return { allowed: ready, ready };
}
