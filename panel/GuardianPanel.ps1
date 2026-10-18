param(
  [switch]$NoAutoStart,
  [switch]$Check,
  [string]$Screenshot
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$script:Root = Split-Path -Parent $PSScriptRoot
$script:StateDir = if ($env:DSH_GUARDIAN_HOME) { $env:DSH_GUARDIAN_HOME } else { Join-Path $env:USERPROFILE '.dsh-guardian' }
$script:StatusPath = Join-Path $script:StateDir 'runtime\status.json'
$script:ConfigPath = Join-Path $script:Root 'config.json'
$script:LogPath = Join-Path $script:StateDir 'logs\guardian.log'
$script:IncidentsDir = Join-Path $script:StateDir 'incidents'
$script:IconPath = Join-Path $script:Root 'assets\guardian.ico'
$script:AutoStarted = $false
$script:Updating = $false
$script:SuppressConfigEvents = $false
$script:HadFirstUpdate = $false

function Read-JsonFile([string]$Path) {
  try {
    if (-not (Test-Path -LiteralPath $Path)) { return $null }
    $text = [System.IO.File]::ReadAllText($Path, [System.Text.Encoding]::UTF8)
    if ([string]::IsNullOrWhiteSpace($text)) { return $null }
    return $text | ConvertFrom-Json
  } catch {
    return $null
  }
}

function Get-NodePath {
  $config = Read-JsonFile $script:ConfigPath
  if ($config -and $config.nodeExe -and (Test-Path -LiteralPath $config.nodeExe)) { return $config.nodeExe }
  return (Join-Path $env:USERPROFILE '.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe')
}

function Get-GuardianCli {
  return (Join-Path $script:Root 'guardian.mjs')
}

function Invoke-Guardian {
  param([string[]]$Arguments, [string]$Feedback)
  try {
    $node = Get-NodePath
    $cli = Get-GuardianCli
    if (-not (Test-Path -LiteralPath $node)) { throw "找不到 Node：$node" }
    $argList = @($cli) + $Arguments
    Start-Process -FilePath $node -ArgumentList $argList -WorkingDirectory $script:Root -WindowStyle Hidden | Out-Null
    if ($Feedback) { Set-Feedback $Feedback }
  } catch {
    Set-Feedback "操作失败：$($_.Exception.Message)" '#ef4444'
  }
}

function Set-Feedback([string]$Text, [string]$Color = '#94a3b8') {
  $script:LblFeedback.Text = $Text
  $script:LblFeedback.ForeColor = [System.Drawing.ColorTranslator]::FromHtml($Color)
}

function Get-DaemonRunning($status) {
  if (-not $status -or -not $status.daemon -or -not $status.daemon.running) { return $false }
  $daemonPid = [int]$status.daemon.pid
  if ($daemonPid -le 0) { return $false }
  try {
    $process = Get-Process -Id $daemonPid -ErrorAction Stop
    return -not $process.HasExited
  } catch {
    return $false
  }
}

function Format-Time([object]$UnixMs) {
  try {
    if ($null -eq $UnixMs) { return '' }
    $date = [System.DateTimeOffset]::FromUnixTimeMilliseconds([int64]$UnixMs).LocalDateTime
    return $date.ToString('MM-dd HH:mm:ss')
  } catch {
    return ''
  }
}

function Format-Age([object]$UnixMs) {
  try {
    if ($null -eq $UnixMs) { return '' }
    $seconds = ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - [int64]$UnixMs) / 1000
    if ($seconds -lt 60) { return "$([int][Math]::Max(0,$seconds)) 秒前" }
    if ($seconds -lt 3600) { return "$([int]($seconds / 60)) 分钟前" }
    if ($seconds -lt 86400) { return "$([int]($seconds / 3600)) 小时前" }
    return "$([int]($seconds / 86400)) 天前"
  } catch {
    return ''
  }
}

