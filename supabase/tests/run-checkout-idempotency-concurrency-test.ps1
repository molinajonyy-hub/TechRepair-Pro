<#
  Real concurrency test for create_comprobante_checkout_atomic (T1 from the
  checkout idempotency audit, 2026-07-01).

  comprobante_checkout_idempotency_test.sql runs everything in a single
  transaction/session - it cannot demonstrate real mutual exclusion between
  concurrent connections. This script uses TWO independent connections (two
  separate `docker exec ... psql` processes, launched as PowerShell
  background jobs = two real Postgres backends) and relies on REAL Postgres
  blocking behavior when two transactions race on the SAME
  (business_id, idempotency_key) unique index:
    - Job 1 opens a transaction, calls the RPC with key K, SLEEPS a few
      seconds without committing (the RPC itself does all its work and
      returns before the outer psql script's own extra sleep/commit, so the
      sleep is added AFTER the RPC call inside the same transaction to keep
      it open).
    - Job 2 starts ~1s later and calls the RPC with the SAME key K: if the
      unique index on comprobante_checkout_requests(business_id,
      idempotency_key) really protects it, Job 2's own INSERT attempt must
      BLOCK until Job 1 commits, and only then see the row as 'completed'
      and return 'existing' with the SAME comprobante_id - never create a
      second comprobante.

  Requires: `supabase start` (or `db reset`) already run, with migration
  20260701170000_comprobante_checkout_idempotency.sql applied.

  USAGE:
    pwsh supabase/tests/run-checkout-idempotency-concurrency-test.ps1
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
$biz = "00000000-0000-0000-0000-0000000f0a01"
$owner = "00000000-0000-0000-0000-0000000f0a09"

$setupSql = @"
SET session_replication_role = 'replica';
DELETE FROM comprobante_checkout_requests WHERE business_id = '$biz';
DELETE FROM comprobantes WHERE business_id = '$biz';
DELETE FROM comprobante_number_sequences WHERE business_id = '$biz';
DELETE FROM profiles WHERE business_id = '$biz';
DELETE FROM businesses WHERE id = '$biz';
DELETE FROM auth.users WHERE id = '$owner';

INSERT INTO auth.users(id) VALUES ('$owner');
INSERT INTO businesses(id, name) VALUES ('$biz', 'Test Biz Checkout Concurrencia');
INSERT INTO profiles(business_id, user_id, role, is_active) VALUES ('$biz', '$owner', 'owner', true);
SET session_replication_role = 'origin';
"@
Invoke-PsqlSql $setupSql | Out-Null
Write-Host "Checkout concurrency fixtures inserted (business $biz)." -ForegroundColor Cyan

$payload = '{"tipo":"factura_c","punto_venta":"0001","condicion_fiscal":"Consumidor Final","customer_id":null,"es_fiscal":true,"emitir_en_arca":false,"skip_finance_entry":false,"cc_total":0,"items":[{"descripcion":"Servicio concurrencia","tipo_linea":"servicio","cantidad":1,"precio_unitario":100,"currency":"ARS","exchange_rate":1}],"pagos":[{"payment_method":"efectivo","amount":100,"currency":"ARS","amount_ars":100,"exchange_rate":1}]}'

function New-CheckoutScript([string]$key, [int]$sleepSeconds) {
  # Mismo hash SIEMPRE para el mismo key: representa el MISMO intento
  # comercial reintentado (no un payload distinto), igual que el cliente
  # real (mismo carrito -> mismo computeCheckoutRequestHash en cada retry).
  return @"
BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '$owner';
SELECT create_comprobante_checkout_atomic('$biz'::uuid, '$key', 'hash-conc-shared', '$payload'::jsonb)::text;
SELECT pg_sleep($sleepSeconds);
COMMIT;
"@
}

