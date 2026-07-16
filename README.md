# Kimi Proxy Web

OpenAI-compatible **local proxy** for the **Kimi web API** (`www.kimi.com/apiv2`).

It translates OpenAI Chat Completions (including tool calls) into Kimi’s Connect-RPC chat protocol, so tools like **OpenCode**, Roo, Cline, and other OpenAI clients can talk to **Kimi K3 / K2** using a web session JWT instead of the official Moonshot platform API.

> **Not** an official Moonshot product. Uses the same web endpoints the Kimi website uses. Accounts, rate limits, and ToS are yours to respect.

---

## Stability / recommended usage

| Client | Recommendation |
|---|---|
| **OpenCode CLI** (`opencode run …`) | **Preferred — most stable** |
| **OpenCode GUI** | Works well for many flows; may differ slightly from CLI on tool loops / system prompts |
| Other OpenAI clients (Roo, Cline, curl, etc.) | Supported via `/v1/chat/completions` |

**Most stable path:** run the proxy locally, then use **OpenCode CLI** with model `kimi-proxy/k3` (or your configured provider id).

The GUI can work fine too; if tool calling or “empty workspace” weirdness appears, prefer CLI or a fresh session.

---

## Features

- OpenAI-compatible:
  - `POST /v1/chat/completions` (stream + non-stream)
  - `GET /v1/models`
- Multi-account pool (`accounts.json`) with round-robin
- Skips expired JWTs; deactivates bad accounts
- Tool-call translation (OpenAI function tools ↔ tagged text for Kimi)
- Anti-sandbox prompting (blocks Kimi web agent persona / `/mnt/agents/*` noise)
- Compact tool schemas when clients send huge MCP tool lists
- Optional request debug dumps (`DEBUG_REQUESTS=1`)
- Playwright helpers to **add / refresh** web accounts (login capture)

---

## Requirements

- **Node.js ≥ 20**
- A Kimi web account (login via browser capture)
- Network access to `https://www.kimi.com`

---

## Quick start

```bash
git clone https://github.com/Maicon501a/kimi-proxy-web.git
cd kimi-proxy-web
npm install

# 1) Add a Kimi web account (opens browser — log in, then press ENTER)
npm run add

# 2) Start the proxy
npm run server
# → http://127.0.0.1:8080
```

Interactive menu:

```bash
npm start
```

Health check:

```bash
curl http://127.0.0.1:8080/health
```

---

## Models

| Proxy model id | Kimi web scenario | Notes |
|---|---|---|
| `k3` | `SCENARIO_K3` | **Default latest** (Kimi K3) |
| `kimi-latest` | `SCENARIO_K3` | Alias of K3 |
| `kimi-k3` | `SCENARIO_K3` | Alias |
| `k2d5` | `SCENARIO_K2D5` | K2.5 family |
| `k2d6` / `k2-instant` / `kimi-k2` | `SCENARIO_K2D5` | K2.6-style instant |

Example:

```bash
curl http://127.0.0.1:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"k3\",\"messages\":[{\"role\":\"user\",\"content\":\"ping\"}]}"
```

Optional local API key:

```bash
set API_KEY=my-secret
npm run server
# Client: Authorization: Bearer my-secret
```

---

## OpenCode setup

### 1. Run the proxy

```bash
npm run server
```

### 2. Provider in OpenCode config

Add to your OpenCode config (e.g. `~/.config/opencode/opencode.json`):

```json
{
  "provider": {
    "kimi-proxy": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Kimi Proxy (web)",
      "options": {
        "baseURL": "http://127.0.0.1:8080/v1",
        "apiKey": "kimi-proxy"
      },
      "models": {
        "k3": { "name": "Kimi K3" },
        "kimi-latest": { "name": "Kimi Latest (K3)" },
        "k2d5": { "name": "Kimi K2.5" },
        "k2d6": { "name": "Kimi K2.6" }
      }
    }
  }
}
```

