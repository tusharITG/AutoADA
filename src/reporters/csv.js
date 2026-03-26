/**
 * CSV reporter — flattened violations table.
 * One row per affected element across all pages.
 */

const { extractWcagCriteria, formatTarget, buildFailureSummary } = require('./utils');

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
 * Escape a value for CSV (RFC 4180).
 */
function escapeCsvField(value) {
  let str = String(value || '');
  // Guard against CSV formula injection (OWASP recommendation)
  if (/^[=+\-@\t\r]/.test(str)) {
    str = "'" + str;
  }
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
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
