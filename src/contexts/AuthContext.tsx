import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { Session, User } from '@supabase/supabase-js';
import { supabase } from '../lib/supabase';
import { getProfileCacheKey } from '../lib/profileCache';
import { getAuthCallbackUrl } from '../lib/authRedirect';
import { clearInviteToken } from '../lib/pendingInvite';

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
  /**
   * Overrides de permisos crudos, tal como los devuelve `get_my_profile()` /
   * `link_profile_to_auth_user()` desde `profiles.permissions` (jsonb).
   *
   * Deliberadamente `unknown`: es un payload no confiable (jsonb libre, y
   * además puede venir de un caché de localStorage viejo). El único lugar
   * autorizado a interpretarlo es `sanitizePermissions()` en
   * `src/hooks/usePermissions.ts`, que falla cerrado si no lo entiende.
   */
  permissions?: unknown;
  created_at: string;
  updated_at: string;
}

export interface SignUpResult {
  needsEmailConfirmation: boolean;
}

/**
 * Resultado de reenviar el correo de confirmación.
 *
 * `rateLimited` se distingue de `error` a propósito: es el único fallo que el
 * usuario puede resolver solo (esperando), así que la pantalla lo trata como
 * un estado y no como una falla.
 */
export type ResendConfirmationResult =
  | { status: 'sent' }
  | { status: 'rate_limited' }
  | { status: 'error' };

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
  /**
   * Señal CANÓNICA y provider-agnostic de «este correo está verificado».
   *
   * Se deriva de `session.user.email_confirmed_at` y nunca de `provider`:
   * Google devuelve el usuario ya confirmado vía GoTrue, así que un usuario de
   * OAuth entra por el mismo camino que uno de email+password que ya confirmó.
   * No hay una rama `provider === 'google'` en ningún lado, y no debe haberla.
   *
   * Sin sesión es `false`. Los guards ya exigen `isAuthenticated` por separado,
   * así que un `false` sin sesión nunca se confunde con «pendiente».
   */
  emailConfirmed: boolean;
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
  /**
   * Reenvía el correo de confirmación de signup usando la API oficial de
   * Supabase. No hay endpoint propio ni se guarda ningún token.
   */
  resendConfirmation: (email: string) => Promise<ResendConfirmationResult>;
  /**
   * Consulta el estado REAL del usuario contra el servidor (`auth.getUser()`)
   * y sincroniza el contexto. Es lo que respalda «Ya confirmé, continuar»:
   * jamás se marca confirmado con una bandera local.
   *
   * Devuelve `true` si el correo quedó confirmado.
   */
  refreshUser: () => Promise<boolean>;
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

/**
 * Correo de un registro que quedó pendiente de confirmación.
 *
 * Con «Confirm Email» ON, `signUp` NO devuelve sesión: el usuario existe en
 * `auth.users` pero el browser no tiene nada. Sin este dato, /verificar-email
 * no sabría a quién reenviarle el correo.
 *
 * Va en `sessionStorage` (no `localStorage`): muere con la pestaña, que es el
 * alcance correcto para un dato de un flujo en curso. Se guarda ÚNICAMENTE el
 * email — jamás un token ni un `token_hash`.
 */
const PENDING_CONFIRMATION_EMAIL_KEY = 'trp_pending_confirmation_email';

export const rememberPendingConfirmationEmail = (email: string) => {
  try {
    window.sessionStorage.setItem(PENDING_CONFIRMATION_EMAIL_KEY, email);
  } catch {
    // sessionStorage bloqueado: la pantalla degrada a pedir el email de nuevo.
  }
};

export const readPendingConfirmationEmail = (): string | null => {
  try {
    return window.sessionStorage.getItem(PENDING_CONFIRMATION_EMAIL_KEY);
  } catch {
    return null;
  }
};

export const clearPendingConfirmationEmail = () => {
  try {
    window.sessionStorage.removeItem(PENDING_CONFIRMATION_EMAIL_KEY);
  } catch {
    // no-op
  }
};

