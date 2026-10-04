// Transcript parsing, pricing and aggregation for Claude Code usage.
// Deliberately free of any `vscode` import so it can be unit-tested with plain Node.

import * as fs from 'fs';
import * as path from 'path';

// ---------------------------------------------------------------------------
// Pricing
// ---------------------------------------------------------------------------

/** USD per million tokens. */
export interface PriceEntry {
  input: number;
  output: number;
}

export type PricingTable = Record<string, PriceEntry>;

/**
 * Default per-model prices, matched against `message.model` by longest prefix.
 *
 * NOTE: these are API list-price equivalents, not subscription billing. On a
 * Pro/Max plan the figures are a "what this would have cost on the API"
 * yardstick, not money actually charged.
 */
export const DEFAULT_PRICING: Readonly<PricingTable> = Object.freeze({
  'claude-fable-5-1': { input: 10, output: 50 },
  'claude-opus-5-5': { input: 4, output: 20 },
  'claude-opus-5': { input: 5, output: 25 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-haiku-4-5': { input: 1, output: 5 },
});

/** Cache write/read multipliers applied to the model's input price. */
export const CACHE_WRITE_5M_MULTIPLIER = 1.25;
export const CACHE_WRITE_1H_MULTIPLIER = 2;
export const CACHE_READ_MULTIPLIER = 0.1;

export const UNKNOWN_MODEL = 'unknown';
export const UNSPECIFIED_EFFORT = 'unspecified';

function isFiniteNonNeg(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

/**
 * Merge a user-supplied pricing object (the `claude-usage.pricing` setting) over
 * the defaults. Malformed entries are ignored.
 */
export function mergePricing(user: unknown): PricingTable {
  const table: PricingTable = { ...DEFAULT_PRICING };
  if (user && typeof user === 'object' && !Array.isArray(user)) {
    for (const [prefix, v] of Object.entries(user as Record<string, unknown>)) {
      if (!prefix || !v || typeof v !== 'object') { continue; }
      const { input, output } = v as Record<string, unknown>;
      if (isFiniteNonNeg(input) && isFiniteNonNeg(output)) {
        table[prefix] = { input, output };
      }
    }
  }
  return table;
}

/** Longest-prefix lookup. Returns undefined for unpriced/unknown models. */
export function resolvePrice(model: string, table: PricingTable): PriceEntry | undefined {
  if (!model || model === UNKNOWN_MODEL) { return undefined; }
  let best: string | undefined;
  for (const prefix of Object.keys(table)) {
    if (model.startsWith(prefix) && (best === undefined || prefix.length > best.length)) {
      best = prefix;
    }
  }
  return best === undefined ? undefined : table[best];
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

export interface UsageEntry {
  /** Dedupe key: message.id, else requestId, else a per-line synthetic key. */
  key: string;
  /** Epoch ms. */
  timestamp: number;
  model: string;
  effort: string;
  input: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  output: number;
}

function num(v: unknown): number {
  return isFiniteNonNeg(v) ? v : 0;
}

function normModel(v: unknown): string {
  if (typeof v !== 'string' || !v || v === '<synthetic>') { return UNKNOWN_MODEL; }
  return v;
}

function normEffort(effort: unknown, perTurn: unknown): string {
  if (typeof effort === 'string' && effort) { return effort; }
  if (typeof perTurn === 'string' && perTurn) { return perTurn; }
  return UNSPECIFIED_EFFORT;
}

/**
 * Parse one transcript line. Returns null for anything that is not a
 * well-formed assistant message with usage and a valid timestamp.
 */
export function parseLine(line: string, fallbackKey: string): UsageEntry | null {
  if (!line || !line.trim()) { return null; }
  let obj: any;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  if (!obj || typeof obj !== 'object' || obj.type !== 'assistant') { return null; }
  const msg = obj.message;
  const usage = msg && typeof msg === 'object' ? msg.usage : undefined;
  if (!usage || typeof usage !== 'object') { return null; }
  const ts = typeof obj.timestamp === 'string' || typeof obj.timestamp === 'number'
    ? new Date(obj.timestamp).getTime()
    : NaN;
  if (!Number.isFinite(ts)) { return null; }

  // Cache-write split by TTL. When the split is absent, all writes count as 5m.
  const cc = usage.cache_creation && typeof usage.cache_creation === 'object' ? usage.cache_creation : undefined;
  const split5m = cc ? num(cc.ephemeral_5m_input_tokens) : 0;
  const split1h = cc ? num(cc.ephemeral_1h_input_tokens) : 0;
  const cwTotal = isFiniteNonNeg(usage.cache_creation_input_tokens)
    ? usage.cache_creation_input_tokens
    : split5m + split1h;
  const cacheWrite1h = Math.min(split1h, cwTotal);
  const cacheWrite5m = cwTotal - cacheWrite1h;

  const key =
    (typeof msg.id === 'string' && msg.id) ||
    (typeof obj.requestId === 'string' && obj.requestId) ||
    fallbackKey;

  return {
    key,
    timestamp: ts,
    model: normModel(msg.model),
    effort: normEffort(obj.effort, obj.perTurnEffort),
    input: num(usage.input_tokens),
    cacheWrite5m,
    cacheWrite1h,
    cacheRead: num(usage.cache_read_input_tokens),
    output: num(usage.output_tokens),
  };
}

/**
 * Fold a duplicate (same key) into an existing entry. Claude Code writes one API
 * response as several lines sharing message.id; usage is normally identical, but
 * streaming can leave an early line with a partial output_tokens count, so take
 * the field-wise maximum rather than summing.
 */
function mergeInto(a: UsageEntry, b: UsageEntry): void {
  a.input = Math.max(a.input, b.input);
  a.cacheWrite5m = Math.max(a.cacheWrite5m, b.cacheWrite5m);
  a.cacheWrite1h = Math.max(a.cacheWrite1h, b.cacheWrite1h);
  a.cacheRead = Math.max(a.cacheRead, b.cacheRead);
  a.output = Math.max(a.output, b.output);
  if (b.timestamp < a.timestamp) { a.timestamp = b.timestamp; }
}

/** Add entries into a key->entry map, deduplicating by key. */
export function dedupeInto(map: Map<string, UsageEntry>, entries: Iterable<UsageEntry>): void {
  for (const e of entries) {
    const existing = map.get(e.key);
    if (existing) {
      mergeInto(existing, e);
    } else {
      map.set(e.key, { ...e });
    }
  }
}

/** Parse a whole JSONL document; result is deduplicated by key. */
export function parseJsonl(content: string, sourceId = ''): UsageEntry[] {
  const map = new Map<string, UsageEntry>();
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const e = parseLine(lines[i], `${sourceId}#${i}`);
    if (e) { dedupeInto(map, [e]); }
  }
  return [...map.values()];
}

/**
 * Recursively list `.jsonl` files under `root` (covers both
 * `<project>/*.jsonl` and `<project>/<session>/subagents/*.jsonl`).
 * Unreadable directories are skipped.
 */
export function findJsonlFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    let dirents: fs.Dirent[];
    try {
      dirents = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of dirents) {
      const p = path.join(dir, d.name);
      if (d.isDirectory()) {
        walk(p);
      } else if (d.isFile() && d.name.endsWith('.jsonl')) {
        out.push(p);
      }
    }
  };
  walk(root);
  return out;
}

