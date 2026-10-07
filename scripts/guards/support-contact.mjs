#!/usr/bin/env node
// ============================================================================
// GUARD — BETA-UX-1A · canal de soporte (VITE_CONTACT_WHATSAPP)
//
// El WhatsApp de ayuda de producción fue `+594…` (Guayana Francesa) en vez de
// `+549…`: una transposición en la variable de Vercel que ningún gate miraba.
// Ayuda, la pantalla global de error y el muro de fin de prueba abrían un chat
// con un número que no es el del soporte.
//
// Tres capas, una sola regla (`validarWhatsAppSoporte`, src/config/contacto.ts):
//
//   1. runtime  la app no arma un enlace con un valor inválido;
//   2. build    `vite build` falla antes de empaquetar (plugin de
//               support-contact-build.mjs, cableado en vite.config.ts);
//   3. este CLI valida un valor a mano antes de cargarlo en Vercel.
//
//   node scripts/guards/support-contact.mjs               valida la variable del entorno
//   node scripts/guards/support-contact.mjs --production  la exige, como un deploy productivo
//   node scripts/guards/support-contact.mjs --self-test
//
// El self-test no se queda en la función pura: resuelve el `vite.config.ts`
// REAL con cada valor, así que también falla si alguien descablea el plugin.
// Necesita Node >= 22.18 (importa TypeScript, como el guard de CI E2E).
// ============================================================================
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validarWhatsAppSoporte } from '../../src/config/contacto.ts'
import { VARIABLE, esDeployProductivo, evaluarSoporteDeBuild } from './support-contact-build.mjs'

const RAIZ = resolve(fileURLToPath(new URL('../..', import.meta.url)))

// Número de soporte confirmado por el owner (2026-10-05). Es público —lo
// publica el pie de la landing— y acá es sólo un caso de prueba: la app lo lee
// de la variable de entorno, nunca de este archivo.
const SOPORTE = '5493574404419'

// ── Self-test ────────────────────────────────────────────────────────────────

/** [etiqueta, valor, número esperado | null si debe rechazarse] */
const CASOS_REGLA = [
  ['número productivo canónico', SOPORTE, SOPORTE],
  ['formato internacional legible', '+54 9 3574 404419', SOPORTE],
  ['con guiones y paréntesis', '+54 9 (3574) 40-4419', SOPORTE],
  ['transposición 594 (el valor que estuvo en producción)', '5943574404419', null],
  ['transposición 594 con +', '+5943574404419', null],
  ['celular argentino sin el 9', '543574404419', null],
  ['número local, sin código de país', '3574404419', null],
  ['truncado (12 dígitos)', '549357440441', null],
  ['un dígito de más (14)', '54935744044190', null],
  ['otro país', '5511987654321', null],
  ['vacío', '', null],
  ['sólo espacios', '   ', null],
  ['undefined', undefined, null],
  ['null', null, null],
  ['letras', 'pendiente', null],
  ['número válido con basura pegada', `${SOPORTE}x`, null],
  ['una URL en vez del número', `https://wa.me/${SOPORTE}`, null],
]

/** [etiqueta, valor, productivo, nivel esperado] */
const CASOS_POLITICA = [
  ['producción + válido', SOPORTE, true, 'ok'],
  ['producción + vacío', '', true, 'error'],
  ['producción + ausente', undefined, true, 'error'],
  ['producción + 594', '5943574404419', true, 'error'],
  ['producción + sin 9', '543574404419', true, 'error'],
  ['fuera de producción + ausente', undefined, false, 'aviso'],
  ['fuera de producción + válido', SOPORTE, false, 'ok'],
  ['fuera de producción + 594 (inválido es inválido en cualquier entorno)', '5943574404419', false, 'error'],
  ['fuera de producción + basura', 'pendiente', false, 'error'],
]

/** [etiqueta, VERCEL_ENV, valor (undefined = ausente), ¿el build debe pasar?] */
const CASOS_BUILD = [
  ['Production + número canónico', 'production', SOPORTE, true],
  ['Production + formato legible', 'production', '+54 9 3574 404419', true],
  ['Production + 594', 'production', '5943574404419', false],
  ['Production + sin 9', 'production', '543574404419', false],
  ['Production + ausente', 'production', undefined, false],
  ['Production + basura', 'production', 'pendiente', false],
  ['Preview + ausente (aviso)', 'preview', undefined, true],
  ['Preview + 594', 'preview', '5943574404419', false],
  ['local/CI + ausente (aviso)', undefined, undefined, true],
  ['local/CI + número canónico', undefined, SOPORTE, true],
]

