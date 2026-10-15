// BETA-UX-2 — tabla Markdown «antes → después» de las medidas de capture.mjs.
// Uso: node measures-table.mjs <measures-before.json>[,<extra.json>] <measures-after.json>[,<extra.json>]
import fs from 'node:fs'

const leer = lista => Object.assign({}, ...lista.split(',').map(f => JSON.parse(fs.readFileSync(f, 'utf8'))))
const [antes, despues] = process.argv.slice(2).map(leer)
const tile = m => m?.tile ? `${m.tile.w}px${m.tile.bg === 'gradient' ? ' grad.' : ''}` : '—'
const sub = m => m?.subtitle ? `${m.subtitle.size} ${m.subtitle.color.replace(/rgb\((\d+), (\d+), (\d+)\)/, (_, r, g, b) => '#' + [r, g, b].map(n => Number(n).toString(16).padStart(2, '0')).join(''))}` : '—'

const pantallas = Object.keys(despues).filter(k => /-(desktop|mobile)$/.test(k) && !k.startsWith('wizard') && antes[k])
const out = ['| Pantalla | Barra → encabezado | Margen izq. | Ícono | Glifo | Subtítulo | Encabezado → contenido |', '|---|---|---|---|---|---|---|']
for (const k of pantallas) {
  const a = antes[k], d = despues[k]
  const cambio = (x, y) => x === y ? `${y}` : `${x} → **${y}**`
  out.push(`| ${k} | ${cambio(a.barToHeader, d.barToHeader)} | ${cambio(a.header?.left, d.header?.left)} | ${cambio(tile(a), tile(d))} | ${cambio(a.glyph, d.glyph)} | ${cambio(sub(a), sub(d))} | ${cambio(a.gaps?.[0], d.gaps?.[0])} |`)
}
out.push('', `Recepción (390 px): ${antes['wizard-mobile']?.steps.length} pasos → **${despues['wizard-mobile']?.steps.length}**; secreto del patrón 1-5-9: \`${antes['wizard-mobile']?.rpc?.[0]?.p_access_secret}\` (${antes['wizard-mobile']?.alert ?? 'sin alerta'}) → **\`${despues['wizard-mobile']?.rpc?.[0]?.p_access_secret}\`** (${despues['wizard-mobile']?.alert ?? 'orden creada'}).`)
console.log(out.join('\n'))
