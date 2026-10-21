param(
    [string]$SshHost,
    [int]$LocalPort = 7398,
    [string]$RemoteHost = "127.0.0.1",
    [int]$RemotePort = 7317,
    [string]$IdentityFile,
    [string]$KnownHostsFile,
    [string]$SshExe,
    [switch]$Remove,
    [switch]$Status
)

$ErrorActionPreference = "Stop"

$taskName = "AI Teams SSH Tunnel"
$projectRoot = Split-Path -Parent $PSScriptRoot
$supervisorConfigPath = Join-Path $projectRoot "config\supervisor.json"
$dataRoot = Join-Path $projectRoot "data"
$launcherDir = Join-Path $dataRoot "ssh-tunnel"
$launcherPath = Join-Path $launcherDir "run-tunnel.cmd"
$stopFlag = Join-Path $launcherDir "stop.flag"
$tunnelLog = Join-Path $launcherDir "tunnel.log"
$installLog = Join-Path $dataRoot "install-tunnel-task.log"

New-Item -ItemType Directory -Force -Path $dataRoot | Out-Null

function Log([string]$message) {
    $line = "[{0}] {1}" -f (Get-Date).ToString("yyyy-MM-dd HH:mm:ss"), $message
    Write-Host $line
    Add-Content -Path $installLog -Value $line -Encoding UTF8
}

