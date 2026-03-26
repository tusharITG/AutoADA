/**
 * AutoSEO — SEO analysis + Lighthouse performance scoring.
 * Runs Lighthouse programmatically for speed metrics and performs
 * HTML-level SEO checks (meta tags, headings, links, structured data, etc.).
 */

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

let lighthouseLoader;
async function getLighthouse() {
  if (!lighthouseLoader) {
    lighthouseLoader = import('lighthouse')
      .then((mod) => mod.default || mod)
      .catch((err) => {
        lighthouseLoader = null;
        throw err;
      });
  }
  return lighthouseLoader;
}

// ───────────────────────────────────────────────────
// Lighthouse Performance Audit
// ───────────────────────────────────────────────────

async function runLighthouseAudit(url, opts = {}) {
  let browser;
  try {
    const lighthouse = await getLighthouse();

    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });

    const { port } = new URL(browser.wsEndpoint());

    const lhConfig = {
      extends: 'lighthouse:default',
      settings: {
        onlyCategories: ['performance', 'seo', 'best-practices'],
        formFactor: opts.mobile ? 'mobile' : 'desktop',
        screenEmulation: opts.mobile
          ? { mobile: true, width: 375, height: 812, deviceScaleFactor: 2, disabled: false }
          : { mobile: false, width: 1350, height: 940, deviceScaleFactor: 1, disabled: false },
        throttling: opts.mobile
          ? undefined // default mobile throttling
          : { rttMs: 40, throughputKbps: 10240, cpuSlowdownMultiplier: 1, requestLatencyMs: 0, downloadThroughputKbps: 0, uploadThroughputKbps: 0 },
        maxWaitForLoad: opts.timeout || 45000,
      },
    };

    const flags = {
      port: parseInt(port, 10),
      output: 'json',
      logLevel: 'error',
    };

    const result = await lighthouse(url, flags, lhConfig);
    const lhr = result.lhr;

    // Extract core web vitals + performance metrics
    const metrics = extractMetrics(lhr);
    const opportunities = extractOpportunities(lhr);
    const diagnostics = extractDiagnostics(lhr);
    const categories = extractCategories(lhr);

    return {
      url,
      fetchTime: lhr.fetchTime,
      formFactor: opts.mobile ? 'mobile' : 'desktop',
      categories,
      metrics,
      opportunities,
      diagnostics,
    };
  } finally {
    if (browser) await browser.close();
  }
}

function extractMetrics(lhr) {
  const audits = lhr.audits || {};
  const getValue = (id) => {
    const a = audits[id];
    if (!a) return null;
    return {
      score: a.score,
      value: a.numericValue || null,
      displayValue: a.displayValue || null,
    };
  };

  return {
    firstContentfulPaint: getValue('first-contentful-paint'),
    largestContentfulPaint: getValue('largest-contentful-paint'),
    totalBlockingTime: getValue('total-blocking-time'),
    cumulativeLayoutShift: getValue('cumulative-layout-shift'),
    speedIndex: getValue('speed-index'),
    timeToInteractive: getValue('interactive'),
    firstMeaningfulPaint: getValue('first-meaningful-paint'),
    serverResponseTime: getValue('server-response-time'),
    maxPotentialFid: getValue('max-potential-fid'),
  };
}

function extractOpportunities(lhr) {
  const audits = lhr.audits || {};
  const opportunities = [];
  for (const [id, audit] of Object.entries(audits)) {
    if (audit.details?.type === 'opportunity' && audit.score !== null && audit.score < 1) {
      const allItems = audit.details.items || [];
      const MAX_ITEMS = 5;
      opportunities.push({
        id,
        title: audit.title,
        description: audit.description,
        score: audit.score,
        savings: audit.details.overallSavingsMs || 0,
        savingsBytes: audit.details.overallSavingsBytes || 0,
        displayValue: audit.displayValue || '',
        totalItems: allItems.length,
        truncated: allItems.length > MAX_ITEMS,
        items: allItems.slice(0, MAX_ITEMS).map(item => ({
          url: item.url || item.source || '',
          totalBytes: item.totalBytes || 0,
          wastedBytes: item.wastedBytes || 0,
          wastedMs: item.wastedMs || 0,
        })),
      });
    }
  }
  return opportunities.sort((a, b) => b.savings - a.savings);
}

