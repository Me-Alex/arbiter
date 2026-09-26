# Arbiter Design System

A unified design language for the Arbiter sports arbitrage scanner web application.

## Architecture

The visual layer is built on CSS custom properties (design tokens) as the single source of truth.

```
design-tokens.css  →  theme.css  →  page-specific CSS (dashboard.css, scanner.css, etc.)
     ↓
  :root variables     Global resets,       Page-specific layouts,
  for colors,         components,           animations, and
  spacing, motion     utilities             presentation refinements
```

### File hierarchy

| File | Role |
|---|---|
| `public/css/design-tokens.css` | Token definitions (`:root` variables) |
| `public/css/theme.css` | Global resets, components, utilities, responsive breakpoints |
| `public/css/dashboard.css` | Dashboard grid, opportunity cards, source health, entrance animations |
| `public/css/scanner.css` | Scanner summary cards, tables, scan controls |
| `public/css/scrape.css` | Scrape KPI cards, progress bar, pipeline stepper, bookmaker chips |
| `public/css/analytics.css` | Analytics KPI cards, tracker/catalog tables, modals |

## Design Tokens

All visual values are defined as CSS custom properties in `design-tokens.css`. Never hard-code colors, spacing, or timing values in component CSS.

### Color System

**Surface scale** (backgrounds):
- `--bg-0` through `--bg-5` — progressive surface depth
- `--surface-highlight` — subtle white overlay for card tops
- `--surface-overlay` — semi-transparent backdrop

**Semantic colors** (each with base, `-soft`, `-strong`, and `-glow` variants):
- `--green` — confirmed, fresh, won, positive states
- `--yellow` — warning, stale, review states
- `--red` — error, failed, rejected states
- `--purple` — middles, secondary accent
- `--accent` — primary interactive color (sky blue)

**Text hierarchy**:
- `--text-strong` — headings, primary values
- `--text` — body text
- `--text-muted` — labels, secondary info
- `--text-dim` — tertiary, placeholder text

### Light mode

Activate by setting `data-theme="light"` on `<html>`. The token file
(`design-tokens.css`) overrides every group with lighter surface colors,
reduced shadows, and higher-contrast accent values. Dark mode remains the
default; light mode is opt-in. Component-level overrides live in
`theme.css` under `[data-theme="light"]` selectors.

### Spacing Scale

```
--s-1: 4px    --s-4: 16px   --s-8: 32px    --s-16: 64px
--s-2: 8px    --s-5: 20px   --s-10: 40px   --s-20: 80px
--s-3: 12px   --s-6: 24px   --s-12: 48px
```

### Typography

- **Sans**: Inter, system fallbacks — body text, UI elements
- **Mono**: JetBrains Mono, system fallbacks — numbers, codes, technical data
- **Display**: Inter — page headings

Font size scale: `--fs-xs` (11px) through `--fs-6xl` (60px)

### Motion

Easing curves:
- `--ease-out` — entrances, transitions (decelerate)
- `--ease-in-out` — state changes (symmetric)
- `--ease-spring` — playful bounces, pop effects

Duration scale:
- `--t-fast` (140ms) — hover states, micro-interactions
- `--t-base` (200ms) — standard transitions
- `--t-slow` (340ms) — page transitions, entrance animations
- `--t-slower` (520ms) — complex multi-step animations

### Border Radii

```
--r-xs: 4px    --r-md: 10px   --r-xl: 20px   --r-full: 999px
--r-sm: 6px    --r-lg: 14px   --r-2xl: 28px
```

## Components

### Cards (`.card`)
Background with subtle gradient highlight, border, and shadow. Hover lifts with brighter border.
- `.card-elevated` — deeper shadow for emphasis
- `.card-glass` — frosted glass effect with backdrop blur
- `.card-hover` — link-style cards (analytics KPIs)

### Status Badges (`.status`)
Inline pill with colored dot indicator. Semantic variants:
- `.idle`, `.pending` — neutral
- `.running` — accent blue, pulsing dot
- `.ok`, `.live`, `.completed`, `.fresh`, `.confirmed`, `.won` — green
- `.failed`, `.error`, `.rejected`, `.lost` — red
- `.stale`, `.partial`, `.busy`, `.review` — yellow

