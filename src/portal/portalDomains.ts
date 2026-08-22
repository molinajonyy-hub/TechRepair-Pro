// Dominios exclusivos del portal — sin prefijo /mayorista/:slug en la URL.
//
// Vive en su propio módulo (y no dentro de PortalRouter.tsx) porque lo consume
// también `AuthCallback`, que no tiene por qué arrastrar el árbol entero de
// páginas del portal sólo para preguntar por un hostname.
export const PORTAL_DOMAINS: Record<string, string> = {
  'clicmayorista.com.ar':     'clic',
  'www.clicmayorista.com.ar': 'clic',
}

// Mapa inverso: slug → dominio público dedicado del portal.
export const PORTAL_PUBLIC_DOMAINS: Record<string, string> = {
  clic: 'https://clicmayorista.com.ar',
}
