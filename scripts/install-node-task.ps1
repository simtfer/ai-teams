param(
    [switch]$Remove,
    [switch]$Status,
    [switch]$Force
)

$ErrorActionPreference = "Stop"

$taskName = "AI Teams Node Agent"
$projectRoot = Split-Path -Parent $PSScriptRoot
$configPath = Join-Path $projectRoot "config\node.json"
$agentPath = Join-Path $projectRoot "dist\src\node\agent.js"
$dataRoot = Join-Path $projectRoot "data"
$launcherDir = Join-Path $dataRoot "node-autostart"
$launcherPath = Join-Path $launcherDir "run-node.cmd"
$stopFlag = Join-Path $launcherDir "stop.flag"
$installLog = Join-Path $dataRoot "install-node-task.log"

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

function Get-AgentProcesses {
    return @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
        Where-Object {
            $_.CommandLine -and
            $_.CommandLine.IndexOf($agentPath, [StringComparison]::OrdinalIgnoreCase) -ge 0
        })
}

function Get-LauncherProcesses {
    return @(Get-CimInstance Win32_Process -Filter "Name = 'cmd.exe'" -ErrorAction SilentlyContinue |
        Where-Object {
            $_.CommandLine -and
            $_.CommandLine.IndexOf($launcherPath, [StringComparison]::OrdinalIgnoreCase) -ge 0
        })
}

function Get-Token($config) {
    if ($config.token) { return $config.token }
    if ($config.tokenEnv) {
        $machineValue = [Environment]::GetEnvironmentVariable($config.tokenEnv, "Machine")
        if ($machineValue) { return $machineValue }
    }
    return $null
}

function Get-HealthUri($config) {
    $hostName = [string]$config.host
    if ($hostName -in @("0.0.0.0", "::", "[::]")) { $hostName = "127.0.0.1" }
    return "http://{0}:{1}" -f $hostName, [int]$config.port
}

function Get-NodeHealth($config, $token) {
    $headers = @{ Authorization = "Bearer $token" }
    try {
        return Invoke-RestMethod -Uri ((Get-HealthUri $config) + "/health") -Headers $headers -TimeoutSec 3
    } catch {
        return $null
    }
}

function Stop-AgentProcesses {
    $launchers = @(Get-LauncherProcesses)
    foreach ($process in $launchers) {
        Log "Stopping launcher PID $($process.ProcessId) ..."
        & taskkill.exe /PID $process.ProcessId /T /F 2>&1 | ForEach-Object { Log "  $_" }
    }
    $processes = @(Get-AgentProcesses)
    foreach ($process in $processes) {
        Log "Stopping node agent PID $($process.ProcessId) ..."
        & taskkill.exe /PID $process.ProcessId /T /F 2>&1 | ForEach-Object { Log "  $_" }
    }
    for ($attempt = 0; $attempt -lt 10; $attempt++) {
        Start-Sleep -Milliseconds 500
        $remaining = @(Get-AgentProcesses)
        $remainingLaunchers = @(Get-LauncherProcesses)
        if ($remaining.Count -eq 0 -and $remainingLaunchers.Count -eq 0) {
            return
        }
    }
    $pids = @($remaining.ProcessId) + @($remainingLaunchers.ProcessId)
    throw "Failed to stop node agent process(es): $($pids -join ', ')"
}

