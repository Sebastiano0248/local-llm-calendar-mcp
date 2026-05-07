# lmstudio-google-calendar-mcp

A [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) server that connects LM Studio (or any MCP-compatible local LLM runner) to your Google Calendar and Google Tasks, allowing your local AI models to read your schedule and task lists.

## What it does

This server exposes read-only tools over the MCP stdio transport:

**Calendar tools**
- List all your Google Calendars
- List, search, and get events by date range or keyword
- Get today's agenda
- Check free/busy availability

**Task tools**
- List all Google Tasks lists
- List, search, and get individual tasks (including completed ones)

## Project structure

```
├── config/
│   └── lmstudio-mcp.json        # LM Studio MCP server registration
├── mcp-google-calendar/
│   ├── index.js                 # MCP server entry point
│   ├── auth.js                  # OAuth2 setup script
│   ├── package.json
│   └── credentials/             # ⚠ NOT committed — see setup below
│       ├── credentials.json     # Google OAuth client credentials
│       └── token.json           # OAuth access/refresh tokens (auto-generated)
└── models/                      # Local GGUF model files (not committed)
```

## Prerequisites

- [Node.js](https://nodejs.org/) v18.14.1 or later
- [LM Studio](https://lmstudio.ai/) (or another MCP-compatible runner)
- A Google account
- A Google Cloud project with the Calendar and Tasks APIs enabled

---

## Setup

### 1. Clone the repo

```bash
git clone https://github.com/<your-username>/lmstudio-google-calendar-mcp.git
cd lmstudio-google-calendar-mcp
```

### 2. Install dependencies

```bash
cd mcp-google-calendar
npm install
```

### 3. Create a Google Cloud project and OAuth credentials

1. Go to the [Google Cloud Console](https://console.cloud.google.com/).
2. Create a new project (or select an existing one).
3. Enable the following APIs:
   - **Google Calendar API**
   - **Google Tasks API**
4. Go to **APIs & Services → Credentials → Create Credentials → OAuth client ID**.
5. Select **Desktop app** as the application type.
6. Download the generated JSON file.
7. Rename it to `credentials.json` and place it at:

```
mcp-google-calendar/credentials/credentials.json
```

> The `credentials/` directory is git-ignored. Never commit these files.

### 4. Authenticate with Google

Run the authentication script from inside the `mcp-google-calendar/` directory:

```bash
npm run auth
```

This will:
- Open your default browser to the Google OAuth consent screen
- Ask you to grant read-only access to Calendar and Tasks
- Save the resulting token to `credentials/token.json`

You only need to do this once. The token will be refreshed automatically.

### 5. Register the MCP server in LM Studio

LM Studio reads MCP server configurations from a JSON file. Copy the provided config file to the location LM Studio expects, or point LM Studio at the file in `config/lmstudio-mcp.json`.

The config references the absolute path to `index.js`. Open `config/lmstudio-mcp.json` and update the `args` path to match your local installation:

```json
{
  "mcpServers": {
    "google-calendar": {
      "command": "node",
      "args": ["C:/path/to/your/mcp-google-calendar/index.js"]
    }
  }
}
```

> In LM Studio, go to **Settings → MCP Servers** and point it to this file, or paste the config directly into the MCP settings panel.

### 6. Download a model (optional)

Place any GGUF-format model file inside the `models/` directory. Tested with:

- `Meta-Llama-3.1-8B-Instruct-Q5_K_M.gguf`
- `Qwen2.5-7B-Instruct-Q5_K_M.gguf`

Models can be downloaded from [Hugging Face](https://huggingface.co/models?library=gguf).

---

## Troubleshooting

**`credentials.json` not found**
Make sure you completed step 3 and the file is at `mcp-google-calendar/credentials/credentials.json`.

**`token.json` not found or expired**
Re-run `npm run auth` to generate a fresh token.

**LM Studio doesn't pick up the MCP server**
Check that the path in `lmstudio-mcp.json` points to the correct absolute path of `index.js` on your machine.

**Google API quota errors**
The server uses read-only scopes. If you hit quota limits, check your Google Cloud Console quotas for the Calendar and Tasks APIs.

---

## Security notes

- Both `credentials.json` and `token.json` contain sensitive OAuth material. They are excluded from version control via `.gitignore`.
- The server requests only read-only scopes (`calendar.readonly`, `tasks.readonly`).
- Tokens are stored as plain JSON on disk — do not share your `credentials/` directory.

## License

MIT
