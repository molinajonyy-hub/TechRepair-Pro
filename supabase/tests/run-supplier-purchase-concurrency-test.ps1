<#
  Real concurrency test for create_supplier_purchase_atomic idempotency
  (the ACTIVE purchase flow of NewExpenseModal). Two independent connections race
  on the SAME (business_id, idempotency_key) unique index of
  supplier_purchase_requests:
    - same key + same payload    -> one creates, the other replays (never 2 compras)
    - same key + different payload-> one creates, the other IDEMPOTENCY_CONFLICT

  Requires: supabase start / db reset with migration
  20260705100000_supplier_purchase_idempotency.sql applied.
  USAGE: (dot-source or run with powershell.exe)
#>
param([string]$Container = "supabase_db_techrepair-vite")
$ErrorActionPreference = "Stop"
$failures = @(); $passes = @()
function Assert-True($cond, $label) {
  if ($cond) { $script:passes += $label; Write-Host "PASS: $label" -ForegroundColor Green }
  else { $script:failures += $label; Write-Host "FAIL: $label" -ForegroundColor Red }
}
function Invoke-PsqlSql([string]$sql) { ($sql | docker exec -i $Container psql -U postgres -d postgres -X -q -t -A -v ON_ERROR_STOP=1 2>&1) -join "`n" }
function Get-FirstJsonLine([string]$o) { foreach ($l in ($o -split "`n")) { if ($l.Trim().StartsWith("{")) { return $l.Trim() } } return $null }

$biz="00000000-0000-0000-0000-0000000fb101"; $owner="00000000-0000-0000-0000-0000000fb109"
$prod="00000000-0000-0000-0000-0000000fbd01"; $sup="00000000-0000-0000-0000-0000000fb501"

$setup=@"
SET session_replication_role='replica';
DELETE FROM inventory_movements WHERE business_id='$biz';
DELETE FROM supplier_account_movements WHERE business_id='$biz';
DELETE FROM supplier_payments WHERE business_id='$biz';
DELETE FROM supplier_purchase_items WHERE business_id='$biz';
DELETE FROM supplier_purchases WHERE business_id='$biz';
DELETE FROM financial_movements WHERE business_id='$biz';
DELETE FROM business_finance_entries WHERE business_id='$biz';
DELETE FROM supplier_purchase_requests WHERE business_id='$biz';
DELETE FROM inventory WHERE business_id='$biz';
DELETE FROM suppliers WHERE business_id='$biz';
DELETE FROM profiles WHERE business_id='$biz';
DELETE FROM businesses WHERE id='$biz';
DELETE FROM auth.users WHERE id='$owner';
INSERT INTO auth.users(id) VALUES ('$owner');
INSERT INTO businesses(id,name,owner_user_id) VALUES ('$biz','SP Conc','$owner');
INSERT INTO profiles(business_id,user_id,role,is_active) VALUES ('$biz','$owner','owner',true);
INSERT INTO inventory(id,business_id,name,code,category,stock_quantity,stock,cost_price,sale_price,base_currency,is_active) VALUES ('$prod','$biz','P SP','SPC-1','R',10,10,600,1000,'ARS',true);
INSERT INTO suppliers(id,business_id,name,active) VALUES ('$sup','$biz','Prov SP',true);
SET session_replication_role='origin';
"@
Invoke-PsqlSql $setup | Out-Null
Write-Host "Supplier-purchase concurrency fixtures inserted." -ForegroundColor Cyan

function New-Script([string]$key,[int]$qty,[int]$sleep) {
  $item="jsonb_build_array(jsonb_build_object('inventory_id','$prod','product_name','P SP','quantity',$qty,'unit_cost',1000))"
  $total=$qty*1000
  return @"
BEGIN;
SET LOCAL ROLE authenticated;
SET LOCAL "request.jwt.claim.sub" = '$owner';
SELECT create_supplier_purchase_atomic('$biz'::uuid,'$sup'::uuid,'$owner'::uuid,'Prov SP','2026-06-20','FC-C',$total,$total,'efectivo',NULL,$item,'$key')::text;
SELECT pg_sleep($sleep);
COMMIT;
"@
}

