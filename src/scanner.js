/**
 * Scanner engine — per-page WCAG scanning with dual viewport + pop-up handling.
 * Uses isolated browser contexts and defensive page loading.
 *
 * Phase 2 improvements:
 * - Request interception: blocks non-essential resources (images, fonts, media)
 * - Optimized page loading: 2 page loads per URL (was 4) — scan then dismiss on same page
 * - Retry with exponential backoff: 2 retries with 2s/4s delays
 * - Smarter popup dismissal: verifies parent is modal/overlay before clicking
 */

const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { AxePuppeteer } = require('@axe-core/puppeteer');
const { captureAnnotatedScreenshot } = require('./screenshotter');
const { applyConfidenceScores } = require('./confidence');
const { verifyContrastItems } = require('./contrast-verify');

// Enable stealth mode to bypass bot detection (Cloudflare, etc.)
puppeteer.use(StealthPlugin());

// Debug logging — only outputs when AUTOADA_DEBUG=1
function debugLog(context, msg) {
  if (process.env.AUTOADA_DEBUG === '1') {
    console.log(`  [debug:${context}] ${msg}`);
  }
}

// Resource types to block during scanning (keeps scripts + stylesheets for axe-core)
// Note: 'image' is NOT blocked — needed for meaningful screenshots.
// Fonts/media/beacons are still blocked for speed.
const BLOCKED_RESOURCE_TYPES = new Set([
  'font', 'media', 'beacon', 'csp_report', 'ping', 'imageset',
]);

// Tracker/ad domains to block for faster, cleaner scans
const BLOCKED_DOMAINS = [
  'google-analytics.com', 'googletagmanager.com', 'doubleclick.net',
  'facebook.net', 'hotjar.com', 'analytics.', 'tracking.',
];

// Common dismiss/close selectors (prefer close/dismiss over accept)
const DISMISS_SELECTORS = [
  // ARIA-based close buttons
  '[aria-label*="close" i]',
  '[aria-label*="dismiss" i]',
  '[aria-label*="reject" i]',
  '[aria-label*="decline" i]',
  'button[aria-label*="deny" i]',
  // Generic close buttons
  'button[class*="close" i]',
  '.modal-close',
  '[data-dismiss]',
  // Klaviyo (Shopify email capture popups)
  '.klaviyo-close-form',
  '[aria-label="Close dialog"]',
  '[aria-label="Close form"]',
  'button.kl-private-close-button',
  '.klaviyo-popup .close',
  // Shopify popups
  '.popup-close',
  '.popup__close',
  '.modal__close',
  // Generic X/close buttons (SVG icons, etc.)
  'button[class*="dismiss" i]',
  '[data-action="close"]',
  '[data-close]',
  'button.close',
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

// Rate-limiting between page scans to avoid Cloudflare escalation
const INTER_PAGE_DELAY_MS = { min: 1000, max: 3000 };
const MAX_CONSECUTIVE_CF_FAILURES = 3;

/** @const {number} Maximum interactive elements to expand and scan (accordions, tabs, etc.) */
const MAX_INTERACTIVE_ELEMENTS = 10;

/** @const {number} Maximum Tab key presses for keyboard trap detection */
const MAX_TAB_PRESSES = 50;

/** @const {number} Consecutive same-element focus count that indicates a keyboard trap */
const KEYBOARD_TRAP_THRESHOLD = 3;

/** @const {number} Wait time (ms) after dismissing overlays before re-scanning */
const OVERLAY_DISMISS_WAIT_MS = 500;

/** @const {number} Maximum time (ms) to wait for Cloudflare challenge resolution */
const CHALLENGE_TIMEOUT_MS = 15000;

/** @const {number} Maximum time (ms) to wait for SPA framework hydration */
const FRAMEWORK_READY_TIMEOUT_MS = 8000;

/** @const {number} Duration (ms) of no DOM mutations that signals framework stability */
const DOM_STABILITY_WINDOW_MS = 1000;

/** @const {number} Timeout (ms) for best-effort network idle wait after page load */
const NETWORK_IDLE_TIMEOUT_MS = 5000;

/** @const {number} Fallback timeout (ms) for domcontentloaded when networkidle2 fails */
const FALLBACK_LOAD_TIMEOUT_MS = 15000;

function randomDelay(min, max) {
  return min + Math.random() * (max - min);
}

// ---------------------------------------------------------------------------
// Utility: retry with exponential backoff
// ---------------------------------------------------------------------------

/**
 * Retry an async function with exponential backoff.
 * @param {Function} fn - Async function to retry
 * @param {number} maxRetries - Maximum number of retries (default: 2)
 * @param {number} baseDelay - Base delay in ms (default: 2000)
 */
async function withRetry(fn, maxRetries = 2, baseDelay = 2000) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      // Don't retry non-transient errors (DNS failure, unreachable host, Cloudflare CAPTCHA)
      if (err.message && err.message.startsWith('Page unreachable:')) throw err;
      if (err.message && err.message.includes('Cloudflare escalated')) throw err;
      if (err.message && err.message.includes('Cloudflare challenge did not resolve')) throw err;
      if (attempt === maxRetries) throw err;
      const delay = baseDelay * Math.pow(2, attempt); // 2s, 4s
      console.warn(`    Retry ${attempt + 1}/${maxRetries} after ${delay}ms: ${err.message}`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
}

// ---------------------------------------------------------------------------
// Request interception
// ---------------------------------------------------------------------------

/**
 * Enable request interception on a page to block non-essential resources.
 * Blocks images, fonts, media, beacons, and known tracker domains.
 * Keeps scripts and stylesheets (needed by axe-core for computed styles).
 */
async function enableRequestInterception(page) {
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const resourceType = req.resourceType();
    const url = req.url();

    if (BLOCKED_RESOURCE_TYPES.has(resourceType)) {
      req.abort();
      return;
    }

    if (BLOCKED_DOMAINS.some((domain) => url.includes(domain))) {
      req.abort();
      return;
    }

    req.continue();
  });
}

// ---------------------------------------------------------------------------
// Defensive page loading
// ---------------------------------------------------------------------------

/**
 * Defensive page load strategy.
 * Doesn't rely solely on networkidle2 — uses a multi-step approach.
 */
