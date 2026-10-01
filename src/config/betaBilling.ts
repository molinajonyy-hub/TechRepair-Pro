/**
 * BETA-1 — Autoridad ÚNICA del checkout de suscripción.
 *
 * Durante la beta la app NO inicia cobros de Mercado Pago: quien necesite más
 * tiempo o quiera un plan escribe por Ayuda y el acceso se extiende a mano
 * desde SaaS Admin. Planes sigue mostrando precios, pero ningún CTA crea un
 * checkout.
 *
 * Es un switch, no un borrado: `mp-subscription`, el webhook y todo el flujo de
 * pago siguen en el repo. Para reabrir el checkout se cambia este valor a
 * `true` y nada más — cada superficie consulta `isBillingCheckoutEnabled()`,
 * ninguna tiene su propio criterio.
 *
 * Módulo HOJA (sin imports ni import.meta) → cargable bajo `node --test`.
 */
export const BETA_BILLING_CHECKOUT_ENABLED = false

/**
 * Lectura canónica del flag. Los componentes y `subscriptionService` usan esta
 * función y no la constante: devuelve `boolean` (no el literal `false`), así
 * las dos ramas se tipan y se testean igual.
 */
export function isBillingCheckoutEnabled(): boolean {
  return BETA_BILLING_CHECKOUT_ENABLED
}

/** Error estable del servicio cuando alguien intenta crear un checkout apagado. */
export const BILLING_CHECKOUT_DISABLED_MESSAGE =
  'La activación de planes se coordina con nuestro equipo durante la beta. Escribinos desde Ayuda.'
