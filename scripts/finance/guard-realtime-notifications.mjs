#!/usr/bin/env node
// ============================================================================
// P0 final pre-M8 — Guard del lote Realtime / notifications / 406.
//
// ACOTADO a este lote. NO duplica reglas de otros guards; cuando una regla ya
// vive en otro archivo se delega explicitamente (una sola regla por guard):
//   · RPC SECDEF publica fuera de la allowlist -> guard-secdef-exposure.mjs R1.
//   · Lockdown de `businesses` (policies/grants/realtime) -> guard-businesses-public-read.mjs.
//   · Higiene del cuerpo de una SECDEF (search_path, pg_temp) -> guard-security-definer.mjs.
//
// Falla (exit 1) cuando:
//   R1. un hook usa un topic ESTATICO de canal (`supabase.channel('x:'+id)`)
//       fuera de src/lib/realtimeChannel.ts. Es la causa raiz del P0: N
//       consumidores del mismo topic -> el 2do en adelante recibe el canal ya
//       suscripto y su `.on()` explota.
//   R2. se encadena `.on(...)` DESPUES de `.subscribe()` sobre el mismo canal.
//   R3. se crea un canal y no se retira: `supabase.channel(...)` sin
//       `removeChannel` en el mismo archivo.
//   R4. una migracion agrega a supabase_realtime una tabla que NO sea
//       `notifications` (businesses/payments y cualquier otra "por las dudas").
//   R5. un INSERT sobre `notifications` omite `business_id`.
//   R6. un INSERT/UPDATE sobre `notifications` ignora el `{ error }` que
//       devuelve supabase-js (que NO lanza excepcion: por eso el bug paso
//       inadvertido desde siempre).
//   R7. se reemplazan INDISCRIMINADAMENTE los `.single()` del repo: si la
//       cantidad cae por debajo del piso, hubo un barrido global en vez de
//       arreglar las firmas donde la ausencia es legitima.
//   R8. una migracion le da a `notifications` una policy o un GRANT alcanzable
//       por anon o por PUBLIC.
//   R9. se pone `REPLICA IDENTITY FULL` sobre notifications sin justificarlo.
//  R10. el codigo vuelve a escribir columnas que no existen en notifications
//       (`read_at`, `customer_id`) -> 400 PGRST204 y se pierde la escritura.
//
//   node scripts/finance/guard-realtime-notifications.mjs [archivo|dir ...]
//   node scripts/finance/guard-realtime-notifications.mjs --self-test
// ============================================================================
import { readFileSync, readdirSync, writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, basename, extname } from 'node:path'

// Las reglas SQL miran hacia ADELANTE: el baseline 20260628190324 contiene el
// GRANT ALL a anon y la policy sin TO, y reescribir el baseline no es opcion.
// Es exactamente lo que limpia 20260805120000.
const CUTOFF = '20260805120000'

// El unico modulo autorizado a tocar el cliente de Realtime.
const MODULO_CANAL = 'realtimeChannel.ts'

// Columnas que NO existen en public.notifications y cuya escritura tumba el
// statement entero con PGRST204.
const COLUMNAS_INEXISTENTES = ['read_at', 'customer_id']

// Piso de `.single()`. Medido sobre bca8e31 (105 crudos, 103 fuera de
// comentarios). Un barrido global lo desploma; arreglar una firma puntual no.
const PISO_SINGLE = 95

const DIRS_SQL_POR_DEFECTO = ['supabase/migrations']
const DIRS_TS_POR_DEFECTO  = ['src']

/** Reemplaza comentarios por espacios conservando offsets. Sirve para SQL y TS. */
function despojar(s) {
  let out = '', i = 0
  while (i < s.length) {
    if (s.slice(i, i + 2) === '--' || s.slice(i, i + 2) === '//') {
      const f = s.indexOf('\n', i); const e = f === -1 ? s.length : f
      out += ' '.repeat(e - i); i = e; continue
    }
    if (s.slice(i, i + 2) === '/*') {
      const f = s.indexOf('*/', i + 2); const e = f === -1 ? s.length : f + 2
      out += ' '.repeat(e - i); i = e; continue
    }
    out += s[i]; i++
  }
  return out
}

const esNotifications = (t) => /"?public"?\s*\.\s*"?notifications"?|(?<![\w."])"?notifications"?(?![\w."])/i.test(t)

