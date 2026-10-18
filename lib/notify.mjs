import { spawn } from 'node:child_process';

function psQuote(value) {
  return `'${String(value ?? '').replaceAll("'", "''")}'`;
}

function clip(value, max = 240) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function notify(config, logger, level, title, message) {
  if (!config?.notify) return;
  const icon = level === 'error' ? 'Error' : level === 'warn' ? 'Warning' : 'Information';
  const script = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$n = New-Object System.Windows.Forms.NotifyIcon
$n.Icon = [System.Drawing.SystemIcons]::${icon}
$n.Visible = $true
$n.ShowBalloonTip(8000, ${psQuote(clip(title, 60))}, ${psQuote(clip(message))}, [System.Windows.Forms.ToolTipIcon]::${icon})
Start-Sleep -Milliseconds 4500
$n.Dispose()
`;
  try {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-Command', script],
      { detached: true, stdio: 'ignore', windowsHide: true },
    );
    child.unref();
    logger?.debug('notify', `${title}：${message}`);
  } catch (error) {
    logger?.warn('notify.failed', '无法显示桌面通知', { error: error instanceof Error ? error.message : String(error) });
  }
}