function Format-Duration([object]$Seconds) {
  $value = [double]$Seconds
  if ($value -lt 60) { return "$([int]$value) 秒" }
  if ($value -lt 3600) { return "$([int]($value / 60)) 分 $([int]($value % 60)) 秒" }
  return "$([int]($value / 3600)) 小时 $([int](($value % 3600) / 60)) 分"
}

# ---------- palette ----------
$bg = '#0b1220'
$card = '#111c2e'
$cardBorder = '#1e2d45'
$text = '#e2e8f0'
$muted = '#94a3b8'
$accent = '#38bdf8'
$green = '#22c55e'
$amber = '#f59e0b'
$red = '#ef4444'
$blue = '#60a5fa'
$gray = '#64748b'

$fontUi = New-Object System.Drawing.Font('Microsoft YaHei UI', 9.5)
$fontSmall = New-Object System.Drawing.Font('Microsoft YaHei UI', 8.5)
$fontTitle = New-Object System.Drawing.Font('Microsoft YaHei UI', 20, [System.Drawing.FontStyle]::Bold)
$fontValue = New-Object System.Drawing.Font('Microsoft YaHei UI', 10, [System.Drawing.FontStyle]::Regular)
$fontValueBold = New-Object System.Drawing.Font('Microsoft YaHei UI', 10, [System.Drawing.FontStyle]::Bold)

$form = New-Object System.Windows.Forms.Form
$form.Text = 'DSH 守护者'
$form.ClientSize = New-Object System.Drawing.Size(820, 648)
$form.MinimumSize = New-Object System.Drawing.Size(820, 648)
$form.StartPosition = 'CenterScreen'
$form.BackColor = [System.Drawing.ColorTranslator]::FromHtml($bg)
$form.Font = $fontUi
$form.ForeColor = [System.Drawing.ColorTranslator]::FromHtml($text)
$form.MaximizeBox = $false
$form.FormBorderStyle = 'FixedSingle'
if (Test-Path -LiteralPath $script:IconPath) {
  try { $form.Icon = New-Object System.Drawing.Icon($script:IconPath) } catch {}
}

function New-Card([int]$X, [int]$Y, [int]$W, [int]$H) {
  $panel = New-Object System.Windows.Forms.Panel
  $panel.Location = New-Object System.Drawing.Point($X, $Y)
  $panel.Size = New-Object System.Drawing.Size($W, $H)
  $panel.BackColor = [System.Drawing.ColorTranslator]::FromHtml($card)
  $border = New-Object System.Windows.Forms.Panel
  $border.Location = New-Object System.Drawing.Point(0, 0)
  $border.Size = New-Object System.Drawing.Size($W, 1)
  $border.BackColor = [System.Drawing.ColorTranslator]::FromHtml($cardBorder)
  $panel.Controls.Add($border)
  return $panel
}

function New-Label([int]$X, [int]$Y, [int]$W, [int]$H, [string]$Value, [System.Drawing.Font]$Font, [string]$Color, [string]$Align = 'MiddleLeft') {
  $label = New-Object System.Windows.Forms.Label
  $label.Location = New-Object System.Drawing.Point($X, $Y)
  $label.Size = New-Object System.Drawing.Size($W, $H)
  $label.Text = $Value
  $label.Font = $Font
  $label.ForeColor = [System.Drawing.ColorTranslator]::FromHtml($Color)
  $label.BackColor = [System.Drawing.Color]::Transparent
  $label.TextAlign = $Align
  $label.AutoEllipsis = $true
  return $label
}

function New-Button([int]$X, [int]$Y, [int]$W, [int]$H, [string]$Text, [string]$Back, [string]$Fore = '#07121f') {
  $button = New-Object System.Windows.Forms.Button
  $button.Location = New-Object System.Drawing.Point($X, $Y)
  $button.Size = New-Object System.Drawing.Size($W, $H)
  $button.Text = $Text
  $button.FlatStyle = 'Flat'
  $button.FlatAppearance.BorderSize = 0
  $button.BackColor = [System.Drawing.ColorTranslator]::FromHtml($Back)
  $button.ForeColor = [System.Drawing.ColorTranslator]::FromHtml($Fore)
  $button.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 9.5, [System.Drawing.FontStyle]::Bold)
  $button.Cursor = [System.Windows.Forms.Cursors]::Hand
  $button.UseVisualStyleBackColor = $false
  return $button
}