### Buttons
- `.primary` — filled accent button with gradient
- `.ghost` — transparent with border
- `.danger` — red variant for destructive actions
- `.sm` — compact size

### Tables
Clean table style with sticky headers, alternating row tints, and hover highlights.
- `.table-wrap` — bordered container with rounded corners
- `.table-clean` — no outer border, for use inside cards
- `.compact` — reduced padding for data-dense tables

## Animations

### Entrance Animations
All major sections use staggered entrance animations:
- `cardSlideIn` — cards slide up from below with fade
- `rowSlideIn` — table rows slide in from left
- `scanSlideIn` — scanner/scrape sections slide up
- `analyticsSlideIn` — analytics sections slide up

Stagger delays are applied via `:nth-child` selectors (0-300ms range).

### Data Update Flash
When data updates via SSE, elements briefly flash with `--accent-soft` background:
- `.flash` class is toggled on update
- First load is skipped (tracked via `_isFirstLoad` flags)
- Animation duration: 500-800ms

### Source Health Freshness Bars
Visual progress indicators showing data age:
- `.freshness-bar .fill.fresh` — green, >70% fresh
- `.freshness-bar .fill.stale` — yellow, 30-70%
- `.freshness-bar .fill.old` — red, <30%

### KPI Count Pop
Numbers animate with a brief scale pulse on value change (`.counting` class).

## Accessibility

### Preferences
- `prefers-reduced-motion: reduce` — disables all animations and transitions
- `prefers-contrast: more` — increases border contrast and text brightness

### ARIA & Semantics
- All tables have `<caption>` and `<th scope="col">`
- Interactive elements have `aria-label` attributes
- `aria-busy` on loading containers
- `role="alert"` and `aria-live="polite"` on error messages
- Skip navigation link (`.visually-hidden-focusable`)
- `lang` attribute updates on language switch

### Focus Management
- `:focus-visible` ring using `--ring-strong`
- Keyboard-navigable sidebar and controls

## Responsive Design

Breakpoints:
- `1080px` — quickbar stacks to 2 columns
- `980px` — sidebar becomes slide-out overlay, dashboard stacks
- `700px` — mobile optimizations, reduced padding
- `600px` — single-column layouts, compact cards

Mobile sidebar uses overlay pattern with backdrop blur.

## Shared JavaScript Helpers

### `public/js/pages/common.js`
- `createDropdown(id, options, {storageKey, placeholder})` — builds a `<select>`, restores value from `localStorage`, persists on change
- Used by Scanner and Scrape pages with independent storage keys

### `public/js/app.js`
- `arbiterApp.mount(page)` — injects sidebar navigation
- `arbiterApp.applyDesignTokens()` — toggles theme based on saved preference
- Skip navigation link injection
- Language toggle with `lang` attribute sync

### `public/js/connection-status.js`
- Auto-wires into `arbiterSse.connect()` to update `.sse-status` chip elements
- Shows transient toasts on reconnection and connection loss
- Wraps `arbiterApi` methods to auto-toast on fetch errors
- `arbiterConnectionStatus.setDataHealth(health)` — shows/hides data-freshness banner

### Dual server entrypoints

| Entrypoint | Command | Description |
|-----------|---------|-------------|
| `src/server.mjs` | `npm start` | Constructs the services, then delegates every request to `router.mjs`. |

It binds to `127.0.0.1:PORT`, serves the `public/` static files, and enforces
the CSP / CSRF / loopback-only security model. The routing itself lives in
`router.mjs`; the services it wires are independently testable. A second
entrypoint (`server-modular.mjs`) once duplicated the route table and drifted
from it, so it was removed rather than kept in sync.

## Critic Loop

Run `npm run critic-loop` to evaluate the codebase across 8 perspectives:
1. Architecture — token system, file structure, no inline handlers
2. Code Quality — lint compliance, no unused globals
3. Security — CSP, CSRF, escapeHtml usage
4. Performance — minimal inline styles, no hardcoded colors
5. Testing — test suite passes, UI test file exists
6. Documentation — README, CONTRIBUTING, JSDoc
7. UX — skip nav, reduced motion, sidebar, WCAG attributes
8. Maintainability — utility classes, responsive breakpoints, shared helpers

The loop auto-fixes lint issues and terminates when all perspectives score 10/10 or after 100 iterations.
