/**
 * HTML reporter — generates a single self-contained HTML compliance report.
 * All CSS and JS are embedded inline. No external dependencies at runtime.
 */

const path = require('path');
const fs = require('fs');
const { calculateOverallScore, getPrinciple } = require('../score');
const { escapeHtml, extractWcagCriteria, getWcagDetails, formatTarget, buildFailureSummary, safeHref } = require('./utils');

// IT Geeks default logo (base64-encoded PNG)
let DEFAULT_LOGO_BASE64 = '';
try {
  const logoPath = path.join(__dirname, '..', 'web', 'itgeeks-logo.png');
  DEFAULT_LOGO_BASE64 = fs.readFileSync(logoPath).toString('base64');
} catch { /* logo not available */ }

let remediationData = {};
try {
  remediationData = require('../data/remediation.json');
} catch { /* remediation data not available */ }

let falsePositives = {};
try {
  falsePositives = require('../data/false-positives.json');
} catch { /* false-positives data not available */ }

// ---------------------------------------------------------------------------
// Helper utilities
// ---------------------------------------------------------------------------

/**
 * Format a date string nicely.
 */
function formatDate(dateStr) {
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  } catch {
    return dateStr || 'Unknown';
  }
}

/**
 * Get the hostname from a URL.
 */
function getHostname(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return url || 'Unknown';
  }
}

/**
 * Map severity to display color.
 */
function severityColor(severity) {
  const map = {
    critical: '#dc2626',
    serious: '#ea580c',
    moderate: '#ca8a04',
    minor: '#2563eb',
    pass: '#16a34a',
  };
  return map[severity] || '#6b7280';
}

/**
 * Estimate effort from element count or remediation data.
 */
function estimateEffort(ruleId, nodeCount) {
  if (remediationData[ruleId] && remediationData[ruleId].effort) {
    return remediationData[ruleId].effort;
  }
  if (nodeCount <= 5) return 'Low';
  if (nodeCount <= 20) return 'Medium';
  return 'High';
}

/**
 * Map severity to sort priority (lower = higher priority).
 */
function severityPriority(severity) {
  const map = { critical: 0, serious: 1, moderate: 2, minor: 3 };
  return map[severity] != null ? map[severity] : 4;
}

/**
 * Extract base64 image data from a screenshot object (handles both old and new format).
 */
function extractImgData(shot) {
  if (!shot) return null;
  if (typeof shot === 'string') return shot;
  if (typeof shot === 'object' && shot.base64) return shot.base64;
  return null;
}

/**
 * Render screenshot(s) for a page, supporting multi-region captures.
 */
function renderScreenshots(desktopShot, mobileShot, pageUrl) {
  let html = '';
  const desktopImg = extractImgData(desktopShot);
  const mobileImg = extractImgData(mobileShot);
  const desktopRegions = (desktopShot && typeof desktopShot === 'object' && desktopShot.regions) || [];
  const mobileRegions = (mobileShot && typeof mobileShot === 'object' && mobileShot.regions) || [];

  // Primary screenshots (desktop + mobile side by side)
  if (desktopImg || mobileImg) {
    html += '<div style="display:flex; gap:16px; flex-wrap:wrap; margin:16px 0;">';
    if (desktopImg) {
      html += `
        <div class="screenshot-container" style="flex:1; min-width:300px;">
          <p style="font-weight:600; margin-bottom:8px;">Desktop View (1280px)</p>
          <img src="data:image/png;base64,${desktopImg}" alt="Desktop annotated screenshot of ${escapeHtml(pageUrl)}">
        </div>`;
    }
    if (mobileImg) {
      html += `
        <div class="screenshot-container" style="flex:0 0 auto; max-width:375px;">
          <p style="font-weight:600; margin-bottom:8px;">Mobile View (375px)</p>
          <img src="data:image/png;base64,${mobileImg}" alt="Mobile annotated screenshot of ${escapeHtml(pageUrl)}">
        </div>`;
    }
    html += '</div>';
  }

  // Additional region screenshots (desktop)
  if (desktopRegions.length > 1) {
    html += '<details><summary>Additional Desktop Regions (' + desktopRegions.length + ' captured)</summary>';
    for (let i = 1; i < desktopRegions.length; i++) {
      const region = desktopRegions[i];
      if (!region.base64) continue;
      html += `
        <div class="screenshot-container" style="margin:12px 0;">
          <p style="font-weight:600; margin-bottom:8px; font-size:0.9rem;">
            ${escapeHtml(region.label || 'Region ' + (i + 1))}
            (${region.violationCount || 0} violation${region.violationCount !== 1 ? 's' : ''})
          </p>
          <img src="data:image/png;base64,${region.base64}" alt="Desktop region ${i + 1} of ${escapeHtml(pageUrl)}">
        </div>`;
    }
    html += '</details>';
  }

  // Additional region screenshots (mobile)
  if (mobileRegions.length > 1) {
    html += '<details><summary>Additional Mobile Regions (' + mobileRegions.length + ' captured)</summary>';
    for (let i = 1; i < mobileRegions.length; i++) {
      const region = mobileRegions[i];
      if (!region.base64) continue;
      html += `
        <div class="screenshot-container" style="margin:12px 0; max-width:375px;">
          <p style="font-weight:600; margin-bottom:8px; font-size:0.9rem;">
            ${escapeHtml(region.label || 'Region ' + (i + 1))}
            (${region.violationCount || 0} violation${region.violationCount !== 1 ? 's' : ''})
          </p>
          <img src="data:image/png;base64,${region.base64}" alt="Mobile region ${i + 1} of ${escapeHtml(pageUrl)}">
        </div>`;
    }
    html += '</details>';
  }

  return html;
}

// ---------------------------------------------------------------------------
// CSS generation
// ---------------------------------------------------------------------------

