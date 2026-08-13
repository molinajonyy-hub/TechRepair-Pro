// ============================================================================
// RECONCILIACIÓN FISCAL — runner de DevTools.
//
// CÓMO SE USA
//   1. Iniciá sesión en https://www.techrepairpro.app con tu usuario owner/admin.
//   2. Abrí DevTools (F12) → pestaña Console.
//   3. Pegá TODO este archivo y Enter.
//   4. Cuando termine descarga `reconciliacion-arca.json`. Pasámelo.
//
// QUÉ HACE
//   Reutiliza la sesión que YA tenés abierta. No pide contraseña, no toca
//   service_role, no imprime el token: el JWT sale del storage de Supabase y se
//   usa sólo como header. Consulta ARCA de a una, con pausa, y arma un JSON.
//
// QUÉ NO HACE
//   No escribe en la base. No emite. No pide CAE. No crea notas de crédito.
//   La Edge Function que invoca (afip-fe-query) sólo sabe hacer
//   FECompConsultar y FECompUltimoAutorizado — es estructuralmente incapaz de
//   autorizar un comprobante.
// ============================================================================
(async () => {
  const THROTTLE_MS = 350
  const TIPO_FACTURA_C = 11          // mapping canónico del sistema
  const sleep = (ms) => new Promise(r => setTimeout(r, ms))

  // ── 1. Token de la sesión existente ───────────────────────────────────────
  // Se busca la clave que guarda supabase-js. NUNCA se imprime ni se guarda.
  let token = null, supabaseUrl = null
  for (const k of Object.keys(localStorage)) {
    if (!/^sb-.*-auth-token$/.test(k)) continue
    try {
      const v = JSON.parse(localStorage.getItem(k))
      if (v?.access_token) {
        token = v.access_token
        const ref = k.match(/^sb-(.+)-auth-token$/)?.[1]
        if (ref) supabaseUrl = `https://${ref}.supabase.co`
      }
    } catch { /* clave no parseable: se ignora */ }
  }
  if (!token) {
    console.error('No encontré una sesión activa. Iniciá sesión y volvé a intentar.')
    return
  }
  console.log('✓ sesión detectada (el token no se muestra)')

  const fn = `${supabaseUrl}/functions/v1/afip-fe-query`
  const rest = `${supabaseUrl}/rest/v1`

  const arca = async (payload) => {
    const res = await fetch(fn, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    return { http: res.status, ...(await res.json().catch(() => ({}))) }
  }

  // La anon key la necesita PostgREST además del JWT; se lee del cliente ya
  // cargado en la página, no se pide ni se escribe a mano.
  const anon = (window.__SUPABASE_ANON_KEY__)
    || document.querySelector('meta[name="supabase-anon-key"]')?.content
    || null

  const consultarDb = async (path) => {
    const headers = { Authorization: `Bearer ${token}` }
    if (anon) headers.apikey = anon
    const res = await fetch(`${rest}/${path}`, { headers })
    if (!res.ok) throw new Error(`REST ${res.status}`)
    return res.json()
  }

  const salida = {
    generado: new Date().toISOString(),
    ultimo_autorizado: {},
    serie_pv10: [],
    candidatos: [],
    notas: [],
  }

  // ── 2. Último autorizado en PV 1 y PV 10 ──────────────────────────────────
  for (const pv of [1, 10]) {
    const r = await arca({ operacion: 'ultimo_autorizado', tipo_comprobante: TIPO_FACTURA_C, punto_venta: pv })
    salida.ultimo_autorizado[`pv${pv}`] = { http: r.http, ultimo: r.ultimo_autorizado ?? null, error: r.error ?? null }
    console.log(`ultimo_autorizado PV${pv}:`, r.ultimo_autorizado ?? r.error ?? r.http)
    await sleep(THROTTLE_MS)
  }

  // ── 3. Serie real de PV 10 ────────────────────────────────────────────────
  const ultimo10 = Number(salida.ultimo_autorizado.pv10?.ultimo)
  if (Number.isInteger(ultimo10) && ultimo10 > 0 && ultimo10 <= 500) {
    console.log(`consultando serie PV10 1..${ultimo10} — puede tardar unos minutos`)
    for (let n = 1; n <= ultimo10; n++) {
      const r = await arca({ operacion: 'consultar', tipo_comprobante: TIPO_FACTURA_C, punto_venta: 10, numero: n })
      salida.serie_pv10.push({ numero: n, ...(r.consulta || { error: r.error, http: r.http }) })
      if (n % 25 === 0) console.log(`  ...${n}/${ultimo10}`)
      await sleep(THROTTLE_MS)
    }
  } else {
    salida.notas.push(`serie PV10 no consultada: ultimo_autorizado=${ultimo10}`)
  }

  // ── 4. Familia sospechosa (CAE de 15 dígitos) ─────────────────────────────
  let sospechosos = []
  try {
    sospechosos = await consultarDb(
      'comprobantes?select=id,fecha,numero,numero_fiscal,total,cae,estado_fiscal' +
      '&cae=not.is.null&order=created_at.asc')
  } catch (e) {
    salida.notas.push(`no se pudo leer comprobantes desde el navegador: ${e.message}`)
  }
  const familia = sospechosos.filter(c => String(c.cae).length === 15)
  console.log(`familia CAE-15: ${familia.length} filas`)

  for (const c of familia) {
    const declarado = c.numero_fiscal || c.numero || ''
    const m = /^(\d{1,5})-(\d{1,12})$/.exec(declarado)
    if (!m) { salida.candidatos.push({ id: c.id, declarado, omitido: 'sin forma PV-numero' }); continue }
    const pv = parseInt(m[1], 10), nro = parseInt(m[2], 10)

    // Si el número supera el último autorizado oficial de esa serie, ARCA no
    // pudo haberlo autorizado: se registra SIN consultar.
    const ultimoPv = Number(salida.ultimo_autorizado[`pv${pv}`]?.ultimo)
    if (Number.isInteger(ultimoPv) && nro > ultimoPv) {
      salida.candidatos.push({
        id: c.id, fecha: c.fecha, total: c.total, estado_fiscal: c.estado_fiscal,
        cae_local_masc: String(c.cae).slice(0, 4) + '…' + String(c.cae).slice(-3),
        declarado, pv, numero: nro, consultado: false,
        veredicto_previo: `numero ${nro} > ultimo autorizado ${ultimoPv} en PV${pv}`,
      })
      continue
    }

    const r = await arca({ operacion: 'consultar', tipo_comprobante: TIPO_FACTURA_C, punto_venta: pv, numero: nro })
    salida.candidatos.push({
      id: c.id, fecha: c.fecha, total: c.total, estado_fiscal: c.estado_fiscal,
      cae_local_masc: String(c.cae).slice(0, 4) + '…' + String(c.cae).slice(-3),
      declarado, pv, numero: nro, consultado: true,
      arca: r.consulta || { error: r.error, http: r.http },
    })
    await sleep(THROTTLE_MS)
  }

  // ── 5. Sanitizado y descarga ──────────────────────────────────────────────
  // El CAE oficial se enmascara para el reporte. No se incluye ningún token,
  // header ni sobre SOAP.
  const masc = (v) => (typeof v === 'string' && v.length > 7)
    ? v.slice(0, 4) + '…' + v.slice(-3) : v
  for (const fila of salida.serie_pv10) {
    if (fila.cae) fila.cae = masc(fila.cae)
    if (fila.doc_numero && String(fila.doc_numero).length > 4) fila.doc_numero = masc(String(fila.doc_numero))
  }
  for (const c of salida.candidatos) {
    if (c.arca?.cae) c.arca.cae = masc(c.arca.cae)
    if (c.arca?.doc_numero && String(c.arca.doc_numero).length > 4) c.arca.doc_numero = masc(String(c.arca.doc_numero))
  }

  const blob = new Blob([JSON.stringify(salida, null, 2)], { type: 'application/json' })
  const a = document.createElement('a')
  a.href = URL.createObjectURL(blob)
  a.download = 'reconciliacion-arca.json'
  a.click()
  URL.revokeObjectURL(a.href)

  console.log('%c✓ listo — se descargó reconciliacion-arca.json', 'color:#22c55e;font-weight:bold')
  console.log('  Nada fue modificado: ni en la base, ni en ARCA.')
})()