# ════════════════════════════════════════════════════════════════════════
# T1: two connections calling the SAME idempotency key at the same time.
# ════════════════════════════════════════════════════════════════════════
Write-Host "`n== T1: two concurrent connections, SAME idempotency_key ==" -ForegroundColor Cyan
$job1 = Start-Job -ScriptBlock {
  param($sql, $container)
  $out = $sql | docker exec -i $container psql -U postgres -d postgres -X -q -t -A -v ON_ERROR_STOP=1 2>&1
  return ($out -join "`n")
} -ArgumentList (New-CheckoutScript "conc-key-1" 4), $Container

Start-Sleep -Milliseconds 900
$job2 = Start-Job -ScriptBlock {
  param($sql, $container)
  $out = $sql | docker exec -i $container psql -U postgres -d postgres -X -q -t -A -v ON_ERROR_STOP=1 2>&1
  return ($out -join "`n")
} -ArgumentList (New-CheckoutScript "conc-key-1" 0), $Container

$beforeConn2Result = Get-Date
Wait-Job $job2 | Out-Null
$conn2Done = Get-Date
$out2 = Receive-Job $job2
Wait-Job $job1 | Out-Null
$out1 = Receive-Job $job1
Remove-Job $job1, $job2 -Force

$r1 = Get-FirstJsonLine $out1 | ConvertFrom-Json
$r2 = Get-FirstJsonLine $out2 | ConvertFrom-Json
$blockedMs = ($conn2Done - $beforeConn2Result).TotalMilliseconds

Write-Host "  conn1 raw: $out1"
Write-Host "  conn2 raw: $out2"

Assert-True ($r1.status -eq "created") "T1a connection 1 (started first) -> created"
Assert-True ($r2.status -eq "existing") "T1b connection 2 (concurrent, same idempotency_key) -> existing (never a second comprobante)"
Assert-True ($r1.comprobante_id -eq $r2.comprobante_id) "T1c both connections got the SAME comprobante_id"
Assert-True ($blockedMs -gt 2000) "T1d connection 2 was BLOCKED by connection 1's uncommitted transaction (real Postgres block of ~${blockedMs}ms on the unique index, not a coordinated sleep or in-memory guard)"

$countComp = (Invoke-PsqlSql "SELECT count(*) FROM comprobantes WHERE business_id='$biz';").Trim()
Assert-True ($countComp -eq "1") "T1e only ONE comprobante exists after the real race (not two)"
$countReq = (Invoke-PsqlSql "SELECT count(*) FROM comprobante_checkout_requests WHERE business_id='$biz' AND idempotency_key='conc-key-1';").Trim()
Assert-True ($countReq -eq "1") "T1f only ONE checkout request row for that key (not duplicated)"
$countPayments = (Invoke-PsqlSql "SELECT count(*) FROM comprobante_payments WHERE business_id='$biz';").Trim()
Assert-True ($countPayments -eq "1") "T1g only ONE payment row (no duplicate cobro from the race)"

# ── Teardown ────────────────────────────────────────────────────────────
$teardownSql = @"
DELETE FROM comprobante_checkout_requests WHERE business_id = '$biz';
DELETE FROM comprobante_payments WHERE business_id = '$biz';
DELETE FROM comprobantes WHERE business_id = '$biz';
DELETE FROM comprobante_number_sequences WHERE business_id = '$biz';
DELETE FROM profiles WHERE business_id = '$biz';
DELETE FROM businesses WHERE id = '$biz';
DELETE FROM auth.users WHERE id = '$owner';
"@
Invoke-PsqlSql $teardownSql | Out-Null
Write-Host "`nCheckout concurrency fixtures cleaned up." -ForegroundColor Cyan

Write-Host "`n===================================================" -ForegroundColor Cyan
Write-Host "RESULT: $($passes.Count) PASS, $($failures.Count) FAIL" -ForegroundColor Cyan
if ($failures.Count -gt 0) {
  Write-Host "Failures:" -ForegroundColor Red
  $failures | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }
  exit 1
}
exit 0
