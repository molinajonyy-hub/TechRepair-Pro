#!/usr/bin/env node
import { readFileSync, readdirSync } from 'node:fs'

const files = [
  'src/pages/NewOrder.tsx',
  'src/pages/OrderDetail.tsx',
  'src/components/order/DeviceLockCard.tsx',
  'src/features/order-intake/service.ts',
]
const source = files.map(file=>`/* ${file} */\n${readFileSync(file,'utf8')}`).join('\n')
const migrationPath = 'supabase/migrations/20260903120000_mobile2a_order_intake.sql'
const migration = readFileSync(migrationPath,'utf8')
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

function between(text,start,end){
  const from=text.indexOf(start)
  const to=from<0?-1:text.indexOf(end,from+start.length)
  return from<0||to<0?'':text.slice(from,to)
}

function inspectExpand(text){
  const findings=[]
  const createBody=between(text,'CREATE OR REPLACE FUNCTION public.create_order_intake','CREATE OR REPLACE FUNCTION public.set_order_device_access_secret')
  const setBody=between(text,'CREATE OR REPLACE FUNCTION public.set_order_device_access_secret','CREATE OR REPLACE FUNCTION public.reveal_order_device_access')
  const deleteBody=between(text,'CREATE OR REPLACE FUNCTION public.delete_order_device_access_secret','-- ── Fotos privadas')
  const triggerBody=between(text,'CREATE OR REPLACE FUNCTION private.mobile2a_mirror_legacy_device_password','DROP TRIGGER IF EXISTS mobile2a_mirror_legacy_device_password')
  const auditTable=between(text,'CREATE TABLE IF NOT EXISTS private.order_device_access_audit','ALTER TABLE private.order_device_access_audit ENABLE ROW LEVEL SECURITY')

  if(!text.includes('CREATE TRIGGER mobile2a_mirror_legacy_device_password')||
     !triggerBody.includes("'legacy_secret_write_mirrored'")) findings.push('falta mirror legacy → Vault auditado')
  if(!createBody.includes('mobile2a_write_legacy_shadow')||
     !setBody.includes('mobile2a_write_legacy_shadow')||
     !deleteBody.includes('mobile2a_write_legacy_shadow')) findings.push('falta dual-write nuevo → legacy')
  if(/ADD\s+CONSTRAINT\s+orders_device_password_retired_check[\s\S]{0,160}CHECK\s*\(\s*device_password\s+IS\s+NULL\s*\)/i.test(text)) findings.push('CHECK contract presente en EXPAND')
  if(/\b(?:secret|secret_value|device_password|plaintext)\s+(?:text|jsonb|bytea)/i.test(auditTable)||
     /order_device_access_audit\s*\([^)]*(?:secret_value|device_password|plaintext)/i.test(text)) findings.push('audit podría persistir secreto')
  if(!triggerBody.includes("current_setting('app.mobile2a_secret_write_origin',true)='vault_to_legacy'")||
     !between(text,'CREATE OR REPLACE FUNCTION private.mobile2a_write_legacy_shadow','CREATE OR REPLACE FUNCTION private.mobile2a_mirror_legacy_device_password').includes("set_config('app.mobile2a_secret_write_origin','vault_to_legacy',true)")) findings.push('falta barrera de no-recursión')
  if(!triggerBody.includes('v_business IS DISTINCT FROM OLD.business_id')||
     !triggerBody.includes('NEW.business_id IS DISTINCT FROM OLD.business_id')||
     !triggerBody.includes('public.is_staff()')) findings.push('mirror legacy no replica autorización tenant/RLS')
  if(/device_password\s+IS\s+NOT\s+DISTINCT[\s\S]{0,100}RETURN\s+NEW/i.test(triggerBody)) findings.push('legacy same-value write sin audit')
  if(!setBody.includes("current_user_can('device_access_secret')")||
     !deleteBody.includes("current_user_can('device_access_secret')")) findings.push('RPC nueva sin capability explícita')
  return findings
}

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
  const expect=(mutated,label)=>{
    const hits=inspectExpand(mutated)
    if(!hits.some(hit=>hit.includes(label)))throw new Error(`self-test no detectó ${label}`)
  }
  expect(migration.replace('CREATE TRIGGER mobile2a_mirror_legacy_device_password','-- trigger removido'),'mirror legacy')
  expect(migration.replaceAll('PERFORM private.mobile2a_write_legacy_shadow','PERFORM private.mobile2a_shadow_removed'),'dual-write')
  expect(`${migration}\nALTER TABLE public.orders ADD CONSTRAINT orders_device_password_retired_check CHECK (device_password IS NULL);`,'CHECK contract')
  expect(migration.replace('actor_id uuid,','actor_id uuid,\n  secret_value text,'),'audit podría persistir secreto')
  expect(migration.replace("current_setting('app.mobile2a_secret_write_origin',true)='vault_to_legacy'","false"),'no-recursión')
  expect(migration.replace("BEGIN\n  IF current_setting('app.mobile2a_secret_write_origin',true)","BEGIN\n  IF NEW.device_password IS NOT DISTINCT FROM OLD.device_password THEN RETURN NEW; END IF;\n  IF current_setting('app.mobile2a_secret_write_origin',true)"),'same-value')
  console.log('mobile2a guard self-test OK: negative gates A-E detectados');process.exit(0)
}
const failures=inspect(source)
if(failures.length){console.error(`MOBILE-2A guard FAIL: ${failures.join(', ')}`);process.exit(1)}
if(!source.includes("rpc('create_order_intake")||!source.includes('p_access_secret: accessSecretForRpc')){
  console.error('MOBILE-2A guard FAIL: falta RPC canónico con secreto separado');process.exit(1)
}
const expandFailures=inspectExpand(migration)
if(expandFailures.length){console.error(`MOBILE-2A EXPAND guard FAIL: ${expandFailures.join(', ')}`);process.exit(1)}
const contractMigrations=readdirSync('supabase/migrations').filter(name=>/mobile2a.*contract|contract.*mobile2a/i.test(name))
if(contractMigrations.length){console.error(`MOBILE-2A EXPAND guard FAIL: CONTRACT pendiente en migraciones: ${contractMigrations.join(', ')}`);process.exit(1)}
console.log('MOBILE-2A guard OK: frontend Vault-only; EXPAND dual-write compatible, auditado y sin CONTRACT pendiente.')
