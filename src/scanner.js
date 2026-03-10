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

// Enable stealth mode to bypass bot detection (Cloudflare, etc.)
puppeteer.use(StealthPlugin());

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
  // Step 1: Navigate with networkidle2 for better full-page loading
  try {
    await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout,
    });
  } catch {
    // networkidle2 timeout — fall back to domcontentloaded
    try {
      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: 15000,
      });
    } catch {
      // Even domcontentloaded failed — continue with whatever loaded
    }
  }

  // Step 2: Detect and wait for Cloudflare/bot challenge pages
  await waitForChallengeResolution(page);

  // Step 3: Smart framework hydration detection (DOM stability-based)
  await waitForFrameworkReady(page);

  // Step 4: Wait for key content selectors (best-effort, short timeout)
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

  // Step 5: Best-effort network idle (don't fail if it never settles)
  try {
    await page.waitForNetworkIdle({ idleTime: 500, timeout: 5000 });
  } catch {
    // Network never went idle — proceed anyway (common for ecommerce/SPA sites)
  }
}

/**
 * Detect Cloudflare/bot challenge pages and wait for them to resolve.
 * Cloudflare typically shows "Just a moment..." and auto-redirects once
 * the JS challenge passes. With the stealth plugin, this usually resolves
 * within 5-10 seconds.
 */
async function waitForChallengeResolution(page, maxWaitMs = 15000) {
  const isChallengePage = async () => {
    try {
      return await page.evaluate(() => {
        const title = document.title.toLowerCase();
        // Cloudflare challenge — require strong indicators (title or DOM selectors)
        const hasCfTitle = title.includes('just a moment') || title.includes('attention required');
        const hasCfDom = !!document.querySelector('#challenge-running, #challenge-form, .cf-browser-verification, #cf-wrapper, .cf-error-details');
        // Meta refresh only counts as Cloudflare if pointing to cdn-cgi (NOT generic meta-refresh)
        const metaRefresh = document.querySelector('meta[http-equiv="refresh"]');
        const hasCfMeta = metaRefresh && (metaRefresh.getAttribute('content') || '').includes('cdn-cgi');
        // Must have at least one strong Cloudflare indicator
        return hasCfTitle || hasCfDom || hasCfMeta;
      });
    } catch {
      return false;
    }
  };

  if (!(await isChallengePage())) return;

  console.log('    [cloudflare] Challenge detected, waiting for resolution...');
  const start = Date.now();

  while (Date.now() - start < maxWaitMs) {
    await new Promise((r) => setTimeout(r, 2000));

    // Check if we navigated away from the challenge
    if (!(await isChallengePage())) {
      const elapsed = ((Date.now() - start) / 1000).toFixed(1);
      console.log(`    [cloudflare] Challenge resolved in ${elapsed}s`);
      // Give the real page a moment to render
      await new Promise((r) => setTimeout(r, 1000));
      return;
    }
  }

  console.warn('    [cloudflare] Challenge did not resolve within timeout — scanning challenge page');
}

/**
 * Wait for SPA frameworks to finish hydrating/rendering.
 * Uses MutationObserver to detect DOM stability (no changes for 1 second).
 * Falls back to a fixed 2s wait if detection fails.
 *
 * @param {import('puppeteer').Page} page
 * @param {number} maxWaitMs - Maximum wait time (default 8s)
 */
