/**
 * whatsappHandoff — apertura ESTÁNDAR de WhatsApp (W1).
 *
 * Handoff externo puro: `https://wa.me/<telefono>?text=<mensaje>`.
 *
 * DESACOPLADO DEL TRANSPORTE OFICIAL A PROPÓSITO. Este módulo no importa
 * Supabase, no invoca Edge Functions, no conoce `whatsapp-send` ni ningún
 * `access_token` / `phone_number_id` de Meta. El guard
 * `scripts/guards/whatsapp-w1-standard.mjs` lo verifica en CI.
 *
 * LO QUE TECHREPAIR PUEDE SABER: que preparó el mensaje y que el usuario tocó
 * "Abrir WhatsApp". NADA MÁS. No hay evidencia de `sent`, `delivered` ni
 * `read`, así que este módulo no expone esos estados. Ver `EVENTO_APERTURA`.
 */
// Extensión explícita: este módulo se testea con `node --test`, cuyo resolver
// de ESM no completa extensiones. `allowImportingTsExtensions` ya está activo y
// el repo usa este patrón en otros módulos con cobertura unitaria.
import { normalizeWhatsAppPhone, isMobileDevice } from './whatsappFormat.ts'

/**
 * Nombre de ventana estable. Reabrir el handoff reutiliza la MISMA pestaña en
 * vez de acumular una por mensaje. En móvil el navegador delega igual en la
 * app nativa, así que no hace falta ramificar por user-agent.
 */
export const WHATSAPP_WINDOW_NAME = 'techrepair_whatsapp'

/**
 * Único resultado que este flujo puede registrar honestamente, y que además ya
 * pertenece al vocabulario que acepta el CHECK de `whatsapp_logs.send_result`
 * (`opened | copied | failed | skipped | sent_api`).
 *
 * `prepared` NO se agrega: exigiría ampliar ese CHECK en producción — una
 * migración que W1 no necesita. El evento que importa (el click en "Abrir
 * WhatsApp") es exactamente `opened`.
 */
export const EVENTO_APERTURA = 'opened' as const

export type ResultadoHandoff =
  | { ok: true;  url: string; telefono: string }
  | { ok: false; error: string }

/**
 * Arma la URL wa.me. FAIL-CLOSED: sin un teléfono resoluble no devuelve URL,
 * así que es imposible abrir un link roto (`https://wa.me/?text=…`, que en
 * desktop lleva a un selector de contacto vacío y en móvil no hace nada útil).
 */
export function buildWaMeUrl(
  phone: string | null | undefined,
  message: string,
): ResultadoHandoff {
  const telefono = normalizeWhatsAppPhone(phone)
  if (!telefono.valid) {
    return { ok: false, error: telefono.error ?? 'Número de teléfono inválido' }
  }
  if (!message.trim()) {
    return { ok: false, error: 'El mensaje está vacío' }
  }
  // encodeURIComponent UNA sola vez. `message` es texto plano, nunca una URL ya
  // codificada, así que no hay doble encoding: %0A queda %0A, no %250A.
  return {
    ok: true,
    telefono: telefono.normalized,
    url: `https://wa.me/${telefono.normalized}?text=${encodeURIComponent(message)}`,
  }
}

/**
 * URL de WhatsApp Web para DESKTOP.
 *
 * POR QUÉ NO wa.me EN DESKTOP: `wa.me` redirige a
 * `api.whatsapp.com/send`, que es una pantalla intermedia ("Chatea en WhatsApp
 * con…", "Abrir aplicación" / "Continuar en WhatsApp Web"). Ese paso extra es
 * el que terminaba abriendo pestañas y sesiones nuevas: el usuario elegía
 * "Continuar en WhatsApp Web" y el navegador estrenaba pestaña, fuera del
 * control del nombre de ventana que fija este módulo.
 *
 * Apuntando directo a `web.whatsapp.com/send` no hay intermediaria, y la
 * navegación ocurre DENTRO de la pestaña `techrepair_whatsapp` ya abierta.
 */
export function buildWebSendUrl(
  phone: string | null | undefined,
  message: string,
): ResultadoHandoff {
  const telefono = normalizeWhatsAppPhone(phone)
  if (!telefono.valid) {
    return { ok: false, error: telefono.error ?? 'Número de teléfono inválido' }
  }
  if (!message.trim()) {
    return { ok: false, error: 'El mensaje está vacío' }
  }
  return {
    ok: true,
    telefono: telefono.normalized,
    url: `https://web.whatsapp.com/send?phone=${telefono.normalized}&text=${encodeURIComponent(message)}`,
  }
}

/**
 * URL de handoff según la plataforma.
 *
 *  · Desktop → `web.whatsapp.com/send` (sin pantalla intermedia).
 *  · Móvil   → `wa.me` , que es el que deja al sistema abrir la app nativa.
 *              Forzar `web.whatsapp.com` en un teléfono lo mandaría al WhatsApp
 *              Web del navegador móvil, que es peor que la app.
 *
 * `esMobile` es inyectable para poder testear las dos ramas sin tocar el
 * user-agent. Por defecto usa `isMobileDevice()`, el mecanismo que el proyecto
 * ya venía usando — no se agrega una detección nueva.
 */
export function buildHandoffUrl(
  phone: string | null | undefined,
  message: string,
  esMobile: boolean = isMobileDevice(),
): ResultadoHandoff {
  return esMobile ? buildWaMeUrl(phone, message) : buildWebSendUrl(phone, message)
}

export type AperturaHandoff =
  | { abierto: true }
  | { abierto: false; error: string }

const ERROR_POPUP =
  'El navegador bloqueó la ventana. Permití las ventanas emergentes para este sitio o copiá el mensaje.'

