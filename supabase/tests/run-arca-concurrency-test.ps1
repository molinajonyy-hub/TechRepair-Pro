<#
  Real concurrency test for claim_comprobante_arca_emission.

  arca_atomic_claim_test.sql runs everything in a single transaction/session
  - it cannot demonstrate real mutual exclusion between concurrent
  connections (which is exactly what was asked to be verified, not
  simulated with two sequential statements in one session). This script
  uses TWO independent connections per test (two separate `docker exec ...
  psql` processes, launched as PowerShell background jobs = two real
  Postgres backends), and relies on REAL Postgres behavior when a partial
  unique index is hit: if transaction A inserted (without commit) a row
  that satisfies the unique index, a transaction B that tries to insert a
  conflicting row gets BLOCKED (waiting for A to resolve) - it does not
  fail immediately. This proves mutual exclusion deterministically:
    - Job 1 opens a transaction, claims, SLEEPS a few seconds without
      committing.
    - Job 2 starts ~1s later and tries to claim the same resource: if the
      unique index really protects it, Job 2 must stay BLOCKED until Job 1
      commits, and only then fail with already_in_progress / serie_ocupada.
    - If Job 2 does NOT block and returns 'acquired' immediately, the lock
      is NOT real - this test detects that.

  Requires: `supabase start` (or `db reset`) already run, with migrations
  20260701140000_arca_pending_reconciliation_state.sql and
  20260701150000_arca_atomic_claim.sql applied.

  USAGE:
    pwsh supabase/tests/run-arca-concurrency-test.ps1
    pwsh supabase/tests/run-arca-concurrency-test.ps1 -Container supabase_db_techrepair-vite
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
  # Pipe the SQL script as stdin of a `docker exec -i psql` - one real connection.
  $out = $sql | docker exec -i $Container psql -U postgres -d postgres -X -q -t -A -v ON_ERROR_STOP=1 2>&1
  return ($out -join "`n")
}

function Get-FirstJsonLine([string]$output) {
  foreach ($line in ($output -split "`n")) {
    $trimmed = $line.Trim()
    if ($trimmed.StartsWith("{")) { return $trimmed }
  }
  return $null
}

Write-Host "== Checking connection to local Supabase stack ($Container) ==" -ForegroundColor Cyan
$ping = docker exec $Container psql -U postgres -d postgres -t -A -c "SELECT 1;" 2>&1
if ($LASTEXITCODE -ne 0 -or ($ping -join "").Trim() -ne "1") {
  Write-Host "Could not connect to the local Postgres container ($Container). Did you run 'supabase start'?" -ForegroundColor Red
  Write-Host $ping
  exit 1
}

# ── Fixtures (autocommit, outside any test transaction) ────────────────────
# T1/T2 share ONE business/series (bizConc) - that's the point of T2 (two
# DIFFERENT comprobantes, SAME series). T3 gets its OWN separate business
# (bizConc3) so its pre-seeded abandoned 'claimed' row does not occupy the
# T1/T2 series before those tests even run.
$bizConc = "00000000-0000-0000-0000-00000000c001"
$bizConc3 = "00000000-0000-0000-0000-00000000c003"
$ownerConc = "00000000-0000-0000-0000-00000000c009"
$ownerConc3 = "00000000-0000-0000-0000-00000000c019"
$compSame = "00000000-0000-0000-0000-0000000c0900"          # T1: same comprobante_id
$compSerieA = "00000000-0000-0000-0000-0000000c0901"         # T2: shared series, comprobante A
$compSerieB = "00000000-0000-0000-0000-0000000c0902"         # T2: shared series, comprobante B
$compAbandoned = "00000000-0000-0000-0000-0000000c0903"      # T3: abandoned-claim recovery race