function extractDiagnostics(lhr) {
  const audits = lhr.audits || {};
  const diagnostics = [];
  const diagIds = [
    'dom-size', 'font-display', 'uses-passive-event-listeners',
    'no-document-write', 'uses-http2', 'mainthread-work-breakdown',
    'bootup-time', 'third-party-summary', 'largest-contentful-paint-element',
    'layout-shift-elements', 'long-tasks', 'render-blocking-resources',
    'uses-long-cache-ttl', 'total-byte-weight', 'critical-request-chains',
  ];
  for (const id of diagIds) {
    const audit = audits[id];
    if (audit && audit.score !== null && audit.score < 1) {
      diagnostics.push({
        id,
        title: audit.title,
        description: audit.description,
        score: audit.score,
        displayValue: audit.displayValue || '',
      });
    }
  }
  return diagnostics;
}

function extractCategories(lhr) {
  const cats = {};
  for (const [key, cat] of Object.entries(lhr.categories || {})) {
    cats[key] = {
      title: cat.title,
      score: Math.round((cat.score || 0) * 100),
    };
  }
  return cats;
}

// ───────────────────────────────────────────────────
// HTML-level SEO Analysis
// ───────────────────────────────────────────────────

async function runSeoAnalysis(url, opts = {}) {
  let browser, page;
  const ownsBrowser = !opts.browser; // Track if we launched the browser (so we know to close it)
  try {
    browser = opts.browser || await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
    page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    await page.setViewport({ width: 1280, height: 900 });

    try {
      await page.goto(url, { waitUntil: 'networkidle2', timeout: opts.timeout || 30000 });
    } catch (navErr) {
      const msg = navErr.message || '';
      // Classify the error for the caller
      if (msg.includes('ERR_NAME_NOT_RESOLVED') || msg.includes('ERR_CONNECTION_REFUSED') || msg.includes('ERR_ADDRESS_UNREACHABLE')) {
        throw new Error(`SEO analysis failed: site unreachable (${msg.split('\n')[0]})`);
      }
      if (msg.includes('Timeout') || msg.includes('timeout')) {
        throw new Error(`SEO analysis failed: page load timed out after ${(opts.timeout || 30000) / 1000}s`);
      }
      throw new Error(`SEO analysis failed: navigation error (${msg.split('\n')[0]})`);
    }

    // Run all checks in a single page.evaluate
    const seoData = await page.evaluate(() => {
      const results = {};

      // --- Meta Tags ---
      const getMeta = (name) => {
        const el = document.querySelector(`meta[name="${name}"], meta[property="${name}"]`);
        return el ? el.getAttribute('content') : null;
      };

      results.meta = {
        title: document.title || null,
        titleLength: (document.title || '').length,
        description: getMeta('description'),
        descriptionLength: (getMeta('description') || '').length,
        canonical: (document.querySelector('link[rel="canonical"]') || {}).href || null,
        robots: getMeta('robots'),
        viewport: getMeta('viewport'),
        charset: document.characterSet,
        lang: document.documentElement.lang || null,
      };

      // --- Open Graph ---
      results.openGraph = {
        title: getMeta('og:title'),
        description: getMeta('og:description'),
        image: getMeta('og:image'),
        url: getMeta('og:url'),
        type: getMeta('og:type'),
        siteName: getMeta('og:site_name'),
      };

      // --- Twitter Card ---
      results.twitterCard = {
        card: getMeta('twitter:card'),
        title: getMeta('twitter:title'),
        description: getMeta('twitter:description'),
        image: getMeta('twitter:image'),
        site: getMeta('twitter:site'),
      };

      // --- Headings ---
      const headings = {};
      for (let i = 1; i <= 6; i++) {
        const els = document.querySelectorAll('h' + i);
        headings['h' + i] = {
          count: els.length,
          texts: Array.from(els).slice(0, 5).map(el => el.textContent.trim().substring(0, 100)),
        };
      }
      results.headings = headings;

      // --- Images ---
      const images = document.querySelectorAll('img');
      let withAlt = 0, withoutAlt = 0, emptyAlt = 0, oversized = 0;
      const missingAltImages = [];
      images.forEach(img => {
        const alt = img.getAttribute('alt');
        if (alt === null || alt === undefined) {
          withoutAlt++;
          if (missingAltImages.length < 5) missingAltImages.push(img.src || img.currentSrc || '');
        } else if (alt.trim() === '') {
          emptyAlt++;
        } else {
          withAlt++;
        }
        if (img.naturalWidth > 2000 || img.naturalHeight > 2000) oversized++;
      });
      results.images = { total: images.length, withAlt, withoutAlt, emptyAlt, oversized, missingAltImages };

      // --- Links ---
      const links = document.querySelectorAll('a[href]');
      let internal = 0, external = 0, nofollow = 0, brokenAnchors = 0;
      const externalLinks = [];
      links.forEach(a => {
        const href = a.href;
        if (!href || href === '#' || href.startsWith('javascript:')) { brokenAnchors++; return; }
        try {
          const linkUrl = new URL(href, window.location.origin);
          if (linkUrl.hostname === window.location.hostname) {
            internal++;
          } else {
            external++;
            if (externalLinks.length < 10) externalLinks.push({ url: href, text: a.textContent.trim().substring(0, 60) });
          }
          if (a.rel && a.rel.includes('nofollow')) nofollow++;
        } catch { brokenAnchors++; }
      });
      results.links = { total: links.length, internal, external, nofollow, brokenAnchors, externalLinks };

      // --- Structured Data (JSON-LD) ---
      const ldScripts = document.querySelectorAll('script[type="application/ld+json"]');
      const structuredData = [];
      ldScripts.forEach(script => {
        try {
          const data = JSON.parse(script.textContent);
          structuredData.push({
            type: data['@type'] || (Array.isArray(data['@graph']) ? 'Graph' : 'Unknown'),
            summary: JSON.stringify(data).substring(0, 200),
          });
        } catch { /* invalid JSON-LD */ }
      });
      results.structuredData = structuredData;

      // --- DOM Stats ---
      results.domStats = {
        totalElements: document.querySelectorAll('*').length,
        totalScripts: document.querySelectorAll('script').length,
        totalStylesheets: document.querySelectorAll('link[rel="stylesheet"]').length,
        inlineStyles: document.querySelectorAll('[style]').length,
        iframes: document.querySelectorAll('iframe').length,
        forms: document.querySelectorAll('form').length,
      };

      // --- Indexability ---
      const robotsMeta = getMeta('robots') || '';
      results.indexability = {
        isIndexable: !robotsMeta.toLowerCase().includes('noindex'),
        isFollowable: !robotsMeta.toLowerCase().includes('nofollow'),
        hasCanonical: !!document.querySelector('link[rel="canonical"]'),
        hasHreflang: document.querySelectorAll('link[rel="alternate"][hreflang]').length > 0,
        hreflangCount: document.querySelectorAll('link[rel="alternate"][hreflang]').length,
      };

      // --- Mobile Friendliness ---
      const vp = getMeta('viewport') || '';
      results.mobileFriendliness = {
        hasViewport: !!vp,
        viewportContent: vp,
        hasWidthDeviceWidth: vp.includes('width=device-width'),
        hasInitialScale: vp.includes('initial-scale'),
        touchIcons: document.querySelectorAll('link[rel="apple-touch-icon"]').length > 0,
      };

      return results;
    });

    // Fetch robots.txt and sitemap for extra info
    const robotsInfo = await fetchRobotsInfo(url, page);
    seoData.robotsTxt = robotsInfo;

    // Calculate SEO score
    seoData.seoScore = calculateSeoScore(seoData);

    return seoData;
  } finally {
    if (page) await page.close().catch(() => {});
    if (ownsBrowser && browser) await browser.close().catch(() => {});
  }
}

