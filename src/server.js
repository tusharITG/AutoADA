/**
 * AutoADA Web Server — Express API with SSE progress streaming.
 * Serves the web UI and provides endpoints to trigger scans and retrieve results.
 */

const fs = require('fs');
const express = require('express');
const path = require('path');
const crypto = require('crypto');

const { discoverPages, crawlLinks, crawlLinksWithBrowser, parseRobotsTxt } = require('./crawler');
const { scanAllPages } = require('./scanner');
const { calculateScores, getPrinciple } = require('./score');
const { generateJson } = require('./reporters/json');
const { generateCsv } = require('./reporters/csv');
const { generateHtml } = require('./reporters/html');
const { generatePdf } = require('./reporters/pdf');
const { runFullSeoScan } = require('./seo');
const { escapeHtml: escHtml, getWcagDetails } = require('./reporters/utils');

let remediationData = {};
try { remediationData = require('./data/remediation.json'); } catch {}
let wcagMap = {};
try { wcagMap = require('./data/wcag-map.json'); } catch {}

// IT Geeks default logo (base64-encoded PNG) for reports
let DEFAULT_LOGO_BASE64 = '';
try {
  DEFAULT_LOGO_BASE64 = fs.readFileSync(path.join(__dirname, 'web', 'itgeeks-logo.png')).toString('base64');
} catch { /* logo not available */ }

const app = express();
app.use(express.json());

// ---------------------------------------------------------------------------
// In-memory scan store with TTL cleanup
// ---------------------------------------------------------------------------
const scans = new Map();
const SCAN_TTL_MS = 30 * 60 * 1000; // 30 minutes
const SCAN_STALE_TIMEOUT_MS = 60 * 60 * 1000; // 60 minutes — force-mark crashed running scans
const MAX_CONCURRENT_SCANS = 3;

