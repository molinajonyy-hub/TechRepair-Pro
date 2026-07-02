<#
  Verifies the ROLLBACK block documented in
  supabase/migrations/20260701150000_arca_atomic_claim.sql:
    DROP FUNCTION complete_arca_attempt / mark_arca_attempt_sent /
    reserve_arca_number / claim_comprobante_arca_emission;
    DROP TABLE arca_emission_attempts;

  STRATEGY:
  1) Try to clone the working database into a real TEMPORARY database
     (`CREATE DATABASE ... TEMPLATE <db>`) to run the rollback there without
     touching the dev database. This requires ZERO active connections to the
     template database at that instant - the local Supabase stack keeps
     persistent PostgREST/GoTrue/Realtime connections, so this normally
     FAILS (the real result is reported, not assumed to work).
  2) If cloning fails (expected case), verify inside a transaction on the
     current database with a final ROLLBACK - never persists the drop. This
     is still a real test that the documented DROP statements execute
     without error and leave the objects gone, just not isolated in a
     separate physical database. The final result states explicitly which
     of the two strategies ran.

  USAGE:
    pwsh supabase/tests/arca_migration_rollback_test.ps1
#>
param(
  [string]$Container = "supabase_db_techrepair-vite",
  [string]$WorkingDb = "postgres"
)

$ErrorActionPreference = "Stop"
$ScratchDb = "arca_rollback_scratch"

function Invoke-Psql([string]$db, [string]$sql) {
  $prevEap = $ErrorActionPreference
  $ErrorActionPreference = "Continue"
  try {
    $out = $sql | docker exec -i $Container psql -U postgres -d $db -X -q -t -A -v ON_ERROR_STOP=1 2>&1
    $code = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $prevEap
  }
  return @{ Text = ($out -join "`n"); Code = $code }
}

$rollbackSql = @"
DROP FUNCTION IF EXISTS public.complete_arca_attempt(uuid, text, text, timestamptz, text, text, text);
DROP FUNCTION IF EXISTS public.mark_arca_attempt_sent(uuid);
DROP FUNCTION IF EXISTS public.reserve_arca_number(uuid, integer);
DROP FUNCTION IF EXISTS public.claim_comprobante_arca_emission(uuid, text);
DROP TABLE IF EXISTS public.arca_emission_attempts;
"@

$verifySql = @"
SELECT
  (to_regclass('public.arca_emission_attempts') IS NULL)::text AS table_gone,
  (to_regprocedure('public.claim_comprobante_arca_emission(uuid,text)') IS NULL)::text AS claim_gone,
  (to_regprocedure('public.reserve_arca_number(uuid,integer)') IS NULL)::text AS reserve_gone,
  (to_regprocedure('public.mark_arca_attempt_sent(uuid)') IS NULL)::text AS mark_sent_gone,
  (to_regprocedure('public.complete_arca_attempt(uuid,text,text,timestamptz,text,text,text)') IS NULL)::text AS complete_gone,
  (to_regclass('public.comprobantes') IS NOT NULL)::text AS comprobantes_untouched;
"@

Write-Host "== Attempt 1: clone $WorkingDb -> $ScratchDb (real temp database) ==" -ForegroundColor Cyan
Invoke-Psql $WorkingDb "DROP DATABASE IF EXISTS $ScratchDb;" | Out-Null
$clone = Invoke-Psql $WorkingDb "CREATE DATABASE $ScratchDb TEMPLATE $WorkingDb;"

if ($clone.Code -eq 0) {
  Write-Host "Clone OK - running rollback in the isolated TEMP database ($ScratchDb)." -ForegroundColor Green
  $strategy = "temp_database"
  $targetDb = $ScratchDb

  $preCheck = Invoke-Psql $targetDb "SELECT (to_regclass('public.arca_emission_attempts') IS NOT NULL)::text;"
  Write-Host "Pre-rollback, table exists in the cloned database: $($preCheck.Text.Trim())"

  $applyRollback = Invoke-Psql $targetDb $rollbackSql
  if ($applyRollback.Code -ne 0) {
    Write-Host "The documented ROLLBACK block FAILED to execute:" -ForegroundColor Red
    Write-Host $applyRollback.Text
    Invoke-Psql $WorkingDb "DROP DATABASE IF EXISTS $ScratchDb;" | Out-Null
    exit 1
  }

  $verify = Invoke-Psql $targetDb $verifySql
  Write-Host "Verify result (table_gone|claim_gone|reserve_gone|mark_sent_gone|complete_gone|comprobantes_untouched):"
  Write-Host $verify.Text

  Invoke-Psql $WorkingDb "DROP DATABASE IF EXISTS $ScratchDb;" | Out-Null
  Write-Host "Temp database $ScratchDb dropped after verification." -ForegroundColor Cyan
} else {
  Write-Host "Clone FAILED (expected: the local Supabase stack keeps active connections to '$WorkingDb' from PostgREST/GoTrue/Realtime, and CREATE DATABASE ... TEMPLATE requires zero connections to the source). Detail:" -ForegroundColor Yellow
  Write-Host $clone.Text
  Write-Host "`n== Attempt 2: verify rollback in a TRANSACTION on the current database (final ROLLBACK, does not persist) ==" -ForegroundColor Cyan
  $strategy = "transaction_on_working_db_rolled_back"

  $script = @"
BEGIN;
$rollbackSql
$verifySql
ROLLBACK;
"@
  $result = Invoke-Psql $WorkingDb $script
  if ($result.Code -ne 0) {
    Write-Host "The documented ROLLBACK block FAILED to execute (inside a transaction that is reverted anyway):" -ForegroundColor Red
    Write-Host $result.Text
    exit 1
  }
  Write-Host "Verify result (table_gone|claim_gone|reserve_gone|mark_sent_gone|complete_gone|comprobantes_untouched):"
  Write-Host $result.Text

  # Confirm that the test transaction's ROLLBACK really left everything intact.
  $postCheck = Invoke-Psql $WorkingDb "SELECT (to_regclass('public.arca_emission_attempts') IS NOT NULL)::text;"
  if ($postCheck.Text.Trim() -ne "true") {
    Write-Host "ALERT: after the test transaction's ROLLBACK, arca_emission_attempts no longer exists in the working database - this should NOT happen." -ForegroundColor Red
    exit 1
  }
  Write-Host "Confirmed: the working database was NOT altered (arca_emission_attempts still exists after the test transaction's ROLLBACK)." -ForegroundColor Green
}

Write-Host "`nStrategy used: $strategy" -ForegroundColor Cyan
exit 0
