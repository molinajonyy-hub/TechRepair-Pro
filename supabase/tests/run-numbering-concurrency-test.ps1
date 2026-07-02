<#
  Real concurrency test for reserve_comprobante_number (N1/N5 from the
  numbering audit, 2026-07-01) - two independent Postgres connections.

  N1: two DIFFERENT sales (different idempotency keys), SAME series
      (business_id, tipo) - both must complete, with DIFFERENT, consecutive
      numbers, zero collision. Connection 2 must be genuinely BLOCKED by
      connection 1's uncommitted transaction (measured), proving Postgres -
      not the frontend - serializes the series.

  N5: two DIFFERENT series (different business_id) advance in parallel
      without blocking each other.

  Requires: `supabase start` (or `db reset`) already run, with migration
  20260701180000_checkout_number_pricing_permissions.sql applied.

  USAGE:
    pwsh supabase/tests/run-numbering-concurrency-test.ps1
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
  Write-Host "Could not connect to the local Postgres container ($Container)." -ForegroundColor Red
  exit 1
}

$bizA = "00000000-0000-0000-0000-00000000ec01"
$bizB = "00000000-0000-0000-0000-00000000ec02"
$owner = "00000000-0000-0000-0000-00000000ec09"
$ownerB = "00000000-0000-0000-0000-00000000ec19"

$setupSql = @"
SET session_replication_role = 'replica';
DELETE FROM comprobante_checkout_requests WHERE business_id IN ('$bizA', '$bizB');
DELETE FROM comprobantes WHERE business_id IN ('$bizA', '$bizB');
DELETE FROM comprobante_number_sequences WHERE business_id IN ('$bizA', '$bizB');
DELETE FROM profiles WHERE business_id IN ('$bizA', '$bizB');
DELETE FROM businesses WHERE id IN ('$bizA', '$bizB');
DELETE FROM auth.users WHERE id IN ('$owner', '$ownerB');

INSERT INTO auth.users(id) VALUES ('$owner'), ('$ownerB');
INSERT INTO businesses(id, name) VALUES ('$bizA', 'Test Biz Numbering Conc A'), ('$bizB', 'Test Biz Numbering Conc B');
INSERT INTO profiles(business_id, user_id, role, is_active) VALUES ('$bizA', '$owner', 'owner', true), ('$bizB', '$ownerB', 'owner', true);
SET session_replication_role = 'origin';
"@
Invoke-PsqlSql $setupSql | Out-Null
Write-Host "Numbering concurrency fixtures inserted (bizA=$bizA, bizB=$bizB)." -ForegroundColor Cyan

function New-CheckoutScript([string]$bizId, [string]$key, [int]$sleepSeconds, [string]$ownerId = $owner) {
  $payload = '{"tipo":"factura_c","punto_venta":"0001","es_fiscal":true,"emitir_en_arca":false,"skip_finance_entry":true,"items":[],"pagos":[],"cc_total":0}'
  return @"
BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '$ownerId';
SELECT create_comprobante_checkout_atomic('$bizId'::uuid, '$key', 'hash-$key', '$payload'::jsonb)::text;
SELECT pg_sleep($sleepSeconds);
COMMIT;
"@
}

# ════════════════════════════════════════════════════════════════════════
# N1: two DIFFERENT sales, SAME series, concurrent -> distinct consecutive numbers.
# ════════════════════════════════════════════════════════════════════════
Write-Host "`n== N1: two concurrent connections, DIFFERENT sales, SAME series (business_id+tipo) ==" -ForegroundColor Cyan
$job1 = Start-Job -ScriptBlock {
  param($sql, $container)
  $out = $sql | docker exec -i $container psql -U postgres -d postgres -X -q -t -A -v ON_ERROR_STOP=1 2>&1
  return ($out -join "`n")
} -ArgumentList (New-CheckoutScript $bizA "n1-sale-1" 4), $Container

Start-Sleep -Milliseconds 900
$job2 = Start-Job -ScriptBlock {
  param($sql, $container)
  $out = $sql | docker exec -i $container psql -U postgres -d postgres -X -q -t -A -v ON_ERROR_STOP=1 2>&1
  return ($out -join "`n")
} -ArgumentList (New-CheckoutScript $bizA "n1-sale-2" 0), $Container

$beforeConn2 = Get-Date
Wait-Job $job2 | Out-Null
$conn2Done = Get-Date
$out2 = Receive-Job $job2
Wait-Job $job1 | Out-Null
$out1 = Receive-Job $job1
Remove-Job $job1, $job2 -Force

$r1 = Get-FirstJsonLine $out1 | ConvertFrom-Json
$r2 = Get-FirstJsonLine $out2 | ConvertFrom-Json
$blockedMs = ($conn2Done - $beforeConn2).TotalMilliseconds

Write-Host "  conn1 (sale 1) raw: $out1"
Write-Host "  conn2 (sale 2) raw: $out2"