async function fetchRobotsInfo(baseUrl, page) {
  try {
    const urlObj = new URL(baseUrl);
    const robotsUrl = `${urlObj.protocol}//${urlObj.hostname}/robots.txt`;
    const response = await page.evaluate(async (url) => {
      try {
        const res = await fetch(url);
        if (!res.ok) return { exists: false, status: res.status };
        const text = await res.text();
        return { exists: true, status: res.status, hasSitemap: text.toLowerCase().includes('sitemap:'), content: text.substring(0, 500) };
      } catch { return { exists: false, error: true }; }
    }, robotsUrl);
    return response;
  } catch {
    return { exists: false, error: true };
  }
}

function calculateSeoScore(data) {
  if (!data || typeof data !== 'object') return { score: 0, issues: [{ severity: 'critical', msg: 'No SEO data available' }] };

  let score = 100;
  const issues = [];

  // Defensive defaults for all sub-objects
  const meta = data.meta || {};
  const headings = data.headings || {};
  const h1 = headings.h1 || { count: 0 };
  const images = data.images || { withoutAlt: 0 };
  const openGraph = data.openGraph || {};
  const twitterCard = data.twitterCard || {};
  const structuredData = data.structuredData || [];
  const indexability = data.indexability || { isIndexable: true };
  const robotsTxt = data.robotsTxt;

  // Title
  if (!meta.title) { score -= 15; issues.push({ severity: 'critical', msg: 'Missing page title' }); }
  else if ((meta.titleLength || 0) < 30) { score -= 5; issues.push({ severity: 'moderate', msg: 'Title too short (' + (meta.titleLength || 0) + ' chars, aim for 50-60)' }); }
  else if ((meta.titleLength || 0) > 60) { score -= 3; issues.push({ severity: 'minor', msg: 'Title too long (' + (meta.titleLength || 0) + ' chars, aim for 50-60)' }); }

  // Description
  if (!meta.description) { score -= 10; issues.push({ severity: 'serious', msg: 'Missing meta description' }); }
  else if ((meta.descriptionLength || 0) < 70) { score -= 3; issues.push({ severity: 'minor', msg: 'Meta description too short (' + (meta.descriptionLength || 0) + ' chars)' }); }
  else if ((meta.descriptionLength || 0) > 160) { score -= 3; issues.push({ severity: 'minor', msg: 'Meta description too long (' + (meta.descriptionLength || 0) + ' chars)' }); }

  // Canonical
  if (!meta.canonical) { score -= 5; issues.push({ severity: 'moderate', msg: 'Missing canonical URL' }); }

  // Language
  if (!meta.lang) { score -= 5; issues.push({ severity: 'moderate', msg: 'Missing lang attribute on <html>' }); }

  // Viewport
  if (!meta.viewport) { score -= 10; issues.push({ severity: 'serious', msg: 'Missing viewport meta tag' }); }

  // Headings
  if (h1.count === 0) { score -= 10; issues.push({ severity: 'serious', msg: 'No H1 heading found' }); }
  else if (h1.count > 1) { score -= 3; issues.push({ severity: 'minor', msg: 'Multiple H1 headings (' + h1.count + ')' }); }

  // Images without alt
  if (images.withoutAlt > 0) {
    const penalty = Math.min(10, images.withoutAlt * 2);
    score -= penalty;
    issues.push({ severity: 'serious', msg: images.withoutAlt + ' image(s) missing alt text' });
  }

  // Open Graph
  const ogFields = ['title', 'description', 'image'];
  const missingOg = ogFields.filter(f => !openGraph[f]);
  if (missingOg.length > 0) { score -= missingOg.length * 2; issues.push({ severity: 'moderate', msg: 'Missing Open Graph: ' + missingOg.join(', ') }); }

  // Twitter Card
  if (!twitterCard.card) { score -= 2; issues.push({ severity: 'minor', msg: 'Missing Twitter Card meta tags' }); }

  // Structured Data
  if (structuredData.length === 0) { score -= 5; issues.push({ severity: 'moderate', msg: 'No structured data (JSON-LD) found' }); }

  // Indexability
  if (!indexability.isIndexable) { score -= 5; issues.push({ severity: 'moderate', msg: 'Page is set to noindex' }); }

  // Robots.txt
  if (robotsTxt && !robotsTxt.exists) { score -= 2; issues.push({ severity: 'minor', msg: 'No robots.txt found' }); }
  if (robotsTxt && robotsTxt.exists && !robotsTxt.hasSitemap) { score -= 2; issues.push({ severity: 'minor', msg: 'robots.txt does not reference a sitemap' }); }

  return { score: Math.max(0, Math.min(100, score)), issues };
}

