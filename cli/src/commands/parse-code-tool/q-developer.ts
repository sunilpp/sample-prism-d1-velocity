import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

const CHARS_PER_TOKEN = 4;
const MIN_REASONABLE_TIMESTAMP_MS = 1_000_000_000_000;

// Q Developer routes through Bedrock; pricing is internal but model identifiers leak through
// the chat-history JSON. We map known IDs and default to Sonnet-class pricing for the rest.
const MODEL_COSTS: Record<string, [number, number]> = {
  'claude-sonnet-4-6': [0.003, 0.015],
  'claude-sonnet-4-5': [0.003, 0.015],
  'claude-sonnet-3-7': [0.003, 0.015],
  'claude-haiku-4-5': [0.0008, 0.004],
  'q-developer-auto': [0.003, 0.015],
};

function calculateCost(model: string, input: number, output: number): number {
  const [inCost, outCost] = MODEL_COSTS[model] ?? [0.003, 0.015];
  return (input * inCost + output * outCost) / 1000;
}

function getCandidateRoots(): string[] {
  const home = homedir();
  const platformRoots = process.platform === 'darwin'
    ? [join(home, 'Library', 'Application Support', 'amazon-q')]
    : process.platform === 'win32'
      ? [join(home, 'AppData', 'Roaming', 'amazon-q')]
      : [join(home, '.config', 'amazon-q')];
  return [
    join(home, '.aws', 'amazonq', 'cache'),
    join(home, '.aws', 'amazonq', 'history'),
    ...platformRoots,
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

function normalizeModel(raw: unknown): string {
  if (typeof raw !== 'string' || !raw) return 'q-developer-auto';
  let m = raw.replace(/^[^.]*anthropic\./, '').replace(/^anthropic\//, '');
  m = m.replace(/-\d{8}(-v\d+)?(:\d+)?$/, '');
  m = m.replace(/(\d+)\.(\d+)/g, '$1-$2');
  return m;
}

function projectFromPath(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const cleaned = raw.replace(/^file:\/\//, '').replace(/\?.*$/, '');
  const parts = cleaned.split(/[\\/]/).filter(Boolean);
  return parts.length ? parts[parts.length - 1]! : null;
}

function recordFromEntry(entry: any, fallbackTimestamp?: string): ParsedCall | null {
  if (!entry || typeof entry !== 'object') return null;

  const ts = parseTimestamp(entry.timestamp ?? entry.createdAt ?? entry.time) ?? fallbackTimestamp;
  if (!ts) return null;

  const usage = entry.usage ?? entry.metadata?.usage ?? {};
  let inputTokens = Number(usage.input_tokens ?? usage.inputTokens ?? usage.prompt_tokens ?? 0);
  let outputTokens = Number(usage.output_tokens ?? usage.outputTokens ?? usage.completion_tokens ?? 0);

  if (inputTokens === 0 && typeof entry.prompt === 'string') {
    inputTokens = Math.ceil(entry.prompt.length / CHARS_PER_TOKEN);
  }
  if (outputTokens === 0 && typeof entry.response === 'string') {
    outputTokens = Math.ceil(entry.response.length / CHARS_PER_TOKEN);
  }
  if (inputTokens === 0 && outputTokens === 0) return null;

  const model = normalizeModel(entry.model ?? entry.modelId ?? entry.metadata?.modelId);
  const project = projectFromPath(entry.workspace ?? entry.cwd ?? entry.context?.workspace) || 'unknown';

  return {
    model,
    inputTokens,
    outputTokens,
    costUSD: calculateCost(model, inputTokens, outputTokens),
    timestamp: ts,
    project,
  };
}

async function* iterEntries(): AsyncGenerator<any> {
  for (const root of getCandidateRoots()) {
    if (!existsSync(root)) continue;
    let entries: string[];
    try { entries = await readdir(root); } catch { continue; }
    for (const name of entries) {
      if (name.startsWith('.')) continue;
      const path = join(root, name);
      let raw: string;
      try { raw = await readFile(path, 'utf-8'); } catch { continue; }

      // .jsonl → NDJSON only. Otherwise prefer whole-file JSON.parse first;
      // fall back to NDJSON only if that fails.
      if (!path.endsWith('.jsonl')) {
        try {
          const data = JSON.parse(raw);
          if (Array.isArray(data)) { for (const e of data) yield e; continue; }
          if (Array.isArray(data?.messages)) { for (const e of data.messages) yield e; continue; }
          if (Array.isArray(data?.history))  { for (const e of data.history)  yield e; continue; }
          continue;
        } catch { /* fall through to NDJSON */ }
      }

      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try { yield JSON.parse(line); } catch { /* skip */ }
      }
    }
  }
}

export default {
  description: 'Parse Amazon Q Developer local history files and output token usage (codeburn-compatible JSON)',
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
      console.log(`Amazon Q Developer Token Usage (${opts.period})`);
      console.log(`  Calls: ${output.overview.calls}`);
      console.log(`  Cost:  $${output.overview.cost}`);
      for (const m of output.models) console.log(`  ${m.name}: ${m.inputTokens} in / ${m.outputTokens} out`);
    } else {
      console.log(JSON.stringify(output, null, 2));
    }
  },
};
