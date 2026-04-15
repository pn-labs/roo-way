'use strict';

// =============================================================================
// server.js — Webhook + manual trigger server for roo-way on Railway
//
// Routes:
//   GET  /health          — liveness probe (Railway healthcheck)
//   POST /trigger         — manual trigger
//   POST /webhook         — GitHub webhook: issues "labeled" events
//
// POST /trigger body (JSON):
//   command    {string}  required — one of: roo-bug, roo-code, roo-design, roo-docs
//   repo       {string}  required — HTTPS clone URL of the target repo (e.g. https://github.com/org/repo.git)
//   title      {string}  required — issue / ticket title
//   body       {string}  required — issue / ticket description / body
//   comments   {string}  optional — prior comment history (plain text)
//   branch     {string}  optional — explicit branch name; derived from title if omitted
//   extra      {string}  optional — additional instruction appended to the prompt
//   issue      {number}  optional — GitHub issue number (used only to post a comment back)
//
// Required env vars:
//   OPENROUTER_API_KEY    — passed through to roo-local.sh
//   GH_TOKEN              — used by gh CLI + git HTTPS auth (set in entrypoint)
//
// Optional env vars:
//   PORT                  — defaults to 3000
// =============================================================================

const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const PORT = parseInt(process.env.PORT || '3000', 10);

// Label names that map directly to roo-local.sh commands
const VALID_COMMANDS = new Set(['roo-code', 'roo-design']);

// ─── Repo list helpers ────────────────────────────────────────────────────────
// Reads REPOS env var (JSON array or pipe-separated), merges with REPO_URL.
function parseRepos() {
  const raw = (process.env.REPOS || '').trim();
  let list = [];
  if (raw) {
    if (raw.startsWith('[')) {
      try {
        list = JSON.parse(raw);
      } catch {
        list = [];
      }
    } else {
      list = raw
        .split('|')
        .map((r) => r.trim())
        .filter(Boolean);
    }
  }
  // Also include the legacy REPO_URL fallback if present and not already listed
  const single = (process.env.REPO_URL || '').trim();
  if (single && !list.includes(single)) list.unshift(single);
  return list;
}

const SCRIPT_PATH = path.resolve(__dirname, 'scripts', 'roo-local.sh');

// ─── Logging helpers ──────────────────────────────────────────────────────────
const log = (...a) => console.log(`[${new Date().toISOString()}]`, ...a);
const logE = (...a) => console.error(`[${new Date().toISOString()}]`, ...a);

// ─── Read full request body ───────────────────────────────────────────────────
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ─── Respond helpers ──────────────────────────────────────────────────────────
function send(res, status, body) {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(json),
  });
  res.end(json);
}

function sendHtml(res, html) {
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Length': Buffer.byteLength(html),
  });
  res.end(html);
}