function generateStyles(accentColor) {
  const accent = accentColor || '#4295f6';
  return `
    *, *::before, *::after { box-sizing: border-box; }
    html { scroll-behavior: smooth; }
    body {
      margin: 0; padding: 0;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif;
      font-size: 15px; line-height: 1.6; color: #1a1a2e;
      background: #ffffff;
    }
    .report-wrap { max-width: 1100px; margin: 0 auto; padding: 0 32px 64px; }

    /* Cover page */
    .cover-page {
      min-height: 100vh; display: flex; flex-direction: column;
      align-items: center; justify-content: center; text-align: center;
      padding: 48px 24px; page-break-after: always;
    }
    .cover-page h1 {
      font-size: 2.4rem; font-weight: 800; letter-spacing: 2px;
      margin: 0 0 8px; color: #0d0d0d;
    }
    .cover-title-bar { width: 80px; height: 4px; background: ${accent}; margin: 0 auto 24px; border-radius: 2px; }
    .cover-subtitle { font-size: 1.15rem; color: #555; margin-bottom: 32px; }
    .cover-meta { font-size: 0.95rem; color: #666; line-height: 2; }
    .cover-meta strong { color: #1a1a2e; }
    .cover-confidential {
      margin-top: 48px; font-size: 0.8rem; letter-spacing: 3px;
      text-transform: uppercase; color: #999; font-weight: 600;
    }
    .client-logo { max-height: 72px; max-width: 240px; margin-bottom: 24px; }

    /* Section headings */
    h2.section-heading {
      font-size: 1.6rem; font-weight: 700; color: #0d0d0d;
      border-bottom: 3px solid ${accent}; padding-bottom: 8px;
      margin: 48px 0 24px;
    }
    h3.sub-heading { font-size: 1.2rem; font-weight: 600; color: #1a1a2e; margin: 32px 0 16px; }
    h4.card-heading { font-size: 1.05rem; font-weight: 600; margin: 0 0 12px; color: #0d0d0d; }

    /* Table of Contents */
    .toc-list { list-style: none; padding: 0; margin: 0; }
    .toc-list li { padding: 6px 0; border-bottom: 1px dashed #e5e7eb; }
    .toc-list li a { text-decoration: none; color: ${accent}; font-weight: 500; }
    .toc-list li a:hover { text-decoration: underline; }
    .toc-number { display: inline-block; width: 28px; color: #999; font-weight: 600; }

    /* Score card */
    .score-card {
      display: inline-block; padding: 24px 48px; border-radius: 16px;
      text-align: center; color: #fff; margin: 16px 0 24px;
    }
    .score-card .score-number { font-size: 3.6rem; font-weight: 800; line-height: 1; }
    .score-card .score-label { font-size: 0.9rem; opacity: 0.9; margin-top: 4px; }

    /* Tables */
    table { width: 100%; border-collapse: collapse; margin: 16px 0; font-size: 0.92rem; }
    table th {
      background: #1a1a2e; color: #fff; font-weight: 600;
      text-align: left; padding: 10px 14px;
    }
    table td { padding: 10px 14px; border-bottom: 1px solid #e5e7eb; }
    table tr:nth-child(even) td { background: #f9fafb; }
    table tr:nth-child(odd) td { background: #fff; }

    /* Severity badges */
    .badge {
      display: inline-block; padding: 2px 10px; border-radius: 9999px;
      font-size: 0.75rem; font-weight: 600; color: #fff; text-transform: capitalize;
      white-space: nowrap; vertical-align: middle;
    }
    .badge-critical { background: #dc2626; }
    .badge-serious { background: #ea580c; }
    .badge-moderate { background: #ca8a04; }
    .badge-minor { background: #2563eb; }
    .badge-pass { background: #16a34a; }
    .badge-level-a { background: #6366f1; }
    .badge-level-aa { background: #8b5cf6; }
    .badge-confirmed { background: #16a34a; }
    .badge-review { background: #ca8a04; }
    .badge-needs-verification { background: #9ca3af; }
    .badge-best-practice { background: #7c3aed; }

    .score-disclaimer {
      background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 8px;
      padding: 14px 18px; margin: 16px 0 24px; font-size: 0.9rem;
      color: #1e40af; text-align: center; line-height: 1.5;
    }

    /* WCAG SC detail block */
    .wcag-sc-list { margin: 8px 0 12px; }
    .wcag-sc-item {
      display: flex; align-items: flex-start; gap: 10px;
      padding: 8px 12px; margin: 4px 0; background: #f8fafc;
      border: 1px solid #e2e8f0; border-radius: 6px; font-size: 0.88rem;
    }
    .wcag-sc-item .sc-number { font-weight: 700; white-space: nowrap; min-width: 40px; }
    .wcag-sc-item .sc-name { font-weight: 600; }
    .wcag-sc-item .sc-legal { color: #6b7280; font-size: 0.82rem; margin-top: 2px; }

    /* Metric cards row */
    .metrics-row {
      display: flex; gap: 16px; flex-wrap: wrap; margin: 16px 0 24px;
    }
    .metric-card {
      flex: 1; min-width: 140px; padding: 18px 16px; border-radius: 10px;
      text-align: center; border: 1px solid #e5e7eb; background: #f9fafb;
    }
    .metric-card .metric-value { font-size: 2rem; font-weight: 800; line-height: 1.1; color: #0d0d0d; }
    .metric-card .metric-label { font-size: 0.82rem; color: #6b7280; margin-top: 4px; text-transform: uppercase; letter-spacing: 0.5px; }

    /* Risk assessment */
    .risk-badge {
      display: inline-block; padding: 4px 14px; border-radius: 6px;
      font-weight: 700; font-size: 0.9rem; color: #fff; text-transform: uppercase;
      letter-spacing: 1px; vertical-align: middle;
    }
    .risk-high { background: #dc2626; }
    .risk-moderate { background: #ca8a04; }
    .risk-low { background: #16a34a; }

    /* Priority action items */
    .priority-list { list-style: none; padding: 0; margin: 12px 0; counter-reset: priority; }
    .priority-list li {
      counter-increment: priority; padding: 10px 14px 10px 48px; margin: 6px 0;
      background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 8px;
      position: relative; font-size: 0.92rem;
    }
    .priority-list li::before {
      content: counter(priority); position: absolute; left: 14px; top: 10px;
      width: 24px; height: 24px; border-radius: 50%; background: #1a1a2e;
      color: #fff; font-size: 0.78rem; font-weight: 700;
      display: flex; align-items: center; justify-content: center;
    }

    /* Status text */
    .status-good { color: #16a34a; font-weight: 600; }
    .status-needs-work { color: #ca8a04; font-weight: 600; }
    .status-critical { color: #dc2626; font-weight: 600; }

    /* Cards */
    .card {
      border: 1px solid #e5e7eb; border-radius: 10px; padding: 20px 24px;
      margin: 16px 0; background: #fff;
    }
    .card + .card { margin-top: 12px; }

    /* "Why This Matters" blocks */
    .callout-why {
      background: #f3f4f6; border-left: 4px solid ${accent};
      padding: 14px 18px; margin: 16px 0; border-radius: 0 6px 6px 0;
    }
    .callout-why strong { display: block; margin-bottom: 4px; color: #0d0d0d; }

    /* "Recommended Fix" blocks */
    .callout-fix {
      background: #eff6ff; border-left: 4px solid #2563eb;
      padding: 14px 18px; margin: 16px 0; border-radius: 0 6px 6px 0;
    }
    .callout-fix strong { display: block; margin-bottom: 4px; color: #0d0d0d; }

    /* False positive note */
    .callout-fp {
      background: #fef3c7; border-left: 4px solid #ca8a04;
      padding: 14px 18px; margin: 16px 0; border-radius: 0 6px 6px 0;
    }
    .callout-fp strong { display: block; margin-bottom: 4px; color: #92400e; }

    /* ARIA callout box */
    .callout-aria {
      background: #eff6ff; border: 2px solid ${accent};
      padding: 18px 22px; margin: 16px 0; border-radius: 8px;
    }

    /* Manual review (amber) */
    .callout-manual {
      background: #fef3c7; border: 1px solid #ca8a04;
      padding: 14px 18px; margin: 12px 0; border-radius: 8px;
    }

    /* Code blocks */
    pre {
      background: #f3f4f6; padding: 12px 16px; border-radius: 6px;
      overflow-x: auto; font-size: 0.85rem; line-height: 1.5;
      font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
      white-space: pre-wrap; word-break: break-all;
    }
    code {
      font-family: 'SFMono-Regular', Consolas, 'Liberation Mono', Menlo, monospace;
      font-size: 0.85rem; background: #f3f4f6; padding: 2px 5px; border-radius: 4px;
    }

    /* Before/After code blocks */
    .code-compare { display: flex; gap: 16px; margin: 12px 0; }
    .code-compare > div { flex: 1; min-width: 0; }
    .code-before pre { background: #fef2f2; border: 1px solid #fecaca; }
    .code-after pre { background: #f0fdf4; border: 1px solid #bbf7d0; }
    .code-compare .code-label {
      font-size: 0.78rem; font-weight: 600; text-transform: uppercase;
      margin-bottom: 4px; letter-spacing: 0.5px;
    }
    .code-before .code-label { color: #dc2626; }
    .code-after .code-label { color: #16a34a; }

    /* Color contrast swatches */
    .swatch {
      display: inline-block; width: 40px; height: 40px; border-radius: 6px;
      border: 1px solid #d1d5db; vertical-align: middle;
    }
    .swatch-pair { display: flex; align-items: center; gap: 8px; margin: 8px 0; }
    .swatch-label { font-size: 0.85rem; color: #555; }

    /* Element list */
    .element-item { margin: 12px 0; padding: 12px; background: #f9fafb; border-radius: 6px; border: 1px solid #e5e7eb; }
    .element-selector { font-weight: 600; margin-bottom: 6px; }

    /* Details/Summary */
    details { margin: 8px 0; }
    summary {
      cursor: pointer; font-weight: 600; padding: 8px 0;
      user-select: none; color: #1a1a2e;
    }
    summary:hover { color: ${accent}; }
    details[open] > summary { margin-bottom: 8px; }

    /* Screenshots */
    .screenshot-container { margin: 16px 0; text-align: center; }
    .screenshot-container img {
      max-width: 100%; max-height: 600px; height: auto; object-fit: contain;
      border: 1px solid #e5e7eb;
      border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.08);
    }

    /* Search filter */
    .search-filter {
      padding: 10px 16px; border: 2px solid #e5e7eb; border-radius: 8px;
      font-size: 0.95rem; width: 100%; margin-bottom: 16px;
      font-family: inherit; transition: border-color 0.2s;
    }
    .search-filter:focus { outline: none; border-color: ${accent}; }

    /* Muted section (passes) */
    .muted-section table td { color: #6b7280; }
    .muted-section table th { background: #4b5563; }

    /* Links */
    a { color: ${accent}; }
    a:hover { text-decoration: underline; }

    /* Lists */
    ul.clean-list { padding-left: 20px; margin: 8px 0; }
    ul.clean-list li { margin: 4px 0; }

    /* Compact violation row */
    .violation-compact { display: flex; align-items: center; gap: 10px; padding: 8px 0; border-bottom: 1px solid #f3f4f6; }
    .violation-compact:last-child { border-bottom: none; }

    /* Print styles */
    @media print {
      .cover-page { min-height: auto; page-break-after: always; }
      h2.section-heading { page-break-before: always; margin-top: 16px; }
      .card { page-break-inside: avoid; }
      .callout-why, .callout-fix, .callout-fp { page-break-inside: avoid; }
      table { page-break-inside: avoid; }
      .screenshot-container { page-break-inside: avoid; }
      .screenshot-container img { max-height: 400px; }
      a[href]::after { content: " (" attr(href) ")"; font-size: 0.8em; color: #666; }
      .search-filter { display: none; }
      body { font-size: 12px; }
      .report-wrap { padding: 0 16px; }
    }

    @media (max-width: 720px) {
      .code-compare { flex-direction: column; }
      .report-wrap { padding: 0 16px 32px; }
      .cover-page h1 { font-size: 1.8rem; }
      .score-card .score-number { font-size: 2.4rem; }
    }
  `;
}

// ---------------------------------------------------------------------------
// Section renderers
// ---------------------------------------------------------------------------

/**
 * Section 1: Cover Page
 */
