import { backoffDelay } from './backoff';
import { codePointLength, deriveStatus, validateContent } from './protocol';
import { item } from './testing/fakes';

describe('backoffDelay', () => {
  const opts = { baseMs: 500, maxMs: 15_000 };
  it.each([
    // attempt, random, expected
    [0, 0, 250],
    [0, 0.999999, 500],
    [1, 0, 500],
    [2, 0.5, 1500],
    [4, 1 - 1e-9, 8000],
    [5, 0, 7500], // ceiling capped at 15 s
    [20, 0.999999, 15_000],
  ])('attempt %i, random %f → %i ms', (attempt, random, expected) => {
    expect(backoffDelay(attempt, () => random, opts)).toBe(expected);
  });

  it('jitter spreads clients cut by the same kill', () => {
    const delays = [0.1, 0.4, 0.9].map((r) => backoffDelay(3, () => r, opts));
    expect(new Set(delays).size).toBe(3);
  });
});

describe('validateContent', () => {
  it.each([
    ['', { ok: false, code: 'EMPTY' }],
    ['   \n ', { ok: false, code: 'EMPTY' }],
    ['  bonjour  ', { ok: true, content: 'bonjour' }],
    ['x'.repeat(2000), { ok: true, content: 'x'.repeat(2000) }],
    ['x'.repeat(2001), { ok: false, code: 'TOO_LONG' }],
    // 2000 emoji = 4000 UTF-16 units but 2000 code points, like PostgreSQL char_length
    ['😀'.repeat(2000), { ok: true, content: '😀'.repeat(2000) }],
    ['😀'.repeat(2001), { ok: false, code: 'TOO_LONG' }],
  ])('%#', (raw, expected) => {
    expect(validateContent(raw)).toEqual(expected);
  });

  it('counts code points', () => {
    expect(codePointLength('a😀b')).toBe(3);
  });
});

describe('deriveStatus', () => {
  it.each([
    [[], 'en_attente'],
    [['texte'], 'en_attente'],
    [['prise_en_charge', 'texte'], 'en_cours'],
    [['prise_en_charge', 'cloture'], 'cloturee'],
    [['cloture'], 'cloturee'],
  ] as const)('%j → %s', (types, expected) => {
    const its = types.map((type, i) => item(1, i + 1, { type }));
    expect(deriveStatus('en_attente', its)).toBe(expected);
  });
});