# ---------- header ----------
$header = New-Object System.Windows.Forms.Panel
$header.Location = New-Object System.Drawing.Point(18, 14)
$header.Size = New-Object System.Drawing.Size(784, 76)
$header.BackColor = [System.Drawing.Color]::Transparent
$form.Controls.Add($header)

$lblTitle = New-Label 0 0 400 38 'DSH 守护者' $fontTitle $text
$header.Controls.Add($lblTitle)
$lblSub = New-Label 2 40 560 22 '外部守护进程 · 快照、健康检查、崩溃自动回滚' $fontSmall $muted
$header.Controls.Add($lblSub)

$script:LblPill = New-Object System.Windows.Forms.Label
$script:LblPill.Location = New-Object System.Drawing.Point(630, 14)
$script:LblPill.Size = New-Object System.Drawing.Size(154, 38)
$script:LblPill.TextAlign = 'MiddleCenter'
$script:LblPill.Font = New-Object System.Drawing.Font('Microsoft YaHei UI', 10, [System.Drawing.FontStyle]::Bold)
$script:LblPill.BackColor = [System.Drawing.ColorTranslator]::FromHtml($card)
$script:LblPill.ForeColor = [System.Drawing.ColorTranslator]::FromHtml($muted)
$script:LblPill.Text = '检查中…'
$header.Controls.Add($script:LblPill)

# ---------- status card ----------
$statusCard = New-Card 18 102 470 370
$form.Controls.Add($statusCard)
$statusCard.Controls.Add((New-Label 18 14 300 24 '运行状态' (New-Object System.Drawing.Font('Microsoft YaHei UI', 11, [System.Drawing.FontStyle]::Bold)) $text))

$rowY = 50
$rowGap = 46
function Add-StatusRow([string]$Key, [int]$Y) {
  $label = New-Label 18 $Y 92 26 $Key $fontSmall $muted
  $statusCard.Controls.Add($label)
  $value = New-Label 112 $Y 338 26 '—' $fontValue $text
  $statusCard.Controls.Add($value)
  return $value
}
$script:ValDaemon = Add-StatusRow '守护进程' $rowY
$script:ValApp = Add-StatusRow 'DSH 状态' ($rowY + $rowGap)
$script:ValPhase = Add-StatusRow '当前阶段' ($rowY + $rowGap * 2)
$script:ValBaseline = Add-StatusRow '良好基线' ($rowY + $rowGap * 3)
$script:ValCandidate = Add-StatusRow '插件试用' ($rowY + $rowGap * 4)

$lblEventKey = New-Label 18 ($rowY + $rowGap * 5) 92 24 '最近事件' $fontSmall $muted
$statusCard.Controls.Add($lblEventKey)
$script:ValEvent = New-Label 112 ($rowY + $rowGap * 5) 338 58 '—' $fontSmall $muted
$script:ValEvent.AutoEllipsis = $false
$statusCard.Controls.Add($script:ValEvent)

# ---------- action card ----------
$actionCard = New-Card 502 102 300 370
$form.Controls.Add($actionCard)
$actionCard.Controls.Add((New-Label 18 14 260 24 '操作' (New-Object System.Drawing.Font('Microsoft YaHei UI', 11, [System.Drawing.FontStyle]::Bold)) $text))

