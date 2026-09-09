# Deploy Pulse Chat to Yandex Cloud VPS
param(
  [string]$HostName = "193.233.247.171",
  [string]$User = "root",
  [string]$Key = "$env:USERPROFILE\.ssh\id_ed25519",
  [string]$AppDir = "pulse-chat",
  [string]$PublicOrigin = "https://193.233.247.171.sslip.io"
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$deployDir = Join-Path $root ".deploy"
$tarball = Join-Path $deployDir "pulse-chat.tgz"
$sshArgs = @("-i", $Key, "-o", "StrictHostKeyChecking=accept-new")
$remote = "${User}@${HostName}"

New-Item -ItemType Directory -Force -Path $deployDir | Out-Null
if (Test-Path $tarball) { Remove-Item $tarball -Force }

Write-Host "Packing..."
tar -czf $tarball `
  --exclude=node_modules `
  --exclude=.next `
  --exclude=data `
  --exclude=uploads `
  --exclude=.git `
  --exclude=.deploy `
  --exclude=tools/cloudflared.exe `
  --exclude=test-results `
  --exclude=playwright-report `
  --exclude=.cursor `
  --exclude=.serena `
  --exclude=.claude `
  --exclude=build-restart.log `
  --exclude=.livekit-url `
  --exclude=.livekit-api-key `
  --exclude=.livekit-api-secret `
  --exclude=.livekit-server.yaml `
  -C $root .

Write-Host "Uploading..."
& scp @sshArgs $tarball "${remote}:~/pulse-chat.tgz"

Write-Host "Building & restarting on server..."
# LF-only remote script — CRLF breaks `set -o pipefail` on Linux bash
$remoteScript = @(
  "set -euo pipefail",
  "mkdir -p ~/$AppDir",
  "tar -xzf ~/pulse-chat.tgz -C ~/$AppDir",
  "cd ~/$AppDir",
  "node -e `"const fs=require('fs'); const p='ecosystem.config.cjs'; let s=fs.readFileSync(p,'utf8'); s=s.replace(/PUBLIC_ORIGIN:\\s*[\\\"'][^\\\"']*[\\\"']/, 'PUBLIC_ORIGIN: \\\"$PublicOrigin\\\"'); fs.writeFileSync(p,s);`"",
  "npm ci",
  "SEED_DEMO=0 NEXT_PUBLIC_DEMO=0 npm run build",
  "mkdir -p data uploads",
  "pm2 delete pulse-chat >/dev/null 2>&1 || true",
  "pm2 start ecosystem.config.cjs",
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
