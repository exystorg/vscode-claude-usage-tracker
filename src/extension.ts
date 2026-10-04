import * as vscode from 'vscode';
import * as path from 'path';
import * as os from 'os';
import {
  Breakdown,
  FIVE_HOURS_MS,
  SEVEN_DAYS_MS,
  Totals,
  TranscriptCache,
  UsageEntry,
  entryCost,
  formatCost,
  formatDuration,
  formatTokens,
  lastEntry,
  mergePricing,
  PricingTable,
  sortedByCost,
  splitModelEffortKey,
  startOfToday,
  summarize,
} from './usage';

const CONFIG = 'claude-usage';
const PRICING_NOTE = 'Costs are API list-price equivalents (not subscription billing).';

interface Snapshot {
  now: number;
  table: PricingTable;
  windows: { label: string; b: Breakdown }[];
  last?: UsageEntry;
  lastCost: number | null;
}

function esc(s: string): string {
  return s.replace(/[\\|*_`<>[\]]/g, m => `\\${m}`);
}

function costCell(t: Totals): string {
  return t.unpriced ? `${formatCost(t.cost)} ⚠` : formatCost(t.cost);
}

export function activate(context: vscode.ExtensionContext) {
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  const cache = new TranscriptCache(projectsDir);
  const output = vscode.window.createOutputChannel('Claude Usage');

  // Named item: the id is what the statusBar/item/context menu in package.json matches on.
  const statusBar = vscode.window.createStatusBarItem('claude-usage.statusbar', vscode.StatusBarAlignment.Right, 100);
  statusBar.name = 'Claude Usage';
  statusBar.command = 'claude-usage.showDetail';
  statusBar.text = '$(cloud) Claude usage…';
  statusBar.show();

  function snapshot(): Snapshot {
    const now = Date.now();
    const table = mergePricing(vscode.workspace.getConfiguration(CONFIG).get('pricing'));
    const entries = cache.entries();
    const last = lastEntry(entries);
    return {
      now,
      table,
      windows: [
        { label: '5h', b: summarize(entries, table, now - FIVE_HOURS_MS) },
        { label: 'Today', b: summarize(entries, table, startOfToday(now)) },
        { label: '7d', b: summarize(entries, table, now - SEVEN_DAYS_MS) },
      ],
      last,
      lastCost: last ? entryCost(last, table) : null,
    };
  }

  function buildTooltip(s: Snapshot): vscode.MarkdownString {
    const md = new vscode.MarkdownString('', true);
    md.isTrusted = { enabledCommands: ['claude-usage.showDetail', 'claude-usage.refresh'] };
    md.appendMarkdown('**Claude Usage**\n\n');

    let anyUnpriced = false;
    for (const { label, b } of s.windows) {
      anyUnpriced ||= b.total.unpriced;
      md.appendMarkdown(`| **${label}** | In | Cache W | Cache R | Out | Cost |\n|:--|--:|--:|--:|--:|--:|\n`);
      const row = (name: string, t: Totals) =>
        `| ${name} | ${formatTokens(t.input)} | ${formatTokens(t.cacheWrite)} | ${formatTokens(t.cacheRead)} | ${formatTokens(t.output)} | ${costCell(t)} |\n`;
      md.appendMarkdown(row('**Total**', b.total));
      for (const [model, t] of sortedByCost(b.byModel)) { md.appendMarkdown(row(esc(model), t)); }
      for (const [effort, t] of sortedByCost(b.byEffort)) { md.appendMarkdown(row(`*effort: ${esc(effort)}*`, t)); }
      md.appendMarkdown('\n');
    }

    const fiveH = s.windows[0].b;
    if (fiveH.oldest !== undefined) {
      const age = s.now - fiveH.oldest;
      md.appendMarkdown(
        `5h window: oldest activity ${formatDuration(age)} ago, rolls off in ${formatDuration(FIVE_HOURS_MS - age)}\n\n`
      );
    }

    if (s.last) {
      const cost = s.lastCost === null ? '$0.00 ⚠' : formatCost(s.lastCost);
      md.appendMarkdown(
        `**Last prompt:** ${cost} · ${esc(s.last.model)} · effort ${esc(s.last.effort)} · ` +
        `${formatTokens(s.last.input + s.last.cacheWrite5m + s.last.cacheWrite1h + s.last.cacheRead + s.last.output)} tok · ` +
        `${new Date(s.last.timestamp).toLocaleTimeString()}\n\n`
      );
      anyUnpriced ||= s.lastCost === null;
    }
    if (anyUnpriced) {
      md.appendMarkdown('⚠ Includes models with no price (counted as $0); set `claude-usage.pricing` to add them.\n\n');
    }
    md.appendMarkdown(`*${PRICING_NOTE}*\n\n`);
    md.appendMarkdown('[Show detail](command:claude-usage.showDetail) · [Refresh](command:claude-usage.refresh)');
    return md;
  }

  function render() {
    const s = snapshot();
    const [fiveH, , sevenD] = s.windows;
    const last = s.last ? (s.lastCost === null ? '$0.00' : `$${s.lastCost.toFixed(2)}`) : '$—';
    statusBar.text = `$(cloud) 5h:$${fiveH.b.total.cost.toFixed(2)} 7d:$${sevenD.b.total.cost.toFixed(2)} last:${last}`;
    statusBar.tooltip = buildTooltip(s);
  }

  function refresh() {
    try {
      cache.refresh();
    } catch (err) {
      output.appendLine(`[refresh] ${String(err)}`);
    }
    render();
  }

  function showDetail() {
    refresh();
    const s = snapshot();
    const pad = (v: string, n: number) => v.padStart(n);
    const header = `${'group'.padEnd(36)}${pad('resp', 7)}${pad('input', 10)}${pad('cacheW', 10)}${pad('cacheR', 10)}${pad('output', 10)}${pad('cost', 11)}`;
    const line = (name: string, t: Totals) =>
      `${name.padEnd(36)}${pad(String(t.responses), 7)}${pad(formatTokens(t.input), 10)}${pad(formatTokens(t.cacheWrite), 10)}` +
      `${pad(formatTokens(t.cacheRead), 10)}${pad(formatTokens(t.output), 10)}${pad(formatCost(t.cost) + (t.unpriced ? '!' : ''), 11)}`;

    output.clear();
    output.appendLine(`Claude Usage — ${new Date(s.now).toLocaleString()}`);
    output.appendLine(`Source: ${projectsDir} (${cache.fileCount()} transcript files, incl. subagents)`);
    output.appendLine(PRICING_NOTE + ' "!" = includes unpriced models counted as $0.');
    for (const { label, b } of s.windows) {
      output.appendLine('');
      output.appendLine(`=== ${label} ===`);
      output.appendLine(header);
      output.appendLine(line('TOTAL', b.total));
      output.appendLine('-- by model');
      for (const [k, t] of sortedByCost(b.byModel)) { output.appendLine(line(k, t)); }
      output.appendLine('-- by effort');
      for (const [k, t] of sortedByCost(b.byEffort)) { output.appendLine(line(k, t)); }
      output.appendLine('-- by model x effort');
      for (const [k, t] of sortedByCost(b.byModelEffort)) {
        const [m, e] = splitModelEffortKey(k);
        output.appendLine(line(`${m} / ${e}`, t));
      }
      if (label === '5h' && b.oldest !== undefined) {
        const age = s.now - b.oldest;
        output.appendLine(`oldest activity ${formatDuration(age)} ago; rolls off in ${formatDuration(FIVE_HOURS_MS - age)}`);
      }
    }
    output.appendLine('');
    if (s.last) {
      const l = s.last;
      output.appendLine(`=== Last prompt (${new Date(l.timestamp).toLocaleString()}) ===`);
      output.appendLine(`model ${l.model} · effort ${l.effort} · cost ${s.lastCost === null ? '$0.00 (unpriced)' : formatCost(s.lastCost)}`);
      output.appendLine(
        `input ${l.input} · cache write ${l.cacheWrite5m + l.cacheWrite1h} (5m ${l.cacheWrite5m}, 1h ${l.cacheWrite1h}) · ` +
        `cache read ${l.cacheRead} · output ${l.output}`
      );
    } else {
      output.appendLine('No assistant messages found.');
    }
    output.appendLine('');
    output.appendLine('Prices (USD/MTok, longest model-prefix match; cache write 5m 1.25x / 1h 2x input, cache read 0.1x input):');
    for (const [k, p] of Object.entries(s.table)) { output.appendLine(`  ${k.padEnd(28)} in ${p.input}  out ${p.output}`); }
    output.show(true);
  }

  context.subscriptions.push(
    output,
    statusBar,
    vscode.commands.registerCommand('claude-usage.showDetail', showDetail),
    vscode.commands.registerCommand('claude-usage.refresh', () => {
      refresh();
      vscode.window.setStatusBarMessage('Claude usage refreshed', 2000);
    })
  );

  // Transcript files are appended line-by-line while streaming, so debounce watcher events.
  let debounce: NodeJS.Timeout | undefined;
  const onFileEvent = () => {
    if (debounce) { clearTimeout(debounce); }
    debounce = setTimeout(refresh, 750);
  };
  const watcher = vscode.workspace.createFileSystemWatcher(
    new vscode.RelativePattern(vscode.Uri.file(projectsDir), '**/*.jsonl')
  );
  watcher.onDidChange(onFileEvent);
  watcher.onDidCreate(onFileEvent);
  watcher.onDidDelete(onFileEvent);
  context.subscriptions.push(watcher, { dispose: () => debounce && clearTimeout(debounce) });

  // Periodic refresh: catches anything the watcher misses and keeps rolling windows current.
  // Cheap, because only changed files (by mtime+size) are re-parsed.
  let timer: NodeJS.Timeout | undefined;
  const startTimer = () => {
    if (timer) { clearInterval(timer); }
    const sec = vscode.workspace.getConfiguration(CONFIG).get<number>('refreshIntervalSeconds', 30);
    timer = setInterval(refresh, Math.max(5, sec || 30) * 1000);
  };
  startTimer();
  context.subscriptions.push({ dispose: () => timer && clearInterval(timer) });

  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration(e => {
      if (e.affectsConfiguration(`${CONFIG}.refreshIntervalSeconds`)) { startTimer(); }
      if (e.affectsConfiguration(CONFIG)) { render(); }
    })
  );

  refresh();
}

export function deactivate() {}
