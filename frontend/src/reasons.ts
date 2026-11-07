/**
 * reasons.ts — the verification verdicts the engine writes in English, said in
 * the reader's language.
 *
 * `src/verification.mjs` decides whether an opportunity's legs still add up and
 * states the verdict it reached as an English sentence. The shell carries that
 * sentence to the two places a trader reads it: the risk tag's tooltip on the
 * card, and the settlement notice in the execution slip. In the Romanian
 * interface it was the last English on the screen — a text about whether the
 * bet is still safe to place, in a language the reader may not have.
 *
 * The mapping is deliberately **closed**: an exact table for the sentences the
 * engine writes verbatim, and an ordered pattern list for the six it builds
 * around an identifier or a figure. A verdict this file does not know is passed
 * through unchanged, because a settlement verdict is the last thing to guess at
 * — an English sentence a trader can read beats a confident mistranslation of
 * why their money is at risk. `test/frontend-reasons.test.mjs` reads the
 * engine's own source and fails if it can say something this file cannot.
 *
 * Like `labels.ts`, this module is pure and dictionary-free: the translator is
 * passed in, which is what lets a Node test drive it with a fake translator and
 * see which key was chosen rather than a sentence in one language.
 */
export type Translator = (key: string) => string;

/**
 * The verdicts the engine states in full, mapped to the key that says them.
 *
 * `Backend verification rejected this contract.` is not the engine's: `api.ts`
 * writes it when a rejection arrives without a reason. It is in this table
 * because it reaches the same two places and had the same problem.
 */
export const RULE_REASONS: Record<string, string> = {
  'no sourceIds': 'appReasonNoSourceIds',
  'verification cancelled': 'appReasonCancelled',
  'unsupported contract: settlement equivalence not established': 'appReasonUnsupportedContract',
  'incomplete or unsupported contract': 'appReasonIncompleteContract',
  'no positive rounded guaranteed profit': 'appReasonNoRoundedProfit',
  'all legs re-priced within tolerance': 'appReasonRepriced',
  'middle lost a leg': 'appReasonMiddleLostLeg',
  'legs share upstream feed': 'appReasonSharedFeed',
  'middle window exceeded risk or ROI threshold': 'appReasonMiddleThresholds',
  'event past': 'appReasonEventPast',
  'event kickoff unknown': 'appReasonKickoffUnknown',
  'Backend verification rejected this contract.': 'appReasonRejectedGeneric',
};

/**
 * The verdicts built around data: the source that failed, the odds it moved
 * between, the margin that is left.
 *
 * The trailing array names the capture groups, and each name is a token the
 * dictionary entry may carry. The identifiers and the figures are substituted
 * rather than translated — `superbet` is a book's own name and `2.10` is a
 * price, and neither is a word in anyone's language.
 *
 * Every pattern is anchored at both ends, and the data is matched as `\S+`: a
 * source id and a price both contain no spaces, and anchoring is what stops a
 * longer sentence from being translated by the meaning of its first clause. A
 * tighter class was written first — `[\d.]+` for the margin — and the closure
 * test in `test/frontend-reasons.test.mjs` immediately showed it for what it
 * was: a claim about how the engine *currently* formats a number, which would
 * go silently back to English the day the margin was written as `2,40%`.
 */
export const RULE_REASON_PATTERNS: [RegExp, string, string[]][] = [
  [/^(\S+) ambiguous selection$/, 'appReasonAmbiguous', ['id']],
  [/^(\S+) selection missing from re-scrape \(event present\)$/, 'appReasonSelectionMissing', ['id']],
  [/^(\S+) leg missing from re-scrape \(event not reached\)$/, 'appReasonLegMissing', ['id']],
  [/^(\S+) odds drift (\S+) → (\S+)$/, 'appReasonOddsDrift', ['id', 'from', 'to']],
  [/^margin dropped to (\S+)%$/, 'appReasonMarginDropped', ['margin']],
  [/^(\S+) leg re-quoted from (\S+)-scope, not (\S+)-scope$/, 'appReasonScopeMismatch', ['id', 'from', 'to']],
  [/^(\S+) leg re-quoted from (\S+)-subject, not (\S+)-subject$/, 'appReasonSubjectMismatch', ['id', 'from', 'to']],
];

/**
 * One verdict, in the interface's language, or the engine's own sentence.
 *
 * @param reason the engine's sentence, as it arrived on the opportunity
 * @param tr the dictionary lookup, normally `t`
 */
export function localizeRuleReason(reason: string | null | undefined, tr: Translator): string {
  if (!reason) return '';
  const exact = RULE_REASONS[reason];
  if (exact) return tr(exact);
  for (const [pattern, key, tokens] of RULE_REASON_PATTERNS) {
    const match = pattern.exec(reason);
    if (!match) continue;
    return tokens.reduce((sentence, token, index) => sentence.replace(`{${token}}`, match[index + 1]), tr(key));
  }
  return reason;
}

/** Every dictionary key this module can ask for, for the dictionary's own tests. */
export const RULE_REASON_KEYS: string[] = [
  ...Object.values(RULE_REASONS),
  ...RULE_REASON_PATTERNS.map(([, key]) => key),
];
