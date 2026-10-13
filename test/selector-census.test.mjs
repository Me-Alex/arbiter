/**
 * selector-census.test.mjs — does every selector a script hands the DOM name a
 * class that some page actually carries?
 *
 * A selector the browser cannot answer is silent. `document.querySelectorAll`
 * returns an empty list, a `forEach` over it runs zero times, and the `if` around
 * a single lookup swallows the null. Three of these were live on scrape.html at
 * once, and the worst of them cost a whole run: `updateStepper` asked for
 * `.stepper .step`, markup that exists only in design-preview/preview.html, so the
 * orchestrator's `currentStep.index` — the field naming which of the five stages
 * a run is on — was read by the page and applied to nothing. The band of KPI
 * cards was flashing `.scrape-kpis .kpi-card`, two classes this page has never
 * had, so no number it drew was ever acknowledged. And `.ring-fill` was an
 * SVG-era child of a ring that is `display: none`.
 *
 * Nothing could see any of the three, and the reason was in the test seams as
 * much as in the page: `querySelectorAll` was `() => []` for every selector, so
 * "marks five stages" and "marks none of them" were the same observation.
 *
 * Four ways this census lies by passing, all of them found by running it and
 * watching it report nothing:
 *
 *   - A dot inside an attribute selector is not a class. `a[href*=...]` on
 *     scanner.html reported a defect called `.csv` — the end of a file extension
 *     in a string. Attribute selectors are blanked before classes are read.
 *   - A class can be put on an element without any `class="..."` in the page:
 *     `className =`, `classList.add`, `setAttribute('class', …)`. Reading only
 *     the first form reported `dash-quickbar` as carried by nobody on eight
 *     pages, and it is in index.html.
 *   - The scope is the set of pages that load the script, not one page.
 *     `app.js` reaches for `.dash-quickbar` on all eleven pages and only
 *     index.html has it, behind `if (summary)`. Checking it per page reported
 *     that as eight defects; all eleven remaining candidates were verified by
 *     reading them, and every one is a guarded lookup in a shared script.
 *   - A census that reads fewer call sites than the code has is reporting on a
 *     subset while looking like it reports on the file. This one read the
 *     single-quoted form only: 87 of 91 call sites, missing every
 *     `querySelector(`#${id} tbody`)` — and the check that let that pass was a
 *     `length > 100` threshold this file's author invented on the way in. A
 *     threshold asserts a magnitude, so it fails for one reason (the count fell)
 *     and the reason it should have failed — that something escaped measurement
 *     — is invisible in it. The control here is a completeness claim instead:
 *     the number of selectors read equals the number of literal call sites in
 *     the scripts scanned, and every call site's argument is a literal. Neither
 *     can be satisfied by a census that read nothing, and neither has a number
 *     in it that a new page could invalidate.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { codeOnly } from './helpers/code-only.mjs';

// Rooted at the repository, for the reason page-scripts.test.mjs gives.
const ROOT = new URL('../', import.meta.url);
const read = (path) => readFileSync(new URL(path, ROOT), 'utf8');

/** Class tokens of a `class="..."` value: no interpolation, no empty ones. */
const tokensIn = (value) => value.split(/\s+/).filter((t) => t && !t.includes('$') && !t.includes('{'));

/** Every class the static markup of a page carries. */
const classesOf = (html) => new Set(
  [...html.matchAll(/\bclass="([^"]+)"/g)].flatMap((m) => tokensIn(m[1])),
);

/** Every id the static markup of a page carries. */
const idsOf = (html) => new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));

/**
 * Attributes the static markup carries, as name -> the values it gives them.
 *
 * `<script>` and `<style>` bodies are removed first, because a `data-foo="bar"`
 * written inside an inline script is a string in a script and not an attribute
 * on an element. Counting those would let a selector pass on the strength of a
 * mention, which is the hole `codeOnly` closes on the JavaScript side and which
 * a second, home-grown version of it would reopen here.
 *
 * The empty string is a real member of a value set: it is what a bare boolean
 * attribute carries, `data-dashboard-retry` rather than `data-dashboard-retry="x"`.
 */
