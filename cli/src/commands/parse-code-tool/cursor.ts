import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

const CHARS_PER_TOKEN = 4;
const MIN_REASONABLE_TIMESTAMP_MS = 1_000_000_000_000;

const MODEL_COSTS: Record<string, [number, number]> = {
  'claude-sonnet-4-6': [0.003, 0.015],
  'claude-sonnet-4-5': [0.003, 0.015],
  'claude-opus-4-7': [0.015, 0.075],
  'claude-haiku-4-5': [0.0008, 0.004],
  'gpt-4': [0.03, 0.06],
  'gpt-4o': [0.005, 0.015],
  'gpt-4o-mini': [0.00015, 0.0006],
  'gpt-5': [0.015, 0.045],
  'cursor-auto': [0.003, 0.015],
};

function calculateCost(model: string, input: number, output: number): number {
  const [inCost, outCost] = MODEL_COSTS[model] ?? [0.003, 0.015];
  return (input * inCost + output * outCost) / 1000;
}

function getCursorRoot(): string {
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Application Support', 'Cursor');
  if (process.platform === 'win32') return join(homedir(), 'AppData', 'Roaming', 'Cursor');
  return join(homedir(), '.config', 'Cursor');
}

function getCursorUsageFiles(): string[] {
  const root = getCursorRoot();
  // Cursor (and the open-source AnySphere build) write a number of artifacts. None are formally
  // documented, so we accept the union of paths reported by community tooling and probe each.
  return [
    join(homedir(), '.cursor', 'usage.json'),                            // CLI export
    join(homedir(), '.cursor', 'audit.log'),                             // audit log (ndjson)
    join(root, 'User', 'globalStorage', 'cursor.usage.json'),            // settings UI export
    join(root, 'User', 'globalStorage', 'cursor', 'usage.json'),
  ];
}

type ParsedCall = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
  timestamp: string;
  project: string;
};

function parseTimestamp(value: unknown): string | null {
  if (value == null) return null;
  let parsed: number | string = typeof value === 'string' ? value.trim() : value as number;
  if (typeof parsed === 'string' && /^-?\d+(\.\d+)?$/.test(parsed)) parsed = Number(parsed);
  if (typeof parsed === 'number') {
    if (!Number.isFinite(parsed)) return null;
    const ms = parsed < MIN_REASONABLE_TIMESTAMP_MS ? parsed * 1000 : parsed;
    return ms >= MIN_REASONABLE_TIMESTAMP_MS ? new Date(ms).toISOString() : null;
  }
  const d = new Date(parsed);
  return d.getTime() >= MIN_REASONABLE_TIMESTAMP_MS ? d.toISOString() : null;
}

function projectFromPath(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  // Common file:// or absolute path → take basename
  const cleaned = value.replace(/^file:\/\//, '').replace(/\?.*$/, '');
  if (!cleaned) return null;
  // If it's a full path, take the deepest workspace-like dir
  const parts = cleaned.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1]! : null;
}

function recordFromEntry(entry: any): ParsedCall | null {
  if (!entry || typeof entry !== 'object') return null;

  const ts = parseTimestamp(entry.timestamp ?? entry.time ?? entry.createdAt ?? entry.date);
  if (!ts) return null;

  // Token fields vary by Cursor build — accept several shapes
  const inputTokens = Number(
    entry.input_tokens ?? entry.inputTokens ?? entry.promptTokens ?? entry.tokens?.input ?? 0,
  );
  const outputTokens = Number(
    entry.output_tokens ?? entry.outputTokens ?? entry.completionTokens ?? entry.tokens?.output ?? 0,
  );
  // Fall back to char count if no tokens reported
  let estInput = inputTokens;
  let estOutput = outputTokens;
  if (estInput === 0 && typeof entry.prompt === 'string') estInput = Math.ceil(entry.prompt.length / CHARS_PER_TOKEN);
  if (estOutput === 0 && typeof entry.response === 'string') estOutput = Math.ceil(entry.response.length / CHARS_PER_TOKEN);
  if (estInput === 0 && estOutput === 0) return null;

  const rawModel = String(entry.model ?? entry.modelName ?? entry.engine ?? 'cursor-auto').toLowerCase();
  const model = rawModel.replace(/(\d+)\.(\d+)/g, '$1-$2');

  const project = projectFromPath(entry.workspace ?? entry.workspacePath ?? entry.cwd ?? entry.repoPath) || 'unknown';

  return {
    model,
    inputTokens: estInput,
    outputTokens: estOutput,
    costUSD: calculateCost(model, estInput, estOutput),
    timestamp: ts,
    project,
  };
}