async function loadPageDefensively(page, url, timeout = 30000) {
  let navigationFailed = false;

  // Step 1: Navigate with networkidle2 for better full-page loading
  try {
    await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout,
    });
  } catch (err1) {
    // networkidle2 timeout — fall back to domcontentloaded
    try {
      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: FALLBACK_LOAD_TIMEOUT_MS,
      });
    } catch (err2) {
      // Even domcontentloaded failed — flag for error page check
      navigationFailed = true;
      // If both attempts failed with net::ERR_NAME_NOT_RESOLVED or similar, throw immediately
      const msg = (err2.message || '') + ' ' + (err1.message || '');
      if (msg.includes('ERR_NAME_NOT_RESOLVED') || msg.includes('ERR_CONNECTION_REFUSED') ||
          msg.includes('ERR_CONNECTION_TIMED_OUT') || msg.includes('ERR_ADDRESS_UNREACHABLE') ||
          msg.includes('ERR_NETWORK_CHANGED') || msg.includes('ERR_INTERNET_DISCONNECTED')) {
        throw new Error(`Page unreachable: ${url} — ${err2.message}`);
      }
    }
  }

  // Step 1b: Detect browser error pages (chrome-error://, about:neterror, etc.)
  // When a domain is unreachable, the browser shows its own error page.
  // We must NOT scan that — it produces fake violations on the error UI.
  try {
    const pageUrl = page.url();
    if (pageUrl.startsWith('chrome-error://') || pageUrl === 'about:blank' || pageUrl === 'about:neterror') {
      throw new Error(`Page unreachable: ${url} — browser showed error page (${pageUrl})`);
    }
    // Also detect standard browser error pages by content
    const isErrorPage = await page.evaluate(() => {
      const title = (document.title || '').toLowerCase();
      const bodyText = (document.body?.innerText || '').toLowerCase().substring(0, 500);
      // Chrome: "site can't be reached", Firefox: "problem loading page", Safari: "can't find server"
      const errorPatterns = [
        "this site can't be reached",
        "this site can\u2019t be reached",
        "err_name_not_resolved",
        "err_connection_refused",
        "err_connection_timed_out",
        "err_address_unreachable",
        "dns_probe_finished_nxdomain",
        "problem loading page",
        "can't find the server",
        "server not found",
        "webpage is not available",
        "unable to connect",
      ];
      return errorPatterns.some((p) => title.includes(p) || bodyText.includes(p));
    });
    if (isErrorPage) {
      throw new Error(`Page unreachable: ${url} — browser displayed a network error page`);
    }
  } catch (err) {
    // Re-throw if it's our error, otherwise the page.evaluate() failed (acceptable)
    if (err.message.startsWith('Page unreachable:')) throw err;
  }

  // Step 2: Detect and wait for Cloudflare/bot challenge pages
  const challengeStatus = await waitForChallengeResolution(page);
  if (challengeStatus.escalated) {
    throw new Error('Cloudflare escalated to interactive CAPTCHA — page cannot be scanned automatically');
  }
  if (!challengeStatus.resolved && challengeStatus.type === 'timeout') {
    throw new Error('Cloudflare challenge did not resolve within timeout');
  }

  // Step 3: Smart framework hydration detection (DOM stability-based)
  await waitForFrameworkReady(page);

  // Step 4: Wait for key content selectors (best-effort, short timeout)
  try {
    await page.waitForSelector('body:not(:empty)', { timeout: 3000 });
  } catch (e) {
    debugLog('load', `body:not(:empty) wait failed: ${e.message}`);
  }

  try {
    await page.waitForSelector('main, #content, #main, [role="main"]', { timeout: 2000 });
  } catch (e) {
    debugLog('load', `No main content landmark found: ${e.message}`);
  }

  // Step 5: Best-effort network idle (don't fail if it never settles)
  try {
    await page.waitForNetworkIdle({ idleTime: 500, timeout: NETWORK_IDLE_TIMEOUT_MS });
  } catch (e) {
    debugLog('load', `Network never went idle: ${e.message}`);
  }

  // Step 6: Empty/blank page detection
  // Pages with almost no text and very few structural elements are likely
  // blank pages, API endpoints, or broken redirects. Flag them so reports
  // can indicate the scan result may be unreliable.
  try {
    const contentCheck = await page.evaluate(() => {
      const textLen = (document.body?.innerText || '').trim().length;
      const structuralCount = document.querySelectorAll('main, article, section, h1, h2, h3, p, a, nav, form').length;
      return { textLen, structuralCount };
    });
    if (contentCheck.textLen < 50 && contentCheck.structuralCount < 3) {
      page._emptyContent = true;
    }
  } catch (e) {
    debugLog('load', `Content check failed: ${e.message}`);
  }
}

/**
 * Detect Cloudflare/bot challenge pages and wait for them to resolve.
 * Cloudflare typically shows "Just a moment..." and auto-redirects once
 * the JS challenge passes. With the stealth plugin, this usually resolves
 * within 5-10 seconds.
 */