function Main {
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
        if (Test-Path $configPath) {
            $config = Get-Content $configPath -Raw | ConvertFrom-Json
            $token = Get-Token $config
            $health = if ($token) { Get-NodeHealth $config $token } else { $null }
            if ($null -ne $health) {
                Log "Health: ok (nodeId=$($health.nodeId), version=$($health.version))"
            } else {
                Log "Health: unreachable"
            }
        }
        Log "Stop flag: $(if (Test-Path $stopFlag) { 'present' } else { 'absent' })"
        Log "Visible agent processes: $(@(Get-AgentProcesses).Count) (non-elevated may not see S4U command lines)"
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
            Stop-AgentProcesses
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
        Log "Node agent is stopped. Start it manually with: npm run start:node"
        return 0
    }

    if (-not (Test-Path $configPath)) {
        throw "Missing $configPath. Copy config\node.example.json to config\node.json and edit it first."
    }
    if (-not (Test-Path $agentPath)) {
        throw "Missing $agentPath. Run 'npm run build' first."
    }

    $config = Get-Content $configPath -Raw | ConvertFrom-Json
    if (-not $config.token -and $config.tokenEnv) {
        $machineValue = [Environment]::GetEnvironmentVariable($config.tokenEnv, "Machine")
        if (-not $machineValue) {
            throw "tokenEnv '$($config.tokenEnv)' is not set at machine scope. A boot task cannot rely on user-level environment variables; use token or a machine-level variable."
        }
    }
    $token = Get-Token $config
    if (-not $token) {
        throw "Node token is missing in $configPath."
    }

    if ([IO.Path]::IsPathRooted([string]$config.dataDir)) {
        $dataDir = [IO.Path]::GetFullPath([string]$config.dataDir)
    } else {
        $dataDir = [IO.Path]::GetFullPath((Join-Path (Split-Path -Parent $configPath) $config.dataDir))
    }
    $logDir = Join-Path $dataDir "logs"
    New-Item -ItemType Directory -Force -Path $logDir | Out-Null
    $stdoutLog = Join-Path $logDir "node-autostart.log"

    $nodePath = (Get-Command node -ErrorAction Stop).Source
    $piCommand = [string]$config.harnesses.pi.command
    $piPath = $null
    try {
        $piPath = (Get-Command $piCommand -ErrorAction Stop).Source
    } catch {
        if (Test-Path $piCommand) {
            $piPath = (Get-Item $piCommand).FullName
        } else {
            throw "pi command '$piCommand' was not found. Install pi or set harnesses.pi.command to an absolute path."
        }
    }
    $piDir = Split-Path -Parent $piPath

    $existing = @(Get-AgentProcesses)
    if ($existing.Count -gt 0) {
        $health = Get-NodeHealth $config $token
        if ($null -ne $health) {
            try {
                $headers = @{ Authorization = "Bearer $token" }
                $response = Invoke-RestMethod -Uri ((Get-HealthUri $config) + "/api/tasks?status=running&limit=10") -Headers $headers -TimeoutSec 3
                $runningCount = if ($null -eq $response) { 0 } else { [int]$response.Count }
            } catch {
                throw "Node is reachable but the running-task check failed: $($_.Exception.Message)"
            }
            if ($runningCount -gt 0 -and -not $Force) {
                throw "Node has $runningCount running task(s). Wait for them to finish, cancel them, or re-run with -Force to interrupt them."
            }
        }
    }

    $existingTask = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    if ($existingTask) {
        Log "Stopping existing scheduled task '$taskName' ..."
        Stop-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
    }
    New-Item -ItemType Directory -Force -Path $launcherDir | Out-Null
    Set-Content -Path $stopFlag -Value "stopping" -Encoding ASCII
    Stop-AgentProcesses
    Remove-Item $stopFlag -Force

    $pathParts = @($piDir, (Split-Path -Parent $nodePath)) |
        Where-Object { $_ } |
        Select-Object -Unique
    $pathPrefix = $pathParts -join ";"

    $launcherLines = @(
        "@echo off",
        "setlocal",
        ('set "PATH={0};%PATH%"' -f $pathPrefix)
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
    $launcherLines += ":ai_teams_run"
    $launcherLines += ('"{0}" "{1}" --config "{2}" >> "{3}" 2>&1' -f $nodePath, $agentPath, $configPath, $stdoutLog)
    $launcherLines += 'set "AI_TEAMS_EXIT=%ERRORLEVEL%"'
    $launcherLines += ('echo [%DATE% %TIME%] node exited with code %AI_TEAMS_EXIT% >> "{0}"' -f $stdoutLog)
    $launcherLines += ('if exist "{0}" exit /b %AI_TEAMS_EXIT%' -f $stopFlag)
    $launcherLines += "ping -n 11 127.0.0.1 >nul"
    $launcherLines += "goto ai_teams_run"

    New-Item -ItemType Directory -Force -Path $launcherDir | Out-Null
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
        -Description "AI Teams node agent. Starts at boot without requiring user logon. Installed from $projectRoot." `
        -Force | Out-Null
    Log "Registered scheduled task '$taskName' for $user (S4U, at startup)."

    $startupShortcut = Join-Path ([Environment]::GetFolderPath("Startup")) "AI Teams Node Agent.lnk"
    if (Test-Path $startupShortcut) {
        Remove-Item $startupShortcut -Force
        Log "Removed old startup shortcut: $startupShortcut"
    }

    Log "Starting scheduled task '$taskName' ..."
    Start-ScheduledTask -TaskName $taskName

    $deadline = (Get-Date).AddSeconds(15)
    $health = $null
    do {
        Start-Sleep -Milliseconds 500
        $health = Get-NodeHealth $config $token
    } while ($null -eq $health -and (Get-Date) -lt $deadline)

    if ($null -eq $health) {
        $info = Get-ScheduledTaskInfo -TaskName $taskName
        throw "Task started but the node health check failed. LastTaskResult=0x$('{0:X8}' -f [uint32]$info.LastTaskResult). See $stdoutLog and $logDir\node.log."
    }

    $agentProcesses = @(Get-AgentProcesses)
    Log "Health check OK: nodeId=$($health.nodeId), version=$($health.version), pids=$($agentProcesses.ProcessId -join ',')"
    Log "Autostart installed. Task log: $stdoutLog"
    Log "Remove with: powershell -ExecutionPolicy Bypass -File scripts\install-node-task.ps1 -Remove"
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
