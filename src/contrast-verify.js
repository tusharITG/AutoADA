/**
 * Color Contrast Pixel Verification (Phase 15)
 *
 * After axe-core scanning, verifies color-contrast incomplete items by:
 * 1. Sampling foreground and background colors from the live page
 * 2. Calculating WCAG 2.1 contrast ratio
 * 3. Reclassifying as verified_fail / verified_pass / still_uncertain
 *
 * Runs while the Puppeteer page is still open (inside scanViewport).
 */

/** @const {number} Maximum elements to verify per page (performance limit) */
const MAX_VERIFY_ELEMENTS = 30;

// Debug logging — mirrors scanner.js pattern, outputs when AUTOADA_DEBUG=1
function debugLog(context, msg) {
  if (process.env.AUTOADA_DEBUG === '1') {
    console.log(`  [debug:${context}] ${msg}`);
  }
}

/**
 * Calculate relative luminance per WCAG 2.1 definition.
 * @param {number} r 0-255
 * @param {number} g 0-255
 * @param {number} b 0-255
 * @returns {number} Relative luminance (0-1)
 */
function relativeLuminance(r, g, b) {
  const [rs, gs, bs] = [r, g, b].map((c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

/**
 * Calculate WCAG contrast ratio between two colors.
 * @param {{r:number,g:number,b:number}} fg Foreground color
 * @param {{r:number,g:number,b:number}} bg Background color
 * @returns {number} Contrast ratio (1 to 21)
 */
function contrastRatio(fg, bg) {
  const l1 = relativeLuminance(fg.r, fg.g, fg.b);
  const l2 = relativeLuminance(bg.r, bg.g, bg.b);
  const lighter = Math.max(l1, l2);
  const darker = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Determine if contrast ratio passes WCAG AA.
 * @param {number} ratio Contrast ratio
 * @param {boolean} isLargeText Whether text is large (>=18pt or >=14pt bold)
 * @returns {boolean}
 */
function passesWcagAA(ratio, isLargeText) {
  return isLargeText ? ratio >= 3.0 : ratio >= 4.5;
}

/**
 * Sample colors from a Puppeteer page element by reading computed styles.
 * Walks up the DOM to find the effective background color, and detects
 * background-image patterns that make sampling uncertain.
 *
 * @param {import('puppeteer').Page} page
 * @param {string} selector CSS selector for the element
 * @returns {Promise<{fg: {r,g,b}, bg: {r,g,b}, isLargeText: boolean, hasBgImage: boolean} | null>}
 */
async function sampleElementColors(page, selector) {
  try {
    const colors = await page.evaluate((sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;

      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return null;

      // Get computed styles for foreground color
      const style = window.getComputedStyle(el);
      const fgColor = style.color;
      const fontSize = parseFloat(style.fontSize);
      const fontWeight = parseInt(style.fontWeight, 10) || 400;
      // WCAG large text: >= 24px (18pt), or >= 18.66px (14pt) and bold
      const isLargeText = fontSize >= 24 || (fontSize >= 18.66 && fontWeight >= 700);

      // Parse RGB from computed color string
      function parseRgb(str) {
        const m = str.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
        if (m) return { r: parseInt(m[1]), g: parseInt(m[2]), b: parseInt(m[3]) };
        return null;
      }

      const fg = parseRgb(fgColor);
      if (!fg) return null;

      // Walk up the DOM to find the effective background color
      let bgColor = null;
      let current = el;
      while (current && current !== document.documentElement) {
        const cs = window.getComputedStyle(current);
        const bg = cs.backgroundColor;
        const parsed = parseRgb(bg);
        if (parsed) {
          // Check if it's not transparent (rgba with alpha 0)
          const alphaMatch = bg.match(/rgba\(\d+,\s*\d+,\s*\d+,\s*([\d.]+)\)/);
          const alpha = alphaMatch ? parseFloat(alphaMatch[1]) : 1;
          if (alpha > 0.1) {
            bgColor = parsed;
            break;
          }
        }
        current = current.parentElement;
      }
      // Default to white background if nothing found
      if (!bgColor) bgColor = { r: 255, g: 255, b: 255 };

      // Check if element or any ancestor has a background-image (makes sampling uncertain)
      let hasBgImage = false;
      current = el;
      while (current && current !== document.documentElement) {
        const cs = window.getComputedStyle(current);
        if (cs.backgroundImage && cs.backgroundImage !== 'none') {
          hasBgImage = true;
          break;
        }
        current = current.parentElement;
      }

      return { fg, bg: bgColor, isLargeText, hasBgImage };
    }, selector);

    return colors;
  } catch (err) {
    debugLog('contrast-verify', 'Color sampling failed: ' + err.message);
    return null;
  }
}

/**
 * Verify color contrast for incomplete axe-core items.
 * Runs on the live Puppeteer page after axe-core scanning.
 *
 * For each node in each incomplete color-contrast item:
 * - Samples foreground and background colors via computed styles
 * - Calculates WCAG contrast ratio
 * - Classifies as verified_fail, verified_pass, or still_uncertain
 *
 * @param {import('puppeteer').Page} page - Live Puppeteer page
 * @param {Array} incompleteItems - axe-core incomplete items for color-contrast rule
 * @returns {Promise<Array>} Verified items with _contrastVerification metadata on each node
 */
async function verifyContrastItems(page, incompleteItems) {
  if (!incompleteItems || incompleteItems.length === 0) return [];

  const results = [];
  let count = 0;

  for (const item of incompleteItems) {
    const nodes = item.nodes || [];
    const verifiedNodes = [];

    for (const node of nodes) {
      if (count >= MAX_VERIFY_ELEMENTS) {
        // Mark remaining as uncertain — performance limit reached
        verifiedNodes.push({
          ...node,
          _contrastVerification: {
            status: 'still_uncertain',
            reason: 'Verification limit reached (' + MAX_VERIFY_ELEMENTS + ' elements max)',
          },
        });
        continue;
      }

      // Extract the last selector from the target array.
      // axe-core target can be: ['selector'] or [['iframe-sel'], ['elem-sel']] or [['host', 'shadow-child']]
      const target = node.target;
      let selector = null;
      if (target && target.length > 0) {
        const last = target[target.length - 1];
        selector = Array.isArray(last) ? last[last.length - 1] : last;
      }

      if (!selector) {
        verifiedNodes.push({
          ...node,
          _contrastVerification: { status: 'still_uncertain', reason: 'No valid selector' },
        });
        continue;
      }

      try {
        const colors = await sampleElementColors(page, selector);
        count++;

        if (!colors) {
          verifiedNodes.push({
            ...node,
            _contrastVerification: { status: 'still_uncertain', reason: 'Could not sample colors' },
          });
          continue;
        }

        if (colors.hasBgImage) {
          verifiedNodes.push({
            ...node,
            _contrastVerification: {
              status: 'still_uncertain',
              reason: 'Background image present — cannot determine true contrast',
              fg: colors.fg,
              bg: colors.bg,
            },
          });
          continue;
        }

        const ratio = contrastRatio(colors.fg, colors.bg);
        const passes = passesWcagAA(ratio, colors.isLargeText);

        verifiedNodes.push({
          ...node,
          _contrastVerification: {
            status: passes ? 'verified_pass' : 'verified_fail',
            ratio: Math.round(ratio * 100) / 100,
            required: colors.isLargeText ? 3.0 : 4.5,
            isLargeText: colors.isLargeText,
            fg: colors.fg,
            bg: colors.bg,
          },
        });
      } catch (err) {
        verifiedNodes.push({
          ...node,
          _contrastVerification: { status: 'still_uncertain', reason: err.message },
        });
      }
    }

    results.push({ ...item, nodes: verifiedNodes });
  }

  return results;
}

/**
 * Format an RGB color object as a hex string.
 * @param {{r:number,g:number,b:number}} color
 * @returns {string} e.g. "#ff0000"
 */
function rgbToHex(color) {
  if (!color) return '#000000';
  const hex = (n) => n.toString(16).padStart(2, '0');
  return '#' + hex(color.r) + hex(color.g) + hex(color.b);
}

module.exports = {
  verifyContrastItems,
  contrastRatio,
  relativeLuminance,
  passesWcagAA,
  rgbToHex,
  MAX_VERIFY_ELEMENTS,
};
