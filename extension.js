'use strict';

const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PRICING = {
  input: 3.0,
  cacheCreation: 3.75,
  cacheRead: 0.30,
  output: 15.0,
};

function tokenCost(usage) {
  return (
    (usage.input_tokens / 1_000_000) * PRICING.input +
    (usage.cache_creation_input_tokens / 1_000_000) * PRICING.cacheCreation +
    (usage.cache_read_input_tokens / 1_000_000) * PRICING.cacheRead +
    (usage.output_tokens / 1_000_000) * PRICING.output
  );
}

function aggregate(entries) {
  const result = { inputTokens: 0, cacheCreationTokens: 0, cacheReadTokens: 0, outputTokens: 0, costUsd: 0 };
  for (const e of entries) {
    result.inputTokens += e.usage.input_tokens;
    result.cacheCreationTokens += e.usage.cache_creation_input_tokens;
    result.cacheReadTokens += e.usage.cache_read_input_tokens;
    result.outputTokens += e.usage.output_tokens;
    result.costUsd += tokenCost(e.usage);
  }
  return result;
}

function totalTokens(usage) {
  return usage.inputTokens + usage.cacheCreationTokens + usage.cacheReadTokens + usage.outputTokens;
}

function readJsonlFile(filePath) {
  const entries = [];
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    for (const line of content.split('\n')) {
      if (!line.trim()) { continue; }
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'assistant' && obj.message?.usage && obj.timestamp) {
          const u = obj.message.usage;
          entries.push({
            timestamp: new Date(obj.timestamp),
            usage: {
              input_tokens: u.input_tokens ?? 0,
              cache_creation_input_tokens: u.cache_creation_input_tokens ?? 0,
              cache_read_input_tokens: u.cache_read_input_tokens ?? 0,
              output_tokens: u.output_tokens ?? 0,
            },
            model: obj.message.model ?? 'unknown',
          });
        }
      } catch { /* skip malformed lines */ }
    }
  } catch { /* file unreadable */ }
  return entries;
}

function getAllJsonlFiles(claudeDir) {
  const projectsDir = path.join(claudeDir, 'projects');
  const files = [];
  try {
    for (const project of fs.readdirSync(projectsDir)) {
      const projectPath = path.join(projectsDir, project);
      try {
        for (const file of fs.readdirSync(projectPath)) {
          if (file.endsWith('.jsonl')) {
            files.push(path.join(projectPath, file));
          }
        }
      } catch { /* skip */ }
    }
  } catch { /* skip */ }
  return files;
}

// Format a duration given in milliseconds as "Xh Ym" or "Ym" or "Xs"
function formatDuration(ms) {
  if (ms < 0) { ms = 0; }
  const totalSec = Math.floor(ms / 1000);
  const totalMin = Math.floor(totalSec / 60);
  if (totalMin === 0) { return `${totalSec}s`; }
  if (totalMin < 60) { return `${totalMin}m`; }
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m > 0 ? `${h}h${m}m` : `${h}h`;
}

function formatCost(usd) {
  if (usd < 0.001) { return '$0.00'; }
  if (usd < 0.01) { return `$${usd.toFixed(3)}`; }
  return `$${usd.toFixed(2)}`;
}

// For the 5h block: find the oldest message timestamp within the last 5h
// and report elapsed = now - oldest (wall-clock time used in this block).
// "Remaining" = 5h - elapsed.
function get5hBlockInfo(entries5h) {
  if (entries5h.length === 0) {
    return { elapsed: 0, remaining: 5 * 60 * 60 * 1000, hasActivity: false };
  }
  const oldest = entries5h[0].timestamp.getTime(); // entries are sorted ascending
  const elapsed = Date.now() - oldest;
  const remaining = Math.max(0, 5 * 60 * 60 * 1000 - elapsed);
  return { elapsed, remaining, hasActivity: true };
}