async function waitForChallengeResolution(page, maxWaitMs = CHALLENGE_TIMEOUT_MS) {
  const isChallengePage = async () => {
    try {
      return await page.evaluate(() => {
        const title = document.title.toLowerCase();
        const hasCfTitle = title.includes('just a moment') || title.includes('attention required');
        const hasCfDom = !!document.querySelector('#challenge-running, #challenge-form, .cf-browser-verification, #cf-wrapper, .cf-error-details');
        const metaRefresh = document.querySelector('meta[http-equiv="refresh"]');
        const hasCfMeta = metaRefresh && (metaRefresh.getAttribute('content') || '').includes('cdn-cgi');
        return hasCfTitle || hasCfDom || hasCfMeta;
      });
    } catch (e) {
      debugLog('challenge', `Challenge page check failed: ${e.message}`);
      return false;
    }
  };

  const isTurnstilePage = async () => {
    try {
      return await page.evaluate(() => {
        // Turnstile iframe
        if (document.querySelector('iframe[src*="challenges.cloudflare.com"]')) return true;
        // Turnstile widget containers
        if (document.querySelector('.cf-turnstile, #turnstile-wrapper, [data-sitekey]')) return true;
        // Interactive challenge checkbox
        if (document.querySelector('#challenge-stage input[type="checkbox"]')) return true;
        // "Verify you are human" text pattern
        const body = (document.body?.innerText || '').toLowerCase().substring(0, 1000);
        if (body.includes('verify you are human') || body.includes('verify that you are not a robot')) return true;
        return false;
      });
    } catch (e) {
      debugLog('challenge', `Turnstile check failed: ${e.message}`);
      return false;
    }
  };

  if (!(await isChallengePage())) return { resolved: true, escalated: false, type: 'none' };

  console.log('    [cloudflare] Challenge detected, waiting for resolution...');

  // Check for Turnstile immediately — if interactive, don't waste time waiting
  if (await isTurnstilePage()) {
    console.warn('    [cloudflare] Interactive Turnstile CAPTCHA detected — cannot auto-resolve');
    return { resolved: false, escalated: true, type: 'turnstile' };
  }

  const start = Date.now();

  while (Date.now() - start < maxWaitMs) {
    await new Promise((r) => setTimeout(r, 2000));

    try {
      if (!(await isChallengePage())) {
        const elapsed = ((Date.now() - start) / 1000).toFixed(1);
        console.log(`    [cloudflare] Challenge resolved in ${elapsed}s`);
        await new Promise((r) => setTimeout(r, 1000));
        return { resolved: true, escalated: false, type: 'js-challenge' };
      }

      // Re-check for escalation during wait
      if (await isTurnstilePage()) {
        console.warn('    [cloudflare] Escalated to interactive Turnstile during wait');
        return { resolved: false, escalated: true, type: 'turnstile' };
      }
    } catch (err) {
      debugLog('cloudflare', `Challenge check failed: ${err.message}`);
      // If page context was destroyed, challenge likely resolved via navigation
      if (err.message && (err.message.includes('Execution context') || err.message.includes('detached'))) {
        return { resolved: true, escalated: false, type: 'navigation' };
      }
    }
  }

  console.warn('    [cloudflare] Challenge did not resolve within timeout');
  return { resolved: false, escalated: false, type: 'timeout' };
}

/**
 * Wait for SPA frameworks to finish hydrating/rendering.
 * Uses MutationObserver to detect DOM stability (no changes for 1 second).
 * Falls back to a fixed 2s wait if detection fails.
 *
 * @param {import('puppeteer').Page} page
 * @param {number} maxWaitMs - Maximum wait time (default 8s)
 */
async function waitForFrameworkReady(page, maxWaitMs = FRAMEWORK_READY_TIMEOUT_MS) {
  try {
    // Detect framework for logging
    const framework = await page.evaluate(() => {
      if (window.__NEXT_DATA__) return 'nextjs';
      if (document.querySelector('[data-reactroot]') || document.querySelector('#__next')) return 'react';
      if (document.querySelector('[data-v-]') || window.__VUE__) return 'vue';
      if (document.querySelector('[ng-version]') || document.querySelector('app-root')) return 'angular';
      return null;
    });

    if (framework) {
      console.log(`    [framework] Detected: ${framework}`);
    }

    // Wait for DOM stability: resolve when no mutations for 1 second
    // Wrap in Promise.race to prevent page.evaluate() from hanging if page JS freezes
    await Promise.race([
      new Promise((r) => setTimeout(r, maxWaitMs + 2000)), // hard outer timeout
      page.evaluate((maxWait) => {
      return new Promise((resolve) => {
        let timer = null;
        let settled = false;
        const STABILITY_WINDOW = 1000; // DOM_STABILITY_WINDOW_MS — inside browser context

        const observer = new MutationObserver(() => {
          if (timer) clearTimeout(timer);
          timer = setTimeout(() => {
            settled = true;
            observer.disconnect();
            resolve();
          }, STABILITY_WINDOW);
        });

        observer.observe(document.body || document.documentElement, {
          childList: true,
          subtree: true,
          attributes: true,
        });

        // Initial timer — if no mutations at all, DOM is already stable
        timer = setTimeout(() => {
          if (!settled) {
            observer.disconnect();
            resolve();
          }
        }, STABILITY_WINDOW);

        // Hard timeout — never wait longer than maxWait
        setTimeout(() => {
          if (!settled) {
            observer.disconnect();
            resolve();
          }
        }, maxWait);
      });
    }, maxWaitMs),
    ]);
  } catch (e) {
    debugLog('framework', `Framework detection failed, using 2s fallback: ${e.message}`);
    await new Promise((r) => setTimeout(r, 2000));
  }
}

// ---------------------------------------------------------------------------
// Popup / overlay dismissal (smarter: checks ancestor is modal/overlay)
// ---------------------------------------------------------------------------

/**
 * Check if a button element is inside a modal/overlay/popup container.
 * This prevents accidentally clicking dismiss buttons in regular page content.
 */
async function isInOverlayContainer(page, btn) {
  try {
    return await page.evaluate((el) => {
      let parent = el.parentElement;
      while (parent && parent !== document.body) {
        const style = window.getComputedStyle(parent);
        const role = parent.getAttribute('role');
        const tagName = parent.tagName.toLowerCase();
        const classList = parent.classList ? parent.classList.toString() : '';

        const isOverlay =
          // ARIA dialog roles
          role === 'dialog' || role === 'alertdialog' ||
          // HTML dialog element
          tagName === 'dialog' ||
          // Common overlay class names
          /modal|overlay|popup|cookie|consent|banner|dialog|drawer|lightbox/i.test(classList) ||
          // Common overlay ID patterns
          (parent.id && /modal|overlay|popup|cookie|consent|banner|dialog/i.test(parent.id)) ||
          // Fixed/absolute positioned elements with high z-index (common for overlays)
          (style.position === 'fixed' && parseInt(style.zIndex, 10) > 10) ||
          (style.position === 'absolute' && parseInt(style.zIndex, 10) > 100);

        if (isOverlay) return true;
        parent = parent.parentElement;
      }
      return false;
    }, btn);
  } catch (e) {
    debugLog('overlay', `Overlay container check failed: ${e.message}`);
    return false;
  }
}

/**
 * Try to dismiss overlays/popups on the page.
 * Uses a multi-strategy approach:
 * 1. Click known dismiss/close selectors (checks overlay container)
 * 2. Click known dismiss selectors (relaxed — skip overlay check for framework-specific selectors)
 * 3. Click accept/cookie selectors (fallback)
 * 4. Force-remove any remaining fixed overlays via DOM manipulation
 * Returns true if something was dismissed.
 */
