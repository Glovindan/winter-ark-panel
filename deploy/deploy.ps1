# Сборка и заливка на сервер. Запускать на своём компьютере из любой папки.
#   Первый раз:  .\deploy\deploy.ps1 -Server 1.2.3.4 -Setup -Domain 1-2-3-4.sslip.io
#   Обновление:  .\deploy\deploy.ps1 -Server 1.2.3.4
param(
  [Parameter(Mandatory)][string]$Server,
  [string]$User = 'root',
  [string]$Key,
  [switch]$Setup,
  [string]$Domain
)
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot
Set-Location $root

$ssh = @('-o', 'StrictHostKeyChecking=accept-new')
if ($Key) { $ssh += @('-i', $Key) }
$target = "$User@$Server"

function Run($label, [scriptblock]$cmd) {
  Write-Host "==> $label" -ForegroundColor Cyan
  # Windows PowerShell 5.1 превращает любой вывод native-команды в stderr (apt, npm) в ошибку, поэтому смотрим только на код возврата
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  & $cmd
  $code = $LASTEXITCODE
  $ErrorActionPreference = $prev
  if ($code -ne 0) { throw "Шаг не удался: $label (код $code)" }
}

if ($Setup) {
  if (-not $Domain) { throw 'Для -Setup укажи -Domain, например 1-2-3-4.sslip.io (IP с дефисами)' }
  Run 'Заливаю скрипты сервера' {
    scp @ssh "$PSScriptRoot\server\setup.sh" "$PSScriptRoot\server\update.sh" "$PSScriptRoot\server\ark-deploy.sh" "$PSScriptRoot\server\install-ci.sh" "${target}:/tmp/"
  }
  Run 'Настраиваю сервер (несколько минут)' { ssh @ssh $target "bash /tmp/setup.sh $Domain" }
  Run 'Включаю релизную схему и скрипты деплоя' { ssh @ssh $target 'cd /tmp && bash install-ci.sh' }
}

Run 'Проверка типов' { npm run typecheck }
Run 'Тесты' { npm test }
Run 'Сборка фронтенда' { npm run build -w @ark/web }

$tgz = Join-Path $env:TEMP 'ark-deploy.tgz'
Run 'Архив' {
  tar -czf $tgz package.json package-lock.json tsconfig.base.json `
    packages/shared/package.json packages/shared/tsconfig.json packages/shared/src `
    apps/server/package.json apps/server/tsconfig.json apps/server/src `
    apps/web/package.json apps/web/dist
}

Run 'Заливаю архив' { scp @ssh $tgz "${target}:/tmp/ark-deploy.tgz" }
Run 'Раскатываю на сервере' { ssh @ssh $target '/usr/local/bin/ark-deploy < /tmp/ark-deploy.tgz; rc=$?; rm -f /tmp/ark-deploy.tgz; exit $rc' }
Remove-Item $tgz -ErrorAction SilentlyContinue
Write-Host 'Готово.' -ForegroundColor Green