// ── R1/R2/R3 · el lado del cliente ──────────────────────────────────────────
function reglasFrontend(archivo, crudo) {
  const out = []
  const nombre = basename(archivo)
  const limpio = despojar(crudo)

  // El modulo del lifecycle es justamente el que TIENE que llamar a
  // supabase.channel(): se lo exime de R1/R3, no de R2.
  const esElModulo = nombre === MODULO_CANAL

  // R1 — topic estatico fuera del modulo. Un topic con interpolacion tambien es
  // estatico si no lleva un discriminante por instancia: `x:${id}` colisiona
  // entre los N consumidores del mismo id, que es exactamente el P0.
  if (!esElModulo) {
    for (const m of limpio.matchAll(/supabase\s*\.\s*channel\s*\(([^)]*)\)/g)) {
      out.push(`R1 ${nombre}: usa supabase.channel(${m[1].trim().slice(0, 40)}) directo — usar subscribeShared de lib/realtimeChannel`)
    }
  }

  // R2 — `.on()` DESPUES de `.subscribe()`. Es el error literal:
  // "cannot add postgres_changes callbacks ... after subscribe()".
  // Dos formas, y las dos rompen igual:
  //   (a) encadenada:  ch.subscribe().on(...)
  //   (b) por variable: const c = ch.subscribe(); ... c.on(...)
  for (const m of limpio.matchAll(/\.subscribe\s*\([^)]*\)\s*(?:\r?\n\s*)*\.on\s*\(/g)) {
    out.push(`R2 ${nombre}: .on() encadenado DESPUES de .subscribe() (posicion ${m.index})`)
  }
  for (const m of limpio.matchAll(/(?:const|let|var)\s+(\w+)\s*=[\s\S]{0,300}?\.subscribe\s*\(/g)) {
    const variable = m[1]
    const resto = limpio.slice(m.index + m[0].length)
    if (new RegExp(`\\b${variable}\\s*\\.\\s*on\\s*\\(`).test(resto)) {
      out.push(`R2 ${nombre}: \`${variable}.on(...)\` ocurre DESPUES de su .subscribe()`)
    }
  }

  // R3 — canal creado y nunca retirado.
  if (!esElModulo && /supabase\s*\.\s*channel\s*\(/.test(limpio) && !/removeChannel/.test(limpio)) {
    out.push(`R3 ${nombre}: crea un canal y no llama nunca a removeChannel`)
  }

  // R5/R6/R10 — escrituras sobre notifications.
  for (const m of limpio.matchAll(/\.from\(\s*['"`]notifications['"`]\s*\)([\s\S]{0,700})/g)) {
    const cola = m[1]
    const insert = cola.match(/\.insert\s*\(\s*\{([\s\S]{0,600}?)\}\s*\)/)
    if (insert) {
      if (!/\bbusiness_id\s*:/.test(insert[1])) {
        out.push(`R5 ${nombre}: INSERT en notifications sin business_id (es NOT NULL y lo exige la policy)`)
      }
      // R6 — el resultado tiene que mirarse. supabase-js no lanza: un
      // `await supabase.from(...).insert(...)` suelto pierde el error.
      const antes = limpio.slice(Math.max(0, m.index - 160), m.index)
      if (!/\{\s*(?:data\s*:|error\s*:|[\w]+\s*,\s*error)/.test(antes) && !/const\s*\{[^}]*error/.test(antes)) {
        out.push(`R6 ${nombre}: el resultado del INSERT en notifications no se desestructura — { error } se pierde`)
      }
    }
    const upd = cola.match(/\.update\s*\(\s*\{([\s\S]{0,400}?)\}\s*\)/)
    const cuerpos = [insert?.[1], upd?.[1]].filter(Boolean)
    for (const cuerpo of cuerpos) {
      for (const col of COLUMNAS_INEXISTENTES) {
        if (new RegExp(`\\b${col}\\s*:`).test(cuerpo)) {
          out.push(`R10 ${nombre}: escribe \`${col}\` en notifications — no es columna, da 400 PGRST204`)
        }
      }
    }
  }

  return out
}

// ── R4/R8/R9 · el lado de la base ───────────────────────────────────────────
function reglasSql(limpio) {
  const out = []

  // R4 — solo `notifications` puede entrar a la publicacion en este lote.
  for (const m of limpio.matchAll(/ALTER\s+PUBLICATION\s+"?supabase_realtime"?\s+ADD\s+TABLE\s+([^;]+)/gi)) {
    const tablas = m[1].split(',').map(t => t.trim().replace(/"/g, '').replace(/^public\./i, ''))
    for (const t of tablas) {
      if (t.toLowerCase() !== 'notifications') {
        out.push(`R4: agrega \`${t}\` a supabase_realtime — este lote solo autoriza notifications`)
      }
    }
  }

  // R8 — policy sobre notifications alcanzable por PUBLIC (sin TO) o por anon.
  for (const m of limpio.matchAll(/CREATE\s+POLICY\s+("?[\w]+"?)\s+ON\s+("?[\w]+"?\."?[\w]+"?|"?[\w]+"?)([\s\S]*?)(?=;)/gi)) {
    if (!esNotifications(m[2])) continue
    const cuerpo = m[3]
    if (/\bAS\s+RESTRICTIVE\b/i.test(cuerpo)) continue   // una RESTRICTIVE no concede
    const to = cuerpo.match(/\bTO\s+([\w",\s]+?)(?=\bUSING\b|\bWITH\b|$)/i)
    if (!to) {
      out.push(`R8: policy ${m[1]} sobre notifications SIN clausula TO (aplica a PUBLIC, anon incluido)`)
    } else if (/\b(anon|public)\b/i.test(to[1])) {
      out.push(`R8: policy ${m[1]} sobre notifications TO ${to[1].trim()}`)
    }
  }

  // R8 — GRANT sobre notifications a anon o PUBLIC.
  for (const m of limpio.matchAll(/GRANT\s+([\w\s,()]+?)\s+ON\s+(?:TABLE\s+)?("?[\w]+"?\."?[\w]+"?|"?[\w]+"?)\s+TO\s+("?[\w]+"?)/gi)) {
    if (!esNotifications(m[2])) continue
    const rol = m[3].replace(/"/g, '').toLowerCase()
    if (rol === 'anon' || rol === 'public') {
      out.push(`R8: GRANT ${m[1].trim()} sobre notifications a ${rol}`)
    }
  }

  // R9 — REPLICA IDENTITY FULL sin justificacion escrita.
  for (const m of limpio.matchAll(/ALTER\s+TABLE\s+([^\s;]+)\s+REPLICA\s+IDENTITY\s+FULL/gi)) {
    if (esNotifications(m[1])) {
      out.push('R9: REPLICA IDENTITY FULL sobre notifications — el unico binding es INSERT, FULL solo agrega la tupla OLD y duplica el WAL')
    }
  }

  return out
}

// ── R7 · barrido global de `.single()` ──────────────────────────────────────
function reglaSingle(dirs) {
  const out = []
  let total = 0
  for (const d of dirs) {
    for (const f of listar(d, ['.ts', '.tsx'])) {
      total += [...despojar(readFileSync(f, 'utf8')).matchAll(/\.single\(\s*\)/g)].length
    }
  }
  if (total < PISO_SINGLE) {
    out.push(`R7: quedan ${total} \`.single()\` (piso ${PISO_SINGLE}) — parece un reemplazo global. ` +
             'Solo se cambian las firmas donde la ausencia de fila es un estado LEGITIMO.')
  }
  return out
}

function listar(dir, exts) {
  const out = []
  let entradas
  try { entradas = readdirSync(dir, { withFileTypes: true }) } catch { return out }
  for (const e of entradas) {
    const p = join(dir, e.name)
    if (e.isDirectory()) out.push(...listar(p, exts))
    else if (exts.includes(extname(e.name))) out.push(p)
  }
  return out
}

function revisarSql(archivo) {
  const ts = basename(archivo).split('_')[0]
  if (/^\d{14}$/.test(ts) && ts < CUTOFF) return []   // deuda historica: es lo que se limpia
  return reglasSql(despojar(readFileSync(archivo, 'utf8')))
}

function revisarTs(archivo) {
  return reglasFrontend(archivo, readFileSync(archivo, 'utf8'))
}

// ── self-test ───────────────────────────────────────────────────────────────
const FIXTURES_SQL = [
  { nombre: 'la migracion real de este lote', debeFallar: false, sql:
`ALTER PUBLICATION supabase_realtime ADD TABLE public.notifications;
DROP POLICY IF EXISTS "notifications_select" ON public.notifications;
CREATE POLICY "notifications_select" ON public.notifications
  FOR SELECT TO authenticated USING (business_id = public.current_user_business_id());
REVOKE ALL ON TABLE public.notifications FROM anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.notifications TO authenticated;` },

  { nombre: 'R4 publica businesses', debeFallar: true, sql:
`ALTER PUBLICATION supabase_realtime ADD TABLE public.businesses;` },

  { nombre: 'R4 publica payments', debeFallar: true, sql:
`ALTER PUBLICATION supabase_realtime ADD TABLE public.payments;` },

  { nombre: 'R4 publica varias de una', debeFallar: true, sql:
`ALTER PUBLICATION supabase_realtime ADD TABLE public.notifications, public.payments;` },

  { nombre: 'R8 policy sin clausula TO', debeFallar: true, sql:
`CREATE POLICY "n_sel" ON public.notifications FOR SELECT USING (business_id = current_user_business_id());` },

  { nombre: 'R8 policy TO anon', debeFallar: true, sql:
`CREATE POLICY "n_sel" ON public.notifications FOR SELECT TO anon USING (true);` },

  { nombre: 'R8 policy RESTRICTIVE a PUBLIC no concede', debeFallar: false, sql:
`CREATE POLICY "n_r" ON public.notifications AS RESTRICTIVE FOR SELECT USING (true);` },

  { nombre: 'R8 GRANT a anon', debeFallar: true, sql:
`GRANT SELECT ON TABLE public.notifications TO anon;` },

  { nombre: 'R8 GRANT a PUBLIC', debeFallar: true, sql:
`GRANT SELECT ON TABLE public.notifications TO PUBLIC;` },

  { nombre: 'R8 GRANT a authenticated es legitimo', debeFallar: false, sql:
`GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.notifications TO authenticated;` },

  { nombre: 'R8 GRANT a anon sobre OTRA tabla no es asunto de este guard', debeFallar: false, sql:
`GRANT SELECT ON TABLE public.wholesale_customers TO anon;` },

  { nombre: 'R9 REPLICA IDENTITY FULL', debeFallar: true, sql:
`ALTER TABLE public.notifications REPLICA IDENTITY FULL;` },

  { nombre: 'R9 no aplica a otra tabla', debeFallar: false, sql:
`ALTER TABLE public.otra_cosa REPLICA IDENTITY FULL;` },
]

const FIXTURES_TS = [
  { nombre: 'consumidor correcto (subscribeShared)', archivo: 'useX.ts', debeFallar: false, src:
`const baja = subscribeShared({ key: \`subscription:\${businessId}\`, bindings: [
  { event: 'UPDATE', table: 'businesses', filter: \`id=eq.\${businessId}\` },
] }, { onEvent: () => load() })
return () => baja()` },

  { nombre: 'R1 topic estatico (el patron del P0)', archivo: 'useSubscription.ts', debeFallar: true, src:
`const channel = supabase.channel(\`subscription:\${businessId}\`)
  .on('postgres_changes', { event: 'UPDATE', table: 'businesses' }, () => load())
  .subscribe()
return () => supabase.removeChannel(channel)` },

  { nombre: 'R1 topic con Date.now() sigue siendo directo', archivo: 'useNotifications.ts', debeFallar: true, src:
`const ch = supabase.channel(\`notifications:\${businessId}:\${Date.now()}\`)
  .on('postgres_changes', { event: 'INSERT', table: 'notifications' }, () => {})
  .subscribe()
supabase.removeChannel(ch)` },

  { nombre: 'R2 .on() despues de .subscribe()', archivo: 'malo.ts', debeFallar: true, src:
`const c = cliente.channel('t').subscribe()
c.on('postgres_changes', { event: 'INSERT', table: 'x' }, () => {})
removeChannel(c)` },

  { nombre: 'R3 canal sin removeChannel', archivo: 'fuga.ts', debeFallar: true, src:
`const c = supabase.channel('t:1').on('postgres_changes', {}, () => {}).subscribe()` },

  { nombre: 'R5 insert sin business_id', archivo: 'StatusChange.tsx', debeFallar: true, src:
`const { error } = await supabase.from('notifications').insert({
  type: 'status_change', title: 'T', message: 'M', is_read: false,
})` },

  { nombre: 'R6 insert que ignora el error', archivo: 'StatusChange.tsx', debeFallar: true, src:
`await supabase.from('notifications').insert({
  business_id: businessId, type: 'status_change', title: 'T', message: 'M',
})` },

  { nombre: 'insert correcto', archivo: 'StatusChange.tsx', debeFallar: false, src:
`const { error: notifError } = await supabase.from('notifications').insert({
  business_id: businessId, type: 'status_change', title: 'T', message: 'M',
  order_id: orderId, is_read: false, metadata: { to_status: s },
})
if (notifError) logger.warn('SUPABASE', 'no se pudo crear', notifError.message)` },

  { nombre: 'R10 escribe read_at', archivo: 'useNotifications.ts', debeFallar: true, src:
`const { error } = await supabase.from('notifications')
  .update({ is_read: true, read_at: new Date().toISOString() }).eq('id', id)` },

  { nombre: 'R10 escribe customer_id', archivo: 'StatusChange.tsx', debeFallar: true, src:
`const { error } = await supabase.from('notifications').insert({
  business_id: businessId, type: 't', title: 'T', message: 'M', customer_id: c,
})` },

  { nombre: 'update correcto (solo is_read)', archivo: 'useNotifications.ts', debeFallar: false, src:
`const { error } = await supabase.from('notifications').update({ is_read: true }).eq('id', id)` },

  { nombre: 'un comentario que MENCIONA read_at no es una escritura', archivo: 'useNotifications.ts', debeFallar: false, src:
`// Solo is_read: read_at no es una columna de la tabla.
const { error } = await supabase.from('notifications').update({ is_read: true }).eq('id', id)` },
]

function autoTest() {
  let fallas = 0
  const dir = mkdtempSync(join(tmpdir(), 'rtnotif-'))

  for (const f of FIXTURES_SQL) {
    const p = join(dir, `${CUTOFF}_fx.sql`)
    writeFileSync(p, f.sql)
    const h = revisarSql(p)
    const fallo = h.length > 0
    const ok = fallo === f.debeFallar
    if (!ok) fallas++
    console.log(`${ok ? 'OK  ' : 'FALLA'} sql "${f.nombre}": esperaba ${f.debeFallar ? 'FALLA' : 'OK'}, obtuvo ${fallo ? 'FALLA' : 'OK'}${fallo ? ` (${h[0]})` : ''}`)
  }

  for (const f of FIXTURES_TS) {
    const p = join(dir, f.archivo)
    writeFileSync(p, f.src)
    const h = revisarTs(p)
    const fallo = h.length > 0
    const ok = fallo === f.debeFallar
    if (!ok) fallas++
    console.log(`${ok ? 'OK  ' : 'FALLA'} ts  "${f.nombre}": esperaba ${f.debeFallar ? 'FALLA' : 'OK'}, obtuvo ${fallo ? 'FALLA' : 'OK'}${fallo ? ` (${h[0]})` : ''}`)
  }

  // R7 se prueba aparte: es un conteo agregado, no por archivo.
  const dirVacio = mkdtempSync(join(tmpdir(), 'rtnotif-barrido-'))
  writeFileSync(join(dirVacio, 'todo.ts'), 'const a = 1')
  const hR7 = reglaSingle([dirVacio])
  const okR7 = hR7.length > 0
  if (!okR7) fallas++
  console.log(`${okR7 ? 'OK  ' : 'FALLA'} r7  "un barrido que deja 0 .single() se detecta": esperaba FALLA, obtuvo ${okR7 ? 'FALLA' : 'OK'}`)

  const hR7ok = reglaSingle(DIRS_TS_POR_DEFECTO)
  const okR7ok = hR7ok.length === 0
  if (!okR7ok) fallas++
  console.log(`${okR7ok ? 'OK  ' : 'FALLA'} r7  "el repo actual esta por encima del piso": ${okR7ok ? 'OK' : hR7ok[0]}`)

  console.log(fallas === 0 ? '\nself-test OK' : `\nself-test con ${fallas} fallas`)
  process.exit(fallas === 0 ? 0 : 1)
}

// ── main ────────────────────────────────────────────────────────────────────
if (process.argv.includes('--self-test')) autoTest()

const args = process.argv.slice(2).filter(a => !a.startsWith('--'))
const objetivosSql = args.length ? args : DIRS_SQL_POR_DEFECTO
const objetivosTs  = args.length ? args : DIRS_TS_POR_DEFECTO

const hallazgos = []
for (const o of objetivosSql) {
  const archivos = extname(o) === '.sql' ? [o] : listar(o, ['.sql'])
  for (const a of archivos) hallazgos.push(...revisarSql(a))
}
for (const o of objetivosTs) {
  const archivos = ['.ts', '.tsx'].includes(extname(o)) ? [o] : listar(o, ['.ts', '.tsx'])
  for (const a of archivos) hallazgos.push(...revisarTs(a))
}
if (!args.length) hallazgos.push(...reglaSingle(DIRS_TS_POR_DEFECTO))

if (hallazgos.length) {
  console.error('guard-realtime-notifications: HALLAZGOS\n')
  for (const h of hallazgos) console.error(`  · ${h}`)
  process.exit(1)
}
console.log('guard-realtime-notifications OK — lifecycle, publicacion, RLS y contrato de columnas intactos.')
