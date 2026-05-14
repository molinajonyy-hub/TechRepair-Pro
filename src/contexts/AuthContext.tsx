import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { Session, User } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import type { AppPermissions } from '../config/permissions';

export type UserRole = 'owner' | 'admin' | 'manager' | 'tech' | 'sales' | 'cashier' | 'viewer';

export interface Profile {
  id: string;
  user_id: string;
  business_id: string;
  role: UserRole;
  is_active: boolean;
  full_name?: string;
  email?: string;
  phone?: string;
  permissions?: Partial<AppPermissions> | null;
  created_at: string;
  updated_at: string;
}

export interface SignUpResult {
  needsEmailConfirmation: boolean;
}

interface AuthContextType {
  user: User | null;
  session: Session | null;
  profile: Profile | null;
  businessId: string | null;
  role: UserRole | null;
  loading: boolean;
  isLoading: boolean;
  profileLoading: boolean;
  isAuthenticated: boolean;
  hasBusinessAccess: boolean;
  profileError: string | null;
  isOwner: boolean;
  isAdmin: boolean;
  isManager: boolean;
  isTech: boolean;
  isSales: boolean;
  isCashier: boolean;
  isViewer: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, password: string, fullName?: string) => Promise<SignUpResult>;
  signInWithGoogle: () => Promise<void>;
  refreshProfile: () => Promise<void>;
  signOut: () => Promise<void>;
  setProfileLoadingDisabled: (disabled: boolean) => void;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

