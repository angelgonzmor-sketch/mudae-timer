# Despliega mudae-timer en Deno Deploy como una app NUEVA (si la anterior quedo suspendida).
#
# Requiere una de estas dos formas de autenticacion:
#   - token:  $env:DENO_DEPLOY_TOKEN = "ddo_..."  (create en https://console.deno.com/account/access-tokens)
#   - login interactivo con keychain del sistema funcionando (en Windows suele fallar)
#
# Se usa el plugin CLI directo (jsr:@deno/deploy) porque el subcomando integrado
# "deno deploy" de Deno 2.9.x duplica el primer flag:
#   Option "--prod" can only occur once, but was found several times
#
# Uso:
#   .\deploy.ps1                                    # app "mudae-timer" desde GitHub
#   .\deploy.ps1 -App mudae-timer -Source local     # sube la carpeta local
#   .\deploy.ps1 -DryRun                            # valida flags sin crear nada
#
# El valor devuelto por "create" con --json incluye la URL. La base KV "mudae-kv"
# se provisiona y se asigna a la app (si ya existe, provision no hace dano).
# El cron (mudae-scan) se activa/confirma en la consola: app > Cron.
param(
  [string]$App = "mudae-timer",
  [string]$Org = "angelgonzmor-sketch",
  [ValidateSet("github", "local")]
  [string]$Source = "github",
  [string]$Owner = "angelgonzmor-sketch",
  [string]$Repo = "mudae-timer",
  [string]$Db = "mudae-kv",
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$deno = "C:\Users\Angel G\.deno\bin\deno.exe"

if (-not $env:DENO_DEPLOY_TOKEN) {
  Write-Warning "No hay DENO_DEPLOY_TOKEN. Ponlo con: `$env:DENO_DEPLOY_TOKEN = 'ddo_xxx'"
  Write-Warning "antes de ejecutar, o haz 'deno login' con keychain del sistema."
}

function Invoke-Deploy($sub, $fl) {
  $out = & $deno run --allow-all jsr:@deno/deploy $sub --json --non-interactive @fl 2>&1
  if ($LASTEXITCODE -ne 0) { Write-Host $out; exit $LASTEXITCODE }
  Write-Host $out
  return $out
}

$createFlags = @("--org", $Org, "--app", $App)
if ($DryRun) { $createFlags += "--dry-run" }
if ($Source -eq "github") {
  $createFlags += @("--source", "github", "--owner", $Owner, "--repo", $Repo)
} else {
  $createFlags += @("--source", "local", "--runtime-mode", "dynamic", "--entrypoint", "src/main.ts", "--region", "global")
}

Write-Host "==> create: app '$App' (fuente: $Source)"
Invoke-Deploy "create" $createFlags
if ($DryRun) { exit 0 }

Write-Host "==> database provision: '$Db' (ignora si ya existe)"
& $deno run --allow-all jsr:@deno/deploy database provision $Db --json --non-interactive --org $Org 2>$null | Out-Null

Write-Host "==> database assign: '$Db' -> app '$App'"
Invoke-Deploy "database" @("assign", $Db, "--app", $App, "--org", $Org)

Write-Host ""
Write-Host "Listo. URL: https://$App.$Org.deno.net"
Write-Host "Siguiente (manual, en consola de la app):"
Write-Host "  1. Confirmar el cron 'mudae-scan' en la pestana Cron."
Write-Host "  2. Comprobar el panel de uso si la app anterior se suspendio por limites."