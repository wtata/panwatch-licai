# Pack deploy-aliyun -> workbench upload -> remote extract + remote-setup.sh
# Usage (on tata):
#   $env:Path = "C:\Program Files\workbench;" + $env:Path
#   powershell -ExecutionPolicy Bypass -File C:\Users\15295\panwatch-licai\deploy-aliyun\push-to-ecs.ps1

param(
  [string]$InstanceId = "i-2ze1sc9j6hgtk5e6qtix",
  [string]$Region = "cn-beijing",
  [string]$RemoteDir = "/root",
  [int]$TimeoutSec = 1200
)

$ErrorActionPreference = "Stop"

function Require-Cmd([string]$Name) {
  if (Get-Command $Name -ErrorAction SilentlyContinue) { return }
  if ($Name -eq "workbench") {
    foreach ($c in @(
      "C:\Program Files\workbench\workbench.exe",
      "$env:LOCALAPPDATA\workbench\workbench.exe"
    )) {
      if (Test-Path $c) {
        $env:Path = (Split-Path $c -Parent) + ";" + $env:Path
        return
      }
    }
  }
  throw "Command not found: $Name"
}

Require-Cmd tar
Require-Cmd workbench

$DeployRoot = $PSScriptRoot
if (-not (Test-Path (Join-Path $DeployRoot "docker-compose.yml"))) {
  throw "docker-compose.yml missing under $DeployRoot"
}

$TarName = "panwatch-licai-deploy.tar"
$TarPath = Join-Path $env:TEMP $TarName

Write-Host "==> packing $DeployRoot -> $TarPath"
if (Test-Path $TarPath) { Remove-Item -Force $TarPath }
Push-Location $DeployRoot
try {
  # Pack contents (not parent folder) so extract flattens into /root/panwatch-licai
  & tar -cf $TarPath --exclude=push-to-ecs.ps1 overlay docker-compose.yml nginx remote-setup.sh
  if ($LASTEXITCODE -ne 0) { throw "tar failed" }
} finally { Pop-Location }

$sizeMb = [math]::Round((Get-Item $TarPath).Length / 1MB, 2)
Write-Host "==> packed $sizeMb MB"

Write-Host "==> workbench upload -> $RemoteDir/"
& workbench upload $TarPath ($RemoteDir + "/") --instance-id $InstanceId --region $Region -f
if ($LASTEXITCODE -ne 0) { throw "upload failed exit=$LASTEXITCODE" }

$remoteCmd = @'
set -e
mkdir -p /root/panwatch-licai
tar -xf /root/panwatch-licai-deploy.tar -C /root/panwatch-licai
chmod +x /root/panwatch-licai/remote-setup.sh
bash /root/panwatch-licai/remote-setup.sh
'@

Write-Host "==> workbench exec remote-setup (timeout ${TimeoutSec}s)..."
& workbench exec --instance-id $InstanceId --region $Region --timeout $TimeoutSec --command $remoteCmd
if ($LASTEXITCODE -ne 0) { throw "exec failed exit=$LASTEXITCODE" }

Write-Host "==> done. Test: curl -sS -H 'Host: gushiding.cn' http://182.92.143.113/api/health"
