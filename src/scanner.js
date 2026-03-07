/**
 * Scanner engine — per-page WCAG scanning with dual viewport + pop-up handling.
 * Uses isolated browser contexts and defensive page loading.
 */

const puppeteer = require('puppeteer');
const { AxePuppeteer } = require('@axe-core/puppeteer');
const { captureAnnotatedScreenshot } = require('./screenshotter');

// Common dismiss/close selectors (prefer close/dismiss over accept)
const DISMISS_SELECTORS = [
  '[aria-label*="close" i]',
  '[aria-label*="dismiss" i]',
  '[aria-label*="reject" i]',
  '[aria-label*="decline" i]',
  'button[class*="close" i]',
  '.modal-close',
  '[data-dismiss]',
  'button[aria-label*="deny" i]',
];

const ACCEPT_FALLBACK_SELECTORS = [
  '#onetrust-accept-btn-handler',
  '[id*="cookie" i] button',
  '[class*="consent" i] button',
  '[class*="cookie" i] button[class*="accept" i]',
  '[id*="consent" i] button',
];

const VIEWPORTS = {
  desktop: { width: 1280, height: 900 },
  mobile: { width: 375, height: 812 },
};

/**
 * Defensive page load strategy.
 * Doesn't rely solely on networkidle2 — uses a multi-step approach.
 */
async function loadPageDefensively(page, url, timeout = 30000) {
  // Step 1: Navigate with domcontentloaded (fast, reliable)
  await page.goto(url, {
    waitUntil: 'domcontentloaded',
    timeout,
  });

  // Step 2: Stable delay for JS framework hydration
  await new Promise((r) => setTimeout(r, 2000));

  // Step 3: Wait for key content selectors (best-effort, short timeout)
  try {
    await page.waitForSelector('body:not(:empty)', { timeout: 3000 });
  } catch {
    // Body not empty check failed — continue anyway
  }

  try {
    await page.waitForSelector('main, #content, #main, [role="main"]', { timeout: 2000 });
  } catch {
    // No main content landmark — that's fine, not all pages have one
  }

  // Step 4: Best-effort network idle (don't fail if it never settles)
  try {
    await page.waitForNetworkIdle({ idleTime: 500, timeout: 5000 });
  } catch {
    // Network never went idle — proceed anyway (common for ecommerce/SPA sites)
  }
}

/**
 * Try to dismiss overlays/popups on the page.
 * Prefers close/dismiss over accept.
 * Returns true if something was dismissed.
 */
async function tryDismissOverlays(page) {
  let dismissed = false;

  // First try dismiss/close/reject selectors
  for (const selector of DISMISS_SELECTORS) {
    try {
      const btn = await page.$(selector);
      if (btn) {
        const isVisible = await page.evaluate((el) => {
          const style = window.getComputedStyle(el);
          return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
        }, btn);
        if (isVisible) {
          await btn.click();
          dismissed = true;
          await new Promise((r) => setTimeout(r, 500));
          break;
        }
      }
    } catch {
      // Selector not found or click failed — try next
    }
  }

  // Fallback: try accept selectors only if dismiss didn't work
  if (!dismissed) {
    for (const selector of ACCEPT_FALLBACK_SELECTORS) {
      try {
        const btn = await page.$(selector);
        if (btn) {
          const isVisible = await page.evaluate((el) => {
            const style = window.getComputedStyle(el);
            return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
          }, btn);
          if (isVisible) {
            await btn.click();
            dismissed = true;
            await new Promise((r) => setTimeout(r, 500));
            break;
          }
        }
      } catch {
        // Try next
      }
    }
  }

  return dismissed;
}

/**
 * Run axe-core analysis on a page.
 */
async function runAxeAnalysis(page, tags) {
  const results = await new AxePuppeteer(page)
    .withTags(tags)
    .analyze();
  return results;
}

/**
 * Scan a single page in a single viewport at a single state.
 * Uses an isolated browser context.
 *
 * @param {import('puppeteer').Browser} browser
 * @param {string} url
 * @param {object} viewport - { width, height }
 * @param {string[]} tags - WCAG tags to test
 * @param {number} timeout
 * @param {boolean} dismissOverlays - whether to dismiss popups before scanning
 * @returns {Promise<{results: object, screenshot: object|null, state: string}>}
 */
async function scanPageState(browser, url, viewport, tags, timeout, dismissOverlays) {
  const context = await browser.createBrowserContext();
  let screenshot = null;

  try {
    const page = await context.newPage();
    await page.setBypassCSP(true);
    await page.setViewport(viewport);

    await loadPageDefensively(page, url, timeout);

    if (dismissOverlays) {
      await tryDismissOverlays(page);
      // Wait for DOM to settle after dismissal
      await new Promise((r) => setTimeout(r, 500));
    }

    const results = await runAxeAnalysis(page, tags);

    // Capture screenshot while page is still open (only for pages with violations)
    if (results.violations && results.violations.length > 0) {
      screenshot = await captureAnnotatedScreenshot(page, results.violations);
    }

    return {
      results,
      screenshot,
      state: dismissOverlays ? 'after-dismissal' : 'with-overlays',
    };
  } finally {
    await context.close();
  }
}