async function tryDismissOverlays(page) {
  let dismissed = false;

  // Strategy 1: Try dismiss/close selectors with overlay container check
  for (const selector of DISMISS_SELECTORS) {
    try {
      const buttons = await page.$$(selector);
      for (const btn of buttons) {
        const isVisible = await page.evaluate((el) => {
          const style = window.getComputedStyle(el);
          return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0'
            && el.offsetWidth > 0 && el.offsetHeight > 0;
        }, btn);
        if (!isVisible) continue;
        const inOverlay = await isInOverlayContainer(page, btn);
        if (inOverlay) {
          await btn.click();
          dismissed = true;
          await new Promise((r) => setTimeout(r, OVERLAY_DISMISS_WAIT_MS));
          break;
        }
      }
      if (dismissed) break;
    } catch (e) {
      debugLog('overlay', `Strategy 1 selector failed: ${e.message}`);
    }
  }

  // Strategy 2: Relaxed — try dismiss selectors WITHOUT overlay check
  // (for framework popups like Klaviyo that use shadow DOM or non-standard containers)
  if (!dismissed) {
    for (const selector of DISMISS_SELECTORS) {
      try {
        const buttons = await page.$$(selector);
        for (const btn of buttons) {
          const isVisible = await page.evaluate((el) => {
            const style = window.getComputedStyle(el);
            return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0'
              && el.offsetWidth > 0 && el.offsetHeight > 0;
          }, btn);
          if (isVisible) {
            await btn.click();
            dismissed = true;
            await new Promise((r) => setTimeout(r, OVERLAY_DISMISS_WAIT_MS));
            break;
          }
        }
        if (dismissed) break;
      } catch (e) {
        debugLog('overlay', `Strategy 2 selector failed: ${e.message}`);
      }
    }
  }

  // Strategy 3: Accept/cookie selectors (fallback)
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
            await new Promise((r) => setTimeout(r, OVERLAY_DISMISS_WAIT_MS));
            break;
          }
        }
      } catch (e) {
        debugLog('overlay', `Strategy 3 selector failed: ${e.message}`);
      }
    }
  }

  // Strategy 4: Force-remove any remaining fixed/modal overlays via DOM
  // This catches popups that resist clicking (Klaviyo, Privy, Justuno, etc.)
  try {
    const removedCount = await page.evaluate(() => {
      let removed = 0;
      const allElements = document.querySelectorAll('*');
      for (const el of allElements) {
        const style = window.getComputedStyle(el);
        const zIndex = parseInt(style.zIndex, 10) || 0;
        const isFixed = style.position === 'fixed';
        const classList = el.classList ? el.classList.toString().toLowerCase() : '';
        const id = (el.id || '').toLowerCase();

        // Detect overlay/popup containers: fixed position with high z-index
        // or known popup class/id patterns
        const isPopup =
          (isFixed && zIndex > 999) ||
          /klaviyo|privy|justuno|popup|modal|overlay|lightbox/.test(classList) ||
          /klaviyo|privy|justuno|popup|modal|overlay/.test(id);

        if (isPopup && el.offsetWidth > 0 && el.offsetHeight > 0) {
          // Don't remove navigation bars, headers, or small elements
          const rect = el.getBoundingClientRect();
          const coversSignificantArea = rect.width > 200 && rect.height > 200;
          if (coversSignificantArea) {
            el.remove();
            removed++;
          }
        }
      }
      return removed;
    });
    if (removedCount > 0) {
      dismissed = true;
      await new Promise((r) => setTimeout(r, 300));
    }
  } catch (e) {
    debugLog('overlay', `Strategy 4 DOM removal failed: ${e.message}`);
  }

  return dismissed;
}

// ---------------------------------------------------------------------------
// axe-core analysis
// ---------------------------------------------------------------------------

/**
 * Run axe-core analysis on a page.
 * @param {import('puppeteer').Page} page
 * @param {string[]} tags - WCAG tags to test
 * @param {object} [axeConfig] - Optional axe-core configuration
 */
async function runAxeAnalysis(page, tags, axeConfig = {}) {
  let builder = new AxePuppeteer(page).withTags(tags);

  // Apply optional axe-core configuration
  if (axeConfig.disableRules && axeConfig.disableRules.length) {
    builder = builder.disableRules(axeConfig.disableRules);
  }
  if (axeConfig.include) {
    builder = builder.include(axeConfig.include);
  }
  if (axeConfig.exclude) {
    builder = builder.exclude(axeConfig.exclude);
  }

  const results = await builder.analyze();
  return results;
}

// ---------------------------------------------------------------------------
// Violation merging
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Interactive state scanning (accordions, tabs, details/summary)
// ---------------------------------------------------------------------------

/**
 * Scan interactive states by expanding collapsed content and re-scanning.
 * Finds violations hidden inside accordions, tabs, details, and expandable regions.
 *
 * @param {import('puppeteer').Page} page
 * @param {string[]} tags - WCAG tags to test
 * @param {object} axeConfig - Optional axe-core configuration
 * @returns {Promise<Array>} Additional violations found in expanded states
 */
