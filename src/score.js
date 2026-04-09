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

// Minimum score deduction per rule by severity tier — guarantees critical issues
// always have a large impact regardless of how many passes there are.
const SEVERITY_FLOOR_PENALTY = {
  critical: 8,
  serious: 4,
  moderate: 1.5,
  minor: 0.5,
};

/**
 * Calculate overall compliance score (0-100).
 *
 * Criticality-first approach:
 * - Base score: rule-level pass/fail ratio weighted by severity. A single
 *   critical failure weighs 10× more than a minor failure. Volume (node
 *   count) adds diminishing marginal impact via log₂ so 20 alt-text nodes
 *   never outweigh 1 keyboard trap.
 * - Severity penalty: each violated rule incurs a floor penalty by tier
 *   (critical ≥ 8 pts, serious ≥ 4 pts). Volume only adds log₂ on top.
 *   NOT divided by totalRules — a site with 10 critical issues pays 10×
 *   the penalty, not 1× diluted across rules.
 * - Capped at 0 minimum, 100 maximum.
 */
function calculateOverallScore(violations, passes) {
  const violationList = violations || [];
  const passList = passes || [];

  if (violationList.length === 0 && passList.length === 0) return 100;

  // --- Base score: severity-weighted rule pass rate ---
  // Each rule counts as its severity weight. Violations are further adjusted
  // by confidence and best-practice flags. Node count is intentionally NOT
  // used in the base score — severity of the rule type matters, not volume.
  let weightedViolations = 0;
  for (const v of violationList) {
    const severity = v.impact || 'minor';
    const sevWeight = SEVERITY_WEIGHTS[severity] || 1;
    const confWeight = CONFIDENCE_WEIGHTS[v._confidence] || 0.6;
    const bpWeight = v._isBestPractice ? BEST_PRACTICE_WEIGHT : 1.0;
    weightedViolations += sevWeight * confWeight * bpWeight;
  }

  // Passes are weighted uniformly at 1 per rule (severity only matters for failures)
  const weightedPasses = passList.length;

  const totalWeighted = weightedViolations + weightedPasses;
  if (totalWeighted === 0) return 100;

  const passRate = weightedPasses / totalWeighted;
  const baseScore = passRate * 100;

  // --- Severity penalty: floor penalty per rule + volume bonus via log₂ ---
  // Each violated rule gets at minimum its floor penalty (critical=8, serious=4, etc.)
  // Volume of affected nodes adds a small log₂ bonus on top — so 100 affected
  // elements hurts slightly more than 1, but the severity tier dominates.
  let totalPenalty = 0;
  for (const v of violationList) {
    const severity = v.impact || 'minor';
    const nodeCount = v.nodes ? v.nodes.length : 1;
    const confWeight = CONFIDENCE_WEIGHTS[v._confidence] || 0.6;
    const bpWeight = v._isBestPractice ? BEST_PRACTICE_WEIGHT : 1.0;

    // Floor penalty: guaranteed deduction per rule by severity tier
    const floor = SEVERITY_FLOOR_PENALTY[severity] || 0.5;
    // Volume bonus: diminishing marginal impact of additional affected nodes
    const volumeBonus = nodeCount > 1 ? Math.log2(nodeCount) * 0.5 : 0;

    totalPenalty += (floor + volumeBonus) * confWeight * bpWeight;
  }

  // Cap total penalty at baseScore (can't go below 0)
  const cappedPenalty = Math.min(baseScore, totalPenalty);

  return Math.max(0, Math.min(100, Math.round(baseScore - cappedPenalty)));
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
