param([ValidateSet('local', 'remote')][string]$Mode = 'local')
$ErrorActionPreference = 'Stop'
$desktopDir = $PSScriptRoot
$projectDir = Join-Path (Split-Path -Parent $desktopDir) 'site'
$launchLog = Join-Path $env:TEMP 'maiko-desktop-launch.log'
try {
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        throw 'Для запуска из исходников установите Node.js 22 или новее. Установленная через Maiko-Setup версия работает без Node.js.'
    }
    if (-not (Test-Path -LiteralPath (Join-Path $desktopDir 'node_modules/electron/package.json'))) {
        & npm.cmd ci --prefix $desktopDir --no-audit --no-fund *> $launchLog
        if ($LASTEXITCODE -ne 0) { throw "Не удалось установить Electron. Журнал: $launchLog" }
    }
    if (-not (Test-Path -LiteralPath (Join-Path $desktopDir 'node_modules/electron/dist/electron.exe'))) {
        & node (Join-Path $desktopDir 'node_modules/electron/install.js') *> $launchLog
        if ($LASTEXITCODE -ne 0) { throw "Не удалось скачать Electron. Журнал: $launchLog" }
    }
    if (-not (Test-Path -LiteralPath (Join-Path $projectDir 'node_modules/tsx/dist/cjs/index.cjs'))) {
        & npm.cmd ci --prefix $projectDir --no-audit --no-fund *> $launchLog
        if ($LASTEXITCODE -ne 0) { throw "Не удалось установить зависимости сайта. Журнал: $launchLog" }
    }
    & node (Join-Path $projectDir 'scripts/prepare-dtln.mjs') *> $launchLog
    if ($LASTEXITCODE -ne 0) { throw "Не удалось подготовить звук. Журнал: $launchLog" }
    & node (Join-Path $desktopDir 'prepare-native.cjs') *> $launchLog
    if ($LASTEXITCODE -ne 0) { throw "Не удалось подготовить захват звука приложения. Журнал: $launchLog" }
    & node (Join-Path $desktopDir 'prepare-assets.cjs') *> $launchLog
    if ($LASTEXITCODE -ne 0) { throw "Не удалось подготовить ресурсы приложения. Журнал: $launchLog" }
    $electronExe = Join-Path $desktopDir 'node_modules/electron/dist/electron.exe'
    $launchArgs = @(('"{0}"' -f $desktopDir))
    if ($Mode -eq 'local') { $launchArgs += '--local' }
    Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
    Start-Process -FilePath $electronExe -ArgumentList $launchArgs -WorkingDirectory $projectDir -WindowStyle Hidden
} catch {
    Add-Type -AssemblyName System.Windows.Forms
    [void][System.Windows.Forms.MessageBox]::Show($_.Exception.Message, 'Майко', 'OK', 'Error')
    exit 1
}
