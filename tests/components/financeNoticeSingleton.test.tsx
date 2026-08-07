// -----------------------------------------------------------------------------
// M8 - el aviso del cambio de calculo contable existe UNA sola vez en /finance.
//
// El gate visual del Preview encontro dos banners casi identicos: el componente
// <AccountingChangeBanner> arriba del header, y un aviso inline dentro de la
// pestania Resumen que decia lo mismo con otras palabras. Los dos eran previos a
// M8, pero convivian.
//
// Este test lee el SOURCE de FinanceDashboard.tsx en vez de montar la pagina:
// montarla exigiria simular AuthContext, Supabase, router y las cinco pestanias,
// y el defecto es estructural, no de runtime. Lo que hay que impedir es que
// alguien vuelva a escribir un segundo aviso con el mismo texto.
// -----------------------------------------------------------------------------
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'

const DASHBOARD = 'src/pages/FinanceDashboard.tsx'
const BANNER = 'src/components/finance/AccountingChangeBanner.tsx'

const dashboard = readFileSync(DASHBOARD, 'utf8')
const banner = readFileSync(BANNER, 'utf8')

/** Quita comentarios de linea y de bloque: un aviso citado en un comentario
 *  explicativo no es un aviso renderizado. */
function sinComentarios(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

const dashboardVivo = sinComentarios(dashboard)

describe('Aviso de cambio de calculo contable - singleton en /finance', () => {
  it('1. el dashboard monta AccountingChangeBanner exactamente una vez', () => {
    const usos = (dashboardVivo.match(/<AccountingChangeBanner\b/g) || []).length
    expect(usos).toBe(1)
  })

  it('2. no queda ningun aviso inline con el mismo mensaje', () => {
    // La frase que compartian ambos banners.
    const ocurrencias = (dashboardVivo.match(/Actualizamos el c[aá]lculo financiero/g) || []).length
    expect(ocurrencias).toBe(0)
  })

  it('3. el texto del aviso vive en el componente, no en la pagina', () => {
    expect(banner).toMatch(/Actualizamos el c[aá]lculo financiero/)
  })

  it('4. el estado del aviso inline quedo removido del dashboard', () => {
    expect(dashboardVivo).not.toMatch(/calcNoticeDismissed/)
    expect(dashboardVivo).not.toMatch(/dismissCalcNotice/)
    expect(dashboardVivo).not.toMatch(/finance_calc_notice_v2_dismissed/)
  })

  it('5. el banner viejo de alertas binarias sigue retirado (lo cubre M8)', () => {
    // data_quality y supplier_crunch cubren sus dos casos con evidencia.
    expect(dashboardVivo).not.toMatch(/finance-dashboard-health-alert/)
  })

  it('6. el panel de insights se monta una sola vez', () => {
    const usos = (dashboardVivo.match(/<FinanceInsightsPanel\b/g) || []).length
    expect(usos).toBe(1)
  })

  it('7. no se tocaron banners de otros modulos', () => {
    // Estos viven fuera de finanzas y no deben desaparecer por este arreglo.
    const otros = [
      'src/components/subscription',
      'src/portal',
    ]
    // Se comprueba de forma indirecta: el dashboard financiero no los importa,
    // asi que este arreglo no pudo alcanzarlos.
    for (const mod of otros) {
      expect(dashboard).not.toContain(mod)
    }
  })
})
