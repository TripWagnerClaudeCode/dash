# Sets up the Windows PC to run the Dash hub all the time, from boot. No passwords are stored.
#   1. installs WSL and Ubuntu if they're missing (then open Ubuntu once and pick a Linux username and password)
#   2. keeps WSL from idling out and keeps the PC awake
#   3. adds a "Dash Hub" scheduled task that keeps Ubuntu running from boot, and starts it now
# Run from an Admin PowerShell:  powershell -ExecutionPolicy Bypass -File $HOME\setup-windows.ps1
$ErrorActionPreference = 'Stop'
$Distro = 'Ubuntu-24.04'

# wsl -l prints UTF-16, so strip the NULs before comparing. 'Continue' because Windows PowerShell treats
# any stderr from a program as a fatal error under 'Stop'.
function Get-Distros([string[]]$Options) {
    $ErrorActionPreference = 'Continue'
    (wsl.exe -l -q @Options 2>$null) | ForEach-Object { ($_ -replace "`0", '').Trim() } | Where-Object { $_ }
}

if ((Get-Distros) -notcontains $Distro) {
    wsl.exe --install -d $Distro
    Write-Host ""
    Write-Host "Ubuntu is installing. If Windows asks to restart, restart."
    Write-Host "Then open Ubuntu from the Start menu, choose a username and password, and run this script again."
    exit 0
}

# Keep the WSL VM running even when no window is open.
$wslconfig = Join-Path $env:USERPROFILE '.wslconfig'
$text = if (Test-Path $wslconfig) { Get-Content $wslconfig -Raw } else { '' }
if ($text -notmatch '(?m)^\s*vmIdleTimeout') {
    if ($text -match '(?m)^\[wsl2\]') {
        $text = $text -replace '(?m)^\[wsl2\]\s*$', "[wsl2]`r`nvmIdleTimeout=-1"
    } else {
        $text = $text.TrimEnd() + "`r`n[wsl2]`r`nvmIdleTimeout=-1`r`n"
    }
    Set-Content -Path $wslconfig -Value $text.TrimStart() -Encoding ascii
}
Write-Host "WSL is set to stay running."

# Never sleep while plugged in. (Turning hibernate off needs Admin; it's optional once sleep is off.)
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
Write-Host "Sleep is off while plugged in."

# The keeper: a "Dash Hub" scheduled task that runs one Ubuntu command forever, so Ubuntu (and so the hub)
# stays up. It starts at boot, before anyone signs in (S4U, so no password is stored), again at sign-in,
# and every 5 minutes it starts again if it stopped (an update, `wsl --shutdown`). Registering a task that
# runs at boot needs Admin.
$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $admin) {
    Write-Host "Run this script once from an Admin PowerShell, so it can add the 'Dash Hub' scheduled task."
    exit 1
}
$user = "$env:USERDOMAIN\$env:USERNAME"
$action = New-ScheduledTaskAction -Execute "$env:WINDIR\System32\wsl.exe" -Argument "-d $Distro --exec /usr/bin/sleep infinity"
$every5 = New-ScheduledTaskTrigger -Once -At (Get-Date) -RepetitionInterval (New-TimeSpan -Minutes 5)
$triggers = @((New-ScheduledTaskTrigger -AtStartup), (New-ScheduledTaskTrigger -AtLogOn -User $user), $every5)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType S4U -RunLevel Highest
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -MultipleInstances IgnoreNew -ExecutionTimeLimit 0 -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1)
Register-ScheduledTask -TaskName 'Dash Hub' -Action $action -Trigger $triggers -Principal $principal -Settings $settings -Force | Out-Null
Start-ScheduledTask -TaskName 'Dash Hub'
Write-Host "The 'Dash Hub' scheduled task keeps Ubuntu running, from boot."

# An earlier version kept Ubuntu running from a Startup-folder shortcut instead. The task replaces it.
$oldShortcut = Join-Path ([Environment]::GetFolderPath('Startup')) 'Dash Hub.lnk'
if (Test-Path $oldShortcut) { Remove-Item $oldShortcut; Write-Host "Removed the old 'Dash Hub' Startup shortcut." }
$oldKeeper = Join-Path $env:LOCALAPPDATA 'DashHub'
if (Test-Path $oldKeeper) { Remove-Item -Recurse -Force $oldKeeper }
Start-Sleep -Seconds 10

Write-Host ""
if ((Get-Distros '--running') -contains $Distro) {
    Write-Host "Ubuntu is running and will start again after every restart, even before you sign in."
    Write-Host ""
    Write-Host "Next: in the Ubuntu window, run setup-wsl.sh (step 2 on the page)."
} else {
    Write-Host "Ubuntu didn't start. Open Ubuntu from the Start menu once, then run this script again."
    Write-Host "If it still says this, copy everything above and send it to Claude on the Mac."
}