/**
 * Merge violation arrays from two scan states, deduplicating by rule ID + node target.
 * Tags violations with their source state.
 */
function mergeViolations(withOverlays, afterDismissal) {
  const merged = new Map();

  // Add all from state 1 (with overlays)
  for (const v of (withOverlays || [])) {
    const key = v.id;
    if (!merged.has(key)) {
      merged.set(key, { ...v, _source: 'overlay', nodes: [...v.nodes] });
    }
  }

  // Merge state 2 (after dismissal)
  for (const v of (afterDismissal || [])) {
    const key = v.id;
    if (merged.has(key)) {
      // Add new nodes not already present
      const existing = merged.get(key);
      const existingTargets = new Set(existing.nodes.map((n) => JSON.stringify(n.target)));
      for (const node of v.nodes) {
        if (!existingTargets.has(JSON.stringify(node.target))) {
          existing.nodes.push(node);
        }
      }
    } else {
      merged.set(key, { ...v, _source: 'page', nodes: [...v.nodes] });
    }
  }

  return Array.from(merged.values());
}

/**
 * Scan a single page at both viewports with pop-up handling.
 *
 * @param {import('puppeteer').Browser} browser
 * @param {string} url
 * @param {object} options
 * @returns {Promise<object>} Per-page scan result
 */
async function scanPage(browser, url, options = {}) {
  const {
    tags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'],
    timeout = 30000,
  } = options;

  const pageResult = {
    url,
    desktop: { violations: [], passes: [], incomplete: [], inapplicable: [], screenshot: null },
    mobile: { violations: [], passes: [], incomplete: [], inapplicable: [], screenshot: null },
    combined: { violations: [], passes: [], incomplete: [], inapplicable: [] },
  };

  // --- Desktop scans ---
  try {
    // State 1: With overlays
    const desktopState1 = await scanPageState(browser, url, VIEWPORTS.desktop, tags, timeout, false);
    // State 2: After dismissal
    const desktopState2 = await scanPageState(browser, url, VIEWPORTS.desktop, tags, timeout, true);

    pageResult.desktop.violations = mergeViolations(
      desktopState1.results.violations,
      desktopState2.results.violations
    );
    pageResult.desktop.passes = desktopState2.results.passes || [];
    pageResult.desktop.incomplete = desktopState2.results.incomplete || [];
    pageResult.desktop.inapplicable = desktopState2.results.inapplicable || [];
    // Use after-dismissal screenshot (more useful — shows the real page)
    pageResult.desktop.screenshot = desktopState2.screenshot || desktopState1.screenshot;
    pageResult.desktop.testEngine = desktopState2.results.testEngine;
    pageResult.desktop.testEnvironment = desktopState2.results.testEnvironment;
  } catch (err) {
    console.warn(`  Warning: Desktop scan failed for ${url}: ${err.message}`);
  }

  // --- Mobile scans ---
  try {
    const mobileState1 = await scanPageState(browser, url, VIEWPORTS.mobile, tags, timeout, false);
    const mobileState2 = await scanPageState(browser, url, VIEWPORTS.mobile, tags, timeout, true);

    pageResult.mobile.violations = mergeViolations(
      mobileState1.results.violations,
      mobileState2.results.violations
    );
    pageResult.mobile.passes = mobileState2.results.passes || [];
    pageResult.mobile.incomplete = mobileState2.results.incomplete || [];
    pageResult.mobile.inapplicable = mobileState2.results.inapplicable || [];
    pageResult.mobile.screenshot = mobileState2.screenshot || mobileState1.screenshot;
  } catch (err) {
    console.warn(`  Warning: Mobile scan failed for ${url}: ${err.message}`);
  }

  // --- Combine results with viewport tagging ---
  pageResult.combined = combineViewportResults(pageResult.desktop, pageResult.mobile);

  return pageResult;
}

/**
 * Combine desktop and mobile results, tagging each violation with its viewport(s).
 */
