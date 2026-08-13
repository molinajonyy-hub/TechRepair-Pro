// ============================================================================
// RECONCILIACIÓN FISCAL — runner de DevTools.
//
// CÓMO SE USA
//   1. Iniciá sesión en https://www.techrepairpro.app con tu usuario owner/admin.
//   2. Abrí DevTools (F12) → Console.
//   3. Pegá TODO este archivo y Enter.
//   4. Al terminar descarga `reconciliacion-arca.json`. Pasámelo.
//
// QUÉ HACE
//   Reutiliza la sesión que YA tenés abierta: el JWT sale del storage de
//   Supabase y se usa sólo como header. No pide contraseña, no usa
//   service_role, no imprime el token.
//
//   Es AUTOSUFICIENTE: los candidatos van embebidos abajo, así que sólo
//   necesita el JWT para hablar con la Edge Function. No consulta PostgREST
//   (que además exigiría la anon key) ni depende de nada de la página.
//
// QUÉ NO HACE
//   No escribe en la base. No emite. No pide CAE. No crea notas de crédito.
//   La Edge Function que invoca (afip-fe-query) sólo sabe hacer
//   FECompConsultar y FECompUltimoAutorizado.
// ============================================================================
(async () => {
  const THROTTLE_MS = 350
  const TIPO_FACTURA_C = 11              // mapping canónico del sistema
  const sleep = (ms) => new Promise(r => setTimeout(r, ms))

  // ── Familia CAE-15: los 53 candidatos ─────────────────────────────────────
  // MINIMO IMPRESCINDIBLE, a proposito: identificador interno sanitizado
  // (prefijo de UUID, 8 chars) + numero DECLARADO, que ya lleva adentro el
  // punto de venta. El tipo es constante (Factura C = 11).
  //
  // NO van importes, fechas, estados, nombres, documentos, telefonos ni mails:
  // para preguntarle a ARCA si un numero existe alcanza con el numero, y todo
  // lo demas es dato productivo viajando sin necesidad. La correlacion con
  // fecha/importe/estado se hace despues, del lado del analisis, contra la
  // base — por el identificador.
  const CANDIDATOS = [
    ['9488be82','0001-00758894'], ['3719f704','0001-00597022'],
    ['3e22e6d3','0001-00371622'], ['683bf3a9','0001-00219063'],
    ['8f5520b9','0001-00265375'], ['aa9d3513','0001-00695484'],
    ['def266d0','0001-00637388'], ['42900f13','0001-00220537'],
    ['9827b2a2','0001-00216580'], ['31df8719','0001-00937040'],
    ['90d73b2c','0001-00420529'], ['22381a16','0001-00191743'],
    ['335a127c','0001-00255604'], ['c3b6b4f7','0001-00886065'],
    ['056f876d','0001-00474886'], ['c19f04a0','0001-00252030'],
    ['d77d62ad','0001-00868419'], ['c820352d','0001-00817253'],
    ['01545f69','0001-00407067'], ['5e63db6a','0001-00852866'],
    ['0b19312a','0001-00113740'], ['9daaafa6','0001-00353263'],
    ['9ed5f382','0001-00652390'], ['ff0feed6','0001-00442733'],
    ['c819d5c3','0001-00807617'], ['9d5b4c7c','0001-00412354'],
    ['df7e6adf','0001-00353088'], ['95151a03','0001-00332705'],
    ['344d42b6','0001-00940909'], ['4a918380','0001-00691187'],
    ['8ba1161f','0001-00050637'], ['bc3ef032','0001-00637162'],
    ['2a9604e5','0001-00098643'], ['14c5470f','0001-00725807'],
    ['871d2001','0001-00714171'], ['e92d9f5f','0001-00927185'],
    ['fc8356b9','0001-00051679'], ['f69ed145','0001-00470585'],
    // ── FISC-01..15: los que NO tienen numero_fiscal ──
    ['1f2956ec','0001-00167260'], ['ff5204f4','0001-00036453'],
    ['641c8257','0001-00530061'], ['5b9089ad','0001-00206654'],
    ['d86713c9','0001-00082427'], ['7ee6ffd8','0001-00449776'],
    ['b69d7ac2','0001-00796325'], ['61fb8f8d','0001-00560522'],
    ['33ee3b08','0001-00468500'], ['cbc1b1b8','0001-00282498'],
    ['25025d77','0001-00039691'], ['dc99098c','0001-00988729'],
    ['9e05444d','0001-00345550'], ['1eedc52d','0001-00391953'],
    ['ff3dc175','0001-00672017'],
  ]

  // ── 1. Token de la sesión existente ───────────────────────────────────────
  let token = null, base = null
  for (const k of Object.keys(localStorage)) {
    if (!/^sb-.*-auth-token$/.test(k)) continue
    try {
      const v = JSON.parse(localStorage.getItem(k))
      if (v?.access_token) {
        token = v.access_token
        const ref = k.match(/^sb-(.+)-auth-token$/)?.[1]
        if (ref) base = `https://${ref}.supabase.co`
      }
    } catch { /* clave no parseable */ }
  }
  if (!token || !base) {
    console.error('No encontré una sesión activa. Iniciá sesión como owner/admin y reintentá.')
    return
  }
  console.log('✓ sesión detectada (el token no se muestra)')

  const arca = async (payload) => {
    const res = await fetch(`${base}/functions/v1/afip-fe-query`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    })
    return { http: res.status, ...(await res.json().catch(() => ({}))) }
  }

  const salida = { generado: new Date().toISOString(), ultimo_autorizado: {}, serie_pv10: [], candidatos: [], notas: [] }

  // ── 2. Último autorizado, PV1 y PV10 ──────────────────────────────────────
  for (const pv of [1, 10]) {
    const r = await arca({ operacion: 'ultimo_autorizado', tipo_comprobante: TIPO_FACTURA_C, punto_venta: pv })
    salida.ultimo_autorizado[`pv${pv}`] = { http: r.http, ultimo: r.ultimo_autorizado ?? null, error: r.error ?? null }
    console.log(`ultimo_autorizado PV${pv}:`, r.ultimo_autorizado ?? r.error ?? r.http)
    if (r.http === 403) { console.error('403 — tu rol no tiene autoridad fiscal (se requiere owner/admin).'); return }
    await sleep(THROTTLE_MS)
  }

  // ── 3. Serie real PV10 ────────────────────────────────────────────────────
  const u10 = Number(salida.ultimo_autorizado.pv10?.ultimo)
  if (Number.isInteger(u10) && u10 > 0 && u10 <= 500) {
    console.log(`consultando serie PV10 1..${u10} — puede tardar unos minutos`)
    for (let n = 1; n <= u10; n++) {
      const r = await arca({ operacion: 'consultar', tipo_comprobante: TIPO_FACTURA_C, punto_venta: 10, numero: n })
      salida.serie_pv10.push({ numero: n, ...(r.consulta || { error: r.error, http: r.http }) })
      if (n % 25 === 0) console.log(`  ...${n}/${u10}`)
      await sleep(THROTTLE_MS)
    }
  } else {
    salida.notas.push(`serie PV10 no consultada: ultimo_autorizado=${u10}`)
  }

  // ── 4. Los 53 candidatos ──────────────────────────────────────────────────
  const u1 = Number(salida.ultimo_autorizado.pv1?.ultimo)
  for (const [id, declarado] of CANDIDATOS) {
    const m = /^(\d{1,5})-(\d{1,12})$/.exec(declarado)
    const pv = parseInt(m[1], 10), nro = parseInt(m[2], 10)
    const fila = { id, declarado, pv, numero: nro }

    // Si el número supera el último autorizado oficial de esa serie, ARCA no
    // pudo haberlo autorizado: se resuelve SIN consultar.
    if (Number.isInteger(u1) && pv === 1 && nro > u1) {
      fila.consultado = false
      fila.veredicto_previo = `numero ${nro} > ultimo autorizado ${u1} en PV1`
      salida.candidatos.push(fila)
      continue
    }
    const r = await arca({ operacion: 'consultar', tipo_comprobante: TIPO_FACTURA_C, punto_venta: pv, numero: nro })
    fila.consultado = true
    fila.arca = r.consulta || { error: r.error, http: r.http }
    salida.candidatos.push(fila)
    await sleep(THROTTLE_MS)
  }

  // ── 5. Sanitizado y descarga ──────────────────────────────────────────────
  const masc = (v) => (typeof v === 'string' && v.length > 7) ? v.slice(0, 4) + '…' + v.slice(-3) : v
  for (const f of salida.serie_pv10) {
    if (f.cae) f.cae = masc(f.cae)
    if (f.doc_numero && String(f.doc_numero).length > 4) f.doc_numero = masc(String(f.doc_numero))
  }
  for (const c of salida.candidatos) {
    if (c.arca?.cae) c.arca.cae = masc(c.arca.cae)
    if (c.arca?.doc_numero && String(c.arca.doc_numero).length > 4) c.arca.doc_numero = masc(String(c.arca.doc_numero))
  }

  const a = document.createElement('a')
  a.href = URL.createObjectURL(new Blob([JSON.stringify(salida, null, 2)], { type: 'application/json' }))
  a.download = 'reconciliacion-arca.json'
  a.click()
  URL.revokeObjectURL(a.href)

  console.log('%c✓ listo — se descargó reconciliacion-arca.json', 'color:#22c55e;font-weight:bold')
  console.log('  Nada fue modificado: ni en la base, ni en ARCA.')
})()