// ───────────────────────────────────────────────────
// Code-Level Speed Suggestions
// ───────────────────────────────────────────────────

function generateSpeedSuggestions(lighthouseData, seoData) {
  const suggestions = [];

  if (!lighthouseData || lighthouseData.error) return suggestions;

  const metrics = lighthouseData.metrics || {};
  const opps = lighthouseData.opportunities || [];

  // Helper: safely get numeric metric value (returns null if missing)
  const metricVal = (key) => metrics[key]?.value ?? null;

  // LCP
  const lcpVal = metricVal('largestContentfulPaint');
  if (lcpVal !== null && lcpVal > 2500) {
    suggestions.push({
      category: 'Core Web Vital',
      severity: lcpVal > 4000 ? 'critical' : 'serious',
      title: 'Largest Contentful Paint is slow (' + (lcpVal / 1000).toFixed(1) + 's)',
      fix: 'Optimize the largest visible element. Preload hero images with <link rel="preload">, use responsive images with srcset, compress images to WebP/AVIF, and ensure server TTFB < 800ms.',
      code: '<link rel="preload" as="image" href="/hero.webp" fetchpriority="high">\n<img src="/hero.webp" srcset="/hero-400.webp 400w, /hero-800.webp 800w" sizes="100vw" alt="...">'
    });
  }

  // CLS
  const clsVal = metricVal('cumulativeLayoutShift');
  if (clsVal !== null && clsVal > 0.1) {
    suggestions.push({
      category: 'Core Web Vital',
      severity: clsVal > 0.25 ? 'critical' : 'serious',
      title: 'Layout shifts detected (CLS: ' + clsVal.toFixed(3) + ')',
      fix: 'Always set width and height on images/videos. Use CSS aspect-ratio. Avoid injecting content above existing content. Use font-display: swap with size-adjust.',
      code: '<img src="photo.jpg" width="800" height="600" alt="...">\n\n/* CSS */\n.hero-img { aspect-ratio: 4/3; }\n@font-face { font-display: swap; size-adjust: 105%; }'
    });
  }

  // TBT
  const tbtVal = metricVal('totalBlockingTime');
  if (tbtVal !== null && tbtVal > 200) {
    suggestions.push({
      category: 'Core Web Vital',
      severity: tbtVal > 600 ? 'critical' : 'serious',
      title: 'Main thread is blocked (' + Math.round(tbtVal) + 'ms TBT)',
      fix: 'Break up long tasks with requestIdleCallback() or setTimeout(). Defer non-critical JS with async/defer. Move heavy computation to Web Workers.',
      code: '<script src="/analytics.js" defer></script>\n<script src="/widget.js" async></script>\n\n// Break long tasks\nfunction processChunk(items, i) {\n  const end = Math.min(i + 50, items.length);\n  for (; i < end; i++) process(items[i]);\n  if (end < items.length) setTimeout(() => processChunk(items, end), 0);\n}'
    });
  }

  // FCP
  const fcpVal = metricVal('firstContentfulPaint');
  if (fcpVal !== null && fcpVal > 1800) {
    suggestions.push({
      category: 'Performance',
      severity: 'moderate',
      title: 'Slow First Contentful Paint (' + (fcpVal / 1000).toFixed(1) + 's)',
      fix: 'Eliminate render-blocking resources. Inline critical CSS. Preconnect to required origins. Use font-display: swap.',
      code: '<link rel="preconnect" href="https://fonts.googleapis.com">\n<link rel="preconnect" href="https://cdn.example.com" crossorigin>\n<style>/* critical above-fold CSS inlined here */</style>'
    });
  }

  // Server response time
  const ttfbVal = metricVal('serverResponseTime');
  if (ttfbVal !== null && ttfbVal > 600) {
    suggestions.push({
      category: 'Server',
      severity: 'serious',
      title: 'Slow server response (TTFB: ' + Math.round(ttfbVal) + 'ms)',
      fix: 'Enable server-side caching, use a CDN, optimize database queries, and consider edge computing. Aim for TTFB < 200ms.',
      code: '# Nginx caching example\nlocation / {\n  proxy_cache_valid 200 10m;\n  add_header Cache-Control "public, max-age=600";\n  add_header X-Cache-Status $upstream_cache_status;\n}'
    });
  }

  // Opportunity-based suggestions
  for (const opp of opps) {
    if (opp.savings < 100) continue; // Skip trivial savings
    const existing = suggestions.find(s => s.title.includes(opp.title));
    if (existing) continue;

    let fix = '', code = '';
    switch (opp.id) {
      case 'render-blocking-resources':
        fix = 'Defer non-critical CSS and JS. Use media queries on stylesheets. Inline critical CSS.';
        code = '<link rel="stylesheet" href="/print.css" media="print">\n<link rel="preload" href="/style.css" as="style" onload="this.onload=null;this.rel=\'stylesheet\'">';
        break;
      case 'uses-text-compression':
        fix = 'Enable Gzip/Brotli compression on your server for text-based assets.';
        code = '# Nginx Brotli\nbrotli on;\nbrotli_types text/html text/css application/javascript application/json;';
        break;
      case 'uses-responsive-images':
      case 'offscreen-images':
        fix = 'Use responsive srcset, lazy-load offscreen images, and serve modern formats (WebP/AVIF).';
        code = '<img src="photo.webp" srcset="photo-400.webp 400w, photo-800.webp 800w"\n     sizes="(max-width: 600px) 400px, 800px"\n     loading="lazy" alt="...">';
        break;
      case 'unminified-javascript':
      case 'unminified-css':
        fix = 'Minify all JS and CSS files. Use a build tool like Vite, webpack, or esbuild.';
        code = '// package.json\n"scripts": { "build": "vite build" }\n\n# Or: npx esbuild src/app.js --bundle --minify --outfile=dist/app.js';
        break;
      case 'unused-javascript':
      case 'unused-css-rules':
        fix = 'Remove unused code. Use code splitting and tree shaking. Load features on demand.';
        code = '// Dynamic import for code splitting\nconst module = await import(\'./heavy-feature.js\');\n\n// CSS: Use PurgeCSS to remove unused rules';
        break;
      case 'efficient-animated-content':
        fix = 'Replace GIFs with video (MP4/WebM). Use CSS animations instead of JS where possible.';
        code = '<video autoplay loop muted playsinline>\n  <source src="animation.webm" type="video/webm">\n  <source src="animation.mp4" type="video/mp4">\n</video>';
        break;
      case 'uses-optimized-images':
        fix = 'Compress images with tools like Sharp, Squoosh, or ImageOptim. Convert to WebP/AVIF.';
        code = '# Convert with Sharp\nnpx sharp-cli -i input.png -o output.webp --webp\n\n# Or use <picture> for format fallback\n<picture>\n  <source srcset="photo.avif" type="image/avif">\n  <source srcset="photo.webp" type="image/webp">\n  <img src="photo.jpg" alt="...">\n</picture>';
        break;
      default:
        fix = opp.description ? opp.description.replace(/\[.*?\]\(.*?\)/g, '').substring(0, 200) : opp.title;
    }

    suggestions.push({
      category: 'Lighthouse Opportunity',
      severity: opp.savings > 1000 ? 'serious' : 'moderate',
      title: opp.title + (opp.displayValue ? ' — ' + opp.displayValue : ''),
      fix,
      code: code || null,
      savingsMs: opp.savings,
    });
  }

  // DOM size check from SEO data
  const domElements = seoData?.domStats?.totalElements;
  if (domElements && domElements > 1500) {
    suggestions.push({
      category: 'DOM',
      severity: domElements > 3000 ? 'serious' : 'moderate',
      title: 'Large DOM size (' + domElements + ' elements)',
      fix: 'Reduce DOM nodes by virtualizing long lists, lazy-loading sections, and removing hidden/unused elements.',
      code: '// Virtualize long lists (e.g., react-window)\nimport { FixedSizeList } from "react-window";\n<FixedSizeList height={600} itemCount={1000} itemSize={50}>\n  {({ index, style }) => <div style={style}>Row {index}</div>}\n</FixedSizeList>'
    });
  }

  return suggestions;
}

