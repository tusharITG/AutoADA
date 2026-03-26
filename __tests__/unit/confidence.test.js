/**
 * Unit tests for src/confidence.js — confidence scoring.
 */

const { applyConfidenceScores, BEST_PRACTICE_RULES } = require('../../src/confidence');

describe('applyConfidenceScores', () => {
  test('assigns high confidence to deterministic rules', () => {
    const violations = [
      { id: 'html-has-lang', impact: 'serious', tags: ['wcag2a'], nodes: [{ target: ['html'] }] },
      { id: 'document-title', impact: 'serious', tags: ['wcag2a'], nodes: [{ target: ['html'] }] },
      { id: 'button-name', impact: 'critical', tags: ['wcag2a'], nodes: [{ target: ['#btn'] }] },
    ];

    applyConfidenceScores(violations);

    expect(violations[0]._confidence).toBe('high');
    expect(violations[1]._confidence).toBe('high');
    expect(violations[2]._confidence).toBe('high');
  });

  test('assigns low confidence to known false-positive rules', () => {
    const violations = [
      { id: 'color-contrast', impact: 'serious', tags: ['wcag2aa'], nodes: [
        { target: ['#text'], html: '<p style="color: #333">text</p>' },
      ]},
    ];

    applyConfidenceScores(violations);

    expect(violations[0]._confidence).toBe('low');
    expect(violations[0]._falsePositiveNote).toBeDefined();
    expect(typeof violations[0]._falsePositiveNote).toBe('string');
  });

  test('assigns medium confidence to best-practice rules', () => {
    const violations = [
      { id: 'heading-order', impact: 'moderate', tags: ['best-practice'], nodes: [
        { target: ['h3'] },
      ]},
    ];

    applyConfidenceScores(violations);

    expect(violations[0]._confidence).toBe('medium');
    expect(violations[0]._isBestPractice).toBe(true);
  });

  test('every violation gets a _confidence field', () => {
    const violations = [
      { id: 'html-has-lang', impact: 'serious', tags: ['wcag2a'], nodes: [{ target: ['html'] }] },
      { id: 'color-contrast', impact: 'serious', tags: ['wcag2aa'], nodes: [{ target: ['p'], html: '<p>text</p>' }] },
      { id: 'heading-order', impact: 'moderate', tags: ['best-practice'], nodes: [{ target: ['h3'] }] },
      { id: 'unknown-rule', impact: 'minor', tags: [], nodes: [{ target: ['div'] }] },
    ];

    applyConfidenceScores(violations);

    for (const v of violations) {
      expect(v._confidence).toBeDefined();
      expect(['high', 'medium', 'low']).toContain(v._confidence);
    }
  });

  test('handles empty violations array without error', () => {
    const violations = [];
    expect(() => applyConfidenceScores(violations)).not.toThrow();
  });

  test('contextual check: color-contrast with background-image gets low confidence', () => {
    const violations = [
      {
        id: 'color-contrast',
        impact: 'serious',
        tags: ['wcag2aa'],
        nodes: [{
          target: ['#hero-text'],
          html: '<span style="background-image: url(hero.jpg); color: white;">Hero</span>',
        }],
      },
    ];

    applyConfidenceScores(violations);

    // Violation-level should be low (it's in false-positives.json)
    expect(violations[0]._confidence).toBe('low');
    // Node-level contextual check should also apply
    const node = violations[0].nodes[0];
    expect(node._confidence).toBe('low');
    expect(node._contextNote).toBeDefined();
  });
});

describe('BEST_PRACTICE_RULES', () => {
  test('is a Set with expected rules', () => {
    expect(BEST_PRACTICE_RULES).toBeInstanceOf(Set);
    expect(BEST_PRACTICE_RULES.has('heading-order')).toBe(true);
    expect(BEST_PRACTICE_RULES.has('region')).toBe(true);
    expect(BEST_PRACTICE_RULES.has('page-has-heading-one')).toBe(true);
  });

  test('does not contain deterministic rules', () => {
    // These should be HIGH confidence, not best-practice
    expect(BEST_PRACTICE_RULES.has('html-has-lang')).toBe(false);
    expect(BEST_PRACTICE_RULES.has('document-title')).toBe(false);
    expect(BEST_PRACTICE_RULES.has('button-name')).toBe(false);
  });
});
