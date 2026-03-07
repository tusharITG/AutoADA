/**
 * Screenshot capture + violation overlay rendering.
 * Called during scan while the Puppeteer page is still open.
 */

const SEVERITY_COLORS = {
  critical: '#dc2626',
  serious: '#ea580c',
  moderate: '#ca8a04',
  minor: '#2563eb',
};

/**
 * Capture an annotated screenshot of a page with violation overlays.
 * Must be called while the page is still open in Puppeteer.
 *
 * @param {import('puppeteer').Page} page - Live Puppeteer page reference
 * @param {Array} violations - axe-core violations array
 * @returns {Promise<{base64: string, width: number, height: number} | null>}
 */
async function captureAnnotatedScreenshot(page, violations) {
  if (!violations || violations.length === 0) return null;

  try {
    // Collect all violating element selectors with their severity and index
    const elements = [];
    let globalIndex = 0;

    for (const violation of violations) {
      const severity = violation.impact || 'minor';
      for (const node of violation.nodes) {
        const selector = formatSelector(node.target);
        if (selector) {
          elements.push({
            selector,
            severity,
            index: ++globalIndex,
            color: SEVERITY_COLORS[severity] || SEVERITY_COLORS.minor,
          });
        }
        // Cap at 50 overlays to keep screenshots readable
        if (globalIndex >= 50) break;
      }
      if (globalIndex >= 50) break;
    }

    // Inject overlay elements onto the page
    await page.evaluate((elems) => {
      for (const elem of elems) {
        try {
          const target = document.querySelector(elem.selector);
          if (!target) continue;

          const rect = target.getBoundingClientRect();
          if (rect.width === 0 && rect.height === 0) continue;

          // Scroll into view if needed
          target.scrollIntoView({ block: 'nearest', behavior: 'instant' });

          // Create border overlay
          const overlay = document.createElement('div');
          overlay.setAttribute('data-autoada-overlay', 'true');
          overlay.style.cssText = `
            position: absolute;
            left: ${rect.left + window.scrollX - 2}px;
            top: ${rect.top + window.scrollY - 2}px;
            width: ${rect.width + 4}px;
            height: ${rect.height + 4}px;
            border: 3px solid ${elem.color};
            border-radius: 3px;
            pointer-events: none;
            z-index: 999999;
            box-sizing: border-box;
          `;
          document.body.appendChild(overlay);

          // Create numbered marker
          const marker = document.createElement('div');
          marker.setAttribute('data-autoada-marker', 'true');
          marker.textContent = elem.index;
          marker.style.cssText = `
            position: absolute;
            left: ${rect.left + window.scrollX - 12}px;
            top: ${rect.top + window.scrollY - 12}px;
            width: 24px;
            height: 24px;
            background: ${elem.color};
            color: white;
            border-radius: 50%;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 11px;
            font-weight: bold;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
            pointer-events: none;
            z-index: 1000000;
            line-height: 1;
            box-shadow: 0 1px 3px rgba(0,0,0,0.3);
          `;
          document.body.appendChild(marker);
        } catch {
          // Skip elements that can't be found or measured
        }
      }
    }, elements);

    // Wait briefly for renders
    await new Promise((r) => setTimeout(r, 300));

    // Capture viewport-only screenshot (not full page — full page creates 10,000+ px images)
    const screenshotBuffer = await page.screenshot({
      fullPage: false,
      type: 'png',
    });

    // Get viewport dimensions
    const dimensions = await page.evaluate(() => ({
      width: document.documentElement.scrollWidth,
      height: document.documentElement.scrollHeight,
    }));

    // Clean up overlays
    await page.evaluate(() => {
      document.querySelectorAll('[data-autoada-overlay], [data-autoada-marker]')
        .forEach((el) => el.remove());
    });

    return {
      base64: Buffer.from(screenshotBuffer).toString('base64'),
      width: dimensions.width,
      height: dimensions.height,
    };
  } catch (err) {
    console.warn(`  Warning: Screenshot capture failed: ${err.message}`);
    return null;
  }
}

/**
 * Format an axe-core target selector array into a CSS selector string.
 * Handles simple selectors, iframe nesting, and shadow DOM.
 */
function formatSelector(target) {
  if (!target || target.length === 0) return null;
  // Use the last (most specific) selector in the chain
  const last = target[target.length - 1];
  return Array.isArray(last) ? last[last.length - 1] : last;
}

module.exports = { captureAnnotatedScreenshot };
