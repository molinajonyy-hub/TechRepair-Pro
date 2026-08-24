// ─────────────────────────────────────────────────────────────────────────────
// P0-P2 — Preservación del token de invitación durante el rodeo por auth.
//
// El problema: `/accept-invite?token=...` es público, pero aceptar exige sesión.
// Un invitado nuevo tiene que pasar por login / signup / confirmación de correo
// / Google antes de poder aceptar, y en el camino la URL con el token se pierde.
//
// La app YA tiene un mecanismo para destinos post-login (`?redirectTo=` +
// `post_login_redirect` en sessionStorage, normalizado por
// `sanitizeInternalPath`) y cubre login y OAuth. Este módulo NO lo reemplaza:
// cubre el único hueco que ese mecanismo no puede cubrir.
//
// EL HUECO: `sessionStorage` es POR PESTAÑA. El enlace de confirmación de correo
// se abre casi siempre en una pestaña NUEVA —o directamente en otro momento—, y
// ahí el `post_login_redirect` guardado por la pestaña original no existe. Por
// eso el token se guarda además en `localStorage`, que sí se comparte entre
// pestañas del mismo origen.
//
// A cambio de esa persistencia:
//   · se guarda SOLO el token, nada de correo, negocio ni rol;
//   · tiene TTL corto (30 min): es el tiempo de dar una vuelta por el correo, no
//     una credencial de larga vida;
//   · se consume y se borra en el primer uso (`takeInviteToken`);
//   · se limpia en el logout, junto con el resto del estado de sesión.
//
// El token NO es un secreto de más valor que el enlace del que salió: quien
// tiene acceso al localStorage del origen ya tiene la sesión. Y aunque se filtre,
// el servidor exige que el correo del actor coincida con el de la invitación.
// ─────────────────────────────────────────────────────────────────────────────

const CLAVE = 'trp_pending_invite'

/** 30 minutos. Alcanza para ir al correo y volver; no para quedar dando vueltas. */
const TTL_MS = 30 * 60 * 1000

interface Guardado {
  token: string
  /** epoch ms en que se guardó. */
  ts: number
}

const almacen = (): Storage | null => {
  try {
    return typeof window !== 'undefined' ? window.localStorage : null
  } catch {
    // Safari en modo privado y algunos WebViews tiran al TOCAR localStorage.
    return null
  }
}

/** Guarda el token para recuperarlo después del rodeo por auth. */
export function stashInviteToken(token: string): void {
  const limpio = token.trim()
  if (!limpio) return

  const store = almacen()
  if (!store) return

  try {
    store.setItem(CLAVE, JSON.stringify({ token: limpio, ts: Date.now() } satisfies Guardado))
  } catch {
    // Cuota llena o storage bloqueado: el flujo sigue andando con el token de la
    // URL. Perder el stash degrada la UX, no la corrección.
  }
}

/** Lee sin consumir. Devuelve `null` si no hay o si venció (y en ese caso limpia). */
export function peekInviteToken(): string | null {
  const store = almacen()
  if (!store) return null

  let crudo: string | null
  try {
    crudo = store.getItem(CLAVE)
  } catch {
    return null
  }
  if (!crudo) return null

  let dato: Guardado
  try {
    dato = JSON.parse(crudo) as Guardado
  } catch {
    // Valor corrupto o de una versión anterior: se descarta.
    clearInviteToken()
    return null
  }

  if (typeof dato?.token !== 'string' || !dato.token || typeof dato.ts !== 'number') {
    clearInviteToken()
    return null
  }

  // `Date.now() < dato.ts` cubre un reloj movido hacia atrás: si el sello quedó
  // en el futuro no se puede razonar sobre su antigüedad, así que se descarta.
  if (Date.now() - dato.ts > TTL_MS || Date.now() < dato.ts) {
    clearInviteToken()
    return null
  }

  return dato.token
}

/** Lee y borra. Es la forma normal de consumirlo: un token se usa una sola vez. */
export function takeInviteToken(): string | null {
  const token = peekInviteToken()
  clearInviteToken()
  return token
}

export function clearInviteToken(): void {
  const store = almacen()
  if (!store) return
  try {
    store.removeItem(CLAVE)
  } catch {
    /* nada que hacer */
  }
}

/** Ruta interna canónica de aceptación, con el token ya codificado. */
export function acceptInviteePath(token: string): string {
  return `/accept-invite?token=${encodeURIComponent(token.trim())}`
}
