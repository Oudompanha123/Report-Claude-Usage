#!/usr/bin/env node
/**
 * Claude Code usage reporter - runs on YOUR machine, reports only YOUR usage.
 *
 * Reads this machine's own ~/.claude/projects transcripts (*.jsonl), sums today's
 * tokens, and POSTs the running day total to the team dashboard's /api/ingest.
 *
 * It never reads anyone else's account and never talks to Anthropic. Every teammate
 * runs their own copy; the dashboard is the union of what people choose to send.
 *
 * Config (env vars, or a claude-usage.config.json next to this script):
 *   USER_EMAIL     your identity on the dashboard, e.g. you@company.com
 *   USER_NAME      the name shown on the dashboard, e.g. "Socheat Hun"
 *   INGEST_URL     the Coc Docs Platform backend's ingest route, e.g.
 *                  http://localhost:8080/api/ingest (local dev) or
 *                  https://<your-backend-host>/api/ingest once deployed
 *   INGEST_SECRET  the shared bearer secret (app.claude-usage.ingest-secret
 *                  on the backend) — ask whoever holds it
 * Optional:
 *   CLAUDE_PROJECTS_DIR  override the transcript directory
 *
 * On first run in a terminal it asks for your name once and saves it, so a
 * scheduled run never has to.
 *
 * Usage: node push-usage.mjs [--dry-run] [--verbose] [--days N]
 *
 * --days N reports the last N days instead of just today, for a one-off backfill
 * of history that is still in your transcripts (e.g. --days 30).
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

// Must agree with the backend's own reporting zone (ClaudeUsageService.
// REPORT_ZONE, ADR-035) — otherwise a report made near midnight lands under
// the wrong calendar date on one side of the gap between the two zones.
const REPORT_TZ = 'Asia/Phnom_Penh';
const HTTP_TIMEOUT_MS = 10_000;
const HERE = path.dirname(fileURLToPath(import.meta.url));

const argv = process.argv.slice(2);
const args = new Set(argv);
const DRY_RUN = args.has('--dry-run');
const VERBOSE = args.has('--verbose');

/**
 * How many days back to report, today inclusive. 1 is the normal scheduled run.
 * Larger values backfill history from transcripts still on disk — useful once,
 * when a team first starts using the dashboard.
 */
const DAYS = (() => {
  const i = argv.findIndex((a) => a === '--days' || a.startsWith('--days='));
  if (i === -1) return 1;
  const raw = argv[i].includes('=') ? argv[i].split('=')[1] : argv[i + 1];
  const n = Number(raw);
  return Number.isInteger(n) && n >= 1 && n <= 400 ? n : 1;
})();

function debug(...parts) {
  if (VERBOSE) console.error('[debug]', ...parts);
}

/**
 * Abort with a one-line diagnostic. Throws rather than calling process.exit():
 * exiting hard while a fetch socket is still open trips a libuv assertion on
 * Windows and reports 127 instead of 1, which would hide real failures from
 * Task Scheduler.
 */
class Fatal extends Error {}

function fail(message) {
  throw new Fatal(message);
}

// ---------------------------------------------------------------- config

/** Env wins; the JSON file is the fallback so a teammate can set it up once, by hand. */
function loadConfig() {
  let fromFile = {};
  const configPath = path.join(HERE, 'claude-usage.config.json');
  if (fs.existsSync(configPath)) {
    try {
      fromFile = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      debug('loaded config file', configPath);
    } catch {
      fail(`${configPath} exists but is not valid JSON.`);
    }
  }

  const pick = (key) => process.env[key] ?? fromFile[key];
  const config = {
    userEmail: String(pick('USER_EMAIL') ?? '').trim().toLowerCase(),
    userName: String(pick('USER_NAME') ?? '').trim(),
    ingestUrl: String(pick('INGEST_URL') ?? '').trim(),
    ingestSecret: String(pick('INGEST_SECRET') ?? '').trim(),
    // Optional. Only needed when the deployment sits behind Vercel Deployment
    // Protection: the dashboard stays private to the team while this script is still
    // allowed to post. Vercel calls it "Protection Bypass for Automation".
    bypassToken: String(pick('VERCEL_AUTOMATION_BYPASS_SECRET') ?? '').trim(),
    projectsDir:
      String(pick('CLAUDE_PROJECTS_DIR') ?? '').trim() ||
      path.join(os.homedir(), '.claude', 'projects'),
  };

  const missing = [];
  if (!config.userEmail) missing.push('USER_EMAIL');
  if (!DRY_RUN && !config.ingestUrl) missing.push('INGEST_URL');
  if (!DRY_RUN && !config.ingestSecret) missing.push('INGEST_SECRET');
  if (missing.length) {
    fail(
      `missing config: ${missing.join(', ')}. Set them as env vars or in ` +
        'scripts/claude-usage.config.json (copy claude-usage.config.example.json).',
    );
  }
  if (!config.userEmail.includes('@')) {
    fail(`USER_EMAIL "${config.userEmail}" does not look like an email address.`);
  }
  return { config, configPath, fromFile };
}

