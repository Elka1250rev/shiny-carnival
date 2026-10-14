/** Exact rational arithmetic. Only formatting rounds: calculations never do. */
const abs = value => value < 0n ? -value : value;
const gcd = (left, right) => {
  let a = abs(left);
  let b = abs(right);
  while (b !== 0n) [a, b] = [b, a % b];
  return a;
};

export class Decimal {
  constructor(numerator, denominator = 1n) {
    if (typeof numerator !== 'bigint' || typeof denominator !== 'bigint') {
      throw new TypeError('Decimal richiede interi BigInt. Usa Decimal.from per i decimali.');
    }
    if (denominator === 0n) throw new RangeError('Divisione per zero.');
    const sign = denominator < 0n ? -1n : 1n;
    const divisor = gcd(numerator, denominator);
    this.numerator = numerator * sign / divisor;
    this.denominator = abs(denominator) / divisor;
    Object.freeze(this);
  }

  static from(value) {
    if (value instanceof Decimal) return value;
    if (typeof value === 'bigint') return new Decimal(value);
    if (typeof value !== 'string' || !/^[+-]?\d+(?:\.\d+)?$/.test(value)) {
      throw new TypeError('Usa una stringa decimale con punto, senza esponenti.');
    }
    const negative = value.startsWith('-');
    const unsigned = value.replace(/^[+-]/, '');
    const [whole, fraction = ''] = unsigned.split('.');
    const denominator = 10n ** BigInt(fraction.length);
    const numerator = BigInt(whole + fraction) * (negative ? -1n : 1n);
    return new Decimal(numerator, denominator);
  }

  // Internal arithmetic cancels common factors before multiplying. The result
  // is already reduced, so avoid another GCD on potentially enormous products.
  static #reduced(numerator, denominator) {
    const result = Object.create(Decimal.prototype);
    const sign = denominator < 0n ? -1n : 1n;
    result.numerator = numerator * sign;
    result.denominator = denominator * sign;
    return Object.freeze(result);
  }

  static #combine(value, other, subtract) {
    const common = gcd(value.denominator, other.denominator);
    const leftScale = other.denominator / common;
    const rightScale = value.denominator / common;
    const right = other.numerator * rightScale;
    const numerator = value.numerator * leftScale + (subtract ? -right : right);
    // With reduced operands, any factor still shared by the result is in common.
    const remaining = gcd(numerator, common);
    return Decimal.#reduced(numerator / remaining,
      rightScale * (other.denominator / remaining));
  }

  add(value) {
    return Decimal.#combine(this, Decimal.from(value), false);
  }

  sub(value) {
    return Decimal.#combine(this, Decimal.from(value), true);
  }

  mul(value) {
    const other = Decimal.from(value);
    const left = gcd(this.numerator, other.denominator);
    const right = gcd(other.numerator, this.denominator);
    return Decimal.#reduced((this.numerator / left) * (other.numerator / right),
      (this.denominator / right) * (other.denominator / left));
  }

  div(value) {
    const other = Decimal.from(value);
    if (other.numerator === 0n) throw new RangeError('Divisione per zero.');
    const top = gcd(this.numerator, other.numerator);
    const bottom = gcd(this.denominator, other.denominator);
    return Decimal.#reduced((this.numerator / top) * (other.denominator / bottom),
      (this.denominator / bottom) * (other.numerator / top));
  }

  cmp(value) {
    const other = Decimal.from(value);
    const difference = this.numerator * other.denominator - other.numerator * this.denominator;
    return difference < 0n ? -1 : difference > 0n ? 1 : 0;
  }

  min(value) { const other = Decimal.from(value); return this.cmp(other) <= 0 ? this : other; }
  max(value) { const other = Decimal.from(value); return this.cmp(other) >= 0 ? this : other; }
  static min(left, right) { return Decimal.from(left).min(right); }
  static max(left, right) { return Decimal.from(left).max(right); }

  /** Round half away from zero, including values smaller than one cent. */
  toFixed(digits = 2) {
    if (!Number.isInteger(digits) || digits < 0 || digits > 100) {
      throw new RangeError('La precisione deve essere un intero tra 0 e 100.');
    }
    const scale = 10n ** BigInt(digits);
    const scaled = abs(this.numerator) * scale;
    let rounded = scaled / this.denominator;
    if (scaled % this.denominator * 2n >= this.denominator) rounded += 1n;
    const sign = this.numerator < 0n && rounded !== 0n ? '-' : '';
    const raw = rounded.toString().padStart(digits + 1, '0');
    return digits === 0 ? sign + raw : sign + raw.slice(0, -digits) + '.' + raw.slice(-digits);
  }

  /** Exact for finite decimals of up to 18 places; formatted otherwise. */
  toString() {
    const fixed = this.toFixed(18);
    return fixed.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
  }
}