$setupSql = @"
SET session_replication_role = 'replica';
DELETE FROM arca_emission_attempts WHERE business_id IN ('$bizConc', '$bizConc3');
DELETE FROM comprobantes WHERE business_id IN ('$bizConc', '$bizConc3');
DELETE FROM arca_config WHERE business_id IN ('$bizConc', '$bizConc3');
DELETE FROM profiles WHERE business_id IN ('$bizConc', '$bizConc3');
DELETE FROM businesses WHERE id IN ('$bizConc', '$bizConc3');

INSERT INTO businesses(id, name) VALUES ('$bizConc', 'Test Biz Concurrencia'), ('$bizConc3', 'Test Biz Concurrencia T3');
INSERT INTO profiles(business_id, user_id, role, is_active) VALUES
  ('$bizConc', '$ownerConc', 'owner', true),
  ('$bizConc3', '$ownerConc3', 'owner', true);
INSERT INTO arca_config(business_id, cuit_emisor, punto_venta, ambiente) VALUES
  ('$bizConc', '20333333334', 5, 'homologacion'),
  ('$bizConc3', '20444444445', 6, 'homologacion');

INSERT INTO comprobantes(id, business_id, tipo, estado, estado_fiscal) VALUES
  ('$compSame', '$bizConc', 'factura_c', 'borrador', 'pendiente_emision'),
  ('$compSerieA', '$bizConc', 'factura_c', 'borrador', 'pendiente_emision'),
  ('$compSerieB', '$bizConc', 'factura_c', 'borrador', 'pendiente_emision'),
  ('$compAbandoned', '$bizConc3', 'factura_c', 'borrador', 'pendiente_emision');

-- T3: old 'claimed' attempt (>2 min), eligible for abandoned recovery. Lives
-- entirely inside bizConc3's own series - does not touch bizConc's series.
INSERT INTO arca_emission_attempts (
  comprobante_id, business_id, correlation_id, ambiente, cuit_emisor, punto_venta, tipo_comprobante, status, started_at
) VALUES (
  '$compAbandoned', '$bizConc3', 'corr-conc-t3-old', 'homologacion', '20444444445', 6, 11, 'claimed', now() - INTERVAL '10 minutes'
);
SET session_replication_role = 'origin';
"@
Invoke-PsqlSql $setupSql | Out-Null
Write-Host "Concurrency fixtures inserted (business $bizConc / $bizConc3)." -ForegroundColor Cyan

function New-ClaimScript([string]$compId, [string]$corr, [int]$sleepSeconds, [string]$owner = $ownerConc) {
  return @"
BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '$owner';
SELECT claim_comprobante_arca_emission('$compId'::uuid, '$corr')::text;
SELECT pg_sleep($sleepSeconds);
COMMIT;
"@
}

# ════════════════════════════════════════════════════════════════════════
# T1: two connections claiming the SAME comprobante_id at the same time.
# ════════════════════════════════════════════════════════════════════════
Write-Host "`n== T1: two concurrent connections, SAME comprobante_id ==" -ForegroundColor Cyan
$job1 = Start-Job -ScriptBlock {
  param($sql, $container)
  $out = $sql | docker exec -i $container psql -U postgres -d postgres -X -q -t -A -v ON_ERROR_STOP=1 2>&1
  return ($out -join "`n")
} -ArgumentList (New-ClaimScript $compSame "conc-t1-conn1" 4), $Container

Start-Sleep -Milliseconds 900
$job2 = Start-Job -ScriptBlock {
  param($sql, $container)
  $out = $sql | docker exec -i $container psql -U postgres -d postgres -X -q -t -A -v ON_ERROR_STOP=1 2>&1
  return ($out -join "`n")
} -ArgumentList (New-ClaimScript $compSame "conc-t1-conn2" 0), $Container

$t1BeforeConn2Result = Get-Date
Wait-Job $job2 | Out-Null
$t1Conn2Done = Get-Date
$out2 = Receive-Job $job2
Wait-Job $job1 | Out-Null
$out1 = Receive-Job $job1
Remove-Job $job1, $job2 -Force

