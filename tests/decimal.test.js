import test from 'node:test';
import assert from 'node:assert/strict';
import { Decimal } from '../dist/decimal.js';

const fraction = (value, numerator, denominator = 1n) => {
  assert.equal(value.numerator, numerator);
  assert.equal(value.denominator, denominator);
  assert.ok(value instanceof Decimal);
  assert.ok(Object.isFrozen(value));
};

test('addition and subtraction reduce shared and distinct denominator factors exactly', () => {
  fraction(new Decimal(5n, 12n).add(new Decimal(7n, 18n)), 29n, 36n);
  fraction(new Decimal(5n, 12n).sub(new Decimal(7n, 18n)), 1n, 36n);
  fraction(new Decimal(5n, 12n).add(new Decimal(7n, 12n)), 1n);
  fraction(new Decimal(5n, 12n).sub(new Decimal(5n, 12n)), 0n);
  fraction(new Decimal(1n, 7n).add(new Decimal(1n, 11n)), 18n, 77n);
});

test('multiplication and division cancel large factors before forming the result', () => {
  const large = 10n ** 1000n + 1n;
  const small = large - 1n;
  const left = new Decimal(large, small);
  const right = new Decimal(small, large);
  fraction(left.mul(right), 1n);
  fraction(left.div(left), 1n);
  fraction(left.mul('-2').div(left), -2n);
  fraction(right.div('-1').mul(left), -1n);
});

test('all operations normalize zeros and denominator signs and preserve operands', () => {
  const negative = new Decimal(3n, -7n);
  fraction(negative, -3n, 7n);
  fraction(negative.add('0'), -3n, 7n);
  fraction(negative.sub('0'), -3n, 7n);
  fraction(negative.mul('0'), 0n);
  fraction(Decimal.from('0').mul(negative), 0n);
  fraction(Decimal.from('0').div(negative), 0n);
  fraction(negative.div(negative), 1n);
  fraction(negative, -3n, 7n);
  assert.throws(() => negative.div('0'), RangeError);
  assert.throws(() => Decimal.from('0').div('0'), RangeError);
});

test('optimized arithmetic agrees with direct rational identities for varied signs and factors', () => {
  const values = [];
  for (const numerator of [-13n, -4n, -1n, 0n, 1n, 4n, 13n]) {
    for (const denominator of [1n, 2n, 3n, 4n, 7n, 12n, 21n]) {
      values.push(new Decimal(numerator, denominator));
    }
  }
  for (const left of values) {
    for (const right of values) {
      const a = left.numerator;
      const b = left.denominator;
      const c = right.numerator;
      const d = right.denominator;
      const expected = [
        new Decimal(a * d + c * b, b * d),
        new Decimal(a * d - c * b, b * d),
        new Decimal(a * c, b * d),
      ];
      const actual = [left.add(right), left.sub(right), left.mul(right)];
      if (c !== 0n) {
        expected.push(new Decimal(a * d, b * c));
        actual.push(left.div(right));
      }
      actual.forEach((result, i) => fraction(result, expected[i].numerator, expected[i].denominator));
    }
  }
});

test('chained fractions retain exact precision until explicit half-away-from-zero formatting', () => {
  const third = Decimal.from('1').div('3');
  fraction(third.add(third).add(third), 1n);
  fraction(third.mul('0.000000000000000003'), 1n, 10n ** 18n);
  assert.equal(new Decimal(201n, 200n).toFixed(2), '1.01');
  assert.equal(new Decimal(-201n, 200n).toFixed(2), '-1.01');
  assert.equal(new Decimal(-1n, 1000n).toFixed(2), '0.00');
  assert.equal(third.toString(), '0.333333333333333333');
  assert.equal(third.mul('3').toFixed(18), '1.000000000000000000');
});