// For the week block: sum output tokens as a rough "hours of compute" proxy,
// or just show cost + token count.
function get7dInfo(entries7d) {
  const usage = aggregate(entries7d);
  // elapsed = now - oldest entry in 7d window (wall-clock days active)
  const oldest = entries7d.length > 0 ? entries7d[0].timestamp.getTime() : Date.now();
  const elapsedDays = (Date.now() - oldest) / (24 * 60 * 60 * 1000);
  return { usage, elapsedDays };
}

function activate(context) {
  const claudeDir = path.join(os.homedir(), '.claude');

  // Named status bar item — required for right-click context menu
  const statusBar = vscode.window.createStatusBarItem(
    'claude-usage.statusbar',
    vscode.StatusBarAlignment.Right,
    100
  );
  statusBar.command = 'claude-usage.showDetail';
  statusBar.name = 'Claude Usage';
  statusBar.show();

  let lastEntry = null;
  let allEntries = [];

  function loadAllEntries() {
    const files = getAllJsonlFiles(claudeDir);
    const entries = [];
    for (const f of files) {
      entries.push(...readJsonlFile(f));
    }
    entries.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    allEntries = entries;
    lastEntry = entries.length > 0 ? entries[entries.length - 1] : null;
  }

  function updateStatusBar() {
    const now = Date.now();
    const fiveHoursAgo = now - 5 * 60 * 60 * 1000;
    const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;

    const entries5h = allEntries.filter(e => e.timestamp.getTime() >= fiveHoursAgo);
    const entries7d = allEntries.filter(e => e.timestamp.getTime() >= sevenDaysAgo);

    const blockInfo = get5hBlockInfo(entries5h);
    const usage7d = aggregate(entries7d);
    const usageLast = lastEntry ? aggregate([lastEntry]) : null;

    // 5h: show elapsed/5h (wall-clock time, not token math)
    const label5h = blockInfo.hasActivity
      ? `${formatDuration(blockInfo.elapsed)}/5h`
      : `—/5h`;

    // 7d: show cost
    const label7d = formatCost(usage7d.costUsd);

    // last prompt: cost
    const labelLast = usageLast ? formatCost(usageLast.costUsd) : '$—';

    statusBar.text = `$(cloud) 5h:${label5h} 7d:${label7d} last:${labelLast}`;

    // Tooltip
    const md = new vscode.MarkdownString('', true);
    md.isTrusted = true;
    md.appendMarkdown('**Claude Usage**\n\n');
    md.appendMarkdown('| | Value |\n|--|--|\n');
    md.appendMarkdown(`| **5h elapsed** | ${formatDuration(blockInfo.elapsed)} of 5h |\n`);
    md.appendMarkdown(`| **5h resets in** | ${formatDuration(blockInfo.remaining)} |\n`);
    md.appendMarkdown(`| **5h tokens** | ${totalTokens(aggregate(entries5h)).toLocaleString()} |\n`);
    md.appendMarkdown(`| **5h cost** | ${formatCost(aggregate(entries5h).costUsd)} |\n`);
    md.appendMarkdown(`| **7d cost** | ${formatCost(usage7d.costUsd)} |\n`);
    md.appendMarkdown(`| **7d tokens** | ${totalTokens(usage7d).toLocaleString()} |\n`);
    if (usageLast) {
      md.appendMarkdown(`| **Last prompt** | ${formatCost(usageLast.costUsd)} (${totalTokens(usageLast).toLocaleString()} tok) |\n`);
      md.appendMarkdown(`| **Last model** | ${lastEntry?.model ?? '?'} |\n`);
    }
    md.appendMarkdown('\n*Click: detail panel · Right-click: refresh*');
    statusBar.tooltip = md;
  }

  function showDetailPanel() {
    const now = Date.now();
    const fiveHoursAgo = now - 5 * 60 * 60 * 1000;
    const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;

    const entries5h = allEntries.filter(e => e.timestamp.getTime() >= fiveHoursAgo);
    const entries7d = allEntries.filter(e => e.timestamp.getTime() >= sevenDaysAgo);
    const usage5h = aggregate(entries5h);
    const usage7d = aggregate(entries7d);
    const usageLast = lastEntry ? aggregate([lastEntry]) : null;
    const blockInfo = get5hBlockInfo(entries5h);

    const lastTimestamp = lastEntry ? lastEntry.timestamp.toLocaleString() : 'N/A';
    const lastModel = lastEntry?.model ?? 'N/A';

    const row = (label, tok, cost) =>
      `<tr><td>${label}</td><td class="mono">${tok.toLocaleString()}</td><td class="mono">${formatCost(cost)}</td></tr>`;

    const panel = vscode.window.createWebviewPanel('claudeUsage', 'Claude Usage', vscode.ViewColumn.One, {});
    panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Claude Usage</title>
<style>
  body{font-family:var(--vscode-font-family);color:var(--vscode-foreground);background:var(--vscode-editor-background);padding:24px;max-width:720px;margin:0 auto}
  h1{font-size:1.4em;margin-bottom:4px}
  .sub{color:var(--vscode-descriptionForeground);font-size:.85em;margin-bottom:24px}
  .cards{display:grid;grid-template-columns:repeat(3,1fr);gap:12px;margin-bottom:28px}
  .card{background:var(--vscode-editor-inactiveSelectionBackground);border-radius:8px;padding:16px}
  .clabel{font-size:.72em;text-transform:uppercase;letter-spacing:.08em;color:var(--vscode-descriptionForeground);margin-bottom:8px}
  .cval{font-size:2em;font-weight:700;line-height:1;color:var(--vscode-textLink-foreground)}
  .csub{font-size:.8em;color:var(--vscode-descriptionForeground);margin-top:6px}
  .progress-wrap{margin-top:8px;background:var(--vscode-panel-border);border-radius:4px;height:6px;overflow:hidden}
  .progress-bar{height:100%;border-radius:4px;background:var(--vscode-textLink-foreground);transition:width .3s}
  section{margin-bottom:24px}
  section h2{font-size:.85em;text-transform:uppercase;letter-spacing:.06em;color:var(--vscode-descriptionForeground);margin-bottom:10px}
  table{width:100%;border-collapse:collapse;font-size:.9em}
  th{text-align:left;padding:6px 12px;border-bottom:1px solid var(--vscode-panel-border);color:var(--vscode-descriptionForeground);font-weight:normal}
  td{padding:6px 12px;border-bottom:1px solid var(--vscode-panel-border)}
  .mono{font-family:var(--vscode-editor-font-family,monospace)}
  .note{font-size:.75em;color:var(--vscode-descriptionForeground);margin-top:20px}
  button{background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;padding:6px 14px;border-radius:4px;cursor:pointer;font-size:.85em}
  button:hover{background:var(--vscode-button-hoverBackground)}
</style>
</head>
<body>
<h1>&#9729; Claude Usage</h1>
<div class="sub">Source: ~/.claude/projects &mdash; all projects, all sessions</div>

<div class="cards">
  <div class="card">
    <div class="clabel">5h Block Elapsed</div>
    <div class="cval">${formatDuration(blockInfo.elapsed)}</div>
    <div class="csub">resets in <strong>${formatDuration(blockInfo.remaining)}</strong></div>
    <div class="progress-wrap">
      <div class="progress-bar" style="width:${Math.min(100, (blockInfo.elapsed / (5*60*60*1000))*100).toFixed(1)}%"></div>
    </div>
  </div>
  <div class="card">
    <div class="clabel">7-Day Cost</div>
    <div class="cval">${formatCost(usage7d.costUsd)}</div>
    <div class="csub">${totalTokens(usage7d).toLocaleString()} tokens</div>
  </div>
  <div class="card">
    <div class="clabel">Last Prompt</div>
    <div class="cval">${usageLast ? formatCost(usageLast.costUsd) : '$—'}</div>
    <div class="csub">${usageLast ? totalTokens(usageLast).toLocaleString() + ' tokens' : '—'}<br><span style="font-size:.85em">${lastModel}</span></div>
  </div>
</div>

<section>
  <h2>Last Prompt Breakdown</h2>
  <table>
    <tr><th>Type</th><th>Tokens</th><th>Cost</th></tr>
    ${row('Input', usageLast?.inputTokens ?? 0, ((usageLast?.inputTokens ?? 0) / 1e6) * PRICING.input)}
    ${row('Cache Creation', usageLast?.cacheCreationTokens ?? 0, ((usageLast?.cacheCreationTokens ?? 0) / 1e6) * PRICING.cacheCreation)}
    ${row('Cache Read', usageLast?.cacheReadTokens ?? 0, ((usageLast?.cacheReadTokens ?? 0) / 1e6) * PRICING.cacheRead)}
    ${row('Output', usageLast?.outputTokens ?? 0, ((usageLast?.outputTokens ?? 0) / 1e6) * PRICING.output)}
    <tr><td><strong>Total</strong></td><td class="mono"><strong>${usageLast ? totalTokens(usageLast).toLocaleString() : '0'}</strong></td><td class="mono"><strong>${usageLast ? formatCost(usageLast.costUsd) : '$0.00'}</strong></td></tr>
  </table>
  <div style="margin-top:8px;font-size:.8em;color:var(--vscode-descriptionForeground)">${lastTimestamp} &nbsp;|&nbsp; ${lastModel}</div>
</section>

<section>
  <h2>5-Hour Block Detail (last 5h)</h2>
  <table>
    <tr><th>Type</th><th>Tokens</th><th>Cost</th></tr>
    ${row('Input', usage5h.inputTokens, (usage5h.inputTokens / 1e6) * PRICING.input)}
    ${row('Cache Creation', usage5h.cacheCreationTokens, (usage5h.cacheCreationTokens / 1e6) * PRICING.cacheCreation)}
    ${row('Cache Read', usage5h.cacheReadTokens, (usage5h.cacheReadTokens / 1e6) * PRICING.cacheRead)}
    ${row('Output', usage5h.outputTokens, (usage5h.outputTokens / 1e6) * PRICING.output)}
    <tr><td><strong>Total</strong></td><td class="mono"><strong>${totalTokens(usage5h).toLocaleString()}</strong></td><td class="mono"><strong>${formatCost(usage5h.costUsd)}</strong></td></tr>
  </table>
</section>

<div class="note">
  Pricing: Input $3/M &middot; Cache creation $3.75/M &middot; Cache read $0.30/M &middot; Output $15/M (Sonnet 4.x)<br>
  5h elapsed = wall-clock time since your first message in the current 5h window.
</div>
</body>
</html>`;
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('claude-usage.showDetail', showDetailPanel)
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claude-usage.refresh', () => {
      loadAllEntries();
      updateStatusBar();
      vscode.window.setStatusBarMessage('Claude usage refreshed', 2000);
    })
  );

  // File watcher — updates immediately when a new Claude response lands
  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(
      vscode.Uri.file(path.join(claudeDir, 'projects')),
      '**/*.jsonl'
    )
  );
  const onFileChange = () => { loadAllEntries(); updateStatusBar(); };
  watcher.onDidChange(onFileChange);
  watcher.onDidCreate(onFileChange);
  context.subscriptions.push(watcher);

  // Periodic refresh (for the elapsed/remaining countdown)
  const intervalSec = vscode.workspace.getConfiguration('claude-usage').get('refreshIntervalSeconds', 30);
  const timer = setInterval(() => updateStatusBar(), intervalSec * 1000);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('claude-usage')) { loadAllEntries(); updateStatusBar(); }
    })
  );

  loadAllEntries();
  updateStatusBar();
  context.subscriptions.push(statusBar);
}

function deactivate() {}

module.exports = { activate, deactivate };
