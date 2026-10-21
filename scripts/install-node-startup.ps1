param(
    [switch]$Remove
)

$ErrorActionPreference = "Stop"

$projectRoot = Split-Path -Parent $PSScriptRoot
$startupDir = [Environment]::GetFolderPath("Startup")
$shortcutPath = Join-Path $startupDir "AI Teams Node Agent.lnk"

if ($Remove) {
    if (Test-Path $shortcutPath) {
        Remove-Item $shortcutPath
        Write-Host "Removed startup shortcut: $shortcutPath"
    } else {
        Write-Host "No startup shortcut found: $shortcutPath"
    }
    exit 0
}

$configPath = Join-Path $projectRoot "config\node.json"
$agentPath = Join-Path $projectRoot "dist\src\node\agent.js"

if (-not (Test-Path $configPath)) {
    throw "Missing $configPath. Copy config\node.example.json to config\node.json and edit it first."
}
if (-not (Test-Path $agentPath)) {
    throw "Missing $agentPath. Run 'npm run build' first."
}

$node = (Get-Command node -ErrorAction Stop).Source
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $node
$shortcut.Arguments = "`"$agentPath`" --config `"$configPath`""
$shortcut.WorkingDirectory = $projectRoot
$shortcut.WindowStyle = 7
$shortcut.Description = "AI Teams node agent (starts when this user logs in)"
$shortcut.Save()

Write-Host "Installed startup shortcut: $shortcutPath"
Write-Host "The agent starts at user logon in the logged-in desktop session."
Write-Host "Logs: $(Join-Path $projectRoot 'data\node-a\logs\node.log') (adjust dataDir if changed)"
Write-Host "Remove with: powershell -ExecutionPolicy Bypass -File scripts\install-node-startup.ps1 -Remove"