const PROFILE_LOAD_TIMEOUT_MS = 20000;

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

    // Sin correo confirmado no hay provisioning server-side todavía (ver la
    // migración 20260823120000), así que `get_my_profile` devolvería 0 filas y
    // dispararía un intento inútil de `link_profile_to_auth_user` en cada
    // carga. Peor: dejaría `profileError = "No existe un perfil de negocio"`,
    // que manda a diagnosticar al lugar equivocado cuando lo único que falta
    // es hacer click en el correo.
    if (!currentUser.email_confirmed_at) {
      setProfile(null);
      setProfileError(null);
      setProfileLoading(false);
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
            // `get_my_profile` resuelve SÓLO por identidad
            // (COALESCE(user_id, id) = auth.uid()). Cero filas significa que
            // este auth user todavía no tiene un perfil vinculado, así que se
            // intenta la REPARACIÓN explícita: vincular por email un perfil
            // huérfano (user_id IS NULL). Ver 20260822160000.
            //
            // Antes esto vivía en un try/catch mudo, y fue parte de por qué el
            // defecto quedó invisible tanto tiempo: cualquier fallo del
            // fallback se reportaba como "no existe perfil". Ahora se
            // distinguen los dos estados.
            let linkedRow: Profile | undefined;

            try {
              const { data: linked, error: linkError } = await supabase.rpc('link_profile_to_auth_user');

              if (linkError) {
                throw new Error(linkError.message);
              }

              linkedRow = Array.isArray(linked) ? linked[0] : linked;
            } catch (linkError) {
              // LINK_ERROR — distinto de NO_PROFILE. Se da, por ejemplo, cuando
              // hay más de un perfil huérfano con el mismo email y el servidor
              // falla cerrado (SQLSTATE TRLNK) en vez de vincular uno al azar.
              // No se reintenta: reintentar no cambiaría el resultado.
              if (import.meta.env.DEV) console.warn('Error vinculando el perfil:', linkError);
              setProfile(null);
              setProfileError(
                'No pudimos vincular tu perfil de negocio. Escribinos para que lo revisemos.'
              );
              return null;
            }

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

            // NO_PROFILE — no hay perfil propio ni huérfano que reparar.
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
    } = supabase.auth.onAuthStateChange((event, nextSession) => {
      const sessionFromEvent = nextSession ?? null;
      applySession(sessionFromEvent);
      setLoading(false);

      if (sessionFromEvent?.user) {
        // TOKEN_REFRESHED solo actualiza el token, no el perfil de usuario.
        // No poner profileLoading=true para evitar que ProtectedRoute desmonte
        // las páginas activas (cerrando modales y reseteando estado).
        if (event === 'TOKEN_REFRESHED') return;

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
          // Con «Confirm Email» ON, esta es la URL que GoTrue interpola en la
          // plantilla del correo. Sale del helper canónico, nunca de
          // `window.location.origin` suelto.
          emailRedirectTo: getAuthCallbackUrl(),
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

      // NO se asume que signUp devuelve sesión: con Confirm Email ON, Supabase
      // crea el usuario y devuelve `session: null`. Eso NO es un error — es el
      // camino feliz del registro pendiente.
      if (!nextSession) {
        // Sin sesión, /verificar-email no tendría de dónde sacar el correo y
        // rebotaría a /login, que es justo el callejón sin salida que esta P0
        // viene a eliminar. Se guarda el email —y sólo el email, nunca un
        // token— para que la pantalla pueda ofrecer el reenvío.
        rememberPendingConfirmationEmail(email);
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
      // La URL /auth/callback debe estar en la lista de URLs permitidas en Supabase.
      // El origen sale del helper canónico (allowlist cerrada), no de
      // `window.location.origin` crudo.
      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: getAuthCallbackUrl(),
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

  const resendConfirmation = async (email: string): Promise<ResendConfirmationResult> => {
    try {
      const { error } = await supabase.auth.resend({
        type: 'signup',
        email,
        options: {
          emailRedirectTo: getAuthCallbackUrl(),
        },
      });

      if (!error) {
        return { status: 'sent' };
      }

      // 429 es el único fallo accionable por el usuario. Se detecta por status
      // Y por mensaje: distintas versiones de GoTrue lo reportan distinto.
      const status = (error as { status?: number }).status;
      const message = error.message?.toLowerCase() ?? '';
      if (status === 429 || message.includes('rate limit') || message.includes('too many')) {
        return { status: 'rate_limited' };
      }

      if (import.meta.env.DEV) console.warn('Error reenviando la confirmación:', error);
      return { status: 'error' };
    } catch (error) {
      if (import.meta.env.DEV) console.warn('Error reenviando la confirmación:', error);
      return { status: 'error' };
    }
  };

  const refreshUser = async (): Promise<boolean> => {
    try {
      // getUser() consulta al servidor de auth; getSession() sólo lee el token
      // guardado, que puede ser anterior a la confirmación. Esa diferencia es
      // exactamente el punto de «Ya confirmé, continuar».
      const { data, error } = await supabase.auth.getUser();

      if (error || !data?.user) {
        return false;
      }

      const confirmed = !!data.user.email_confirmed_at;

      if (confirmed) {
        // El JWT vigente se emitió antes de confirmar. Se refresca para que la
        // sesión (y cualquier claim derivado) refleje el estado nuevo, y para
        // que el provisioning server-side ya tenga su fila cuando se pida el
        // profile.
        const { data: refreshed } = await supabase.auth.refreshSession();
        const nextSession = refreshed?.session ?? null;

        if (nextSession) {
          applySession(nextSession);
          await loadProfile(nextSession.user);
        } else {
          // Sin refresh disponible, al menos se adopta el user real.
          setUser(data.user);
          await loadProfile(data.user);
        }
      } else {
        // Se adopta igual el user del servidor: es la fuente de verdad y deja
        // el contexto consistente aunque siga sin confirmar.
        setUser(data.user);
      }

      return confirmed;
    } catch (error) {
      if (import.meta.env.DEV) console.warn('Error consultando el usuario:', error);
      return false;
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
      // Y el correo pendiente: si alguien cambia de cuenta, no debe arrastrar
      // el registro a medias de la anterior.
      clearPendingConfirmationEmail();
      // P0-P2: idem con el token de invitación. Vive en localStorage para
      // sobrevivir el salto de pestaña del enlace de confirmación, así que el
      // logout tiene que borrarlo explícitamente: si no, el próximo usuario que
      // inicie sesión en este navegador sería redirigido a aceptar una
      // invitación ajena (el servidor la rechazaría por correo, pero la pantalla
      // no tiene por qué aparecer).
      clearInviteToken();
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
    emailConfirmed: !!user?.email_confirmed_at,
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
    resendConfirmation,
    refreshUser,
    signOut,
    setProfileLoadingDisabled: updateProfileLoadingDisabled,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
};