// ---------------------------------------------------------------------------
// Incremental per-file cache
// ---------------------------------------------------------------------------

interface CachedFile {
  mtimeMs: number;
  size: number;
  entries: UsageEntry[];
}

export interface TranscriptCacheOptions {
  /**
   * Files whose mtime is older than this are not parsed (their entries cannot
   * fall inside any window we display). Default: 8 days. Use Infinity to parse all.
   */
  maxAgeMs?: number;
}

export class TranscriptCache {
  private files = new Map<string, CachedFile>();
  private merged: UsageEntry[] | null = null;
  /** Number of file parses performed (exposed for tests). */
  parseCount = 0;
  private readonly maxAgeMs: number;

  constructor(private readonly root: string, opts: TranscriptCacheOptions = {}) {
    this.maxAgeMs = opts.maxAgeMs ?? 8 * 24 * 60 * 60 * 1000;
  }

  /** Re-stat all files and re-parse only those whose mtime or size changed. */
  refresh(now = Date.now()): boolean {
    let changed = false;
    const seen = new Set<string>();
    for (const file of findJsonlFiles(this.root)) {
      seen.add(file);
      let st: fs.Stats;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      const cached = this.files.get(file);
      if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) { continue; }
      let entries: UsageEntry[] = [];
      if (now - st.mtimeMs <= this.maxAgeMs) {
        try {
          entries = parseJsonl(fs.readFileSync(file, 'utf-8'), file);
          this.parseCount++;
        } catch {
          entries = [];
        }
      }
      this.files.set(file, { mtimeMs: st.mtimeMs, size: st.size, entries });
      changed = true;
    }
    for (const file of [...this.files.keys()]) {
      if (!seen.has(file)) {
        this.files.delete(file);
        changed = true;
      }
    }
    if (changed) { this.merged = null; }
    return changed;
  }

  /** All entries across files, deduplicated globally and sorted by timestamp. */
  entries(): UsageEntry[] {
    if (!this.merged) {
      const map = new Map<string, UsageEntry>();
      for (const f of this.files.values()) { dedupeInto(map, f.entries); }
      this.merged = [...map.values()].sort((a, b) => a.timestamp - b.timestamp);
    }
    return this.merged;
  }

  fileCount(): number {
    return this.files.size;
  }
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export interface Totals {
  responses: number;
  input: number;
  cacheWrite: number;
  cacheRead: number;
  output: number;
  cost: number;
  /** True if any contributing entry had no price (counted as $0). */
  unpriced: boolean;
}

