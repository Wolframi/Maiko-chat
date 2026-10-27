$ErrorActionPreference = 'Stop'
$projectDirectory = Split-Path $PSScriptRoot -Parent
$sourcePath = Join-Path $PSScriptRoot 'Test-MaikoNetwork.ps1'
$destinationPath = Join-Path $projectDirectory 'Диагностика сети Майко.cmd'
$launcher = @'
@echo off
setlocal
chcp 65001 >nul
set "MAIKO_DIAGNOSTICS_FILE=%~f0"
echo Проверяем доступ к Майко. Дождитесь завершения проверки.
powershell.exe -NoProfile -ExecutionPolicy Bypass -Command "try { $lines = Get-Content -LiteralPath $env:MAIKO_DIAGNOSTICS_FILE -Encoding UTF8; $marker = [Array]::IndexOf($lines, '# MAIKO_POWERSHELL_BEGIN'); if ($marker -lt 0) { throw 'Embedded diagnostic script is missing' }; $script = [ScriptBlock]::Create(($lines[($marker + 1)..($lines.Length - 1)] -join [Environment]::NewLine)); $reportPath = Join-Path ([IO.Path]::GetDirectoryName($env:MAIKO_DIAGNOSTICS_FILE)) 'Maiko-network-report.txt'; & $script -OutputPath $reportPath } catch { Write-Host $_; exit 1 }"
set "MAIKO_DIAGNOSTICS_EXIT=%errorlevel%"
if defined MAIKO_DIAGNOSTICS_NO_PAUSE goto maiko_done
echo.
pause
:maiko_done
exit /b %MAIKO_DIAGNOSTICS_EXIT%
# MAIKO_POWERSHELL_BEGIN
'@
$source = [IO.File]::ReadAllText($sourcePath, [Text.Encoding]::UTF8)
$content = ($launcher.TrimEnd() + "`n" + $source).Replace("`r`n", "`n").Replace("`n", "`r`n")
[IO.File]::WriteAllText($destinationPath, $content, (New-Object Text.UTF8Encoding($false)))
Write-Host ('Created self-contained diagnostic: ' + $destinationPath)