// ───────────────────────────────────────────────────
// Full SEO+Speed Scan
// ───────────────────────────────────────────────────

async function runFullSeoScan(url, opts = {}) {
  const onProgress = opts.onProgress || (() => {});

  onProgress({ phase: 'seo-start', message: 'Starting SEO analysis...' });

  // Launch a shared browser for SEO analysis (Lighthouse needs its own due to debugging port)
  let seoBrowser;
  try {
    seoBrowser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });
  } catch (err) {
    seoBrowser = null;
  }

  // Run SEO analysis using shared browser
  onProgress({ phase: 'seo-meta', message: 'Analyzing page meta tags, headings, links...' });
  let seoData;
  try {
    seoData = await runSeoAnalysis(url, { ...opts, browser: seoBrowser });
  } catch (err) {
    seoData = { error: err.message };
  }

  // Close shared SEO browser after analysis
  if (seoBrowser) await seoBrowser.close().catch(() => {});
  onProgress({ phase: 'seo-meta-done', message: 'SEO analysis complete' });

  // Run Lighthouse — desktop (Lighthouse manages its own browser via port)
  onProgress({ phase: 'lighthouse-desktop', message: 'Running Lighthouse (desktop)...' });
  let lighthouseDesktop;
  try {
    lighthouseDesktop = await runLighthouseAudit(url, { ...opts, mobile: false });
  } catch (err) {
    lighthouseDesktop = { error: err.message };
  }
  onProgress({ phase: 'lighthouse-desktop-done', message: 'Desktop performance audit complete' });

  // Run Lighthouse — mobile (reuses same approach — Lighthouse closes browser after each)
  onProgress({ phase: 'lighthouse-mobile', message: 'Running Lighthouse (mobile)...' });
  let lighthouseMobile;
  try {
    lighthouseMobile = await runLighthouseAudit(url, { ...opts, mobile: true });
  } catch (err) {
    lighthouseMobile = { error: err.message };
  }
  onProgress({ phase: 'lighthouse-mobile-done', message: 'Mobile performance audit complete' });

  // Generate speed suggestions
  onProgress({ phase: 'seo-suggestions', message: 'Generating speed improvement suggestions...' });
  const speedSuggestions = generateSpeedSuggestions(lighthouseDesktop.error ? lighthouseMobile : lighthouseDesktop, seoData);

  onProgress({ phase: 'seo-done', message: 'AutoSEO scan complete' });

  return {
    url,
    scanDate: new Date().toISOString(),
    seo: seoData,
    lighthouse: {
      desktop: lighthouseDesktop,
      mobile: lighthouseMobile,
    },
    speedSuggestions,
  };
}

module.exports = { runFullSeoScan, runLighthouseAudit, runSeoAnalysis, generateSpeedSuggestions, calculateSeoScore };