function renderCoverPage(scanResult, options) {
  const clientName = options.clientName || getHostname(scanResult.url);
  const dateStr = formatDate(scanResult.scanDate);
  const accentColor = options.clientColor || '#4295f6';

  let logoHtml = '';
  const logoBase64 = options.clientLogoBase64 || DEFAULT_LOGO_BASE64;
  if (logoBase64) {
    const isDefaultLogo = !options.clientLogoBase64;
    const altText = isDefaultLogo ? 'IT Geeks logo' : `${escapeHtml(clientName)} logo`;
    if (isDefaultLogo) {
      logoHtml = `<div style="display:inline-block;background:#1c1917;padding:10px 16px;border-radius:8px;margin-bottom:24px"><img class="client-logo" src="data:image/png;base64,${logoBase64}" alt="${altText}" style="margin-bottom:0"></div>`;
    } else {
      logoHtml = `<img class="client-logo" src="data:image/png;base64,${logoBase64}" alt="${altText}">`;
    }
  }

  return `
    <div class="cover-page">
      ${logoHtml}
      <h1>ADA/WCAG COMPLIANCE REPORT</h1>
      <div class="cover-title-bar" style="background:${escapeHtml(accentColor)}"></div>
      <p class="cover-subtitle">Comprehensive Accessibility Analysis</p>
      <div class="cover-meta">
        <p>Prepared for: <strong>${escapeHtml(clientName)}</strong></p>
        <p>Scanned URL: <strong>${escapeHtml(scanResult.url)}</strong></p>
        <p>Report Date: <strong>${escapeHtml(dateStr)}</strong></p>
      </div>
      <p class="cover-confidential">CONFIDENTIAL</p>
    </div>
  `;
}

/**
 * Section 2: Table of Contents
 */
function renderTableOfContents(scanResult) {
  const sections = [
    ['exec-summary', 'Executive Summary'],
    ['methodology', 'Audit Methodology'],
    ['compliance-overview', 'Compliance Overview'],
    ['desktop-mobile', 'Desktop vs. Mobile Comparison'],
    ['detailed-findings-rule', 'Detailed Findings by Rule Type'],
    ['detailed-findings-page', 'Detailed Findings by Page'],
    ['color-contrast', 'Color Contrast Analysis'],
    ['aria-analysis', 'ARIA Analysis Summary'],
    ['manual-review', 'Manual Review Items'],
    ['passed-checks', 'Passed Checks Summary'],
    ['action-plan', 'Prioritized Action Plan'],
    ['compliance-statement', 'Draft Accessibility Compliance Statement'],
    ['appendix', 'Appendix'],
  ];

  let items = '';
  sections.forEach(([id, label], i) => {
    items += `<li><span class="toc-number">${i + 1}.</span><a href="#${id}">${escapeHtml(label)}</a>`;
    // Add per-page sub-items under "Detailed Findings by Page"
    if (id === 'detailed-findings-page') {
      const pages = scanResult?.pages || [];
      if (pages.length > 1) {
        items += '<ul class="toc-list" style="margin-left:28px; margin-top:4px;">';
        pages.forEach((page, pi) => {
          const pagePath = safePathname(page.url);
          items += `<li><a href="#page-${pi}">${escapeHtml(pagePath)}</a></li>`;
        });
        items += '</ul>';
      }
    }
    items += '</li>\n';
  });

  return `
    <h2 class="section-heading" id="toc">Table of Contents</h2>
    <ol class="toc-list">
      ${items}
    </ol>
  `;
}

function safePathname(url) {
  try { return new URL(url).pathname || '/'; }
  catch { return url || '/'; }
}

/**
 * Section 3: Executive Summary
 */
function renderExecutiveSummary(scanResult, scores) {
  const overall = scores.overall;
  let scoreBg = '#dc2626';
  if (overall >= 80) scoreBg = '#16a34a';
  else if (overall >= 50) scoreBg = '#ca8a04';

  const violations = scanResult.allViolations || [];
  const passes = scanResult.allPasses || [];
  const sev = scores.severityBreakdown || { critical: 0, serious: 0, moderate: 0, minor: 0 };
  const pageCount = scanResult.pageCount || (scanResult.pages || []).length || 1;
  const totalNodes = scores.totalViolationNodes || 0;

  // --- Risk Assessment ---
  let riskLevel, riskClass, riskText;
  if (sev.critical > 0 || overall < 40) {
    riskLevel = 'HIGH';
    riskClass = 'risk-high';
    riskText = 'This website presents a <strong>high risk</strong> of ADA non-compliance. Critical accessibility barriers were detected that may prevent users with disabilities from accessing core content and functionality. Immediate remediation is strongly recommended to reduce legal exposure and improve user access.';
  } else if (sev.serious > 0 || overall < 70) {
    riskLevel = 'MODERATE';
    riskClass = 'risk-moderate';
    riskText = 'This website presents a <strong>moderate risk</strong> of ADA non-compliance. Serious accessibility issues were detected that create significant barriers for some users with disabilities. Targeted remediation of the highest-severity issues is recommended within the near term.';
  } else {
    riskLevel = 'LOW';
    riskClass = 'risk-low';
    riskText = 'This website presents a <strong>low risk</strong> of ADA non-compliance. No critical or serious barriers were detected. Minor improvements may further enhance the experience for users with disabilities.';
  }

  // --- Estimated Fix Time ---
  let estimatedMinutes = 0;
  for (const v of violations) {
    const nodeCount = (v.nodes || []).length;
    const imp = v.impact || 'minor';
    // Rough per-node estimate: critical=15min, serious=10min, moderate=7min, minor=5min
    const perNode = imp === 'critical' ? 15 : imp === 'serious' ? 10 : imp === 'moderate' ? 7 : 5;
    estimatedMinutes += nodeCount * perNode;
  }
  let fixTimeStr;
  if (estimatedMinutes === 0) fixTimeStr = '0 hrs';
  else if (estimatedMinutes < 60) fixTimeStr = `~${estimatedMinutes} min`;
  else fixTimeStr = `~${Math.round(estimatedMinutes / 60)} hrs`;

  // --- Principle table rows ---
  let principleRows = '';
  for (const [name, data] of Object.entries(scores.byPrinciple || {})) {
    let statusClass = 'status-good';
    if (data.status === 'Needs Work') statusClass = 'status-needs-work';
    if (data.status === 'Critical') statusClass = 'status-critical';
    principleRows += `
      <tr>
        <td>${escapeHtml(name)}</td>
        <td>${data.score}/100</td>
        <td class="${statusClass}">${escapeHtml(data.status)}</td>
      </tr>`;
  }

  // --- Benchmark ---
  const benchmarkSummary = scores.benchmarkContext
    ? escapeHtml(scores.benchmarkContext.summary)
    : 'Benchmark data not available.';

  // --- Industry comparison ---
  let benchmarks;
  try { benchmarks = require('../data/benchmarks.json'); } catch { benchmarks = null; }
  let industryComparisonHtml = '';
  if (benchmarks && benchmarks.percentile_thresholds) {
    const pt = benchmarks.percentile_thresholds;
    let percentileLabel = '';
    if (overall >= pt.top_1_percent) percentileLabel = 'Top 1%';
    else if (overall >= pt.top_5_percent) percentileLabel = 'Top 5%';
    else if (overall >= pt.top_10_percent) percentileLabel = 'Top 10%';
    else if (overall >= pt.top_25_percent) percentileLabel = 'Top 25%';
    else if (overall >= pt.median) percentileLabel = 'Above Median';
    else if (overall >= pt.bottom_25_percent) percentileLabel = 'Below Median';
    else percentileLabel = 'Bottom 10%';

    industryComparisonHtml = `
      <p>Based on the <strong>WebAIM Million 2025</strong> dataset (1,000,000 homepages analyzed),
      your score of <strong>${overall}/100</strong> places you in the <strong>${escapeHtml(percentileLabel)}</strong>
      of all websites. The industry median is <strong>${pt.median}/100</strong>, and
      <strong>${benchmarks.failure_rate}%</strong> of homepages have detectable WCAG failures
      (average of ${benchmarks.average_errors_per_page} errors per page).</p>`;
  }

  // --- Top strengths ---
  const topStrengths = passes.slice(0, 5);
  let strengthsList = '';
  if (topStrengths.length > 0) {
    strengthsList = '<ul class="clean-list">' +
      topStrengths.map((p) => `<li>${escapeHtml(p.description || p.help || p.id)}</li>`).join('') +
      '</ul>';
  } else {
    strengthsList = '<p>No passed checks recorded.</p>';
  }

  // --- Top critical issues ---
  const sorted = [...violations].sort((a, b) => severityPriority(a.impact) - severityPriority(b.impact));
  const topIssues = sorted.slice(0, 5);
  let issuesList = '';
  if (topIssues.length > 0) {
    issuesList = '<ul class="clean-list">' +
      topIssues.map((v) => {
        const badge = `<span class="badge badge-${v.impact || 'minor'}">${escapeHtml(v.impact || 'minor')}</span>`;
        return `<li>${badge} ${escapeHtml(v.help || v.id)} (${(v.nodes || []).length} elements affected)</li>`;
      }).join('') +
      '</ul>';
  } else {
    issuesList = '<p>No violations found.</p>';
  }

  // --- Priority actions (top 3-5) ---
  const priorityActions = sorted.slice(0, 5);
  let priorityHtml = '';
  if (priorityActions.length > 0) {
    priorityHtml = '<ol class="priority-list">';
    for (const v of priorityActions) {
      const nodeCount = (v.nodes || []).length;
      const wcagDetails = getWcagDetails(v.tags);
      const scLabel = wcagDetails.length > 0
        ? wcagDetails.map((d) => `WCAG ${d.sc} (${d.name})`).join(', ')
        : '';
      const effort = estimateEffort(v.id, nodeCount);
      priorityHtml += `
        <li>
          <strong>${escapeHtml(v.help || v.id)}</strong>
          <span class="badge badge-${v.impact || 'minor'}" style="margin-left:6px;">${escapeHtml(v.impact || 'minor')}</span>
          <br><span style="color:#6b7280;font-size:0.85rem;">
            ${nodeCount} element${nodeCount !== 1 ? 's' : ''} affected
            ${scLabel ? ' &mdash; ' + escapeHtml(scLabel) : ''}
            &mdash; Effort: ${escapeHtml(typeof effort === 'string' ? effort : 'Medium')}
          </span>
        </li>`;
    }
    priorityHtml += '</ol>';
  }

  return `
    <h2 class="section-heading" id="exec-summary">Executive Summary</h2>

    <h3 class="sub-heading">Automated Scan Score</h3>
    <div style="text-align:center;">
      <div class="score-card" style="background:${scoreBg};">
        <div class="score-number">${overall}</div>
        <div class="score-label">out of 100</div>
      </div>
    </div>
    <div class="score-disclaimer">
      <strong>Automated Scan Score</strong> &mdash; This score reflects only issues detectable by automated
      scanning with axe-core, which covers approximately 30&ndash;40% of WCAG 2.2 criteria. Issues requiring
      human judgment (keyboard usability, screen reader flow, cognitive load, content quality) are not fully
      covered. A complete accessibility assessment requires manual expert testing.
    </div>
    <div class="metrics-row">
      <div class="metric-card">
        <div class="metric-value" style="color:#16a34a;">${scores.confirmedViolations || 0}</div>
        <div class="metric-label">Confirmed Issues</div>
      </div>
      <div class="metric-card">
        <div class="metric-value" style="color:#ca8a04;">${scores.needsReviewViolations || 0}</div>
        <div class="metric-label">Needs Manual Review</div>
      </div>
      <div class="metric-card">
        <div class="metric-value">${scores.confirmedNodes || 0}</div>
        <div class="metric-label">Confirmed Elements</div>
      </div>
      <div class="metric-card">
        <div class="metric-value">${scores.needsReviewNodes || 0}</div>
        <div class="metric-label">Review Elements</div>
      </div>
    </div>

    <h3 class="sub-heading">Risk Assessment</h3>
    <p><span class="risk-badge ${riskClass}">${riskLevel} RISK</span></p>
    <p>${riskText}</p>

    <h3 class="sub-heading">Key Metrics</h3>
    <div class="metrics-row">
      <div class="metric-card">
        <div class="metric-value">${pageCount}</div>
        <div class="metric-label">Pages Scanned</div>
      </div>
      <div class="metric-card">
        <div class="metric-value">${violations.length}</div>
        <div class="metric-label">Violations</div>
      </div>
      <div class="metric-card">
        <div class="metric-value">${totalNodes}</div>
        <div class="metric-label">Elements Affected</div>
      </div>
      <div class="metric-card">
        <div class="metric-value">${fixTimeStr}</div>
        <div class="metric-label">Est. Fix Time</div>
      </div>
    </div>

    <h3 class="sub-heading">Score Breakdown by WCAG Principle</h3>
    <table>
      <thead><tr><th>Principle</th><th>Score</th><th>Status</th></tr></thead>
      <tbody>${principleRows}</tbody>
    </table>

    <h3 class="sub-heading">Industry Benchmark</h3>
    <p>${benchmarkSummary}</p>
    ${industryComparisonHtml}

    ${priorityActions.length > 0 ? '<h3 class="sub-heading">Recommended Priority Actions</h3>' + priorityHtml : ''}

    <h3 class="sub-heading">Top Strengths</h3>
    ${strengthsList}

    <h3 class="sub-heading">Top Critical Issues</h3>
    ${issuesList}

    <div class="callout-why">
      <strong>Why This Matters</strong>
      ADA compliance is not only a legal requirement under Title III of the Americans with Disabilities Act
      but also a business imperative. Websites that fail to meet WCAG 2.2 Level AA standards risk litigation,
      loss of customers with disabilities (approximately 26% of U.S. adults), and reputational harm.
      Accessible websites also tend to have better SEO, faster load times, and improved usability for all users.
    </div>
  `;
}