function Test-Elevated {
    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($identity)
    return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Resolve-Defaults {
    if (-not $IdentityFile) { $script:IdentityFile = Join-Path $env:USERPROFILE ".ssh\id_ed25519" }
    if (-not $KnownHostsFile) { $script:KnownHostsFile = Join-Path $env:USERPROFILE ".ssh\known_hosts" }
    if (-not $SshExe) { $script:SshExe = Join-Path $env:SystemRoot "System32\OpenSSH\ssh.exe" }
}

function Get-LauncherProcesses {
    return @(Get-CimInstance Win32_Process -Filter "Name = 'cmd.exe'" -ErrorAction SilentlyContinue |
        Where-Object {
            $_.CommandLine -and
            $_.CommandLine.IndexOf($launcherPath, [StringComparison]::OrdinalIgnoreCase) -ge 0
        })
}

function Get-SshProcesses {
    $forwardPattern = "(^|\s)-L\s*" + [regex]::Escape($LocalPort) + ":"
    return @(Get-CimInstance Win32_Process -Filter "Name = 'ssh.exe'" -ErrorAction SilentlyContinue |
        Where-Object {
            if (-not $_.CommandLine -or $_.CommandLine -notmatch $forwardPattern) { return $false }
            if (-not $SshHost) { return $true }
            return $_.CommandLine.IndexOf($SshHost, [StringComparison]::OrdinalIgnoreCase) -ge 0
        })
}

function Stop-TunnelProcesses {
    $launchers = @(Get-LauncherProcesses)
    foreach ($process in $launchers) {
        Log "Stopping launcher PID $($process.ProcessId) ..."
        & taskkill.exe /PID $process.ProcessId /T /F 2>&1 | ForEach-Object { Log "  $_" }
    }
    $sshProcesses = @(Get-SshProcesses)
    foreach ($process in $sshProcesses) {
        Log "Stopping ssh PID $($process.ProcessId) ..."
        & taskkill.exe /PID $process.ProcessId /T /F 2>&1 | ForEach-Object { Log "  $_" }
    }
    for ($attempt = 0; $attempt -lt 10; $attempt++) {
        Start-Sleep -Milliseconds 500
        $remaining = @(Get-SshProcesses)
        $remainingLaunchers = @(Get-LauncherProcesses)
        if ($remaining.Count -eq 0 -and $remainingLaunchers.Count -eq 0) {
            return
        }
    }
    $pids = @($remaining.ProcessId) + @($remainingLaunchers.ProcessId)
    throw "Failed to stop tunnel process(es): $($pids -join ', ')"
}

function Get-SupervisorNode {
    if (-not (Test-Path $supervisorConfigPath)) { return $null }
    $supervisorConfig = Get-Content $supervisorConfigPath -Raw | ConvertFrom-Json
    return $supervisorConfig.nodes |
        Where-Object { $_.baseUrl -eq ("http://127.0.0.1:{0}" -f $LocalPort) } |
        Select-Object -First 1
}

function Get-NodeToken($node) {
    if (-not $node) { return $null }
    if ($node.token) { return $node.token }
    if ($node.tokenEnv) {
        foreach ($scope in @("Process", "User", "Machine")) {
            $value = [Environment]::GetEnvironmentVariable($node.tokenEnv, $scope)
            if ($value) { return $value }
        }
    }
    return $null
}

function Get-NodeHealth($node) {
    if (-not $node) { return $null }
    $token = Get-NodeToken $node
    if (-not $token) { return $null }
    try {
        return Invoke-RestMethod -Uri ("http://127.0.0.1:{0}/health" -f $LocalPort) -Headers @{ Authorization = "Bearer $token" } -TimeoutSec 3
    } catch {
        return $null
    }
}

function Get-Listener {
    return @(Get-NetTCPConnection -State Listen -LocalPort $LocalPort -ErrorAction SilentlyContinue)
}

function Assert-BatchSafe([string]$value, [string]$name) {
    if ($value -match '[\r\n"%]') {
        throw "$name contains a character that cannot be embedded in the launcher."
    }
}

function Main {
    Resolve-Defaults

    if ($Status) {
        $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        if (-not $task) {
            Log "Task '$taskName' is not installed."
            return 1
        }
        $info = Get-ScheduledTaskInfo -TaskName $taskName
        Log "Task: $taskName"
        Log "State: $($task.State)"
        Log "Principal: $($task.Principal.UserId) / logon=$($task.Principal.LogonType) / runLevel=$($task.Principal.RunLevel)"
        Log "Last run: $($info.LastRunTime)"
        Log "Last result: 0x$('{0:X8}' -f [uint32]$info.LastTaskResult)"
        $listeners = @(Get-Listener)
        if ($listeners.Count -gt 0) {
            $pids = @($listeners.OwningProcess | Select-Object -Unique)
            Log "Listen: 127.0.0.1:$LocalPort (PID $($pids -join ', '))"
        } else {
            Log "Listen: 127.0.0.1:$LocalPort (none)"
        }
        $node = Get-SupervisorNode
        $health = Get-NodeHealth $node
        if ($null -ne $health) {
            Log "Health: ok (nodeId=$($health.nodeId), version=$($health.version))"
        } else {
            Log "Health: unreachable"
        }
        Log "Stop flag: $(if (Test-Path $stopFlag) { 'present' } else { 'absent' })"
        Log "Visible ssh processes: $(@(Get-SshProcesses).Count) (non-elevated may not see S4U command lines)"
        if (Test-Path $tunnelLog) {
            Get-Content $tunnelLog -Tail 5 | ForEach-Object { Log "  $_" }
        }
        return 0
    }

    if (-not (Test-Elevated)) {
        Log "ERROR: run this script from an elevated PowerShell (Run as Administrator)."
        return 1
    }

    if ($Remove) {
        New-Item -ItemType Directory -Force -Path $launcherDir | Out-Null
        Set-Content -Path $stopFlag -Value "stopping" -Encoding ASCII
        $task = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        if ($task) {
            Log "Stopping scheduled task '$taskName' ..."
            Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
        }
        try {
            Stop-TunnelProcesses
        } catch {
            Log "WARNING: $($_.Exception.Message)"
        }
        if ($task) {
            Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
            Log "Removed scheduled task '$taskName'."
        }
        if (Test-Path $launcherPath) {
            Remove-Item $launcherPath -Force
            Log "Removed launcher: $launcherPath"
        }
        $deadline = (Get-Date).AddSeconds(5)
        while ((Get-Listener).Count -gt 0 -and (Get-Date) -lt $deadline) {
            Start-Sleep -Milliseconds 500
        }
        Log "SSH tunnel is stopped."
        return 0
    }

    if (-not $SshHost) {
        throw "Missing -SshHost, for example: -SshHost root@203.0.113.10"
    }
    if ($SshHost -notmatch '^[A-Za-z0-9._@:\[\]-]+$') {
        throw "SshHost contains unsupported characters."
    }
    if ($LocalPort -lt 1 -or $LocalPort -gt 65535 -or $RemotePort -lt 1 -or $RemotePort -gt 65535) {
        throw "Ports must be between 1 and 65535."
    }
    if ($RemoteHost -notmatch '^[A-Za-z0-9._:\[\]-]+$') {
        throw "RemoteHost contains unsupported characters."
    }
    Assert-BatchSafe $IdentityFile "IdentityFile"
    Assert-BatchSafe $KnownHostsFile "KnownHostsFile"
    Assert-BatchSafe $SshExe "SshExe"
    Assert-BatchSafe $SshHost "SshHost"
    if (-not (Test-Path $SshExe)) {
        throw "ssh.exe was not found at $SshExe."
    }
    if (-not (Test-Path $IdentityFile)) {
        throw "SSH identity file was not found at $IdentityFile."
    }
    if (-not (Test-Path $KnownHostsFile)) {
        throw "known_hosts was not found at $KnownHostsFile."
    }

    Log "Testing SSH key authentication to $SshHost ..."
    $testArgs = @(
        "-o", "BatchMode=yes",
        "-o", "ConnectTimeout=10",
        "-o", "ConnectionAttempts=1",
        "-o", "IdentityAgent=none",
        "-o", "IdentitiesOnly=yes",
        "-o", "StrictHostKeyChecking=yes",
        "-o", "UserKnownHostsFile=$KnownHostsFile",
        "-i", $IdentityFile,
        $SshHost,
        "echo tunnel-auth-ok"
    )
    $testOutput = & $SshExe @testArgs 2>&1
    if ($LASTEXITCODE -ne 0 -or ($testOutput -join "`n") -notmatch "tunnel-auth-ok") {
        throw "SSH authentication test failed: $($testOutput -join ' ')"
    }
    Log "SSH authentication OK."

    $existingTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($existingTask) {
        Log "Stopping existing scheduled task '$taskName' ..."
        Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    }
    New-Item -ItemType Directory -Force -Path $launcherDir | Out-Null
    Set-Content -Path $stopFlag -Value "stopping" -Encoding ASCII
    Stop-TunnelProcesses

    Start-Sleep -Milliseconds 500
    $listeners = @(Get-Listener)
    if ($listeners.Count -gt 0) {
        $pids = @($listeners.OwningProcess | Select-Object -Unique)
        throw "Port $LocalPort is still in use by process(es): $($pids -join ', ')."
    }
    Remove-Item $stopFlag -Force

    $sshDir = Split-Path -Parent $SshExe
    $launcherLines = @(
        "@echo off",
        "setlocal",
        ('set "PATH={0};%SystemRoot%\System32;%SystemRoot%;%PATH%"' -f $sshDir)
    )
    if ($env:USERPROFILE) {
        $launcherLines += ('set "USERPROFILE={0}"' -f $env:USERPROFILE)
        $launcherLines += ('set "HOME={0}"' -f $env:USERPROFILE)
    }
    if ($env:APPDATA) { $launcherLines += ('set "APPDATA={0}"' -f $env:APPDATA) }
    if ($env:LOCALAPPDATA) {
        $launcherLines += ('set "LOCALAPPDATA={0}"' -f $env:LOCALAPPDATA)
        $launcherLines += ('set "TEMP={0}"' -f (Join-Path $env:LOCALAPPDATA "Temp"))
        $launcherLines += ('set "TMP={0}"' -f (Join-Path $env:LOCALAPPDATA "Temp"))
    }
    $launcherLines += ('cd /d "{0}"' -f $projectRoot)
    $launcherLines += ('if exist "{0}" exit /b 0' -f $stopFlag)
    $launcherLines += ":ai_teams_tunnel"
    $launcherLines += ('echo [%DATE% %TIME%] starting tunnel to {0} >> "{1}"' -f $SshHost, $tunnelLog)
    $sshArgs = @(
        "-N", "-T",
        "-o", "BatchMode=yes",
        "-o", "ExitOnForwardFailure=yes",
        "-o", "ConnectTimeout=10",
        "-o", "ConnectionAttempts=1",
        "-o", "ServerAliveInterval=15",
        "-o", "ServerAliveCountMax=3",
        "-o", "TCPKeepAlive=yes",
        "-o", "IdentityAgent=none",
        "-o", "IdentitiesOnly=yes",
        "-o", "StrictHostKeyChecking=yes",
        "-o", "UserKnownHostsFile=$KnownHostsFile",
        "-i", $IdentityFile,
        "-L", ("{0}:{1}:{2}" -f $LocalPort, $RemoteHost, $RemotePort),
        $SshHost
    )
    $quotedArgs = $sshArgs | ForEach-Object {
        if ($_ -match '[\s]') { '"{0}"' -f $_ } else { $_ }
    }
    $launcherLines += ('"{0}" {1} >> "{2}" 2>&1' -f $SshExe, ($quotedArgs -join " "), $tunnelLog)
    $launcherLines += 'set "AI_TEAMS_EXIT=%ERRORLEVEL%"'
    $launcherLines += ('echo [%DATE% %TIME%] ssh exited with code %AI_TEAMS_EXIT% >> "{0}"' -f $tunnelLog)
    $launcherLines += ('if exist "{0}" exit /b %AI_TEAMS_EXIT%' -f $stopFlag)
    $launcherLines += "ping -n 11 127.0.0.1 >nul"
    $launcherLines += "goto ai_teams_tunnel"

    Set-Content -Path $launcherPath -Value $launcherLines -Encoding ASCII
    Log "Wrote launcher: $launcherPath"

    $action = New-ScheduledTaskAction `
        -Execute $env:ComSpec `
        -Argument ('/c ""{0}""' -f $launcherPath) `
        -WorkingDirectory $projectRoot
    $trigger = New-ScheduledTaskTrigger -AtStartup
    $settings = New-ScheduledTaskSettingsSet `
        -AllowStartIfOnBatteries `
        -DontStopIfGoingOnBatteries `
        -StartWhenAvailable `
        -RestartCount 3 `
        -RestartInterval (New-TimeSpan -Minutes 1) `
        -MultipleInstances IgnoreNew `
        -ExecutionTimeLimit ([TimeSpan]::Zero) `
        -Hidden
    $user = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $principal = New-ScheduledTaskPrincipal -UserId $user -LogonType S4U -RunLevel Limited

    Register-ScheduledTask `
        -TaskName $taskName `
        -Action $action `
        -Trigger $trigger `
        -Settings $settings `
        -Principal $principal `
        -Description "AI Teams SSH local port forward to $SshHost. Starts at boot and reconnects automatically. Installed from $projectRoot." `
        -Force | Out-Null
    Log "Registered scheduled task '$taskName' for $user (S4U, at startup)."

    Log "Starting scheduled task '$taskName' ..."
    Start-ScheduledTask -TaskName $taskName

    $deadline = (Get-Date).AddSeconds(25)
    $health = $null
    $node = Get-SupervisorNode
    do {
        Start-Sleep -Milliseconds 500
        if ((Get-Listener).Count -gt 0) {
            $health = Get-NodeHealth $node
        }
    } while ($null -eq $health -and (Get-Date) -lt $deadline)

    if ((Get-Listener).Count -eq 0) {
        $info = Get-ScheduledTaskInfo -TaskName $taskName
        throw "Task started but port $LocalPort is not listening. LastTaskResult=0x$('{0:X8}' -f [uint32]$info.LastTaskResult). See $tunnelLog."
    }
    if ($null -eq $health) {
        Log "WARNING: port $LocalPort is listening but node health is unreachable. Check node-linux and supervisor token."
    } else {
        Log "Health check OK: nodeId=$($health.nodeId), version=$($health.version)"
    }
    Log "Tunnel installed. Log: $tunnelLog"
    Log "Remove with: powershell -ExecutionPolicy Bypass -File scripts\install-tunnel-task.ps1 -Remove"
    return 0
}

$exitCode = 1
try {
    $exitCode = Main
} catch {
    Log "ERROR: $($_.Exception.Message)"
    if ($_.ScriptStackTrace) { Log $_.ScriptStackTrace }
    $exitCode = 1
}
exit $exitCode