// ---------------------------------------------------------------- dates

const ymdFormatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: REPORT_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Calendar date of an instant, as seen in the team's fixed reporting timezone. */
function ymd(at) {
  return ymdFormatter.format(at);
}

/**
 * The last `count` reporting days, oldest first, ending today. Walks back in whole
 * days from now and formats each in the reporting timezone, so a DST or offset
 * change cannot drop or duplicate a date.
 */
function lastDays(count) {
  const out = [];
  const now = Date.now();
  for (let i = count - 1; i >= 0; i--) {
    out.push(ymd(new Date(now - i * 86400000)));
  }
  return [...new Set(out)];
}

// ---------------------------------------------------------------- log scan

function findTranscripts(dir) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // unreadable or missing directory - treated as "no usage"
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...findTranscripts(full));
    else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(full);
  }
  return out;
}

/**
 * A file not written to since before today started cannot contain today's entries,
 * so it can be skipped outright. mtime only moves forward as Claude Code appends,
 * which makes this safe rather than merely fast. The extra day of slack absorbs
 * clock skew and sessions that span midnight.
 */
function touchedRecently(file, cutoffMs) {
  try {
    return fs.statSync(file).mtimeMs >= cutoffMs;
  } catch {
    return false;
  }
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Sum today's tokens across this machine's transcripts.
 *
 * The critical detail: Claude Code writes ONE LINE PER CONTENT BLOCK, and every line
 * of the same assistant response repeats that response's full usage object. Summing
 * every line double-counts badly - measured 2.36x against a real transcript set. So
 * dedupe on message.id + requestId, one charge per API response, the way ccusage does.
 */
function collectDays(projectsDir, dates) {
  const wanted = new Set(dates);
  const oldest = dates[0];
  const cutoffMs = Date.parse(`${oldest}T00:00:00Z`) - 36 * 3600 * 1000;
  const files = findTranscripts(projectsDir).filter((file) => touchedRecently(file, cutoffMs));
  debug(`scanning ${files.length} recently-touched transcript(s) in ${projectsDir}`);

  const seen = new Set();
  // One bucket per day. A message id is unique across the whole scan, so `seen`
  // stays global rather than per-day.
  const days = new Map();
  const bucketFor = (date) => {
    if (!days.has(date)) {
      days.set(date, {
        totals: { input: 0, output: 0, cache_read: 0, cache_creation: 0 },
        byModel: {},
        counted: 0,
      });
    }
    return days.get(date);
  };
  let counted = 0;
  let skipped = 0;

  for (const file of files) {
    let contents;
    try {
      contents = fs.readFileSync(file, 'utf8');
    } catch {
      skipped++; // a session being written right now, or a permissions hiccup
      continue;
    }

    for (const line of contents.split('\n')) {
      if (!line.trim()) continue;

      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        skipped++; // half-flushed final line - never fatal
        continue;
      }

      const usage = entry?.message?.usage;
      if (!usage || typeof usage !== 'object') continue;
      if (!entry.timestamp) continue;
      const day = ymd(new Date(entry.timestamp));
      if (!wanted.has(day)) continue;

      const key = `${entry.message?.id ?? ''}|${entry.requestId ?? ''}`;
      if (key !== '|') {
        if (seen.has(key)) continue;
        seen.add(key);
      }

      const slot = bucketFor(day);
      const model = String(entry.message?.model ?? 'unknown');
      const bucket = (slot.byModel[model] ??= {
        input: 0,
        output: 0,
        cache_read: 0,
        cache_creation: 0,
      });

      const add = {
        input: num(usage.input_tokens),
        output: num(usage.output_tokens),
        cache_read: num(usage.cache_read_input_tokens),
        cache_creation: num(usage.cache_creation_input_tokens),
      };
      for (const k of Object.keys(add)) {
        slot.totals[k] += add[k];
        bucket[k] += add[k];
      }
      slot.counted++;
      counted++;
    }
  }

  debug(`counted ${counted} response(s), skipped ${skipped} unreadable line(s)`);
  return { days, counted, skipped, files: files.length };
}