/**
 * Section 4: Audit Methodology
 */
function renderMethodology(scanResult) {
  const dateStr = formatDate(scanResult.scanDate);
  const toolVersion = escapeHtml(scanResult.toolVersion || 'AutoADA 1.0.0');
  const pageCount = scanResult.pageCount || (scanResult.pages || []).length || 1;

  return `
    <h2 class="section-heading" id="methodology">Audit Methodology</h2>
    <table>
      <tbody>
        <tr><td><strong>Scan Date</strong></td><td>${escapeHtml(dateStr)}</td></tr>
        <tr><td><strong>Tool</strong></td><td>${toolVersion}</td></tr>
        <tr><td><strong>Standard</strong></td><td>WCAG 2.2 Level AA</td></tr>
        <tr><td><strong>Pages Scanned</strong></td><td>${pageCount}</td></tr>
        <tr><td><strong>Viewports Tested</strong></td><td>Desktop (1280 &times; 900px) + Mobile (375 &times; 812px)</td></tr>
      </tbody>
    </table>

    <h3 class="sub-heading">Data Sources</h3>
    <ul class="clean-list">
      <li>axe-core automated accessibility engine (Deque Systems)</li>
      <li>Dual-viewport testing (desktop and mobile breakpoints)</li>
      <li>Overlay/popup dismissal for beneath-overlay scanning</li>
      <li>Annotated screenshots of violation locations</li>
    </ul>

    <p>Each page was scanned at two viewports: <strong>Desktop (1280px wide)</strong> and
    <strong>Mobile (375px wide)</strong>. Overlays and cookie banners were automatically dismissed
    to ensure the underlying page content was fully tested.</p>

    <div class="callout-why">
      <strong>Why This Matters</strong>
      Automated testing with axe-core can detect approximately 30&ndash;40% of all WCAG conformance
      issues. This audit provides a strong baseline, but manual testing with assistive technologies
      (screen readers, keyboard-only navigation) is recommended for comprehensive coverage.
    </div>
  `;
}

/**
 * Section 5: Compliance Overview
 */
function renderComplianceOverview(scanResult, scores) {
  const violations = scanResult.allViolations || [];
  const passes = scanResult.allPasses || [];
  const incomplete = scanResult.allIncomplete || [];
  const totalNodes = scores.totalViolationNodes || 0;

  // Summary statistics
  const totalRules = violations.length + passes.length;

  // Severity distribution
  const sev = scores.severityBreakdown || { critical: 0, serious: 0, moderate: 0, minor: 0 };
  const totalSevNodes = Object.values(sev).reduce((a, b) => a + b, 0) || 1;

  let sevRows = '';
  for (const [level, count] of Object.entries(sev)) {
    const pct = ((count / totalSevNodes) * 100).toFixed(1);
    sevRows += `
      <tr>
        <td><span class="badge badge-${level}">${escapeHtml(level)}</span></td>
        <td>${count}</td>
        <td>${pct}%</td>
      </tr>`;
  }

  return `
    <h2 class="section-heading" id="compliance-overview">Compliance Overview</h2>

    <h3 class="sub-heading">Summary Statistics</h3>
    <table>
      <thead><tr><th>Metric</th><th>Count</th></tr></thead>
      <tbody>
        <tr><td>Total Rules Checked</td><td>${totalRules}</td></tr>
        <tr><td>Violations Found</td><td>${violations.length}</td></tr>
        <tr><td>Elements Affected</td><td>${totalNodes}</td></tr>
        <tr><td>Passed Checks</td><td>${passes.length}</td></tr>
        <tr><td>Needs Manual Review</td><td>${incomplete.length}</td></tr>
      </tbody>
    </table>

    <h3 class="sub-heading">Severity Distribution</h3>
    <table>
      <thead><tr><th>Severity</th><th>Count</th><th>% of Total</th></tr></thead>
      <tbody>${sevRows}</tbody>
    </table>
  `;
}

/**
 * Section 6: Desktop vs. Mobile Comparison
 */
