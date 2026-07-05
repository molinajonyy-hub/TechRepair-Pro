<#
  Real concurrency test for create_quick_inventory_purchase_atomic, verifying
  the payload-bound idempotency contract under two independent connections.

  etapa1_quick_purchase_test.sql runs in a single transaction/session and can
  assert the replay/conflict LOGIC, but not real mutual exclusion. This script
  uses TWO independent connections (two `docker exec ... psql` background jobs =
  two real Postgres backends) racing on the SAME
  (business_id, idempotency_key) unique index of quick_purchase_requests:

    - Job 1 opens a transaction, calls the RPC with key K, and SLEEPS a few
      seconds WITHOUT committing (sleep added AFTER the RPC call inside the same
      transaction to keep the row locked/uncommitted).
    - Job 2 starts ~1s later with the SAME key K. Its own INSERT into
      quick_purchase_requests must BLOCK until Job 1 commits, and only then:
        * same payload    -> replay of Job 1's purchase_id (never a 2nd compra)
        * different payload-> IDEMPOTENCY_CONFLICT (no exito, no 2nd compra)

  Requires: `supabase start` (or `db reset`) already run, with migrations
  20260704101000_quick_inventory_purchase.sql and
  20260704140000_quick_purchase_idempotency_hash.sql applied.

  USAGE:
    pwsh supabase/tests/run-quick-purchase-concurrency-test.ps1
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
  Write-Host "Could not connect to the local Postgres container ($Container). Did you run 'supabase start'?" -ForegroundColor Red
  Write-Host $ping
  exit 1
}

# ── Fixtures ────────────────────────────────────────────────────────────
$biz   = "00000000-0000-0000-0000-0000000f2a01"
$owner = "00000000-0000-0000-0000-0000000f2a09"
$prod  = "00000000-0000-0000-0000-0000000f2d01"
$sup   = "00000000-0000-0000-0000-0000000f2501"

$setupSql = @"
SET session_replication_role = 'replica';
DELETE FROM inventory_movements WHERE business_id = '$biz';
DELETE FROM supplier_account_movements WHERE business_id = '$biz';
DELETE FROM supplier_payments WHERE business_id = '$biz';
DELETE FROM supplier_purchase_items WHERE business_id = '$biz';
DELETE FROM supplier_purchases WHERE business_id = '$biz';
DELETE FROM financial_movements WHERE business_id = '$biz';
DELETE FROM business_finance_entries WHERE business_id = '$biz';
DELETE FROM quick_purchase_requests WHERE business_id = '$biz';
DELETE FROM inventory WHERE business_id = '$biz';
DELETE FROM suppliers WHERE business_id = '$biz';
DELETE FROM profiles WHERE business_id = '$biz';
DELETE FROM businesses WHERE id = '$biz';
DELETE FROM auth.users WHERE id = '$owner';

INSERT INTO auth.users(id) VALUES ('$owner');
INSERT INTO businesses(id, name, owner_user_id) VALUES ('$biz', 'Test Biz QP Concurrencia', '$owner');
INSERT INTO profiles(business_id, user_id, role, is_active) VALUES ('$biz', '$owner', 'owner', true);
INSERT INTO inventory(id, business_id, name, code, category, stock_quantity, stock, cost_price, sale_price, base_currency, is_active)
  VALUES ('$prod', '$biz', 'Prod QP Conc', 'QPC-001', 'Rep', 10, 10, 600, 1000, 'ARS', true);
INSERT INTO suppliers(id, business_id, name, active) VALUES ('$sup', '$biz', 'Prov QP Conc', true);
SET session_replication_role = 'origin';
"@
Invoke-PsqlSql $setupSql | Out-Null
Write-Host "Quick-purchase concurrency fixtures inserted (business $biz)." -ForegroundColor Cyan

function New-QuickPurchaseScript([string]$key, [int]$quantity, [int]$sleepSeconds) {
  $item = "jsonb_build_array(jsonb_build_object('inventory_id','$prod','product_name','Prod QP Conc','quantity',$quantity,'unit_cost_ars',1000))"
  $total = $quantity * 1000
  return @"
BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '$owner';
SELECT create_quick_inventory_purchase_atomic('$biz'::uuid, '$key', '$sup'::uuid, 'Prov QP Conc', 'FC-CONC', '2026-06-20', 'efectivo', $total, $total, $item)::text;
SELECT pg_sleep($sleepSeconds);
COMMIT;
"@
}

# ════════════════════════════════════════════════════════════════════════
# T1: same key + SAME payload → one creates, the other replays (never 2 compras)
# ════════════════════════════════════════════════════════════════════════
Write-Host "`n== T1: two concurrent connections, SAME key + SAME payload ==" -ForegroundColor Cyan
$job1 = Start-Job -ScriptBlock {
  param($sql, $container)
  $out = $sql | docker exec -i $container psql -U postgres -d postgres -X -q -t -A -v ON_ERROR_STOP=1 2>&1
  return ($out -join "`n")
} -ArgumentList (New-QuickPurchaseScript "qpc-same" 5 4), $Container

Start-Sleep -Milliseconds 900
$job2 = Start-Job -ScriptBlock {
  param($sql, $container)
  $out = $sql | docker exec -i $container psql -U postgres -d postgres -X -q -t -A -v ON_ERROR_STOP=1 2>&1
  return ($out -join "`n")
} -ArgumentList (New-QuickPurchaseScript "qpc-same" 5 0), $Container

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
Write-Host "  conn1 raw: $out1"
Write-Host "  conn2 raw: $out2"

