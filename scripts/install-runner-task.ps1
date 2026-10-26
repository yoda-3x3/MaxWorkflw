# Registers the WorkflwPro runner as a hidden Windows scheduled task.
# The task starts at logon, restarts on failure, and runs `npx tsx scripts/runner.ts` in the repo.
#
#   .\scripts\install-runner-task.ps1             install (or update) and start the task
#   .\scripts\install-runner-task.ps1 -Start      start it now
#   .\scripts\install-runner-task.ps1 -Stop       stop it now (it restarts at next logon)
#   .\scripts\install-runner-task.ps1 -Uninstall  stop and remove the task
[CmdletBinding()]
param(
  [switch]$Uninstall,
  [switch]$Start,
  [switch]$Stop
)

$ErrorActionPreference = 'Stop'
$TaskName = 'WorkflwProRunner'
$RepoDir = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$User = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

function Test-TaskInstalled {
  return [bool](Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)
}

if ($Uninstall) {
  if (Test-TaskInstalled) {
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Output "Removed scheduled task $TaskName."
  } else {
    Write-Output "Scheduled task $TaskName is not installed."
  }
  return
}

if ($Start) {
  if (-not (Test-TaskInstalled)) { throw "Scheduled task $TaskName is not installed. Run without switches first." }
  Start-ScheduledTask -TaskName $TaskName
  Write-Output "Started $TaskName."
  return
}

if ($Stop) {
  if (-not (Test-TaskInstalled)) { throw "Scheduled task $TaskName is not installed." }
  Stop-ScheduledTask -TaskName $TaskName
  Write-Output "Stopped $TaskName."
  return
}

# Full path to npx so the task does not depend on the PATH of the logon session.
$Npx = (Get-Command npx.cmd -ErrorAction Stop).Source

$envFiles = @('scripts\.env', 'runner.env') | ForEach-Object { Join-Path $RepoDir $_ }
if (-not ($envFiles | Where-Object { Test-Path $_ })) {
  Write-Warning "No runner env file found. Create scripts\.env or runner.env in $RepoDir before the runner can start."
}

$action = New-ScheduledTaskAction -Execute $Npx -Argument 'tsx scripts/runner.ts' -WorkingDirectory $RepoDir
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $User
$settings = New-ScheduledTaskSettingsSet `
  -Hidden `
  -StartWhenAvailable `
  -AllowStartIfOnBatteries `
  -DontStopIfGoingOnBatteries `
  -MultipleInstances IgnoreNew `
  -RestartCount 999 `
  -RestartInterval (New-TimeSpan -Minutes 1) `
  -ExecutionTimeLimit ([TimeSpan]::Zero)
$principal = New-ScheduledTaskPrincipal -UserId $User -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Description 'WorkflwPro PC runner (polls the queue, drives agent runs).' -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Write-Output "Installed and started scheduled task $TaskName (repo: $RepoDir)."
