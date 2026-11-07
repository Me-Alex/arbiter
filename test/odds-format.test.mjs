import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  convertFromSide,
  decimalToAmerican,
  decimalToFractional,
  decimalToHongKong,
  decimalToMalay,
  decimalToProbability,
  flipBackLayDecimal,
  formatOdds,
  parseToDecimal,
} from '../frontend/src/odds-format.ts';

test('odds-format converts decimal odds accurately across American, Fractional, Hong Kong, Malay, and Probability %', () => {
  assert.equal(decimalToAmerican(2.5), '+150');
  assert.equal(decimalToAmerican(1.5), '-200');
  assert.equal(decimalToAmerican(2.0), '+100');

  assert.equal(decimalToFractional(2.5), '3/2');
  assert.equal(decimalToFractional(1.5), '1/2');
  assert.equal(decimalToFractional(2.0), '1/1');
  assert.equal(decimalToFractional(4 / 3), '1/3');

  assert.equal(decimalToHongKong(2.5), '1.50');
  assert.equal(decimalToHongKong(1.4), '0.40');

  assert.equal(decimalToMalay(1.5), '0.50');
  assert.equal(decimalToMalay(2.0), '1.00');
  assert.equal(decimalToMalay(3.0), '-0.50');

  assert.equal(decimalToProbability(2.5), '40.00');
  assert.equal(formatOdds(2.5, 'american'), '+150');
  assert.equal(formatOdds(2.5, 'fractional'), '3/2');
  assert.equal(formatOdds(2.5, 'decimal'), '2.50');
});

test('odds-format parses inputs across all 6 formats and preserves Back <-> Lay involution', () => {
  assert.equal(parseToDecimal('2.50', 'decimal'), 2.5);
  assert.equal(parseToDecimal('+150', 'american'), 2.5);
  assert.equal(parseToDecimal('-200', 'american'), 1.5);
  assert.equal(parseToDecimal('3/2', 'fractional'), 2.5);
  assert.equal(parseToDecimal('1.50', 'hongkong'), 2.5);
  assert.equal(parseToDecimal('0.50', 'malay'), 1.5);
  assert.equal(parseToDecimal('-0.50', 'malay'), 3.0);
  assert.equal(parseToDecimal('40%', 'probability'), 2.5);
  assert.equal(parseToDecimal('0.95', 'decimal'), null);

  const flipped = flipBackLayDecimal(2.5);
  assert.ok(Math.abs(flipped - 5 / 3) < 1e-9);
  assert.ok(Math.abs(flipBackLayDecimal(flipped) - 2.5) < 1e-9);

  const pair = convertFromSide(3.0, 'back');
  assert.equal(pair.back.probability, '33.33');
  assert.equal(pair.lay.probability, '66.67');
  assert.equal(pair.lay.decimal, '1.50');
});
