# roo-way

A Railway-hosted webhook server that triggers [Roo CLI](https://github.com/RooCodeInc/Roo-Code) workflows from GitHub issue label events.

> **No GitHub API reads.** Issue content (title, body, comments) is always supplied by the caller — either in the `/trigger` request body or directly from the GitHub webhook payload. The server and script never call `gh issue view`.
>
> **No secret required.** The webhook and trigger endpoints are open — protect them at the network/proxy level if needed.

## How it works

```
GitHub Issue labelled "roo-code"
        │
        ▼
POST /webhook  (this server, hosted on Railway)
        │  title + body extracted from the webhook payload
        ▼
scripts/roo-local.sh roo-code
  (ROO_TITLE / ROO_BODY / ROO_COMMENTS env vars)
        │
        ▼
roo CLI runs in feature-mode, commits + pushes changes
        │
        ▼
Comment posted on the GitHub issue (only when ROO_ISSUE is set)
```

## Supported commands / labels

| GitHub label | Script command | Roo mode          |
| ------------ | -------------- | ----------------- |
| `roo-code`   | `roo-code`     | `feature-mode`    |
| `roo-design` | `roo-design`   | _(extend script)_ |

## API routes

| Method | Path       | Description                                       |
| ------ | ---------- | ------------------------------------------------- |
| GET    | `/health`  | Liveness probe (used by Railway healthcheck)      |
| POST   | `/webhook` | GitHub webhook receiver (`issues` labeled events) |
| POST   | `/trigger` | Manual trigger — see body schema below            |

### `POST /trigger` — request body

All issue / ticket content must be supplied by the caller. The server does **not** fetch anything from GitHub.

```json
{
  "command": "roo-code",
  "title": "Add dark mode support",
  "body": "We need a dark mode toggle in Settings...",
  "comments": "alice: CSS variables would work well here.\nbob: Agreed.",
  "branch": "feature-mode/123-dark-mode",
  "extra": "Focus on the Settings panel component",
  "issue": 123
}
```

| Field      | Type    | Required | Description                                                |
| ---------- | ------- | -------- | ---------------------------------------------------------- |
| `command`  | string  | ✅       | One of: `roo-code`, `roo-design`                           |
| `title`    | string  | ✅       | Issue / ticket title                                       |
| `body`     | string  | ✅       | Issue / ticket description                                 |
| `comments` | string  | —        | Prior comment history (plain text)                         |
| `branch`   | string  | —        | Exact branch name; derived from `title` if omitted         |
| `extra`    | string  | —        | Additional instruction appended to the roo prompt          |
| `issue`    | integer | —        | GitHub issue number — used **only** to post a comment back |

### `POST /webhook` — GitHub `issues` labeled event

Title and body are read directly from the webhook payload (`payload.issue.title` / `payload.issue.body`). No additional API call is made. Comment history is not included (not present in labeled events).

## Environment variables

| Variable             | Required | Description                                                   |
| -------------------- | -------- | ------------------------------------------------------------- |
| `OPENROUTER_API_KEY` | ✅       | OpenRouter API key passed to roo CLI                          |
| `GH_TOKEN`           | ✅       | GitHub token — used by `gh` CLI and `git push`                |
| `PORT`               | —        | HTTP port (Railway sets this automatically)                   |
| `GIT_USER_NAME`      | —        | Committer name (default: `Roo Way`)                           |
| `GIT_USER_EMAIL`     | —        | Committer email (default: `roo-way@users.noreply.github.com`) |

Copy [`.env.example`](.env.example) to `.env` for local development.

## Deploy to Railway

### 1. Create a Railway project

```bash
railway login
railway init          # link or create project
railway up            # first deploy (builds Dockerfile)
```

### 2. Set environment variables in Railway dashboard

Go to your service → **Variables** and add:

- `OPENROUTER_API_KEY`
- `GH_TOKEN`

### 3. Configure a GitHub webhook

In your target repo → **Settings → Webhooks → Add webhook**:

| Field        | Value                                   |
| ------------ | --------------------------------------- |
| Payload URL  | `https://<your-railway-domain>/webhook` |
| Content type | `application/json`                      |
| Which events | **Issues** only                         |

### 4. Label an issue to trigger a workflow

Apply the label `roo-code` (or any supported label) to a GitHub issue — the webhook fires and extracts the issue title + body from the payload automatically.

## Local usage

```bash
cp .env.example .env
# fill in OPENROUTER_API_KEY + GH_TOKEN

# Run the server locally
node server.js

# Invoke the script directly — pass content via env vars
ROO_TITLE="Add dark mode" \
ROO_BODY="We need a dark mode toggle in Settings..." \
ROO_COMMENTS="alice: CSS variables would work well here." \
ROO_ISSUE=123 \
OPENROUTER_API_KEY=sk-... \
  ./scripts/roo-local.sh roo-code "Focus on the Settings panel"

# Manual HTTP trigger via curl
curl -X POST http://localhost:3000/trigger \
  -H 'Content-Type: application/json' \
  -d '{
    "command": "roo-code",
    "title": "Add dark mode support",
    "body": "We need a dark mode toggle in Settings...",
    "issue": 123
  }'
```

## Project structure

```
.
├── Dockerfile            # Container image (node:20-slim + gh CLI + roo CLI)
├── entrypoint.sh         # Configures git HTTPS auth from GH_TOKEN at startup
├── server.js             # HTTP server — webhook + trigger routes
├── package.json
├── railway.json          # Railway build + deploy config
├── .env.example          # Required env var reference
└── scripts/
    └── roo-local.sh      # Core workflow script (runs roo CLI, commits, comments)
```
