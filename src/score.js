/**
 * Compliance score calculation + benchmark context.
 */

const benchmarks = require('./data/benchmarks.json');

// axe-core category tags → WCAG principle mapping
const CATEGORY_TO_PRINCIPLE = {
  'cat.text-alternatives': 'Perceivable',
  'cat.time-and-media': 'Perceivable',
  'cat.adaptable': 'Perceivable',
  'cat.distinguishable': 'Perceivable',
  'cat.color': 'Perceivable',
  'cat.sensory-and-visual-cues': 'Perceivable',
  'cat.keyboard': 'Operable',
  'cat.time-limits': 'Operable',
  'cat.seizures': 'Operable',
  'cat.navigation': 'Operable',
  'cat.readable': 'Understandable',
  'cat.predictable': 'Understandable',
  'cat.input-assistance': 'Understandable',
  'cat.forms': 'Understandable',
  'cat.parsing': 'Robust',
  'cat.compatible': 'Robust',
  'cat.name-role-value': 'Robust',
  'cat.structure': 'Robust',
  'cat.semantics': 'Robust',
  'cat.aria': 'Robust',
  'cat.language': 'Understandable',
  'cat.tables': 'Perceivable',
};

const SEVERITY_WEIGHTS = {
  critical: 10,
  serious: 5,
  moderate: 2,
  minor: 1,
};

// Confidence-based weighting — low-confidence violations (likely false positives)
// contribute much less to the score than confirmed violations.
const CONFIDENCE_WEIGHTS = {
  high: 1.0,    // Deterministic rules (html-has-lang, document-title, etc.)
  medium: 0.6,  // Moderate FP rate (heading-order, region, label, etc.)
  low: 0.15,    // High FP rate (color-contrast, etc.) — barely affects score
};

// Best-practice violations are advisory (not strict WCAG failures),
// so they penalize the score less than WCAG-mapped violations.
const BEST_PRACTICE_WEIGHT = 0.5;

/**
 * Calculate overall compliance score (0-100).
 *
 * Uses a node-count-weighted approach:
 * - Base: weighted pass rate where each rule is weighted by the number of
 *   elements it affects. Violations are further weighted by severity.
 *   This prevents a single rule with 500 affected elements from being
 *   treated the same as a rule affecting 1 element.
 * - Penalty: logarithmic severity deduction to prevent a handful of
 *   repeated violations from cratering the score.
 */
function calculateOverallScore(violations, passes) {
  const violationList = violations || [];
  const passList = passes || [];

  if (violationList.length === 0 && passList.length === 0) return 100;

  // Weight each violation by node count × confidence × best-practice factor
  // (severity is handled separately in penalty)
  let weightedViolations = 0;
  for (const v of violationList) {
    const nodeCount = v.nodes ? v.nodes.length : 1;
    const confWeight = CONFIDENCE_WEIGHTS[v._confidence] || 0.6;
    const bpWeight = v._isBestPractice ? BEST_PRACTICE_WEIGHT : 1.0;
    weightedViolations += nodeCount * confWeight * bpWeight;
  }

  // Weight each pass by node count
  let weightedPasses = 0;
  for (const p of passList) {
    const nodeCount = p.nodes ? p.nodes.length : 1;
    weightedPasses += nodeCount;
  }

  const totalWeighted = weightedViolations + weightedPasses;
  if (totalWeighted === 0) return 100;

  // Base score from weighted pass rate
  const passRate = weightedPasses / totalWeighted;
  const baseScore = passRate * 100;

  // Severity penalty (logarithmically scaled, confidence-weighted, best-practice-adjusted)
  let rawPenalty = 0;
  for (const v of violationList) {
    const severity = v.impact || 'minor';
    const weight = SEVERITY_WEIGHTS[severity] || 1;
    const nodeCount = v.nodes ? v.nodes.length : 1;
    const confWeight = CONFIDENCE_WEIGHTS[v._confidence] || 0.6;
    const bpWeight = v._isBestPractice ? BEST_PRACTICE_WEIGHT : 1.0;
    // Log scale: first instance counts full, additional instances have diminishing impact
    rawPenalty += weight * (1 + Math.log2(nodeCount)) * confWeight * bpWeight;
  }

  // Scale penalty relative to total weighted count (more elements checked = more tolerance)
  const totalRules = violationList.length + passList.length;
  const scaledPenalty = Math.min(baseScore, (rawPenalty / Math.max(totalRules, 1)) * 25);

  return Math.max(0, Math.min(100, Math.round(baseScore - scaledPenalty)));
}

/**
 * Get severity breakdown counts.
 */
function getSeverityBreakdown(violations) {
  const counts = { critical: 0, serious: 0, moderate: 0, minor: 0, unknown: 0 };

  for (const v of violations) {
    for (const node of (v.nodes || [])) {
      const impact = node.impact || v.impact || 'minor';
      if (impact in counts) {
        counts[impact]++;
      } else {
        counts.unknown++;
      }
    }
  }

  return counts;
}

/**
 * Calculate per-WCAG-principle scores.
 * Groups violations, passes, and incomplete items by principle.
 */