/** Resuelve el vite.config.ts real, como `vite build`, sin empaquetar nada. */
async function buildPasa(vercelEnv, valor) {
  const { resolveConfig } = await import('vite')
  // `envDir` vacío: el resultado no depende de los `.env*` de la máquina.
  const envDir = mkdtempSync(join(tmpdir(), 'support-contact-'))
  const previo = { VERCEL_ENV: process.env.VERCEL_ENV, [VARIABLE]: process.env[VARIABLE] }
  const poner = (nombre, v) => { if (v === undefined) delete process.env[nombre]; else process.env[nombre] = v }
  poner('VERCEL_ENV', vercelEnv)
  poner(VARIABLE, valor)
  try {
    await resolveConfig({ root: RAIZ, configFile: join(RAIZ, 'vite.config.ts'), envDir, logLevel: 'silent' }, 'build', 'production')
    return { pasa: true }
  } catch (err) {
    const mensaje = err instanceof Error ? err.message : String(err)
    // Sólo cuenta como rechazo del guard si el mensaje es el del guard: un
    // config que no carga por otro motivo no puede hacerse pasar por un caso.
    return { pasa: false, delGuard: mensaje.includes('GUARD support-contact'), mensaje }
  } finally {
    poner('VERCEL_ENV', previo.VERCEL_ENV)
    poner(VARIABLE, previo[VARIABLE])
    rmSync(envDir, { recursive: true, force: true })
  }
}

async function selfTest() {
  let malos = 0
  const linea = (ok, texto) => { if (!ok) malos++; console.log(`  ${ok ? 'OK  ' : 'MAL '} ${texto}`) }

  console.log('regla — validarWhatsAppSoporte')
  for (const [etiqueta, valor, esperado] of CASOS_REGLA) {
    const r = validarWhatsAppSoporte(valor)
    const ok = esperado === null ? !r.ok && r.motivo.length > 0 : r.ok && r.numero === esperado
    linea(ok, `${etiqueta} (esperado ${esperado === null ? 'RECHAZA' : 'ACEPTA'}, dio ${r.ok ? 'ACEPTA' : 'RECHAZA'})`)
  }

  console.log('política — evaluarSoporteDeBuild')
  for (const [etiqueta, valor, productivo, esperado] of CASOS_POLITICA) {
    const d = evaluarSoporteDeBuild({ valor, productivo })
    linea(d.nivel === esperado, `${etiqueta} (esperado ${esperado}, dio ${d.nivel})`)
  }
  linea(esDeployProductivo({ VERCEL_ENV: 'production' }) && !esDeployProductivo({ VERCEL_ENV: 'preview' }) && !esDeployProductivo({}),
    'sólo VERCEL_ENV=production es un deploy productivo')
  const diagnostico = evaluarSoporteDeBuild({ valor: '5943574404419', productivo: true }).mensaje
  linea(/594/.test(diagnostico) && !diagnostico.includes('5943574404419'), 'el diagnóstico nombra la transposición sin volcar el número entero')

  console.log('build — vite.config.ts real (resolveConfig)')
  for (const [etiqueta, vercelEnv, valor, debePasar] of CASOS_BUILD) {
    const r = await buildPasa(vercelEnv, valor)
    const ok = debePasar ? r.pasa : !r.pasa && r.delGuard
    linea(ok, `${etiqueta} (esperado ${debePasar ? 'PASA' : 'FALLA'}, dio ${r.pasa ? 'PASA' : r.delGuard ? 'FALLA' : `ERROR AJENO: ${r.mensaje.split('\n')[0]}`})`)
  }

  if (malos) {
    console.error(`\nSELF-TEST FALLIDO: ${malos} caso(s).`)
    process.exit(1)
  }
  console.log('\nself-test OK: el build rechaza 594, la falta del 9, valores truncados, vacíos y basura; y exige el canal en producción.')
}

// ── CLI ──────────────────────────────────────────────────────────────────────
if (process.argv.includes('--self-test')) {
  await selfTest()
} else {
  const productivo = process.argv.includes('--production') || esDeployProductivo(process.env)
  const decision = evaluarSoporteDeBuild({ valor: process.env[VARIABLE], productivo })
  if (decision.nivel === 'error') {
    console.error(`GUARD support-contact: ${decision.mensaje}\nFormato esperado: 549XXXXXXXXXX (13 dígitos: 54 + 9 + número nacional de 10).`)
    process.exit(1)
  }
  console.log(`GUARD support-contact: ${decision.nivel === 'ok' ? 'OK' : 'AVISO'} — ${decision.mensaje}`)
}