/**
 * Lo único que este módulo necesita de la pestaña destino.
 *
 * Se declara como interfaz propia en vez de `Window` porque, una vez que la
 * pestaña navegó a WhatsApp, es cross-origin y SÓLO estas cuatro cosas siguen
 * siendo accesibles desde acá: leer `closed`, ESCRIBIR `location.href`
 * (navegar), y llamar `focus()`. Leer la URL, el DOM o cualquier otra cosa
 * lanza. `opener` sólo se puede tocar mientras sigue en about:blank.
 */
export interface PestanaHandoff {
  readonly closed: boolean
  opener: unknown
  location: { href: string }
  focus?: () => void
}

/**
 * POR QUÉ NO ALCANZA EL NOMBRE DE VENTANA
 *
 * El primer diseño repetía `window.open(url, 'techrepair_whatsapp')` confiando
 * en que el navegador reutilizara la pestaña por nombre. No alcanza: el HTML
 * Standard **resetea `window.name` cuando el browsing context navega a otro
 * origen**. Nuestro salto es techrepairpro.app → web.whatsapp.com, o sea
 * cross-origin, así que después del primer handoff esa pestaña ya no responde
 * al nombre y el segundo `open` estrena una nueva. Es justo el bug que se
 * quería cerrar. (Los tests que sólo comparaban el string del target no podían
 * verlo: mockean `window.open` y no reproducen esa regla del navegador.)
 *
 * Por eso se conserva una referencia real al `WindowProxy`:
 *
 *  1. Primer handoff, dentro del click: `open('', TARGET)` → about:blank, que
 *     todavía es SAME-ORIGIN.
 *  2. Ahí, y sólo ahí, se puede hacer `opener = null`: WhatsApp no queda con
 *     una referencia de vuelta a TechRepair. (No se usa `noopener` en el open
 *     porque devuelve `null` y nos dejaría sin referencia, que es lo único que
 *     hace funcionar la reutilización.)
 *  3. Se guarda la referencia y se navega con `location.href = url`.
 *  4. Handoffs siguientes: si la referencia vive y no está cerrada, se navega
 *     ESA misma pestaña. No se vuelve a llamar `open`.
 *
 * LÍMITE EXPLÍCITO: la referencia vive en memoria de esta pestaña de
 * TechRepair. Un reload completo, cerrar TechRepair o una sesión nueva la
 * pierden, y no hay forma de redescubrir una pestaña de WhatsApp ya abierta —
 * el navegador no deja enumerar pestañas ajenas. El contrato honesto es:
 * *TechRepair reutiliza una única pestaña de WhatsApp mientras esta sesión de
 * la app siga cargada*, que es lo que resuelve el problema real de acumular
 * pestañas durante el uso normal.
 */
export function crearHandoffWhatsApp(
  abrirVentana: (url: string, target: string) => PestanaHandoff | null =
    (u, t) => window.open(u, t) as unknown as PestanaHandoff | null,
) {
  let pestana: PestanaHandoff | null = null

  const enfocar = (p: PestanaHandoff) => {
    // Best-effort: `focus` sí está permitido cross-origin, pero algunos
    // navegadores lo ignoran o lanzan. No poder enfocar NO invalida la
    // apertura: el mensaje igual quedó cargado en la pestaña.
    try { p.focus?.() } catch { /* el navegador no la deja enfocar */ }
  }

  /**
   * @param reutilizar false en móvil: ahí `wa.me` se lo lleva el sistema
   *        operativo a la app nativa y guardar un WindowProxy no aporta nada.
   */
  function abrir(url: string, { reutilizar = true }: { reutilizar?: boolean } = {}): AperturaHandoff {
    if (!reutilizar) {
      const win = abrirVentana(url, WHATSAPP_WINDOW_NAME)
      if (!win) return { abierto: false, error: ERROR_POPUP }
      enfocar(win)
      return { abierto: true }
    }

    // Reutilización por REFERENCIA.
    if (pestana && !pestana.closed) {
      pestana.location.href = url
      enfocar(pestana)
      return { abierto: true }
    }

    // No hay pestaña viva (primer handoff, o el usuario la cerró).
    const win = abrirVentana('', WHATSAPP_WINDOW_NAME)
    if (!win) {
      pestana = null
      return { abierto: false, error: ERROR_POPUP }
    }
    // about:blank hereda el origen: es el ÚNICO momento en que se puede cortar
    // el vínculo de vuelta antes de mandarla a WhatsApp.
    try { win.opener = null } catch { /* no se pudo; se sigue igual */ }
    pestana = win
    win.location.href = url
    enfocar(win)
    return { abierto: true }
  }

  /** Sólo para tests: descarta la referencia viva. */
  function _olvidarPestana() { pestana = null }

  return { abrir, _olvidarPestana }
}

const handoffPorDefecto = crearHandoffWhatsApp()

/** Abre (o reutiliza) la pestaña de WhatsApp de esta sesión. */
export function abrirWhatsApp(
  url: string,
  opciones: { reutilizar?: boolean } = {},
): AperturaHandoff {
  return handoffPorDefecto.abrir(url, opciones)
}

/**
 * Descarta la referencia viva del singleton. SÓLO para tests.
 *
 * La referencia sobrevive a propósito entre aperturas del modal — es lo que
 * hace que WhatsApp se reutilice aunque el mensaje salga de otra pantalla —
 * así que en una suite hay que soltarla entre casos o el segundo test hereda
 * la pestaña del primero.
 */
export function _olvidarPestanaWhatsApp(): void {
  handoffPorDefecto._olvidarPestana()
}
