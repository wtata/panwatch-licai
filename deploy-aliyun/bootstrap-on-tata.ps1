# One-shot on machine tata (machineId e4bbe5cd-ad96-4e0f-b1aa-c0e1ed8aa4f0)
# Downloads deploy tar from GitHub release, uploads to ECS, runs remote-setup.
$ErrorActionPreference = "Stop"
$env:Path = "C:\Program Files\workbench;" + $env:Path
$InstanceId = "i-2ze1sc9j6hgtk5e6qtix"
$Region = "cn-beijing"
$TarUrl = "https://github.com/wtata/panwatch-licai/releases/download/panwatch-aliyun-deploy/panwatch-licai-deploy.tar"
$TarPath = Join-Path $env:TEMP "panwatch-licai-deploy.tar"

Write-Host "==> download $TarUrl"
Invoke-WebRequest -Uri $TarUrl -OutFile $TarPath -UseBasicParsing
Write-Host ("==> size MB " + [math]::Round((Get-Item $TarPath).Length/1MB,2))

if (-not (Get-Command workbench -ErrorAction SilentlyContinue)) {
  throw "workbench not on PATH. Install Workbench CLI and add C:\Program Files\workbench"
}

Write-Host "==> workbench upload"
& workbench upload $TarPath "/root/" --instance-id $InstanceId --region $Region -f
if ($LASTEXITCODE -ne 0) { throw "upload failed" }

$remoteCmd = @'
set -e
mkdir -p /root/panwatch-licai
tar -xf /root/panwatch-licai-deploy.tar -C /root/panwatch-licai
chmod +x /root/panwatch-licai/remote-setup.sh
bash /root/panwatch-licai/remote-setup.sh
'@

Write-Host "==> workbench exec remote-setup"
& workbench exec --instance-id $InstanceId --region $Region --timeout 1200 --command $remoteCmd
if ($LASTEXITCODE -ne 0) { throw "exec failed" }

Write-Host "==> verify from Windows"
curl.exe -sS -H "Host: gushiding.cn" http://182.92.143.113/api/health
Write-Host ""
curl.exe -sSk -Ik https://chaolemei.cn 2>&1 | Select-Object -First 12
Write-Host ""
Resolve-DnsName gushiding.cn -Type A | Format-Table Name,IPAddress
Write-Host "DONE"
