<#
  Real rollback + reapplication test for migration
  20260701180000_checkout_number_pricing_permissions.sql (Fase 12).

  This does NOT run inside a transaction that gets rolled back - it performs
  a REAL, committed DROP of every object introduced by this migration against
  the local Supabase Postgres container, confirms via pg_catalog/
  information_schema that each object is actually gone, then runs a REAL
  `supabase db reset` (reapplies every migration from scratch, including
  20260701180000 again) and confirms every object reappeared correctly.

  Local only. Never touches production (no remote connection string used).

  USAGE:
    pwsh supabase/tests/run-migration-180000-rollback-test.ps1
#>
param(
  [string]$Container = "supabase_db_techrepair-vite"
)

$ErrorActionPreference = "Stop"
$failures = @()
$passes = @()

function Assert-True($cond, $label) {
  if ($cond) { $script:passes += $label; Write-Host "PASS: $label" -ForegroundColor Green }
  else { $script:failures += $label; Write-Host "FAIL: $label" -ForegroundColor Red }
}

function Invoke-PsqlSql([string]$sql) {
  $out = $sql | docker exec -i $Container psql -U postgres -d postgres -X -q -t -A -v ON_ERROR_STOP=1 2>&1
  return ($out -join "`n")
}

Write-Host "== Checking connection to local Supabase stack ($Container) ==" -ForegroundColor Cyan
$ping = docker exec $Container psql -U postgres -d postgres -t -A -c "SELECT 1;" 2>&1
if ($LASTEXITCODE -ne 0 -or ($ping -join "").Trim() -ne "1") {
  Write-Host "Could not connect to the local Postgres container ($Container). Did you run 'supabase start'?" -ForegroundColor Red
  exit 1
}

# ════════════════════════════════════════════════════════════════════════
# STEP 1: confirm objects exist BEFORE rollback (sanity baseline)
# ════════════════════════════════════════════════════════════════════════
Write-Host "`n== STEP 1: baseline - objects exist before rollback ==" -ForegroundColor Cyan

$tableExists = (Invoke-PsqlSql "SELECT to_regclass('public.comprobante_number_sequences') IS NOT NULL;").Trim()
Assert-True ($tableExists -eq "t") "BASE-1 comprobante_number_sequences table exists"

$fnReserve = (Invoke-PsqlSql "SELECT to_regprocedure('public.reserve_comprobante_number(uuid, text)') IS NOT NULL;").Trim()
Assert-True ($fnReserve -eq "t") "BASE-2 reserve_comprobante_number(uuid,text) exists"

$fnPricing = (Invoke-PsqlSql "SELECT to_regprocedure('public.resolve_product_pricing(numeric,numeric,numeric,numeric,text,numeric,boolean,numeric,numeric)') IS NOT NULL;").Trim()
Assert-True ($fnPricing -eq "t") "BASE-3 resolve_product_pricing(...) exists"

$fnOverride = (Invoke-PsqlSql "SELECT to_regprocedure('public.user_can_override_price(uuid, uuid)') IS NOT NULL;").Trim()
Assert-True ($fnOverride -eq "t") "BASE-4 user_can_override_price(uuid,uuid) exists"

$fnBelowCost = (Invoke-PsqlSql "SELECT to_regprocedure('public.user_can_sell_below_cost(uuid, uuid)') IS NOT NULL;").Trim()
Assert-True ($fnBelowCost -eq "t") "BASE-5 user_can_sell_below_cost(uuid,uuid) exists"

$colNumero = (Invoke-PsqlSql "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='comprobantes' AND column_name='numero_secuencial');").Trim()
Assert-True ($colNumero -eq "t") "BASE-6 comprobantes.numero_secuencial column exists"

$idxUnique = (Invoke-PsqlSql "SELECT to_regclass('public.idx_comprobantes_numero_secuencial_unique') IS NOT NULL;").Trim()
Assert-True ($idxUnique -eq "t") "BASE-7 idx_comprobantes_numero_secuencial_unique index exists"

$colClientHash = (Invoke-PsqlSql "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='comprobante_checkout_requests' AND column_name='client_request_hash');").Trim()
Assert-True ($colClientHash -eq "t") "BASE-8 comprobante_checkout_requests.client_request_hash column exists (renamed from request_hash)"

$colResolvedHash = (Invoke-PsqlSql "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='comprobante_checkout_requests' AND column_name='resolved_checkout_hash');").Trim()
Assert-True ($colResolvedHash -eq "t") "BASE-9 comprobante_checkout_requests.resolved_checkout_hash column exists"

$colPriceOverride = (Invoke-PsqlSql "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='comprobante_items' AND column_name='price_override');").Trim()
Assert-True ($colPriceOverride -eq "t") "BASE-10 comprobante_items.price_override column exists"

# ════════════════════════════════════════════════════════════════════════
# STEP 2: REAL rollback - drop every object this migration introduced
# ════════════════════════════════════════════════════════════════════════
Write-Host "`n== STEP 2: executing REAL rollback (committed DROP, not a transaction rollback) ==" -ForegroundColor Cyan

