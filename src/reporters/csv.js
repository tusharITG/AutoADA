/**
 * CSV reporter — flattened violations table.
 * One row per affected element across all pages.
 */

const HEADERS = [
  'Page URL',
  'Rule ID',
  'Impact',
  'Description',
  'Help',
  'WCAG Criteria',
  'Viewport',
  'Element Selector',
  'HTML Snippet',
  'Help URL',
  'Failure Summary',
];

/**
 * Extract WCAG criteria numbers from axe-core tags.
 * Converts tags like 'wcag111' → '1.1.1', 'wcag1412' → '1.4.12'
 */
function extractWcagCriteria(tags) {
  if (!tags) return '';
  return tags
    .filter((tag) => /^wcag\d{3,}$/.test(tag))
    .map((tag) => {
      const digits = tag.replace('wcag', '');
      // First digit = principle, second = guideline, rest = criterion
      return `${digits[0]}.${digits[1]}.${digits.slice(2)}`;
    })
    .join(', ');
}

/**
 * Format an axe-core target array into a readable CSS selector.
 */
function formatTarget(target) {
  if (!target) return '';
  return target
    .map((t) => (Array.isArray(t) ? t.join(' >>> ') : t))
    .join(' > ');
}

/**
 * Escape a value for CSV (RFC 4180).
 */
function escapeCsvField(value) {
  const str = String(value || '');
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

/**
 * Build failure summary from axe-core node data.
 */
function buildFailureSummary(node) {
  if (node.failureSummary) return node.failureSummary;
  const parts = [];
  if (node.any && node.any.length) {
    parts.push('Fix any of: ' + node.any.map((c) => c.message).join('; '));
  }
  if (node.all && node.all.length) {
    parts.push('Fix all of: ' + node.all.map((c) => c.message).join('; '));
  }
  if (node.none && node.none.length) {
    parts.push('Must not have: ' + node.none.map((c) => c.message).join('; '));
  }
  return parts.join(' | ');
}

/**
 * Generate CSV report from scan results.
 *
 * @param {object} scanResult - Full scan result
 * @returns {string} CSV content
 */
function generateCsv(scanResult) {
  const rows = [];

  // Iterate over all pages
  for (const page of (scanResult.pages || [])) {
    const pageUrl = page.url;

    for (const violation of (page.combined?.violations || [])) {
      const wcag = extractWcagCriteria(violation.tags);
      const viewport = violation._viewport || 'both';

      for (const node of violation.nodes) {
        rows.push([
          pageUrl,
          violation.id,
          node.impact || violation.impact || '',
          violation.description,
          violation.help,
          wcag,
          viewport,
          formatTarget(node.target),
          node.html || '',
          violation.helpUrl,
          buildFailureSummary(node),
        ]);
      }
    }
  }

  // Build CSV
  const lines = [HEADERS.map(escapeCsvField).join(',')];
  for (const row of rows) {
    lines.push(row.map(escapeCsvField).join(','));
  }

  return lines.join('\n');
}

module.exports = { generateCsv, extractWcagCriteria, formatTarget, escapeCsvField };
