/**
 * Clave del caché de perfil en localStorage.
 *
 * Vive en un módulo propio porque tiene DOS consumidores que deben coincidir
 * exactamente, y hasta ahora cada uno repetía el literal por su cuenta:
 *
 *   · `src/contexts/AuthContext.tsx` — escribe y lee el perfil completo.
 *   · `src/services/api.ts`          — lee el mismo registro como fallback
 *                                      offline para obtener `business_id`.
 *
 * Si los literales se desincronizan, el segundo deja de encontrar el caché en
 * silencio (no falla, sólo pierde el fallback).
 *
 * VERSIÓN v2 — migración 20260822120000 (permissions hydration): hasta esa
 * migración el servidor no devolvía `profiles.permissions`, así que todo perfil
 * cacheado con la clave v1 no tiene overrides. Leerlo se interpretaría como
 * "este usuario no tiene overrides" y mostraría affordances que un override
 * podría estar restringiendo, hasta que responda el RPC. Versionar la clave
 * descarta esos cachés incompletos en vez de hidratar con ellos.
 *
 * Al cambiar la forma del perfil cacheado, subir la versión.
 */
const PROFILE_CACHE_KEY_PREFIX = 'techrepair_profile_v2'

export const getProfileCacheKey = (userId: string) => `${PROFILE_CACHE_KEY_PREFIX}:${userId}`