function calculatePrincipleScores(violations, passes, incomplete) {
  const principles = {
    Perceivable: { violations: 0, passes: 0, needsReview: 0 },
    Operable: { violations: 0, passes: 0, needsReview: 0 },
    Understandable: { violations: 0, passes: 0, needsReview: 0 },
    Robust: { violations: 0, passes: 0, needsReview: 0 },
  };

  // Count violations per principle
  for (const v of violations) {
    const principle = getPrinciple(v.tags);
    if (principle && principles[principle]) {
      principles[principle].violations += v.nodes ? v.nodes.length : 1;
    }
  }

  // Count passes per principle
  for (const p of passes) {
    const principle = getPrinciple(p.tags);
    if (principle && principles[principle]) {
      principles[principle].passes += p.nodes ? p.nodes.length : 1;
    }
  }

  // Count incomplete (needs review) per principle
  for (const i of (incomplete || [])) {
    const principle = getPrinciple(i.tags);
    if (principle && principles[principle]) {
      principles[principle].needsReview += i.nodes ? i.nodes.length : 1;
    }
  }

  // Calculate scores (incomplete NOT counted as violations — they're ambiguous)
  const result = {};
  for (const [name, data] of Object.entries(principles)) {
    const total = data.violations + data.passes;
    const score = total > 0 ? Math.round((data.passes / total) * 100) : 100;
    let status = 'Good';
    if (score < 50) status = 'Critical';
    else if (score < 75) status = 'Needs Work';

    result[name] = {
      score,
      status,
      violations: data.violations,
      passes: data.passes,
      needsReview: data.needsReview,
      total,
    };
  }

  return result;
}

/**
 * Determine which WCAG principle a rule belongs to based on its tags.
 */
function getPrinciple(tags) {
  if (!tags) return 'Robust'; // Default fallback

  for (const tag of tags) {
    if (CATEGORY_TO_PRINCIPLE[tag]) {
      return CATEGORY_TO_PRINCIPLE[tag];
    }
  }

  // Try to infer from wcag criteria number (1.x = Perceivable, 2.x = Operable, 3.x = Understandable, 4.x = Robust)
  for (const tag of tags) {
    const match = tag.match(/^wcag(\d)/);
    if (match) {
      const principle = parseInt(match[1]);
      if (principle === 1) return 'Perceivable';
      if (principle === 2) return 'Operable';
      if (principle === 3) return 'Understandable';
      if (principle === 4) return 'Robust';
    }
  }

  return 'Robust'; // Default
}

/**
 * Generate benchmark interpretation text.
 */
function getBenchmarkContext(score, industry) {
  const avg = benchmarks.overall_average;
  const industryScore = industry ? benchmarks.by_industry[industry.toLowerCase()] : null;
  const compareTarget = industryScore || avg;
  const compareName = industryScore ? `the ${industry} industry average` : 'the overall industry average';

  const position = score >= compareTarget ? 'above' : 'below';
  const diff = Math.abs(score - compareTarget);

  // Find interpretation range
  let interpretation = '';
  for (const [range, data] of Object.entries(benchmarks.interpretation)) {
    const [low, high] = range.split('-').map(Number);
    if (score >= low && score <= high) {
      interpretation = data.description;
      break;
    }
  }

  // Find what the label/status is
  let label = '';
  for (const [range, data] of Object.entries(benchmarks.interpretation)) {
    const [low, high] = range.split('-').map(Number);
    if (score >= low && score <= high) {
      label = data.label;
      break;
    }
  }

  return {
    score,
    label,
    industryAverage: compareTarget,
    position,
    difference: diff,
    compareName,
    interpretation,
    summary: `Your score of ${score}/100 is ${diff} points ${position} ${compareName} of ${compareTarget}/100. ${interpretation}`,
  };
}

/**
 * Calculate all scores for a scan result.
 *
 * @param {object} scanResult - Full scan result from scanner
 * @param {string} [industry] - Industry category for benchmark comparison
 * @returns {object} Scores object
 */
function calculateScores(scanResult, industry) {
  const violations = scanResult.allViolations || scanResult.violations || [];
  const passes = scanResult.allPasses || scanResult.passes || [];
  const incomplete = scanResult.allIncomplete || scanResult.incomplete || [];

  const overall = calculateOverallScore(violations, passes);
  const severityBreakdown = getSeverityBreakdown(violations);
  const byPrinciple = calculatePrincipleScores(violations, passes, incomplete);
  const benchmarkContext = getBenchmarkContext(overall, industry);

  // Count incomplete (needs review) nodes
  const totalIncompleteNodes = incomplete.reduce(
    (acc, i) => acc + (i.nodes ? i.nodes.length : 0), 0
  );

  // Categorize violations by confidence level
  let confirmedViolations = 0;
  let needsReviewViolations = 0;
  let confirmedNodes = 0;
  let needsReviewNodes = 0;

  for (const v of violations) {
    const nodeCount = (v.nodes || []).length;
    if (v._confidence === 'low') {
      needsReviewViolations++;
      needsReviewNodes += nodeCount;
    } else {
      confirmedViolations++;
      confirmedNodes += nodeCount;
    }
  }

  return {
    overall,
    severityBreakdown,
    byPrinciple,
    benchmarkContext,
    totalViolations: violations.length,
    totalViolationNodes: Object.values(severityBreakdown).reduce((a, b) => a + b, 0),
    totalPasses: passes.length,
    totalIncomplete: incomplete.length,
    totalIncompleteNodes,
    confirmedViolations,
    needsReviewViolations,
    confirmedNodes,
    needsReviewNodes,
  };
}

module.exports = { calculateScores, calculateOverallScore, getPrinciple, CONFIDENCE_WEIGHTS };
