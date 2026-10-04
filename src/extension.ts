import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Anthropic pricing per million tokens (Sonnet 4.x)
const PRICING = {
  input: 3.0,
  cacheCreation: 3.75,
  cacheRead: 0.30,
  output: 15.0,
};

interface TokenUsage {
  input_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  output_tokens: number;
  cache_creation?: {
    ephemeral_5m_input_tokens?: number;
    ephemeral_1h_input_tokens?: number;
  };
}

interface UsageEntry {
  timestamp: Date;
  usage: TokenUsage;
  model: string;
}

interface AggregatedUsage {
  inputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  outputTokens: number;
  costUsd: number;
}

function tokenCost(usage: TokenUsage): number {
  return (
    (usage.input_tokens / 1_000_000) * PRICING.input +
    (usage.cache_creation_input_tokens / 1_000_000) * PRICING.cacheCreation +
    (usage.cache_read_input_tokens / 1_000_000) * PRICING.cacheRead +
    (usage.output_tokens / 1_000_000) * PRICING.output
  );
}

function aggregate(entries: UsageEntry[]): AggregatedUsage {
  const result: AggregatedUsage = {
    inputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    outputTokens: 0,
    costUsd: 0,
  };
  for (const e of entries) {
    result.inputTokens += e.usage.input_tokens;
    result.cacheCreationTokens += e.usage.cache_creation_input_tokens;
    result.cacheReadTokens += e.usage.cache_read_input_tokens;
    result.outputTokens += e.usage.output_tokens;
    result.costUsd += tokenCost(e.usage);
  }
  return result;
}

function readJsonlFile(filePath: string): UsageEntry[] {
  const entries: UsageEntry[] = [];
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    for (const line of content.split('\n')) {
      if (!line.trim()) { continue; }
      try {
        const obj = JSON.parse(line);
        if (
          obj.type === 'assistant' &&
          obj.message?.usage &&
          obj.timestamp
        ) {
          entries.push({
            timestamp: new Date(obj.timestamp),
            usage: obj.message.usage as TokenUsage,
            model: obj.message.model ?? 'unknown',
          });
        }
      } catch {
        // skip malformed lines
      }
    }
  } catch {
    // file unreadable
  }
  return entries;
}

function getAllJsonlFiles(claudeDir: string): string[] {
  const projectsDir = path.join(claudeDir, 'projects');
  const files: string[] = [];
  try {
    for (const project of fs.readdirSync(projectsDir)) {
      const projectPath = path.join(projectsDir, project);
      try {
        for (const file of fs.readdirSync(projectPath)) {
          if (file.endsWith('.jsonl')) {
            files.push(path.join(projectPath, file));
          }
        }
      } catch {
        // skip unreadable project dirs
      }
    }
  } catch {
    // projects dir unreadable
  }
  return files;
}

function tokensToMinutes(tokens: number, tokensPerMinute: number): number {
  return tokens / tokensPerMinute;
}

function formatMinutes(minutes: number): string {
  if (minutes < 60) {
    return `${Math.round(minutes)}m`;
  }
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return m > 0 ? `${h}h${m}m` : `${h}h`;
}

function formatCost(usd: number): string {
  if (usd < 0.01) { return `<$0.01`; }
  return `$${usd.toFixed(2)}`;
}

function totalTokens(usage: AggregatedUsage): number {
  return usage.inputTokens + usage.cacheCreationTokens + usage.cacheReadTokens + usage.outputTokens;
}

