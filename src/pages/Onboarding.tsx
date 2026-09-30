/**
 * Onboarding.tsx — CONFIGURACIÓN del negocio.
 *
 * P0-P5. El wizard NO crea tenants: cuando esta pantalla se monta el negocio ya
 * existe (lo creó `provision_my_business()` desde /no-business o desde el alta).
 * Acá sólo se configura, y toda la persistencia va por `businessSetupService`.
 *
 * ── QUÉ SE ARREGLÓ ───────────────────────────────────────────────────────────
 * La versión anterior hacía seis `supabase.from('businesses').update(...)`
 * sueltos. TODOS fallaban:
 *   · 42501 — `authenticated` no tiene GRANT de UPDATE sobre `businesses`;
 *   · 42703 — `condicion_fiscal`, `cuit` y `payment_methods_enabled` ni
 *     siquiera existen en esa tabla (los fiscales viven en business_settings).
 *
 * Y no se veía porque `supabase.from().update()` NO LANZA: devuelve
 * `{ data, error }`. El código hacía `await ...update(...)` sin mirar `error`,
 * así que el try/catch no atrapaba nada y el paso avanzaba igual.
 * MEDIDO: de 26 negocios productivos, 1 tenía rubro y 2 tenían logo.
 *
 * Ahora cada paso espera el resultado, corta si falla y precarga desde la DB.
 *
 * ── PRE-BETA-3A-1a ───────────────────────────────────────────────────────────
 * El onboarding es SÓLO configuración: cuatro pasos (src/lib/onboardingSteps.ts,
 * única fuente de cantidad, progreso, navegación y reanudación) y un estado
 * final que entrega al producto. Salieron el paso comercial del trial (la
 * autoridad del trial es SubscriptionBanner + Suscripción) y el checklist
 * estático del final: «Primeros pasos» vive sólo en el Dashboard, derivado del
 * servidor. El plan elegido en la landing se sigue conservando para
 * `signup_completed`, pero ya no se muestra. La finalización no cambió.
 */