export function emptyTotals(): Totals {
  return { responses: 0, input: 0, cacheWrite: 0, cacheRead: 0, output: 0, cost: 0, unpriced: false };
}

export function totalTokens(t: Totals): number {
  return t.input + t.cacheWrite + t.cacheRead + t.output;
}

/** Cost of one entry in USD, or null if the model has no price. */
export function entryCost(e: UsageEntry, table: PricingTable): number | null {
  const p = resolvePrice(e.model, table);
  if (!p) { return null; }
  return (
    e.input * p.input +
    e.cacheWrite5m * p.input * CACHE_WRITE_5M_MULTIPLIER +
    e.cacheWrite1h * p.input * CACHE_WRITE_1H_MULTIPLIER +
    e.cacheRead * p.input * CACHE_READ_MULTIPLIER +
    e.output * p.output
  ) / 1_000_000;
}

function addTo(t: Totals, e: UsageEntry, cost: number | null): void {
  t.responses++;
  t.input += e.input;
  t.cacheWrite += e.cacheWrite5m + e.cacheWrite1h;
  t.cacheRead += e.cacheRead;
  t.output += e.output;
  if (cost === null) { t.unpriced = true; } else { t.cost += cost; }
}

export interface Breakdown {
  total: Totals;
  byModel: Map<string, Totals>;
  byEffort: Map<string, Totals>;
  /** Keyed by `${model}\u0000${effort}`; use splitModelEffortKey to unpack. */
  byModelEffort: Map<string, Totals>;
  /** Timestamp of the oldest entry in the window, if any. */
  oldest?: number;
}

export function splitModelEffortKey(k: string): [string, string] {
  const i = k.indexOf('\u0000');
  return [k.slice(0, i), k.slice(i + 1)];
}

function bucket(map: Map<string, Totals>, key: string): Totals {
  let t = map.get(key);
  if (!t) { t = emptyTotals(); map.set(key, t); }
  return t;
}

/** Aggregate entries with timestamp >= since (entries need not be sorted). */
export function summarize(entries: readonly UsageEntry[], table: PricingTable, since = -Infinity): Breakdown {
  const b: Breakdown = { total: emptyTotals(), byModel: new Map(), byEffort: new Map(), byModelEffort: new Map() };
  for (const e of entries) {
    if (e.timestamp < since) { continue; }
    const cost = entryCost(e, table);
    addTo(b.total, e, cost);
    addTo(bucket(b.byModel, e.model), e, cost);
    addTo(bucket(b.byEffort, e.effort), e, cost);
    addTo(bucket(b.byModelEffort, `${e.model}\u0000${e.effort}`), e, cost);
    if (b.oldest === undefined || e.timestamp < b.oldest) { b.oldest = e.timestamp; }
  }
  return b;
}

/** Latest entry by timestamp, or undefined. */
export function lastEntry(entries: readonly UsageEntry[]): UsageEntry | undefined {
  let last: UsageEntry | undefined;
  for (const e of entries) {
    if (!last || e.timestamp >= last.timestamp) { last = e; }
  }
  return last;
}

export const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
export const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

/** Local midnight of the day containing `now`. */
export function startOfToday(now = Date.now()): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** Map entries sorted by cost desc then name, for display. */
export function sortedByCost(map: Map<string, Totals>): [string, Totals][] {
  return [...map.entries()].sort((a, b) => b[1].cost - a[1].cost || totalTokens(b[1]) - totalTokens(a[1]) || a[0].localeCompare(b[0]));
}

// ---------------------------------------------------------------------------
// Formatting helpers (shared by extension and smoke scripts)
// ---------------------------------------------------------------------------

export function formatCost(usd: number): string {
  if (usd > 0 && usd < 0.01) { return `$${usd.toFixed(3)}`; }
  return `$${usd.toFixed(2)}`;
}

export function formatTokens(n: number): string {
  if (n >= 1e9) { return `${(n / 1e9).toFixed(2)}B`; }
  if (n >= 1e6) { return `${(n / 1e6).toFixed(2)}M`; }
  if (n >= 1e4) { return `${(n / 1e3).toFixed(1)}k`; }
  return String(n);
}

export function formatDuration(ms: number): string {
  const totalMin = Math.max(0, Math.floor(ms / 60000));
  if (totalMin < 60) { return `${totalMin}m`; }
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return m > 0 ? `${h}h${m}m` : `${h}h`;
}