async function scanInteractiveStates(page, tags, axeConfig = {}) {
  const MAX_INTERACTIONS = MAX_INTERACTIVE_ELEMENTS;
  const additionalViolations = [];

  // Selectors for collapsed/expandable elements
  const interactiveSelectors = [
    '[aria-expanded="false"]',
    'details:not([open])',
    '[role="tab"][aria-selected="false"]',
    'button[data-toggle]:not(.active)',
    '[role="button"][aria-expanded="false"]',
  ];

  try {
    // Find all expandable elements (up to MAX_INTERACTIONS)
    const elements = await page.evaluate((selectors, max) => {
      const found = [];
      for (const selector of selectors) {
        const els = document.querySelectorAll(selector);
        for (const el of els) {
          if (found.length >= max) break;
          const rect = el.getBoundingClientRect();
          const style = window.getComputedStyle(el);
          // Only include visible, interactable elements
          if (rect.width > 0 && rect.height > 0 &&
              style.display !== 'none' && style.visibility !== 'hidden') {
            // Generate a unique selector path for this element
            let path = el.tagName.toLowerCase();
            if (el.id) path = `#${el.id}`;
            else if (el.className && typeof el.className === 'string') {
              path += '.' + el.className.trim().split(/\s+/).join('.');
            }
            found.push({ selector: path, index: found.length });
          }
        }
        if (found.length >= max) break;
      }
      return found;
    }, interactiveSelectors, MAX_INTERACTIONS);

    if (elements.length === 0) return [];

    console.log(`    [interactive] Found ${elements.length} expandable element(s), scanning...`);

    // Click each element and scan for new violations
    for (const elem of elements) {
      try {
        // Try to click the element
        const handle = await page.$(elem.selector);
        if (!handle) continue;

        await handle.click();
        await new Promise((r) => setTimeout(r, OVERLAY_DISMISS_WAIT_MS)); // Wait for animation/expansion

        // Re-scan after expansion
        const results = await runAxeAnalysis(page, tags, axeConfig);

        // Collect new violations and tag them
        for (const v of (results.violations || [])) {
          v._source = 'interactive';
          v._expandedFrom = elem.selector;
          additionalViolations.push(v);
        }
      } catch (e) {
        debugLog('interactive', `Failed to expand/scan element: ${e.message}`);
        // Element not clickable or scan failed — skip
      }
    }
  } catch (err) {
    console.warn(`    [interactive] Error during interactive scanning: ${err.message}`);
  }

  return additionalViolations;
}

// ---------------------------------------------------------------------------
// Keyboard trap detection — behavioral test using real Tab key presses
// ---------------------------------------------------------------------------

/**
 * Detect keyboard traps by programmatically tabbing through the page.
 * If the same element receives focus 3+ times consecutively, it's a trap.
 * This catches real usability barriers that axe-core's static analysis misses.
 *
 * @param {import('puppeteer').Page} page
 * @returns {Promise<Array>} Array of keyboard trap violations (axe-core format)
 */
