param(
  [switch]$NoStartup,
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'
$root = $PSScriptRoot
$icon = Join-Path $root 'assets\guardian.ico'
$wscript = Join-Path $env:SystemRoot 'System32\wscript.exe'
$desktop = [Environment]::GetFolderPath('Desktop')
$startup = [Environment]::GetFolderPath('Startup')

$desktopName = 'DSH 守护者.lnk'
$startupName = 'DSH 守护者（后台）.lnk'
$desktopLink = Join-Path $desktop $desktopName
$startupLink = Join-Path $startup $startupName

function Remove-Shortcut([string]$Path) {
  if (Test-Path -LiteralPath $Path) {
    Remove-Item -LiteralPath $Path -Force
    Write-Output "已删除快捷方式：$Path"
  }
}

if ($Remove) {
  Remove-Shortcut $desktopLink
  Remove-Shortcut $startupLink
  exit 0
}

if (-not (Test-Path -LiteralPath (Join-Path $root 'guardian.mjs'))) {
  throw "找不到 guardian.mjs：$root"
}

# Make sure config.json exists (init detects DSH_HOME, node, and app path defaults).
if (-not (Test-Path -LiteralPath (Join-Path $root 'config.json'))) {
  $nodeCandidates = @(
    (Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'),
    'D:\DSH\resources\runtime\primary-runtime\dependencies\node\bin\node.exe'
  )
  $node = $nodeCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
  if (-not $node) { $node = (Get-Command node.exe -ErrorAction Stop).Source }
  & $node (Join-Path $root 'guardian.mjs') init | Out-Null
}

function New-Shortcut([string]$Path, [string]$Target, [string]$Arguments, [string]$Description) {
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($Path)
  $shortcut.TargetPath = $Target
  $shortcut.Arguments = $Arguments
  $shortcut.WorkingDirectory = $root
  $shortcut.WindowStyle = 1
  if (Test-Path -LiteralPath $icon) { $shortcut.IconLocation = "$icon,0" }
  $shortcut.Description = $Description
  $shortcut.Save()
  Write-Output "已创建快捷方式：$Path"
}

$panelLauncher = Join-Path $root 'panel\launch-panel.vbs'
New-Shortcut $desktopLink $wscript "`"$panelLauncher`"" 'DSH 守护者 — 监控 DSH、自动回滚问题插件'

if (-not $NoStartup) {
  $daemonLauncher = Join-Path $root 'panel\launch-daemon.vbs'
  New-Shortcut $startupLink $wscript "`"$daemonLauncher`"" 'DSH 守护者 — 登录后后台启动守护进程'
} else {
  Remove-Shortcut $startupLink
}

Write-Output ''
Write-Output '完成。双击桌面的「DSH 守护者」即可打开控制面板。'
if (-not $NoStartup) {
  Write-Output '已注册开机自启（启动文件夹快捷方式）；如需移除，运行：install-shortcuts.ps1 -Remove'
} else {
  Write-Output '未注册开机自启（-NoStartup）。'
}
