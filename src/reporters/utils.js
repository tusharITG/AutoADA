/**
 * Shared reporter utilities — used by html.js, csv.js, and pdf.js.
 * Centralizes escapeHtml, formatTarget, extractWcagCriteria, getWcagDetails,
 * and buildFailureSummary to eliminate duplication across reporters.
 */

let wcagMap = {};
try {
  wcagMap = require('../data/wcag-map.json');
} catch { /* wcag-map data not available */ }

/**
 * Escape HTML special characters to prevent XSS in generated report.
 */
function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Extract WCAG criteria numbers from axe-core tags.
 * Converts tags like 'wcag111' to '1.1.1', 'wcag1412' to '1.4.12'.
 */
function extractWcagCriteria(tags) {
  if (!tags) return '';
  return tags
    .filter((tag) => /^wcag\d{3,}$/.test(tag))
    .map((tag) => {
      const digits = tag.replace('wcag', '');
      return `${digits[0]}.${digits[1]}.${digits.slice(2)}`;
    })
    .join(', ');
}

/**
 * Look up WCAG success criterion details from axe-core tags.
 * Returns array of { sc, name, level, principle, guideline, legalRelevance, description }.
 */
function getWcagDetails(tags) {
  if (!tags || !wcagMap || Object.keys(wcagMap).length === 0) return [];
  const criteria = tags
    .filter((tag) => /^wcag\d{3,}$/.test(tag))
    .map((tag) => {
      const digits = tag.replace('wcag', '');
      return `${digits[0]}.${digits[1]}.${digits.slice(2)}`;
    });
  const details = [];
  const seen = new Set();
  for (const sc of criteria) {
    if (seen.has(sc)) continue;
    seen.add(sc);
    const info = wcagMap[sc];
    if (info) {
      details.push({ sc, ...info });
    } else {
      details.push({ sc, name: sc, level: '?', principle: '', guideline: '', legalRelevance: '', description: '' });
    }
  }
  return details;
}

/**
 * Format an axe-core target array into a readable CSS selector string.
 */
function formatTarget(target) {
  if (!target) return '';
  return target
    .map((t) => (Array.isArray(t) ? t.join(' >>> ') : t))
    .join(' > ');
}

/**
 * Build failure summary from axe-core node data.
 */
function buildFailureSummary(node) {
  if (node.failureSummary) return node.failureSummary;
  const parts = [];
  if (node.any && node.any.length) {
    parts.push('Fix any of: ' + node.any.map((c) => c.message || c.id || 'Unknown check').join('; '));
  }
  if (node.all && node.all.length) {
    parts.push('Fix all of: ' + node.all.map((c) => c.message || c.id || 'Unknown check').join('; '));
  }
  if (node.none && node.none.length) {
    parts.push('Must not have: ' + node.none.map((c) => c.message || c.id || 'Unknown check').join('; '));
  }
  return parts.join(' | ');
}

/**
 * Sanitize a URL for safe use in href attributes.
 * Blocks javascript: and data: protocols; only allows http/https.
 */
function safeHref(url) {
  if (!url) return '';
  const trimmed = String(url).trim().toLowerCase();
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return escapeHtml(url);
  }
  return '#';
}

module.exports = { escapeHtml, extractWcagCriteria, getWcagDetails, formatTarget, buildFailureSummary, safeHref };