Assert-True ($r1.ok -eq $true -and $r1.replay -eq $false) "T1a connection 1 (first) -> created (replay=false)"
Assert-True ($r2.ok -eq $true -and $r2.replay -eq $true)  "T1b connection 2 (same payload) -> replay=true"
Assert-True ($r1.purchase_id -eq $r2.purchase_id)         "T1c both connections got the SAME purchase_id"
Assert-True ($blockedMs -gt 2000) "T1d connection 2 was BLOCKED ~${blockedMs}ms by conn 1's uncommitted tx (real unique-index lock, not a coordinated sleep)"

$countPur = (Invoke-PsqlSql "SELECT count(*) FROM supplier_purchases WHERE business_id='$biz';").Trim()
Assert-True ($countPur -eq "1") "T1e only ONE supplier_purchase after the race (not two)"
$stock = (Invoke-PsqlSql "SELECT stock_quantity FROM inventory WHERE id='$prod';").Trim()
Assert-True ($stock -eq "15") "T1f stock rose exactly once (10 -> 15), no double stock from the race"
$countReq = (Invoke-PsqlSql "SELECT count(*) FROM quick_purchase_requests WHERE business_id='$biz' AND idempotency_key='qpc-same';").Trim()
Assert-True ($countReq -eq "1") "T1g only ONE request row for that key"

# ════════════════════════════════════════════════════════════════════════
# T2: same key + DIFFERENT payload → one creates, the other CONFLICTS (never 2 compras)
# ════════════════════════════════════════════════════════════════════════
Write-Host "`n== T2: two concurrent connections, SAME key + DIFFERENT payload ==" -ForegroundColor Cyan
$job3 = Start-Job -ScriptBlock {
  param($sql, $container)
  $out = $sql | docker exec -i $container psql -U postgres -d postgres -X -q -t -A -v ON_ERROR_STOP=1 2>&1
  return ($out -join "`n")
} -ArgumentList (New-QuickPurchaseScript "qpc-diff" 3 4), $Container

Start-Sleep -Milliseconds 900
$job4 = Start-Job -ScriptBlock {
  param($sql, $container)
  $out = $sql | docker exec -i $container psql -U postgres -d postgres -X -q -t -A -v ON_ERROR_STOP=1 2>&1
  return ($out -join "`n")
} -ArgumentList (New-QuickPurchaseScript "qpc-diff" 9 0), $Container

$beforeConn4 = Get-Date
Wait-Job $job4 | Out-Null
$conn4Done = Get-Date
$out4 = Receive-Job $job4
Wait-Job $job3 | Out-Null
$out3 = Receive-Job $job3
Remove-Job $job3, $job4 -Force

$r3 = Get-FirstJsonLine $out3 | ConvertFrom-Json
$r4 = Get-FirstJsonLine $out4 | ConvertFrom-Json
$blocked2Ms = ($conn4Done - $beforeConn4).TotalMilliseconds
Write-Host "  conn3 raw: $out3"
Write-Host "  conn4 raw: $out4"

Assert-True ($r3.ok -eq $true -and $r3.replay -eq $false) "T2a connection 3 (first) -> created"
Assert-True ($r4.ok -ne $true -and $r4.error -eq "IDEMPOTENCY_CONFLICT") "T2b connection 4 (different payload) -> IDEMPOTENCY_CONFLICT (not success)"
Assert-True ([string]::IsNullOrEmpty($r4.purchase_id)) "T2c conflict connection did NOT receive a purchase_id"
Assert-True ($blocked2Ms -gt 2000) "T2d connection 4 was BLOCKED ~${blocked2Ms}ms by conn 3's uncommitted tx (real lock, then conflict)"

$countPur2 = (Invoke-PsqlSql "SELECT count(*) FROM supplier_purchases WHERE business_id='$biz' AND invoice_number='FC-CONC' AND total_amount=3000;").Trim()
Assert-True ($countPur2 -eq "1") "T2e exactly ONE compra from key qpc-diff (the conflicting one created nothing)"
$stock2 = (Invoke-PsqlSql "SELECT stock_quantity FROM inventory WHERE id='$prod';").Trim()
Assert-True ($stock2 -eq "18") "T2f stock rose only by conn 3's 3 units (15 -> 18); conflict added no stock"

# ── Teardown ────────────────────────────────────────────────────────────
$teardownSql = @"
DELETE FROM inventory_movements WHERE business_id = '$biz';
DELETE FROM supplier_account_movements WHERE business_id = '$biz';
DELETE FROM supplier_payments WHERE business_id = '$biz';
DELETE FROM supplier_purchase_items WHERE business_id = '$biz';
DELETE FROM supplier_purchases WHERE business_id = '$biz';
DELETE FROM financial_movements WHERE business_id = '$biz';
DELETE FROM business_finance_entries WHERE business_id = '$biz';
DELETE FROM quick_purchase_requests WHERE business_id = '$biz';
DELETE FROM inventory WHERE business_id = '$biz';
DELETE FROM suppliers WHERE business_id = '$biz';
DELETE FROM profiles WHERE business_id = '$biz';
DELETE FROM businesses WHERE id = '$biz';
DELETE FROM auth.users WHERE id = '$owner';
"@
Invoke-PsqlSql $teardownSql | Out-Null
Write-Host "`nQuick-purchase concurrency fixtures cleaned up." -ForegroundColor Cyan

Write-Host "`n===================================================" -ForegroundColor Cyan
Write-Host "RESULT: $($passes.Count) PASS, $($failures.Count) FAIL" -ForegroundColor Cyan
if ($failures.Count -gt 0) {
  Write-Host "Failures:" -ForegroundColor Red
  $failures | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
  exit 1
}
exit 0