$script:BtnToggle = New-Button 18 50 264 38 '启动守护' $accent
$actionCard.Controls.Add($script:BtnToggle)
$script:BtnSnapshot = New-Button 18 98 264 38 '记录为良好版本' '#334155' '#e2e8f0'
$actionCard.Controls.Add($script:BtnSnapshot)
$script:BtnVerify = New-Button 18 146 264 38 '安全重启并验证插件' '#0ea5e9' '#f8fafc'
$actionCard.Controls.Add($script:BtnVerify)
$script:BtnRollback = New-Button 18 194 264 38 '回滚到良好版本' '#b45309' '#fff7ed'
$actionCard.Controls.Add($script:BtnRollback)
$script:BtnRestart = New-Button 18 242 264 34 '仅重启 DSH' '#1e293b' '#cbd5e1'
$actionCard.Controls.Add($script:BtnRestart)
$linkLog = New-Label 20 296 260 22 '打开守护日志 ↗' $fontSmall $accent
$linkLog.Cursor = [System.Windows.Forms.Cursors]::Hand
$actionCard.Controls.Add($linkLog)
$linkReports = New-Label 20 322 260 22 '打开事件报告文件夹 ↗' $fontSmall $accent
$linkReports.Cursor = [System.Windows.Forms.Cursors]::Hand
$actionCard.Controls.Add($linkReports)

# ---------- bottom card ----------
$bottomCard = New-Card 18 486 784 112
$bottomCard.Anchor = 'Bottom,Left,Right'
$form.Controls.Add($bottomCard)
$chkAutoVerify = New-Object System.Windows.Forms.CheckBox
$chkAutoVerify.Location = New-Object System.Drawing.Point(18, 12)
$chkAutoVerify.Size = New-Object System.Drawing.Size(350, 24)
$chkAutoVerify.Text = '安装插件后自动安全重启并验证'
$chkAutoVerify.ForeColor = [System.Drawing.ColorTranslator]::FromHtml($text)
$chkAutoVerify.BackColor = [System.Drawing.Color]::Transparent
$chkAutoVerify.Font = $fontSmall
$bottomCard.Controls.Add($chkAutoVerify)

$chkAutoRestart = New-Object System.Windows.Forms.CheckBox
$chkAutoRestart.Location = New-Object System.Drawing.Point(390, 12)
$chkAutoRestart.Size = New-Object System.Drawing.Size(360, 24)
$chkAutoRestart.Text = 'DSH 意外崩溃时自动重启'
$chkAutoRestart.ForeColor = [System.Drawing.ColorTranslator]::FromHtml($text)
$chkAutoRestart.BackColor = [System.Drawing.Color]::Transparent
$chkAutoRestart.Font = $fontSmall
$bottomCard.Controls.Add($chkAutoRestart)

$script:LblFeedback = New-Label 18 44 748 24 '正在读取守护状态…' $fontSmall $muted
$bottomCard.Controls.Add($script:LblFeedback)

$linkReadme = New-Label 18 74 420 22 '使用说明 · 回滚原理 · 手动命令 ↗' $fontSmall $accent
$linkReadme.Cursor = [System.Windows.Forms.Cursors]::Hand
$bottomCard.Controls.Add($linkReadme)

$lblFooter = New-Label 440 74 326 22 '' $fontSmall $muted 'MiddleRight'
$lblFooter.Anchor = 'Top,Right'
$bottomCard.Controls.Add($lblFooter)

# ---------- behaviour ----------
$phaseColors = @{
  'stable' = $green
  'awaiting' = $amber
  'probation' = $accent
  'verifying' = $blue
  'rolling-back' = $red
  'attention' = $red
  'paused' = $gray
  'starting' = $amber
}