// ---------------------------------------------------------------- send

/**
 * Translate the transport failures a corporate laptop actually produces. fetch()
 * reports all of them as a bare "fetch failed", which tells a teammate nothing about
 * what to go and fix.
 */
function explainNetworkError(error, url) {
  const code = error?.cause?.code ?? error?.code ?? '';

  if (error?.name === 'AbortError') {
    return `no response from ${url} within ${HTTP_TIMEOUT_MS / 1000}s`;
  }
  if (code === 'SELF_SIGNED_CERT_IN_CHAIN' || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') {
    return (
      'a proxy or DLP agent on this machine is intercepting HTTPS and Node does not ' +
      'trust its certificate. Export that root CA and set NODE_EXTRA_CA_CERTS to it ' +
      '(see the README, Troubleshooting). Do not disable certificate checking — this ' +
      'request carries the shared ingest secret.'
    );
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return `cannot resolve the host in INGEST_URL (${url}). Check it for typos.`;
  }
  if (code === 'ECONNREFUSED') {
    return `nothing is listening at ${url}. Is the dashboard deployed and INGEST_URL right?`;
  }
  return `${error.message}${code ? ` (${code})` : ''}`;
}

async function postOnce(url, secret, payload, bypassToken) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${secret}`,
        // Only present when the deployment sits behind Vercel Deployment Protection.
        ...(bypassToken ? { 'x-vercel-protection-bypass': bypassToken } : {}),
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
  } catch (error) {
    throw new Error(explainNetworkError(error, url));
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 401) {
    const body = await res.text().catch(() => '');
    // Vercel's own protection answers before the app does, and looks nothing like
    // our 401 — distinguishing them saves a long hunt for a wrong secret.
    if (body.includes('vercel_auth_callback') || body.includes('_vercel_sso')) {
      throw new Error(
        'blocked by Vercel Deployment Protection, not by the app. Either turn protection ' +
          'off for production, or create a Protection Bypass for Automation secret and set ' +
          'VERCEL_AUTOMATION_BYPASS_SECRET here. (See the README, Troubleshooting.)',
      );
    }
    throw new Error('rejected (401): INGEST_SECRET here does not match the one on the server.');
  }
  if (res.status === 404) {
    throw new Error(`no ingest route at ${url}. It should end with /api/ingest.`);
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${body.slice(0, 200)}`);
  }
  return true;
}

/** One retry, then give up - the next scheduled tick will try again. */
async function send(url, secret, payload, bypassToken) {
  try {
    return await postOnce(url, secret, payload, bypassToken);
  } catch (error) {
    debug('first attempt failed:', error.message);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    return postOnce(url, secret, payload, bypassToken);
  }
}

/**
 * Release the keep-alive sockets fetch() left open, so a scheduled run exits as soon
 * as its work is done instead of idling until the connection pool times out.
 */
async function closeConnections() {
  try {
    await globalThis[Symbol.for('undici.globalDispatcher.1')]?.close?.();
  } catch {
    // No pool in use, or already closed - the process will exit on its own.
  }
}

/**
 * Ask for the display name once, and remember it.
 *
 * Only ever prompts when stdin is a real terminal, so a scheduled run can never
 * hang waiting for input it will not get — it falls back to the email's local part
 * and carries on. The answer is written back to the config file so the next run,
 * scheduled or not, already has it.
 */
async function resolveName(config, configPath, fromFile) {
  if (config.userName) return config.userName;

  const fallback = config.userEmail.split('@')[0];
  if (!process.stdin.isTTY || !process.stdout.isTTY) return fallback;

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => {
    rl.question(`Your name as it should appear on the dashboard [${fallback}]: `, resolve);
  });
  rl.close();

  const name = String(answer).trim().slice(0, 60) || fallback;

  try {
    const next = { ...fromFile, USER_NAME: name };
    fs.writeFileSync(configPath, JSON.stringify(next, null, 2) + String.fromCharCode(10));
    console.log(`saved USER_NAME to ${configPath}`);
  } catch {
    console.error('could not save the name; set USER_NAME in the config or environment.');
  }
  return name;
}

