import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { homedir } from 'node:os';

const MIN_REASONABLE_TIMESTAMP_MS = 1_000_000_000_000;

type Usage = {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
};

type ParsedCall = {
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUSD: number;
  timestamp: string;
  project: string;
  sessionId: string;
};

// Anthropic billing multipliers vs. base input rate:
//   cache_creation = 1.25× input  (5m TTL ephemeral cache)
//   cache_read     = 0.10× input  (cache hit)
// Source: https://docs.anthropic.com/en/docs/build-with-claude/prompt-caching#pricing
const CACHE_WRITE_MULTIPLIER = 1.25;
const CACHE_READ_MULTIPLIER = 0.10;

// Claude pricing per 1K tokens (input, output). Cache tokens are priced from input.
const MODEL_COSTS: Record<string, [number, number]> = {
  'claude-opus-4-8': [0.015, 0.075],
  'claude-opus-4-7': [0.015, 0.075],
  'claude-opus-4-6': [0.015, 0.075],
  'claude-opus-4': [0.015, 0.075],
  'claude-sonnet-4-6': [0.003, 0.015],
  'claude-sonnet-4-5': [0.003, 0.015],
  'claude-sonnet-4': [0.003, 0.015],
  'claude-haiku-4-5': [0.0008, 0.004],
  'claude-fable-5': [0.003, 0.015],
};

function normalizeModelId(raw: string): string {
  // Strip provider prefix (bedrock: us.anthropic.<id>, vertex: anthropic/<id>)
  let m = raw.replace(/^[^.]*anthropic\./, '').replace(/^anthropic\//, '');
  // Drop version suffix like `-20250929-v1:0`
  m = m.replace(/-\d{8}(-v\d+)?(:\d+)?$/, '');
  // Bedrock IDs use dots, e.g. claude-sonnet-4.6 — normalize to dashes
  m = m.replace(/(\d+)\.(\d+)/g, '$1-$2');
  return m;
}

function calculateCost(
  model: string,
  input: number,
  output: number,
  cacheCreate = 0,
  cacheRead = 0,
): number {
  const norm = normalizeModelId(model);
  const [inCost, outCost] = MODEL_COSTS[norm] ?? [0.003, 0.015];
  const inputBilled = input + cacheCreate * CACHE_WRITE_MULTIPLIER + cacheRead * CACHE_READ_MULTIPLIER;
  return (inputBilled * inCost + output * outCost) / 1000;
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const ms = new Date(value).getTime();
  return Number.isFinite(ms) && ms >= MIN_REASONABLE_TIMESTAMP_MS ? ms : null;
}

function getClaudeProjectsDir(): string {
  return join(homedir(), '.claude', 'projects');
}

async function* iterTranscriptFiles(): AsyncGenerator<string> {
  const root = getClaudeProjectsDir();
  let dirs: string[];
  try { dirs = await readdir(root); } catch { return; }
  for (const dir of dirs) {
    if (dir.startsWith('.')) continue;
    const projectDir = join(root, dir);
    let files: string[];
    try { files = await readdir(projectDir); } catch { continue; }
    for (const f of files) {
      if (f.endsWith('.jsonl')) yield join(projectDir, f);
    }
  }
}

async function parseTranscript(
  filePath: string,
  targetProject: string | undefined,
  cutoffMs: number,
): Promise<ParsedCall[]> {
  let raw: string;
  try { raw = await readFile(filePath, 'utf-8'); } catch { return []; }

  const sessionId = basename(filePath, '.jsonl');
  const calls: ParsedCall[] = [];

  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let entry: any;
    try { entry = JSON.parse(line); } catch { continue; }

    // Only count assistant turns. Tool-result echoes and resumed-session
    // synthetic entries can carry a copied `usage` block; filtering by type
    // avoids double-counting them.
    if (entry?.type !== 'assistant') continue;

    const msg = entry?.message;
    const usage: Usage | undefined = msg?.usage;
    if (!usage) continue;

    const ts = parseTimestamp(entry?.timestamp);
    if (ts === null || ts < cutoffMs) continue;

    const cwd: string = typeof entry?.cwd === 'string' ? entry.cwd : '';
    const project = cwd ? basename(cwd) : 'unknown';
    if (targetProject && project !== targetProject) continue;

    const baseInput = usage.input_tokens ?? 0;
    const cacheCreate = usage.cache_creation_input_tokens ?? 0;
    const cacheRead = usage.cache_read_input_tokens ?? 0;
    const inputTokens = baseInput + cacheCreate + cacheRead;
    const outputTokens = usage.output_tokens ?? 0;
    if (inputTokens === 0 && outputTokens === 0) continue;

    const model = typeof msg?.model === 'string' ? msg.model : 'unknown';
    calls.push({
      model: normalizeModelId(model),
      inputTokens,
      outputTokens,
      costUSD: calculateCost(model, baseInput, outputTokens, cacheCreate, cacheRead),
      timestamp: new Date(ts).toISOString(),
      project,
      sessionId,
    });
  }
  return calls;
}

