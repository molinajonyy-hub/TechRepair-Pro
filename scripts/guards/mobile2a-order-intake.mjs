#!/usr/bin/env node
import { readFileSync } from 'node:fs'

const files = [
  'src/pages/NewOrder.tsx',
  'src/pages/OrderDetail.tsx',
  'src/components/order/DeviceLockCard.tsx',
  'src/features/order-intake/service.ts',
]
const source = files.map(file=>`/* ${file} */\n${readFileSync(file,'utf8')}`).join('\n')
const forbidden = [
  [/\.from\(['"]financial_movements['"]\)\.(?:insert|update|delete)/, 'write financiero directo'],
  [/\.from\(['"]account_movements['"]\)\.(?:insert|update|delete)/, 'write de cuenta corriente'],
  [/\.from\(['"]orders['"]\)\.update\(\{\s*device_password/, 'write plaintext de device_password'],
  [/initialValue=\{[^}]*device_password/, 'lectura plaintext de device_password'],
  [/localStorage\.(?:setItem|getItem)[^\n]*(?:accessSecret|password|pattern|pin)/i, 'persistencia local de secreto'],
  [/(?:console\.(?:log|info|warn|error|debug)|analytics\.(?:track|identify|capture)|whatsapp|wa\.me|window\.print|print\(|pdf)[^\n]{0,180}(?:accessSecret|access_secret|device_password|\bpin\b|pattern|patr[oó]n)/i, 'salida sensible a log/analytics/WhatsApp/print/PDF'],
  [/(?:accessSecret|access_secret|device_password|\bpin\b|pattern|patr[oó]n)[^\n]{0,180}(?:console\.(?:log|info|warn|error|debug)|analytics\.(?:track|identify|capture)|whatsapp|wa\.me|window\.print|print\(|pdf)/i, 'secreto sensible enviado a log/analytics/WhatsApp/print/PDF'],
]

function inspect(text) { return forbidden.filter(([pattern])=>pattern.test(text)).map(([,label])=>label) }
if (process.argv.includes('--self-test')) {
  const positive = [
    "supabase.from('orders').update({ device_password: pin })",
    "console.log('accessSecret', accessSecret)",
    "analytics.track('intake', { pin })",
    "window.open('https://wa.me/1?text=' + pattern)",
    "pdf.text(access_secret)",
  ].flatMap(inspect)
  if(!positive.includes('write plaintext de device_password'))throw new Error('self-test no detectó plaintext')
  if(!positive.some(label=>label.includes('log/analytics/WhatsApp/print/PDF')))throw new Error('self-test no detectó canal de salida sensible')
  const negative=inspect("console.info('MOBILE-2A intake created', { orderId }); pdf.text('Orden creada')")
  if(negative.length)throw new Error(`self-test falso positivo: ${negative.join(', ')}`)
  console.log('mobile2a guard self-test OK');process.exit(0)
}
const failures=inspect(source)
if(failures.length){console.error(`MOBILE-2A guard FAIL: ${failures.join(', ')}`);process.exit(1)}
if(!source.includes("rpc('create_order_intake")||!source.includes('p_access_secret: accessSecretForRpc')){
  console.error('MOBILE-2A guard FAIL: falta RPC canónico con secreto separado');process.exit(1)
}
console.log('MOBILE-2A guard OK: RPC canónico, sin plaintext/persistencia ni writes financieros.')