const withTimeout = async <T,>(promise: PromiseLike<T>, timeoutMs: number, errorMessage: string): Promise<T> => {
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(() => {
      reject(new Error(errorMessage));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
    }
  }
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const PROFILE_CACHE_KEY_PREFIX = 'techrepair_profile';
const PROFILE_LOAD_TIMEOUT_MS = 20000;

const getProfileCacheKey = (userId: string) => `${PROFILE_CACHE_KEY_PREFIX}:${userId}`;

const isTransientProfileLoadError = (error: unknown) => {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    message.includes('auth-token') ||
    message.includes('stole it') ||
    message.includes('tiempo agotado') ||
    message.includes('timeout') ||
    message.includes('failed to fetch') ||
    message.includes('network')
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [profileLoading, setProfileLoading] = useState(false);
  const [profileError, setProfileError] = useState<string | null>(null);
  const profileLoadingDisabledRef = useRef(false);
  const profileRequestRef = useRef<Promise<Profile | null> | null>(null);

  const updateProfileLoadingDisabled = (disabled: boolean) => {
    profileLoadingDisabledRef.current = disabled;
  };

  const loadProfile = async (currentUser: User) => {
    if (profileLoadingDisabledRef.current) {
      return null;
    }

    if (profileRequestRef.current) {
      return profileRequestRef.current;
    }

    setProfileLoading(true);

    const cachedProfile = loadCachedProfile(currentUser.id);

    if (cachedProfile) {
      setProfile(cachedProfile);
      setProfileError(cachedProfile.is_active ? null : 'Tu usuario existe, pero esta inactivo para este negocio.');
    }

    const request = (async () => {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        try {
          const { data, error } = await withTimeout(
            supabase.rpc('get_my_profile'),
            PROFILE_LOAD_TIMEOUT_MS,
            'Tiempo agotado al cargar el perfil del negocio.'
          );

          if (error) {
            throw new Error(error.message);
          }

          const profileRow = Array.isArray(data) ? data[0] : data;

          if (!profileRow) {
            // Fallback para OAuth (Google): si get_my_profile no encontró por user_id,
            // intentar vincular el profile existente por email al auth user actual.
            try {
              const { data: linked } = await supabase.rpc('link_profile_to_auth_user');
              const linkedRow = Array.isArray(linked) ? linked[0] : linked;
              if (linkedRow) {
                const linkedProfile: Profile = {
                  ...linkedRow,
                  user_id: linkedRow.user_id ?? currentUser.id,
                };
                setProfile(linkedProfile);
                cacheProfile(currentUser.id, linkedProfile);
                setProfileError(linkedProfile.is_active ? null : 'Tu usuario existe, pero esta inactivo para este negocio.');
                return linkedProfile;
              }
            } catch {
              // link falló — continuar con perfil null
            }
            setProfile(null);
            setProfileError('No existe un perfil de negocio para este usuario.');
            return null;
          }

          const normalizedProfile: Profile = {
            ...profileRow,
            user_id: profileRow.user_id ?? profileRow.id ?? currentUser.id,
          };

          setProfile(normalizedProfile);
          cacheProfile(currentUser.id, normalizedProfile);
          setProfileError(
            normalizedProfile.is_active
              ? null
              : 'Tu usuario existe, pero esta inactivo para este negocio.'
          );

          return normalizedProfile;
        } catch (error) {
          if (isTransientProfileLoadError(error) && attempt < 3) {
            await sleep(500 * (attempt + 1));
            continue;
          }

          if (import.meta.env.DEV) console.warn('Error loading profile:', error);

          if (cachedProfile) {
            setProfile(cachedProfile);
            setProfileError(
              'No se pudo actualizar el perfil del negocio en este momento. Usando datos guardados localmente.'
            );
            return cachedProfile;
          }

          setProfile(null);
          setProfileError(
            error instanceof Error
              ? `No se pudo cargar el perfil del negocio. ${error.message}`
              : 'No se pudo cargar el perfil del negocio.'
          );
          return null;
        }
      }

      setProfile(null);
      setProfileError('No se pudo cargar el perfil del negocio.');
      return null;
    })();

    profileRequestRef.current = request.finally(() => {
      profileRequestRef.current = null;
      setProfileLoading(false);
    });

    return profileRequestRef.current;
  };

  const loadCachedProfile = (userId: string): Profile | null => {
    try {
      const rawProfile = window.localStorage.getItem(getProfileCacheKey(userId));
      return rawProfile ? JSON.parse(rawProfile) as Profile : null;
    } catch {
      return null;
    }
  };

  const cacheProfile = (userId: string, nextProfile: Profile) => {
    try {
      window.localStorage.setItem(getProfileCacheKey(userId), JSON.stringify(nextProfile));
    } catch {
      // Local storage is best-effort; auth must not fail if the browser blocks it.
    }
  };

  const applySession = (nextSession: Session | null) => {
    const nextUser = nextSession?.user ?? null;

    setSession(nextSession);
    setUser(nextUser);

    if (!nextUser) {
      setProfile(null);
      setProfileError(null);
      setProfileLoading(false);
    }
  };

  const refreshProfile = async () => {
    if (user) {
      // Limpiar caché para forzar recarga desde DB (evita perfil/rol desactualizado)
      window.localStorage.removeItem(getProfileCacheKey(user.id));
      await loadProfile(user);
    }
  };

  useEffect(() => {
    const initializeAuth = async () => {
      setLoading(true);

      try {
        const {
          data: { session: currentSession },
        } = await supabase.auth.getSession();

        const nextSession = currentSession ?? null;
        applySession(nextSession);
        setLoading(false);

        if (nextSession?.user) {
          void loadProfile(nextSession.user);
        }
      } finally {
        setLoading(false);
      }
    };

    void initializeAuth();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      const sessionFromEvent = nextSession ?? null;
      applySession(sessionFromEvent);
      setLoading(false);

      if (sessionFromEvent?.user) {
        // Marcar profileLoading ANTES del setTimeout para que ProtectedRoute
        // muestre loader en vez de redirigir a /no-business durante el tick de espera.
        setProfileLoading(true);
        setTimeout(() => {
          void loadProfile(sessionFromEvent.user);
        }, 0);
      } else {
        setProfileLoading(false);
      }
    });

    return () => {
      subscription.unsubscribe();
    };
  }, []);

  const signIn = async (email: string, password: string) => {
    setLoading(true);

    try {
      const { data, error } = await supabase.auth.signInWithPassword({
        email,
        password,
      });

      if (error) {
        throw error;
      }

      const nextSession = data.session ?? null;
      applySession(nextSession);

      if (nextSession?.user) {
        void loadProfile(nextSession.user);
      }
    } finally {
      setLoading(false);
    }
  };

  const signUp = async (email: string, password: string, fullName?: string): Promise<SignUpResult> => {
    setLoading(true);

    try {
      const { data, error } = await supabase.auth.signUp({
        email,
        password,
        options: {
          data: {
            full_name: fullName || '',
          },
        },
      });

      if (error) {
        throw error;
      }

      const nextSession = data.session ?? null;
      applySession(nextSession);

      if (nextSession?.user) {
        void loadProfile(nextSession.user);
      }

      return {
        needsEmailConfirmation: !nextSession,
      };
    } finally {
      setLoading(false);
    }
  };

  const signInWithGoogle = async () => {
    setLoading(true);

    try {
      // Usar VITE_APP_URL si está definido (para producción),
      // o window.location.origin como fallback (para desarrollo local).
      // La URL /auth/callback debe estar en la lista de URLs permitidas en Supabase.
      const appUrl = (import.meta.env.VITE_APP_URL as string | undefined)?.replace(/\/$/, '')
        || window.location.origin;

      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: `${appUrl}/auth/callback`,
          queryParams: {
            access_type: 'offline',
            prompt: 'select_account',
          },
        },
      });

      if (error) {
        throw error;
      }
      // signInWithOAuth redirige el browser — el código posterior no se ejecuta
    } finally {
      setLoading(false);
    }
  };

  const signOut = async () => {
    setLoading(true);

    try {
      const { error } = await supabase.auth.signOut();

      if (error) {
        throw error;
      }

      setSession(null);
      setUser(null);
      setProfile(null);
      setProfileError(null);

      if (user?.id) {
        window.localStorage.removeItem(getProfileCacheKey(user.id));
      }
      // Limpiar redirect de sesión para evitar que otro usuario herede la URL
      window.sessionStorage.removeItem('post_login_redirect');
    } finally {
      setLoading(false);
    }
  };

  const value: AuthContextType = {
    user,
    session,
    profile,
    businessId: profile?.business_id || null,
    role: profile?.role || null,
    loading,
    isLoading: loading,
    profileLoading,
    isAuthenticated: !!user,
    hasBusinessAccess: !!profile?.business_id && profile.is_active,
    profileError,
    isOwner: profile?.role === 'owner',
    isAdmin: profile?.role === 'admin',
    isManager: profile?.role === 'manager',
    isTech: profile?.role === 'tech',
    isSales: profile?.role === 'sales',
    isCashier: profile?.role === 'cashier',
    isViewer: profile?.role === 'viewer',
    signIn,
    signUp,
    signInWithGoogle,
    refreshProfile,
    signOut,
    setProfileLoadingDisabled: updateProfileLoadingDisabled,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};