async function detectKeyboardTraps(page) {
  const MAX_TABS = MAX_TAB_PRESSES;
  const TRAP_THRESHOLD = KEYBOARD_TRAP_THRESHOLD;

  try {
    // Click body to reset focus to start of page
    await page.click('body').catch(() => {});
    await new Promise((r) => setTimeout(r, 100));

    const traps = [];
    let consecutiveSame = 0;
    let lastKey = null; // unique key = selector + position (distinguishes same-class elements)
    let lastInfo = null;
    const uniqueElements = new Set(); // Track unique elements seen during tabbing

    for (let i = 0; i < MAX_TABS; i++) {
      // Wrap each Tab cycle in try/catch — on some pages, Tab causes navigation
      // (e.g., clicking a link via Enter after Tab), which destroys the
      // execution context. We abort gracefully instead of crashing.
      let focusInfo;
      try {
        await page.keyboard.press('Tab');
        focusInfo = await page.evaluate(() => {
          const el = document.activeElement;
          if (!el || el === document.body || el === document.documentElement) {
            return null;
          }
          let selector = el.tagName.toLowerCase();
          if (el.id) selector = '#' + el.id;
          else if (el.className && typeof el.className === 'string' && el.className.trim()) {
            selector += '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.');
          }
          // Use absolute page position (not viewport-relative) to uniquely identify
          // the element. Viewport-relative coords change as the browser auto-scrolls
          // to focused elements, making different elements look like the same one.
          const rect = el.getBoundingClientRect();
          const absTop = Math.round(rect.top + window.scrollY);
          const absLeft = Math.round(rect.left + window.scrollX);
          const posKey = `${absTop}:${absLeft}`;
          return {
            selector,
            posKey,
            uniqueKey: selector + '@' + posKey,
            html: el.outerHTML.substring(0, 250),
          };
        });
      } catch (tabErr) {
        // Execution context destroyed (page navigated) or other fatal error.
        // Abort trap detection — no trap was found before navigation.
        const msg = tabErr.message || '';
        if (msg.includes('Execution context') || msg.includes('detached') ||
            msg.includes('Target closed') || msg.includes('Session closed')) {
          console.warn('    [keyboard-trap] Page navigated during Tab cycling — aborting detection');
          return [];
        }
        // For other errors, just skip this Tab iteration
        continue;
      }

      const currentKey = focusInfo?.uniqueKey || null;

      if (currentKey) uniqueElements.add(currentKey);

      // A real keyboard trap: focus STAYS on the exact same element (same
      // selector AND same position) for consecutive Tab presses. Normal page
      // cycling moves focus to different elements even if they share the same
      // CSS class — their positions differ.
      if (currentKey && currentKey === lastKey) {
        consecutiveSame++;
        lastInfo = focusInfo;
        // Only declare trap if we've seen enough unique elements before it
        // (pages with very few focusable elements can falsely trigger)
        if (consecutiveSame >= TRAP_THRESHOLD && uniqueElements.size >= 3) {
          traps.push(focusInfo);
          break;
        }
      } else {
        consecutiveSame = currentKey ? 1 : 0;
        lastKey = currentKey;
        lastInfo = focusInfo;
      }
    }

    if (traps.length === 0) return [];

    // Verify trap: try Shift+Tab to see if focus escapes. A real trap holds
    // focus even with Shift+Tab. If focus moves, it's a normal page wrap.
    const verified = [];
    for (const trap of traps) {
      try {
        await page.keyboard.down('Shift');
        await page.keyboard.press('Tab');
        await page.keyboard.up('Shift');
        const afterShift = await page.evaluate(() => {
          const el = document.activeElement;
          if (!el || el === document.body || el === document.documentElement) return null;
          const rect = el.getBoundingClientRect();
          const absTop = Math.round(rect.top + window.scrollY);
          const absLeft = Math.round(rect.left + window.scrollX);
          let sel = el.tagName.toLowerCase();
          if (el.id) sel = '#' + el.id;
          else if (el.className && typeof el.className === 'string' && el.className.trim()) {
            sel += '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.');
          }
          return sel + '@' + absTop + ':' + absLeft;
        });
        // If Shift+Tab moves focus to a different element, it's NOT a real trap
        if (afterShift && afterShift === trap.uniqueKey) {
          verified.push(trap);
        }
      } catch (shiftErr) {
        // Context destroyed during verification — page navigated away.
        // Can't verify, so don't report this trap (avoid false positive).
        console.warn('    [keyboard-trap] Page context lost during Shift+Tab verification — skipping');
      }
    }

    if (verified.length === 0) return [];

    console.log(`    [keyboard-trap] Detected ${verified.length} keyboard trap(s)`);

    return [{
      id: 'autoada-keyboard-trap',
      impact: 'critical',
      help: 'Keyboard focus is trapped and cannot escape using Tab',
      description: 'A keyboard trap was detected where Tab focus stays on the same element without progressing. Users who rely on keyboard navigation cannot move past this point.',
      tags: ['wcag2a', 'wcag211', 'cat.keyboard'],
      helpUrl: 'https://www.w3.org/WAI/WCAG22/Understanding/no-keyboard-trap.html',
      _source: 'autoada-custom',
      _confidence: 'high',
      nodes: verified.map((t) => ({
        target: [t.selector],
        html: t.html,
        impact: 'critical',
        failureSummary: `Focus trapped at ${t.selector}. Ensure Tab and Shift+Tab move focus normally through all interactive elements.`,
      })),
    }];
  } catch (err) {
    console.warn(`    [keyboard-trap] Detection failed: ${err.message}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// Optimized per-viewport scanning (loads page ONCE, scans twice)
// ---------------------------------------------------------------------------

/**
 * Scan a single page at a single viewport. Loads the page once, runs axe,
 * then dismisses overlays and re-runs axe on the same page.
 * This replaces the old approach of loading the page 4 times per URL.
 *
 * @param {import('puppeteer').Browser} browser
 * @param {string} url
 * @param {object} viewport - { width, height }
 * @param {string[]} tags - WCAG tags to test
 * @param {number} timeout
 * @param {object} [axeConfig] - Optional axe-core configuration
 * @param {boolean} [interactive=false] - Scan interactive states
 * @returns {Promise<object>} viewport scan result
 */
async function scanViewport(browser, url, viewport, tags, timeout, axeConfig = {}, interactive = false, skipScreenshot = false) {
  // Use default browser context (NOT isolated) so Cloudflare clearance cookies persist
  // across pages on the same domain — prevents re-triggering challenges on every page.
  let page;
  try {
    page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
    await enableRequestInterception(page);
    await page.setBypassCSP(true);
    await page.setViewport(viewport);

    await loadPageDefensively(page, url, timeout);

    // State 1: Scan with overlays present
    const results1 = await runAxeAnalysis(page, tags, axeConfig);

    // State 2: Dismiss overlays on the SAME page, then re-scan
    await tryDismissOverlays(page);
    await new Promise((r) => setTimeout(r, OVERLAY_DISMISS_WAIT_MS));
    const results2 = await runAxeAnalysis(page, tags, axeConfig);

    // Merge violations from both states
    let violations = mergeViolations(results1.violations, results2.violations);

    // Interactive state scanning (accordions, tabs, details)
    if (interactive) {
      const interactiveViolations = await scanInteractiveStates(page, tags, axeConfig);
      if (interactiveViolations.length > 0) {
        violations = mergeViolations(violations, interactiveViolations);
      }
    }

    // Keyboard trap detection (always enabled — catches critical usability issues)
    const keyboardTraps = await detectKeyboardTraps(page);
    if (keyboardTraps.length > 0) {
      violations = mergeViolations(violations, keyboardTraps);
    }

    // Capture screenshot after dismissal (more useful — shows the real page)
    // Skip screenshots for pages beyond the limit to save memory on large scans
    let screenshot = null;
    if (violations.length > 0 && !skipScreenshot) {
      screenshot = await captureAnnotatedScreenshot(page, violations);
    }

    // Phase 15: Verify color-contrast incomplete items while page is still open
    const incomplete = results2.incomplete || [];
    const contrastIncomplete = incomplete.filter((i) => i.id === 'color-contrast');
    let _contrastVerified = null;
    if (contrastIncomplete.length > 0) {
      try {
        _contrastVerified = await verifyContrastItems(page, contrastIncomplete);
        const nodeCount = _contrastVerified.reduce((n, v) => n + (v.nodes ? v.nodes.length : 0), 0);
        debugLog('contrast', 'Verified ' + nodeCount + ' color-contrast elements');
      } catch (err) {
        debugLog('contrast', 'Contrast verification failed: ' + err.message);
      }
    }

    return {
      violations,
      passes: results2.passes || [],
      incomplete,
      inapplicable: results2.inapplicable || [],
      screenshot,
      testEngine: results2.testEngine,
      testEnvironment: results2.testEnvironment,
      _emptyContent: !!page._emptyContent,
      _contrastVerified,
    };
  } finally {
    if (page) {
      try { await page.close(); } catch (e) { debugLog('scan', `Page close failed: ${e.message}`); }
    }
  }
}

// ---------------------------------------------------------------------------
// Per-page scanning (dual viewport)
// ---------------------------------------------------------------------------

/**
 * Scan a single page at both viewports with pop-up handling and retry logic.
 *
 * @param {import('puppeteer').Browser} browser
 * @param {string} url
 * @param {object} options
 * @returns {Promise<object>} Per-page scan result
 */
/** Overall timeout for a single page scan (desktop + mobile) — prevents indefinite hangs */
const SCAN_PAGE_TIMEOUT_MS = 120000; // 2 minutes

async function scanPage(browser, url, options = {}) {
  const {
    tags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'],
    timeout = 30000,
    axeConfig = {},
    interactive = false,
    skipScreenshot = false,
  } = options;

  const emptyResult = {
    url,
    error: null,
    desktop: { violations: [], passes: [], incomplete: [], inapplicable: [], screenshot: null },
    mobile: { violations: [], passes: [], incomplete: [], inapplicable: [], screenshot: null },
    combined: { violations: [], passes: [], incomplete: [], inapplicable: [] },
  };

  // Wrap entire page scan in overall timeout to prevent indefinite hangs
  const scanPromise = (async () => {
    const pageResult = { ...emptyResult, error: null };

    // --- Desktop scan (with retry) ---
    let desktopError = null;
    try {
      const desktopResult = await withRetry(
        () => scanViewport(browser, url, VIEWPORTS.desktop, tags, timeout, axeConfig, interactive, skipScreenshot)
      );
      pageResult.desktop.violations = desktopResult.violations;
      pageResult.desktop.passes = desktopResult.passes;
      pageResult.desktop.incomplete = desktopResult.incomplete;
      pageResult.desktop.inapplicable = desktopResult.inapplicable;
      pageResult.desktop.screenshot = desktopResult.screenshot;
      pageResult.desktop.testEngine = desktopResult.testEngine;
      pageResult.desktop.testEnvironment = desktopResult.testEnvironment;
      if (desktopResult._emptyContent) pageResult._emptyContent = true;
    } catch (err) {
      desktopError = err.message;
      console.warn(`  Warning: Desktop scan failed for ${url}: ${err.message}`);
    }

    // --- Mobile scan (with retry) ---
    let mobileError = null;
    try {
      const mobileResult = await withRetry(
        () => scanViewport(browser, url, VIEWPORTS.mobile, tags, timeout, axeConfig, interactive, skipScreenshot)
      );
      pageResult.mobile.violations = mobileResult.violations;
      pageResult.mobile.passes = mobileResult.passes;
      pageResult.mobile.incomplete = mobileResult.incomplete;
      pageResult.mobile.inapplicable = mobileResult.inapplicable;
      pageResult.mobile.screenshot = mobileResult.screenshot;
    } catch (err) {
      mobileError = err.message;
      console.warn(`  Warning: Mobile scan failed for ${url}: ${err.message}`);
    }

    // If both viewports failed, mark the page as errored
    if (desktopError && mobileError) {
      pageResult.error = desktopError;
    }

    // --- Combine results with viewport tagging ---
    pageResult.combined = combineViewportResults(pageResult.desktop, pageResult.mobile);

    return pageResult;
  })();

  const timeoutPromise = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Page scan timed out after ${SCAN_PAGE_TIMEOUT_MS / 1000}s`)), SCAN_PAGE_TIMEOUT_MS)
  );

  try {
    return await Promise.race([scanPromise, timeoutPromise]);
  } catch (err) {
    console.warn(`  Warning: Page scan timed out for ${url}: ${err.message}`);
    emptyResult.error = err.message;
    return emptyResult;
  }
}