function combineViewportResults(desktop, mobile) {
  const desktopRuleIds = new Set(desktop.violations.map((v) => v.id));
  const mobileRuleIds = new Set(mobile.violations.map((v) => v.id));

  const combined = new Map();

  for (const v of desktop.violations) {
    const viewport = mobileRuleIds.has(v.id) ? 'both' : 'desktop-only';
    combined.set(v.id, { ...v, _viewport: viewport });
  }

  for (const v of mobile.violations) {
    if (combined.has(v.id)) {
      // Already added from desktop — merge mobile-specific nodes
      const existing = combined.get(v.id);
      const existingTargets = new Set(existing.nodes.map((n) => JSON.stringify(n.target)));
      for (const node of v.nodes) {
        if (!existingTargets.has(JSON.stringify(node.target))) {
          existing.nodes.push({ ...node, _viewport: 'mobile' });
        }
      }
    } else {
      combined.set(v.id, { ...v, _viewport: 'mobile-only' });
    }
  }

  // Combine passes (union)
  const passMap = new Map();
  for (const p of [...desktop.passes, ...mobile.passes]) {
    if (!passMap.has(p.id)) passMap.set(p.id, p);
  }

  // Combine incomplete (union)
  const incompleteMap = new Map();
  for (const i of [...desktop.incomplete, ...mobile.incomplete]) {
    if (!incompleteMap.has(i.id)) incompleteMap.set(i.id, i);
  }

  return {
    violations: Array.from(combined.values()),
    passes: Array.from(passMap.values()),
    incomplete: Array.from(incompleteMap.values()),
    inapplicable: desktop.inapplicable, // Same rules apply regardless of viewport
  };
}

/**
 * Scan all discovered pages.
 *
 * @param {string[]} urls - Array of URLs to scan
 * @param {object} options - Scan options
 * @returns {Promise<object>} Full scan result
 */
async function scanAllPages(urls, options = {}) {
  const {
    tags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'],
    timeout = 30000,
    onProgress = null,
  } = options;

  const emit = (data) => {
    if (typeof onProgress === 'function') onProgress(data);
  };

  emit({ phase: 'launching', message: 'Launching browser...' });

  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
    ],
  });

  const pageResults = [];

  try {
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      console.log(`  Scanning page ${i + 1}/${urls.length}: ${url}`);
      emit({ phase: 'scanning', current: i + 1, total: urls.length, url, message: `Scanning page ${i + 1}/${urls.length}: ${url}` });

      try {
        const result = await scanPage(browser, url, { tags, timeout });
        pageResults.push(result);
        emit({ phase: 'page-done', current: i + 1, total: urls.length, url, violations: result.combined.violations.length });
      } catch (err) {
        console.warn(`  Error scanning ${url}: ${err.message}`);
        emit({ phase: 'page-error', current: i + 1, total: urls.length, url, error: err.message });
        pageResults.push({
          url,
          error: err.message,
          desktop: { violations: [], passes: [], incomplete: [], inapplicable: [], screenshot: null },
          mobile: { violations: [], passes: [], incomplete: [], inapplicable: [], screenshot: null },
          combined: { violations: [], passes: [], incomplete: [], inapplicable: [] },
        });
      }
    }
  } finally {
    await browser.close();
  }

  emit({ phase: 'aggregating', message: 'Aggregating results...' });

  // Build aggregate result
  const scanDate = new Date().toISOString();
  const testEngine = pageResults.find((r) => r.desktop?.testEngine)?.desktop?.testEngine;

  return {
    url: urls[0],
    scannedUrls: urls,
    scanDate,
    toolVersion: `AutoADA 1.0.0 / axe-core ${testEngine?.version || 'unknown'}`,
    testEngine,
    wcagTags: tags,
    pageCount: urls.length,
    pages: pageResults,
    // Aggregate combined violations across all pages
    allViolations: aggregateViolations(pageResults),
    allPasses: aggregatePasses(pageResults),
    allIncomplete: aggregateIncomplete(pageResults),
  };
}

/**
 * Aggregate violations across all pages, merging by rule ID.
 */
function aggregateViolations(pageResults) {
  const ruleMap = new Map();

  for (const page of pageResults) {
    for (const v of (page.combined?.violations || [])) {
      if (ruleMap.has(v.id)) {
        const existing = ruleMap.get(v.id);
        existing.nodes.push(...v.nodes.map((n) => ({ ...n, _pageUrl: page.url })));
        existing._pageUrls.add(page.url);
      } else {
        ruleMap.set(v.id, {
          ...v,
          nodes: v.nodes.map((n) => ({ ...n, _pageUrl: page.url })),
          _pageUrls: new Set([page.url]),
        });
      }
    }
  }

  // Convert Set to Array for serialization
  return Array.from(ruleMap.values()).map((v) => ({
    ...v,
    _pageUrls: Array.from(v._pageUrls),
    _affectedPages: v._pageUrls.size || v._pageUrls.length,
  }));
}

function aggregatePasses(pageResults) {
  const passMap = new Map();
  for (const page of pageResults) {
    for (const p of (page.combined?.passes || [])) {
      if (!passMap.has(p.id)) passMap.set(p.id, p);
    }
  }
  return Array.from(passMap.values());
}

function aggregateIncomplete(pageResults) {
  const incMap = new Map();
  for (const page of pageResults) {
    for (const i of (page.combined?.incomplete || [])) {
      if (!incMap.has(i.id)) incMap.set(i.id, i);
    }
  }
  return Array.from(incMap.values());
}

module.exports = { scanPage, scanAllPages };
