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

const PORT = parseInt(process.env.PORT || '3000', 10);

// Label names that map directly to roo-local.sh commands
const VALID_COMMANDS = new Set(['roo-code', 'roo-design']);

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

// ─── Run roo-local.sh in the background ──────────────────────────────────────
// Content is forwarded via env vars so the script never calls the GitHub API.
//
// @param {string} command   — roo-bug | roo-code | roo-design | roo-docs
// @param {object} content   — { title, body, comments?, branch?, issue?, extra? }
function runScript(command, content = {}) {
  const {
    title,
    body,
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

  if (!process.env.OPENROUTER_API_KEY) {
    logE('OPENROUTER_API_KEY is not set — cannot process webhook');
    return send(res, 500, {
      error: 'OPENROUTER_API_KEY is not configured on the server',
    });
  }

  log(
    `Webhook: label '${labelName}' applied to issue #${issueNumber} — "${issueTitle}"`,
  );

  const pid = runScript(labelName, {
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
    if (method === 'GET' && url === '/health')
      return await handleHealth(req, res);
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