function renderDesktopMobileComparison(scanResult) {
  const pages = scanResult.pages || [];
  // Collect all combined violations and their viewport tags
  const violationMap = new Map();

  for (const page of pages) {
    for (const v of (page.combined?.violations || [])) {
      if (!violationMap.has(v.id)) {
        violationMap.set(v.id, {
          id: v.id,
          help: v.help || v.description || v.id,
          viewport: v._viewport || 'both',
        });
      } else {
        // Merge viewport info
        const existing = violationMap.get(v.id);
        if (existing.viewport !== v._viewport && existing.viewport !== 'both') {
          existing.viewport = 'both';
        }
      }
    }
  }

  const allViolations = Array.from(violationMap.values());

  let rows = '';
  if (allViolations.length === 0) {
    rows = '<tr><td colspan="4">No violations detected in either viewport.</td></tr>';
  } else {
    for (const v of allViolations) {
      const isDesktop = v.viewport === 'desktop-only' || v.viewport === 'both';
      const isMobile = v.viewport === 'mobile-only' || v.viewport === 'both';
      let status = '';
      if (v.viewport === 'both') status = 'Both viewports';
      else if (v.viewport === 'desktop-only') status = 'Desktop only';
      else if (v.viewport === 'mobile-only') status = 'Mobile only';
      else status = escapeHtml(v.viewport);

      rows += `
        <tr>
          <td>${escapeHtml(v.help)}</td>
          <td style="text-align:center;">${isDesktop ? '<span style="color:#16a34a;font-weight:600;">&#10003;</span>' : '<span style="color:#dc2626;">&#10007;</span>'}</td>
          <td style="text-align:center;">${isMobile ? '<span style="color:#16a34a;font-weight:600;">&#10003;</span>' : '<span style="color:#dc2626;">&#10007;</span>'}</td>
          <td>${status}</td>
        </tr>`;
    }
  }

  return `
    <h2 class="section-heading" id="desktop-mobile">Desktop vs. Mobile Comparison</h2>
    <p>The following table shows which violations were detected on each viewport.</p>
    <table>
      <thead><tr><th>Issue</th><th>Desktop</th><th>Mobile</th><th>Status</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

/**
 * Section 7: Detailed Findings by Rule Type
 */
function renderDetailedFindingsByRule(scanResult, scores) {
  const violations = scanResult.allViolations || [];

  // Group by principle
  const principleDescriptions = {
    Perceivable: 'Information and user interface components must be presentable to users in ways they can perceive. This includes text alternatives, adaptable layouts, distinguishable content, and sufficient color contrast.',
    Operable: 'User interface components and navigation must be operable. Users must be able to operate the interface using a keyboard, have enough time to read content, and navigate without seizure-inducing content.',
    Understandable: 'Information and the operation of user interface must be understandable. Text must be readable, pages must operate in predictable ways, and users must be helped to avoid and correct mistakes.',
    Robust: 'Content must be robust enough that it can be interpreted reliably by a wide variety of user agents, including assistive technologies. This requires valid markup and proper ARIA usage.',
  };

  const grouped = { Perceivable: [], Operable: [], Understandable: [], Robust: [] };
  for (const v of violations) {
    const principle = getPrinciple(v.tags);
    if (!grouped[principle]) grouped[principle] = [];
    grouped[principle].push(v);
  }

  let html = `
    <h2 class="section-heading" id="detailed-findings-rule">Detailed Findings by Rule Type</h2>
    <input type="text" class="search-filter" id="findingsFilter" placeholder="Search violations by name, rule ID, or description..." aria-label="Filter violation cards">
  `;

  for (const [principle, desc] of Object.entries(principleDescriptions)) {
    const items = grouped[principle] || [];
    html += `<h3 class="sub-heading">${escapeHtml(principle)}</h3>`;
    html += `<p>${escapeHtml(desc)}</p>`;

    if (items.length === 0) {
      html += '<p><em>No violations found in this category.</em></p>';
      continue;
    }

    // Sort by confidence (high first = confirmed issues at top), then by severity
    const confPriority = { high: 0, medium: 1, low: 2 };
    items.sort((a, b) => {
      const confA = confPriority[a._confidence] ?? 1;
      const confB = confPriority[b._confidence] ?? 1;
      if (confA !== confB) return confA - confB;
      return severityPriority(a.impact) - severityPriority(b.impact);
    });

    for (const v of items) {
      html += renderViolationCard(v);
    }
  }

  return html;
}

/**
 * Render a single violation card for Section 7.
 */
function renderViolationCard(violation) {
  const impact = violation.impact || 'minor';
  const nodes = violation.nodes || [];
  const wcag = extractWcagCriteria(violation.tags);
  const wcagDetails = getWcagDetails(violation.tags);
  const viewport = violation._viewport || 'both';
  const ruleId = violation.id;
  const remediation = remediationData[ruleId];
  const fpNote = falsePositives[ruleId];

  // Confidence badge
  const confidence = violation._confidence || 'medium';
  let confLabel, confClass;
  if (confidence === 'high') {
    confLabel = 'Confirmed';
    confClass = 'badge-confirmed';
  } else if (confidence === 'medium') {
    confLabel = 'Likely';
    confClass = 'badge-review';
  } else {
    confLabel = 'Needs Verification';
    confClass = 'badge-needs-verification';
  }

  // Best practice badge (advisory, not strict WCAG failure)
  const isBestPractice = violation._isBestPractice || false;
  const bestPracticeBadge = isBestPractice
    ? '<span class="badge badge-best-practice">Best Practice</span>'
    : '';

  // Card heading
  let html = `
    <div class="card violation-card" data-rule="${escapeHtml(ruleId)}" id="rule-${escapeHtml(ruleId)}">
      <h4 class="card-heading">
        <span class="badge badge-${impact}">${escapeHtml(impact)}</span>
        <span class="badge ${confClass}">${confLabel}</span>
        ${bestPracticeBadge}
        ${escapeHtml(violation.help || ruleId)}
      </h4>

      <table>
        <thead><tr><th>Severity</th><th>Confidence</th><th>Affected Elements</th><th>WCAG Criteria</th><th>Viewport(s)</th></tr></thead>
        <tbody><tr>
          <td><span class="badge badge-${impact}">${escapeHtml(impact)}</span></td>
          <td><span class="badge ${confClass}">${confLabel}</span></td>
          <td>${nodes.length}</td>
          <td>${escapeHtml(wcag) || 'N/A'}</td>
          <td>${escapeHtml(viewport)}</td>
        </tr></tbody>
      </table>

      <p>${escapeHtml(violation.description || '')}</p>`;

  // WCAG Success Criterion details
  if (wcagDetails.length > 0) {
    html += '<div class="wcag-sc-list">';
    for (const sc of wcagDetails) {
      const levelClass = sc.level === 'AA' ? 'badge-level-aa' : 'badge-level-a';
      html += `
        <div class="wcag-sc-item">
          <span class="sc-number">${escapeHtml(sc.sc)}</span>
          <span class="badge ${levelClass}">Level ${escapeHtml(sc.level)}</span>
          <div>
            <span class="sc-name">${escapeHtml(sc.name)}</span>
            <span style="color:#6b7280;"> &mdash; ${escapeHtml(sc.guideline)}</span>
            ${sc.legalRelevance ? `<div class="sc-legal">${escapeHtml(sc.legalRelevance)}</div>` : ''}
          </div>
        </div>`;
    }
    html += '</div>';
  }

  // "Why This Matters" block
  if (remediation && remediation.explanation) {
    html += `
      <div class="callout-why">
        <strong>Why This Matters</strong>
        ${escapeHtml(remediation.explanation)}
      </div>`;
  } else {
    html += `
      <div class="callout-why">
        <strong>Why This Matters</strong>
        This accessibility issue creates barriers for users who rely on assistive technologies
        such as screen readers, voice controls, or keyboard-only navigation. Fixing it improves
        the experience for all users and helps meet WCAG 2.2 Level AA conformance requirements.
      </div>`;
  }

  // Affected elements (capped at 10)
  const maxElements = 10;
  const displayNodes = nodes.slice(0, maxElements);
  const remaining = nodes.length - maxElements;

  if (displayNodes.length > 0) {
    html += `<details><summary>Affected Elements (${nodes.length})</summary>`;
    for (const node of displayNodes) {
      const selector = formatTarget(node.target);
      const snippet = node.html || '';
      const fix = buildFailureSummary(node);
      html += `
        <div class="element-item">
          <div class="element-selector"><code>${escapeHtml(selector)}</code></div>
          ${snippet ? `<pre>${escapeHtml(snippet)}</pre>` : ''}
          ${fix ? `<p><strong>Fix:</strong> ${escapeHtml(fix)}</p>` : ''}
        </div>`;
    }
    if (remaining > 0) {
      html += `<p><em>+${remaining} more affected element${remaining !== 1 ? 's' : ''}</em></p>`;
    }
    html += '</details>';
  }

  // Before/After Code Example
  if (remediation && remediation.before && remediation.after) {
    html += `
      <details><summary>Before/After Code Example</summary>
        <div class="code-compare">
          <div class="code-before">
            <div class="code-label">Before (Issue)</div>
            <pre>${escapeHtml(remediation.before)}</pre>
          </div>
          <div class="code-after">
            <div class="code-label">After (Fixed)</div>
            <pre>${escapeHtml(remediation.after)}</pre>
          </div>
        </div>
      </details>`;
  }

  // Recommended Fix
  const helpUrl = violation.helpUrl || '';
  html += `
    <div class="callout-fix">
      <strong>Recommended Fix</strong>
      ${escapeHtml(violation.help || 'Review the flagged elements and apply the appropriate remediation.')}
      ${helpUrl ? `<br><a href="${safeHref(helpUrl)}" target="_blank" rel="noopener">Learn more at Deque University</a>` : ''}
    </div>`;

  // False positive note
  if (fpNote) {
    html += `
      <div class="callout-fp">
        <strong>Potential False Positive</strong>
        ${escapeHtml(fpNote)}
      </div>`;
  }

  // Screenshot
  // Check if any nodes have screenshots at page level — this is embedded at page level, handled in section 8
  // Individual violation screenshots are less common; we check nodes for any attached screenshot data
  // (In practice screenshots are per-page via scanResult.pages[].desktop.screenshot)

  html += '</div>'; // close .card
  return html;
}

/**
 * Section 8: Detailed Findings by Page
 */
function renderDetailedFindingsByPage(scanResult) {
  const pages = scanResult.pages || [];
  if (pages.length === 0) {
    return `
      <h2 class="section-heading" id="detailed-findings-page">Detailed Findings by Page</h2>
      <p>No page data available.</p>
    `;
  }

  let html = `<h2 class="section-heading" id="detailed-findings-page">Detailed Findings by Page</h2>`;

  // Page summary table (for multi-page scans)
  if (pages.length > 1) {
    html += `
      <table>
        <thead><tr><th>Page</th><th>Score</th><th>Violations</th><th>Critical</th><th>Serious</th></tr></thead>
        <tbody>`;
    pages.forEach((page, i) => {
      const pageViolations = page.combined?.violations || [];
      const pagePasses = page.combined?.passes || [];
      const pageScore = calculateOverallScore(pageViolations, pagePasses);
      let scoreBg = '#dc2626';
      if (pageScore >= 80) scoreBg = '#16a34a';
      else if (pageScore >= 50) scoreBg = '#ca8a04';
      const critCount = countBySeverity(pageViolations, 'critical');
      const seriousCount = countBySeverity(pageViolations, 'serious');
      html += `
        <tr>
          <td><a href="#page-${i}">${escapeHtml(safePathname(page.url))}</a></td>
          <td><span style="color:${scoreBg};font-weight:700;">${pageScore}/100</span></td>
          <td>${pageViolations.length}</td>
          <td>${critCount > 0 ? '<span class="badge badge-critical">' + critCount + '</span>' : '0'}</td>
          <td>${seriousCount > 0 ? '<span class="badge badge-serious">' + seriousCount + '</span>' : '0'}</td>
        </tr>`;
    });
    html += '</tbody></table>';
  }

  pages.forEach((page, pageIndex) => {
    const pageUrl = page.url || 'Unknown';
    const violations = page.combined?.violations || [];
    const passes = page.combined?.passes || [];
    const sevCounts = { critical: 0, serious: 0, moderate: 0, minor: 0 };

    for (const v of violations) {
      for (const n of (v.nodes || [])) {
        const imp = n.impact || v.impact || 'minor';
        if (sevCounts.hasOwnProperty(imp)) sevCounts[imp]++;
      }
    }

    // Per-page score
    const pageScore = calculateOverallScore(violations, passes);
    let scoreBg = '#dc2626';
    if (pageScore >= 80) scoreBg = '#16a34a';
    else if (pageScore >= 50) scoreBg = '#ca8a04';

    const totalElements = Object.values(sevCounts).reduce((a, b) => a + b, 0);

    html += `
      <h3 class="sub-heading" id="page-${pageIndex}">${escapeHtml(pageUrl)}</h3>

      <div style="display:flex; align-items:center; gap:16px; margin-bottom:16px; flex-wrap:wrap;">
        <div style="text-align:center; padding:12px 24px; border-radius:10px; background:${scoreBg}; color:#fff; min-width:80px;">
          <div style="font-size:1.8rem; font-weight:800; line-height:1;">${pageScore}</div>
          <div style="font-size:0.75rem; opacity:0.9;">/ 100</div>
        </div>
        <div>
          <p style="margin:0;"><strong>${violations.length}</strong> violation${violations.length !== 1 ? 's' : ''}
            affecting <strong>${totalElements}</strong> element${totalElements !== 1 ? 's' : ''}</p>
          <p style="margin:4px 0 0;">
            <span class="badge badge-critical">Critical: ${sevCounts.critical}</span>
            <span class="badge badge-serious">Serious: ${sevCounts.serious}</span>
            <span class="badge badge-moderate">Moderate: ${sevCounts.moderate}</span>
            <span class="badge badge-minor">Minor: ${sevCounts.minor}</span>
          </p>
        </div>
      </div>
    `;

    // Compact violation list
    if (violations.length > 0) {
      html += '<div>';
      for (const v of violations) {
        const nodeCount = (v.nodes || []).length;
        html += `
          <div class="violation-compact">
            <span class="badge badge-${v.impact || 'minor'}">${escapeHtml(v.impact || 'minor')}</span>
            <span><a href="#rule-${escapeHtml(v.id)}">${escapeHtml(v.help || v.id)}</a></span>
            <span style="color:#666; margin-left:auto;">${nodeCount} element${nodeCount !== 1 ? 's' : ''}</span>
          </div>`;
      }
      html += '</div>';
    } else {
      html += '<p style="color:#16a34a; font-weight:600;">No violations detected on this page.</p>';
    }

    // Screenshots — embed desktop and mobile, with multi-region support
    const desktopShot = page.desktop?.screenshot;
    const mobileShot = page.mobile?.screenshot;

    if (desktopShot || mobileShot) {
      html += renderScreenshots(desktopShot, mobileShot, pageUrl);
    }
  });

  return html;
}

function countBySeverity(violations, severity) {
  let count = 0;
  for (const v of violations) {
    for (const n of (v.nodes || [])) {
      if ((n.impact || v.impact || 'minor') === severity) count++;
    }
  }
  return count;
}

/**
 * Section 9: Color Contrast Analysis
 */
function renderColorContrastAnalysis(scanResult) {
  const violations = scanResult.allViolations || [];
  const contrastViolations = violations.filter((v) => v.id === 'color-contrast');

  let html = `<h2 class="section-heading" id="color-contrast">Color Contrast Analysis</h2>`;

  if (contrastViolations.length === 0) {
    html += '<p>No color contrast violations were detected. All tested text elements meet WCAG 2.2 Level AA contrast requirements.</p>';
    return html;
  }

  html += '<p>The following elements have insufficient color contrast ratios, making text difficult to read for users with low vision or color vision deficiencies.</p>';

  for (const v of contrastViolations) {
    for (const node of (v.nodes || [])) {
      const selector = formatTarget(node.target);

      // Extract color data from node.any
      let fgColor = null;
      let bgColor = null;
      let contrastRatio = null;
      let requiredRatio = null;
      let fontSize = null;
      let fontWeight = null;

      for (const check of (node.any || [])) {
        if (check.data) {
          fgColor = fgColor || check.data.fgColor;
          bgColor = bgColor || check.data.bgColor;
          contrastRatio = contrastRatio || check.data.contrastRatio;
          requiredRatio = requiredRatio || check.data.expectedContrastRatio;
          fontSize = fontSize || check.data.fontSize;
          fontWeight = fontWeight || check.data.fontWeight;
        }
      }

      // Also check node.all and node.none
      for (const check of [...(node.all || []), ...(node.none || [])]) {
        if (check.data) {
          fgColor = fgColor || check.data.fgColor;
          bgColor = bgColor || check.data.bgColor;
          contrastRatio = contrastRatio || check.data.contrastRatio;
          requiredRatio = requiredRatio || check.data.expectedContrastRatio;
        }
      }

      const ratioDisplay = contrastRatio ? `${Number(contrastRatio).toFixed(2)}:1` : 'Unknown';
      const reqDisplay = requiredRatio ? `${requiredRatio}:1` : '4.5:1';
      const passFail = contrastRatio && requiredRatio && contrastRatio >= requiredRatio;

      html += `
        <div class="card">
          <div class="element-selector"><code>${escapeHtml(selector)}</code></div>
          <div class="swatch-pair">`;

      if (fgColor) {
        html += `<div class="swatch" style="background:${escapeHtml(fgColor)}" title="Foreground: ${escapeHtml(fgColor)}"></div>
                 <span class="swatch-label">Foreground: ${escapeHtml(fgColor)}</span>`;
      }
      html += '</div><div class="swatch-pair">';
      if (bgColor) {
        html += `<div class="swatch" style="background:${escapeHtml(bgColor)}" title="Background: ${escapeHtml(bgColor)}"></div>
                 <span class="swatch-label">Background: ${escapeHtml(bgColor)}</span>`;
      }
      html += '</div>';

      html += `
          <p>
            <strong>Contrast Ratio:</strong> ${escapeHtml(ratioDisplay)}
            &mdash; requires ${escapeHtml(reqDisplay)}
            <span class="badge ${passFail ? 'badge-pass' : 'badge-critical'}">${passFail ? 'Pass' : 'Fail'}</span>
          </p>`;

      if (fontSize || fontWeight) {
        html += `<p style="font-size:0.85rem;color:#666;">Font: ${fontSize ? escapeHtml(fontSize) : ''} ${fontWeight ? '/ weight ' + escapeHtml(String(fontWeight)) : ''}</p>`;
      }

      if (node.html) {
        html += `<pre>${escapeHtml(node.html)}</pre>`;
      }

      html += '</div>';
    }
  }

  return html;
}

/**
 * Section 10: ARIA Analysis Summary
 */
function renderAriaAnalysis(scanResult) {
  const violations = scanResult.allViolations || [];
  const ariaViolations = violations.filter((v) => v.id && v.id.includes('aria'));

  let html = `<h2 class="section-heading" id="aria-analysis">ARIA Analysis Summary</h2>`;

  html += '<div class="callout-aria">';

  if (ariaViolations.length === 0) {
    html += '<p><strong>No ARIA-related violations detected.</strong> ARIA attributes are being used correctly across the scanned pages.</p>';
    html += '</div>';
    return html;
  }

  // Count + severity breakdown
  const sevCounts = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  let totalNodes = 0;
  for (const v of ariaViolations) {
    for (const n of (v.nodes || [])) {
      const imp = n.impact || v.impact || 'minor';
      if (sevCounts.hasOwnProperty(imp)) sevCounts[imp]++;
      totalNodes++;
    }
  }

  html += `
    <p><strong>${ariaViolations.length} ARIA-related violation${ariaViolations.length !== 1 ? 's' : ''}</strong>
    affecting <strong>${totalNodes}</strong> element${totalNodes !== 1 ? 's' : ''} were found.</p>
    <p>
      <span class="badge badge-critical">Critical: ${sevCounts.critical}</span>
      <span class="badge badge-serious">Serious: ${sevCounts.serious}</span>
      <span class="badge badge-moderate">Moderate: ${sevCounts.moderate}</span>
      <span class="badge badge-minor">Minor: ${sevCounts.minor}</span>
    </p>
    <ul class="clean-list">`;

  for (const v of ariaViolations) {
    html += `<li><a href="#rule-${escapeHtml(v.id)}">${escapeHtml(v.help || v.id)}</a>
      <span class="badge badge-${v.impact || 'minor'}">${escapeHtml(v.impact || 'minor')}</span>
      (${(v.nodes || []).length} elements)</li>`;
  }

  html += '</ul></div>';
  return html;
}

/**
 * Section 11: Manual Review Items
 */
function renderManualReview(scanResult) {
  const incomplete = scanResult.allIncomplete || [];

  let html = `<h2 class="section-heading" id="manual-review">Manual Review Items</h2>`;

  html += `
    <div class="callout-manual">
      <strong>Note:</strong> These items could not be automatically verified and require human review.
      Automated tools can detect the <em>presence</em> of certain patterns but cannot always determine
      whether they are implemented correctly in context.
    </div>`;

  if (incomplete.length === 0) {
    html += '<p>No items requiring manual review were identified.</p>';
    return html;
  }

  for (const item of incomplete) {
    const nodeCount = (item.nodes || []).length;
    html += `
      <div class="callout-manual" style="padding:14px 18px;">
        <strong>${escapeHtml(item.help || item.id)}</strong>
        <span class="badge badge-${item.impact || 'moderate'}" style="margin-left:8px;">${escapeHtml(item.impact || 'moderate')}</span>
        <p style="margin:6px 0 0;font-size:0.9rem;">${escapeHtml(item.description || '')}
        (${nodeCount} element${nodeCount !== 1 ? 's' : ''} to review)</p>
        ${item.helpUrl ? `<p style="margin:4px 0 0;"><a href="${safeHref(item.helpUrl)}" target="_blank" rel="noopener">Learn more</a></p>` : ''}
      </div>`;
  }

  return html;
}

/**
 * Section 12: Passed Checks Summary
 */
function renderPassedChecks(scanResult) {
  const passes = scanResult.allPasses || [];

  let html = `<h2 class="section-heading" id="passed-checks">Passed Checks Summary</h2>`;
  html += '<div class="muted-section">';

  if (passes.length === 0) {
    html += '<p>No passed checks recorded.</p></div>';
    return html;
  }

  html += `
    <table>
      <thead><tr><th>Rule</th><th>Description</th><th>Elements Passed</th></tr></thead>
      <tbody>`;

  for (const p of passes) {
    const nodeCount = (p.nodes || []).length;
    html += `
      <tr>
        <td>${escapeHtml(p.id)}</td>
        <td>${escapeHtml(p.description || p.help || '')}</td>
        <td>${nodeCount}</td>
      </tr>`;
  }

  html += '</tbody></table></div>';
  return html;
}

/**
 * Section 13: Prioritized Action Plan
 */
function renderActionPlan(scanResult) {
  const violations = scanResult.allViolations || [];

  let html = `<h2 class="section-heading" id="action-plan">Prioritized Action Plan</h2>`;

  if (violations.length === 0) {
    html += '<p>No violations found. No remediation actions are required at this time.</p>';
    return html;
  }

  // Sort by severity
  const sorted = [...violations].sort((a, b) => severityPriority(a.impact) - severityPriority(b.impact));

  html += `
    <table>
      <thead><tr><th>Priority</th><th>Task</th><th>Business Impact</th><th>Effort</th><th>Severity</th></tr></thead>
      <tbody>`;

  sorted.forEach((v, i) => {
    const impact = v.impact || 'minor';
    const nodeCount = (v.nodes || []).length;
    const effort = estimateEffort(v.id, nodeCount);

    let businessImpact = '';
    switch (impact) {
      case 'critical':
        businessImpact = 'Blocks access for users with disabilities; high litigation risk';
        break;
      case 'serious':
        businessImpact = 'Significant barrier to assistive technology users';
        break;
      case 'moderate':
        businessImpact = 'Creates friction for users with disabilities';
        break;
      case 'minor':
        businessImpact = 'Minor usability issue; improves overall experience';
        break;
      default:
        businessImpact = 'Review for impact';
    }

    html += `
      <tr>
        <td>${i + 1}</td>
        <td>${escapeHtml(v.help || v.id)} (${nodeCount} element${nodeCount !== 1 ? 's' : ''})</td>
        <td>${escapeHtml(businessImpact)}</td>
        <td>${escapeHtml(typeof effort === 'string' ? effort : 'Medium')}</td>
        <td><span class="badge badge-${impact}">${escapeHtml(impact)}</span></td>
      </tr>`;
  });

  html += '</tbody></table>';
  return html;
}

/**
 * Section 14: Draft Accessibility Compliance Statement
 */
function renderComplianceStatement(scanResult, scores) {
  const dateStr = formatDate(scanResult.scanDate);
  const url = escapeHtml(scanResult.url);
  const overall = scores.overall;
  const violations = scanResult.allViolations || [];
  const passes = scanResult.allPasses || [];

  // Conformance areas
  let conformanceAreas = '';
  if (passes.length > 0) {
    conformanceAreas = '<h3 class="sub-heading">Areas of Conformance</h3><ul class="clean-list">';
    const topPasses = passes.slice(0, 10);
    for (const p of topPasses) {
      conformanceAreas += `<li>${escapeHtml(p.help || p.description || p.id)}</li>`;
    }
    if (passes.length > 10) {
      conformanceAreas += `<li><em>...and ${passes.length - 10} additional passing checks</em></li>`;
    }
    conformanceAreas += '</ul>';
  }

  // Known non-conformance
  let nonConformanceAreas = '';
  if (violations.length > 0) {
    nonConformanceAreas = '<h3 class="sub-heading">Known Non-Conformance Areas</h3><ul class="clean-list">';
    for (const v of violations) {
      const wcag = extractWcagCriteria(v.tags);
      nonConformanceAreas += `<li>${escapeHtml(v.help || v.id)}${wcag ? ' (WCAG ' + escapeHtml(wcag) + ')' : ''}</li>`;
    }
    nonConformanceAreas += '</ul>';
  }

  return `
    <h2 class="section-heading" id="compliance-statement">Draft Accessibility Compliance Statement</h2>

    <div class="card">
      <p>Based on automated testing conducted on <strong>${escapeHtml(dateStr)}</strong>,
      <strong>${url}</strong> has been evaluated against WCAG 2.2 Level AA success criteria.</p>

      <p>The automated compliance score is <strong>${overall}/100</strong>.
      ${violations.length > 0
        ? `A total of <strong>${violations.length}</strong> rule violation${violations.length !== 1 ? 's' : ''} were identified, affecting multiple elements across the scanned pages.`
        : 'No automated violations were detected.'
      }</p>

      ${conformanceAreas}
      ${nonConformanceAreas}

      <div class="callout-fp">
        <strong>Disclaimer</strong>
        This statement is based on automated testing only using axe-core and does not constitute a
        complete accessibility audit. Automated tools typically detect 30&ndash;40% of all WCAG
        conformance issues. Manual testing with assistive technologies is recommended for full
        conformance evaluation. This report should not be interpreted as legal advice.
      </div>
    </div>
  `;
}

/**
 * Section 15: Appendix
 */
function renderAppendix(scanResult) {
  const axeVersion = scanResult.testEngine?.version || 'unknown';

  return `
    <h2 class="section-heading" id="appendix">Appendix</h2>

    <!-- A. Glossary -->
    <h3 class="sub-heading">A. Glossary</h3>
    <table>
      <thead><tr><th>Term</th><th>Definition</th></tr></thead>
      <tbody>
        <tr><td><strong>WCAG</strong></td><td>Web Content Accessibility Guidelines &mdash; an international standard for web accessibility published by the W3C.</td></tr>
        <tr><td><strong>ARIA</strong></td><td>Accessible Rich Internet Applications &mdash; a set of HTML attributes that define ways to make web content more accessible to people with disabilities.</td></tr>
        <tr><td><strong>Alt Text</strong></td><td>Alternative text &mdash; a text description for images that is read aloud by screen readers and displayed when images cannot load.</td></tr>
        <tr><td><strong>Screen Reader</strong></td><td>Assistive technology software that reads digital content aloud, used by people who are blind or have low vision.</td></tr>
        <tr><td><strong>POUR</strong></td><td>Perceivable, Operable, Understandable, Robust &mdash; the four foundational principles of WCAG.</td></tr>
        <tr><td><strong>Assistive Technology</strong></td><td>Hardware or software used by people with disabilities to interact with digital content (e.g., screen readers, switch devices, eye-tracking systems).</td></tr>
        <tr><td><strong>Landmark</strong></td><td>An HTML region (such as &lt;header&gt;, &lt;nav&gt;, &lt;main&gt;, &lt;footer&gt;) that helps assistive technology users navigate to major sections of a page.</td></tr>
        <tr><td><strong>Focus</strong></td><td>The visual and programmatic indicator showing which interactive element is currently selected for keyboard input.</td></tr>
        <tr><td><strong>Tab Order</strong></td><td>The sequence in which focusable elements receive keyboard focus when the user presses the Tab key.</td></tr>
        <tr><td><strong>Color Contrast Ratio</strong></td><td>The relative luminance difference between foreground text and its background. WCAG AA requires at least 4.5:1 for normal text and 3:1 for large text.</td></tr>
        <tr><td><strong>Semantic HTML</strong></td><td>Using HTML elements according to their intended purpose (e.g., &lt;button&gt; for buttons, &lt;nav&gt; for navigation) so assistive technologies can understand the content structure.</td></tr>
      </tbody>
    </table>

    <!-- B. Tools Used -->
    <h3 class="sub-heading">B. Tools Used</h3>
    <table>
      <thead><tr><th>Tool</th><th>Version</th><th>Purpose</th></tr></thead>
      <tbody>
        <tr><td>AutoADA</td><td>1.0.0</td><td>Automated WCAG compliance scanning and reporting framework</td></tr>
        <tr><td>axe-core</td><td>${escapeHtml(axeVersion)}</td><td>WCAG rule engine by Deque Systems</td></tr>
        <tr><td>Puppeteer</td><td>Bundled</td><td>Headless Chrome browser automation for page rendering and analysis</td></tr>
      </tbody>
    </table>

    <!-- C. WCAG Quick Reference -->
    <h3 class="sub-heading">C. WCAG Quick Reference</h3>
    <table>
      <thead><tr><th>Level</th><th>Description</th></tr></thead>
      <tbody>
        <tr>
          <td><strong>Level A</strong></td>
          <td>The minimum level of conformance. Addresses the most fundamental accessibility barriers
          that would otherwise make content completely inaccessible to some users. Examples include
          providing text alternatives for images and ensuring all functionality is keyboard-accessible.</td>
        </tr>
        <tr>
          <td><strong>Level AA</strong></td>
          <td>The target level for most organizations and the standard referenced by the ADA and
          Section 508. Includes all Level A requirements plus additional criteria such as sufficient
          color contrast (4.5:1), visible focus indicators, and consistent navigation. This is the
          level evaluated in this report.</td>
        </tr>
        <tr>
          <td><strong>Level AAA</strong></td>
          <td>The highest level of conformance. Includes enhanced requirements such as sign language
          interpretation for video content, higher contrast ratios (7:1), and extended audio descriptions.
          While not typically required, individual AAA criteria can significantly improve usability.</td>
        </tr>
      </tbody>
    </table>

    <!-- D. Next Steps -->
    <h3 class="sub-heading">D. Next Steps</h3>
    <ol>
      <li><strong>Address Critical and Serious Violations:</strong> Begin remediation with the highest-severity
      issues identified in this report. These create the most significant barriers for users with disabilities.</li>
      <li><strong>Conduct Manual Testing:</strong> Perform keyboard-only navigation testing and screen reader
      testing (NVDA on Windows, VoiceOver on macOS/iOS, TalkBack on Android) to identify issues that
      automated tools cannot detect.</li>
      <li><strong>Usability Testing with Assistive Technology Users:</strong> Engage people with disabilities
      to test the website and provide direct feedback on the experience.</li>
      <li><strong>Re-Audit in 90 Days:</strong> After implementing fixes, run a follow-up automated scan to
      measure progress and identify any regressions.</li>
      <li><strong>Integrate Accessibility into Development Workflow:</strong> Add axe-core or similar
      tools to CI/CD pipelines, establish accessibility code review checklists, and provide developer
      training on WCAG requirements.</li>
      <li><strong>Publish an Accessibility Statement:</strong> Use the draft in this report as a starting
      point for a public accessibility statement on the website.</li>
    </ol>
  `;
}

// ---------------------------------------------------------------------------
// Progressive enhancement script
// ---------------------------------------------------------------------------

function generateScript() {
  return `
  <script>
  (function() {
    'use strict';

    // Smooth details animation
    document.querySelectorAll('details').forEach(function(detail) {
      var summary = detail.querySelector('summary');
      if (!summary) return;
      var content = detail.querySelector('summary ~ *');
      if (!content) return;

      summary.addEventListener('click', function(e) {
        if (detail.open) {
          // Closing
          var inner = detail.querySelector('.details-inner');
          if (inner) {
            inner.style.maxHeight = inner.scrollHeight + 'px';
            requestAnimationFrame(function() {
              inner.style.maxHeight = '0';
              inner.style.opacity = '0';
            });
          }
        }
      });

      // Wrap content for animation
      if (!detail.querySelector('.details-inner')) {
        var wrapper = document.createElement('div');
        wrapper.className = 'details-inner';
        wrapper.style.overflow = 'hidden';
        wrapper.style.transition = 'max-height 0.3s ease, opacity 0.2s ease';
        var children = [];
        var node = summary.nextSibling;
        while (node) {
          children.push(node);
          node = node.nextSibling;
        }
        children.forEach(function(c) { wrapper.appendChild(c); });
        detail.appendChild(wrapper);
      }
    });

    // Search/filter for Section 7 violation cards
    var filterInput = document.getElementById('findingsFilter');
    if (filterInput) {
      filterInput.addEventListener('input', function() {
        var query = this.value.toLowerCase().trim();
        var cards = document.querySelectorAll('.violation-card');
        cards.forEach(function(card) {
          if (!query) {
            card.style.display = '';
            return;
          }
          var text = card.textContent.toLowerCase();
          var ruleId = (card.getAttribute('data-rule') || '').toLowerCase();
          card.style.display = (text.indexOf(query) !== -1 || ruleId.indexOf(query) !== -1) ? '' : 'none';
        });
      });
    }
  })();
  </script>`;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Generate a comprehensive, self-contained HTML accessibility compliance report.
 *
 * @param {object} scanResult - Full scan result from the scanner engine.
 * @param {object} scores - Calculated compliance scores from score.js.
 * @param {object} [options={}] - Report options.
 * @param {string} [options.clientName] - Client or organization name.
 * @param {string} [options.clientLogoBase64] - Base64-encoded client logo (PNG).
 * @param {string} [options.clientColor] - Accent color hex (e.g., '#ff6600').
 * @returns {string} Complete self-contained HTML document.
 */
function generateHtml(scanResult, scores, options = {}) {
  const accentColor = options.clientColor || '#4295f6';

  const sections = [
    renderCoverPage(scanResult, options),
    renderTableOfContents(scanResult),
    renderExecutiveSummary(scanResult, scores),
    renderMethodology(scanResult),
    renderComplianceOverview(scanResult, scores),
    renderDesktopMobileComparison(scanResult),
    renderDetailedFindingsByRule(scanResult, scores),
    renderDetailedFindingsByPage(scanResult),
    renderColorContrastAnalysis(scanResult),
    renderAriaAnalysis(scanResult),
    renderManualReview(scanResult),
    renderPassedChecks(scanResult),
    renderActionPlan(scanResult),
    renderComplianceStatement(scanResult, scores),
    renderAppendix(scanResult),
  ];

  const body = sections.join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>ADA/WCAG Compliance Report &mdash; ${escapeHtml(options.clientName || getHostname(scanResult.url))}</title>
  <style>${generateStyles(accentColor)}</style>
</head>
<body>
  <div class="report-wrap">
    ${body}
  </div>
  ${generateScript()}
</body>
</html>`;
}

module.exports = { generateHtml };
