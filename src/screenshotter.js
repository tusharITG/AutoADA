/**
 * Screenshot capture + violation overlay rendering.
 * Called during scan while the Puppeteer page is still open.
 *
 * Phase 2.6.3: Multi-region screenshot capture — groups violations by vertical
 * position, scrolls to each region, injects overlays per region, captures
 * per-region screenshots. Returns array of {base64, label, violationCount}.
 * Backward compatible: result.base64 still available as primary screenshot.
 */

const MAX_REGIONS = 2;
const MAX_OVERLAYS = 30;

const SEVERITY_COLORS = {
  critical: '#dc2626',
  serious: '#ea580c',
  moderate: '#ca8a04',
  minor: '#2563eb',
};

/**
 * Capture multi-region annotated screenshots of a page with violation overlays.
 * Must be called while the page is still open in Puppeteer.
 *
 * @param {import('puppeteer').Page} page - Live Puppeteer page reference
 * @param {Array} violations - axe-core violations array
 * @returns {Promise<{base64: string, width: number, height: number, regions: Array} | null>}
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
            ruleId: violation.id,
            help: violation.help || violation.description || violation.id,
          });
        }
        if (globalIndex >= MAX_OVERLAYS) break;
      }
      if (globalIndex >= MAX_OVERLAYS) break;
    }

    // Get element positions (absolute Y) and viewport height
    const layout = await page.evaluate((elems) => {
      const viewportWidth = window.innerWidth;
      const viewportHeight = window.innerHeight;
      const positions = [];
      for (const elem of elems) {
        try {
          const target = document.querySelector(elem.selector);
          if (!target) { positions.push(null); continue; }
          const rect = target.getBoundingClientRect();
          if (rect.width === 0 && rect.height === 0) { positions.push(null); continue; }
          positions.push({
            absTop: rect.top + window.scrollY,
            absBottom: rect.bottom + window.scrollY,
            left: rect.left + window.scrollX,
            width: rect.width,
            height: rect.height,
          });
        } catch {
          positions.push(null);
        }
      }
      return {
        viewportWidth,
        viewportHeight,
        pageHeight: document.documentElement.scrollHeight,
        positions,
      };
    }, elements);

    // Pair elements with their positions
    const positioned = elements
      .map((el, i) => ({ ...el, pos: layout.positions[i] }))
      .filter((el) => el.pos !== null);

    if (positioned.length === 0) {
      // Fallback: just take a viewport screenshot
      return await captureSingleViewport(page);
    }

    // Group violations into vertical regions (bins of viewport height)
    const vpH = layout.viewportHeight || 900;
    const regions = groupIntoRegions(positioned, vpH, layout.pageHeight);

    // Capture each region
    const regionScreenshots = [];
    for (const region of regions) {
      const screenshot = await captureRegion(page, region, vpH);
      if (screenshot) {
        regionScreenshots.push(screenshot);
      }
    }

    // Clean up any lingering overlays
    await cleanupOverlays(page);

    if (regionScreenshots.length === 0) {
      return await captureSingleViewport(page);
    }

    // Primary screenshot is the first region (usually the most critical, top-of-page)
    const primary = regionScreenshots[0];

    // Collect all annotations across all regions for the legend
    const allAnnotations = regionScreenshots
      .flatMap((r) => r.annotations || [])
      // Deduplicate by index
      .filter((a, i, arr) => arr.findIndex((b) => b.index === a.index) === i);

    return {
      base64: primary.base64,
      width: layout.viewportWidth,
      height: layout.viewportHeight,
      regions: regionScreenshots,
      annotations: allAnnotations,
    };
  } catch (err) {
    console.warn(`  Warning: Screenshot capture failed: ${err.message}`);
    return null;
  }
}

/**
 * Group positioned elements into vertical regions (max MAX_REGIONS).
 * Each region is ~1 viewport height, centered on the violation cluster.
 */
