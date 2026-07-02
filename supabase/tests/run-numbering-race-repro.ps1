<#
  REPRODUCTION script (auditoría numeración local, 2026-07-01) — demuestra la
  carrera en generar_numero_comprobante ANTES del fix, usando dos conexiones
  PostgreSQL REALES (no dos sentencias secuenciales en una sesión).

  generar_numero_comprobante() es una función de SOLO LECTURA: hace
  SELECT MAX(...)  y devuelve MAX+1, pero NO inserta ni bloquea nada por sí
  misma. Como no hay ninguna fila que una segunda conexión pueda esperar,
  dos conexiones concurrentes que llaman a esta función para la MISMA serie
  (business_id + tipo) pueden computar EXACTAMENTE el mismo "próximo número"
  sin bloquearse entre sí — el bug se demuestra por la AUSENCIA de bloqueo
  (ambas conexiones responden casi instantáneamente con el mismo valor),
  a diferencia de los locks atómicos (ARCA, checkout) donde la segunda
  conexión SÍ se bloquea.

  Este script se corre UNA VEZ, contra el estado de la migración ANTES del
  fix de Fase 2, para dejar registrada la reproducción exigida por Fase 1.
  Después de aplicar el contador atómico, correr
  run-numbering-concurrency-test.ps1 (N1-N8) en su lugar.

  USO:
    pwsh supabase/tests/run-numbering-race-repro.ps1
#>
param(
  [string]$Container = "supabase_db_techrepair-vite"
)

$ErrorActionPreference = "Stop"

function Invoke-PsqlSql([string]$sql) {
  $out = $sql | docker exec -i $Container psql -U postgres -d postgres -X -q -t -A -v ON_ERROR_STOP=1 2>&1
  return ($out -join "`n")
}

Write-Host "== Checking connection to local Supabase stack ($Container) ==" -ForegroundColor Cyan
$ping = docker exec $Container psql -U postgres -d postgres -t -A -c "SELECT 1;" 2>&1
if ($LASTEXITCODE -ne 0 -or ($ping -join "").Trim() -ne "1") {
  Write-Host "Could not connect to the local Postgres container ($Container)." -ForegroundColor Red
  exit 1
}

$biz = "00000000-0000-0000-0000-0000000a0b01"
$setupSql = @"
SET session_replication_role = 'replica';
DELETE FROM comprobantes WHERE business_id = '$biz';
DELETE FROM businesses WHERE id = '$biz';
INSERT INTO businesses(id, name) VALUES ('$biz', 'Test Biz Numbering Repro');
SET session_replication_role = 'origin';
"@
Invoke-PsqlSql $setupSql | Out-Null
Write-Host "Fixtures inserted (business $biz, NO comprobantes yet -> both connections will compute number 1)." -ForegroundColor Cyan

$scriptTemplate = @"
SELECT clock_timestamp()::text AS t_start;
SELECT generar_numero_comprobante('factura_c', '$biz'::uuid, '0001')::text AS numero;
SELECT clock_timestamp()::text AS t_end;
"@

Write-Host "`n== Launching TWO independent connections concurrently (Start-Job = separate OS processes) ==" -ForegroundColor Cyan
$job1 = Start-Job -ScriptBlock {
  param($sql, $container)
  $out = $sql | docker exec -i $container psql -U postgres -d postgres -X -q -t -A 2>&1
  return ($out -join "`n")
} -ArgumentList $scriptTemplate, $Container

$job2 = Start-Job -ScriptBlock {
  param($sql, $container)
  $out = $sql | docker exec -i $container psql -U postgres -d postgres -X -q -t -A 2>&1
  return ($out -join "`n")
} -ArgumentList $scriptTemplate, $Container

Wait-Job $job1, $job2 | Out-Null
$out1 = Receive-Job $job1
$out2 = Receive-Job $job2
Remove-Job $job1, $job2 -Force

Write-Host "`nConnection 1 output:`n$out1" -ForegroundColor Yellow
Write-Host "`nConnection 2 output:`n$out2" -ForegroundColor Yellow

$lines1 = $out1 -split "`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne "" }
$lines2 = $out2 -split "`n" | ForEach-Object { $_.Trim() } | Where-Object { $_ -ne "" }
$numero1 = $lines1[1]
$numero2 = $lines2[1]

Write-Host "`n===================================================" -ForegroundColor Cyan
if ($numero1 -eq $numero2) {
  Write-Host "REPRODUCED: ambas conexiones calcularon el MISMO numero ('$numero1') para la misma serie." -ForegroundColor Red
  Write-Host "Esto confirma la carrera: generar_numero_comprobante() no tiene ninguna exclusion atomica -" -ForegroundColor Red
  Write-Host "dos ventas legitimas y concurrentes de la misma serie recibirian el mismo numero local." -ForegroundColor Red
} else {
  Write-Host "NO reproducido en esta corrida (numero1=$numero1, numero2=$numero2) - la ausencia de carga/timing puede ocultar la ventana." -ForegroundColor Yellow
  Write-Host "Esto NO significa que el bug no exista: la funcion sigue sin ningun mecanismo de exclusion." -ForegroundColor Yellow
}

# ── Teardown ────────────────────────────────────────────────────────────
$teardownSql = @"
DELETE FROM comprobantes WHERE business_id = '$biz';
DELETE FROM businesses WHERE id = '$biz';
"@
Invoke-PsqlSql $teardownSql | Out-Null
Write-Host "`nFixtures cleaned up." -ForegroundColor Cyan
