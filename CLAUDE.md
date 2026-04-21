# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Pi agent extension (`package.json` → `"pi": { "extensions": ["./index.ts"] }`). Pi compiles TypeScript directly — there is no build step, no tsconfig, and no test runner in this repo. To exercise the code, install it via `pi install npm:pi-web-access` or via a local path.

## Development workflow

```bash
# Install dependencies
npm install

# Publish a new version
npm publish
```

There are no lint, build, or test scripts. Changes are validated by running the extension inside Pi.

## Architecture

This is a **Pi extension** that registers 4 tools: `web_search`, `code_search`, `fetch_content`, and `get_search_content`. The entry point is `index.ts`, which exports a default function receiving the Pi `ExtensionAPI`.

### Search provider waterfall (`gemini-search.ts`)

`web_search` resolves a provider in this order (in `auto` mode):
1. **Exa** — direct API if `EXA_API_KEY` is set, else public MCP gateway (`mcp.exa.ai/mcp`, no auth, 1k/month limit tracked in `~/.pi/exa-usage.json`)
2. **Perplexity** — if `PERPLEXITY_API_KEY` is set
3. **Gemini API** — if `GEMINI_API_KEY` is set
4. **Gemini Web** — if a supported Chromium browser is signed into `gemini.google.com` (cookie extraction via `chrome-cookies.ts`)

Each provider has its own module (`exa.ts`, `perplexity.ts`, `gemini-api.ts`, `gemini-web.ts`). `gemini-search.ts` owns the orchestration and fallback logic.

### Content extraction router (`extract.ts`)

`fetch_content` dispatches URLs to specialized handlers based on pattern matching:
- **GitHub URLs** → `github-extract.ts` (clones locally, returns file tree + README; falls back to GitHub API for oversized repos via `github-api.ts`)
- **YouTube URLs** → `youtube-extract.ts` (3-tier: Gemini Web → Gemini API → Perplexity; frame extraction requires `ffmpeg` + `yt-dlp`)
- **Local video files** → `video-extract.ts` (uploads to Gemini Files API, analyzes, deletes)
- **PDF URLs** → `pdf-extract.ts` (saves to `~/Downloads/`, extracts text via `unpdf`)
- **HTML pages** → Readability (`@mozilla/readability` + `linkedom`) → Jina Reader (`r.jina.ai`) → Gemini URL context (`gemini-url-context.ts`)
- **Next.js RSC pages** → `rsc-extract.ts` (parses flight payload from `__next_f` chunks)

### Curator workflow (`curator-server.ts`, `curator-page.ts`, `summary-review.ts`)

When `curatorMode` is enabled in config, `web_search` launches an ephemeral local HTTP server. The browser UI streams search results via SSE, allows the user to approve/edit a draft summary, and submits the final answer back to the agent. `curator-server.ts` is a state machine managing the server lifecycle. `curator-page.ts` generates the entire HTML/CSS/JS as a string. `summary-review.ts` builds the summary prompt and handles model-based draft generation with a deterministic fallback.

### Session storage and activity tracking

`storage.ts` provides session-aware result caching (keyed by session ID from Pi). `activity.ts` tracks in-flight requests for the live widget (toggled with Ctrl+Shift+W by default).

## Configuration

All user config lives in `~/.pi/web-search.json`. API keys can also be set as env vars (`EXA_API_KEY`, `PERPLEXITY_API_KEY`, `GEMINI_API_KEY`). The config is read fresh on each call (cached per process in some modules — search for `cachedSearchConfig` and similar patterns when debugging stale config).

## Key invariants

- The Exa MCP path (`searchWithExaMcp`) is the only zero-config search path. `isExaAvailable()` returns `true` even with no API key, so the waterfall always attempts Exa first.
- GitHub clones are cached under `~/.pi/github-clones/` and reused across turns within a session.
- Gemini file uploads (for video) are deleted after analysis — see `deleteGeminiFile` in `video-extract.ts`.
- `p-limit` is used in `index.ts` to bound concurrent search requests when `queries` (multi-query mode) is used.