function Update-UI {
  if ($script:Updating) { return }
  $script:Updating = $true
  try {
    $status = Read-JsonFile $script:StatusPath
    $config = Read-JsonFile $script:ConfigPath
    $running = Get-DaemonRunning $status
    $staleSeconds = 999
    if ($status -and $status.updatedAt) {
      $staleSeconds = ([DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - [int64]$status.updatedAt) / 1000
    }
    $stale = $staleSeconds -gt 20

    if ($running -and $status) {
      $script:ValDaemon.Text = "运行中 · PID $($status.daemon.pid) · 已运行 $(Format-Duration $status.daemon.uptimeSec)"
      $script:ValDaemon.ForeColor = [System.Drawing.ColorTranslator]::FromHtml($green)
      $script:BtnToggle.Text = '停止守护'
      $script:BtnToggle.BackColor = [System.Drawing.ColorTranslator]::FromHtml('#475569')
      $script:BtnToggle.ForeColor = [System.Drawing.ColorTranslator]::FromHtml('#f1f5f9')
    } else {
      $script:ValDaemon.Text = if ($stale -and $status) { '无响应（进程可能已退出）' } else { '未运行' }
      $script:ValDaemon.ForeColor = [System.Drawing.ColorTranslator]::FromHtml($gray)
      $script:BtnToggle.Text = '启动守护'
      $script:BtnToggle.BackColor = [System.Drawing.ColorTranslator]::FromHtml($accent)
      $script:BtnToggle.ForeColor = [System.Drawing.ColorTranslator]::FromHtml('#07121f')
    }

    if ($status) {
      $app = $status.app
      $appColor = switch ($app.state) {
        'healthy' { $green }
        'starting' { $amber }
        'degraded' { $red }
        'down' { $gray }
        default { $muted }
      }
      $appText = $app.label
      if ($app.mainPid) { $appText += " · 主进程 $($app.mainPid)" }
      if ($app.port) { $appText += " · 端口 $($app.port)" }
      if ($app.state -eq 'healthy' -and $app.uptimeSec) { $appText += " · $(Format-Duration $app.uptimeSec)" }
      $script:ValApp.Text = $appText
      $script:ValApp.ForeColor = [System.Drawing.ColorTranslator]::FromHtml($appColor)

      $phase = if ($status.paused) { 'paused' } else { $status.phase }
      $script:ValPhase.Text = $status.phaseLabel
      $script:ValPhase.ForeColor = [System.Drawing.ColorTranslator]::FromHtml($(if ($phaseColors.ContainsKey($phase)) { $phaseColors[$phase] } else { $text }))

      if ($status.baseline) {
        $script:ValBaseline.Text = "$($status.baseline.id) · $(Format-Age $status.baseline.createdAt)"
      } else {
        $script:ValBaseline.Text = '尚未建立（等待 DSH 正常运行）'
      }
      $script:ValBaseline.ForeColor = [System.Drawing.ColorTranslator]::FromHtml($(if ($status.baseline) { $text } else { $amber }))

      if ($status.candidate) {
        $candidate = $status.candidate
        $remaining = ''
        if ($candidate.probationRemainingMs -ne $null) {
          $remaining = " · 剩余 $(Format-Duration ($candidate.probationRemainingMs / 1000))"
        }
        $phaseText = switch ($candidate.phase) {
          'awaiting' { '等待 DSH 重启加载' }
          'probation' { '试用期观察中' }
          'verifying' { '启动验证中' }
          default { $candidate.phase }
        }
        $script:ValCandidate.Text = "$phaseText$remaining"
        $script:ValCandidate.ForeColor = [System.Drawing.ColorTranslator]::FromHtml($accent)
      } else {
        $script:ValCandidate.Text = '无'
        $script:ValCandidate.ForeColor = [System.Drawing.ColorTranslator]::FromHtml($muted)
      }

      if ($status.attention -and $status.attention.message) {
        $script:ValEvent.Text = "⚠ $($status.attention.message)"
        $script:ValEvent.ForeColor = [System.Drawing.ColorTranslator]::FromHtml($red)
      } elseif ($status.lastEvent) {
        $script:ValEvent.Text = "$(Format-Time $status.lastEvent.at) · $($status.lastEvent.message)"
        $script:ValEvent.ForeColor = [System.Drawing.ColorTranslator]::FromHtml($muted)
      } else {
        $script:ValEvent.Text = '—'
      }

      $pillPhase = if ($status.paused) { 'paused' } else { $status.phase }
      $pillColor = if ($phaseColors.ContainsKey($pillPhase)) { $phaseColors[$pillPhase] } else { $muted }
      $script:LblPill.Text = $status.phaseLabel
      $script:LblPill.ForeColor = [System.Drawing.ColorTranslator]::FromHtml($pillColor)
      $script:LblPill.BackColor = [System.Drawing.ColorTranslator]::FromHtml('#0f1a2b')

      $script:SuppressConfigEvents = $true
      $chkAutoVerify.Checked = [bool]$config.autoVerify
      $chkAutoRestart.Checked = [bool]$config.autoRestartStable
      $script:SuppressConfigEvents = $false

      $lastUpdate = Format-Time $status.updatedAt
      $lblFooter.Text = if ($stale) { "状态已过期 · $lastUpdate" } else { "自动刷新 · $lastUpdate" }
      if ($stale) { $lblFooter.ForeColor = [System.Drawing.ColorTranslator]::FromHtml($amber) }
      else { $lblFooter.ForeColor = [System.Drawing.ColorTranslator]::FromHtml($muted) }

      if ($stale -and -not $script:AutoStarted) {
        Set-Feedback '守护状态长时间未更新，可能已退出。点「启动守护」重新启动。' $amber
      } elseif (-not $script:HadFirstUpdate -and $running) {
        Set-Feedback '守护已就绪 · 状态每 1.5 秒自动刷新' $muted
      }
      $script:HadFirstUpdate = $true
    } else {
      $script:ValApp.Text = '—'
      $script:ValPhase.Text = '—'
      $script:ValBaseline.Text = '—'
      $script:ValCandidate.Text = '—'
      $script:ValEvent.Text = '尚未生成状态文件，启动守护后会显示。'
      $script:LblPill.Text = '未运行'
      $script:LblPill.ForeColor = [System.Drawing.ColorTranslator]::FromHtml($gray)
      $script:BtnToggle.Text = '启动守护'
      $script:BtnToggle.BackColor = [System.Drawing.ColorTranslator]::FromHtml($accent)
      $script:BtnToggle.ForeColor = [System.Drawing.ColorTranslator]::FromHtml('#07121f')
    }
  } catch {
    Set-Feedback "刷新状态失败：$($_.Exception.Message)" '#ef4444'
  } finally {
    $script:Updating = $false
  }
}

$script:BtnToggle.Add_Click({
  $status = Read-JsonFile $script:StatusPath
  if (Get-DaemonRunning $status) {
    Invoke-Guardian @('stop') '正在停止守护进程…'
  } else {
    Invoke-Guardian @('start') '正在启动守护进程…'
  }
})

$script:BtnSnapshot.Add_Click({
  $answer = [System.Windows.Forms.MessageBox]::Show(
    "把当前 DSH 状态记录为新的良好版本？`n`n只有当前 DSH 运行正常、且没有正在试用的问题插件时才应这样做。",
    '记录为良好版本',
    [System.Windows.Forms.MessageBoxButtons]::YesNo,
    [System.Windows.Forms.MessageBoxIcon]::Question
  )
  if ($answer -eq [System.Windows.Forms.DialogResult]::Yes) {
    Invoke-Guardian @('snapshot', '--note', '面板手动快照') '正在记录良好版本…'
  }
})

$script:BtnVerify.Add_Click({
  $answer = [System.Windows.Forms.MessageBox]::Show(
    "将安全重启 DSH，让新插件真正加载，并观察启动是否成功。`n`n失败时守护会自动回滚到良好版本。重启会中断当前对话（会话已持久化，不会丢失）。`n`n继续？",
    '安全重启并验证插件',
    [System.Windows.Forms.MessageBoxButtons]::YesNo,
    [System.Windows.Forms.MessageBoxIcon]::Warning
  )
  if ($answer -eq [System.Windows.Forms.DialogResult]::Yes) {
    Invoke-Guardian @('verify') '已请求安全重启验证，请稍候…'
  }
})

$script:BtnRollback.Add_Click({
  $status = Read-JsonFile $script:StatusPath
  $baseline = if ($status -and $status.baseline) { $status.baseline.id } else { '最近良好快照' }
  $answer = [System.Windows.Forms.MessageBox]::Show(
    "立即回滚到良好版本 $baseline？`n`n守护会停止 DSH、恢复插件配置、隔离问题插件并重新启动 DSH。",
    '回滚到良好版本',
    [System.Windows.Forms.MessageBoxButtons]::YesNo,
    [System.Windows.Forms.MessageBoxIcon]::Warning
  )
  if ($answer -eq [System.Windows.Forms.DialogResult]::Yes) {
    Invoke-Guardian @('rollback', '--yes') '已请求回滚，请稍候…'
  }
})

$script:BtnRestart.Add_Click({
  $answer = [System.Windows.Forms.MessageBox]::Show(
    "仅重启 DSH（不改变插件配置）？`n`n当前对话会中断，但会话已持久化。",
    '重启 DSH',
    [System.Windows.Forms.MessageBoxButtons]::YesNo,
    [System.Windows.Forms.MessageBoxIcon]::Question
  )
  if ($answer -eq [System.Windows.Forms.DialogResult]::Yes) {
    Invoke-Guardian @('restart') '已请求重启 DSH…'
  }
})

$linkLog.Add_Click({
  if (Test-Path -LiteralPath $script:LogPath) { Start-Process notepad.exe -ArgumentList "`"$script:LogPath`"" }
  else { Set-Feedback '日志文件尚未生成。' $amber }
})

$linkReports.Add_Click({
  if (-not (Test-Path -LiteralPath $script:IncidentsDir)) { New-Item -ItemType Directory -Path $script:IncidentsDir -Force | Out-Null }
  Start-Process explorer.exe -ArgumentList "`"$script:IncidentsDir`""
})

$linkReadme.Add_Click({
  $readme = Join-Path $script:Root 'README.md'
  if (Test-Path -LiteralPath $readme) { Start-Process notepad.exe -ArgumentList "`"$readme`"" }
  else { Set-Feedback 'README.md 尚未生成。' $amber }
})

$chkAutoVerify.Add_CheckedChanged({
  if ($script:SuppressConfigEvents) { return }
  $value = if ($chkAutoVerify.Checked) { 'true' } else { 'false' }
  Invoke-Guardian @('config', 'set', 'autoVerify', $value) "自动验证已$($(if ($chkAutoVerify.Checked) {'开启'} else {'关闭'}))"
})

$chkAutoRestart.Add_CheckedChanged({
  if ($script:SuppressConfigEvents) { return }
  $value = if ($chkAutoRestart.Checked) { 'true' } else { 'false' }
  Invoke-Guardian @('config', 'set', 'autoRestartStable', $value) "崩溃自动重启已$($(if ($chkAutoRestart.Checked) {'开启'} else {'关闭'}))"
})

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 1500
$timer.Add_Tick({ Update-UI })
$timer.Start()

$form.Add_Shown({
  Update-UI
  if (-not $NoAutoStart -and -not $script:AutoStarted) {
    $status = Read-JsonFile $script:StatusPath
    if (-not (Get-DaemonRunning $status)) {
      $script:AutoStarted = $true
      Set-Feedback '正在自动启动守护进程…' $accent
      Invoke-Guardian @('start')
    }
  }
})

$form.Add_FormClosed({
  $timer.Stop()
})

if ($Check) {
  $form.StartPosition = 'Manual'
  $form.Location = New-Object System.Drawing.Point(-4000, -4000)
  $form.Show()
  [System.Windows.Forms.Application]::DoEvents()
  Update-UI
  [System.Windows.Forms.Application]::DoEvents()
  if ($Screenshot) {
    try {
      $bitmap = New-Object System.Drawing.Bitmap($form.Width, $form.Height)
      $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
      $graphics.Clear($form.BackColor)
      $form.DrawToBitmap($bitmap, (New-Object System.Drawing.Rectangle(0, 0, $form.Width, $form.Height)))
      $bitmap.Save($Screenshot, [System.Drawing.Imaging.ImageFormat]::Png)
      $graphics.Dispose()
      $bitmap.Dispose()
      Write-Output "SCREENSHOT_OK $Screenshot"
    } catch {
      Write-Output "SCREENSHOT_FAIL $($_.Exception.Message)"
    }
  }
  Write-Output 'PANEL_OK'
  $form.Close()
  $form.Dispose()
  exit 0
}

[void]$form.ShowDialog()