// ---------------------------------------------------------------------------
// Viewport result combination
// ---------------------------------------------------------------------------

/**
 * Combine desktop and mobile results, tagging each violation with its viewport(s).
 */
function combineViewportResults(desktop, mobile) {
  const desktopRuleIds = new Set(desktop.violations.map((v) => v.id));
  const mobileRuleIds = new Set(mobile.violations.map((v) => v.id));

  const combined = new Map();

  for (const v of desktop.violations) {
    const viewport = mobileRuleIds.has(v.id) ? 'both' : 'desktop-only';
    const taggedNodes = v.nodes.map((n) => ({ ...n, _viewport: 'desktop' }));
    combined.set(v.id, { ...v, _viewport: viewport, nodes: taggedNodes });
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

  // Propagate contrast verification from desktop (primary) or mobile fallback
  const contrastVerified = desktop._contrastVerified || mobile._contrastVerified || null;

  return {
    violations: Array.from(combined.values()),
    passes: Array.from(passMap.values()),
    incomplete: Array.from(incompleteMap.values()),
    inapplicable: desktop.inapplicable, // Same rules apply regardless of viewport
    _contrastVerified: contrastVerified,
  };
}

// ---------------------------------------------------------------------------
// Multi-page scanning
// ---------------------------------------------------------------------------

/**
 * Scan all discovered pages.
 *
 * @param {string[]} urls - Array of URLs to scan
 * @param {object} options - Scan options
 * @returns {Promise<object>} Full scan result
 */
async function scanAllPages(urls, options = {}) {
  const {
    tags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'],
    timeout = 30000,
    axeConfig = {},
    interactive = false,
    concurrency = 1,
    onProgress = null,
    maxScreenshotPages = Infinity,
  } = options;

  const emit = (data) => {
    if (typeof onProgress === 'function') onProgress(data);
  };

  emit({ phase: 'launching', message: 'Launching browser...' });

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
      ],
    });
  } catch (launchErr) {
    const msg = launchErr.message || 'Unknown browser launch error';
    const isPathError = msg.includes('ENOENT') || msg.includes('EACCES') || msg.includes('spawn') || msg.includes('executable');
    const isSandboxError = msg.includes('sandbox') || msg.includes('SUID');
    let userMessage = `Browser launch failed: ${msg}`;
    if (isPathError) {
      userMessage = `Browser executable not found or not accessible. Ensure Chromium is installed (npx puppeteer browsers install chrome). Error: ${msg}`;
    } else if (isSandboxError) {
      userMessage = `Browser sandbox error. Try running with --no-sandbox or check permissions. Error: ${msg}`;
    }
    emit({ phase: 'browser-error', message: userMessage });
    throw new Error(userMessage);
  }

  const pageResults = [];
  let completedCount = 0;
  let consecutiveCloudflareFailures = 0;
  let abortedRemainingCount = 0;

  try {
    // Process URLs in batches of `concurrency` size
    for (let batchStart = 0; batchStart < urls.length; batchStart += concurrency) {
      // Check if we should abort due to Cloudflare rate-limiting
      if (consecutiveCloudflareFailures >= MAX_CONSECUTIVE_CF_FAILURES) {
        const remaining = urls.length - batchStart;
        console.warn(`  Aborting: ${MAX_CONSECUTIVE_CF_FAILURES} consecutive Cloudflare blocks — skipping ${remaining} remaining pages`);
        emit({
          phase: 'cloudflare-abort',
          message: `Cloudflare rate-limiting detected after ${completedCount} pages. ${remaining} pages skipped to preserve results.`,
        });
        // Mark remaining URLs as skipped
        for (let i = batchStart; i < urls.length; i++) {
          abortedRemainingCount++;
          pageResults.push({
            url: urls[i],
            error: 'Skipped: Cloudflare rate-limiting detected',
            desktop: { violations: [], passes: [], incomplete: [], inapplicable: [], screenshot: null },
            mobile: { violations: [], passes: [], incomplete: [], inapplicable: [], screenshot: null },
            combined: { violations: [], passes: [], incomplete: [], inapplicable: [] },
          });
        }
        break;
      }

      const batch = urls.slice(batchStart, batchStart + concurrency);

      const batchPromises = batch.map(async (url, batchIndex) => {
        const globalIndex = batchStart + batchIndex;
        console.log(`  Scanning page ${globalIndex + 1}/${urls.length}: ${url}`);
        emit({ phase: 'scanning', current: globalIndex + 1, total: urls.length, url, message: `Scanning page ${globalIndex + 1}/${urls.length}: ${url}` });

        try {
          const pageStartTime = Date.now();
          const skipScreenshot = globalIndex >= maxScreenshotPages;
          const result = await scanPage(browser, url, { tags, timeout, axeConfig, interactive, skipScreenshot });
          result.loadTimeMs = Date.now() - pageStartTime;
          completedCount++;
          consecutiveCloudflareFailures = 0; // Reset on success
          const violationSummary = (result.combined.violations || []).map(v => ({
            id: v.id, impact: v.impact, help: v.help, nodes: v.nodes ? v.nodes.length : 0
          }));
          emit({ phase: 'page-done', current: completedCount, total: urls.length, url, violations: result.combined.violations.length, violationSummary, loadTimeMs: result.loadTimeMs });
          return result;
        } catch (err) {
          console.warn(`  Error scanning ${url}: ${err.message}`);
          completedCount++;

          const isCloudflareError = err.message && (
            err.message.includes('Cloudflare escalated') ||
            err.message.includes('Cloudflare challenge did not resolve')
          );
          if (isCloudflareError) {
            consecutiveCloudflareFailures++;
          } else {
            consecutiveCloudflareFailures = 0;
          }

          emit({ phase: 'page-error', current: completedCount, total: urls.length, url, error: err.message });
          return {
            url,
            error: err.message,
            desktop: { violations: [], passes: [], incomplete: [], inapplicable: [], screenshot: null },
            mobile: { violations: [], passes: [], incomplete: [], inapplicable: [], screenshot: null },
            combined: { violations: [], passes: [], incomplete: [], inapplicable: [] },
          };
        }
      });

      const batchResults = await Promise.all(batchPromises);
      pageResults.push(...batchResults);

      // Rate-limit between batches to avoid triggering Cloudflare escalation
      if (batchStart + concurrency < urls.length && consecutiveCloudflareFailures < MAX_CONSECUTIVE_CF_FAILURES) {
        const delay = randomDelay(INTER_PAGE_DELAY_MS.min, INTER_PAGE_DELAY_MS.max);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  } finally {
    await browser.close();
  }

  emit({ phase: 'aggregating', message: 'Aggregating results...' });

  // Build aggregate result
  const scanDate = new Date().toISOString();
  const testEngine = pageResults.find((r) => r.desktop?.testEngine)?.desktop?.testEngine;

  const allViolations = aggregateViolations(pageResults);

  // Log iframe/shadow DOM violation context
  logNestedViolationContext(allViolations);

  // Apply confidence scoring to reduce false-positive noise
  applyConfidenceScores(allViolations);

  // Aggregate contrast verification results across all pages (Phase 15)
  const allContrastVerified = [];
  for (const page of pageResults) {
    if (page.combined && page.combined._contrastVerified) {
      allContrastVerified.push(...page.combined._contrastVerified);
    }
  }

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
    allViolations,
    allPasses: aggregatePasses(pageResults),
    allIncomplete: aggregateIncomplete(pageResults),
    allContrastVerified: allContrastVerified.length > 0 ? allContrastVerified : undefined,
  };
}