// ---------------------------------------------------------------- main

async function main() {
  const { config, configPath, fromFile } = loadConfig();
  const userName = await resolveName(config, configPath, fromFile);
  const dates = lastDays(DAYS);
  const { days, files } = collectDays(config.projectsDir, dates);

  if (DAYS > 1) {
    debug(`scanning ${DAYS} days: ${dates[0]} .. ${dates[dates.length - 1]}`);
  }

  const payloads = dates
    .map((date) => {
      const slot = days.get(date);
      if (!slot) return null; // nothing was logged that day
      const { totals, byModel, counted } = slot;
      const total = Math.round(totals.input + totals.output);
      if (total <= 0) return null;

      // Only models that actually consumed tokens. Claude Code logs a
      // <synthetic> pseudo-model for locally generated messages with all
      // counts at zero; this filter drops it from both byModel and models.
      const activeModels = Object.entries(byModel).filter(
        ([, t]) => t.input + t.output + t.cache_read + t.cache_creation > 0,
      );

      // The per-model breakdown the backend prices at each model's own real
      // rate (ClaudeUsageService/ClaudeUsagePricing, ADR-036) — without this,
      // it has no way to tell a cheap Haiku token from an expensive Opus one,
      // and reports $0 rather than guessing. Field names (camelCase) match
      // ApiDtos.ClaudeUsageModelTokensRequest exactly.
      const byModelPayload = Object.fromEntries(
        activeModels.map(([model, t]) => [
          model,
          {
            input: Math.round(t.input),
            output: Math.round(t.output),
            cacheRead: Math.round(t.cache_read),
            cacheCreation: Math.round(t.cache_creation),
          },
        ]),
      );

      // Names only, for display and as the fallback the backend uses if
      // byModel is ever empty — derived from the same filtered set so the
      // two can never disagree about which models actually ran.
      const models = activeModels.map(([model]) => model).sort();

      return {
        payload: {
          // Field names match ClaudeUsageIngestRequest (ApiDtos.java) exactly
          // — this is Coc Docs Platform's own backend, not the Google-Sheets
          // tool this script was adapted from, and the two contracts are not
          // interchangeable even though both are called "/api/ingest".
          email: config.userEmail,
          displayName: userName,
          date,
          input: Math.round(totals.input),
          output: Math.round(totals.output),
          cacheRead: Math.round(totals.cache_read),
          cacheCreation: Math.round(totals.cache_creation),
          models,
          byModel: byModelPayload,
        },
        total,
        counted,
      };
    })
    .filter(Boolean);

  if (payloads.length === 0) {
    console.log(`no usage found for ${dates.length === 1 ? dates[0] : `${dates[0]}..${dates[dates.length - 1]}`}`);
    return;
  }

  if (DRY_RUN) {
    console.log(
      JSON.stringify(
        payloads.map(({ payload, total, counted }) => ({ ...payload, _total: total, _responses: counted })),
        null,
        2,
      ),
    );
    debug(`${payloads.length} day(s), ${files} file(s) scanned`);
    return;
  }

  // Oldest first, one request per day. Each is an independent upsert, so a failure
  // part-way through leaves the days already sent correctly recorded.
  let sent = 0;
  for (const { payload, total } of payloads) {
    await send(config.ingestUrl, config.ingestSecret, payload, config.bypassToken);
    sent++;
    if (payloads.length > 1) {
      console.log(`  ${payload.date}  ${total} tokens`);
    }
  }

  const range = payloads.length === 1 ? payloads[0].payload.date : `${payloads[0].payload.date}..${payloads[sent - 1].payload.date}`;
  const totalTokens = payloads.reduce((n, { total }) => n + total, 0);
  console.log(`sent ${totalTokens} tokens for ${range} (${userName} <${config.userEmail}>)`);
}

main()
  .catch((error) => {
    console.error(`push-usage: ${error.message}`);
    process.exitCode = 1;
  })
  .finally(closeConnections);