export function activate(context: vscode.ExtensionContext) {
  const claudeDir = path.join(os.homedir(), '.claude');
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = 'claude-usage.showDetail';
  statusBar.show();

  let lastEntry: UsageEntry | null = null;
  let allEntries: UsageEntry[] = [];

  function loadAllEntries() {
    const files = getAllJsonlFiles(claudeDir);
    const entries: UsageEntry[] = [];
    for (const f of files) {
      entries.push(...readJsonlFile(f));
    }
    entries.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    allEntries = entries;
    lastEntry = entries.length > 0 ? entries[entries.length - 1] : null;
  }

  function updateStatusBar() {
    const config = vscode.workspace.getConfiguration('claude-usage');
    const tokensPerMinute = config.get<number>('tokensPerMinute', 10000);
    const showCost = config.get<boolean>('showCost', false);

    const now = Date.now();
    const fiveHoursAgo = now - 5 * 60 * 60 * 1000;
    const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;

    const entries5h = allEntries.filter(e => e.timestamp.getTime() >= fiveHoursAgo);
    const entries7d = allEntries.filter(e => e.timestamp.getTime() >= sevenDaysAgo);

    const usage5h = aggregate(entries5h);
    const usage7d = aggregate(entries7d);
    const usageLast = lastEntry ? aggregate([lastEntry]) : null;

    let label5h: string;
    let label7d: string;
    let labelLast: string;

    if (showCost) {
      label5h = formatCost(usage5h.costUsd);
      label7d = formatCost(usage7d.costUsd);
    } else {
      const mins5h = tokensToMinutes(totalTokens(usage5h), tokensPerMinute);
      const mins7d = tokensToMinutes(totalTokens(usage7d), tokensPerMinute);
      label5h = formatMinutes(mins5h);
      label7d = formatMinutes(mins7d / 60); // hours
      // reformat 7d as hours
      const hours7d = mins7d / 60;
      label7d = hours7d < 1
        ? `${Math.round(mins7d)}m`
        : `${hours7d.toFixed(1)}h`;
    }

    labelLast = usageLast ? formatCost(usageLast.costUsd) : '$0.00';

    statusBar.text = `$(cloud) 5h:${label5h} 7d:${label7d} last:${labelLast}`;
    statusBar.tooltip = buildTooltip(usage5h, usage7d, usageLast, tokensPerMinute);
  }

  function buildTooltip(
    usage5h: AggregatedUsage,
    usage7d: AggregatedUsage,
    usageLast: AggregatedUsage | null,
    tokensPerMinute: number
  ): vscode.MarkdownString {
    const md = new vscode.MarkdownString('', true);
    md.isTrusted = true;

    const mins5h = tokensToMinutes(totalTokens(usage5h), tokensPerMinute);
    const hours7d = tokensToMinutes(totalTokens(usage7d), tokensPerMinute) / 60;

    md.appendMarkdown('**Claude Usage**\n\n');
    md.appendMarkdown(`| | Tokens | Est. Time | Cost |\n`);
    md.appendMarkdown(`|--|--|--|--|\n`);
    md.appendMarkdown(
      `| **5h block** | ${totalTokens(usage5h).toLocaleString()} | ${formatMinutes(mins5h)} | ${formatCost(usage5h.costUsd)} |\n`
    );
    md.appendMarkdown(
      `| **7 days** | ${totalTokens(usage7d).toLocaleString()} | ${hours7d.toFixed(1)}h | ${formatCost(usage7d.costUsd)} |\n`
    );
    if (usageLast) {
      const minsLast = tokensToMinutes(totalTokens(usageLast), tokensPerMinute);
      md.appendMarkdown(
        `| **Last prompt** | ${totalTokens(usageLast).toLocaleString()} | ${formatMinutes(minsLast)} | ${formatCost(usageLast.costUsd)} |\n`
      );
      md.appendMarkdown('\n---\n');
      md.appendMarkdown(`**Last prompt breakdown:**\n`);
      md.appendMarkdown(`- Input: ${usageLast.inputTokens.toLocaleString()} tokens\n`);
      md.appendMarkdown(`- Cache created: ${usageLast.cacheCreationTokens.toLocaleString()} tokens\n`);
      md.appendMarkdown(`- Cache read: ${usageLast.cacheReadTokens.toLocaleString()} tokens\n`);
      md.appendMarkdown(`- Output: ${usageLast.outputTokens.toLocaleString()} tokens\n`);
    }
    md.appendMarkdown('\n*Click to open detail panel*');
    return md;
  }

  function showDetailPanel() {
    const config = vscode.workspace.getConfiguration('claude-usage');
    const tokensPerMinute = config.get<number>('tokensPerMinute', 10000);

    const now = Date.now();
    const fiveHoursAgo = now - 5 * 60 * 60 * 1000;
    const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000;

    const entries5h = allEntries.filter(e => e.timestamp.getTime() >= fiveHoursAgo);
    const entries7d = allEntries.filter(e => e.timestamp.getTime() >= sevenDaysAgo);
    const usage5h = aggregate(entries5h);
    const usage7d = aggregate(entries7d);
    const usageLast = lastEntry ? aggregate([lastEntry]) : null;

    const mins5h = tokensToMinutes(totalTokens(usage5h), tokensPerMinute);
    const hours7d = tokensToMinutes(totalTokens(usage7d), tokensPerMinute) / 60;

    const panel = vscode.window.createWebviewPanel(
      'claudeUsage',
      'Claude Usage',
      vscode.ViewColumn.One,
      {}
    );

    const lastTimestamp = lastEntry ? lastEntry.timestamp.toLocaleString() : 'N/A';
    const lastModel = lastEntry?.model ?? 'N/A';

    panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Claude Usage</title>
<style>
  body { font-family: var(--vscode-font-family); color: var(--vscode-foreground); background: var(--vscode-editor-background); padding: 24px; max-width: 700px; margin: 0 auto; }
  h1 { font-size: 1.4em; margin-bottom: 4px; }
  .subtitle { color: var(--vscode-descriptionForeground); font-size: 0.85em; margin-bottom: 24px; }
  .cards { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 12px; margin-bottom: 24px; }
  .card { background: var(--vscode-editor-inactiveSelectionBackground); border-radius: 8px; padding: 16px; }
  .card-label { font-size: 0.75em; text-transform: uppercase; letter-spacing: 0.08em; color: var(--vscode-descriptionForeground); margin-bottom: 8px; }
  .card-value { font-size: 2em; font-weight: 700; line-height: 1; }
  .card-sub { font-size: 0.8em; color: var(--vscode-descriptionForeground); margin-top: 6px; }
  .section { margin-bottom: 20px; }
  .section h2 { font-size: 1em; margin-bottom: 10px; color: var(--vscode-descriptionForeground); text-transform: uppercase; letter-spacing: 0.06em; }
  table { width: 100%; border-collapse: collapse; font-size: 0.9em; }
  th { text-align: left; padding: 6px 12px; border-bottom: 1px solid var(--vscode-panel-border); color: var(--vscode-descriptionForeground); font-weight: normal; }
  td { padding: 6px 12px; border-bottom: 1px solid var(--vscode-panel-border); }
  .accent { color: var(--vscode-textLink-foreground); }
  .mono { font-family: var(--vscode-editor-font-family, monospace); }
</style>
</head>
<body>
<h1>☁ Claude Usage</h1>
<div class="subtitle">Parsed from ~/.claude/projects — updated on extension load</div>

<div class="cards">
  <div class="card">
    <div class="card-label">5-Hour Block</div>
    <div class="card-value accent">${formatMinutes(mins5h)}</div>
    <div class="card-sub">${totalTokens(usage5h).toLocaleString()} tokens<br>${formatCost(usage5h.costUsd)}</div>
  </div>
  <div class="card">
    <div class="card-label">7-Day Total</div>
    <div class="card-value accent">${hours7d.toFixed(1)}h</div>
    <div class="card-sub">${totalTokens(usage7d).toLocaleString()} tokens<br>${formatCost(usage7d.costUsd)}</div>
  </div>
  <div class="card">
    <div class="card-label">Last Prompt</div>
    <div class="card-value accent">${usageLast ? formatCost(usageLast.costUsd) : '$0.00'}</div>
    <div class="card-sub">${usageLast ? totalTokens(usageLast).toLocaleString() + ' tokens' : ''}<br><span style="font-size:0.85em">${lastModel}</span></div>
  </div>
</div>

<div class="section">
  <h2>Last Prompt Breakdown</h2>
  <table>
    <tr><th>Type</th><th>Tokens</th><th>Cost</th></tr>
    <tr><td>Input</td><td class="mono">${(usageLast?.inputTokens ?? 0).toLocaleString()}</td><td class="mono">${formatCost(((usageLast?.inputTokens ?? 0) / 1_000_000) * PRICING.input)}</td></tr>
    <tr><td>Cache Creation</td><td class="mono">${(usageLast?.cacheCreationTokens ?? 0).toLocaleString()}</td><td class="mono">${formatCost(((usageLast?.cacheCreationTokens ?? 0) / 1_000_000) * PRICING.cacheCreation)}</td></tr>
    <tr><td>Cache Read</td><td class="mono">${(usageLast?.cacheReadTokens ?? 0).toLocaleString()}</td><td class="mono">${formatCost(((usageLast?.cacheReadTokens ?? 0) / 1_000_000) * PRICING.cacheRead)}</td></tr>
    <tr><td>Output</td><td class="mono">${(usageLast?.outputTokens ?? 0).toLocaleString()}</td><td class="mono">${formatCost(((usageLast?.outputTokens ?? 0) / 1_000_000) * PRICING.output)}</td></tr>
    <tr><td><strong>Total</strong></td><td class="mono"><strong>${usageLast ? totalTokens(usageLast).toLocaleString() : '0'}</strong></td><td class="mono"><strong>${usageLast ? formatCost(usageLast.costUsd) : '$0.00'}</strong></td></tr>
  </table>
  <div style="margin-top:8px; font-size:0.8em; color:var(--vscode-descriptionForeground)">
    Last message: ${lastTimestamp} &nbsp;|&nbsp; Model: ${lastModel}
  </div>
</div>

<div class="section">
  <h2>5-Hour Block Detail</h2>
  <table>
    <tr><th>Type</th><th>Tokens</th><th>Cost</th></tr>
    <tr><td>Input</td><td class="mono">${usage5h.inputTokens.toLocaleString()}</td><td class="mono">${formatCost((usage5h.inputTokens / 1_000_000) * PRICING.input)}</td></tr>
    <tr><td>Cache Creation</td><td class="mono">${usage5h.cacheCreationTokens.toLocaleString()}</td><td class="mono">${formatCost((usage5h.cacheCreationTokens / 1_000_000) * PRICING.cacheCreation)}</td></tr>
    <tr><td>Cache Read</td><td class="mono">${usage5h.cacheReadTokens.toLocaleString()}</td><td class="mono">${formatCost((usage5h.cacheReadTokens / 1_000_000) * PRICING.cacheRead)}</td></tr>
    <tr><td>Output</td><td class="mono">${usage5h.outputTokens.toLocaleString()}</td><td class="mono">${formatCost((usage5h.outputTokens / 1_000_000) * PRICING.output)}</td></tr>
    <tr><td><strong>Total</strong></td><td class="mono"><strong>${totalTokens(usage5h).toLocaleString()}</strong></td><td class="mono"><strong>${formatCost(usage5h.costUsd)}</strong></td></tr>
  </table>
</div>

<div style="font-size:0.75em; color:var(--vscode-descriptionForeground); margin-top:24px">
  Pricing: Input $3/M · Cache creation $3.75/M · Cache read $0.30/M · Output $15/M (Sonnet)<br>
  Time estimate based on ${tokensPerMinute.toLocaleString()} tokens/min — adjust in settings.
</div>
</body>
</html>`;
  }

  // Commands
  context.subscriptions.push(
    vscode.commands.registerCommand('claude-usage.showDetail', showDetailPanel)
  );
  context.subscriptions.push(
    vscode.commands.registerCommand('claude-usage.refresh', () => {
      loadAllEntries();
      updateStatusBar();
    })
  );

  // File watcher for JSONL files
  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(
      vscode.Uri.file(path.join(claudeDir, 'projects')),
      '**/*.jsonl'
    )
  );
  const onFileChange = () => {
    loadAllEntries();
    updateStatusBar();
  };
  watcher.onDidChange(onFileChange);
  watcher.onDidCreate(onFileChange);
  context.subscriptions.push(watcher);

  // Periodic refresh
  const config = vscode.workspace.getConfiguration('claude-usage');
  const intervalSec = config.get<number>('refreshIntervalSeconds', 30);
  const timer = setInterval(() => {
    loadAllEntries();
    updateStatusBar();
  }, intervalSec * 1000);
  context.subscriptions.push({ dispose: () => clearInterval(timer) });

  // Config changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration('claude-usage')) {
        updateStatusBar();
      }
    })
  );

  // Initial load
  loadAllEntries();
  updateStatusBar();

  context.subscriptions.push(statusBar);
}

export function deactivate() {}