// Periodic cleanup: remove completed/errored scans older than TTL,
// and force-mark stale running scans as errored after SCAN_STALE_TIMEOUT_MS
setInterval(() => {
  const now = Date.now();
  for (const [id, scan] of scans) {
    if (scan.status === 'running') {
      // Force-mark stale running scans that likely crashed
      if (now - scan.startedAt > SCAN_STALE_TIMEOUT_MS) {
        scan.status = 'error';
        scan.error = 'Scan timed out after 60 minutes — likely crashed';
        scan.completedAt = now;
        broadcastSSE(scan, { phase: 'error', message: scan.error });
        closeSSEClients(scan);
      }
      continue;
    }
    // Don't delete scans that have active sitemap generation in progress
    if (scan.sitemapGeneration && scan.sitemapGeneration.status === 'crawling') continue;
    const finishedAt = scan.completedAt || scan.startedAt;
    if (now - finishedAt > SCAN_TTL_MS) {
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
// GET /api/data/:name — Serve data files (remediation, wcag-map, false-positives)
// ---------------------------------------------------------------------------
const DATA_FILES_WHITELIST = ['remediation', 'wcag-map', 'false-positives'];
app.get('/api/data/:name', (req, res) => {
  const name = req.params.name;
  if (!DATA_FILES_WHITELIST.includes(name)) {
    return res.status(404).json({ error: 'Unknown data file' });
  }
  const filePath = path.join(__dirname, 'data', `${name}.json`);
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.sendFile(filePath);
});

// ---------------------------------------------------------------------------
// POST /api/scan — Start a new scan
// ---------------------------------------------------------------------------
app.post('/api/scan', (req, res) => {
  const { url, maxPages = 100, timeout = 30000, tags, clientName, clientColor, clientLogoBase64, crawl = false, interactive = false, concurrency = 1 } = req.body;

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
    options: {
      maxPages, timeout, tags, clientName, clientColor, crawl, interactive,
      concurrency: Math.max(1, parseInt(concurrency, 10) || 1),
      clientLogoBase64: (typeof clientLogoBase64 === 'string' && clientLogoBase64.startsWith('data:image/') && clientLogoBase64.length < 512000) ? clientLogoBase64 : null,
    },
    sseClients: [],
  };

  scans.set(scanId, scanRecord);

  // Run scan asynchronously
  runScan(scanRecord).catch((err) => {
    scanRecord.status = 'error';
    scanRecord.error = err.message;
    scanRecord.completedAt = Date.now();
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
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
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

  // Heartbeat every 25s to prevent proxy/browser idle timeouts
  const heartbeat = setInterval(() => {
    try { res.write(':\n\n'); } catch { clearInterval(heartbeat); scan.sseClients = scan.sseClients.filter((c) => c !== res); }
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
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
    sitemapStatus: scan.sitemapStatus || null,
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
    clientLogoBase64: scan.options.clientLogoBase64 || null,
    clientColor: scan.options.clientColor || null,
  };

  // Auto-save reports to project reports/ directory
  const reportsDir = path.join(__dirname, '..', 'reports');
  try { fs.mkdirSync(reportsDir, { recursive: true }); } catch (e) { console.warn(`  Warning: Could not create reports dir: ${e.message}`); }

  try {
    switch (format) {
      case 'json': {
        const content = generateJson(scan.results, scan.scores);
        try { fs.writeFileSync(path.join(reportsDir, `${baseName}.json`), content, 'utf-8'); } catch (e) { console.warn(`  Warning: Could not save JSON report: ${e.message}`); }
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${baseName}.json"`);
        return res.send(content);
      }
      case 'csv': {
        const content = generateCsv(scan.results);
        try { fs.writeFileSync(path.join(reportsDir, `${baseName}.csv`), content, 'utf-8'); } catch (e) { console.warn(`  Warning: Could not save CSV report: ${e.message}`); }
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${baseName}.csv"`);
        return res.send(content);
      }
      case 'html': {
        const content = generateHtml(scan.results, scan.scores, brandingOptions);
        try { fs.writeFileSync(path.join(reportsDir, `${baseName}.html`), content, 'utf-8'); } catch (e) { console.warn(`  Warning: Could not save HTML report: ${e.message}`); }
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${baseName}.html"`);
        return res.send(content);
      }
      case 'pdf': {
        const htmlContent = generateHtml(scan.results, scan.scores, brandingOptions);
        const pdfBuffer = await generatePdf(htmlContent);
        try { fs.writeFileSync(path.join(reportsDir, `${baseName}.pdf`), pdfBuffer); } catch (e) { console.warn(`  Warning: Could not save PDF report: ${e.message}`); }
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
// GET /api/scan/:id/combined-export/:format — Combined ADA+SEO report
// ---------------------------------------------------------------------------
app.get('/api/scan/:id/combined-export/:format', async (req, res) => {
  const adaScan = scans.get(req.params.id);
  if (!adaScan) return res.status(404).json({ error: 'ADA scan not found' });
  if (adaScan.status !== 'done') return res.status(400).json({ error: 'ADA scan not complete' });

  // Find matching SEO scan (same URL)
  let seoData = null;
  for (const [, seoScan] of seoScans) {
    if (seoScan.status === 'done' && seoScan.url === adaScan.url) {
      seoData = seoScan.results;
      break;
    }
  }

  const format = req.params.format;
  const hostname = new URL(adaScan.url).hostname.replace(/[^a-z0-9]/gi, '-');
  const dateStr = new Date().toISOString().slice(0, 10);
  const baseName = `${hostname}-combined-report-${dateStr}`;

  const brandingOptions = {
    clientName: adaScan.options.clientName || null,
    clientLogoBase64: adaScan.options.clientLogoBase64 || null,
    clientColor: adaScan.options.clientColor || null,
  };

  try {
    const htmlContent = generateCombinedHtmlReport(adaScan.results, adaScan.scores, seoData, brandingOptions);

    if (format === 'html') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${baseName}.html"`);
      return res.send(htmlContent);
    }
    if (format === 'pdf') {
      const pdfBuffer = await generatePdf(htmlContent);
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', `attachment; filename="${baseName}.pdf"`);
      return res.send(pdfBuffer);
    }
    if (format === 'json') {
      const combined = { ada: { scanResult: adaScan.results, scores: adaScan.scores }, seo: seoData, url: adaScan.url, date: new Date().toISOString() };
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${baseName}.json"`);
      return res.send(JSON.stringify(combined, null, 2));
    }
    return res.status(400).json({ error: `Unknown format: ${format}` });
  } catch (err) {
    return res.status(500).json({ error: `Combined export failed: ${err.message}` });
  }
});

// ---------------------------------------------------------------------------
// GET /api/scan/:id/sitemap — Generate sitemap.xml from discovered pages
// ---------------------------------------------------------------------------
app.get('/api/scan/:id/sitemap', (req, res) => {
  const scan = scans.get(req.params.id);
  if (!scan) return res.status(404).json({ error: 'Scan not found' });
  if (scan.status !== 'done') return res.status(400).json({ error: 'Scan not complete' });

  // Prefer full generated sitemap over scanned-pages-only
  if (scan.generatedSitemap) {
    const hostname = new URL(scan.url).hostname.replace(/[^a-z0-9]/gi, '-');
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${hostname}-sitemap.xml"`);
    return res.send(scan.generatedSitemap);
  }

  const pages = scan.results.pages || [];
  const today = new Date().toISOString().slice(0, 10);
  let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
  xml += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';
  for (const page of pages) {
    if (page.error) continue;
    xml += `  <url>\n    <loc>${escapeXml(page.url)}</loc>\n    <lastmod>${today}</lastmod>\n  </url>\n`;
  }
  xml += '</urlset>\n';

  const hostname = new URL(scan.url).hostname.replace(/[^a-z0-9]/gi, '-');
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${hostname}-sitemap.xml"`);
  res.send(xml);
});

// ---------------------------------------------------------------------------
// POST /api/scan/:id/generate-sitemap — Start async site crawl + sitemap generation
// ---------------------------------------------------------------------------
app.post('/api/scan/:id/generate-sitemap', (req, res) => {
  const scan = scans.get(req.params.id);
  if (!scan) return res.status(404).json({ error: 'Scan not found' });
  if (scan.status !== 'done') return res.status(400).json({ error: 'Scan not complete' });

  // Already generated — return cached info
  if (scan.generatedSitemap) {
    return res.status(200).json({ status: 'done', pageCount: scan.generatedSitemapPageCount });
  }

  // Already crawling — don't start duplicate
  if (scan.sitemapGeneration && scan.sitemapGeneration.status === 'crawling') {
    return res.status(409).json({ status: 'crawling', message: 'Sitemap generation already in progress' });
  }

  // Initialize generation state
  scan.sitemapGeneration = { status: 'crawling', pages: [], events: [], startedAt: Date.now() };
  scan.sitemapClients = scan.sitemapClients || [];

  // Fire and forget — but catch unhandled errors to prevent process crash
  runSitemapGeneration(scan).catch((err) => {
    console.error(`  [sitemap] Generation failed (uncaught): ${err.message}`);
    if (scan.sitemapGeneration) {
      scan.sitemapGeneration.status = 'error';
      scan.sitemapGeneration.error = err.message;
    }
    broadcastSitemapSSE(scan, { type: 'error', message: err.message });
    closeSitemapSSEClients(scan);
  });

  res.status(202).json({ status: 'started' });
});

// ---------------------------------------------------------------------------
// GET /api/scan/:id/sitemap-progress — SSE stream for sitemap generation
// ---------------------------------------------------------------------------
app.get('/api/scan/:id/sitemap-progress', (req, res) => {
  const scan = scans.get(req.params.id);
  if (!scan) return res.status(404).json({ error: 'Scan not found' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const gen = scan.sitemapGeneration;

  // Replay buffered events (catch-up)
  if (gen && gen.events) {
    for (const evt of gen.events) {
      res.write(`data: ${JSON.stringify(evt)}\n\n`);
    }
  }

  // If already complete or errored, send final event and close
  if (gen && gen.status === 'done') {
    res.write(`data: ${JSON.stringify({ type: 'complete', pageCount: scan.generatedSitemapPageCount })}\n\n`);
    return res.end();
  }
  if (gen && gen.status === 'error') {
    res.write(`data: ${JSON.stringify({ type: 'error', message: gen.error || 'Unknown error' })}\n\n`);
    return res.end();
  }

  // Register for live updates
  scan.sitemapClients = scan.sitemapClients || [];
  scan.sitemapClients.push(res);

  // Heartbeat every 25s to prevent proxy/browser idle timeouts
  const heartbeat = setInterval(() => {
    try { res.write(':\n\n'); } catch { clearInterval(heartbeat); scan.sitemapClients = (scan.sitemapClients || []).filter((c) => c !== res); }
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    scan.sitemapClients = scan.sitemapClients.filter((c) => c !== res);
  });
});

// ---------------------------------------------------------------------------
// GET /api/scan/:id/sitemap-download — Download generated sitemap XML
// ---------------------------------------------------------------------------
app.get('/api/scan/:id/sitemap-download', (req, res) => {
  const scan = scans.get(req.params.id);
  if (!scan) return res.status(404).json({ error: 'Scan not found' });
  if (!scan.generatedSitemap) return res.status(404).json({ error: 'Sitemap not yet generated' });

  const hostname = new URL(scan.url).hostname.replace(/[^a-z0-9]/gi, '-');
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${hostname}-full-sitemap.xml"`);
  res.send(scan.generatedSitemap);
});

/**
 * Broadcast SSE event to sitemap generation clients.
 * Buffers events for late-joining clients.
 */
function broadcastSitemapSSE(scan, data) {
  if (!scan.sitemapGeneration) return;
  scan.sitemapGeneration.events.push(data);
  // Cap buffer to prevent memory leak
  if (scan.sitemapGeneration.events.length > MAX_PROGRESS_EVENTS) {
    scan.sitemapGeneration.events.shift();
  }
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  const deadClients = [];
  for (const client of (scan.sitemapClients || [])) {
    try {
      client.write(payload);
    } catch (err) {
      console.warn(`  [sitemap-sse] Write failed, removing dead client: ${err.message}`);
      deadClients.push(client);
    }
  }
  if (deadClients.length > 0) {
    scan.sitemapClients = (scan.sitemapClients || []).filter((c) => !deadClients.includes(c));
  }
}

function closeSitemapSSEClients(scan) {
  for (const client of (scan.sitemapClients || [])) {
    try { client.end(); } catch {}
  }
  scan.sitemapClients = [];
  // Free sitemap generation event buffer to reclaim memory
  if (scan.sitemapGeneration) {
    scan.sitemapGeneration.events = [];
  }
}

/**
 * Run sitemap generation asynchronously with SSE progress streaming.
 * Uses HTTP crawl first, falls back to browser crawl for SPAs.
 */
async function runSitemapGeneration(scan) {
  try {
    broadcastSitemapSSE(scan, { type: 'phase', message: 'Fetching robots.txt...' });

    let disallowed = [];
    try {
      disallowed = await parseRobotsTxt(scan.url);
      broadcastSitemapSSE(scan, { type: 'phase', message: `Found ${disallowed.length} disallowed path(s) in robots.txt` });
    } catch {
      broadcastSitemapSSE(scan, { type: 'phase', message: 'No robots.txt found — crawling without restrictions' });
    }

    broadcastSitemapSSE(scan, { type: 'phase', message: 'Starting HTTP crawl...' });

    // Step 1: Fast HTTP-based crawl with progress callback
    const MAX_SITEMAP_PAGES = 200;
    const MAX_BROWSER_DEPTH = 2;
    let crawledUrls = await crawlLinks(scan.url, MAX_SITEMAP_PAGES, disallowed, (info) => {
      broadcastSitemapSSE(scan, { type: 'page', url: info.url, depth: info.depth, total: info.total, source: 'http' });
    });

    // Step 2: If HTTP found very few pages, likely a SPA — try browser crawl
    if (crawledUrls.length <= 3) {
      broadcastSitemapSSE(scan, { type: 'phase', message: `HTTP crawl found only ${crawledUrls.length} page(s) — site may be a JavaScript SPA. Switching to browser-based crawl...` });

      try {
        const browserUrls = await crawlLinksWithBrowser(scan.url, MAX_SITEMAP_PAGES, disallowed, MAX_BROWSER_DEPTH, (info) => {
          broadcastSitemapSSE(scan, { type: 'page', url: info.url, depth: info.depth, total: info.total, source: 'browser' });
        });

        if (browserUrls.length > crawledUrls.length) {
          console.log(`  [sitemap] Browser crawl found ${browserUrls.length} pages (vs ${crawledUrls.length} from HTTP)`);
          crawledUrls = browserUrls;
        }
      } catch (err) {
        broadcastSitemapSSE(scan, { type: 'phase', message: `Browser crawl failed: ${err.message}. Using HTTP results.` });
        console.warn(`  [sitemap] Browser crawl failed: ${err.message}`);
      }
    }

    // Build sitemap XML
    broadcastSitemapSSE(scan, { type: 'phase', message: `Building sitemap with ${crawledUrls.length} pages...` });

    const today = new Date().toISOString().slice(0, 10);
    let xml = '<?xml version="1.0" encoding="UTF-8"?>\n';
    xml += '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n';
    for (const crawledUrl of crawledUrls) {
      const isHome = crawledUrl === scan.url;
      xml += `  <url>\n    <loc>${escapeXml(crawledUrl)}</loc>\n    <lastmod>${today}</lastmod>\n    <changefreq>${isHome ? 'daily' : 'weekly'}</changefreq>\n    <priority>${isHome ? '1.0' : '0.5'}</priority>\n  </url>\n`;
    }
    xml += '</urlset>\n';

    scan.generatedSitemap = xml;
    scan.generatedSitemapPageCount = crawledUrls.length;
    scan.sitemapGeneration.status = 'done';

    broadcastSitemapSSE(scan, { type: 'complete', pageCount: crawledUrls.length });
    closeSitemapSSEClients(scan);

  } catch (err) {
    console.error(`  [sitemap] Generation failed: ${err.message}`);
    if (scan.sitemapGeneration) {
      scan.sitemapGeneration.status = 'error';
      scan.sitemapGeneration.error = err.message;
    }
    broadcastSitemapSSE(scan, { type: 'error', message: err.message });
    closeSitemapSSEClients(scan);
  }
}

function escapeXml(str) {
  return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

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
  let sitemapFound = false;
  let sitemapCount = 0;
  try {
    const discoverPromise = discoverPages(url, null, options.maxPages, { enabled: options.crawl }, (data) => {
      broadcastSSE(scanRecord, data);
      if (data.phase === 'sitemap-status') {
        sitemapFound = data.found;
        sitemapCount = data.count;
      }
    });
    const discoverTimeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Page discovery timed out after 60s')), 60000));
    pages = await Promise.race([discoverPromise, discoverTimeout]);
  } catch (err) {
    console.warn(`  [discover] ${err.message || 'Discovery failed'} — falling back to URL only`);
    pages = [url];
  }
  scanRecord.sitemapStatus = { found: sitemapFound, count: sitemapCount };
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
  scanRecord.completedAt = Date.now();

  broadcastSSE(scanRecord, { phase: 'done' });
  closeSSEClients(scanRecord);
}

const MAX_PROGRESS_EVENTS = 500;

function broadcastSSE(scanRecord, data) {
  scanRecord.progress.push(data);
  // Cap progress array to prevent memory leak on long scans
  if (scanRecord.progress.length > MAX_PROGRESS_EVENTS) {
    scanRecord.progress.shift();
  }
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  const deadClients = [];
  for (const client of scanRecord.sseClients) {
    try {
      client.write(payload);
    } catch (err) {
      console.warn(`  [sse] Write failed, removing dead client: ${err.message}`);
      deadClients.push(client);
    }
  }
  if (deadClients.length > 0) {
    scanRecord.sseClients = scanRecord.sseClients.filter((c) => !deadClients.includes(c));
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
// SEO Scan Store
// ---------------------------------------------------------------------------
const seoScans = new Map();

// Cleanup SEO scans with same TTL + stale timeout
setInterval(() => {
  const now = Date.now();
  for (const [id, scan] of seoScans) {
    if (scan.status === 'running') {
      if (now - scan.startedAt > SCAN_STALE_TIMEOUT_MS) {
        scan.status = 'error';
        scan.error = 'SEO scan timed out after 60 minutes — likely crashed';
        scan.completedAt = now;
        broadcastSeoSSE(scan, { phase: 'error', message: scan.error });
        closeSeoSSEClients(scan);
      }
      continue;
    }
    const finishedAt = scan.completedAt || scan.startedAt;
    if (now - finishedAt > SCAN_TTL_MS) {
      seoScans.delete(id);
    }
  }
}, 60 * 1000);

// ---------------------------------------------------------------------------
// POST /api/seo-scan — Start a new SEO + Speed scan
// ---------------------------------------------------------------------------
app.post('/api/seo-scan', (req, res) => {
  const { url, timeout = 45000 } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'url is required' });
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
    error: null,
    startedAt: Date.now(),
    options: { timeout },
    sseClients: [],
  };

  seoScans.set(scanId, scanRecord);

  runSeoScanJob(scanRecord).catch((err) => {
    scanRecord.status = 'error';
    scanRecord.error = err.message;
    scanRecord.completedAt = Date.now();
    broadcastSeoSSE(scanRecord, { phase: 'error', message: err.message });
    closeSeoSSEClients(scanRecord);
  });

  return res.json({ scanId });
});

// ---------------------------------------------------------------------------
// GET /api/seo-scan/:id/progress — SSE stream for SEO scan
// ---------------------------------------------------------------------------
app.get('/api/seo-scan/:id/progress', (req, res) => {
  const scan = seoScans.get(req.params.id);
  if (!scan) return res.status(404).json({ error: 'SEO scan not found' });

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  for (const evt of scan.progress) {
    res.write(`data: ${JSON.stringify(evt)}\n\n`);
  }

  if (scan.status === 'done') {
    res.write(`data: ${JSON.stringify({ phase: 'seo-done' })}\n\n`);
    return res.end();
  }
  if (scan.status === 'error') {
    res.write(`data: ${JSON.stringify({ phase: 'error', message: scan.error })}\n\n`);
    return res.end();
  }

  scan.sseClients.push(res);

  // Heartbeat every 25s to prevent proxy/browser idle timeouts
  const heartbeat = setInterval(() => {
    try { res.write(':\n\n'); } catch { clearInterval(heartbeat); scan.sseClients = scan.sseClients.filter((c) => c !== res); }
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    scan.sseClients = scan.sseClients.filter((c) => c !== res);
  });
});

// ---------------------------------------------------------------------------
// GET /api/seo-scan/:id/results — Full SEO results JSON
// ---------------------------------------------------------------------------
app.get('/api/seo-scan/:id/results', (req, res) => {
  const scan = seoScans.get(req.params.id);
  if (!scan) return res.status(404).json({ error: 'SEO scan not found' });
  if (scan.status === 'running') return res.status(202).json({ status: 'running' });
  if (scan.status === 'error') return res.status(500).json({ error: scan.error });

  res.json({ seoResult: scan.results });
});

// ---------------------------------------------------------------------------
// GET /api/seo-scan/:id/export/:format — Download SEO report
// ---------------------------------------------------------------------------
app.get('/api/seo-scan/:id/export/:format', async (req, res) => {
  const scan = seoScans.get(req.params.id);
  if (!scan) return res.status(404).json({ error: 'SEO scan not found' });
  if (scan.status !== 'done') return res.status(400).json({ error: 'SEO scan not complete' });

  const format = req.params.format;
  const hostname = new URL(scan.url).hostname.replace(/[^a-z0-9]/gi, '-');
  const dateStr = new Date().toISOString().slice(0, 10);
  const baseName = `${hostname}-seo-report-${dateStr}`;

  try {
    switch (format) {
      case 'json': {
        const content = JSON.stringify(scan.results, null, 2);
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${baseName}.json"`);
        return res.send(content);
      }
      case 'html': {
        const content = generateSeoHtmlReport(scan.results);
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="${baseName}.html"`);
        return res.send(content);
      }
      case 'pdf': {
        const htmlContent = generateSeoHtmlReport(scan.results);
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
// SEO Scan Execution
// ---------------------------------------------------------------------------
async function runSeoScanJob(scanRecord) {
  const { url, options } = scanRecord;

  const result = await runFullSeoScan(url, {
    timeout: options.timeout,
    onProgress: (data) => broadcastSeoSSE(scanRecord, data),
  });

  scanRecord.results = result;
  scanRecord.status = 'done';
  scanRecord.completedAt = Date.now();

  broadcastSeoSSE(scanRecord, { phase: 'seo-done' });
  closeSeoSSEClients(scanRecord);
}

function broadcastSeoSSE(scanRecord, data) {
  scanRecord.progress.push(data);
  if (scanRecord.progress.length > MAX_PROGRESS_EVENTS) {
    scanRecord.progress.shift();
  }
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  const deadClients = [];
  for (const client of scanRecord.sseClients) {
    try {
      client.write(payload);
    } catch (err) {
      console.warn(`  [seo-sse] Write failed, removing dead client: ${err.message}`);
      deadClients.push(client);
    }
  }
  if (deadClients.length > 0) {
    scanRecord.sseClients = scanRecord.sseClients.filter((c) => !deadClients.includes(c));
  }
}

function closeSeoSSEClients(scanRecord) {
  for (const client of scanRecord.sseClients) {
    client.end();
  }
  scanRecord.sseClients = [];
  scanRecord.progress = [];
}

// ---------------------------------------------------------------------------
// Combined ADA+SEO HTML Report Generator
// ---------------------------------------------------------------------------
function generateCombinedHtmlReport(adaResults, adaScores, seoData, branding) {
  const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const url = adaResults?.url || '';
  let hostname = '';
  try { hostname = new URL(url).hostname; } catch {}
  const date = new Date().toLocaleString();
  const dateShort = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
  const scoreColor = (s) => typeof s === 'number' ? (s >= 90 ? '#16a34a' : s >= 50 ? '#d97706' : '#dc2626') : '#78716c';
  const scoreLabel = (s) => typeof s === 'number' ? (s >= 90 ? 'Excellent' : s >= 70 ? 'Good' : s >= 50 ? 'Needs Improvement' : 'Poor') : 'N/A';
  const sevColor = (sev) => ({ critical: '#dc2626', serious: '#ea580c', moderate: '#d97706', minor: '#2563eb' }[sev] || '#6b7280');
  const sevW = { critical: 4, serious: 3, moderate: 2, minor: 1 };

  const adaScore = adaScores?.overall ?? '--';
  const violations = adaResults?.allViolations || [];
  const totalNodes = violations.reduce((n, v) => n + (v.nodes?.length || 0), 0);
  const passes = adaScores?.totalPasses || 0;
  const seo = seoData?.seo || {};
  const seoScore = seo?.seoScore?.score ?? '--';
  const seoIssues = seo?.seoScore?.issues || [];
  const lhDesktop = seoData?.lighthouse?.desktop || {};
  const lhMobile = seoData?.lighthouse?.mobile || {};
  const suggestions = seoData?.speedSuggestions || [];
  const pageCount = adaResults?.pageCount || 1;

  const clientName = branding?.clientName || '';
  const logoB64 = branding?.clientLogoBase64 || DEFAULT_LOGO_BASE64;
  const isDefaultLogo = !branding?.clientLogoBase64;
  const accentColor = branding?.clientColor || '#6c5ce7';

  const OVERLAPPING = [
    { ada: 'image-alt', seo: 'missing-alt', label: 'Missing Image Alt Text', wcag: '1.1.1', desc: 'Images without alt text are invisible to screen readers and search engines.' },
    { ada: 'heading-order', seo: 'heading-structure', label: 'Heading Structure Issues', wcag: '1.3.1', desc: 'Incorrect heading hierarchy confuses assistive technology and hurts SEO structure.' },
    { ada: 'html-has-lang', seo: 'missing-lang', label: 'Missing Language Attribute', wcag: '3.1.1', desc: 'Without a lang attribute, assistive technology cannot determine the page language.' },
    { ada: 'document-title', seo: 'missing-title', label: 'Missing Page Title', wcag: '2.4.2', desc: 'Missing or inadequate page title affects screen reader users and search listings.' },
  ];
  const adaRuleIds = violations.map(v => v.id);
  const overlaps = OVERLAPPING.filter(r => adaRuleIds.includes(r.ada));

  // Severity breakdown
  const sevBreakdown = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  for (const v of violations) sevBreakdown[v.impact] = (sevBreakdown[v.impact] || 0) + 1;

  // Confirmed vs needs-review
  const confirmed = violations.filter(v => v._confidence === 'high' || v._confidence === 'medium');
  const needsReview = violations.filter(v => v._confidence === 'low');

  // Risk assessment
  const riskLevel = sevBreakdown.critical > 0 ? 'HIGH' : sevBreakdown.serious > 2 ? 'HIGH' : sevBreakdown.serious > 0 || sevBreakdown.moderate > 5 ? 'MODERATE' : 'LOW';
  const riskColor = riskLevel === 'HIGH' ? '#dc2626' : riskLevel === 'MODERATE' ? '#d97706' : '#16a34a';

  // Performance metrics
  const perfD = lhDesktop.categories?.performance?.score;
  const perfDNum = typeof perfD === 'number' ? Math.round(perfD * 100) : null;
  const perfM = lhMobile.categories?.performance?.score;
  const perfMNum = typeof perfM === 'number' ? Math.round(perfM * 100) : null;

  // Priority actions (top 5 from both audits)
  const allIssues = [
    ...violations.map(v => ({ label: v.help, severity: v.impact, source: 'ADA', nodes: v.nodes?.length || 0, rule: v.id })),
    ...seoIssues.map(i => ({ label: i.msg || i.message || '', severity: i.severity || 'moderate', source: 'SEO', nodes: 0, rule: '' })),
  ].sort((a, b) => (sevW[b.severity] || 0) - (sevW[a.severity] || 0)).slice(0, 5);

  // Logo HTML
  let logoHtml = '';
  if (logoB64) {
    logoHtml = isDefaultLogo
      ? `<div style="display:inline-block;background:#1c1917;padding:12px 20px;border-radius:8px"><img src="data:image/png;base64,${logoB64}" alt="IT Geeks" style="max-height:48px;display:block"></div>`
      : `<img src="data:image/png;base64,${logoB64}" alt="${esc(clientName)} logo" style="max-height:48px">`;
  }

  // Build sorted violations for detail section
  const sortedViolations = [...violations].sort((a, b) => (sevW[b.impact] || 0) - (sevW[a.impact] || 0));

  // Quick wins: moderate/minor violations with remediation that are easy to fix
  const quickWins = sortedViolations.filter(v => {
    const rem = remediationData[v.id];
    return rem && (v.impact === 'moderate' || v.impact === 'minor' || v.impact === 'serious');
  }).slice(0, 3);

  // Severity emoji for non-tech readers
  const sevEmoji = (sev) => ({ critical: '\u{1F6D1}', serious: '\u{26A0}\u{FE0F}', moderate: '\u{1F7E1}', minor: '\u{1F535}' }[sev] || '\u{2139}\u{FE0F}');
  // Plain-language severity
  const sevPlain = (sev) => ({
    critical: 'Blocks users completely',
    serious: 'Major barrier for some users',
    moderate: 'Creates difficulty for some users',
    minor: 'Minor inconvenience',
  }[sev] || '');
  // Who should fix
  const whoFixes = (ruleId) => {
    if (['color-contrast', 'color-contrast-enhanced'].includes(ruleId)) return 'Designer';
    if (['image-alt', 'document-title', 'html-has-lang', 'label', 'input-image-alt', 'frame-title'].includes(ruleId)) return 'Content';
    return 'Developer';
  };

  // Section numbering helper
  let sectionNum = 0;
  const nextSection = () => ++sectionNum;

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Combined ADA + SEO Compliance Report — ${esc(hostname)}</title>
<style>
*{box-sizing:border-box}
body{font-family:'Segoe UI',system-ui,-apple-system,sans-serif;max-width:960px;margin:0 auto;padding:0;color:#1c1917;line-height:1.6;font-size:14px}

/* Cover Page */
.cover{min-height:100vh;display:flex;flex-direction:column;justify-content:center;align-items:center;text-align:center;padding:60px 40px;page-break-after:always}
.cover-logo{margin-bottom:40px}
.cover h1{font-size:32px;font-weight:800;margin:0 0 8px;color:#1c1917;letter-spacing:-0.5px}
.cover-subtitle{font-size:18px;color:#78716c;margin:0 0 32px;font-weight:400}
.cover-bar{width:80px;height:4px;background:${accentColor};border-radius:2px;margin:0 auto 32px}
.cover-meta{font-size:14px;color:#78716c;line-height:1.8}
.cover-meta strong{color:#1c1917}
.cover-confidential{margin-top:auto;padding-top:60px;font-size:11px;color:#a8a29e;text-transform:uppercase;letter-spacing:2px}

/* Table of Contents */
.toc{page-break-after:always;padding:40px}
.toc h2{font-size:22px;margin-bottom:24px;border-bottom:3px solid ${accentColor};padding-bottom:8px}
.toc-item{display:flex;justify-content:space-between;align-items:baseline;padding:10px 0;border-bottom:1px dotted #d6d3d1;font-size:14px}
.toc-item a{color:#1c1917;text-decoration:none;font-weight:600}
.toc-item a:hover{color:${accentColor}}
.toc-num{color:#78716c;font-size:13px}

/* Content */
.content{padding:40px}
h2{font-size:20px;margin-top:48px;padding-bottom:10px;border-bottom:2px solid #e7e5e4;color:#1c1917}
h3{font-size:16px;margin-top:24px;color:#44403c}
.section-num{font-size:14px;color:${accentColor};font-weight:700;margin-right:8px}

/* Score Cards */
.scores{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin:24px 0}
.score-card{text-align:center;padding:24px 16px;border-radius:12px;background:#fafaf9;border:1px solid #e5e5e5}
.score-card.highlight{border-width:2px}
.score-num{font-size:40px;font-weight:800;line-height:1}
.score-lbl{font-size:12px;color:#78716c;margin-top:6px;text-transform:uppercase;letter-spacing:.5px}
.score-sub{font-size:11px;margin-top:4px;font-weight:600}
.score-bar{height:6px;border-radius:3px;background:#e5e5e5;margin-top:10px;overflow:hidden}
.score-bar-fill{height:100%;border-radius:3px;transition:width .3s}

/* Risk Badge */
.risk-badge{display:inline-block;padding:6px 16px;border-radius:99px;font-size:13px;font-weight:700;letter-spacing:.5px;margin:8px 0}

/* Callout boxes */
.callout{padding:16px 20px;border-radius:8px;margin:16px 0;font-size:13px;page-break-inside:avoid}
.callout-info{background:#eff6ff;border-left:3px solid #3b82f6}
.callout-warn{background:#fffbeb;border-left:3px solid #d97706}
.callout-success{background:#f0fdf4;border-left:3px solid #16a34a}
.callout-title{font-weight:700;margin-bottom:6px;font-size:14px}
.callout ul{margin:6px 0 0;padding-left:20px}
.callout li{margin:4px 0}

/* Tables */
table{width:100%;border-collapse:collapse;margin:16px 0;font-size:13px}
thead{background:#fafaf9}
th{text-align:left;padding:10px 12px;font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#78716c;border-bottom:2px solid #e5e5e5;font-weight:600}
td{padding:10px 12px;border-bottom:1px solid #f0f0f0;vertical-align:top}
tr:hover td{background:#fafaf9}

/* Badges */
.badge{display:inline-block;padding:2px 8px;border-radius:99px;font-size:11px;font-weight:600}
.badge-critical{background:#fef2f2;color:#dc2626}
.badge-serious{background:#fff7ed;color:#ea580c}
.badge-moderate{background:#fffbeb;color:#d97706}
.badge-minor{background:#eef2ff;color:#2563eb}
.badge-conf{font-size:10px;padding:1px 6px;border-radius:99px}
.badge-ada{background:#6c5ce722;color:#6c5ce7}
.badge-seo{background:#2ed57322;color:#16a34a}
.badge-both{background:#3742fa22;color:#3742fa}
.badge-who{background:#f5f5f4;color:#44403c;font-size:10px;padding:2px 8px}

/* Violation Card */
.v-card{border:1px solid #e5e5e5;border-radius:10px;padding:20px;margin-bottom:16px;page-break-inside:avoid}
.v-card-header{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px}
.v-card h4{font-size:15px;margin:0;flex:1}
.v-card-meta{font-size:12px;color:#78716c;margin-bottom:8px}
.v-card-plain{font-size:13px;color:#44403c;margin:8px 0;padding:10px 14px;background:#fafaf9;border-radius:6px}
.v-card-plain strong{color:#1c1917}
.v-card-wcag{font-size:12px;padding:8px 12px;background:#f5f3ff;border-radius:6px;margin:8px 0;border-left:3px solid ${accentColor}}
.v-card-nodes{font-size:12px;color:#78716c;margin-top:8px}
.v-card-fix{margin-top:12px;padding:12px;background:#f0fdf4;border-radius:6px;border-left:3px solid #16a34a;font-size:13px}
.v-card-fix h5{margin:0 0 4px;font-size:13px;color:#16a34a}
.v-code{background:#f5f5f4;padding:12px;border-radius:6px;font-size:12px;overflow-x:auto;white-space:pre-wrap;font-family:'Fira Code',monospace;margin:8px 0;border:1px solid #e5e5e5}
.v-code.before{border-left:3px solid #dc2626;background:#fef2f2}
.v-code.after{border-left:3px solid #16a34a;background:#f0fdf4}

/* Suggestion card */
.sug-card{border:1px solid #e5e5e5;border-radius:8px;padding:16px;margin-bottom:12px;page-break-inside:avoid}
.sug-card h4{font-size:14px;margin:4px 0 8px}
.sug-card p{font-size:13px;color:#555;margin:0}
.sug-savings{font-size:12px;color:#16a34a;margin-left:auto}

/* Priority list */
.priority-list{list-style:none;padding:0;margin:16px 0}
.priority-list li{padding:10px 12px;border-bottom:1px solid #f0f0f0;display:flex;align-items:center;gap:10px;font-size:13px}
.priority-list li:last-child{border:0}
.priority-num{width:24px;height:24px;background:#f5f5f4;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:#78716c;flex-shrink:0}

/* Overlap Card */
.overlap-card{border:2px solid #6366f1;border-radius:10px;padding:16px;margin-bottom:12px;background:#f5f3ff08;page-break-inside:avoid}
.overlap-card h4{font-size:14px;margin:0 0 4px}
.overlap-card p{font-size:12px;color:#78716c;margin:4px 0 8px}

/* Quick win */
.qw-card{border:1px solid #16a34a44;border-radius:10px;padding:16px;margin-bottom:12px;background:#f0fdf4;page-break-inside:avoid}
.qw-card h4{font-size:14px;margin:0 0 6px;color:#15803d}

/* Footer */
.report-footer{margin-top:60px;padding-top:20px;border-top:2px solid #e5e5e5;color:#78716c;font-size:12px}

/* Print */
@media print{
  .cover{min-height:auto;padding:40px 0}
  body{padding:20px;font-size:12px}
  .score-card,.v-card,.overlap-card,.sug-card,.qw-card,.callout{break-inside:avoid}
  h2{break-after:avoid}
  .no-print{display:none}
}
</style></head><body>

<!-- Cover Page -->
<div class="cover">
  <div class="cover-logo">${logoHtml}</div>
  <h1>WEBSITE HEALTH REPORT</h1>
  <p class="cover-subtitle">Accessibility (ADA) + Search Engine (SEO) Audit</p>
  <div class="cover-bar"></div>
  <div class="cover-meta">
    ${clientName ? `<p>Prepared for: <strong>${esc(clientName)}</strong></p>` : ''}
    <p>Website: <strong>${esc(url)}</strong></p>
    <p>Date: <strong>${dateShort}</strong></p>
    <p>Pages Analyzed: <strong>${pageCount}</strong></p>
  </div>
  <div class="cover-confidential">CONFIDENTIAL</div>
</div>

<!-- Table of Contents -->
<div class="toc">
  <h2>Contents</h2>
  <div class="toc-item"><a href="#at-a-glance">At a Glance</a><span class="toc-num">1</span></div>
  <div class="toc-item"><a href="#score-dashboard">Scores &amp; Metrics</a><span class="toc-num">2</span></div>
  <div class="toc-item"><a href="#top-priorities">Top Priorities</a><span class="toc-num">3</span></div>
  ${quickWins.length > 0 ? '<div class="toc-item"><a href="#quick-wins">Quick Wins</a><span class="toc-num">4</span></div>' : ''}
  ${overlaps.length > 0 ? `<div class="toc-item"><a href="#overlapping-issues">Issues Affecting Both ADA &amp; SEO</a><span class="toc-num">${quickWins.length > 0 ? '5' : '4'}</span></div>` : ''}
  <div class="toc-item"><a href="#ada-violations">Accessibility Issues (Detail)</a></div>
  <div class="toc-item"><a href="#seo-issues">SEO Issues (Detail)</a></div>
  ${suggestions.length > 0 ? '<div class="toc-item"><a href="#speed-suggestions">Speed Improvements</a></div>' : ''}
  <div class="toc-item"><a href="#methodology">How This Scan Was Done</a></div>
</div>

<div class="content">

<!-- 1. At a Glance -->
<h2 id="at-a-glance"><span class="section-num">${nextSection()}</span>At a Glance</h2>

<div style="display:flex;align-items:center;gap:12px;margin:12px 0">
  <span class="risk-badge" style="background:${riskColor}15;color:${riskColor};border:1px solid ${riskColor}44">${riskLevel} RISK</span>
</div>

<div class="callout callout-info">
  <div class="callout-title">What we found on ${esc(hostname)}</div>
  <ul>
    <li><strong>${violations.length} accessibility issue${violations.length !== 1 ? 's' : ''}</strong> affecting ${totalNodes} element${totalNodes !== 1 ? 's' : ''} across ${pageCount} page${pageCount !== 1 ? 's' : ''}</li>
    <li><strong>${seoIssues.length} SEO issue${seoIssues.length !== 1 ? 's' : ''}</strong> that may affect search engine ranking</li>
    ${sevBreakdown.critical > 0 ? `<li style="color:#dc2626"><strong>${sevBreakdown.critical} critical issue${sevBreakdown.critical !== 1 ? 's' : ''}</strong> — these block some users from using the site at all</li>` : ''}
    ${sevBreakdown.serious > 0 ? `<li style="color:#ea580c"><strong>${sevBreakdown.serious} serious issue${sevBreakdown.serious !== 1 ? 's' : ''}</strong> — major barriers for users with disabilities</li>` : ''}
    ${overlaps.length > 0 ? `<li><strong>${overlaps.length} issue${overlaps.length !== 1 ? 's' : ''}</strong> affect both accessibility AND SEO — fixing these gives double benefit</li>` : ''}
    ${violations.length === 0 && seoIssues.length === 0 ? '<li style="color:#16a34a">No issues found — excellent work!</li>' : ''}
  </ul>
</div>

<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:20px 0">
  <div style="padding:14px;background:#fafaf9;border-radius:8px;border-left:3px solid ${accentColor}">
    <div style="font-size:11px;color:#78716c;text-transform:uppercase;letter-spacing:.5px">Confirmed Issues</div>
    <div style="font-size:28px;font-weight:700;color:#1c1917">${confirmed.length}</div>
    <div style="font-size:12px;color:#78716c">${confirmed.reduce((n, v) => n + (v.nodes?.length || 0), 0)} elements</div>
  </div>
  <div style="padding:14px;background:#fafaf9;border-radius:8px;border-left:3px solid #d97706">
    <div style="font-size:11px;color:#78716c;text-transform:uppercase;letter-spacing:.5px">Needs Manual Review</div>
    <div style="font-size:28px;font-weight:700;color:#d97706">${needsReview.length}</div>
    <div style="font-size:12px;color:#78716c">${needsReview.reduce((n, v) => n + (v.nodes?.length || 0), 0)} elements</div>
  </div>
</div>

<!-- 2. Score Dashboard -->
<h2 id="score-dashboard"><span class="section-num">${nextSection()}</span>Scores &amp; Metrics</h2>

<div class="scores">
  <div class="score-card highlight" style="border-color:${scoreColor(adaScore)}">
    <div class="score-num" style="color:${scoreColor(adaScore)}">${adaScore}</div>
    <div class="score-lbl">Accessibility</div>
    <div class="score-sub" style="color:${scoreColor(adaScore)}">${scoreLabel(adaScore)}</div>
    <div class="score-bar"><div class="score-bar-fill" style="width:${typeof adaScore === 'number' ? adaScore : 0}%;background:${scoreColor(adaScore)}"></div></div>
  </div>
  <div class="score-card highlight" style="border-color:${scoreColor(typeof seoScore === 'number' ? seoScore : null)}">
    <div class="score-num" style="color:${scoreColor(typeof seoScore === 'number' ? seoScore : null)}">${typeof seoScore === 'number' ? seoScore : '--'}</div>
    <div class="score-lbl">SEO Health</div>
    <div class="score-sub" style="color:${scoreColor(typeof seoScore === 'number' ? seoScore : null)}">${scoreLabel(typeof seoScore === 'number' ? seoScore : null)}</div>
    <div class="score-bar"><div class="score-bar-fill" style="width:${typeof seoScore === 'number' ? seoScore : 0}%;background:${scoreColor(typeof seoScore === 'number' ? seoScore : null)}"></div></div>
  </div>
  <div class="score-card">
    <div class="score-num">${violations.length + seoIssues.length}</div>
    <div class="score-lbl">Total Issues</div>
    <div class="score-sub" style="color:#3742fa">${overlaps.length} overlap both</div>
  </div>
</div>

<div class="scores" style="grid-template-columns:repeat(4,1fr)">
  <div class="score-card"><div class="score-num" style="color:${scoreColor(perfDNum)};font-size:28px">${perfDNum ?? '--'}</div><div class="score-lbl">Desktop Speed</div></div>
  <div class="score-card"><div class="score-num" style="color:${scoreColor(perfMNum)};font-size:28px">${perfMNum ?? '--'}</div><div class="score-lbl">Mobile Speed</div></div>
  <div class="score-card"><div class="score-num" style="font-size:28px;color:#16a34a">${passes}</div><div class="score-lbl">Checks Passed</div></div>
  <div class="score-card"><div class="score-num" style="font-size:28px">${totalNodes}</div><div class="score-lbl">Elements to Fix</div></div>
</div>

<h3>Issue Severity Breakdown</h3>
<table>
<thead><tr><th style="width:30%">Severity</th><th>What it means</th><th style="width:15%">Count</th></tr></thead>
<tbody>
${sevBreakdown.critical > 0 ? `<tr><td>\u{1F6D1} <span class="badge badge-critical">Critical</span></td><td>Blocks users completely — must fix first</td><td><strong>${sevBreakdown.critical}</strong></td></tr>` : ''}
${sevBreakdown.serious > 0 ? `<tr><td>\u{26A0}\u{FE0F} <span class="badge badge-serious">Serious</span></td><td>Major barrier for users with disabilities</td><td><strong>${sevBreakdown.serious}</strong></td></tr>` : ''}
${sevBreakdown.moderate > 0 ? `<tr><td>\u{1F7E1} <span class="badge badge-moderate">Moderate</span></td><td>Creates difficulty, should fix soon</td><td><strong>${sevBreakdown.moderate}</strong></td></tr>` : ''}
${sevBreakdown.minor > 0 ? `<tr><td>\u{1F535} <span class="badge badge-minor">Minor</span></td><td>Small inconvenience, fix when possible</td><td><strong>${sevBreakdown.minor}</strong></td></tr>` : ''}
${violations.length === 0 ? '<tr><td colspan="3" style="color:#16a34a;font-weight:600;text-align:center">No violations found</td></tr>' : ''}
</tbody>
</table>

<!-- 3. Top Priorities -->
<h2 id="top-priorities"><span class="section-num">${nextSection()}</span>Top Priorities — Fix These First</h2>

<ol class="priority-list">
${allIssues.map((item, i) => `<li>
  <span class="priority-num">${i + 1}</span>
  ${sevEmoji(item.severity)} <span class="badge badge-${item.severity}">${esc(item.severity)}</span>
  <span class="badge badge-${item.source === 'ADA' ? 'ada' : 'seo'}">${item.source}</span>
  <span class="badge-who">${whoFixes(item.rule)}</span>
  <span style="flex:1">${esc(item.label)}</span>
  ${item.nodes > 0 ? `<span style="color:#78716c;font-size:12px;white-space:nowrap">${item.nodes} elements</span>` : ''}
</li>`).join('\n')}
</ol>

${quickWins.length > 0 ? `
<!-- 4. Quick Wins -->
<h2 id="quick-wins"><span class="section-num">${nextSection()}</span>Quick Wins — Easy Fixes, Big Impact</h2>
<p style="color:#78716c;font-size:13px;margin-bottom:16px">These can often be fixed in under an hour and will noticeably improve your score.</p>
${quickWins.map(v => {
  const rem = remediationData[v.id] || {};
  return `<div class="qw-card">
  <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
    <span class="badge badge-${v.impact}">${esc(v.impact)}</span>
    <span class="badge-who">${whoFixes(v.id)}</span>
    <span style="font-size:12px;color:#78716c">${v.nodes?.length || 0} element${(v.nodes?.length || 0) !== 1 ? 's' : ''}</span>
  </div>
  <h4>${esc(v.help)}</h4>
  <ul style="font-size:13px;margin:6px 0;padding-left:20px;color:#44403c">
    <li><strong>Problem:</strong> ${esc(v.description || v.help)}</li>
    <li><strong>Fix:</strong> ${esc(rem.summary || rem.description || 'See detailed guidance below')}</li>
  </ul>
  ${rem.before && rem.after ? `<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px">
    <div><div style="font-size:11px;color:#dc2626;font-weight:600;margin-bottom:4px">Before (broken)</div><pre class="v-code before">${esc(rem.before)}</pre></div>
    <div><div style="font-size:11px;color:#16a34a;font-weight:600;margin-bottom:4px">After (fixed)</div><pre class="v-code after">${esc(rem.after)}</pre></div>
  </div>` : ''}
  </div>`;
}).join('\n')}` : ''}

${overlaps.length > 0 ? `
<!-- Overlapping Issues -->
<h2 id="overlapping-issues"><span class="section-num">${nextSection()}</span>Issues Affecting Both ADA &amp; SEO</h2>
<div class="callout callout-info">
  <div class="callout-title">Why these matter most</div>
  <ul>
    <li>These ${overlaps.length} issue${overlaps.length !== 1 ? 's' : ''} hurt both accessibility AND search rankings</li>
    <li>Fixing them improves your site for users with disabilities AND boosts SEO</li>
    <li>Most are straightforward content fixes</li>
  </ul>
</div>
${overlaps.map(o => {
  const v = violations.find(v2 => v2.id === o.ada);
  const rem = remediationData[o.ada] || null;
  return `<div class="overlap-card">
  <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
    <span class="badge badge-both" style="font-size:10px;font-weight:700">ADA + SEO</span>
    ${v ? `<span class="badge badge-${v.impact}">${esc(v.impact)}</span>` : ''}
    <span style="font-size:12px;color:#78716c">WCAG ${o.wcag}</span>
  </div>
  <h4>${esc(o.label)}</h4>
  <ul style="font-size:13px;margin:6px 0;padding-left:20px;color:#44403c">
    <li><strong>Impact:</strong> ${esc(o.desc)}</li>
    ${v ? `<li><strong>Found on:</strong> ${(v.nodes?.length || 0)} element${(v.nodes?.length || 0) !== 1 ? 's' : ''}</li>` : ''}
    ${rem ? `<li><strong>Fix:</strong> ${esc(rem.summary || rem.description || '')}</li>` : ''}
  </ul>
  ${rem && rem.before && rem.after ? `<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px">
    <div><div style="font-size:11px;color:#dc2626;font-weight:600;margin-bottom:4px">Before</div><pre class="v-code before">${esc(rem.before)}</pre></div>
    <div><div style="font-size:11px;color:#16a34a;font-weight:600;margin-bottom:4px">After</div><pre class="v-code after">${esc(rem.after)}</pre></div>
  </div>` : ''}
  </div>`;
}).join('\n')}` : ''}

<!-- ADA Violations Detail -->
<h2 id="ada-violations"><span class="section-num">${nextSection()}</span>Accessibility Issues — Full Detail (${violations.length})</h2>

${violations.length === 0 ? '<div class="callout callout-success"><div class="callout-title">No accessibility violations found</div></div>' : `
${sortedViolations.map(v => {
  const color = sevColor(v.impact);
  const confColor = v._confidence === 'high' ? '#16a34a' : v._confidence === 'medium' ? '#d97706' : '#6b7280';
  const confLabel = v._confidence === 'high' ? 'Confirmed' : v._confidence === 'medium' ? 'Likely' : 'Needs Verification';
  const wcagTags = (v.tags || []).filter(t => t.startsWith('wcag')).map(t => {
    const m = t.match(/wcag(\d)(\d)(\d+)/);
    return m ? m[1] + '.' + m[2] + '.' + m[3] : null;
  }).filter(Boolean);
  const wcagDetail = wcagTags.length > 0 ? getWcagDetails(v.tags) : [];
  const rem = remediationData[v.id] || null;
  const nodeCount = v.nodes?.length || 0;
  return `<div class="v-card">
  <div class="v-card-header">
    ${sevEmoji(v.impact)} <span class="badge badge-${v.impact}">${esc(v.impact)}</span>
    <span class="badge-conf" style="background:${confColor}15;color:${confColor}">${confLabel}</span>
    <span class="badge-who">${whoFixes(v.id)}</span>
    <h4>${esc(v.help)}</h4>
  </div>
  <div class="v-card-meta">${nodeCount} element${nodeCount !== 1 ? 's' : ''} affected &middot; Rule: <code>${esc(v.id)}</code></div>
  <div class="v-card-plain">
    <strong>What's wrong:</strong> ${esc(v.description || v.help)}<br>
    <strong>User impact:</strong> ${sevPlain(v.impact)}
  </div>
  ${wcagDetail.length > 0 ? wcagDetail.map(w => `<div class="v-card-wcag">WCAG ${esc(w.sc)} — ${esc(w.name)} (Level ${esc(w.level)})</div>`).join('') : ''}
  ${nodeCount > 0 ? `<div class="v-card-nodes"><strong>Where:</strong><ul style="font-size:12px;color:#78716c;margin:4px 0;padding-left:20px">${v.nodes.slice(0, 5).map(n => `<li><code style="font-size:11px;word-break:break-all">${esc(Array.isArray(n.target) ? n.target.join(' > ') : String(n.target || ''))}</code></li>`).join('')}${nodeCount > 5 ? `<li style="color:#a8a29e">...and ${nodeCount - 5} more</li>` : ''}</ul></div>` : ''}
  ${rem ? `<div class="v-card-fix"><h5>How to Fix</h5>
  <ul style="margin:4px 0;padding-left:20px;font-size:13px"><li>${esc(rem.summary || rem.description || '')}</li></ul>
  ${rem.before && rem.after ? `<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:8px">
    <div><div style="font-size:11px;color:#dc2626;font-weight:600;margin-bottom:4px">Before</div><pre class="v-code before">${esc(rem.before)}</pre></div>
    <div><div style="font-size:11px;color:#16a34a;font-weight:600;margin-bottom:4px">After</div><pre class="v-code after">${esc(rem.after)}</pre></div>
  </div>` : ''}
  </div>` : ''}
  </div>`;
}).join('\n')}
`}

<!-- SEO Issues -->
<h2 id="seo-issues"><span class="section-num">${nextSection()}</span>SEO Issues (${seoIssues.length})</h2>

${!seoData ? '<p style="color:#78716c">SEO scan was not performed.</p>' : seoIssues.length === 0 ? '<div class="callout callout-success"><div class="callout-title">No SEO issues found — well optimized!</div></div>' : `
<table>
<thead><tr><th style="width:20%">Severity</th><th>Issue</th></tr></thead>
<tbody>
${seoIssues.map(issue => {
  const sev = issue.severity || 'moderate';
  return `<tr><td>${sevEmoji(sev)} <span class="badge badge-${sev}">${esc(sev)}</span></td><td>${esc(issue.msg || issue.message || '')}</td></tr>`;
}).join('\n')}
</tbody>
</table>
`}

${suggestions.length > 0 ? `
<!-- Speed Suggestions -->
<h2 id="speed-suggestions"><span class="section-num">${nextSection()}</span>Speed Improvements (${suggestions.length})</h2>
${suggestions.map(s => {
  const color = sevColor(s.severity);
  return `<div class="sug-card">
  <div style="display:flex;align-items:center;gap:8px">
    <span class="badge" style="background:${color}15;color:${color}">${esc(s.severity)}</span>
    <span style="font-size:12px;color:#78716c">${esc(s.category || '')}</span>
    ${s.savingsMs ? `<span class="sug-savings">~${(s.savingsMs / 1000).toFixed(1)}s faster</span>` : ''}
  </div>
  <h4>${esc(s.title)}</h4>
  <ul style="font-size:13px;margin:6px 0;padding-left:20px;color:#555"><li>${esc(s.fix)}</li></ul>
  ${s.code ? `<pre class="v-code">${esc(s.code)}</pre>` : ''}
  </div>`;
}).join('\n')}` : ''}

<!-- Methodology -->
<h2 id="methodology"><span class="section-num">${nextSection()}</span>How This Scan Was Done</h2>

<table>
<tbody>
<tr><td style="font-weight:600;width:180px">Accessibility Engine</td><td>axe-core ${esc(adaResults?.testEngine?.version || 'latest')}</td></tr>
<tr><td style="font-weight:600">Speed Engine</td><td>Google Lighthouse</td></tr>
<tr><td style="font-weight:600">Standard</td><td>WCAG 2.2 Level AA</td></tr>
<tr><td style="font-weight:600">Viewports</td><td>Desktop (1280x900) + Mobile (375x812)</td></tr>
<tr><td style="font-weight:600">Pages</td><td>${pageCount}</td></tr>
<tr><td style="font-weight:600">Date</td><td>${dateShort}</td></tr>
</tbody>
</table>

<div class="callout callout-warn">
  <div class="callout-title">What this scan covers</div>
  <ul>
    <li>Automated testing catches ~30-40% of accessibility issues</li>
    <li>Items marked "Needs Verification" require a human to check</li>
    <li>A full audit should also include keyboard testing, screen reader testing, and cognitive review</li>
  </ul>
</div>

</div><!-- end content -->

<div class="report-footer">
  <p>Generated by <strong>AutoADA</strong> — Website Health Report</p>
  <p>${dateShort} | ${esc(hostname)}</p>
</div>

</body></html>`;
}

// ---------------------------------------------------------------------------
// SEO HTML Report Generator (inline)
// ---------------------------------------------------------------------------
function generateSeoHtmlReport(data) {
  if (!data) return '<html><body><h1>No SEO data</h1></body></html>';
  const seo = data.seo || {};
  const lhDesktop = data.lighthouse?.desktop || {};
  const lhMobile = data.lighthouse?.mobile || {};
  const suggestions = data.speedSuggestions || [];
  const meta = seo.meta || {};
  const escHtml = (s) => String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');

  const perfScoreD = lhDesktop.categories?.performance?.score ?? '--';
  const perfScoreM = lhMobile.categories?.performance?.score ?? '--';
  const seoScoreD = lhDesktop.categories?.seo?.score ?? '--';
  const seoScoreM = lhMobile.categories?.seo?.score ?? '--';
  const customSeoScore = seo.seoScore?.score ?? '--';

  const scoreColor = (s) => s >= 90 ? '#2ed573' : s >= 50 ? '#ffa502' : '#ff4757';

  let issuesHtml = '';
  if (seo.seoScore?.issues) {
    for (const issue of seo.seoScore.issues) {
      const color = issue.severity === 'critical' ? '#ff4757' : issue.severity === 'serious' ? '#ff6348' : issue.severity === 'moderate' ? '#ffa502' : '#6366f1';
      issuesHtml += `<tr><td><span style="display:inline-block;padding:2px 8px;border-radius:99px;font-size:11px;font-weight:600;background:${color}22;color:${color}">${escHtml(issue.severity)}</span></td><td>${escHtml(issue.msg)}</td></tr>`;
    }
  }

  let metricsHtml = '';
  const metricsD = lhDesktop.metrics || {};
  const metricsM = lhMobile.metrics || {};
  const metricNames = [
    ['firstContentfulPaint', 'First Contentful Paint'],
    ['largestContentfulPaint', 'Largest Contentful Paint'],
    ['totalBlockingTime', 'Total Blocking Time'],
    ['cumulativeLayoutShift', 'Cumulative Layout Shift'],
    ['speedIndex', 'Speed Index'],
    ['timeToInteractive', 'Time to Interactive'],
  ];
  for (const [key, label] of metricNames) {
    const dVal = metricsD[key]?.displayValue || '--';
    const mVal = metricsM[key]?.displayValue || '--';
    const dScore = metricsD[key]?.score;
    const mScore = metricsM[key]?.score;
    const dColor = dScore !== null && dScore !== undefined ? scoreColor(dScore * 100) : '#888';
    const mColor = mScore !== null && mScore !== undefined ? scoreColor(mScore * 100) : '#888';
    metricsHtml += `<tr><td>${escHtml(label)}</td><td style="color:${dColor};font-weight:600">${escHtml(dVal)}</td><td style="color:${mColor};font-weight:600">${escHtml(mVal)}</td></tr>`;
  }

  let suggestionsHtml = '';
  for (const s of suggestions) {
    const color = s.severity === 'critical' ? '#ff4757' : s.severity === 'serious' ? '#ff6348' : '#ffa502';
    suggestionsHtml += `<div style="border:1px solid #e5e5e5;border-radius:8px;padding:16px;margin-bottom:12px">
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
        <span style="display:inline-block;padding:2px 8px;border-radius:99px;font-size:11px;font-weight:600;background:${color}22;color:${color}">${escHtml(s.severity)}</span>
        <span style="font-size:12px;color:#888">${escHtml(s.category)}</span>
      </div>
      <h3 style="font-size:15px;margin-bottom:8px">${escHtml(s.title)}</h3>
      <p style="font-size:13px;color:#555;margin-bottom:8px">${escHtml(s.fix)}</p>
      ${s.code ? `<pre style="background:#f5f5f5;padding:12px;border-radius:6px;font-size:12px;overflow-x:auto;white-space:pre-wrap">${escHtml(s.code)}</pre>` : ''}
    </div>`;
  }

  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>AutoSEO Report — ${escHtml(data.url)}</title>
<style>
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:960px;margin:0 auto;padding:40px 20px;color:#1c1917;line-height:1.6}
h1{font-size:28px;margin-bottom:8px}h2{font-size:20px;margin-top:40px;padding-bottom:8px;border-bottom:2px solid #e5e5e5}
.meta{color:#78716c;font-size:14px;margin-bottom:32px}
.scores{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:16px;margin:24px 0}
.score-card{text-align:center;padding:24px 16px;border-radius:12px;background:#fafaf9;border:1px solid #e5e5e5}
.score-num{font-size:36px;font-weight:800}
.score-lbl{font-size:13px;color:#78716c;margin-top:4px}
table{width:100%;border-collapse:collapse;margin:16px 0;font-size:14px}
th{text-align:left;padding:10px 12px;font-size:12px;text-transform:uppercase;letter-spacing:.5px;color:#78716c;border-bottom:2px solid #e5e5e5}
td{padding:10px 12px;border-bottom:1px solid #f0f0f0}
.pass{color:#16a34a}.warn{color:#d97706}.fail{color:#dc2626}
@media print{body{padding:20px}.score-card{break-inside:avoid}}
</style></head><body>
<h1>AutoSEO Report</h1>
<div class="meta">${escHtml(data.url)} | ${new Date(data.scanDate).toLocaleString()}</div>

<div class="scores">
  <div class="score-card"><div class="score-num" style="color:${scoreColor(customSeoScore)}">${customSeoScore}</div><div class="score-lbl">SEO Score</div></div>
  <div class="score-card"><div class="score-num" style="color:${scoreColor(perfScoreD)}">${perfScoreD}</div><div class="score-lbl">Performance (Desktop)</div></div>
  <div class="score-card"><div class="score-num" style="color:${scoreColor(perfScoreM)}">${perfScoreM}</div><div class="score-lbl">Performance (Mobile)</div></div>
  <div class="score-card"><div class="score-num" style="color:${scoreColor(seoScoreD)}">${seoScoreD}</div><div class="score-lbl">LH SEO (Desktop)</div></div>
  <div class="score-card"><div class="score-num" style="color:${scoreColor(seoScoreM)}">${seoScoreM}</div><div class="score-lbl">LH SEO (Mobile)</div></div>
</div>

<h2>SEO Issues</h2>
${issuesHtml ? `<table><thead><tr><th>Severity</th><th>Issue</th></tr></thead><tbody>${issuesHtml}</tbody></table>` : '<p style="color:#16a34a;font-weight:600">No SEO issues found!</p>'}

<h2>Meta Tags</h2>
<table><tbody>
<tr><td><strong>Title</strong></td><td>${escHtml(meta.title)} <span style="color:#888">(${meta.titleLength} chars)</span></td></tr>
<tr><td><strong>Description</strong></td><td>${escHtml(meta.description) || '<span class="fail">Missing</span>'} <span style="color:#888">(${meta.descriptionLength} chars)</span></td></tr>
<tr><td><strong>Canonical</strong></td><td>${escHtml(meta.canonical) || '<span class="warn">Missing</span>'}</td></tr>
<tr><td><strong>Language</strong></td><td>${escHtml(meta.lang) || '<span class="warn">Missing</span>'}</td></tr>
<tr><td><strong>Viewport</strong></td><td>${escHtml(meta.viewport) || '<span class="fail">Missing</span>'}</td></tr>
<tr><td><strong>Robots</strong></td><td>${escHtml(meta.robots) || 'Not set (default: index, follow)'}</td></tr>
</tbody></table>

<h2>Performance Metrics</h2>
<table><thead><tr><th>Metric</th><th>Desktop</th><th>Mobile</th></tr></thead><tbody>${metricsHtml}</tbody></table>

<h2>Speed Improvement Suggestions (${suggestions.length})</h2>
${suggestionsHtml || '<p style="color:#16a34a;font-weight:600">No speed issues found — great performance!</p>'}

<div style="margin-top:40px;padding-top:16px;border-top:1px solid #e5e5e5;color:#78716c;font-size:12px">Generated by AutoADA AutoSEO | ${new Date().toLocaleString()}</div>
</body></html>`;
}

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const server = app.listen(PORT, HOST, () => {
  console.log(`\n  AutoADA Web UI running at http://localhost:${PORT}\n`);
});

// Friendly error when port is already in use
server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  ❌ Port ${PORT} is already in use.`);
    console.error(`  → Run: lsof -i :${PORT} -t | xargs kill -9`);
    console.error(`  → Or set a different port: PORT=${Number(PORT) + 1} node src/server.js\n`);
    process.exit(1);
  }
  throw err;
});

// Graceful shutdown — close SSE clients and server
function gracefulShutdown() {
  console.log('\n  Shutting down AutoADA...');
  for (const [, scan] of scans) { try { closeSSEClients(scan); } catch {} }
  for (const [, scan] of seoScans) { try { closeSeoSSEClients(scan); } catch {} }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(1), 5000);  // Force exit after 5s
}
process.on('SIGINT', gracefulShutdown);
process.on('SIGTERM', gracefulShutdown);

// Global error handlers — prevent Railway crash loops from unhandled rejections
process.on('unhandledRejection', (reason, promise) => {
  console.error('  [FATAL] Unhandled Promise Rejection:', reason);
  // Mark all running scans as errored so clients get feedback
  for (const [, scan] of scans) {
    if (scan.status === 'running') {
      scan.status = 'error';
      scan.error = 'Internal server error (unhandled rejection)';
      scan.completedAt = Date.now();
      try { broadcastSSE(scan, { phase: 'error', message: scan.error }); } catch {}
      try { closeSSEClients(scan); } catch {}
    }
  }
  for (const [, scan] of seoScans) {
    if (scan.status === 'running') {
      scan.status = 'error';
      scan.error = 'Internal server error (unhandled rejection)';
      scan.completedAt = Date.now();
      try { broadcastSeoSSE(scan, { phase: 'error', message: scan.error }); } catch {}
      try { closeSeoSSEClients(scan); } catch {}
    }
  }
});

process.on('uncaughtException', (err) => {
  console.error('  [FATAL] Uncaught Exception:', err);
  // Attempt graceful shutdown — don't let process stay in broken state
  gracefulShutdown();
});