export default {
  description: 'Parse Claude Code transcript files and output token usage (codeburn-compatible JSON)',
  options: [
    { flags: '--project <name>', description: 'Filter by project name (basename of cwd)' },
    { flags: '--session-id <id>', description: 'Filter to a single Claude Code session id' },
    { flags: '--period <period>', description: 'Period: today, week, 30days, all', default: 'all' },
    { flags: '--format <fmt>', description: 'Output format: json, summary', default: 'json' },
  ],
  async action(opts: { project?: string; sessionId?: string; period: string; format: string }) {
    const cutoffMs = (() => {
      const windows: Record<string, number> = { today: 86_400_000, week: 604_800_000, '30days': 2_592_000_000 };
      const w = windows[opts.period];
      return w ? Date.now() - w : 0;
    })();

    const calls: ParsedCall[] = [];
    for await (const file of iterTranscriptFiles()) {
      if (opts.sessionId && basename(file, '.jsonl') !== opts.sessionId) continue;
      calls.push(...(await parseTranscript(file, opts.project, cutoffMs)));
    }

    const byModel = new Map<string, { inputTokens: number; outputTokens: number }>();
    const byProject = new Map<string, { cost: number; calls: number }>();
    const sessions = new Set<string>();
    let totalCost = 0;

    for (const c of calls) {
      const m = byModel.get(c.model) ?? { inputTokens: 0, outputTokens: 0 };
      m.inputTokens += c.inputTokens;
      m.outputTokens += c.outputTokens;
      byModel.set(c.model, m);

      const p = byProject.get(c.project) ?? { cost: 0, calls: 0 };
      p.cost += c.costUSD;
      p.calls += 1;
      byProject.set(c.project, p);

      sessions.add(c.sessionId);
      totalCost += c.costUSD;
    }

    const output = {
      overview: {
        cost: Math.round(totalCost * 100) / 100,
        calls: calls.length,
        sessions: sessions.size,
      },
      models: [...byModel.entries()].map(([name, t]) => ({
        name,
        inputTokens: t.inputTokens,
        outputTokens: t.outputTokens,
      })),
      projects: [...byProject.entries()].map(([name, p]) => ({
        name,
        cost: Math.round(p.cost * 100) / 100,
        calls: p.calls,
      })),
    };

    if (opts.format === 'summary') {
      console.log(`Claude Code Token Usage (${opts.period})`);
      console.log(`  Calls:    ${output.overview.calls}`);
      console.log(`  Sessions: ${output.overview.sessions}`);
      console.log(`  Cost:     $${output.overview.cost}`);
      for (const m of output.models) console.log(`  ${m.name}: ${m.inputTokens} in / ${m.outputTokens} out`);
      if (output.projects.length > 1) for (const p of output.projects) console.log(`  [${p.name}] $${p.cost} (${p.calls} calls)`);
    } else {
      console.log(JSON.stringify(output, null, 2));
    }
  },
};
