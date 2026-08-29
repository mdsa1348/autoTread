# Run once in PowerShell as Administrator:
#   powershell -ExecutionPolicy Bypass -File G:\AutoTread\deploy\windows\keep-alive.ps1
$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path
$taskName = "AutoTreadPaperBot"
$startCmd = "npm start"

Write-Host "App folder: $root"

# Do not sleep/hibernate while plugged in
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
powercfg /change disk-timeout-ac 0
Write-Host "AC sleep/hibernate set to Never."

$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument "/c npm start" -WorkingDirectory $root
$triggerLogon = New-ScheduledTaskTrigger -AtLogOn
$triggerStart = New-ScheduledTaskTrigger -AtStartup
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 10 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit (New-TimeSpan -Hours 0)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($triggerLogon, $triggerStart) -Settings $settings -Principal $principal -Force | Out-Null
Write-Host "Scheduled task '$taskName' registered (startup + logon, restart if it crashes)."
Write-Host "Start it now with: Start-ScheduledTask -TaskName $taskName"
Write-Host "Laptop MUST stay powered. If it is fully off, no trades run until it boots again."