async function* iterEntries(): AsyncGenerator<any> {
  for (const path of getCursorUsageFiles()) {
    if (!existsSync(path)) continue;
    let raw: string;
    try { raw = await readFile(path, 'utf-8'); } catch { continue; }

    // .log → NDJSON only. Otherwise prefer whole-file JSON.parse first (handles
    // pretty-printed JSON); fall back to NDJSON only if that fails.
    if (!path.endsWith('.log')) {
      try {
        const data = JSON.parse(raw);
        if (Array.isArray(data)) { for (const e of data) yield e; continue; }
        if (Array.isArray(data?.events)) { for (const e of data.events) yield e; continue; }
        if (Array.isArray(data?.usage))  { for (const e of data.usage)  yield e; continue; }
        // Parseable but not a recognized shape — skip the file.
        continue;
      } catch { /* fall through to NDJSON */ }
    }

    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      try { yield JSON.parse(line); } catch { /* skip */ }
    }
  }
}

export default {
  description: 'Parse Cursor IDE local usage/audit files and output token usage (codeburn-compatible JSON)',
  options: [
    { flags: '--project <name>', description: 'Filter by project name' },
    { flags: '--period <period>', description: 'Period: today, week, 30days, all', default: 'all' },
    { flags: '--format <fmt>', description: 'Output format: json, summary', default: 'json' },
  ],
  async action(opts: { project?: string; period: string; format: string }) {
    const cutoffMs = (() => {
      const w: Record<string, number> = { today: 86_400_000, week: 604_800_000, '30days': 2_592_000_000 };
      return w[opts.period] ? Date.now() - w[opts.period]! : 0;
    })();

    const calls: ParsedCall[] = [];
    for await (const entry of iterEntries()) {
      const rec = recordFromEntry(entry);
      if (!rec) continue;
      if (new Date(rec.timestamp).getTime() < cutoffMs) continue;
      if (opts.project && rec.project !== opts.project) continue;
      calls.push(rec);
    }

    const byModel = new Map<string, { inputTokens: number; outputTokens: number }>();
    const byProject = new Map<string, { cost: number; calls: number }>();
    let totalCost = 0;
    for (const c of calls) {
      const m = byModel.get(c.model) ?? { inputTokens: 0, outputTokens: 0 };
      m.inputTokens += c.inputTokens; m.outputTokens += c.outputTokens;
      byModel.set(c.model, m);
      const p = byProject.get(c.project) ?? { cost: 0, calls: 0 };
      p.cost += c.costUSD; p.calls += 1;
      byProject.set(c.project, p);
      totalCost += c.costUSD;
    }

    const output = {
      overview: {
        cost: Math.round(totalCost * 100) / 100,
        calls: calls.length,
        sessions: 1,
      },
      models: [...byModel.entries()].map(([name, t]) => ({ name, inputTokens: t.inputTokens, outputTokens: t.outputTokens })),
      projects: [...byProject.entries()].map(([name, p]) => ({ name, cost: Math.round(p.cost * 100) / 100, calls: p.calls })),
    };

    if (opts.format === 'summary') {
      console.log(`Cursor Token Usage (${opts.period})`);
      console.log(`  Calls: ${output.overview.calls}`);
      console.log(`  Cost:  $${output.overview.cost}`);
      for (const m of output.models) console.log(`  ${m.name}: ${m.inputTokens} in / ${m.outputTokens} out`);
    } else {
      console.log(JSON.stringify(output, null, 2));
    }
  },
};
