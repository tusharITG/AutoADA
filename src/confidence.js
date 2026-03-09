/**
 * Confidence scoring for violations — reduces false positive noise.
 *
 * Assigns _confidence ('high' | 'medium' | 'low') and _falsePositiveNote
 * to each violation based on rule characteristics and false-positive metadata.
 *
 * Also applies contextual node-level checks for known false-positive patterns.
 */

const falsePositives = require('./data/false-positives.json');

// Rules that are reliably deterministic — very low false-positive rate
const HIGH_CONFIDENCE_RULES = new Set([
  'html-has-lang',
  'document-title',
  'meta-viewport',
  'bypass',
  'link-name',
  'button-name',
  'image-alt',
  'input-image-alt',
  'html-lang-valid',
  'valid-lang',
  'page-has-heading-one',
  'duplicate-id',
  'duplicate-id-active',
]);

// Rules that are known for moderate false-positive rates
const MEDIUM_CONFIDENCE_RULES = new Set([
  'heading-order',
  'region',
  'landmark-one-main',
  'list',
  'listitem',
  'label',
  'frame-title',
  'empty-heading',
  'tabindex',
  'target-size',
]);

/**
 * Apply confidence scores to all violations.
 * Mutates violations in place by adding _confidence and _falsePositiveNote.
 *
 * @param {Array} violations - Array of axe-core violations
 * @returns {Array} Same violations array with confidence metadata added
 */
function applyConfidenceScores(violations) {
  for (const violation of violations) {
    const ruleId = violation.id;

    if (HIGH_CONFIDENCE_RULES.has(ruleId)) {
      violation._confidence = 'high';
    } else if (MEDIUM_CONFIDENCE_RULES.has(ruleId)) {
      violation._confidence = 'medium';
      if (falsePositives[ruleId]) {
        violation._falsePositiveNote = falsePositives[ruleId];
      }
    } else if (falsePositives[ruleId]) {
      // Any rule in false-positives.json defaults to low confidence
      violation._confidence = 'low';
      violation._falsePositiveNote = falsePositives[ruleId];
    } else {
      // Unknown rules default to medium
      violation._confidence = 'medium';
    }

    // Apply contextual node-level checks (may downgrade confidence per-node)
    applyContextualChecks(violation);
  }

  return violations;
}

// ---------------------------------------------------------------------------
// Contextual false-positive detection (node-level)
// ---------------------------------------------------------------------------

/**
 * Apply node-level context checks that can downgrade confidence for specific
 * nodes based on their HTML/ARIA context patterns.
 */
function applyContextualChecks(violation) {
  const ruleId = violation.id;
  const nodes = violation.nodes || [];

  for (const node of nodes) {
    const html = node.html || '';

    switch (ruleId) {
      case 'image-alt':
        // alt="" is correct for decorative images — flag as possible FP
        if (/\balt\s*=\s*""\s*/i.test(html)) {
          node._confidence = 'low';
          node._contextNote = 'Image has alt="" which is correct for decorative images. Verify this image is truly decorative.';
        }
        break;

      case 'color-contrast':
        // background-image, gradient, or opacity patterns make contrast unreliable
        if (/background-image|background:\s*.*(?:url|gradient)/i.test(html)) {
          node._confidence = 'low';
          node._contextNote = 'Element has background-image or gradient — computed contrast may be inaccurate.';
        }
        // Check for opacity or rgba in inline styles
        if (/opacity\s*:|rgba\s*\(/i.test(html)) {
          node._confidence = 'low';
          node._contextNote = 'Element uses opacity or rgba — computed contrast may not reflect visual appearance.';
        }
        break;

      case 'aria-hidden-focus':
        // Dynamic toggle patterns — aria-hidden may be toggled via JS
        if (/aria-hidden\s*=\s*"true"/i.test(html) &&
            /tabindex\s*=\s*"-1"/i.test(html)) {
          node._confidence = 'low';
          node._contextNote = 'Element has both aria-hidden and tabindex=-1, suggesting dynamic toggle pattern.';
        }
        // Modal/drawer patterns
        if (/modal|drawer|dialog|panel|collapse/i.test(html)) {
          node._confidence = 'low';
          node._contextNote = 'Element appears to be in a modal/drawer with dynamic aria-hidden toggling.';
        }
        break;

      case 'color-contrast-enhanced':
        // Same context as color-contrast
        if (/background-image|background:\s*.*(?:url|gradient)/i.test(html)) {
          node._confidence = 'low';
          node._contextNote = 'Element has background-image or gradient — computed contrast may be inaccurate.';
        }
        break;

      case 'empty-heading':
        // Headings with images, SVGs, or visually-hidden text
        if (/<img\b|<svg\b|sr-only|visually-hidden|screen-reader/i.test(html)) {
          node._confidence = 'low';
          node._contextNote = 'Heading may contain image/SVG with alt text or visually-hidden text providing an accessible name.';
        }
        break;

      case 'link-in-text-block':
        // Links with visual differentiators axe-core can't detect
        if (/text-decoration|border-bottom|font-weight|underline/i.test(html)) {
          node._confidence = 'low';
          node._contextNote = 'Link appears to have non-color visual differentiators (underline, border, font-weight).';
        }
        break;

      default:
        break;
    }
  }
}

module.exports = { applyConfidenceScores };