function groupIntoRegions(positioned, vpH, pageHeight) {
  // Sort by vertical position
  const sorted = [...positioned].sort((a, b) => a.pos.absTop - b.pos.absTop);

  // Bin elements by viewport-sized chunks
  const bins = new Map();
  for (const el of sorted) {
    const binIndex = Math.floor(el.pos.absTop / vpH);
    if (!bins.has(binIndex)) bins.set(binIndex, []);
    bins.get(binIndex).push(el);
  }

  // Sort bins by severity priority (bins with critical violations first)
  const sevOrder = { critical: 0, serious: 1, moderate: 2, minor: 3 };
  const sortedBins = [...bins.entries()].sort((a, b) => {
    const aSev = Math.min(...a[1].map((e) => sevOrder[e.severity] ?? 4));
    const bSev = Math.min(...b[1].map((e) => sevOrder[e.severity] ?? 4));
    if (aSev !== bSev) return aSev - bSev;
    return a[0] - b[0]; // then by position
  });

  // Take top MAX_REGIONS
  const regions = sortedBins.slice(0, MAX_REGIONS).map(([binIndex, elems]) => {
    const minY = Math.min(...elems.map((e) => e.pos.absTop));
    const maxY = Math.max(...elems.map((e) => e.pos.absBottom));
    // Center scroll position around the violation cluster
    const centerY = (minY + maxY) / 2;
    const scrollTo = Math.max(0, Math.min(centerY - vpH / 2, pageHeight - vpH));
    const regionTop = binIndex * vpH;

    return {
      scrollTo: Math.round(scrollTo),
      elements: elems,
      violationCount: elems.length,
      label: `Region ${binIndex + 1} (y: ${Math.round(regionTop)}px)`,
      topY: regionTop,
    };
  });

  // Sort back by position for consistent ordering
  regions.sort((a, b) => a.topY - b.topY);
  return regions;
}

/**
 * Capture a single region: scroll to position, inject overlays, screenshot, cleanup.
 */
async function captureRegion(page, region, vpH) {
  try {
    // Scroll to region
    await page.evaluate((scrollY) => {
      window.scrollTo(0, scrollY);
    }, region.scrollTo);
    await new Promise((r) => setTimeout(r, 200));

    // Inject overlays for elements in this region
    await page.evaluate((elems, colors) => {
      for (const elem of elems) {
        try {
          const target = document.querySelector(elem.selector);
          if (!target) continue;
          const rect = target.getBoundingClientRect();
          if (rect.width === 0 && rect.height === 0) continue;

          // Only overlay elements visible in current viewport
          if (rect.bottom < 0 || rect.top > window.innerHeight) continue;

          const overlay = document.createElement('div');
          overlay.setAttribute('data-autoada-overlay', 'true');
          overlay.style.cssText = `
            position: fixed;
            left: ${rect.left - 2}px;
            top: ${rect.top - 2}px;
            width: ${rect.width + 4}px;
            height: ${rect.height + 4}px;
            border: 3px solid ${elem.color};
            border-radius: 3px;
            pointer-events: none;
            z-index: 999999;
            box-sizing: border-box;
          `;
          document.body.appendChild(overlay);

          const marker = document.createElement('div');
          marker.setAttribute('data-autoada-marker', 'true');
          marker.textContent = elem.index;
          marker.style.cssText = `
            position: fixed;
            left: ${rect.left - 12}px;
            top: ${rect.top - 12}px;
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
          // Skip unfound elements
        }
      }
    }, region.elements, SEVERITY_COLORS);

    await new Promise((r) => setTimeout(r, 150));

    // Capture viewport screenshot
    const buffer = await page.screenshot({ fullPage: false, type: 'png' });

    // Clean up overlays
    await cleanupOverlays(page);

    return {
      base64: Buffer.from(buffer).toString('base64'),
      label: region.label,
      violationCount: region.violationCount,
      annotations: region.elements.map((el) => ({
        index: el.index,
        ruleId: el.ruleId,
        severity: el.severity,
        color: el.color,
        help: el.help,
      })),
    };
  } catch (err) {
    console.warn(`  Warning: Region screenshot failed: ${err.message}`);
    await cleanupOverlays(page);
    return null;
  }
}

/**
 * Fallback: capture a single viewport screenshot with no overlays.
 */
async function captureSingleViewport(page) {
  try {
    const buffer = await page.screenshot({ fullPage: false, type: 'png' });
    const dimensions = await page.evaluate(() => ({
      width: document.documentElement.scrollWidth,
      height: document.documentElement.scrollHeight,
    }));
    return {
      base64: Buffer.from(buffer).toString('base64'),
      width: dimensions.width,
      height: dimensions.height,
      regions: [],
    };
  } catch {
    return null;
  }
}

/**
 * Remove all injected overlay/marker elements from the page.
 */
async function cleanupOverlays(page) {
  try {
    await page.evaluate(() => {
      document.querySelectorAll('[data-autoada-overlay], [data-autoada-marker]')
        .forEach((el) => el.remove());
    });
  } catch { /* ignore */ }
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
