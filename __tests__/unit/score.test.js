/**
 * Unit tests for src/score.js — scoring engine.
 */

const { calculateScores, calculateOverallScore, CONFIDENCE_WEIGHTS } = require('../../src/score');

describe('calculateOverallScore', () => {
  test('returns 100 when no violations and no passes', () => {
    expect(calculateOverallScore([], [])).toBe(100);
  });

  test('returns 100 when only passes, no violations', () => {
    const passes = [
      { id: 'rule-1', nodes: [{ target: ['#a'] }] },
      { id: 'rule-2', nodes: [{ target: ['#b'] }, { target: ['#c'] }] },
    ];
    expect(calculateOverallScore([], passes)).toBe(100);
  });

  test('returns < 100 when violations exist', () => {
    const violations = [
      { id: 'button-name', impact: 'critical', _confidence: 'high', nodes: [{ target: ['#btn1'] }] },
    ];
    const passes = [
      { id: 'rule-1', nodes: [{ target: ['#a'] }] },
    ];
    const score = calculateOverallScore(violations, passes);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThan(100);
  });

  test('handles null/undefined inputs gracefully', () => {
    expect(calculateOverallScore(null, null)).toBe(100);
    expect(calculateOverallScore(undefined, undefined)).toBe(100);
    expect(calculateOverallScore(null, [])).toBe(100);
  });

  test('low-confidence violations penalize less than high-confidence', () => {
    const passes = Array.from({ length: 10 }, (_, i) => ({
      id: `pass-${i}`,
      nodes: [{ target: [`#p${i}`] }],
    }));

    const highConfViolation = [{
      id: 'button-name', impact: 'serious', _confidence: 'high',
      nodes: [{ target: ['#btn'] }],
    }];

    const lowConfViolation = [{
      id: 'color-contrast', impact: 'serious', _confidence: 'low',
      nodes: [{ target: ['#txt'] }],
    }];

    const scoreHigh = calculateOverallScore(highConfViolation, passes);
    const scoreLow = calculateOverallScore(lowConfViolation, passes);

    // Low-confidence should result in a HIGHER score (less penalty)
    expect(scoreLow).toBeGreaterThan(scoreHigh);
  });

  test('score is always between 0 and 100', () => {
    const manyViolations = Array.from({ length: 50 }, (_, i) => ({
      id: `rule-${i}`, impact: 'critical', _confidence: 'high',
      nodes: Array.from({ length: 100 }, (_, j) => ({ target: [`#el-${i}-${j}`] })),
    }));
    const score = calculateOverallScore(manyViolations, []);
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
  });
});

describe('calculateScores', () => {
  test('returns full score structure with required fields', () => {
    const scanResult = {
      allViolations: [],
      allPasses: [{ id: 'rule-1', nodes: [{ target: ['#a'] }] }],
      allIncomplete: [],
    };
    const scores = calculateScores(scanResult);

    expect(scores).toHaveProperty('overall');
    expect(scores).toHaveProperty('severityBreakdown');
    expect(scores).toHaveProperty('byPrinciple');
    expect(scores).toHaveProperty('benchmarkContext');
    expect(scores).toHaveProperty('totalViolations');
    expect(scores).toHaveProperty('totalPasses');
    expect(scores).toHaveProperty('totalIncomplete');
    expect(scores).toHaveProperty('confirmedViolations');
    expect(scores).toHaveProperty('needsReviewViolations');
    expect(scores).toHaveProperty('confirmedNodes');
    expect(scores).toHaveProperty('needsReviewNodes');
  });

  test('severity breakdown counts elements correctly', () => {
    const scanResult = {
      allViolations: [
        { id: 'rule-1', impact: 'critical', tags: ['wcag2a'], nodes: [
          { target: ['#a'], impact: 'critical' },
          { target: ['#b'], impact: 'critical' },
        ]},
        { id: 'rule-2', impact: 'moderate', tags: ['wcag2aa'], nodes: [
          { target: ['#c'], impact: 'moderate' },
        ]},
      ],
      allPasses: [],
      allIncomplete: [],
    };
    const scores = calculateScores(scanResult);

    expect(scores.severityBreakdown.critical).toBe(2);
    expect(scores.severityBreakdown.moderate).toBe(1);
    expect(scores.severityBreakdown.minor).toBe(0);
    expect(scores.severityBreakdown.serious).toBe(0);
  });

  test('handles unknown impact gracefully (does not crash)', () => {
    const scanResult = {
      allViolations: [
        { id: 'rule-1', impact: 'banana', tags: ['wcag2a'], nodes: [
          { target: ['#a'], impact: 'banana' },
        ]},
      ],
      allPasses: [],
      allIncomplete: [],
    };
    // Should not throw
    const scores = calculateScores(scanResult);
    expect(scores).toHaveProperty('overall');
    expect(scores.overall).toBeGreaterThanOrEqual(0);
  });

  test('confirmed vs needsReview counts are accurate', () => {
    const scanResult = {
      allViolations: [
        { id: 'rule-1', impact: 'serious', _confidence: 'high', tags: ['wcag2a'], nodes: [
          { target: ['#a'] }, { target: ['#b'] },
        ]},
        { id: 'rule-2', impact: 'moderate', _confidence: 'low', tags: ['wcag2aa'], nodes: [
          { target: ['#c'] },
        ]},
      ],
      allPasses: [],
      allIncomplete: [],
    };
    const scores = calculateScores(scanResult);

    expect(scores.confirmedViolations).toBe(1);
    expect(scores.needsReviewViolations).toBe(1);
    expect(scores.confirmedNodes).toBe(2);
    expect(scores.needsReviewNodes).toBe(1);
  });
});

describe('CONFIDENCE_WEIGHTS', () => {
  test('exports expected weight values', () => {
    expect(CONFIDENCE_WEIGHTS.high).toBe(1.0);
    expect(CONFIDENCE_WEIGHTS.medium).toBe(0.6);
    expect(CONFIDENCE_WEIGHTS.low).toBe(0.15);
  });
});