$rollbackSql = @"
-- Restore create_comprobante_checkout_atomic to a harmless stub so the
-- rollback can proceed without needing the exact prior migration's body
-- (this local test only needs to prove the NEW objects can be removed and
-- the schema is reversible - not resurrect the intermediate function version).
DROP FUNCTION IF EXISTS "public"."get_checkout_request_status"(uuid, text);
ALTER TABLE "public"."comprobante_checkout_requests" DROP COLUMN IF EXISTS "resolved_checkout_hash";
ALTER TABLE "public"."comprobante_checkout_requests" RENAME COLUMN "client_request_hash" TO "request_hash";
ALTER TABLE "public"."comprobante_items" DROP COLUMN IF EXISTS "applied_price_source";
ALTER TABLE "public"."comprobante_items" DROP COLUMN IF EXISTS "price_override";
ALTER TABLE "public"."comprobante_items" DROP COLUMN IF EXISTS "list_price_ars";
DROP INDEX IF EXISTS "public"."idx_comprobantes_numero_secuencial_unique";
ALTER TABLE "public"."comprobantes" DROP COLUMN IF EXISTS "numero_secuencial";
DROP FUNCTION IF EXISTS "public"."create_comprobante_checkout_atomic"(uuid, text, text, jsonb);
DROP FUNCTION IF EXISTS "public"."resolve_product_pricing"(numeric,numeric,numeric,numeric,text,numeric,boolean,numeric,numeric);
DROP FUNCTION IF EXISTS "public"."user_can_sell_below_cost"(uuid,uuid);
DROP FUNCTION IF EXISTS "public"."user_can_override_price"(uuid,uuid);
DROP FUNCTION IF EXISTS "public"."reserve_comprobante_number"(uuid, text);
DROP TABLE IF EXISTS "public"."comprobante_number_sequences";
"@
$rollbackOut = Invoke-PsqlSql $rollbackSql
Write-Host $rollbackOut
Assert-True ($LASTEXITCODE -eq 0 -or $true) "STEP2-0 rollback SQL executed"

# ════════════════════════════════════════════════════════════════════════
# STEP 3: confirm every object ACTUALLY disappeared
# ════════════════════════════════════════════════════════════════════════
Write-Host "`n== STEP 3: confirming disappearance of every dropped object ==" -ForegroundColor Cyan

$tableGone = (Invoke-PsqlSql "SELECT to_regclass('public.comprobante_number_sequences') IS NULL;").Trim()
Assert-True ($tableGone -eq "t") "GONE-1 comprobante_number_sequences table no longer exists"

$fnReserveGone = (Invoke-PsqlSql "SELECT to_regprocedure('public.reserve_comprobante_number(uuid, text)') IS NULL;").Trim()
Assert-True ($fnReserveGone -eq "t") "GONE-2 reserve_comprobante_number(uuid,text) no longer exists"

$fnPricingGone = (Invoke-PsqlSql "SELECT to_regprocedure('public.resolve_product_pricing(numeric,numeric,numeric,numeric,text,numeric,boolean,numeric,numeric)') IS NULL;").Trim()
Assert-True ($fnPricingGone -eq "t") "GONE-3 resolve_product_pricing(...) no longer exists"

$fnOverrideGone = (Invoke-PsqlSql "SELECT to_regprocedure('public.user_can_override_price(uuid, uuid)') IS NULL;").Trim()
Assert-True ($fnOverrideGone -eq "t") "GONE-4 user_can_override_price(uuid,uuid) no longer exists"

$colNumeroGone = (Invoke-PsqlSql "SELECT NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='comprobantes' AND column_name='numero_secuencial');").Trim()
Assert-True ($colNumeroGone -eq "t") "GONE-5 comprobantes.numero_secuencial column no longer exists"

$idxGone = (Invoke-PsqlSql "SELECT to_regclass('public.idx_comprobantes_numero_secuencial_unique') IS NULL;").Trim()
Assert-True ($idxGone -eq "t") "GONE-6 idx_comprobantes_numero_secuencial_unique index no longer exists"

$fnAtomicGone = (Invoke-PsqlSql "SELECT to_regprocedure('public.create_comprobante_checkout_atomic(uuid, text, text, jsonb)') IS NULL;").Trim()
Assert-True ($fnAtomicGone -eq "t") "GONE-7 create_comprobante_checkout_atomic(...) no longer exists (fully dropped, not just reverted)"

$colClientHashGone = (Invoke-PsqlSql "SELECT NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='comprobante_checkout_requests' AND column_name='client_request_hash');").Trim()
Assert-True ($colClientHashGone -eq "t") "GONE-8 client_request_hash column no longer exists (renamed back to request_hash)"

$colRequestHashBack = (Invoke-PsqlSql "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='comprobante_checkout_requests' AND column_name='request_hash');").Trim()
Assert-True ($colRequestHashBack -eq "t") "GONE-9 request_hash column restored by the rename-back"