async function waitForFrameworkReady(page, maxWaitMs = 8000) {
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
    await page.evaluate((maxWait) => {
      return new Promise((resolve) => {
        let timer = null;
        let settled = false;
        const STABILITY_WINDOW = 1000;

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
    }, maxWaitMs);
  } catch {
    // Fallback: fixed 2s wait
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
  } catch {
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
          await new Promise((r) => setTimeout(r, 500));
          break;
        }
      }
      if (dismissed) break;
    } catch {
      // Selector not found or click failed — try next
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
            await new Promise((r) => setTimeout(r, 500));
            break;
          }
        }
        if (dismissed) break;
      } catch {
        // Try next
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
            await new Promise((r) => setTimeout(r, 500));
            break;
          }
        }
      } catch {
        // Try next
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
  } catch {
    // DOM manipulation failed — continue
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
  const MAX_INTERACTIONS = 10;
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
        await new Promise((r) => setTimeout(r, 500)); // Wait for animation/expansion

        // Re-scan after expansion
        const results = await runAxeAnalysis(page, tags, axeConfig);

        // Collect new violations and tag them
        for (const v of (results.violations || [])) {
          v._source = 'interactive';
          v._expandedFrom = elem.selector;
          additionalViolations.push(v);
        }
      } catch {
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
  const MAX_TABS = 50;
  const TRAP_THRESHOLD = 3; // Same element at same position focused 3 times consecutively

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
      await page.keyboard.press('Tab');

      const focusInfo = await page.evaluate(() => {
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
async function scanViewport(browser, url, viewport, tags, timeout, axeConfig = {}, interactive = false) {
  const context = await browser.createBrowserContext();

  try {
    const page = await context.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
    await enableRequestInterception(page);
    await page.setBypassCSP(true);
    await page.setViewport(viewport);

    await loadPageDefensively(page, url, timeout);

    // State 1: Scan with overlays present
    const results1 = await runAxeAnalysis(page, tags, axeConfig);

    // State 2: Dismiss overlays on the SAME page, then re-scan
    await tryDismissOverlays(page);
    await new Promise((r) => setTimeout(r, 500));
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
    let screenshot = null;
    if (violations.length > 0) {
      screenshot = await captureAnnotatedScreenshot(page, violations);
    }

    return {
      violations,
      passes: results2.passes || [],
      incomplete: results2.incomplete || [],
      inapplicable: results2.inapplicable || [],
      screenshot,
      testEngine: results2.testEngine,
      testEnvironment: results2.testEnvironment,
    };
  } finally {
    await context.close();
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
async function scanPage(browser, url, options = {}) {
  const {
    tags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'],
    timeout = 30000,
    axeConfig = {},
    interactive = false,
  } = options;

  const pageResult = {
    url,
    desktop: { violations: [], passes: [], incomplete: [], inapplicable: [], screenshot: null },
    mobile: { violations: [], passes: [], incomplete: [], inapplicable: [], screenshot: null },
    combined: { violations: [], passes: [], incomplete: [], inapplicable: [] },
  };

  // --- Desktop scan (with retry) ---
  try {
    const desktopResult = await withRetry(
      () => scanViewport(browser, url, VIEWPORTS.desktop, tags, timeout, axeConfig, interactive)
    );
    pageResult.desktop.violations = desktopResult.violations;
    pageResult.desktop.passes = desktopResult.passes;
    pageResult.desktop.incomplete = desktopResult.incomplete;
    pageResult.desktop.inapplicable = desktopResult.inapplicable;
    pageResult.desktop.screenshot = desktopResult.screenshot;
    pageResult.desktop.testEngine = desktopResult.testEngine;
    pageResult.desktop.testEnvironment = desktopResult.testEnvironment;
  } catch (err) {
    console.warn(`  Warning: Desktop scan failed for ${url}: ${err.message}`);
  }

  // --- Mobile scan (with retry) ---
  try {
    const mobileResult = await withRetry(
      () => scanViewport(browser, url, VIEWPORTS.mobile, tags, timeout, axeConfig, interactive)
    );
    pageResult.mobile.violations = mobileResult.violations;
    pageResult.mobile.passes = mobileResult.passes;
    pageResult.mobile.incomplete = mobileResult.incomplete;
    pageResult.mobile.inapplicable = mobileResult.inapplicable;
    pageResult.mobile.screenshot = mobileResult.screenshot;
  } catch (err) {
    console.warn(`  Warning: Mobile scan failed for ${url}: ${err.message}`);
  }

  // --- Combine results with viewport tagging ---
  pageResult.combined = combineViewportResults(pageResult.desktop, pageResult.mobile);

  return pageResult;
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

  return {
    violations: Array.from(combined.values()),
    passes: Array.from(passMap.values()),
    incomplete: Array.from(incompleteMap.values()),
    inapplicable: desktop.inapplicable, // Same rules apply regardless of viewport
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
    tags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'],
    timeout = 30000,
    axeConfig = {},
    interactive = false,
    concurrency = 1,
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
  let completedCount = 0;

  try {
    // Process URLs in batches of `concurrency` size
    for (let batchStart = 0; batchStart < urls.length; batchStart += concurrency) {
      const batch = urls.slice(batchStart, batchStart + concurrency);

      const batchPromises = batch.map(async (url, batchIndex) => {
        const globalIndex = batchStart + batchIndex;
        console.log(`  Scanning page ${globalIndex + 1}/${urls.length}: ${url}`);
        emit({ phase: 'scanning', current: globalIndex + 1, total: urls.length, url, message: `Scanning page ${globalIndex + 1}/${urls.length}: ${url}` });

        try {
          const result = await scanPage(browser, url, { tags, timeout, axeConfig, interactive });
          completedCount++;
          emit({ phase: 'page-done', current: completedCount, total: urls.length, url, violations: result.combined.violations.length });
          return result;
        } catch (err) {
          console.warn(`  Error scanning ${url}: ${err.message}`);
          completedCount++;
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

module.exports = { scanPage, scanAllPages };
