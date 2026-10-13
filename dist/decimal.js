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

  add(value) {
    const other = Decimal.from(value);
    return new Decimal(this.numerator * other.denominator + other.numerator * this.denominator,
      this.denominator * other.denominator);
  }

  sub(value) {
    const other = Decimal.from(value);
    return new Decimal(this.numerator * other.denominator - other.numerator * this.denominator,
      this.denominator * other.denominator);
  }

  mul(value) {
    const other = Decimal.from(value);
    return new Decimal(this.numerator * other.numerator, this.denominator * other.denominator);
  }

  div(value) {
    const other = Decimal.from(value);
    return new Decimal(this.numerator * other.denominator, this.denominator * other.numerator);
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
