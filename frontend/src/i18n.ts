/**
 * i18n for the React app, reading the SAME dictionary the legacy console reads.
 *
 * public/js/i18n.js is a classic script: an IIFE that builds the RO/EN
 * dictionary, resolves the language from localStorage, and publishes
 * `window.arbiterI18n`. It is imported here for its side effect rather than
 * copied, because two dictionaries would be two places to add a key and two
 * chances for the Romanian to drift from the English it translates.
 *
 * The import runs the script as a module. It has no import/export statements of
 * its own, so nothing about it is module-specific, and the assignment to
 * `window` is the whole contract. One consequence is worth stating: the file
 * also registers a DOMContentLoaded handler that fills in `[data-i18n]`
 * attributes. The React app renders from state instead, so that handler has
 * nothing to find and is inert here.
 */
import '../../public/js/i18n.js';

import { useCallback, useEffect, useState } from 'react';

export type Lang = 'ro' | 'en';

export type Dictionary = {
  t(key: string): string;
  setLang(next: Lang): void;
  apply(): void;
  readonly lang: Lang;
};

/**
 * The dictionary registers itself on window, so the first read is also the
 * check that the import above actually ran. Throwing names the failure instead
 * of rendering a page full of raw key names.
 */
function dictionary(): Dictionary {
  const found = (window as unknown as { arbiterI18n?: Dictionary }).arbiterI18n;
  if (!found) throw new Error('the shared dictionary did not register window.arbiterI18n');
  return found;
}

/** The current language, read once at startup. */
export function currentLang(): Lang {
  return dictionary().lang;
}

/**
 * Translate one key in the language the dictionary is currently set to.
 *
 * This is a plain function, not a hook, because the dictionary holds the
 * language: `setLang` mutates it, and a component re-renders because the hook
 * below changed state. Reading the language from React state here instead
 * would give every call site a second copy of the truth.
 */
export function t(key: string): string {
  return dictionary().t(key);
}

/**
 * Translate a key that carries `{placeholder}` tokens, then fill them in.
 *
 * `t()` itself interpolates nothing — the legacy pages call `.replace('{n}', …)`
 * at each site, which works only when the number is last. A sentence with two
 * counts in it cannot be assembled that way without letting word order leak
 * into the code, and Romanian does not put these words in the English order.
 * So the tokens are written into the dictionary value and substituted here.
 *
 * An unrecognised token is left as written: a typo shows up on screen as
 * `{edges}` rather than vanishing into a sentence with a hole in it.
 *
 * @param vars values by token name, without the braces
 */
export function tf(key: string, vars: Record<string, string | number>): string {
  return t(key).replace(/\{(\w+)\}/g, (whole, name: string) => (name in vars ? String(vars[name]) : whole));
}

/**
 * The language plus a setter that persists it.
 *
 * `setLang` in the dictionary writes localStorage and re-applies the legacy
 * pages' `[data-i18n]` attributes; the state update is what re-renders this
 * app. Both have to happen, and the order matters: the dictionary switches
 * first, so a re-render never renders the old language under the new label.
 */
export function useLanguage() {
  const [lang, setLangState] = useState<Lang>(currentLang);
  const setLang = useCallback((next: Lang) => {
    dictionary().setLang(next);
    setLangState(next);
  }, []);
  // The legacy pages set this attribute in apply(); the React app is a separate
  // document root and has to do it itself for screen readers and hyphenation.
  useEffect(() => { document.documentElement.lang = lang; }, [lang]);
  return { lang, setLang, t };
}
