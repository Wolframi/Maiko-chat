# Deploy the committed Maiko project to the VPS.
param(
  [string]$HostName = "179.254.175.134",
  [string]$User = "root",
  [string]$Key = "$env:USERPROFILE\.ssh\id_ed25519",
  [string]$AppDir = "maiko",
  [string]$PublicOrigin = "https://maiko.galacticvps.qzz.io"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$deployDir = Join-Path $root ".deploy"
$tarball = Join-Path $deployDir "pulse-chat.tgz"
$sshArgs = @("-i", $Key, "-o", "StrictHostKeyChecking=accept-new")
$remote = "${User}@${HostName}"

New-Item -ItemType Directory -Force -Path $deployDir | Out-Null
if (Test-Path $tarball) { Remove-Item $tarball -Force }

if ($AppDir -notmatch '^[a-zA-Z0-9_-]+$') { throw 'AppDir must be a directory name' }
if ($PublicOrigin -notmatch '^https://[a-zA-Z0-9.-]+(?::[0-9]+)?$') { throw 'PublicOrigin must be an HTTPS origin' }
Write-Host "Packing committed sources..."
git -C $root archive --format=tar.gz --output=$tarball HEAD
if ($LASTEXITCODE -ne 0) { throw 'git archive failed' }

Write-Host "Uploading..."
& scp @sshArgs $tarball "${remote}:~/pulse-chat.tgz"
if ($LASTEXITCODE -ne 0) { throw 'Upload failed' }

Write-Host "Building & restarting on server..."
# LF-only remote script — CRLF breaks `set -o pipefail` on Linux bash
$remoteScript = @(
  "set -euo pipefail",
  "mkdir -p ~/$AppDir",
  "tar -xzf ~/pulse-chat.tgz -C ~/$AppDir",
  "cd ~/$AppDir",
  "export PUBLIC_ORIGIN='$PublicOrigin' TURN_HOST='$(([Uri]$PublicOrigin).Host)'",
  "npm ci",
  "SEED_DEMO=0 NEXT_PUBLIC_DEMO=0 npm run build",
  "mkdir -p data uploads",
  "pm2 startOrReload ecosystem.config.cjs --update-env",
  "pm2 save",
  "sleep 5",
  "curl -fsS http://127.0.0.1:3000/api/health",
  "echo",
  "curl -fsS http://127.0.0.1:3000/api/health/livekit",
  "echo",
  "pm2 status pulse-chat"
) -join "`n"

$remoteScript | ssh @sshArgs $remote "bash -s"
if ($LASTEXITCODE -ne 0) {
  throw "Remote deploy failed with exit code $LASTEXITCODE"
}
Write-Host "Done: $PublicOrigin"