$r1 = Get-FirstJsonLine $out1 | ConvertFrom-Json
$r2 = Get-FirstJsonLine $out2 | ConvertFrom-Json
$blockedMs = ($t1Conn2Done - $t1BeforeConn2Result).TotalMilliseconds

Write-Host "  conn1 raw: $out1"
Write-Host "  conn2 raw: $out2"

Assert-True ($r1.result -eq "acquired") "T1a connection 1 (started first) -> acquired"
Assert-True ($r2.result -eq "already_in_progress") "T1b connection 2 (concurrent, same comprobante) -> already_in_progress"
Assert-True ($blockedMs -gt 2000) "T1c connection 2 was BLOCKED by connection 1's uncommitted transaction (real block of ~${blockedMs}ms - proves the unique index makes it wait, not that it merely 'won a timing race')"

$countLive = (Invoke-PsqlSql "SELECT count(*) FROM arca_emission_attempts WHERE comprobante_id='$compSame' AND status IN ('claimed','number_reserved','sent');").Trim()
Assert-True ($countLive -eq "1") "T1d only one live row remained for that comprobante_id after the real race"

# Release the series T1 left occupied (compSame shares bizConc's series with
# compSerieA/compSerieB) so T2 starts from a clean series, not from T1's
# still-'claimed' row.
Invoke-PsqlSql "UPDATE arca_emission_attempts SET status='rejected', completed_at=now() WHERE comprobante_id='$compSame' AND status='claimed';" | Out-Null

# ════════════════════════════════════════════════════════════════════════
# T2: two connections claiming DIFFERENT comprobantes of the SAME fiscal series.
#     This is the exact scenario the user reported that the old index did not cover.
# ════════════════════════════════════════════════════════════════════════
Write-Host "`n== T2: two concurrent connections, DIFFERENT comprobantes, SAME fiscal series ==" -ForegroundColor Cyan
$jobA = Start-Job -ScriptBlock {
  param($sql, $container)
  $out = $sql | docker exec -i $container psql -U postgres -d postgres -X -q -t -A -v ON_ERROR_STOP=1 2>&1
  return ($out -join "`n")
} -ArgumentList (New-ClaimScript $compSerieA "conc-t2-conn-a" 4), $Container

Start-Sleep -Milliseconds 900
$jobB = Start-Job -ScriptBlock {
  param($sql, $container)
  $out = $sql | docker exec -i $container psql -U postgres -d postgres -X -q -t -A -v ON_ERROR_STOP=1 2>&1
  return ($out -join "`n")
} -ArgumentList (New-ClaimScript $compSerieB "conc-t2-conn-b" 0), $Container

$t2BeforeB = Get-Date
Wait-Job $jobB | Out-Null
$t2BDone = Get-Date
$outB = Receive-Job $jobB
Wait-Job $jobA | Out-Null
$outA = Receive-Job $jobA
Remove-Job $jobA, $jobB -Force

$rA = Get-FirstJsonLine $outA | ConvertFrom-Json
$rB = Get-FirstJsonLine $outB | ConvertFrom-Json
$blockedMsB = ($t2BDone - $t2BeforeB).TotalMilliseconds

Write-Host "  connA raw: $outA"
Write-Host "  connB raw: $outB"

Assert-True ($rA.result -eq "acquired") "T2a comprobante A (started first) -> acquired"
Assert-True ($rB.result -eq "serie_ocupada") "T2b comprobante B, DIFFERENT comprobante_id but SAME fiscal series, concurrent -> serie_ocupada (NOT acquired) - this is the fix for the reported race"
Assert-True ($rB.blocking_comprobante_id -eq $compSerieA) "T2c serie_ocupada reports that comprobante A is the one holding the series"
Assert-True ($blockedMsB -gt 2000) "T2d comprobante B was BLOCKED by A's uncommitted transaction (real block, not timing) - block of ~${blockedMsB}ms"

