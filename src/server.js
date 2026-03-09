/**
 * AutoADA Web Server — Express API with SSE progress streaming.
 * Serves the web UI and provides endpoints to trigger scans and retrieve results.
 */

const express = require('express');
const path = require('path');
const crypto = require('crypto');

const { discoverPages } = require('./crawler');
const { scanAllPages } = require('./scanner');
const { calculateScores } = require('./score');
const { generateJson } = require('./reporters/json');
const { generateCsv } = require('./reporters/csv');
const { generateHtml } = require('./reporters/html');
const { generatePdf } = require('./reporters/pdf');

const app = express();
app.use(express.json());

// ---------------------------------------------------------------------------
// In-memory scan store with TTL cleanup
// ---------------------------------------------------------------------------
const scans = new Map();
const SCAN_TTL_MS = 30 * 60 * 1000; // 30 minutes
const MAX_CONCURRENT_SCANS = 3;

// Periodic cleanup: remove completed/errored scans older than TTL
setInterval(() => {
  const now = Date.now();
  for (const [id, scan] of scans) {
    if (scan.status === 'running') continue;
    if (now - scan.startedAt > SCAN_TTL_MS) {
      scans.delete(id);
    }
  }
}, 60 * 1000); // Check every minute

// ---------------------------------------------------------------------------
// Serve frontend
// ---------------------------------------------------------------------------
app.use('/web', express.static(path.join(__dirname, 'web')));

app.get('/', (_req, res) => {
  res.sendFile(path.join(__dirname, 'web', 'index.html'));
});

// ---------------------------------------------------------------------------
// POST /api/scan — Start a new scan
// ---------------------------------------------------------------------------
app.post('/api/scan', (req, res) => {
  const { url, maxPages = 100, timeout = 30000, tags, clientName, clientColor, crawl = false, interactive = false, concurrency = 1 } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'url is required' });
  }

  // Enforce concurrent scan limit
  const runningScans = [...scans.values()].filter((s) => s.status === 'running').length;
  if (runningScans >= MAX_CONCURRENT_SCANS) {
    return res.status(429).json({ error: `Maximum ${MAX_CONCURRENT_SCANS} concurrent scans allowed. Please wait for a scan to complete.` });
  }

  try {
    new URL(url);
  } catch {
    return res.status(400).json({ error: 'Invalid URL. Include protocol (e.g. https://example.com)' });
  }

  const scanId = crypto.randomUUID();
  const scanRecord = {
    id: scanId,
    url,
    status: 'running',
    progress: [],
    results: null,
    scores: null,
    error: null,
    startedAt: Date.now(),
    options: { maxPages, timeout, tags, clientName, clientColor, crawl, interactive, concurrency: Math.max(1, parseInt(concurrency, 10) || 1) },
    sseClients: [],
  };

  scans.set(scanId, scanRecord);

  // Run scan asynchronously
  runScan(scanRecord).catch((err) => {
    scanRecord.status = 'error';
    scanRecord.error = err.message;
    broadcastSSE(scanRecord, { phase: 'error', message: err.message });
    closeSSEClients(scanRecord);
  });

  return res.json({ scanId });
});