import { useState, useEffect, useRef, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { ArrowRight, Building2, CheckCircle2, ImagePlus } from 'lucide-react'
import { useAuth } from '../contexts/AuthContext'
import { uploadBusinessLogo, LogoUploadError } from '../lib/storageSetup'
import { track } from '../lib/analytics'
import { logger } from '../lib/logger'
import {
  businessSetupService, BusinessSetupError, type BusinessSetup,
} from '../services/businessSetupService'
import type { SubscriptionPlan } from '../types/subscription'
import { clearSignupPlan, isValidPlan, readSignupPlan } from '../lib/signupIntent'
import { CONDICIONES_FISCALES as CONDICIONES_UI } from '../lib/fiscalCondition'
import { isPlaceholderBusinessName } from '../lib/businessIdentity'
import {
  ONBOARDING_STEP_COUNT, canGoBackFrom, nextOnboardingPosition, onboardingProgressLabel,
  onboardingStepAt, previousOnboardingPosition, resumeOnboardingPosition,
} from '../lib/onboardingSteps'
import {
  AuthFlowShell, AuthFlowLoading, AuthFlowForm, AuthFlowField, AuthFlowChoiceGroup,
  AuthFlowError, AuthFlowActions, AuthFlowPrimaryButton, AuthFlowSecondaryButton, AuthFlowTextButton,
} from '../components/auth/AuthFlowShell'

// Plan elegido en la landing (?plan=...). Persistido temporalmente para
// sobrevivir un refresh durante el onboarding. Se valida contra PLANS
// (`isValidPlan` vive en src/lib/signupIntent.ts, junto al CTA que lo emite).
const ORIGIN_PLAN_KEY = 'trp_origin_plan'

const RUBROS = [
  { id: 'celulares',        label: 'Celulares y smartphones' },
  { id: 'computadoras',     label: 'Computadoras y laptops' },
  { id: 'electrodomesticos',label: 'Electrónica y electrodomésticos' },
  { id: 'tecnico_general',  label: 'Técnico general' },
  { id: 'redes',            label: 'Redes y telecomunicaciones' },
  { id: 'otro',             label: 'Otro rubro' },
]

// P0-ONB1: la lista canónica vive en `src/lib/fiscalCondition.ts` y la comparte
// con Configuración. Tenerla duplicada acá fue la causa de que las dos
// pantallas usaran vocabularios distintos sobre la MISMA columna.
//
// Cambios visibles respecto de la lista anterior de este archivo:
//   · 'Monotributo'              -> 'Responsable Monotributo' (nombre real)
//   · 'Consumidor Final interno' -> 'Consumidor Final'
//   · se suma 'Monotributista Social', que Configuración ya ofrecía y el
//     wizard no: elegirla acá dejaba de ser posible y no hay razón para eso.
const CONDICIONES_FISCALES = CONDICIONES_UI.map(c => ({ id: c.slug, label: c.label }))

export function Onboarding() {
  const { authState, refreshProfile } = useAuth()
  const navigate = useNavigate()

  const [originPlan, setOriginPlan] = useState<SubscriptionPlan | null>(null)
  const signupCompletedRef = useRef(false)

  // ── Estado del wizard ──────────────────────────────────────────────────────
  const [cargando, setCargando]                 = useState(true)
  const [setup, setSetup]                       = useState<BusinessSetup | null>(null)
  const [step, setStep]                         = useState(1)
  const [businessName, setBusinessName]         = useState('')
  const [rubro, setRubro]                       = useState('')
  const [logoFile, setLogoFile]                 = useState<File | null>(null)
  const [logoPreview, setLogoPreview]           = useState<string | null>(null)
  const [whatsapp, setWhatsapp]                 = useState('')
  const [ciudad, setCiudad]                     = useState('')
  const [condicionFiscal, setCondicionFiscal]   = useState('')
  const [cuit, setCuit]                         = useState('')
  const [saving, setSaving]                     = useState(false)
  const [error, setError]                       = useState('')

  // ── Guard de routing ───────────────────────────────────────────────────────
  // Se decide SÓLO por `authState`: mientras esté en un estado de espera no se
  // redirige. Es lo que evita el rebote prematuro que tenía la versión anterior.
  useEffect(() => {
    if (authState === 'AUTH_LOADING' || authState === 'AUTHENTICATED_PROFILE_LOADING') return
    if (authState === 'UNAUTHENTICATED') { navigate('/login', { replace: true }); return }
    if (authState === 'EMAIL_UNCONFIRMED') { navigate('/verificar-email', { replace: true }); return }
    // Sin negocio NO se puede configurar nada: el alta del tenant es una acción
    // explícita del usuario y vive en /no-business.
    if (authState === 'AUTHENTICATED_WITHOUT_BUSINESS' || authState === 'AUTH_ERROR') {
      navigate('/no-business', { replace: true })
    }
  }, [authState, navigate])

  useEffect(() => {
    const fromUrl = new URLSearchParams(window.location.search).get('plan')
    const stored = (() => { try { return sessionStorage.getItem(ORIGIN_PLAN_KEY) } catch { return null } })()
    // PRE-BETA-2D — si el alta se confirmó en OTRA pestaña, el plan llega por
    // localStorage (src/lib/signupIntent.ts). Se consume una sola vez.
    const candidate = fromUrl ?? stored ?? readSignupPlan()
    clearSignupPlan()
    if (isValidPlan(candidate)) {
      setOriginPlan(candidate)
      try { sessionStorage.setItem(ORIGIN_PLAN_KEY, candidate) } catch { /* no-op */ }
    }
  }, [])

  // ── PRECARGA / REANUDACIÓN ─────────────────────────────────────────────────
  // Los datos salen de la DB, no del estado de React: cerrar la pestaña en el
  // paso 3 y volver ya no pierde lo guardado.
  useEffect(() => {
    if (authState !== 'AUTHENTICATED_WITH_BUSINESS') return
    let vivo = true

    ;(async () => {
      try {
        const actual = await businessSetupService.getMyBusinessSetup()
        if (!vivo) return

        setSetup(actual)
        // `Mi Negocio` es el nombre por defecto de `provision_my_business`: se
        // trata como «todavía sin elegir» para que el usuario no tenga que
        // borrarlo a mano.
        //
        // P0-ONB1: la comparación literal pasa a `isPlaceholderBusinessName`,
        // que es la MISMA regla que usan las superficies de impresión. Que este
        // archivo supiera que «Mi Negocio» no es un nombre real mientras los
        // comprobantes lo imprimían como si lo fuera era, literalmente, el bug.
        setBusinessName(isPlaceholderBusinessName(actual.name) ? '' : actual.name)
        setRubro(actual.rubro ?? '')
        setCiudad(actual.ciudad ?? '')
        setWhatsapp(actual.whatsapp ?? '')
        setCuit(actual.cuit ?? '')
        setCondicionFiscal(actual.condicionFiscal ?? '')
        setLogoPreview(actual.logoUrl)

        // Se retoma en el PRIMER paso que todavía tiene algo pendiente, en vez
        // de volver siempre al principio. Los campos ya guardados llegan
        // precargados, así que avanzar es sólo confirmar. La regla de cada paso
        // vive en ONBOARDING_STEPS; sin nada pendiente, el estado final.
        setStep(resumeOnboardingPosition(actual))
      } catch (e) {
        if (!vivo) return
        logger.error('AUTH', 'Onboarding: no se pudo precargar la configuración', e)
        setError(e instanceof BusinessSetupError ? e.message : 'No se pudo cargar la configuración de tu negocio.')
      } finally {
        if (vivo) setCargando(false)
      }
    })()

    return () => { vivo = false }
  }, [authState])

  /**
   * Guarda un tramo y sólo avanza si el servidor confirmó.
   *
   * Es el corazón del arreglo: antes cada paso avanzaba pasara lo que pasara.
   */
  const guardarYAvanzar = useCallback(async (
    patch: Parameters<typeof businessSetupService.updateMyBusinessSetup>[0],
    siguiente: number,
  ): Promise<void> => {
    setSaving(true); setError('')
    try {
      const actualizado = await businessSetupService.updateMyBusinessSetup(patch)
      setSetup(actualizado)
      setStep(siguiente)
    } catch (e) {
      if (!(e instanceof BusinessSetupError)) {
        logger.error('AUTH', 'Onboarding: fallo inesperado al guardar', e)
      }
      setError(e instanceof BusinessSetupError ? e.message : 'No se pudo guardar. Intentá nuevamente.')
      // NO se avanza: el dato obligatorio no quedó persistido.
    } finally {
      setSaving(false)
    }
  }, [])

  // Navegación derivada de ONBOARDING_STEPS. «Omitir» y «Atrás» no persisten
  // nada ni pisan lo guardado; el error del paso que se deja no lo acompaña.
  const siguiente = nextOnboardingPosition(step)
  const omitir = () => { setError(''); setStep(siguiente) }
  const volver = () => { setError(''); setStep(previousOnboardingPosition(step)) }

  // ── Paso 1: identidad del negocio (obligatorio) ────────────────────────────
  const handleStep1 = () => {
    if (!businessName.trim()) { setError('El nombre del negocio es obligatorio'); return }
    if (!rubro)               { setError('Seleccioná el rubro de tu negocio'); return }
    void guardarYAvanzar({ name: businessName.trim(), rubro }, siguiente)
  }

  // ── Paso 2: logo (opcional) ────────────────────────────────────────────────
  const handleLogoChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setLogoFile(file)
    setLogoPreview(URL.createObjectURL(file))
    setError('')
  }

  const handleStep2 = async () => {
    if (!logoFile) { setStep(siguiente); return }

    setSaving(true); setError('')
    try {
      const url = await uploadBusinessLogo(logoFile, setup!.businessId)
      const actualizado = await businessSetupService.updateMyBusinessSetup({ logoUrl: url })
      setSetup(actualizado)
      setLogoPreview(actualizado.logoUrl)
      setLogoFile(null)
      setStep(siguiente)
    } catch (e) {
      // El logo es OPCIONAL: su fallo se muestra pero no bloquea el wizard, y el
      // usuario puede omitirlo. Lo que ya NO pasa es que falle en silencio.
      const msg = e instanceof LogoUploadError || e instanceof BusinessSetupError
        ? e.message
        : 'No se pudo subir el logo.'
      setError(`${msg} Podés omitir este paso y cargarlo después desde Configuración.`)
      if (!(e instanceof LogoUploadError) && !(e instanceof BusinessSetupError)) {
        logger.error('AUTH', 'Onboarding: fallo inesperado subiendo el logo', e)
      }
    } finally {
      setSaving(false)
    }
  }

  // ── Paso 3: contacto (opcional) ────────────────────────────────────────────
  const handleStep3 = () => {
    void guardarYAvanzar({ whatsapp: whatsapp.trim(), ciudad: ciudad.trim() }, siguiente)
  }

  // ── Paso 4: fiscal (opcional) ──────────────────────────────────────────────
  const handleStep4 = () => {
    void guardarYAvanzar({ cuit: cuit.trim(), condicionFiscal: condicionFiscal || '' }, siguiente)
  }

  // ── Final: completar ───────────────────────────────────────────────────────
  const handleFinish = async () => {
    if (signupCompletedRef.current) { navigate('/dashboard', { replace: true }); return }

    setSaving(true); setError('')
    try {
      // El servidor valida contra lo REALMENTE persistido, no contra el estado
      // local: si un paso obligatorio falló antes, esto no marca completo.
      const actualizado = await businessSetupService.updateMyBusinessSetup({ complete: true })
      setSetup(actualizado)

      signupCompletedRef.current = true
      track('signup_completed', { business_id: actualizado.businessId, plan: originPlan ?? null, source: 'onboarding' })
      try { sessionStorage.removeItem(ORIGIN_PLAN_KEY) } catch { /* no-op */ }

      // El nombre y el rubro del negocio acaban de cambiar: sin refrescar, el
      // shell seguiría mostrando los datos viejos.
      await refreshProfile()
      navigate('/dashboard', { replace: true })
    } catch (e) {
      if (e instanceof BusinessSetupError && e.code === 'ONBOARDING_INCOMPLETE') {
        setError('Faltan datos obligatorios. Volvé al primer paso y completá el nombre y el rubro.')
        setStep(1)
        return
      }
      if (!(e instanceof BusinessSetupError)) {
        logger.error('AUTH', 'Onboarding: fallo inesperado al finalizar', e)
      }
      setError(e instanceof BusinessSetupError ? e.message : 'No se pudo finalizar. Intentá nuevamente.')
    } finally {
      setSaving(false)
    }
  }

  // ── Espera ─────────────────────────────────────────────────────────────────
  if (authState !== 'AUTHENTICATED_WITH_BUSINESS' || cargando) {
    return <AuthFlowLoading label="Cargando la configuración de tu negocio…" testId="onboarding-loading" />
  }

  // Sólo owner/admin configuran. A los demás se les dice por qué en vez de
  // dejarlos chocar contra un 42501 al guardar.
  if (setup && !setup.canEdit) {
    return (
      <AuthFlowShell
        testId="onboarding-page"
        align="center"
        icon={<Building2 size={26} />}
        title={`Ya estás dentro de ${setup.name}`}
        description="La configuración inicial la completa el dueño o un administrador del negocio."
      >
        <AuthFlowPrimaryButton data-testid="onboarding-ir-dashboard" onClick={() => navigate('/dashboard', { replace: true })}>
          Ir al inicio
        </AuthFlowPrimaryButton>
      </AuthFlowShell>
    )
  }

  const paso = onboardingStepAt(step)
  const errorNode = error ? <AuthFlowError testId="onboarding-error">{error}</AuthFlowError> : null
  const continuar = <ArrowRight size={18} aria-hidden="true" />

  return (
    <AuthFlowShell
      testId="onboarding-page"
      cardTestId={paso ? `onboarding-step-${paso.id}` : 'onboarding-done'}
      contentKey={step}
      progress={{
        total: ONBOARDING_STEP_COUNT,
        current: step,
        label: onboardingProgressLabel(step),
        testId: 'onboarding-progress',
      }}
      back={canGoBackFrom(step)
        ? { label: 'Atrás', onClick: volver, disabled: saving, testId: 'onboarding-back' }
        : undefined}
      align={paso ? 'start' : 'center'}
      tone={paso ? 'accent' : 'success'}
      icon={paso ? undefined : <CheckCircle2 size={28} />}
      eyebrow={paso?.label}
      title={paso ? paso.title : 'Todo listo'}
      description={paso ? paso.description : (
        <>
          <p>Tu negocio ya está configurado.</p>
          <p>Desde Inicio vas a poder completar tus primeros pasos y empezar a trabajar.</p>
        </>
      )}
    >
      {/* ── Paso 1: Tu negocio ─────────────────────────────────────────── */}
      {paso?.id === 'negocio' && (
        <AuthFlowForm>
          <AuthFlowField label="Nombre del negocio" htmlFor="onboarding-business-name">
            <input
              id="onboarding-business-name" data-testid="onboarding-business-name" className="form-control"
              autoFocus autoComplete="organization" placeholder="Ej: Tecno Reparaciones"
              value={businessName} onChange={e => setBusinessName(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && !saving && handleStep1()}
            />
          </AuthFlowField>
          <AuthFlowChoiceGroup
            label="Rubro principal" options={RUBROS} value={rubro} onChange={setRubro}
            testIdPrefix="onboarding-rubro-"
          />
          {errorNode}
          <AuthFlowPrimaryButton data-testid="onboarding-step1-submit" onClick={handleStep1} loading={saving} rightIcon={continuar}>
            {saving ? 'Guardando…' : 'Continuar'}
          </AuthFlowPrimaryButton>
        </AuthFlowForm>
      )}

      {/* ── Paso 2: Identidad ──────────────────────────────────────────── */}
      {paso?.id === 'identidad' && (
        <AuthFlowForm>
          <label className="auth-flow__upload">
            <span className={`auth-flow__upload-tile${logoPreview ? ' has-image' : ''}`}>
              {logoPreview
                ? <img src={logoPreview} alt="Logo del negocio" />
                : <><ImagePlus size={28} aria-hidden="true" /><span>Subir logo</span></>}
            </span>
            <span className="sr-only">Elegir el logo del negocio</span>
            <input
              data-testid="onboarding-logo-input" type="file" accept="image/png,image/jpeg,image/webp"
              className="sr-only" onChange={handleLogoChange}
            />
          </label>
          {logoFile && (
            <AuthFlowTextButton onClick={() => { setLogoFile(null); setLogoPreview(setup?.logoUrl ?? null) }}>
              Quitar logo
            </AuthFlowTextButton>
          )}
          {errorNode}
          <AuthFlowActions>
            <AuthFlowSecondaryButton data-testid="onboarding-logo-skip" onClick={omitir} disabled={saving}>Omitir</AuthFlowSecondaryButton>
            <AuthFlowPrimaryButton data-testid="onboarding-step2-submit" onClick={() => void handleStep2()} loading={saving} rightIcon={continuar}>
              {saving ? 'Guardando…' : logoFile ? 'Guardar logo' : 'Continuar'}
            </AuthFlowPrimaryButton>
          </AuthFlowActions>
        </AuthFlowForm>
      )}

      {/* ── Paso 3: Contacto ───────────────────────────────────────────── */}
      {paso?.id === 'contacto' && (
        <AuthFlowForm>
          <AuthFlowField label="WhatsApp del negocio" htmlFor="onboarding-whatsapp" optional>
            <input
              id="onboarding-whatsapp" data-testid="onboarding-whatsapp" className="form-control"
              type="tel" inputMode="tel" autoComplete="tel" placeholder="3512345678"
              value={whatsapp} onChange={e => setWhatsapp(e.target.value)}
            />
          </AuthFlowField>
          <AuthFlowField label="Ciudad / Localidad" htmlFor="onboarding-ciudad" optional>
            <input
              id="onboarding-ciudad" data-testid="onboarding-ciudad" className="form-control"
              type="text" autoComplete="address-level2" placeholder="Ej: Córdoba"
              value={ciudad} onChange={e => setCiudad(e.target.value)}
            />
          </AuthFlowField>
          {errorNode}
          <AuthFlowActions>
            <AuthFlowSecondaryButton data-testid="onboarding-step3-skip" onClick={omitir} disabled={saving}>Omitir</AuthFlowSecondaryButton>
            <AuthFlowPrimaryButton data-testid="onboarding-step3-submit" onClick={handleStep3} loading={saving} rightIcon={continuar}>
              {saving ? 'Guardando…' : 'Continuar'}
            </AuthFlowPrimaryButton>
          </AuthFlowActions>
        </AuthFlowForm>
      )}

      {/* ── Paso 4: Datos fiscales ─────────────────────────────────────── */}
      {paso?.id === 'fiscal' && (
        <AuthFlowForm>
          <AuthFlowChoiceGroup
            label="Condición fiscal" optional options={CONDICIONES_FISCALES} value={condicionFiscal}
            onChange={setCondicionFiscal} testIdPrefix="onboarding-cond-"
          />
          <AuthFlowField label="CUIT" htmlFor="onboarding-cuit" optional hint="11 dígitos, sin guiones.">
            <input
              id="onboarding-cuit" data-testid="onboarding-cuit" className="form-control"
              type="text" inputMode="numeric" maxLength={11} placeholder="20123456789"
              aria-describedby="onboarding-cuit-hint"
              value={cuit} onChange={e => setCuit(e.target.value.replace(/\D/g, ''))}
            />
          </AuthFlowField>
          {errorNode}
          <AuthFlowActions>
            <AuthFlowSecondaryButton data-testid="onboarding-step4-skip" onClick={omitir} disabled={saving}>Omitir</AuthFlowSecondaryButton>
            <AuthFlowPrimaryButton data-testid="onboarding-step4-submit" onClick={handleStep4} loading={saving} rightIcon={continuar}>
              {saving ? 'Guardando…' : 'Continuar'}
            </AuthFlowPrimaryButton>
          </AuthFlowActions>
        </AuthFlowForm>
      )}

      {/* ── Final: Todo listo ──────────────────────────────────────────── */}
      {!paso && (
        <AuthFlowForm>
          {errorNode}
          <AuthFlowPrimaryButton data-testid="onboarding-finish" onClick={() => void handleFinish()} loading={saving}>
            {saving ? 'Finalizando…' : 'Ir al inicio'}
          </AuthFlowPrimaryButton>
        </AuthFlowForm>
      )}
    </AuthFlowShell>
  )
}
