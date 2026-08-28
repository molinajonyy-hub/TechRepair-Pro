import type { Session, AuthError } from '@supabase/supabase-js'

// ─────────────────────────────────────────────────────────────────────────────
// MOBILE-SESSION-1A — Clasificación de una sonda de sesión.
//
// EL DEFECTO QUE CIERRA ESTE MÓDULO: el camino de wake-up trataba «no pude
// averiguar si hay sesión» como «la sesión venció», mostraba «Tu sesión venció»
// y navegaba a /login. Con señal débil —el escenario diario de un técnico en la
// calle— eso desloguea visualmente a un usuario cuya sesión está intacta.
//
// AUTORIDAD: la pérdida REAL de autenticación tiene un solo dueño y ya funciona:
//
//     @supabase/auth-js  →  AuthContext  →  ProtectedRoute
//
// Cuando el refresh token es inválido o fue revocado, auth-js llama a
// `_removeSession()` y emite `SIGNED_OUT`; `AuthContext.applySession(null)` deja
// `authState = UNAUTHENTICATED` y `ProtectedRoute` navega. Este módulo NO
// duplica esa transición: sólo clasifica para decidir qué CONTAR al usuario.
//
// NO son evidencia de que la sesión venció:
//   · navigator.onLine === false
//   · un fallo de fetch / DNS / timeout
//   · un error reintentable de red
//   · una caída temporal de Supabase
//
// POR QUÉ ALCANZA CON MIRAR `error`, sin heurísticas de status HTTP
// (leído en @supabase/auth-js 2.103.3, `GoTrueClient.__loadSession`):
//
//   · no hay nada guardado, o lo guardado no es una sesión válida
//         → `{ session: null, error: null }`   ← el ÚNICO caso terminal
//   · la sesión está vencida y el refresh falló, por la razón que sea
//         → `{ session: null, error }`         ← error SIEMPRE presente
//   · sesión utilizable
//         → `{ session, error: null }`
//
// Y en el caso terminal por refresh rechazado, auth-js ya hizo `_removeSession()`
// + `SIGNED_OUT` antes de devolver, así que la próxima sonda cae en `absent` y
// el camino canónico ya está navegando. Por eso un `error` presente se clasifica
// SIEMPRE como `unreachable`: equivocarse hacia «no sé» es recuperable;
// equivocarse hacia «venciste» expulsa a un usuario válido.
//
// Deliberadamente NO se codifica «401 ⇒ sesión vencida». Un 401 cualquiera y un
// rechazo terminal del refresh token por GoTrue no son lo mismo.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resultado de preguntar por el estado de la sesión.
 *
 * Son tres, no dos, y esa es toda la corrección: antes existía sólo el eje
 * «hay / no hay», así que «no pude averiguarlo» caía del lado equivocado.
 */
export type SessionProbe =
  /** Hay una sesión utilizable. Operación normal. */
  | { kind: 'active'; session: Session }
  /**
   * No se pudo determinar. Problema de conectividad, no de autorización.
   * La sesión local sigue intacta y auth-js la conserva a propósito ante
   * errores reintentables. Corresponde UI de conexión, jamás de sesión.
   */
  | { kind: 'unreachable' }
  /**
   * auth-js confirmó que NO hay sesión guardada. Es terminal, pero el camino
   * canónico (`SIGNED_OUT` → AuthContext → ProtectedRoute) ya lo está
   * atendiendo: acá sólo sirve para informar estado, nunca para navegar.
   */
  | { kind: 'absent' }

/** Forma de lo que devuelve `supabase.auth.getSession()`. */
export interface SessionProbeResult {
  data: { session: Session | null }
  error: AuthError | null
}

/**
 * Clasifica el resultado de `getSession()`.
 *
 * Función pura: no toca la red, no toca storage, no navega. Es el único lugar
 * autorizado a decidir si un resultado significa «sin sesión».
 */
export function classifySessionProbe(result: SessionProbeResult): SessionProbe {
  const session = result?.data?.session ?? null

  // Una sesión utilizable gana sobre cualquier otra consideración. auth-js
  // puede devolver sesión Y error en escenarios de borde; si hay sesión, se
  // opera.
  if (session) {
    return { kind: 'active', session }
  }

  // Sin sesión PERO con error: no se puede distinguir un corte de red de un
  // rechazo terminal, y no hace falta — el terminal ya emitió `SIGNED_OUT`.
  // Se elige el lado recuperable.
  if (result?.error) {
    return { kind: 'unreachable' }
  }

  // Sin sesión y sin error: auth-js miró el storage y no había nada válido.
  return { kind: 'absent' }
}

/**
 * Sonda completa: ejecuta `getSession()` y clasifica, tratando cualquier
 * excepción como falta de conectividad.
 *
 * Una excepción acá es un fallo de fetch que ni siquiera llegó a producir un
 * `AuthError` (DNS caído, red cortada a mitad de request). Nunca es evidencia
 * de que la sesión venció.
 */
export async function probeSession(
  getSession: () => Promise<SessionProbeResult>,
): Promise<SessionProbe> {
  try {
    return classifySessionProbe(await getSession())
  } catch {
    return { kind: 'unreachable' }
  }
}