Assert-True ($r1.status -eq "created") "N1a sale 1 (started first) -> created"
Assert-True ($r2.status -eq "created") "N1b sale 2 (concurrent, same series) -> created (NOT blocked forever, NOT a duplicate)"
Assert-True ($r1.comprobante_id -ne $r2.comprobante_id) "N1c two DIFFERENT comprobante_id (two real, distinct sales)"
Assert-True ($blockedMs -gt 2000) "N1d connection 2 was genuinely BLOCKED by connection 1's uncommitted number reservation (real Postgres block of ~${blockedMs}ms - Postgres serializes the series, not the frontend)"

$num1 = (Invoke-PsqlSql "SELECT numero_secuencial FROM comprobantes WHERE id='$($r1.comprobante_id)';").Trim()
$num2 = (Invoke-PsqlSql "SELECT numero_secuencial FROM comprobantes WHERE id='$($r2.comprobante_id)';").Trim()
Write-Host "  numero_secuencial: sale1=$num1, sale2=$num2"
Assert-True ($num1 -ne $num2) "N1e the two sales got DIFFERENT numero_secuencial"
Assert-True ([Math]::Abs([int]$num2 - [int]$num1) -eq 1) "N1f the two numbers are CONSECUTIVE (diff = 1) - zero gaps, zero collisions"

$countSeq = (Invoke-PsqlSql "SELECT last_number FROM comprobante_number_sequences WHERE business_id='$bizA' AND tipo='factura_c';").Trim()
Assert-True ($countSeq -eq "2") "N1g the counter ended at exactly 2 (not 1, not 3 - each concurrent sale advanced it exactly once)"

# ════════════════════════════════════════════════════════════════════════
# N5: two DIFFERENT series (different business_id) advance in parallel.
# ════════════════════════════════════════════════════════════════════════
Write-Host "`n== N5: two concurrent connections, DIFFERENT series (different business_id) ==" -ForegroundColor Cyan
$jobA = Start-Job -ScriptBlock {
  param($sql, $container)
  $out = $sql | docker exec -i $container psql -U postgres -d postgres -X -q -t -A -v ON_ERROR_STOP=1 2>&1
  return ($out -join "`n")
} -ArgumentList (New-CheckoutScript $bizA "n5-bizA" 4), $Container

Start-Sleep -Milliseconds 900
$jobB = Start-Job -ScriptBlock {
  param($sql, $container)
  $out = $sql | docker exec -i $container psql -U postgres -d postgres -X -q -t -A -v ON_ERROR_STOP=1 2>&1
  return ($out -join "`n")
} -ArgumentList (New-CheckoutScript $bizB "n5-bizB" 0 $ownerB), $Container

$beforeB = Get-Date
Wait-Job $jobB | Out-Null
$bDone = Get-Date
$outB = Receive-Job $jobB
Wait-Job $jobA | Out-Null
$outA = Receive-Job $jobA
Remove-Job $jobA, $jobB -Force

$rA = Get-FirstJsonLine $outA | ConvertFrom-Json
$rB = Get-FirstJsonLine $outB | ConvertFrom-Json
$notBlockedMs = ($bDone - $beforeB).TotalMilliseconds

Write-Host "  connA (bizA) raw: $outA"
Write-Host "  connB (bizB) raw: $outB"

Assert-True ($rA.status -eq "created") "N5a bizA sale -> created"
Assert-True ($rB.status -eq "created") "N5b bizB sale (different series, concurrent) -> created"
Assert-True ($notBlockedMs -lt 2000) "N5c connection B was NOT blocked by connection A (different series -> different row in comprobante_number_sequences, ~${notBlockedMs}ms, no wait for the other business's uncommitted reservation)"

# ── Teardown ────────────────────────────────────────────────────────────
$teardownSql = @"
DELETE FROM comprobante_checkout_requests WHERE business_id IN ('$bizA', '$bizB');
DELETE FROM comprobantes WHERE business_id IN ('$bizA', '$bizB');
DELETE FROM comprobante_number_sequences WHERE business_id IN ('$bizA', '$bizB');
DELETE FROM profiles WHERE business_id IN ('$bizA', '$bizB');
DELETE FROM businesses WHERE id IN ('$bizA', '$bizB');
DELETE FROM auth.users WHERE id IN ('$owner', '$ownerB');
"@
Invoke-PsqlSql $teardownSql | Out-Null
Write-Host "`nNumbering concurrency fixtures cleaned up." -ForegroundColor Cyan

Write-Host "`n===================================================" -ForegroundColor Cyan
Write-Host "RESULT: $($passes.Count) PASS, $($failures.Count) FAIL" -ForegroundColor Cyan
if ($failures.Count -gt 0) {
  Write-Host "Failures:" -ForegroundColor Red
  $failures | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
  exit 1
}
exit 0
