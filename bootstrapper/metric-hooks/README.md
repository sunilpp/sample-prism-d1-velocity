# Metric Hooks

A `prepare-commit-msg` git hook that automatically tags commits with AI origin metadata and token usage.

## What It Does

Every commit gets trailers appended to the message:

```
feat: add order creation endpoint

AI-Origin: ai-assisted
AI-Tool: claude-code
AI-Model: claude-sonnet-4-5
AI-Input-Tokens: 12450
AI-Output-Tokens: 3200
AI-Cost: $0.0800
AI-Summary: <base64 JSON of per-tool breakdown>
Spec-Ref: specs/create-order-endpoint.md
```

The `AI-Summary` trailer is a base64-encoded JSON array — one entry per tool used
during the commit window, e.g.:

```json
[
  {"tool":"claude-code","model":"claude-opus-4-7","input":8200,"output":2100,"cost":0.04},
  {"tool":"cursor","model":"gpt-4o","input":4250,"output":1100,"cost":0.04}
]
```

These trailers are read by the `prism-ai-metrics.yml` GitHub workflow on PR merge to emit metrics to EventBridge — including per-IDE / per-model dimensions for CloudWatch and OTel dashboards.

## Installation

```bash
bash prism-cli bootstrapper install-git-hooks --team-id my-team
```

Or interactively (prompts for team ID):

```bash
bash prism-cli bootstrapper install-git-hooks
```

To remove:

```bash
bash prism-cli bootstrapper install-git-hooks --uninstall
```

## Prerequisites

- **prism-cli** — Built-in native parsers for Claude Code, Cursor, Kiro CLI/IDE, and Amazon Q Developer (`prism-cli parse-code-tool <tool>`). No external dependency required.
- **jq** — JSON processing. Install: `brew install jq` or `sudo apt install jq`
- **codeburn** *(optional)* — Legacy fallback used only when no native parser produces data for the detected tool. Install: `npm install -g codeburn`

## How AI Detection Works

The hook combines environment markers with a probe of each IDE's local data:

| Tool | Detection | Token source |
|---|---|---|
| Claude Code | `CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE` env vars | `prism-cli parse-code-tool claude-code` — reads `~/.claude/projects/*/<session>.jsonl` |
| Cursor | `CURSOR_SESSION_ID`, `TERM_PROGRAM=cursor`, `VSCODE_GIT_ASKPASS_NODE` contains `Cursor` | `prism-cli parse-code-tool cursor` — reads `~/.cursor/usage.json` / `audit.log` |
| Kiro (CLI) | `KIRO_SESSION_ID` | `prism-cli parse-code-tool kiro-cli --session-id` |
| Kiro (IDE) | `TERM_PROGRAM=kiro` or `VSCODE_GIT_ASKPASS_NODE` contains `kiro` | `prism-cli parse-code-tool kiro-ide` |
| Q Developer | `Q_DEVELOPER_SESSION`, `TERM_PROGRAM=amazonq` | `prism-cli parse-code-tool q-developer` |
| Anything else with codeburn-tracked usage | (origin upgrades to `ai-assisted`) | `codeburn report` (legacy fallback) |

If no env marker fires but a parser reports tokens (e.g. the user used Claude Code in a different terminal earlier), `AI-Origin` is upgraded from `human` to `ai-assisted`.

## Token Tracking

For every known tool, on each commit the hook:

1. Calls the native parser to get lifetime token totals for the current project
2. Compares against a per-tool snapshot at `~/.prism/tokentracker/<project>/<tool>.json`
3. Computes the delta — that becomes the per-tool entry in `AI-Summary`
4. Sums the deltas across all tools for the top-level `AI-Input-Tokens` / `AI-Output-Tokens` / `AI-Cost` trailers
5. Saves the new snapshot

The per-tool snapshot is kept separately so using both Claude Code and Cursor on the same project doesn't double-count.

## Configuration

The installer creates `.prism/config.json`:

```json
{
  "team_id": "your-team",
  "max_tokens": 1000000,
  "max_cost": 100
}
```

| Field | Description | Default |
|-------|-------------|---------|
| `team_id` | Team identifier for metric attribution | *(required)* |
| `max_tokens` | Max input/output tokens per commit (capped at this value) | `1000000` |
| `max_cost` | Max cost in USD per commit (capped at this value) | `100` |

Set custom bounds at install time:

```bash
prism-cli bootstrapper install-git-hooks --team-id my-team --max-tokens 500000 --max-cost 50
```

Values exceeding bounds are clamped to the configured maximum. The workflow (`prism-ai-metrics.yml`) applies a second layer of enforcement, discarding values above 1M tokens / $100 to zero.

## Safety

- Never blocks a commit — exits 0 even if a parser or jq fails
- Only appends trailers — never modifies code
- Skips merge and squash commits
- Won't duplicate trailers if already present
- `AI-Summary` payload is capped at ~4 KB; if a base64 payload would exceed that it is dropped (the flat `AI-Input-Tokens`/`AI-Output-Tokens`/`AI-Cost` trailers still flow through)
