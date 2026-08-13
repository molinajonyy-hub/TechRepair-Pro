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

  // ── Familia CAE-15: los 53 candidatos, con su número DECLARADO ────────────
  // id abreviado · fecha · total · numero declarado · estado_fiscal · tiene numero_fiscal
  const CANDIDATOS = [
    ['9488be82','2026-04-21',139690,'0001-00758894','emitido',true],
    ['3719f704','2026-04-21',7500,'0001-00597022','emitido',true],
    ['3e22e6d3','2026-04-22',15500,'0001-00371622','emitido',true],
    ['683bf3a9','2026-04-22',35000,'0001-00219063','emitido',true],
    ['8f5520b9','2026-04-22',18000,'0001-00265375','emitido',true],
    ['aa9d3513','2026-04-22',17500,'0001-00695484','emitido',true],
    ['def266d0','2026-04-24',292000,'0001-00637388','emitido',true],
    ['42900f13','2026-04-27',223570,'0001-00220537','emitido',true],
    ['9827b2a2','2026-04-28',93960,'0001-00216580','emitido',true],
    ['31df8719','2026-04-28',37000,'0001-00937040','emitido',true],
    ['90d73b2c','2026-04-30',32880,'0001-00420529','emitido',true],
    ['22381a16','2026-04-30',72000,'0001-00191743','emitido',true],
    ['335a127c','2026-05-04',95000,'0001-00255604','emitido',true],
    ['c3b6b4f7','2026-05-04',63000,'0001-00886065','emitido',true],
    ['056f876d','2026-05-04',21150,'0001-00474886','emitido',true],
    ['c19f04a0','2026-05-04',17000,'0001-00252030','emitido',true],
    ['d77d62ad','2026-05-05',85000,'0001-00868419','emitido',true],
    ['c820352d','2026-05-05',125000,'0001-00817253','emitido',true],
    ['01545f69','2026-05-06',12700,'0001-00407067','emitido',true],
    ['5e63db6a','2026-05-06',10000,'0001-00852866','emitido',true],
    ['0b19312a','2026-05-07',135700,'0001-00113740','emitido',true],
    ['9daaafa6','2026-05-07',17000,'0001-00353263','emitido',true],
    ['9ed5f382','2026-05-07',28000,'0001-00652390','emitido',true],
    ['ff0feed6','2026-05-08',48065,'0001-00442733','emitido',true],
    ['c819d5c3','2026-05-09',185000,'0001-00807617','emitido',true],
    ['9d5b4c7c','2026-05-09',15500,'0001-00412354','emitido',true],
    ['df7e6adf','2026-05-12',17700,'0001-00353088','emitido',true],
    ['95151a03','2026-05-12',85750,'0001-00332705','emitido',true],
    ['344d42b6','2026-05-12',25000,'0001-00940909','emitido',true],
    ['4a918380','2026-05-13',167700,'0001-00691187','emitido',true],
    ['8ba1161f','2026-05-13',64390,'0001-00050637','emitido',true],
    ['bc3ef032','2026-05-13',36660,'0001-00637162','emitido',true],
    ['2a9604e5','2026-05-14',38000,'0001-00098643','emitido',true],
    ['14c5470f','2026-05-14',34000,'0001-00725807','emitido',true],
    ['871d2001','2026-05-14',28000,'0001-00714171','emitido',true],
    ['e92d9f5f','2026-05-14',70750,'0001-00927185','emitido',true],
    ['fc8356b9','2026-05-16',54700,'0001-00051679','emitido',true],
    ['f69ed145','2026-05-21',237500,'0001-00470585','emitido',true],
    // ── FISC-01..15: los que NO tienen numero_fiscal ──
    ['1f2956ec','2026-05-21',30000,'0001-00167260','pendiente_emision',false],
    ['ff5204f4','2026-05-22',28000,'0001-00036453','pendiente_emision',false],
    ['641c8257','2026-06-08',15000,'0001-00530061','pendiente_emision',false],
    ['5b9089ad','2026-06-26',35000,'0001-00206654','error_emision',false],
    ['d86713c9','2026-06-27',64000,'0001-00082427','error_emision',false],
    ['7ee6ffd8','2026-06-27',23000,'0001-00449776','error_emision',false],
    ['b69d7ac2','2026-06-27',10700,'0001-00796325','error_emision',false],
    ['61fb8f8d','2026-06-29',110000,'0001-00560522','error_emision',false],
    ['33ee3b08','2026-06-29',100000,'0001-00468500','pendiente_emision',false],
    ['cbc1b1b8','2026-06-29',13800,'0001-00282498','error_emision',false],
    ['25025d77','2026-06-29',78000,'0001-00039691','error_emision',false],
    ['dc99098c','2026-06-30',38300,'0001-00988729','error_emision',false],
    ['9e05444d','2026-06-30',13700,'0001-00345550','error_emision',false],
    ['1eedc52d','2026-06-30',22500,'0001-00391953','pendiente_emision',false],
    ['ff3dc175','2026-06-30',244960.8,'0001-00672017','pendiente_emision',false],
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
  for (const [id, fecha, total, declarado, ef, tieneNf] of CANDIDATOS) {
    const m = /^(\d{1,5})-(\d{1,12})$/.exec(declarado)
    const pv = parseInt(m[1], 10), nro = parseInt(m[2], 10)
    const fila = { id, fecha, total, declarado, pv, numero: nro, estado_fiscal: ef, tiene_numero_fiscal: tieneNf }

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