// ---------------------------------------------------------------------------
// GET /api/scan/:id/progress — SSE stream
// ---------------------------------------------------------------------------
app.get('/api/scan/:id/progress', (req, res) => {
  const scan = scans.get(req.params.id);
  if (!scan) return res.status(404).json({ error: 'Scan not found' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  // Send all past progress events (replay)
  for (const evt of scan.progress) {
    res.write(`data: ${JSON.stringify(evt)}\n\n`);
  }

  // If already finished, send final event and close
  if (scan.status === 'done') {
    res.write(`data: ${JSON.stringify({ phase: 'done' })}\n\n`);
    return res.end();
  }
  if (scan.status === 'error') {
    res.write(`data: ${JSON.stringify({ phase: 'error', message: scan.error })}\n\n`);
    return res.end();
  }

  // Register this client for live updates
  scan.sseClients.push(res);
  req.on('close', () => {
    scan.sseClients = scan.sseClients.filter((c) => c !== res);
  });
});

// ---------------------------------------------------------------------------
// GET /api/scan/:id/results — Full results JSON
// ---------------------------------------------------------------------------
app.get('/api/scan/:id/results', (req, res) => {
  const scan = scans.get(req.params.id);
  if (!scan) return res.status(404).json({ error: 'Scan not found' });
  if (scan.status === 'running') return res.status(202).json({ status: 'running' });
  if (scan.status === 'error') return res.status(500).json({ error: scan.error });

  res.json({
    scanResult: scan.results,
    scores: scan.scores,
  });
});

// ---------------------------------------------------------------------------
// GET /api/scan/:id/export/:format — Download report
// ---------------------------------------------------------------------------
app.get('/api/scan/:id/export/:format', async (req, res) => {
  const scan = scans.get(req.params.id);
  if (!scan) return res.status(404).json({ error: 'Scan not found' });
  if (scan.status !== 'done') return res.status(400).json({ error: 'Scan not complete' });

  const format = req.params.format;
  const hostname = new URL(scan.url).hostname.replace(/[^a-z0-9]/gi, '-');
  const dateStr = new Date().toISOString().slice(0, 10);
  const baseName = `${hostname}-ada-report-${dateStr}`;

  const brandingOptions = {
    clientName: scan.options.clientName || null,
    clientLogoBase64: null,
    clientColor: scan.options.clientColor || null,
  };

  try {
    switch (format) {
      case 'json': {
        const content = generateJson(scan.results, scan.scores);
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename="${baseName}.json"`);
        return res.send(content);
      }
      case 'csv': {
        const content = generateCsv(scan.results);
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="${baseName}.csv"`);
        return res.send(content);
      }
      case 'html': {
        const content = generateHtml(scan.results, scan.scores, brandingOptions);
        res.setHeader('Content-Type', 'text/html');
        res.setHeader('Content-Disposition', `attachment; filename="${baseName}.html"`);
        return res.send(content);
      }
      case 'pdf': {
        const htmlContent = generateHtml(scan.results, scan.scores, brandingOptions);
        const pdfBuffer = await generatePdf(htmlContent);
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename="${baseName}.pdf"`);
        return res.send(pdfBuffer);
      }
      default:
        return res.status(400).json({ error: `Unknown format: ${format}` });
    }
  } catch (err) {
    return res.status(500).json({ error: `Export failed: ${err.message}` });
  }
});

// ---------------------------------------------------------------------------
// Scan execution
// ---------------------------------------------------------------------------
async function runScan(scanRecord) {
  const { url, options } = scanRecord;
  const wcagTags = options.tags
    ? options.tags.split(',').map((t) => t.trim())
    : ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

  // Phase 1: Discover pages
  broadcastSSE(scanRecord, { phase: 'discovering', message: 'Discovering pages...' });
  let pages;
  try {
    pages = await discoverPages(url, null, options.maxPages, { enabled: options.crawl });
  } catch {
    pages = [url];
  }
  broadcastSSE(scanRecord, { phase: 'discovered', pageCount: pages.length, message: `Found ${pages.length} page(s)` });

  // Phase 2: Scan pages (with progress callback)
  const scanResult = await scanAllPages(pages, {
    tags: wcagTags,
    timeout: options.timeout,
    interactive: options.interactive,
    concurrency: options.concurrency || 1,
    onProgress: (data) => broadcastSSE(scanRecord, data),
  });

  // Phase 3: Calculate scores
  broadcastSSE(scanRecord, { phase: 'scoring', message: 'Calculating scores...' });
  const scores = calculateScores(scanResult);

  // Store results
  scanRecord.results = scanResult;
  scanRecord.scores = scores;
  scanRecord.status = 'done';

  broadcastSSE(scanRecord, { phase: 'done' });
  closeSSEClients(scanRecord);
}

function broadcastSSE(scanRecord, data) {
  scanRecord.progress.push(data);
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const client of scanRecord.sseClients) {
    client.write(payload);
  }
}

function closeSSEClients(scanRecord) {
  for (const client of scanRecord.sseClients) {
    client.end();
  }
  scanRecord.sseClients = [];
  // Free progress array — no longer needed after all clients disconnected
  scanRecord.progress = [];
}

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
app.listen(PORT, HOST, () => {
  console.log(`\n  AutoADA Web UI running at http://localhost:${PORT}\n`);
});