const attrsOf = (html) => {
  const map = new Map();
  const markup = html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ');
  for (const m of markup.matchAll(/\s([A-Za-z_][\w:-]*)(?:=(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
    if (!map.has(m[1])) map.set(m[1], new Set());
    map.get(m[1]).add(m[2] ?? m[3] ?? m[4] ?? '');
  }
  return map;
};

/**
 * The argument list of a call, by counting parentheses rather than by a pattern.
 *
 * A `)` inside a quoted argument closes nothing, so `classList.add('a)b')` is one
 * argument list and not a truncated one. Every extractor that reads an argument
 * by matching up to the next `)` gets that wrong in the direction of reading
 * LESS, which is the direction an inventory of what the page can put on an
 * element is not allowed to be wrong in.
 */
const argListOf = (code, openAt) => {
  let depth = 0;
  for (let i = openAt; i < code.length; i += 1) {
    if (code[i] === '(') depth += 1;
    else if (code[i] === ')') {
      depth -= 1;
      if (depth === 0) return code.slice(openAt + 1, i);
    }
  }
  return '';
};

/**
 * Every class a script can put on an element, in every spelling this tree uses.
 *
 * Three forms, and the third is the one that has to read more than one argument.
 * `classList` takes as many tokens as the call site gives it, so a rule that reads
 * the first quoted string after `add(` describes a call the tree does not write.
 * Two sites in scrape.js do exactly that: :1068 removes three classes in one call
 * and :1073 picks between two with a ternary, so `done` and `error` were credited
 * to nobody. Swept over all of `public/js` the cost is one name -- no selector
 * asks for `.done` or `.error`, so nothing was red -- which is the same blindness
 * as the backtick boundary below, in the direction that only shows up once
 * somebody asks.
 *
 * A string compared against is a value and not a class. `status === 'completed'`
 * inside that ternary is the same mistake as `dataset.langSet === lang` counting
 * as a write, and it is excluded the same way.
 */
const classesEmittedBy = (js) => {
  const out = new Set();
  const code = codeOnly(js);
  for (const m of code.matchAll(/class=(?:"([^"]*)"|'([^']*)'|`([^`]*)`)/g)) {
    for (const t of tokensIn((m[1] ?? m[2] ?? m[3]).replace(/\$\{[^}]*\}/g, ' '))) out.add(t);
  }
  for (const m of code.matchAll(/(?:className\s*=\s*|setAttribute\(\s*'class'\s*,\s*)(['"])([^'"]*)\1/g)) {
    for (const t of tokensIn(m[2])) out.add(t);
  }
  for (const m of code.matchAll(/classList\.(?:add|toggle|remove)\s*\(/g)) {
    const args = argListOf(code, m.index + m[0].length - 1);
    for (const q of args.matchAll(/(['"])([^'"]+)\1/g)) {
      if (/(?:===|!==|==|!=)\s*$/.test(args.slice(0, q.index))) continue;
      for (const t of tokensIn(q[2])) out.add(t);
    }
  }
  return out;
};

/**
 * Every id a script can put on an element, in the two ways it does that.
 *
 * `id=` in written markup and `.id =` / `setAttribute('id', …)` on an element
 * already in hand. There is no `idList` to walk, so this is the whole of it —
 * stated because "every way" is a claim and this one is smaller than the class
 * version's three. It is also the weaker of the two: the id form reaches one
 * argument like the old class rule did, and `setAttribute('id', …)` names a
 * single quoting spelling. Neither has an occurrence in this tree (swept: zero
 * for both), which is what makes the form sufficient -- not the form itself.
 */
const idsEmittedBy = (js) => {
  const out = new Set();
  const code = codeOnly(js);
  for (const m of code.matchAll(/\bid=(?:"([^"]*)"|'([^']*)'|`([^`]*)`)/g)) {
    for (const t of tokensIn((m[1] ?? m[2] ?? m[3]).replace(/\$\{[^}]*\}/g, ' '))) out.add(t);
  }
  for (const m of code.matchAll(/(?:\.id\s*=|setAttribute\(\s*'id')\s*=?\s*\(?\s*(['"])([^'"]+)\1/g)) {
    for (const t of tokensIn(m[2].replace(/\$\{[^}]*\}/g, ' '))) out.add(t);
  }
  return out;
};

// What a `${…}` leaves behind. Not a class name and not a `#`: the marker has to
// be something no class token can start with, or `.${cls}` would read as a
// class called `${cls}` and the whole point of blanking it would be lost.
const DYNAMIC = '@@';

/** The part of a selector literal that is fixed at parse time. */
const staticOf = (selector) => selector.replace(/\$\{[^}]*\}/g, DYNAMIC);

/**
 * The classes a selector names, with any attribute selector taken out first.
 *
 * `a[href*="/api/scan/export.csv"]` is not a request for a class called `csv`:
 * the `.csv` is the end of a file extension inside a string in an attribute
 * selector. Reading it as a class invented a defect on scanner.html.
 */
const classesIn = (selector) => [...staticOf(selector).replace(/\[[^\]]*\]/g, ' ').matchAll(/\.([A-Za-z_][\w-]*)/g)]
  .map((m) => m[1]);

/**
 * The ids a selector names, on the same terms as the classes above.
 *
 * An id is the same failure as a class: the browser answers an empty list, and
 * everything downstream of the answer runs zero times without complaint. The
 * class half of this census found three live defects on one page, and this half
 * was not written until a second look asked what `#arb-table tbody` would do if
 * `#arb-table` were not on scanner.html — which is the same question, one
 * character away, and it was going unasked.
 *
 * `href="#top"` is not a request for an element called `top`, for the same reason
 * `href*="…csv"` was not a request for `.csv`: attribute selectors are taken out
 * before anything is read, and it is the attribute selector that holds both of
 * those.
 */
const idsIn = (selector) => [...staticOf(selector).replace(/\[[^\]]*\]/g, ' ').matchAll(/#([A-Za-z_][\w-]*)/g)]
  .map((m) => m[1]);

/**
 * Whether an id in this selector is only known at runtime.
 *
 * Same test as the class above, and unlike the class above it has something to
 * find: three call sites ask for `#${id} tbody` — two in scanner.js and one in
 * analytics.js — where the table id is assembled from a variable at runtime. A
 * census that reads class names and id names cannot resolve those, so they are
 * outside what this file can see.
 *
 * They are therefore listed, not asserted away. Requiring zero would mean
 * rewriting three working call sites so a regex could follow them, which is
 * changing working code to satisfy an instrument. Requiring nothing would let a
 * fourth join them in silence. So the ledger below is exact: the same two shapes,
 * by name. A new one turns it red, and a fixed one turns it red and shortens it.
 * The variable names are not in the ledger, so renaming `tableId` is not a
 * change to it.
 */
const dynamicIdShape = (selector) => selector.replace(/\$\{[^}]*\}/g, '*');

/** Whether an id in this selector is only known at runtime. */
const hasDynamicId = (selector) => /#(?=[@]@|\s|$)/.test(staticOf(selector));

/**
 * Attributes a script writes at runtime, in every spelling this tree uses.
 *
 * `data-foo="bar"` inside a template, `setAttribute('data-foo', 'bar')`,
 * `el.dataset.fooBar = …`, and a BARE boolean attribute that has no `=` at all.
 * That last one was missed by a version requiring `=`, and it reported
 * `data-dashboard-retry` as carried by nobody — while dashboard.js:426 writes
 * `data-dashboard-retry>` and :428 reads it back three lines later. A selector
 * that looks unwired because of the spelling of the thing that writes it is the
 * worst kind of false finding: it names a real feature and says it is dead.
 *
 * `dataset` is camelCase and `data-*` is kebab-case, so `dataset.workspaceCopy`
 * is `data-workspace-copy`. Converting by lowering each capital is the only way
 * to be right here; guessing would invent a defect for anything written both
 * ways.
 *
 * The boundary before the name accepts a backtick as well as whitespace, and
 * that is the sixth door of this shape. dashboard.js builds its card attributes
 * as an array of standalone chunks --
 *
 *     const dataAttrs = [
 *       `data-sport="${escapeHtml(o.sport)}"`,
 *       `data-kickoff="${escapeHtml(o.kickoff || '')}"`,
 *     ];
 *
 * -- so the character before the name is a backtick and not a space. Requiring
 * whitespace there reported six attributes written by the page as written by
 * nobody: `data-sport`, `data-home`, `data-away`, `data-kickoff`,
 * `data-detected-at` and `data-group-size`. Nothing was red at the time, because
 * no selector in this tree reads any of them -- the emitter was wrong in the
 * direction that only shows up once someone asks. A backtick is the only other
 * boundary taken, and the name must still be `data-*` or `aria-*`, neither of
 * which is a legal JavaScript identifier, so ordinary assignments cannot be
 * read as attribute writes.
 */
const attrsEmittedBy = (js) => {
  const out = new Map();
  const code = codeOnly(js);
  const add = (name, value) => {
    if (!out.has(name)) out.set(name, new Set());
    out.get(name).add(value);
  };
  // The name is group 1 and the three value spellings are groups 2 to 4. Wrapping
// this in an outer capture group to make the call site read better renumbers
// every one of them: `m[1]` becomes the whole `data-source="bet"` and the
// attribute is then stored under a name no page has. Four attributes were
// reported unwired that way.
const WRITE = /(?:^|[\s`])(data-[A-Za-z_][\w-]*|aria-[a-z]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`)/gm;
  for (const m of code.matchAll(WRITE)) add(m[1], m[2] ?? m[3] ?? m[4] ?? '');
  // The bare boolean form: a name followed by whitespace or the tag's `>`.
  for (const m of code.matchAll(/(?:^|[\s`])(data-[A-Za-z_][\w-]*|aria-[a-z]+)(?=[\s>])/gm)) add(m[1], '');
  for (const m of code.matchAll(/setAttribute\(\s*['"]([A-Za-z_][\w:-]*)['"]\s*,\s*['"]([^'"]*)['"]\s*\)/g)) add(m[1], m[2]);
  // `==` and `===` are comparisons, not writes, and the one-character difference
  // is the whole difference here: `button.dataset.langSet === lang` read as a
  // write of `data-lang-set`, and `btn.dataset.langToggleWired === '1'` read as
  // a write of `data-lang-toggle-wired`. Two false writes in the tree, and the
  // second one had teeth -- an injection that deleted the real write at
  // common.js:182 left the census reporting the attribute as still written,
  // green, on the strength of a comparison three lines above.
  for (const m of code.matchAll(/\bdataset\.([A-Za-z_][\w]*)\s*=(?!=)/g)) {
    add('data-' + m[1].replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()), '');
  }
  return out;
};

/**
 * Attributes a script READS, and the two ways it touches one without reading it.
 *
 * The other side of `attrsEmittedBy`, and it was missing: this file measured what
 * scripts write into the DOM and what selectors ask for, and never what scripts
 * read back out of it. That gap has the same failure as `getElementById`
 * returning null, and this tree leans on it — `el.getAttribute('data-x') ||
 * label` and `card.dataset.home || ''` both answer themselves with the fallback
 * when the attribute is absent, so a read of an attribute nobody writes produces
 * no exception, no empty list and no visible gap.
 *
 * Every occurrence is bucketed rather than filtered, because the counts are the
 * control: `getAttribute(` and `dataset.` are swept plainly, and this function
 * has to place every one of them in exactly one bucket or the two disagree. That
 * is what stops the version of this reader that only matches a quoted `data-`
 * name from being quietly right about 22 of 25 reads.
 *
 * Only `data-*` and `aria-*` are read. `getAttribute('href')` and
 * `getAttribute('tabindex')` name attributes the DOM itself defines, and the
 * elements carrying them are often built by a script into an innerHTML -- where
 * this emitter deliberately does not look, because `foo = 'bar'` in ordinary
 * JavaScript is the same text as an attribute assignment and no pattern over
 * source text can tell them apart. Those go in the `other` bucket, counted and
 * explained, rather than reported as attributes nobody writes.
 *
 * A write is not a read. `el.dataset.prev = to` is the other half of the ledger,
 * and `delete el.dataset.theme` removes the attribute; crediting either as a
 * consumption would let a script that only ever writes an attribute pass as one
 * that reads it, which is the false pass this file keeps having to undo.
 */
const attrsReadBy = (js) => {
  const code = codeOnly(js);
  const out = new Map();
  const other = [];
  const writes = [];
  const dynamic = [];
  let readCount = 0;
  let getAttributeReads = 0;
  let datasetCount = 0;
  const lineOf = (m) => code.slice(0, m.index).split('\n').length;
  const add = (name, m, viaDataset) => {
    readCount += 1;
    if (viaDataset === false) getAttributeReads += 1;
    if (!out.has(name)) out.set(name, []);
    out.get(name).push(lineOf(m));
  };

  for (const m of code.matchAll(/\bgetAttribute\(/g)) {
    const arg = /^getAttribute\(\s*(['"])([A-Za-z_][\w:-]*)\1\s*\)/.exec(code.slice(m.index));
    if (!arg) { dynamic.push(`${lineOf(m)} getAttribute(<not one string literal>)`); continue; }
    if (/^(data|aria)-/.test(arg[2])) { add(arg[2], m, false); continue; }
    other.push(`${lineOf(m)} ${arg[2]}`);
  }

  for (const m of code.matchAll(/\bdataset\.([A-Za-z_][\w]*)/g)) {
    datasetCount += 1;
    if (/^\s*=[^=]/.test(code.slice(m.index + m[0].length))) { writes.push(lineOf(m)); continue; }
    if (/\bdelete\s+[\w.$]*$/.test(code.slice(Math.max(0, m.index - 60), m.index))) continue;
    add('data-' + m[1].replace(/[A-Z]/g, (c) => '-' + c.toLowerCase()), m, true);
  }
  return { read: out, other, writes, dynamic, readCount, getAttributeReads, datasetCount };
};

/**
 * Every bracketed part of a selector, in order.
 *
 * Bracket counting rather than a pattern, because `]` inside a quoted value
 * closes nothing: `a[href*="/api/x]y"]` is one selector, not two. An unbalanced
 * remainder is returned with `closed: false` rather than dropped, so a selector
 * this cannot finish reading shows up as itself instead of as silence.
 */
function bracketParts(selector) {
  const parts = [];
  for (let i = 0; i < selector.length; i += 1) {
    if (selector[i] !== '[') continue;
    let depth = 0;
    let quote = null;
    let end = -1;
    for (let j = i; j < selector.length; j += 1) {
      const ch = selector[j];
      if (quote) {
        if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'") { quote = ch; continue; }
      if (ch === '[') depth += 1;
      else if (ch === ']') {
        depth -= 1;
        if (depth === 0) { end = j; break; }
      }
    }
    if (end === -1) { parts.push({ raw: selector.slice(i + 1), closed: false }); break; }
    parts.push({ raw: selector.slice(i + 1, end), closed: true });
    i = end;
  }
  return parts;
}

/**
 * One bracketed part, split into operator, name and value.
 *
 * The name comes first and the operator second — `[type=checkbox]`,
 * `[aria-current="page"]`, `[href*="/api/scan/export.csv"]`. A version of this
 * anchored on the operator, and therefore on the empty string at position zero,
 * classified all thirty attribute selectors in this tree as bare names and then
 * reported nine of them as carried by nobody, `type=checkbox` included, which
 * three inputs on scrape.html plainly carry. All nine were the parser's.
 */
function parseAttr(raw) {
  const m = /^([^~^|$*]+?)\s*([~^|$*]?=)\s*(.*)$/.exec(raw);
  if (!m) return { op: null, name: raw.trim(), value: null, interpolated: raw.includes('${') };
  const rest = m[3].trim();
  const quoted = /^(['"])(.*)\1$/.exec(rest);
  return {
    op: m[2],
    name: m[1].trim(),
    value: quoted ? quoted[2] : rest.replace(/^['"]|['"]$/g, ''),
    interpolated: rest.includes('${'),
  };
}

/** The attributes a selector names, with each one's operator and value. */
const attrsIn = (selector) => bracketParts(selector).map((part) => ({
  ...parseAttr(part.raw),
  closed: part.closed,
}));

/**
 * Every selector whose id this census cannot resolve, deduped by shape.
 *
 * `` `#${id} tbody` `` twice in scanner.js is one thing to look at, not two.
 */
const dynamicIds = () => [...new Set(
  QUERIES.filter((q) => q.dynamicId).map((q) => `${q.src} \`${dynamicIdShape(q.selector)}\``),
)].sort();

/**
 * Whether a class in this selector is only known at runtime.
 *
 * `` `.${cls}` `` names one class and the source does not say which, so a census
 * reading class names cannot measure it at all. None of the four template-literal
 * call sites in this tree are like that — three are `#${id} tbody`, an id, and
 * the fourth is `label.chip input[data-source="${s.id}"]`, whose `chip` is fixed
 * — so the answer is zero and is asserted rather than assumed. A new one would
 * be a blind spot, and this is where it gets named instead of passing quiet.
 */
const hasDynamicClass = (selector) => /\.(?=[@]@|\s|$)/.test(staticOf(selector));

/** Every page under public/, repository-relative and slash-flashed. */
const pages = readdirSync(new URL('public/', ROOT), { recursive: true })
  .map(String)
  .filter((f) => f.endsWith('.html'))
  .map((f) => `public/${f.replace(/\\/g, '/')}`);

/** The scripts each page loads, and which pages load each script. */
const scriptsOf = (page) => [...read(page).matchAll(/<script[^>]*\bsrc="([^"]+)"/g)].map((m) => m[1]);

/**
 * The class tokens and ids available to a script: its own, plus every page that
 * loads it.
 *
 * A leading slash in a `src` is the site root, not the filesystem root — as a URL
 * `/js/api.js` resolves to the drive root, which is ENOENT for every script on
 * every page and leaves this census reading nothing while reporting nothing.
 */
const availableTo = (script, pagesLoadingIt) => {
  const classes = new Set();
  const ids = new Set();
  const attrs = new Map();
  const holdAttr = (name, value) => {
    if (!attrs.has(name)) attrs.set(name, new Set());
    attrs.get(name).add(value);
  };
  for (const page of pagesLoadingIt) {
    const html = read(page);
    for (const cls of classesOf(html)) classes.add(cls);
    for (const id of idsOf(html)) ids.add(id);
    for (const [name, values] of attrsOf(html)) for (const v of values) holdAttr(name, v);
    for (const src of scriptsOf(page)) {
      const absolute = src.startsWith('/');
      try {
        const url = new URL(absolute ? src.slice(1) : src, absolute ? new URL('public/', ROOT) : new URL(page, ROOT));
        const js = readFileSync(url, 'utf8');
        for (const cls of classesEmittedBy(js)) classes.add(cls);
        for (const id of idsEmittedBy(js)) ids.add(id);
        for (const [name, values] of attrsEmittedBy(js)) for (const v of values) holdAttr(name, v);
      } catch (err) {
        throw new Error(`could not read ${src} for ${page}: ${err.code || err.message}`);
      }
    }
  }
  return { classes, ids, attrs };
};

const PAGES_BY_SCRIPT = new Map();
for (const page of pages) {
  for (const src of scriptsOf(page)) {
    if (!PAGES_BY_SCRIPT.has(src)) PAGES_BY_SCRIPT.set(src, []);
    PAGES_BY_SCRIPT.get(src).push(page);
  }
}

/**
 * Every script a page loads, with what the census read out of it.
 *
 * The two call-site counts are the control, and they are counted here rather
 * than in the test so they cannot drift from the set of scripts actually
 * scanned: `callSites` is every `querySelector(`, `literalCallSites` is every
 * one whose whole argument is a single string literal. A script where those
 * differ passed a selector this census cannot see, and the difference is the
 * whole number of things it did not read.
 *
 * "Whole argument" is the part that is easy to get wrong in the direction of
 * passing. Counting a call as literal when its argument merely *starts* with a
 * quote reads `querySelector('.e' + 'v')` as a literal — a real way to write a
 * selector, and one no regex over source text can resolve to `.ev`. That version
 * of the count let exactly the blind spot through: the completeness assertion
 * still failed, but on the selector total rather than on the thing the control
 * exists to name, and a control that fires for the wrong reason is one nobody
 * reads the message of twice.
 */
const SCANNED = [...PAGES_BY_SCRIPT].map(([src, loading]) => {
  const absolute = src.startsWith('/');
  const url = new URL(absolute ? src.slice(1) : src, absolute ? new URL('public/', ROOT) : new URL(loading[0], ROOT));
  const code = codeOnly(readFileSync(url, 'utf8'));
  const selectors = [...code.matchAll(/querySelector(?:All)?\(\s*(?:'([^']*)'|"([^"]*)"|`([^`]*)`)\s*\)/g)]
    .map((m) => {
      const selector = m[1] ?? m[2] ?? m[3];
      return {
        selector,
        classes: classesIn(selector),
        dynamic: hasDynamicClass(selector),
        ids: idsIn(selector),
        dynamicId: hasDynamicId(selector),
        attrs: attrsIn(selector),
      };
    });
  return {
    src,
    loading,
    code,
    selectors,
    callSites: [...code.matchAll(/querySelector(?:All)?\s*\(/g)].length,
    literalCallSites: [...code.matchAll(/querySelector(?:All)?\(\s*(?:'[^']*'|"[^"]*"|`[^`]*`)\s*\)/g)].length,
  };
});

/** Every selector in every script, with the pages whose markup has to answer it. */
const QUERIES = SCANNED.flatMap((s) => s.selectors
  .map((sel) => ({ src: s.src, loading: s.loading, ...sel })));

const sum = (values) => values.reduce((total, n) => total + n, 0);

test('every selector a script hands the DOM names a class some page carries', () => {
  // The controls first, because a census that read nothing would pass all of
  // this. Three that cannot be satisfied by reading an empty tree: the pages
  // exist, the scripts were resolved, and these specific selectors were among
  // what was read — one per shape of page, including the page-specific script
  // and the shared one.
  assert.ok(pages.length >= 11, `found ${pages.length} pages, so a walk that returned nothing cannot pass this`);
  assert.ok(PAGES_BY_SCRIPT.size >= 20, `resolved ${PAGES_BY_SCRIPT.size} scripts`);
  for (const src of ['/js/pages/scrape.js', '/js/app.js', '/js/pages/dashboard.js']) {
    assert.ok(PAGES_BY_SCRIPT.has(src), `${src} is loaded by at least one page`);
  }
  const read_selectors = new Set(QUERIES.map((q) => q.src + ' ' + q.selector));
  for (const known of ['/js/pages/scrape.js .sl-stage', '/js/app.js .dash-quickbar', '/js/pages/dashboard.js .source-row']) {
    assert.ok(read_selectors.has(known), `the selector \`${known}\` was among those read`);
  }
  // The id half has its own nominal controls, for the same reason. A census that
  // read no `#` at all and a census that read seventeen of them both report zero
  // orphans, and only the name of a selector says which one ran.
  for (const known of ['/js/pages/scanner.js #arb-table tbody', '/js/pages/dashboard.js #opp-list .opportunity-row', '/js/pages/scrape.js #bookmaker-list .chip-group']) {
    assert.ok(read_selectors.has(known), `the selector \`${known}\` was among those read`);
  }

  // And the class emitter's own controls, named rather than counted. Zero orphan
  // classes is what a rule reading one argument of a three-argument call reports
  // as well, so the difference between the two rules has to be written down
  // somewhere. `active` is the first argument at scrape.js:1078, `done` is the
  // second and `error` the third -- a rule reading only the first passes for
  // either of the other two being absent from the tree.
  const scrape = SCANNED.find((s) => s.src === '/js/pages/scrape.js');
  const scrapeClasses = classesEmittedBy(scrape.code);
  for (const known of ['active', 'done', 'error']) {
    assert.ok(scrapeClasses.has(known), `the class \`${known}\` was among those scrape.js emits`);
  }

  // Completeness, not magnitude. Both halves have to hold for the orphan scan
  // below to mean "no selector the DOM cannot answer" rather than "no selector
  // this regex could reach": the argument of every call site has to be a literal
  // a census can read, and every one of those literals has to have been read.
  const notLiteral = SCANNED.filter((s) => s.callSites !== s.literalCallSites)
    .map((s) => `${s.src}: ${s.callSites} call sites, ${s.literalCallSites} of them a literal`);
  assert.deepEqual(notLiteral, [],
    `call sites whose argument is not a string literal, so no selector was read from them: ${notLiteral.join(' | ')}`);
  assert.equal(QUERIES.length, sum(SCANNED.map((s) => s.literalCallSites)),
    `read ${QUERIES.length} selectors from ${sum(SCANNED.map((s) => s.literalCallSites))} literal call sites`);
  const dynamic = QUERIES.filter((q) => q.dynamic).map((q) => `${q.src} \`${q.selector}\``);
  assert.deepEqual(dynamic, [],
    `selectors whose class name is only known at runtime, which this census cannot measure: ${dynamic.join(' | ')}`);
  // Sorted, so this is a set of shapes and not an accident of which page was
  // walked first.
  assert.deepEqual(dynamicIds(), [
    '/js/pages/analytics.js `#* tbody`',
    '/js/pages/scanner.js `#* tbody`',
  ], 'every call site whose id this census cannot resolve, by shape. A new one belongs here only after being read.');

  const orphans = [];
  const missingIds = [];
  const cache = new Map();
  for (const q of QUERIES) {
    if (q.classes.length === 0 && q.ids.length === 0) continue;
    if (!cache.has(q.src)) cache.set(q.src, availableTo(q.src, q.loading));
    const available = cache.get(q.src);
    for (const cls of q.classes) {
      if (!available.classes.has(cls)) orphans.push(`${q.src} asks for \`${q.selector}\` and no page that loads it has .${cls}`);
    }
    for (const id of q.ids) {
      if (!available.ids.has(id)) missingIds.push(`${q.src} asks for \`${q.selector}\` and no page that loads it has #${id}`);
    }
  }
  assert.deepEqual([...new Set(orphans)], [],
    `selectors the DOM cannot answer: ${[...new Set(orphans)].join(' | ')}`);
  assert.deepEqual([...new Set(missingIds)], [],
    `ids the DOM cannot answer: ${[...new Set(missingIds)].join(' | ')}`);
});

test('a class only the page\'s own script writes is still found', () => {
  // The direction that matters, stated on one case: `sl-stage` is in no other
  // page's markup, and no page but scrape.html loads scrape.js, so this is the
  // check that would have caught the stepper. Without it, the rule above could be
  // satisfied by a script that reads no selectors at all.
  const query = QUERIES.find((q) => q.src === '/js/pages/scrape.js' && q.selector === '.sl-stage');
  assert.ok(query, 'scrape.js still asks the DOM for its stages');
  assert.equal(query.loading.length, 1, 'and only scrape.html loads it, so the scope is that one page');
  const available = availableTo(query.src, query.loading);
  for (const cls of query.classes) {
    assert.ok(available.classes.has(cls), `.${cls} is carried by scrape.html`);
    assert.ok(!pages.filter((p) => p !== query.loading[0]).some((p) => classesOf(read(p)).has(cls)),
      `.${cls} is that page's alone, which is what makes this the check that catches it`);
  }
});

test('an id only the page\'s own markup carries is still found', () => {
  // The id half of the same direction. `#bookmaker-list` is written in
  // scrape.html and nowhere else, and scrape.js is loaded by scrape.html alone,
  // so if the id census were satisfied by the empty set this page would pass it.
  const query = QUERIES.find((q) => q.src === '/js/pages/scrape.js' && q.ids.includes('bookmaker-list'));
  assert.ok(query, 'scrape.js still asks the DOM for its bookmaker list by id');
  assert.equal(query.loading.length, 1, 'and only scrape.html loads it');
  const available = availableTo(query.src, query.loading);
  assert.ok(available.ids.has('bookmaker-list'), 'scrape.html carries that id');
  assert.ok(!pages.filter((p) => p !== query.loading[0]).some((p) => idsOf(read(p)).has('bookmaker-list')),
    'and no other page does, which is what makes this the check that catches it');
});

/**
 * The one attribute selector in this tree that nothing carries, and why it is
 * listed instead of fixed.
 *
 * `app.js:217` reads `[data-workspace-copy]` and fills each match from
 * `WORKSPACE_COPY` by the key in `dataset.workspaceCopy`. Nothing in the
 * repository writes that attribute: not one page's markup, not one template
 * string, not one `setAttribute` or `dataset` assignment. The loop runs over an
 * empty list on all ten pages that load app.js, which is what it does today.
 *
 * What that costs is five strings per language, ten in all -- `sourcesAction`,
 * `scannerAction`, `guideTitle`, `guideBody`, `guideLink` -- and a search of the
 * whole repository finds them only inside the two `WORKSPACE_COPY` dictionaries.
 * The other six keys of that dictionary do reach the page, but by explicit
 * `setAttribute` and `textContent` lines rather than by this mechanism, so the
 * mechanism itself has no user at all.
 *
 * It is left in place, and named here, because both halves of that are decisions
 * that are not this file's. Writing the markup would mean inventing a panel
 * nobody asked for; deleting the strings would be removing translated copy on a
 * product guess. What this census owes instead is to keep them visible: a new
 * unwired attribute is red on the scan below, and this one becoming wired is red
 * on this list, so the ledger cannot rot into a silence.
 *
 * Two tests consult this register, and both have to keep agreeing with it. The
 * selector half sees it because `app.js:217` asks for `[data-workspace-copy]`
 * with a query. The read half sees it because `app.js:218` reads
 * `dataset.workspaceCopy` off whatever that query returns. The second one is
 * newer and matters more: a register somebody has to remember to extend is a
 * register that decays, and this entry used to be exactly that -- a fact typed
 * in by someone who read the code.
 *
 * So the names here are still written by hand, and the honesty is bought with
 * three assertions instead of one: a read the register does not name is red on
 * the orphan scan, a name that becomes wired is red because the reader stops
 * finding it unwired, and a name the register names and no read reaches is red
 * on the stranded check. Only the first two were here when the comment claimed
 * the register could not go stale; the third is what makes the claim true, and
 * it exists because the second comparison derives both of its sides from this
 * very list.
 */
const UNWIRED = new Map([
  ['data-workspace-copy', 'app.js:217 reads it; nothing in the repository writes it'],
]);

/** Whether a value carries the claim its operator makes. */
const matchesOp = (op, actual, wanted) => {
  if (op === '=') return actual === wanted;
  if (op === '*=') return actual.includes(wanted);
  if (op === '^=') return actual.startsWith(wanted);
  if (op === '$=') return actual.endsWith(wanted);
  if (op === '~=') return actual.split(/\s+/).includes(wanted);
  if (op === '|=') return actual === wanted || actual.startsWith(wanted + '-');
  return false;
};

test('every attribute a selector names is carried by a page that loads the script', () => {
  // The controls, and the same three kinds as before: a selector that was among
  // those read, one written as a bare boolean attribute -- which is the spelling
  // two earlier versions of this instrument could not see, so naming it is the
  // control for that -- and one whose value is only a substring claim.
  const read_selectors = new Set(QUERIES.map((q) => q.src + ' ' + q.selector));
  for (const known of [
    '/js/i18n.js [data-i18n]',
    '/js/pages/scrape.js input[data-source]',
    '/js/pages/scrape.js .sl-progress-track[role="progressbar"]',
    '/js/pages/dashboard.js [data-dashboard-retry]',
    '/js/pages/scanner.js a[href*="/api/scan/export.csv"]',
  ]) {
    assert.ok(read_selectors.has(known), `the selector \`${known}\` was among those read`);
  }

  const orphans = [];
  const dynamicValues = [];
  const ledger = [];
  const cache = new Map();
  for (const q of QUERIES) {
    if (q.attrs.length === 0) continue;
    if (!cache.has(q.src)) cache.set(q.src, availableTo(q.src, q.loading));
    const available = cache.get(q.src);
    for (const attr of q.attrs) {
      assert.ok(attr.closed, `${q.src} \`${q.selector}\` has an attribute selector this census cannot finish reading`);
      if (!attr.name) continue;
      if (!available.attrs.has(attr.name)) {
        if (UNWIRED.has(attr.name)) ledger.push(attr.name);
        else orphans.push(`${q.src} asks for \`${q.selector}\` and no page that loads it has [${attr.name}]`);
        continue;
      }
      if (attr.interpolated) { dynamicValues.push(`${q.src} \`${q.selector}\` -> [${attr.name}=…]`); continue; }
      if (attr.value === null || attr.value === '') continue;
      const values = available.attrs.get(attr.name);
      if (![...values].some((v) => matchesOp(attr.op ?? '=', v, attr.value))) {
        orphans.push(`${q.src} asks for \`${q.selector}\` and no page that loads it has [${attr.name}${attr.op ?? '='}"${attr.value}"]`);
      }
    }
  }
  assert.deepEqual([...new Set(orphans)], [],
    `attributes the DOM cannot answer: ${[...new Set(orphans)].join(' | ')}`);

  // Both directions, like the id ledger: a new dynamic value belongs here only
  // after somebody reads it, and a value that becomes fixed leaves this list.
  assert.deepEqual([...new Set(dynamicValues)].sort(), [
    '/js/pages/scrape.js `label.chip input[data-source="${s.id}"]` -> [data-source=…]',
  ], 'every attribute value built at runtime, which this census cannot resolve');
  assert.deepEqual([...new Set(ledger)].sort(), [...UNWIRED.keys()].sort(),
    'the attributes known to be unwired: one becoming wired, or a second appearing, is a change to this list');
});

/**
 * The other door, and it is five times the size of this one.
 *
 * `querySelector` has 91 call sites in the scripts a page loads. `getElementById`
 * has 37 of its own, and eight of those files define
 *
 *     const $ = (id) => document.getElementById(id);
 *
 * which 284 calls go through with a bare string. Nine more hand a selector to
 * `closest()`, on an element a script very often wrote into an innerHTML two
 * lines earlier. So around 330 names reach the DOM here that nothing above
 * measures, and `getElementById` failing is the quietest failure this codebase
 * has: it returns null, and the code around it is written to survive that --
 * `if (el)`, `el?.value` -- so an id that was never in the markup means a control
 * that silently does nothing, with no empty list and no exception to notice.
 *
 * The helper is DETECTED. `$/\$\$` are the names this tree happens to use, and
 * reading them in would make the census true until someone renamed one, at which
 * point it would go quiet instead of red.
 */
function helperDefs(code) {
  const found = [];
  const passthrough = (name, params, forwarded, m) => {
    const names = params.split(',').map((s) => s.trim()).filter(Boolean);
    if (names.length === 1 && names[0] === forwarded) {
      found.push({ name, start: m.index, end: m.index + m[0].length });
    }
  };
  const ARROW = /(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*\(([^)]*)\)\s*=>\s*document\.getElementById\(\s*([A-Za-z_$][\w$]*)\s*\)\s*;?/g;
  for (const m of code.matchAll(ARROW)) passthrough(m[1], m[2], m[3], m);
  const FN = /function\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*\{\s*return\s+document\.getElementById\(\s*([A-Za-z_$][\w$]*)\s*\)\s*;\s*\}/g;
  for (const m of code.matchAll(FN)) passthrough(m[1], m[2], m[3], m);
  return found;
}

function idHelpers(code) {
  return helperDefs(code).map((d) => d.name);
}

/**
 * The string ids a bare identifier stands for, when the source says which.
 *
 * Two shapes exist in this tree and both are local: a loop binding the identifier
 * over a literal list -- `for (const id of ['odds-book', …])`, `NUMERIC.concat(
 * ['set-book']).forEach((id) => …)` -- and a `const NAMES = ['a','b']` that the
 * call then uses. Both are resolved, because both say which ids they are and a
 * census that stops one statement short of an array of four literal ids is
 * under-reading on purpose.
 *
 * Every pattern is matched against the text BEFORE the call and the winner has to
 * be within a few hundred characters of it, so a binding four hundred lines up
 * does not get attributed to a call at the bottom of the file. What is left over
 * -- a name that arrives from somewhere else entirely -- is the ledger below,
 * named with the reason it cannot be followed, rather than an assumption that it
 * is fine.
 */
function boundIdsFor(code, ident, at) {
  const head = code.slice(0, at);
  const literal = (body) => [...body.matchAll(/['"]([^'"]+)['"]/g)].map((m) => m[1]);
  let best = -1;
  let ids = null;
  const take = (index, values) => {
    if (index > best) { best = index; ids = values; }
  };
  for (const re of [
    new RegExp(`for\\s*\\(\\s*(?:const|let)\\s+${ident}\\s+of\\s*\\[([^\\]]*)\\]`, 'g'),
    new RegExp(`(?:const|let|var)\\s+${ident}\\s*=\\s*\\[([^\\]]*)\\]`, 'g'),
  ]) {
    for (const m of head.matchAll(re)) take(m.index, literal(m[1]));
  }
  // The list can sit in the callee of the loop that binds the name:
  // `NUMERIC.concat(['set-book']).forEach((id) => { $(id) … })`. Two things are
  // happening there and a version that looked at one of them resolved nothing:
  // the inline array is BEFORE `.forEach`, not after it, and the longer list is
  // in `NUMERIC`, declared on the line above and named rather than literal. So
  // the segment from the start of the `.forEach` line to the call is searched for
  // array literals, and any identifier in it that is declared as a literal array
  // somewhere earlier in the file is followed to its declaration.
  const LOOP = new RegExp(`\\.forEach\\(\\s*\\(\\s*${ident}\\s*\\)\\s*=>`, 'g');
  for (const m of head.matchAll(LOOP)) {
    const lineStart = head.lastIndexOf('\n', m.index) + 1;
    if (at - lineStart > 400) continue;
    const seg = head.slice(lineStart, at);
    const values = [...seg.matchAll(/\[([^\]]*)\]/g)].flatMap((b) => literal(b[1]));
    for (const name of new Set([...seg.matchAll(/\b([A-Za-z_$][\w$]*)\b/g)].map((x) => x[1]))) {
      const decl = new RegExp(`(?:const|let|var)\\s+${name}\\s*=\\s*\\[([^\\]]*)\\]`).exec(head);
      if (decl) values.push(...literal(decl[1]));
    }
    take(m.index, [...new Set(values)]);
  }
  if (best === -1 || at - best > 400) return null;
  return ids && ids.length ? ids : null;
}

const LOOKUPS = SCANNED.flatMap((s) => {
  const code = s.code;
  const defs = helperDefs(code);
  const helpers = defs.map((d) => d.name);
  const out = [];
  let callSites = 0;
  let literalCalls = 0;
  let resolvedCalls = 0;
  let directCalls = 0;
  let read = 0;
  let named = 0;
  // Counted a second way, with no lookbehind and no argument matching at all.
  // The census's own tallies classify every site it matches, so asking them
  // whether they add up is asking a sum to equal itself -- which is what an
  // earlier version of this asserted, and it could not have failed.
  const rawFor = (name) => [...code.matchAll(new RegExp(`${name.replace(/\$/g, '\\$')}\\(`, 'g'))].length;

  const take = (id, where) => { out.push({ src: s.src, loading: s.loading, id, where }); read += 1; };
  const ledger = [];

  // EVERY occurrence, not only the ones whose argument happens to be a string.
  //
  // Matching the literal form alone dropped five lookups in this tree, and
  // dropped them the quiet way: `document.getElementById(groupId)` and the
  // template that builds `group-${groupId}` in scrape.js, `getElementById(id)`
  // inside `animateValue` and inside `createDropdown` on dashboard.js and
  // common.js, and `getElementById(CONTAINER_ID)` in the toast stack. Not one
  // of them was counted anywhere, so the totals below added up and were wrong
  // by five. A door counted only when its argument is convenient is a door that
  // closes silently, which is the one failure mode this instrument exists to
  // rule out.
  //
  // What cannot be read is named, not dropped: a name bound somewhere the
  // resolver cannot follow, and a template no regex over source text turns into
  // an id. `CONTAINER_ID` is the interesting one -- the same function creates
  // that element when it is missing (common.js:99-106), so it is a different
  // fact from an id the page was supposed to carry, and naming it is what keeps
  // it from being reported as either.
  //
  // Naming it is also why nobody should inline it. Write
  // `getElementById('toast-container')` and this census resolves it, finds no
  // page carrying that id, and reports an orphan -- a false one, for an element
  // the code creates on purpose. Making the orphan check understand "written by
  // the script itself" is the honest fix, and it is not done here: this list is
  // what says so, and a control built on a register nobody has to keep current
  // is worse than a named limit.
  for (const m of code.matchAll(/getElementById\(([^)]*)\)/g)) {
    const at = m.index;
    // A passthrough's own definition is not a call; it is where the helper is.
    if (defs.some((d) => at >= d.start && at < d.end)) continue;
    const line = code.slice(0, at).split('\n').length;
    callSites += 1;
    directCalls += 1;
    const arg = m[1].trim();
    const literal = /^(['"])([^'"]+)\1$/.exec(arg);
    if (literal) { literalCalls += 1; take(literal[2], `getElementById():${line}`); continue; }
    if (/^[A-Za-z_$][\w$]*$/.test(arg)) {
      const bound = boundIdsFor(code, arg, at);
      if (bound) { resolvedCalls += 1; for (const id of bound) take(id, `getElementById(${arg}):${line}`); continue; }
    }
    named += 1;
    ledger.push(`${s.src}:${line}  getElementById(${arg})`);
  }

  const perHelper = new Map();
  for (const name of helpers) {
    const esc = name.replace(/\$/g, '\\$');
    const re = new RegExp(`(?<![\\w.$])${esc}\\(\\s*(.*?)\\s*\\)`, 'g');
    let here = 0;
    for (const m of code.matchAll(re)) {
      const at = m.index;
      const line = code.slice(0, at).split('\n').length;
      callSites += 1;
      here += 1;
      const arg = m[1].trim();
      const literal = /^(['"])([^'"]+)\1$/.exec(arg);
      if (literal) { literalCalls += 1; take(literal[2], `${name}():${line}`); continue; }
      if (/^[A-Za-z_$][\w$]*$/.test(arg)) {
        const bound = boundIdsFor(code, arg, at);
        if (bound) { resolvedCalls += 1; for (const id of bound) take(id, `${name}(${arg}):${line}`); continue; }
        named += 1;
        ledger.push(`${s.src}:${line}  ${name}(${arg})`);
        continue;
      }
      named += 1;
      ledger.push(`${s.src}:${line}  ${name}(${arg})`);
    }
    perHelper.set(name, { raw: rawFor(name), classified: here });
  }

  // Both halves of the selector, not just the classes. `closest('[data-add]')` is
  // three of this tree's nine -- `bookies.js:286`, `:290` and `settings.js:352` --
  // and asking only for the class names meant those three were measured for
  // nothing: a version reading `.foo` out of `[data-add]` finds no class, checks
  // nothing, and reports a clean tree. The three are wired today, which is
  // checked by reading them rather than by this, and a fourth being broken would
  // have gone unreported.
  const closest = [...code.matchAll(/closest\(\s*(['"])([^'"]+)\1\s*\)/g)]
    .map((m) => ({
      src: s.src,
      loading: s.loading,
      selector: m[2],
      classes: [...m[2].matchAll(/\.([A-Za-z_][\w-]*)/g)].map((c) => c[1]),
      attrs: attrsIn(m[2]),
    }));

  return [{
    src: s.src,
    loading: s.loading,
    code,
    helpers,
    out,
    ledger,
    callSites,
    literalCalls,
    resolvedCalls,
    named,
    read,
    closest,
    perHelper,
    defs: defs.length,
    directRaw: rawFor('getElementById'),
    directCalls,
  }];
});

test('every id a script looks up is carried by a page that loads the script', () => {
  // The controls. A census that read nothing reports zero orphans and passes, so
  // these name lookups that had to be among the ones read -- one per page-shaped
  // script, and one straight through the helper rather than getElementById.
  const readIds = new Set(LOOKUPS.flatMap((s) => s.out.map((o) => `${o.src} ${o.id}`)));
  for (const known of [
    '/js/pages/scrape.js log-panel',
    '/js/pages/scrape.js bookmaker-list',
    '/js/pages/scanner.js alert-min-roi',
    '/js/pages/dashboard.js opp-list',
    '/js/pages/settings.js table-sources',
  ]) {
    assert.ok(readIds.has(known), `the lookup \`${known}\` was among those read`);
  }

  // The helpers are detected, so the completeness of the read has to be stated
  // against the names each file actually calls. A file calling `$something()` that
  // this census did not find a passthrough for is a file whose lookups were never
  // read -- and that is exactly what happens if someone renames `$` to `byId`:
  // every lookup in the file would go unread and the orphan scan below would
  // report a clean tree.
  const blind = LOOKUPS.flatMap((s) => [...s.code.matchAll(/(?<![\w.$])\$[A-Za-z_$][\w$]*\(/g)]
    .map((m) => m[0].slice(0, -1))
    .filter((n) => !s.helpers.includes(n))
    .map((n) => `${s.src} calls ${n}(…) but no getElementById passthrough of that name was found, so none of its lookups were read`));
  assert.deepEqual([...new Set(blind)], [], blind.join(' | '));

  // Completeness, cross-checked against a count that shares none of this one's
  // machinery: a plain sweep for the name followed by `(`, no lookbehind, no
  // argument matching. If the reader's own pattern skips an occurrence the sweep
  // sees, the two part company.
  //
  // Two differences are known and subtracted rather than tolerated. A
  // `getElementById(` inside a passthrough's own DEFINITION is not a call, which
  // is why a file with a detected helper has exactly that many more occurrences
  // of the name than this census classified -- and why a definition in a form
  // the detector does not recognise turns this red instead of counting as a
  // lookup of an id nobody can name.
  const counted = LOOKUPS.flatMap((s) => [
    ...[...s.perHelper].map(([name, n]) => (
      n.raw === n.classified ? null : `${s.src} ${name}( appears ${n.raw} times but ${n.classified} were classified`
    )),
    s.directRaw === s.directCalls + s.defs
      ? null
      : `${s.src} getElementById( appears ${s.directRaw} times, which is not ${s.directCalls} classified plus ${s.defs} helper definitions`,
    // The counter and the list are written separately -- one increments, the
    // other appends -- so a path that names a lookup without counting it, or
    // counts one without naming it, shows up as a disagreement here rather than
    // as a ledger quietly short of a line.
    s.named === s.ledger.length ? null : `${s.src} counts ${s.named} unresolvable lookups but names ${s.ledger.length}`,
  ].filter(Boolean));
  assert.deepEqual(counted, [], counted.join(' | '));

  const orphans = [];
  const cache = new Map();
  for (const s of LOOKUPS) {
    if (!cache.has(s.src)) cache.set(s.src, availableTo(s.src, s.loading));
    const available = cache.get(s.src);
    for (const o of s.out) {
      if (!available.ids.has(o.id)) orphans.push(`${o.src} looks up #${o.id} at ${o.where}, and no page that loads it carries that id`);
    }
    for (const c of s.closest) {
      for (const cls of c.classes) {
        if (!available.classes.has(cls)) orphans.push(`${c.src} asks closest('${c.selector}') and no page that loads it has .${cls}`);
      }
      for (const a of c.attrs) {
        if (!available.attrs.has(a.name)) orphans.push(`${c.src} asks closest('${c.selector}') and no page that loads it writes ${a.name}`);
      }
    }
  }
  assert.deepEqual([...new Set(orphans)], [],
    `ids and closest() classes the DOM cannot answer: ${[...new Set(orphans)].join(' | ')}`);

  // The lookups whose argument is not one string literal: a name bound
  // somewhere this census cannot follow, and one template. Each is named with
  // the site it is, so the claim is checkable rather than assumed, and a
  // ninth of either shape turns this red. Deduplicated by text --
  // `scanner.js:577` holds two of them on one line -- because the count of call
  // SITES is reconciled above, and this list is a list of names.
  //
  // Five of these were invisible until the reader stopped requiring a literal,
  // so this list is not bookkeeping: it is the first place `CONTAINER_ID`
  // appears anywhere in the suite, and `CONTAINER_ID` is an id this repo never
  // puts in markup because common.js:99-106 creates it on demand.
  assert.deepEqual([...new Set(LOOKUPS.flatMap((s) => s.ledger))].sort(), [
    '/js/pages/common.js:28  getElementById(id)',
    '/js/pages/common.js:98  getElementById(CONTAINER_ID)',
    '/js/pages/dashboard.js:196  getElementById(id)',
    '/js/pages/scanner.js:49  $(id)',
    '/js/pages/scanner.js:577  $(id)',
    '/js/pages/scrape.js:353  getElementById(groupId)',
    '/js/pages/scrape.js:365  getElementById(`group-${groupId}`)',
    '/js/pages/settings.js:187  $(id)',
  ].sort(), 'lookups whose argument is a name bound somewhere this census cannot follow, or a template');
});

/**
 * The last door, and the one that was left open.
 *
 * The four tests above read three things a script does to the DOM: the classes
 * and ids and attribute names in its selectors, the classes and ids it writes,
 * and the ids it looks up. What none of them read is what it reads BACK -- which
 * in this tree is 25 reads of a `data-*` or `aria-*` attribute across ten
 * scripts, and the way this codebase writes them is `|| label` and `|| ''`. So a
 * read of an attribute nobody writes does not throw, does not render empty, and
 * leaves nothing to notice: it just takes the fallback, forever.
 *
 * `data-workspace-copy` is the proof that the gap was real rather than
 * theoretical. It is in the UNWIRED ledger below because somebody read the code
 * and typed it in. It is in this test's own output because the reader finds it,
 * and the difference between a name a maintainer remembered to write down and
 * one the instrument derives is the difference between a register that decays
 * and one that cannot.
 */
const READS = SCANNED.map((s) => ({ src: s.src, loading: s.loading, code: s.code, ...attrsReadBy(s.code) }));

test('every attribute a script reads is written by a page that loads it', () => {
  // The controls. Same reason as everywhere else in this file: a reader that
  // read nothing would find every read answered by nothing and report a clean
  // tree. These name the reads that have to be among them -- one per spelling,
  // and one per direction, because a reader that only ever saw `getAttribute`
  // would pass on the first line and fail on the second.
  const readNames = new Set(READS.flatMap((r) => [...r.read].map(([name]) => `${r.src} ${name}`)));
  for (const known of [
    '/js/connection-status.js data-connected-text',
    '/js/connection-status.js data-disconnected-text',
    '/js/pages/settings.js data-scrape',
    '/js/pages/scrape.js data-group-check',
    '/js/pages/analytics.js data-action',
    '/js/pages/event-detail-modal.js data-sport',
    '/js/pages/event-detail-modal.js data-event-url',
    '/js/app.js data-lang-set',
    '/js/i18n.js data-i18n-aria-label',
  ]) {
    assert.ok(readNames.has(known), `the read of \`${known}\` was among those read`);
  }

  // Completeness, the same cross-counter as the id half: sweep the door name
  // plainly, with no argument logic at all, and require the reader to have put
  // every occurrence in exactly one bucket. An occurrence the reader skips --
  // a backtick name, a computed `dataset[k]` -- breaks the arithmetic instead
  // of disappearing.
  const buckets = READS.flatMap((r) => [
    [...r.code.matchAll(/\bgetAttribute\(/g)].length
      !== r.getAttributeReads + r.other.length + r.dynamic.length
      ? `${r.src} has ${[...r.code.matchAll(/\bgetAttribute\(/g)].length} getAttribute( calls but ${r.getAttributeReads} reads, ${r.other.length} out-of-scope names and ${r.dynamic.length} dynamic arguments`
      : null,
    [...r.code.matchAll(/\bdataset\b/g)].length
      !== r.datasetCount
      ? `${r.src} mentions dataset ${[...r.code.matchAll(/\bdataset\b/g)].length} times but placed ${r.datasetCount}`
      : null,
  ].filter(Boolean));
  assert.deepEqual(buckets, [], buckets.join(' | '));

  // The answer, and the register. An attribute read by a script is answered by
  // the markup of a page that loads it, by another script that page loads, or by
  // a name in UNWIRED -- which is not an excuse but a claim, and the reason it
  // holds is written next to the name.
  const cache = new Map();
  const orphans = [];
  const unwired = [];
  for (const r of READS) {
    if (!cache.has(r.src)) cache.set(r.src, availableTo(r.src, r.loading));
    const available = cache.get(r.src);
    for (const [name, lines] of r.read) {
      if (UNWIRED.has(name)) { unwired.push(`${r.src} ${name}`); continue; }
      if (!available.attrs.has(name)) {
        orphans.push(`${lines.map((n) => `${r.src}:${n}`).join(', ')} reads ${name}, and no page that loads it writes it`);
      }
    }
  }
  assert.deepEqual([...new Set(orphans)].sort(), [], `attributes the DOM cannot answer: ${[...new Set(orphans)].join(' | ')}`);

  // The other direction: a named defect that gets wired has to leave the ledger,
  // so a fixed one cannot sit in the UNWIRED list forever claiming to be broken.
  // The left side is what this reader FOUND unwired; the right side is what the
  // register claims and the reader has to agree with. Wiring the attribute takes
  // it off the left while the register still names it, and the two part company.
  const claimed = [...UNWIRED.keys()].flatMap((k) => READS.filter((r) => r.read.has(k)).map((r) => `${r.src} ${k}`));
  assert.deepEqual([...new Set(unwired)].sort(), [...new Set(claimed)].sort(),
    'the register of unwired attributes, and the reads that found each one');

  // And the direction that comparison cannot see, because BOTH of its sides are
  // derived from the register: a name the register names and no read reaches
  // leaves the right side, and nothing else in the file can put it on the left.
  // `app.js:218` is the only read of `data-workspace-copy` in the tree, so
  // renaming that one expression left the register claiming a defect that no
  // measurement touches -- two empty lists comparing equal, and the register
  // decaying in exactly the way its own comment says is impossible.
  const stranded = [...UNWIRED.keys()].filter((k) => !unwired.some((s) => s.endsWith(` ${k}`)));
  assert.deepEqual(stranded, [],
    `the register names ${stranded.join(' | ')}, and no read found it: a claim nothing measures`);
});