### 3. Prefer CLI for stability

```bash
opencode run -m kimi-proxy/k3 --auto --dir "C:\\path\\to\\your\\project" "explain this repo"
```

GUI: select model **`kimi-proxy/k3`**. If the session acts like a Kimi web sandbox, start a **new** chat (old context may contain junk).

---

## Accounts

### Add account (Playwright)

```bash
npm run add
```

Opens a clean Chromium window → log into Kimi → press ENTER in the terminal. JWT + device headers are saved to **`accounts.json`** (gitignored).

### Check / refresh

```bash
npm run check
# or full refresh via browser:
# npm start → [l]
```

### File layout

Copy `accounts.example.json` → `accounts.json` only if you paste tokens manually. Prefer `npm run add`.

**Never commit `accounts.json`.** It contains live Bearer JWTs.

---

## Architecture (short)

```
OpenCode / client  --OpenAI HTTP-->  proxy-kimi (:8080)
                                       |
                                       | buildChatBody + Connect envelope
                                       v
                              www.kimi.com/apiv2
                         ChatService/Chat (web JWT)
```

| Path | Role |
|---|---|
| `src/server.mjs` | HTTP server |
| `src/kimi-client.mjs` | Web API client + body builder |
| `src/stream-parser.mjs` | Connect frame parser |
| `src/tool-call-translator.mjs` | Tool call tags ↔ OpenAI tools |
| `src/response-translator.mjs` | Stream/non-stream OpenAI shaping |
| `src/account-pool.mjs` | Account rotation |
| `scripts/add-account.mjs` | Browser login capture |

Chat path is **HTTP direct** (`fetch`). Browser is only for **account capture/refresh**.

---

## Tool calling

- Client sends OpenAI `tools` / `tool_calls` / `role: tool`.
- Proxy injects compact tool instructions and parses Kimi’s `<tool_call>…</tool_call>` (or JSON) back into OpenAI `tool_calls`.
- Stream path suppresses monologue before tool calls so the client UI does not show raw tags.
- Large tool-result dumps are truncated when re-injected into the transcript.

Native Kimi web agent tools (`ipython`, `/mnt/agents/*`, etc.) are **disabled/denied** in the proxy prompt. Only tools provided by your client (OpenCode, etc.) should be used.

---

## Environment variables

| Var | Default | Meaning |
|---|---|---|
| `PORT` | `8080` | Listen port |
| `API_KEY` | empty | If set, require `Authorization: Bearer …` |
| `REQUEST_LOG` | **`true`** | Console request/response logs. Set `false` / `0` / `off` to silence |
| `DEBUG_DUMP` | `false` | Save full request JSON under `debug-requests/` (gitignored) |
| `DEBUG_REQUESTS` | — | Alias: `true` enables dump; `false` disables `REQUEST_LOG` |

---

## Scripts

```bash
npm start          # interactive CLI menu
npm run server     # start proxy
npm run dev        # watch mode
npm run add        # add account (Playwright)
npm run check      # validate accounts
npm test           # unit tests
```

---

## Security notes

- Keep `accounts.json` private.
- Treat JWTs as passwords; they expire (~30 days typical for web access tokens).
- Do not expose the proxy to the public internet without auth (`API_KEY`) and network controls.
- This project is for personal/local tooling; you are responsible for compliance with Kimi/Moonshot terms.

---

## Troubleshooting

| Symptom | What to try |
|---|---|
| `unauthenticated` / empty replies | JWT expired → `npm run add` or refresh |
| Model invents `upload/` / empty agent workspace | New OpenCode session; ensure proxy is latest; use CLI |
| Tool tags appear as chat text | Update proxy (stream leak fixes); restart server |
| No accounts | `npm run add` |
| Port in use | `set PORT=8081` then restart |

---

## License

Use at your own risk. Unofficial reverse-engineered web API bridge — not affiliated with Moonshot AI / Kimi.