Write-Host "`n== T1: same key + SAME payload ==" -ForegroundColor Cyan
$j1=Start-Job -ScriptBlock { param($s,$c) ($s | docker exec -i $c psql -U postgres -d postgres -X -q -t -A -v ON_ERROR_STOP=1 2>&1) -join "`n" } -ArgumentList (New-Script "spc-same" 5 4), $Container
Start-Sleep -Milliseconds 900
$j2=Start-Job -ScriptBlock { param($s,$c) ($s | docker exec -i $c psql -U postgres -d postgres -X -q -t -A -v ON_ERROR_STOP=1 2>&1) -join "`n" } -ArgumentList (New-Script "spc-same" 5 0), $Container
$t0=Get-Date; Wait-Job $j2|Out-Null; $t1=Get-Date; $o2=Receive-Job $j2; Wait-Job $j1|Out-Null; $o1=Receive-Job $j1; Remove-Job $j1,$j2 -Force
$r1=Get-FirstJsonLine $o1|ConvertFrom-Json; $r2=Get-FirstJsonLine $o2|ConvertFrom-Json; $blk=($t1-$t0).TotalMilliseconds
Write-Host "  c1: $o1"; Write-Host "  c2: $o2"
Assert-True ($r1.ok -eq $true -and $r1.replay -eq $false) "T1a conn1 -> created"
Assert-True ($r2.ok -eq $true -and $r2.replay -eq $true)  "T1b conn2 same payload -> replay"
Assert-True ($r1.purchase_id -eq $r2.purchase_id)         "T1c same purchase_id"
Assert-True ($blk -gt 2000) "T1d conn2 blocked ~${blk}ms on the unique index (real lock)"
Assert-True ((Invoke-PsqlSql "SELECT count(*) FROM supplier_purchases WHERE business_id='$biz';").Trim() -eq "1") "T1e only ONE compra"
Assert-True ((Invoke-PsqlSql "SELECT stock_quantity FROM inventory WHERE id='$prod';").Trim() -eq "15") "T1f stock rose once (10->15)"

Write-Host "`n== T2: same key + DIFFERENT payload ==" -ForegroundColor Cyan
$j3=Start-Job -ScriptBlock { param($s,$c) ($s | docker exec -i $c psql -U postgres -d postgres -X -q -t -A -v ON_ERROR_STOP=1 2>&1) -join "`n" } -ArgumentList (New-Script "spc-diff" 3 4), $Container
Start-Sleep -Milliseconds 900
$j4=Start-Job -ScriptBlock { param($s,$c) ($s | docker exec -i $c psql -U postgres -d postgres -X -q -t -A -v ON_ERROR_STOP=1 2>&1) -join "`n" } -ArgumentList (New-Script "spc-diff" 9 0), $Container
$t2=Get-Date; Wait-Job $j4|Out-Null; $t3=Get-Date; $o4=Receive-Job $j4; Wait-Job $j3|Out-Null; $o3=Receive-Job $j3; Remove-Job $j3,$j4 -Force
$r3=Get-FirstJsonLine $o3|ConvertFrom-Json; $r4=Get-FirstJsonLine $o4|ConvertFrom-Json; $blk2=($t3-$t2).TotalMilliseconds
Write-Host "  c3: $o3"; Write-Host "  c4: $o4"
Assert-True ($r3.ok -eq $true -and $r3.replay -eq $false) "T2a conn3 -> created"
Assert-True ($r4.ok -ne $true -and $r4.error -eq "IDEMPOTENCY_CONFLICT") "T2b conn4 different payload -> IDEMPOTENCY_CONFLICT"
Assert-True ([string]::IsNullOrEmpty($r4.purchase_id)) "T2c conflict returned no purchase_id"
Assert-True ($blk2 -gt 2000) "T2d conn4 blocked ~${blk2}ms (real lock, then conflict)"
Assert-True ((Invoke-PsqlSql "SELECT count(*) FROM supplier_purchases WHERE business_id='$biz' AND total_amount=3000;").Trim() -eq "1") "T2e exactly ONE compra from spc-diff"

$teardown=@"
SET session_replication_role='replica';
DELETE FROM inventory_movements WHERE business_id='$biz';
DELETE FROM supplier_account_movements WHERE business_id='$biz';
DELETE FROM supplier_payments WHERE business_id='$biz';
DELETE FROM supplier_purchase_items WHERE business_id='$biz';
DELETE FROM supplier_purchases WHERE business_id='$biz';
DELETE FROM financial_movements WHERE business_id='$biz';
DELETE FROM business_finance_entries WHERE business_id='$biz';
DELETE FROM supplier_purchase_requests WHERE business_id='$biz';
DELETE FROM inventory WHERE business_id='$biz';
DELETE FROM suppliers WHERE business_id='$biz';
DELETE FROM profiles WHERE business_id='$biz';
DELETE FROM businesses WHERE id='$biz';
DELETE FROM auth.users WHERE id='$owner';
SET session_replication_role='origin';
"@
Invoke-PsqlSql $teardown | Out-Null
Write-Host "`nRESULT: $($passes.Count) PASS, $($failures.Count) FAIL" -ForegroundColor Cyan
if ($failures.Count -gt 0) { $failures | ForEach-Object { Write-Host "  - $_" -ForegroundColor Red }; exit 1 }
exit 0