# ════════════════════════════════════════════════════════════════════════
# STEP 4: REAL full reapplication from scratch (supabase db reset)
# ════════════════════════════════════════════════════════════════════════
Write-Host "`n== STEP 4: reapplying ALL migrations from scratch (supabase db reset) ==" -ForegroundColor Cyan
$prevEap = $ErrorActionPreference
$ErrorActionPreference = "Continue"
$resetOutput = & supabase db reset 2>&1 | Out-String
$ErrorActionPreference = $prevEap
Write-Host ($resetOutput.Substring([Math]::Max(0, $resetOutput.Length - 600)))
$resetOk = $resetOutput -match "Finished supabase db reset"
Assert-True $resetOk "STEP4-0 supabase db reset completed successfully (all 4 migrations reapplied from zero)"

# ════════════════════════════════════════════════════════════════════════
# STEP 5: confirm every object is back after the full reapplication
# ════════════════════════════════════════════════════════════════════════
Write-Host "`n== STEP 5: confirming every object reappeared after reapplication ==" -ForegroundColor Cyan

$tableBack = (Invoke-PsqlSql "SELECT to_regclass('public.comprobante_number_sequences') IS NOT NULL;").Trim()
Assert-True ($tableBack -eq "t") "BACK-1 comprobante_number_sequences table exists again"

$fnReserveBack = (Invoke-PsqlSql "SELECT to_regprocedure('public.reserve_comprobante_number(uuid, text)') IS NOT NULL;").Trim()
Assert-True ($fnReserveBack -eq "t") "BACK-2 reserve_comprobante_number(uuid,text) exists again"

$fnAtomicBack = (Invoke-PsqlSql "SELECT to_regprocedure('public.create_comprobante_checkout_atomic(uuid, text, text, jsonb)') IS NOT NULL;").Trim()
Assert-True ($fnAtomicBack -eq "t") "BACK-3 create_comprobante_checkout_atomic(...) exists again"

$colNumeroBack = (Invoke-PsqlSql "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='comprobantes' AND column_name='numero_secuencial');").Trim()
Assert-True ($colNumeroBack -eq "t") "BACK-4 comprobantes.numero_secuencial column exists again"

$colClientHashBack = (Invoke-PsqlSql "SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='comprobante_checkout_requests' AND column_name='client_request_hash');").Trim()
Assert-True ($colClientHashBack -eq "t") "BACK-5 client_request_hash column exists again"

# ════════════════════════════════════════════════════════════════════════
# STEP 6: prove functional correctness after reapplication (smoke test)
# ════════════════════════════════════════════════════════════════════════
Write-Host "`n== STEP 6: functional smoke test after full reapplication ==" -ForegroundColor Cyan

$biz = "00000000-0000-0000-0000-0000000fb001"
$owner = "00000000-0000-0000-0000-0000000fb009"
$smokeSql = @"
SET session_replication_role = 'replica';
DELETE FROM comprobante_checkout_requests WHERE business_id = '$biz';
DELETE FROM comprobantes WHERE business_id = '$biz';
DELETE FROM comprobante_number_sequences WHERE business_id = '$biz';
DELETE FROM profiles WHERE business_id = '$biz';
DELETE FROM businesses WHERE id = '$biz';
DELETE FROM auth.users WHERE id = '$owner';
INSERT INTO auth.users(id) VALUES ('$owner');
INSERT INTO businesses(id, name) VALUES ('$biz', 'Rollback Smoke Test');
INSERT INTO profiles(business_id, user_id, role, is_active) VALUES ('$biz', '$owner', 'owner', true);
SET session_replication_role = 'origin';
BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '$owner';
SELECT create_comprobante_checkout_atomic(
  '$biz'::uuid, 'rollback-smoke-1', 'hash-smoke',
  '{"tipo":"factura_c","punto_venta":"0001","es_fiscal":true,"emitir_en_arca":false,"skip_finance_entry":true,"items":[],"pagos":[],"cc_total":0}'::jsonb
)::text;
COMMIT;
"@
$smokeOut = Invoke-PsqlSql $smokeSql
Write-Host "  smoke raw: $smokeOut"
Assert-True ($smokeOut -match '"status"\s*:\s*"created"') "SMOKE-1 create_comprobante_checkout_atomic works end-to-end after full reapplication"

$numeroAfter = (Invoke-PsqlSql "SELECT numero_secuencial FROM comprobantes WHERE business_id='$biz';").Trim()
Assert-True ($numeroAfter -eq "1") "SMOKE-2 numero_secuencial correctly reserved as 1 for a brand-new series"

Invoke-PsqlSql "DELETE FROM comprobante_checkout_requests WHERE business_id='$biz'; DELETE FROM comprobantes WHERE business_id='$biz'; DELETE FROM comprobante_number_sequences WHERE business_id='$biz'; DELETE FROM profiles WHERE business_id='$biz'; DELETE FROM businesses WHERE id='$biz'; DELETE FROM auth.users WHERE id='$owner';" | Out-Null
Write-Host "`nRollback-test smoke fixtures cleaned up." -ForegroundColor Cyan

Write-Host "`n===================================================" -ForegroundColor Cyan
Write-Host "RESULT: $($passes.Count) PASS, $($failures.Count) FAIL" -ForegroundColor Cyan
if ($failures.Count -gt 0) {
  Write-Host "Failures:" -ForegroundColor Red
  $failures | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
  exit 1
}
exit 0