$countSerieLive = (Invoke-PsqlSql "SELECT count(*) FROM arca_emission_attempts WHERE ambiente='homologacion' AND cuit_emisor='20333333334' AND punto_venta=5 AND tipo_comprobante=11 AND status IN ('claimed','number_reserved','sent','pending_reconciliation');").Trim()
Assert-True ($countSerieLive -eq "1") "T2e only ONE live row for the whole fiscal series after the real race (never two simultaneous candidates for FECompUltimoAutorizado/FECAESolicitar)"

# ════════════════════════════════════════════════════════════════════════
# T3: two connections racing to recover the SAME abandoned claim.
# ════════════════════════════════════════════════════════════════════════
Write-Host "`n== T3: two connections racing to recover the SAME abandoned claim ==" -ForegroundColor Cyan
$jobR1 = Start-Job -ScriptBlock {
  param($sql, $container)
  $out = $sql | docker exec -i $container psql -U postgres -d postgres -X -q -t -A -v ON_ERROR_STOP=1 2>&1
  return ($out -join "`n")
} -ArgumentList (New-ClaimScript $compAbandoned "conc-t3-conn1" 3 $ownerConc3), $Container

$jobR2 = Start-Job -ScriptBlock {
  param($sql, $container)
  $out = $sql | docker exec -i $container psql -U postgres -d postgres -X -q -t -A -v ON_ERROR_STOP=1 2>&1
  return ($out -join "`n")
} -ArgumentList (New-ClaimScript $compAbandoned "conc-t3-conn2" 0 $ownerConc3), $Container

Wait-Job $jobR1, $jobR2 | Out-Null
$outR1 = Receive-Job $jobR1
$outR2 = Receive-Job $jobR2
Remove-Job $jobR1, $jobR2 -Force

Write-Host "  conn1 raw: $outR1"
Write-Host "  conn2 raw: $outR2"

$rR1 = Get-FirstJsonLine $outR1 | ConvertFrom-Json
$rR2 = Get-FirstJsonLine $outR2 | ConvertFrom-Json

$winners = @(@($rR1, $rR2) | Where-Object { $_.result -eq "acquired" -and $_.recovered_abandoned_attempt -eq $true })
$losers = @(@($rR1, $rR2) | Where-Object { $_.result -eq "already_in_progress" })

Assert-True ($winners.Count -eq 1) "T3a exactly ONE of the two connections won the abandoned-claim recovery (recovered_abandoned_attempt=true)"
Assert-True ($losers.Count -eq 1) "T3b the other connection got already_in_progress (lost cleanly, no clash or duplicate)"

$countAbandonedLive = (Invoke-PsqlSql "SELECT count(*) FROM arca_emission_attempts WHERE comprobante_id='$compAbandoned' AND status IN ('claimed','number_reserved','sent');").Trim()
Assert-True ($countAbandonedLive -eq "1") "T3c only one live row after the recovery race (the old one stayed 'abandoned', traceable, not deleted)"

# ── Teardown ────────────────────────────────────────────────────────────
$teardownSql = @"
DELETE FROM arca_emission_attempts WHERE business_id IN ('$bizConc', '$bizConc3');
DELETE FROM comprobantes WHERE business_id IN ('$bizConc', '$bizConc3');
DELETE FROM arca_config WHERE business_id IN ('$bizConc', '$bizConc3');
DELETE FROM profiles WHERE business_id IN ('$bizConc', '$bizConc3');
DELETE FROM businesses WHERE id IN ('$bizConc', '$bizConc3');
"@
Invoke-PsqlSql $teardownSql | Out-Null
Write-Host "`nConcurrency fixtures cleaned up." -ForegroundColor Cyan

Write-Host "`n===================================================" -ForegroundColor Cyan
Write-Host "RESULT: $($passes.Count) PASS, $($failures.Count) FAIL" -ForegroundColor Cyan
if ($failures.Count -gt 0) {
  Write-Host "Failures:" -ForegroundColor Red
  $failures | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
  exit 1
}
exit 0