// ─── Run roo-local.sh in the background ──────────────────────────────────────
// Content is forwarded via env vars so the script never calls the GitHub API.
//
// @param {string} command   — roo-bug | roo-code | roo-design | roo-docs
// @param {object} content   — { title, body, comments?, branch?, issue?, extra? }
function runScript(command, content = {}) {
  const {
    title,
    body,
    repo = '',
    comments = '',
    branch = '',
    issue = '',
    extra = '',
  } = content;

  const scriptArgs = [command];
  if (extra) scriptArgs.push(extra);

  log(`Spawning: bash ${SCRIPT_PATH} ${scriptArgs.join(' ')}`);

  const child = spawn('bash', [SCRIPT_PATH, ...scriptArgs], {
    env: {
      ...process.env,
      PATH: process.env.PATH,
      REPO_URL: repo,
      ROO_TITLE: title,
      ROO_BODY: body,
      ROO_COMMENTS: comments,
      ROO_BRANCH: branch,
      ROO_ISSUE: String(issue),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  child.stdout.on('data', (d) => process.stdout.write(d));
  child.stderr.on('data', (d) => process.stderr.write(d));

  child.on('close', (code) => {
    if (code === 0) {
      log(`Script exited cleanly (command=${command} title="${title}")`);
    } else {
      logE(
        `Script exited with code ${code} (command=${command} title="${title}")`,
      );
    }
  });

  child.on('error', (err) => {
    logE(`Failed to spawn script: ${err.message}`);
  });

  return child.pid;
}

// ─── Route handlers ───────────────────────────────────────────────────────────

async function handleHealth(req, res) {
  send(res, 200, { status: 'ok', uptime: process.uptime() });
}

async function handleRepos(_req, res) {
  send(res, 200, { repos: parseRepos() });
}

async function handleUI(_req, res) {
  const validCommands = [...VALID_COMMANDS];
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>roo-way · Test Console</title>
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg: #0f1117;
      --surface: #1a1d27;
      --border: #2e3148;
      --accent: #7c6af7;
      --accent-hover: #9b8dff;
      --text: #e2e4f0;
      --muted: #7b7f9e;
      --success: #34d399;
      --error: #f87171;
      --warn: #fbbf24;
      --radius: 8px;
      --font: 'Inter', system-ui, sans-serif;
      --mono: 'JetBrains Mono', 'Fira Code', monospace;
    }
    body {
      background: var(--bg);
      color: var(--text);
      font-family: var(--font);
      min-height: 100vh;
      padding: 2rem 1rem 4rem;
    }
    header {
      max-width: 760px;
      margin: 0 auto 2.5rem;
    }
    header h1 {
      font-size: 1.6rem;
      font-weight: 700;
      letter-spacing: -0.5px;
      display: flex;
      align-items: center;
      gap: .5rem;
    }
    header p {
      margin-top: .4rem;
      color: var(--muted);
      font-size: .9rem;
    }
    .badge {
      display: inline-block;
      background: var(--accent);
      color: #fff;
      font-size: .65rem;
      font-weight: 600;
      letter-spacing: .04em;
      padding: .15rem .45rem;
      border-radius: 4px;
      text-transform: uppercase;
    }
    .card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 1.5rem;
      max-width: 760px;
      margin: 0 auto 1.5rem;
    }
    .card h2 {
      font-size: 1rem;
      font-weight: 600;
      margin-bottom: 1.2rem;
      display: flex;
      align-items: center;
      gap: .5rem;
    }
    .card h2 .method {
      font-family: var(--mono);
      font-size: .75rem;
      font-weight: 700;
      padding: .2rem .5rem;
      border-radius: 4px;
      background: #1e3a5f;
      color: #60a5fa;
    }
    .card h2 .method.post {
      background: #2d3a1e;
      color: #86efac;
    }
    .field { margin-bottom: 1rem; }
    label {
      display: block;
      font-size: .8rem;
      font-weight: 500;
      color: var(--muted);
      margin-bottom: .35rem;
      text-transform: uppercase;
      letter-spacing: .04em;
    }
    label span.req { color: var(--error); margin-left: 2px; }
    select, input[type="text"], input[type="number"], textarea {
      width: 100%;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      color: var(--text);
      font-family: var(--font);
      font-size: .9rem;
      padding: .55rem .8rem;
      outline: none;
      transition: border-color .15s;
    }
    select:focus, input:focus, textarea:focus {
      border-color: var(--accent);
    }
    textarea { resize: vertical; min-height: 90px; font-family: var(--mono); font-size: .82rem; }
    .row { display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; }
    button {
      display: inline-flex;
      align-items: center;
      gap: .4rem;
      background: var(--accent);
      color: #fff;
      border: none;
      border-radius: var(--radius);
      font-size: .9rem;
      font-weight: 600;
      padding: .6rem 1.3rem;
      cursor: pointer;
      transition: background .15s, opacity .15s;
    }
    button:hover { background: var(--accent-hover); }
    button:disabled { opacity: .5; cursor: not-allowed; }
    button.secondary {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--muted);
      font-size: .8rem;
      padding: .4rem .9rem;
    }
    button.secondary:hover { border-color: var(--accent); color: var(--text); background: transparent; }
    .response-box {
      margin-top: 1.2rem;
      background: var(--bg);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 1rem;
      display: none;
    }
    .response-box.visible { display: block; }
    .response-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: .7rem;
    }
    .status-pill {
      font-size: .78rem;
      font-weight: 700;
      padding: .2rem .6rem;
      border-radius: 20px;
    }
    .status-pill.ok { background: #063d28; color: var(--success); }
    .status-pill.err { background: #3d0606; color: var(--error); }
    .status-pill.warn { background: #3d2e06; color: var(--warn); }
    pre {
      font-family: var(--mono);
      font-size: .8rem;
      white-space: pre-wrap;
      word-break: break-all;
      color: var(--text);
      line-height: 1.6;
    }
    .divider {
      border: none;
      border-top: 1px solid var(--border);
      margin: 1.2rem 0;
    }
    #health-status { font-size: .85rem; color: var(--muted); display: flex; align-items: center; gap: .5rem; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--muted); display: inline-block; }
    .dot.green { background: var(--success); box-shadow: 0 0 6px var(--success); }
    .dot.red { background: var(--error); }
  </style>
</head>
<body>

<header>
  <h1>🦘 roo-way <span class="badge">Test Console</span></h1>
  <p>Manually trigger Roo CLI workflows or inspect the health of this server.</p>
</header>

<!-- Health card -->
<div class="card">
  <h2><span class="method">GET</span> /health</h2>
  <div id="health-status"><span class="dot" id="health-dot"></span><span id="health-text">Checking…</span></div>
</div>

<!-- Trigger card -->
<div class="card">
  <h2><span class="method post">POST</span> /trigger</h2>

  <div class="row">
    <div class="field">
      <label>Command <span class="req">*</span></label>
      <select id="t-command">
        ${validCommands.map((c) => `<option value="${c}">${c}</option>`).join('\n        ')}
      </select>
    </div>
    <div class="field">
      <label>Repository <span class="req">*</span></label>
      <select id="t-repo-select" onchange="onRepoSelectChange()">
        <option value="" disabled selected>Loading repos…</option>
      </select>
      <input type="text" id="t-repo-custom" placeholder="https://github.com/org/repo.git"
             style="margin-top:.5rem;display:none" />
    </div>
  </div>

  <div class="field">
    <label>Title <span class="req">*</span></label>
    <input type="text" id="t-title" placeholder="e.g. Add retry logic to payment service" />
  </div>

  <div class="field">
    <label>Body <span class="req">*</span></label>
    <textarea id="t-body" placeholder="Full issue / ticket description…"></textarea>
  </div>

  <hr class="divider" />

  <div class="row">
    <div class="field">
      <label>Branch <small style="text-transform:none;font-size:.75rem">(optional)</small></label>
      <input type="text" id="t-branch" placeholder="auto-derived from title" />
    </div>
    <div class="field">
      <label>Issue # <small style="text-transform:none;font-size:.75rem">(optional)</small></label>
      <input type="number" id="t-issue" placeholder="42" min="1" />
    </div>
  </div>

  <div class="row">
    <div class="field">
      <label>Extra instruction <small style="text-transform:none;font-size:.75rem">(optional)</small></label>
      <input type="text" id="t-extra" placeholder="Append to prompt…" />
    </div>
    <div class="field">
      <label>Comments <small style="text-transform:none;font-size:.75rem">(optional)</small></label>
      <textarea id="t-comments" style="min-height:40px" placeholder="Prior comment history…"></textarea>
    </div>
  </div>

  <div style="display:flex;gap:.7rem;align-items:center;margin-top:.4rem">
    <button id="trigger-btn" onclick="submitTrigger()">▶ Run</button>
    <button class="secondary" onclick="clearTrigger()">Clear</button>
  </div>

  <div class="response-box" id="trigger-response">
    <div class="response-header">
      <span id="trigger-status-pill" class="status-pill"></span>
      <span id="trigger-ts" style="font-size:.75rem;color:var(--muted)"></span>
    </div>
    <pre id="trigger-pre"></pre>
  </div>
</div>

<script>
  // ── Health check ────────────────────────────────────────────────────────────
  async function checkHealth() {
    const dot  = document.getElementById('health-dot');
    const text = document.getElementById('health-text');
    try {
      const r = await fetch('/health');
      const d = await r.json();
      dot.className  = 'dot green';
      text.textContent = \`OK — uptime \${Math.round(d.uptime)}s\`;
    } catch {
      dot.className  = 'dot red';
      text.textContent = 'Unreachable';
    }
  }
  checkHealth();

  // ── Trigger ─────────────────────────────────────────────────────────────────
  async function submitTrigger() {
    const btn     = document.getElementById('trigger-btn');
    const box     = document.getElementById('trigger-response');
    const pre     = document.getElementById('trigger-pre');
    const pill    = document.getElementById('trigger-status-pill');
    const ts      = document.getElementById('trigger-ts');

    const command  = document.getElementById('t-command').value;
    const sel      = document.getElementById('t-repo-select').value;
    const repo     = (sel === '__other__'
      ? document.getElementById('t-repo-custom').value
      : sel).trim();
    const title    = document.getElementById('t-title').value.trim();
    const body     = document.getElementById('t-body').value.trim();
    const branch   = document.getElementById('t-branch').value.trim();
    const issueRaw = document.getElementById('t-issue').value.trim();
    const extra    = document.getElementById('t-extra').value.trim();
    const comments = document.getElementById('t-comments').value.trim();

    if (!repo)  { alert('Repo URL is required.'); return; }
    if (sel === '__other__' && !repo) { alert('Enter a custom repo URL.'); return; }
    if (!title) { alert('Title is required.'); return; }
    if (!body)  { alert('Body is required.');  return; }

    const payload = { command, repo, title, body };
    if (branch)   payload.branch   = branch;
    if (issueRaw) payload.issue    = Number(issueRaw);
    if (extra)    payload.extra    = extra;
    if (comments) payload.comments = comments;

    btn.disabled = true;
    btn.textContent = '⏳ Sending…';
    box.classList.remove('visible');

    try {
      const r    = await fetch('/trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const data = await r.json();
      const ok   = r.status >= 200 && r.status < 300;

      pill.className   = 'status-pill ' + (ok ? 'ok' : 'err');
      pill.textContent = r.status + ' ' + (ok ? 'Accepted' : 'Error');
      pre.textContent  = JSON.stringify(data, null, 2);
      ts.textContent   = new Date().toLocaleTimeString();
      box.classList.add('visible');
    } catch (err) {
      pill.className   = 'status-pill err';
      pill.textContent = 'Network Error';
      pre.textContent  = err.message;
      ts.textContent   = new Date().toLocaleTimeString();
      box.classList.add('visible');
    } finally {
      btn.disabled = false;
      btn.textContent = '▶ Run';
    }
  }

  function clearTrigger() {
    ['t-title','t-body','t-branch','t-issue','t-extra','t-comments']
      .forEach(id => document.getElementById(id).value = '');
    const sel = document.getElementById('t-repo-select');
    if (sel.options.length) sel.selectedIndex = 0;
    document.getElementById('t-repo-custom').style.display = 'none';
    document.getElementById('t-repo-custom').value = '';
    document.getElementById('trigger-response').classList.remove('visible');
  }

  // ── Repo dropdown ────────────────────────────────────────────────────────────
  function onRepoSelectChange() {
    const sel    = document.getElementById('t-repo-select');
    const custom = document.getElementById('t-repo-custom');
    custom.style.display = sel.value === '__other__' ? 'block' : 'none';
  }

  async function loadRepos() {
    const sel = document.getElementById('t-repo-select');
    try {
      const r    = await fetch('/repos');
      const data = await r.json();
      const list = Array.isArray(data.repos) ? data.repos : [];
      sel.innerHTML = '';
      if (list.length === 0) {
        const opt = document.createElement('option');
        opt.value = '__other__';
        opt.textContent = 'Other (enter URL)…';
        sel.appendChild(opt);
        document.getElementById('t-repo-custom').style.display = 'block';
      } else {
        list.forEach((url) => {
          const opt = document.createElement('option');
          opt.value = url;
          // show only the org/repo portion as label
          opt.textContent = url.replace(/^https?:\\/\\/[^/]+\\//, '').replace(/\\.git$/, '');
          opt.title = url;
          sel.appendChild(opt);
        });
        const other = document.createElement('option');
        other.value = '__other__';
        other.textContent = 'Other (enter URL)…';
        sel.appendChild(other);
      }
      sel.selectedIndex = 0;
      onRepoSelectChange();
    } catch {
      sel.innerHTML = '<option value="__other__">Other (enter URL)…</option>';
      document.getElementById('t-repo-custom').style.display = 'block';
    }
  }
  loadRepos();
</script>
</body>
</html>`;
  sendHtml(res, html);
}

async function handleTrigger(req, res) {
  const raw = await readBody(req);
  let body;
  try {
    body = JSON.parse(raw.toString());
  } catch {
    return send(res, 400, { error: 'Invalid JSON body' });
  }

  const {
    command,
    repo,
    title,
    body: issueBody,
    comments,
    branch,
    extra,
    issue,
  } = body;

  if (!command || !VALID_COMMANDS.has(command)) {
    return send(res, 400, {
      error: `Invalid or missing 'command'. Must be one of: ${[...VALID_COMMANDS].join(', ')}`,
    });
  }

  if (!repo || typeof repo !== 'string' || !repo.trim()) {
    return send(res, 400, {
      error:
        "Missing or empty 'repo'. Provide the HTTPS clone URL of the target repository.",
    });
  }

  if (!title || typeof title !== 'string' || !title.trim()) {
    return send(res, 400, { error: "Missing or empty 'title'" });
  }

  if (!issueBody || typeof issueBody !== 'string' || !issueBody.trim()) {
    return send(res, 400, { error: "Missing or empty 'body'" });
  }

  if (issue !== undefined && !/^\d+$/.test(String(issue))) {
    return send(res, 400, {
      error: "'issue' must be a positive integer when provided",
    });
  }

  if (!process.env.OPENROUTER_API_KEY) {
    return send(res, 500, {
      error: 'OPENROUTER_API_KEY is not configured on the server',
    });
  }

  const pid = runScript(command, {
    repo: repo.trim(),
    title: title.trim(),
    body: issueBody.trim(),
    comments: comments || '',
    branch: branch || '',
    issue: issue != null ? String(issue) : '',
    extra: extra || '',
  });

  send(res, 202, {
    accepted: true,
    command,
    repo: repo.trim(),
    title: title.trim(),
    issue: issue != null ? Number(issue) : null,
    pid,
  });
}

async function handleWebhook(req, res) {
  const raw = await readBody(req);

  const event = req.headers['x-github-event'];
  if (event !== 'issues') {
    // Acknowledge non-issue events without acting
    return send(res, 200, { ignored: true, event });
  }

  let payload;
  try {
    payload = JSON.parse(raw.toString());
  } catch {
    return send(res, 400, { error: 'Invalid JSON payload' });
  }

  if (payload.action !== 'labeled') {
    return send(res, 200, { ignored: true, action: payload.action });
  }

  const labelName = payload?.label?.name || '';
  const issueNumber = payload?.issue?.number;

  if (!VALID_COMMANDS.has(labelName)) {
    log(`Label '${labelName}' is not a roo command — ignoring`);
    return send(res, 200, { ignored: true, label: labelName });
  }

  // Extract issue content directly from the webhook payload — no GitHub API call needed
  const issueTitle = payload?.issue?.title || '';
  const issueBody = payload?.issue?.body || '(no description)';
  // GitHub always includes repository.clone_url in webhook payloads
  const repoUrl = payload?.repository?.clone_url || '';

  if (!issueTitle) {
    return send(res, 400, {
      error: 'Could not determine issue title from payload',
    });
  }

  if (!issueNumber) {
    return send(res, 400, {
      error: 'Could not determine issue number from payload',
    });
  }

  if (!repoUrl) {
    return send(res, 400, {
      error: 'Could not determine repository clone URL from webhook payload',
    });
  }

  if (!process.env.OPENROUTER_API_KEY) {
    logE('OPENROUTER_API_KEY is not set — cannot process webhook');
    return send(res, 500, {
      error: 'OPENROUTER_API_KEY is not configured on the server',
    });
  }

  log(
    `Webhook: label '${labelName}' applied to issue #${issueNumber} — "${issueTitle}" (repo: ${repoUrl})`,
  );

  const pid = runScript(labelName, {
    repo: repoUrl,
    title: issueTitle,
    body: issueBody,
    comments: '', // labeled events do not include comment history
    branch: '',
    issue: String(issueNumber),
    extra: '',
  });

  send(res, 202, {
    accepted: true,
    command: labelName,
    issue: issueNumber,
    title: issueTitle,
    pid,
  });
}

// ─── HTTP server ──────────────────────────────────────────────────────────────
const server = http.createServer(async (req, res) => {
  const { method, url } = req;
  try {
    if (method === 'GET' && (url === '/' || url === ''))
      return await handleUI(req, res);
    if (method === 'GET' && url === '/health')
      return await handleHealth(req, res);
    if (method === 'GET' && url === '/repos')
      return await handleRepos(req, res);
    if (method === 'POST' && url === '/trigger')
      return await handleTrigger(req, res);
    if (method === 'POST' && url === '/webhook')
      return await handleWebhook(req, res);

    send(res, 404, { error: 'Not found' });
  } catch (err) {
    logE('Unhandled error:', err);
    send(res, 500, { error: 'Internal server error' });
  }
});

server.listen(PORT, '0.0.0.0', () => {
  log(`roo-way server listening on port ${PORT}`);
  log(`Script path: ${SCRIPT_PATH}`);
  log(
    `OPENROUTER_API_KEY: ${process.env.OPENROUTER_API_KEY ? 'configured' : 'NOT SET'}`,
  );
  log(`GH_TOKEN: ${process.env.GH_TOKEN ? 'configured' : 'NOT SET'}`);
});