// ---------------------------------------------------------------------------
// Iframe / Shadow DOM violation context logging
// ---------------------------------------------------------------------------

/**
 * Detect and log violations found inside iframes or shadow DOM.
 * axe-core modern mode returns nested target arrays for these:
 * - iframe: target = [['iframe-selector'], ['element-in-iframe']]
 * - shadow DOM: target = [['host-selector', 'shadow-element']]
 *
 * Tags each affected node with _context: 'iframe' | 'shadow-dom' | 'standard'.
 */
function logNestedViolationContext(violations) {
  let iframeCount = 0;
  let shadowDomCount = 0;

  for (const v of violations) {
    for (const node of (v.nodes || [])) {
      const target = node.target;
      if (!target) {
        node._context = 'standard';
        continue;
      }

      // axe-core nests iframe violations as arrays of arrays: [['iframe'], ['element']]
      if (target.length > 1 && Array.isArray(target[0])) {
        node._context = 'iframe';
        iframeCount++;
      }
      // Shadow DOM targets contain nested arrays within a single entry: [['host', 'shadow-child']]
      else if (target.length === 1 && Array.isArray(target[0]) && target[0].length > 1) {
        node._context = 'shadow-dom';
        shadowDomCount++;
      } else {
        node._context = 'standard';
      }
    }
  }

  if (iframeCount > 0) {
    console.log(`  [iframe] Found ${iframeCount} violation node(s) inside iframes`);
  }
  if (shadowDomCount > 0) {
    console.log(`  [shadow-dom] Found ${shadowDomCount} violation node(s) inside shadow DOM`);
  }
}

// ---------------------------------------------------------------------------
// Aggregation functions
// ---------------------------------------------------------------------------

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
    _affectedPages: v._pageUrls.size,
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

/**
 * Validate axe-core configuration object.
 * @param {object} config - The axe config to validate
 * @returns {{ valid: boolean, warnings: string[] }}
 */
function validateAxeConfig(config) {
  const warnings = [];
  if (!config || typeof config !== 'object') return { valid: true, warnings };

  const knownKeys = ['disableRules', 'include', 'exclude', 'rules', 'runOnly', 'tags'];
  for (const key of Object.keys(config)) {
    if (!knownKeys.includes(key)) {
      warnings.push(`Unknown axe-config key "${key}" — will be ignored`);
    }
  }

  if (config.disableRules !== undefined) {
    if (!Array.isArray(config.disableRules)) {
      warnings.push('"disableRules" should be an array of rule ID strings');
    } else {
      for (const rule of config.disableRules) {
        if (typeof rule !== 'string') {
          warnings.push(`"disableRules" contains non-string value: ${JSON.stringify(rule)}`);
        }
      }
    }
  }

  if (config.include !== undefined && !Array.isArray(config.include)) {
    warnings.push('"include" should be an array of CSS selectors');
  }
  if (config.exclude !== undefined && !Array.isArray(config.exclude)) {
    warnings.push('"exclude" should be an array of CSS selectors');
  }

  return { valid: warnings.length === 0, warnings };
}

module.exports = { scanPage, scanAllPages, validateAxeConfig };
