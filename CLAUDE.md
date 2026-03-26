# AutoADA — Claude Code Context File

> **IMPORTANT**: This file is the persistent context for Claude Code sessions. When starting a new session, read this file FIRST to understand the project state, what changes have been made, and what instructions to follow.

## Project Overview
AutoADA is an automated ADA/WCAG 2.2 Level AA accessibility compliance scanner. It uses Puppeteer + axe-core to scan websites, calculates compliance scores, captures annotated screenshots, and generates professional reports (HTML, PDF, JSON, CSV). It has both a CLI (`src/index.js`) and a web UI with Express API (`src/server.js`).

## Architecture
```
src/
├── index.js              # CLI entry point (Commander.js)
├── server.js             # Express web server + SSE progress streaming
├── crawler.js            # Page discovery (sitemap.xml + extra URLs)
├── scanner.js            # Core scanning engine (Puppeteer + axe-core)
├── score.js              # Compliance scoring (0-100) + benchmarking
├── screenshotter.js      # Screenshot capture with violation overlays
├── confidence.js         # [NEW — Sub-Phase 2.5] False-positive confidence scoring
├── seo.js                # [NEW — Phase 3] AutoSEO engine (Lighthouse + HTML SEO analysis)
├── reporters/
│   ├── json.js           # JSON report generator
│   ├── csv.js            # CSV report generator
│   ├── html.js           # Self-contained HTML report (all CSS/JS inline)
│   └── pdf.js            # PDF via Puppeteer HTML→PDF
├── data/
│   ├── benchmarks.json   # Industry benchmarks (WebAIM Million 2025)
│   ├── false-positives.json  # FP metadata per axe-core rule
│   ├── remediation.json  # Fix guidance + before/after code examples
│   └── wcag-map.json     # [NEW — Sub-Phase 2.6] WCAG SC → {name, level, principle, legal}
└── web/
    └── index.html        # SPA dashboard (dark theme)
```

## Key Technical Details
- **Node.js >= 18** required
- **Puppeteer v23+** with `@axe-core/puppeteer v4.10+`
- axe-core modern mode (default) — handles iframes + open shadow DOM automatically
- Each page scanned at 2 viewports: Desktop (1280×900) + Mobile (375×812)
- Scoring: weighted by node count + severity, logarithmic penalty scaling
- Reports are fully self-contained (no external dependencies)

## Development Methodology
This project follows the **Ralphy methodology**:
1. **Task-driven**: Break work into discrete, trackable micro-tasks
2. **Test before moving on**: Every feature is tested before proceeding to the next
3. **Small focused changes**: One logical change per commit
4. **Quality over speed**: Correctness and reliability over shipping fast
5. **Isolated execution**: Each task is a clean, independent unit of work

## Mandatory Instructions for Claude Code
1. **Read this file first** when starting any session
2. **Log all changes** to the Session Changelog below after completing work
3. **Follow Ralphy methodology** — test each feature before moving to the next
4. **Do not modify** `package-lock.json` directly — use `npm install` for dependency changes
5. **Preserve backward compatibility** — CLI flags and API endpoints should not break
6. **Run a scan test** after any change to scanner.js, score.js, or reporters to verify no regressions
7. When implementing tasks, reference the "Current Execution Plan" section below and the plan file at `/Users/tushartomar/.claude/plans/declarative-wiggling-dolphin.md`

---

## Phase 2 Implementation Status

### Sub-Phase 2.1: Bug Fixes & Data Corrections ✅ COMPLETE
- [x] Task 2.1.1: Fix `cat.time-and-media` duplicate key in `score.js`
- [x] Task 2.1.2: Update benchmarks.json with WebAIM Million 2025 data

### Sub-Phase 2.2: Scoring Accuracy ✅ COMPLETE
- [x] Task 2.2.1: Weight scoring by node count (not rule count)
- [x] Task 2.2.2: Handle incomplete rules in scoring as "Needs Review"

### Sub-Phase 2.3: Scanner Reliability & Performance ✅ COMPLETE
- [x] Task 2.3.1: Request interception (block images/fonts/media, keep stylesheets)
- [x] Task 2.3.2: Optimize from 4 page loads to 2 per URL
- [x] Task 2.3.3: Retry with exponential backoff (2 retries, 2s/4s delays)
- [x] Task 2.3.4: Smarter popup dismissal (verify parent is modal/overlay)

### Sub-Phase 2.4: Scanner Coverage Expansion ✅ COMPLETE
- [x] Task 2.4.1: Verify/enhance iframe + shadow DOM scanning
- [x] Task 2.4.2: Link-based crawling + robots.txt parsing (`--crawl` flag)
- [x] Task 2.4.3: Interactive state scanning (`--interactive` flag)

### Sub-Phase 2.5: False Positive Reduction ✅ COMPLETE
- [x] Task 2.5.1: Confidence scoring (`_confidence: high/medium/low`)
- [x] Task 2.5.2: Contextual false-positive detection (node-level context checks)

### Sub-Phase 2.6: Report Quality ✅ COMPLETE
- [x] Task 2.6.1: WCAG success criterion detail mapping (`wcag-map.json`)
- [x] Task 2.6.2: Enhanced executive summary (risk assessment, metrics, priorities)
- [x] Task 2.6.3: Better screenshot capture (multi-region, scroll to violations)
- [x] Task 2.6.4: Page-level breakdown in HTML report

### Sub-Phase 2.7: Infrastructure & Performance ✅ COMPLETE
- [x] Task 2.7.1: Memory leak fix (TTL cleanup for scan store)
- [x] Task 2.7.2: Concurrent page scanning (`--concurrency` option)
- [x] Task 2.7.3: axe-core configuration support (`--axe-config` option)

### Sub-Phase 2.8: Dashboard UI Enhancement ✅ COMPLETE
- [x] Task 2.8.1: Manual testing checklist in dashboard (NOT in report)

---

## Current Execution Plan — 17 Phases, 84 Tasks

> Full code audit found 56 issues across 15 files (~7,000 lines). This plan fixes ALL bugs first (stable foundation), then restructures UX to make SEO a first-class citizen alongside ADA, then verifies everything end-to-end on real sites.

```
FOUNDATION (Code Health)     → Phases 1-9:  Stable, bug-free codebase
STRUCTURE (UX Restructure)   → Phases 10-13: New navigation, layout, components
FEATURES (New Capabilities)  → Phases 14-15: Screenshot annotations, contrast verification
POLISH (Exports, Branding)   → Phase 16:    Final cleanup
VERIFICATION (E2E)           → Phase 17:    Real-site testing
```

**Methodology**: Ralphy — test each task immediately, do NOT proceed until 100% working, log everything to CLAUDE.md.
**Plan file**: `/Users/tushartomar/.claude/plans/declarative-wiggling-dolphin.md`

### Phase 1: Test Infrastructure Setup ✅ COMPLETE
- [x] Created `__tests__/unit/` with score.test.js (26 tests), confidence.test.js, seo.test.js
- [x] Created `__tests__/smoke/server.test.js` (9 tests, child process spawn)
- [x] Added test scripts to package.json (test, test:unit, test:smoke, test:all)
- [x] All 35 tests passing (26 unit + 9 smoke)

### Phase 2: Critical Bug Fixes — Scanner & Server ✅ COMPLETE
- [x] Puppeteer launch error handling — `scanner.js` `scanAllPages()`: try-catch around `puppeteer.launch()`
- [x] Empty/blank page detection — `scanner.js` `loadPageDefensively()`: content validation after network idle
- [x] Fix clientLogoBase64 always null — `server.js`: accept from req.body, validate, store
- [x] Fix SSE progress memory leak — `server.js`: MAX_PROGRESS_EVENTS=500 cap
- [x] Fix crashed scans never cleaned up — `server.js`: stale timeout 60min, force-mark error
- [x] SEO browser pooling (3→2 launches) — `seo.js`: share browser between analysis phases

### Phase 3: SEO & Score Null Safety ✅ COMPLETE
- [x] Fix generateSpeedSuggestions() null crashes — optional chaining on ALL metric accesses
- [x] Fix runSeoAnalysis() uncaught page.goto() — try-catch with cleanup
- [x] Fix calculateSeoScore() crash on undefined — defensive destructuring
- [x] Fix extractOpportunities() truncation — add totalItems/truncated fields
- [x] Fix score.js severity bounds — unknown counter in getSeverityBreakdown()

### Phase 4: Error Handling & Logging ✅ COMPLETE
- [x] Fix ~15 silent catch blocks — debugLog() with AUTOADA_DEBUG=1
- [x] axeConfig validation — validateAxeConfig() with type checks
- [x] Fix bare catches in server.js — logged warnings, move fs require to top
- [x] PDF generation timeout — 90s Promise.race + page.pdf() timeout
- [x] Replace all alert() with toasts — ~10 calls → showToast()

### Phase 5: Code Deduplication ✅ COMPLETE
- [x] Create shared reporter utils — `src/reporters/utils.js` (escapeHtml, formatTarget, etc.)
- [x] Import getPrinciple from score.js — remove ~40 duplicate lines from html.js
- [x] Consolidate confidence rule overlap — BEST_PRACTICE_RULES canonical
- [x] Extract duplicate background regex — hasBackgroundImageContext() helper
- [x] Fix parseRobotsTxt called twice — hoist to run once

### Phase 6: Security Hardening ✅ COMPLETE
- [x] Fix XSS in checklist onclick — event delegation + data attributes
- [x] Fix fragile copy-fix onclick — data-attribute approach with JS Map
- [x] Add Content-Type charset — `; charset=utf-8` on ALL headers
- [x] Validate sitemap URLs same-domain — skip cross-domain

### Phase 7: Performance & Optimization ✅ COMPLETE
- [x] Extract magic numbers — module-level constants with JSDoc
- [x] Optimize screenshotter MAX_REGIONS 2→3 — early return if empty
- [x] Redirect loop protection — maxRedirects=5 in fetchUrl()
- [x] URL normalization for dedup — strip utm_*, fbclid, gclid
- [x] Response size limit — maxBytes=5MB in fetchUrl()

### Phase 8: Dashboard Reliability ✅ COMPLETE
- [x] Close EventSource on navigation — module-level vars, close in showView()
- [x] Clear elapsed timer between scans — clearInterval at start of startScan()
- [x] fetchWithTimeout helper — AbortController, replace ~12 fetch() calls
- [x] Fix checklist race condition — await data files before renderChecklist()
- [x] Replace innerHTML += in loops — build string first, assign once

### Phase 9: Code Health Verification (Testing Only) ✅ COMPLETE
- [x] CLI scan: gov.uk — score 78 (50 pages), all 4 reports, no crashes
- [x] CLI scan: the-internet.herokuapp.com — score 84, color-contrast low confidence, 3 pages
- [x] Dashboard feature verification — all tabs, toasts, zero console errors
- [x] Code health markers verified: 35/35 tests, 9 modules load, 0 alert(), 0 innerHTML+=

### Phase 10: Landing Page — Dual Value Proposition ✅ COMPLETE
- [x] Update hero — "WCAG 2.2 + SEO ANALYSIS" badge, dual title
- [x] Scan type toggle — ADA + SEO checkboxes below URL input
- [x] Update feature cards — add SEO cards, tag colors (ADA purple, SEO green, BOTH blue)
- [x] Update How It Works — Lighthouse alongside axe-core
- [x] Update What Gets Checked — POUR + SEO pillars
- [x] Update footer — "Powered by axe-core + Lighthouse"
- [x] Tests — landing renders, scan toggle, full regression

### Phase 11: Results Page — Top-Level Audit Toggle ✅ COMPLETE
- [x] Audit switcher — segmented control: ADA / SEO / Combined, URL-state driven
- [x] Adaptive summary cards — different cards per view
- [x] ADA sub-tabs — Overview | Impact | Roadmap | Violations | Exports
- [x] SEO sub-tabs — Overview | Issues | Meta & Content | Performance | Suggestions | Exports
- [x] Remove "AutoSEO [NEW]" tab — content moved to SEO sub-tabs
- [x] Tests — switcher, URL state, back/forward, EventSource cleanup

### Phase 12: Combined Summary Dashboard ✅ COMPLETE
- [x] Health score cards — ADA + SEO side-by-side with drill-through links
- [x] Top 5 cross-audit issues — severity sorted from both audits
- [x] Overlapping issues — missing alt, headings, lang, title (ADA + SEO)
- [x] Quick stats row — Pages, Issues, Overlapping, Fix Time
- [x] Tests — combined default, overlaps, drill-through

### Phase 13: SEO Roadmap & Impact Simulator ✅ COMPLETE
- [x] SEO Roadmap — 3-column Quick/Medium/Deep layout
- [x] SEO Impact Simulator — toggle switches with projected score
- [x] Scatter plot — effort vs impact, colored by severity
- [x] Tests — categories, simulator, scatter, ADA intact

### Phase 14: Screenshot Annotations with Issue Descriptions ✅ COMPLETE
- [x] Extend annotation data model — selector, box, rule, description, severity, confidence
- [x] Annotation rendering — numbered markers + legend table
- [x] False annotation filtering — skip invisible, merge overlap, confidence-based
- [x] Tests — markers match legend, invisible filtered, review toggle

### Phase 15: Color Contrast Pixel Verification ✅ COMPLETE
- [x] Separate confirmed vs needs-review — red/amber badges
- [x] Pixel-level color sampling — crop, sample fg/bg, calculate WCAG ratio
- [x] Pipeline integration — run after axe-core on incomplete color-contrast
- [x] UI display — swatches, ratios, collapsible resolved/uncertain
- [x] Tests — separation, accuracy, anti-aliasing, <5s performance

### Phase 16: Export Parity & Branding Cleanup ✅ COMPLETE
- [x] Consolidate exports — Combined Report (ADA+SEO in one PDF/HTML/JSON)
- [x] Updated Developer Handoff — SEO + ADA, overlapping first
- [x] Branding cleanup — updated tagline, badge SVG with SEO, 5 export formats
- [x] Tests — all formats for ADA/SEO/Combined verified

### Phase 17: Final End-to-End Verification (Testing Only) ✅ COMPLETE
- [x] CLI: example.com — score 95, all 4 reports, confidence fields
- [x] CLI: the-internet.herokuapp.com — contrast split (4 confirmed/1 needs-review), PDF 2.5MB
- [x] Dashboard: full API flow — 9/9 endpoint tests pass, all export formats
- [x] Full feature matrix — 43/43 checks across all 17 phases
- [x] Performance — 11/11 modules, 35/35 tests, no regressions

### Execution Rules (Ralphy Methodology)
1. Execute phases in strict order — do NOT skip ahead
2. Test each task immediately after implementation
3. Do NOT proceed to next phase until the testing gate passes
4. Log all changes to CLAUDE.md Session Changelog after each phase
5. If a test fails, fix before moving forward — never skip
6. DO NOT implement placeholders or stubs — full implementations only
7. Dark theme only — respect existing CSS variables
8. axe-core 'incomplete' = 'needs review', NOT violations
9. Lighthouse scores fluctuate ±5 — never assert exact values
10. Preserve all existing API routes and export functionality
11. Move `const fs = require('fs')` to top of files
12. Replace ALL `alert()` with `showToast()` — zero `alert()` remaining
13. Never use `innerHTML +=` in loops — build string first, assign once
14. All Content-Type headers must include `charset=utf-8`

---

## What Was Changed in Completed Sub-Phases

### Sub-Phase 2.1 Changes
- **`src/score.js` line 16**: Changed `'cat.time-and-media': 'Operable'` → `'cat.time-limits': 'Operable'` (fixed duplicate key bug — `cat.time-and-media` correctly maps to `'Perceivable'` on line 10)
- **`src/data/benchmarks.json`**: Updated with WebAIM Million 2025 data — added `failure_rate: 94.8`, `average_errors_per_page: 51`, updated `common_issues` percentages, added `source_url` and `last_updated`
- **`src/web/index.html`**: Updated hardcoded dashboard stats from `86%/60%/51%` to `79.1%/55.5%/94.8%`, changed "Sites with Empty Links" → "Sites Failing WCAG"

### Sub-Phase 2.2 Changes
- **`src/score.js` `calculateOverallScore()`**: Rewrote to weight by node count. Violations weighted by node count in base score, severity handled via logarithmic penalty `weight * (1 + Math.log2(nodeCount))`. Penalty scaled as `(rawPenalty / totalRules) * 25` capped at `baseScore`.
- **`src/score.js` `calculatePrincipleScores()`**: Added third `incomplete` parameter. Each principle now tracks `needsReview` count. Incomplete rules NOT counted as violations.
- **`src/score.js` `calculateScores()`**: Now reads `allIncomplete` from scan results, outputs `totalIncomplete` and `totalIncompleteNodes`.

### Sub-Phase 2.3 Changes (Full scanner.js rewrite)
- **`enableRequestInterception(page)`**: Blocks `image`, `font`, `media`, `beacon`, `csp_report`, `ping` resource types + tracker domains (google-analytics, doubleclick, facebook, etc.)
- **`withRetry(fn, maxRetries=2, baseDelay=2000)`**: Exponential backoff retry wrapper. Delays: 2s, 4s.
- **`isInOverlayContainer(page, btn)`**: Checks ancestors for `role="dialog"`, `role="alertdialog"`, overlay class patterns, `position: fixed`, or high z-index before dismissing popups.
- **`scanViewport(browser, url, viewport, tags, timeout, axeConfig)`**: Loads page ONCE per viewport, scans before AND after overlay dismissal, merges violations via `mergeViolations()`. Replaces old 4-load approach.
- **`scanPage()`**: Now wraps each viewport in `withRetry()`, calls `scanViewport()` instead of 4x `scanPageState()`.
- **`runAxeAnalysis()`**: Accepts optional `axeConfig` parameter (prep for Task 2.7.3).
- **End-to-end tested**: example.com scan completed in 14.2s, 0 violations, 9 passes, score 100.

### Sub-Phase 2.4 Changes
- **`src/scanner.js` `logNestedViolationContext()`**: Tags each violation node with `_context: 'iframe' | 'shadow-dom' | 'standard'` by inspecting axe-core's nested target arrays. Logs counts of iframe/shadow DOM violations.
- **`src/scanner.js` `scanInteractiveStates(page, tags, axeConfig)`**: Finds collapsed elements (`[aria-expanded="false"]`, `details:not([open])`, unselected tabs, etc.), clicks each (max 10), re-runs axe-core, and returns additional violations tagged with `_source: 'interactive'`. Integrated into `scanViewport()` when `interactive=true`.
- **`src/crawler.js` `parseRobotsTxt(baseUrl)`**: Fetches `/robots.txt`, parses `Disallow` patterns for `User-agent: *`. Returns array of disallowed path prefixes.
- **`src/crawler.js` `isDisallowed(urlPath, disallowedPaths)`**: Checks URL path against robots.txt patterns (prefix match, wildcard, exact).
- **`src/crawler.js` `crawlLinks(startUrl, maxPages, disallowedPaths)`**: BFS link crawling using Puppeteer. Same-domain only, skips non-page extensions (pdf, images, etc.), respects robots.txt. Blocks images/fonts/media/stylesheets during crawl for speed.
- **`src/crawler.js` `discoverPages()`**: Added 4th parameter `crawlOptions = { enabled }`. When enabled, fetches robots.txt then runs BFS link crawl after sitemap + extra URLs.
- **`src/index.js`**: Added `--crawl` (link-based crawling) and `--interactive` (interactive state scanning) CLI flags, both disabled by default.
- **`src/server.js`**: Added `crawl` and `interactive` to POST `/api/scan` body params and scan options pipeline.

### Sub-Phase 2.5 Changes
- **`src/confidence.js` (NEW)**: Rule-level confidence scoring — `HIGH_CONFIDENCE_RULES` (deterministic rules like `html-has-lang`, `document-title`, `button-name`), `MEDIUM_CONFIDENCE_RULES` (moderate FP rate like `heading-order`, `region`, `label`), and low confidence for any rule in `false-positives.json`.
- **`src/confidence.js` `applyContextualChecks()`**: Node-level context checks that can downgrade individual nodes: `image-alt` with `alt=""` (decorative), `color-contrast` with `background-image`/gradient/opacity, `aria-hidden-focus` with `tabindex=-1` or modal patterns, `empty-heading` with SVG/images, `link-in-text-block` with visual differentiators.
- **`src/scanner.js`**: Integrated `applyConfidenceScores()` call on `allViolations` in `scanAllPages()` after aggregation.

### Sub-Phase 2.6 Changes
- **`src/data/wcag-map.json` (NEW)**: Complete mapping of all 55 WCAG 2.2 Level A+AA success criteria. Each entry: `{name, level, principle, guideline, legalRelevance, description}`. Keyed by SC number (e.g., `"1.1.1"`, `"1.4.3"`).
- **`src/reporters/html.js`**: Imported `wcag-map.json` and `calculateOverallScore` from `score.js`. Added `getWcagDetails(tags)` — parses axe-core tags (e.g., `wcag143` → `1.4.3`) and looks up SC details. Added WCAG SC detail blocks to each violation card (SC number, name, level badge, guideline, legal relevance). Rewrote `renderExecutiveSummary()` with risk assessment (HIGH/MODERATE/LOW), 4-card key metrics row, recommended priority actions, WebAIM Million 2025 percentile comparison. Added `renderScreenshots()` helper for multi-region screenshot support. Rewrote `renderDetailedFindingsByPage()` with per-page scores via `calculateOverallScore()`, severity breakdowns, page summary table, and TOC navigation. Added `safePathname()` and `countBySeverity()` helpers. New CSS for `.metrics-row`, `.metric-card`, `.risk-badge`, `.priority-list`, `.wcag-sc-list`, `.badge-level-a`, `.badge-level-aa`.
- **`src/screenshotter.js`**: Full rewrite for multi-region capture. `captureAnnotatedScreenshot()` groups violations by vertical position, captures up to 5 region screenshots. New functions: `groupIntoRegions()` (bins by viewport-sized chunks, prioritizes severity), `captureRegion()` (scroll + inject overlays + capture + cleanup), `captureSingleViewport()` (fallback), `cleanupOverlays()`. Returns `{base64, width, height, regions: [{base64, label, violationCount}]}`. Backward compatible via `result.base64`.
- **`src/score.js`**: Exported `calculateOverallScore` alongside `calculateScores` for use by HTML reporter per-page scoring.
- **`src/web/index.html`**: Added `getScreenshotSrc(shot)` helper for both `.image` and `.base64` formats. Updated `renderScreenshots()` for multi-region screenshot rendering.

---


## Session Changelog

> Every Claude Code session that modifies this project MUST log a summary here.
> Format: `### Session [DATE] — [Brief Description]`
> Include: what was changed, which files were modified, which tasks were completed.

### Session 2026-03-09 — Phase 2 Planning
- **Created**: `CLAUDE.md` (this file) for cross-session context retention
- **Created**: Phase 2 implementation plan with 8 sub-phases, 21 tasks
- **Research completed**: axe-core iframe/shadow DOM support, request interception patterns, WebAIM Million 2025 data, axe-core configuration API, WCAG success criteria mapping
- **Key finding**: axe-core modern mode already handles iframes + shadow DOM by default — no code change needed, just verification
- **Key finding**: `cat.time-and-media` duplicate key in `score.js` causes principle misclassification (bug)
- **Key finding**: Current scoring weights by rule count, not node count, inflating scores for sites with few violation rules but many affected elements
- **No code changes made** — planning session only

### Session 2026-03-09 — Sub-Phases 2.1, 2.2, 2.3 Implementation
- **Completed**: All 8 tasks across Sub-Phases 2.1, 2.2, and 2.3
- **Files modified**:
  - `src/score.js` — Fixed duplicate key bug, rewrote scoring to weight by node count, added incomplete/needsReview handling
  - `src/scanner.js` — Full rewrite: request interception, 4→2 page load optimization, retry with backoff, smarter popup dismissal, scanViewport() architecture
  - `src/data/benchmarks.json` — Updated with WebAIM Million 2025 data
  - `src/web/index.html` — Updated hardcoded dashboard stats to match 2025 data
- **Testing**: All changes verified with unit tests and end-to-end scan of example.com (14.2s, score 100, 0 violations, 9 passes)
- **Key fix**: Scoring double-penalization bug caught and fixed — initial implementation weighted severity in both base score AND penalty, producing scores of 0. Fixed by isolating severity to penalty-only.

### Session 2026-03-09 — Sub-Phases 2.4, 2.5 Implementation
- **Completed**: All 5 tasks across Sub-Phases 2.4 and 2.5
- **Files modified**:
  - `src/scanner.js` — Added `logNestedViolationContext()` for iframe/shadow DOM violation tagging, `scanInteractiveStates()` for accordion/tab/details scanning, integrated confidence scoring, plumbed `interactive` option through all scan functions
  - `src/crawler.js` — Added `parseRobotsTxt()` for /robots.txt fetching/parsing, `crawlLinks()` for BFS link-based page discovery with Puppeteer, `isDisallowed()` for robots.txt enforcement, updated `discoverPages()` with `crawlOptions` parameter
  - `src/confidence.js` — **NEW**: Confidence scoring module assigning `_confidence` (high/medium/low) and `_falsePositiveNote` per violation, plus contextual node-level checks for `image-alt` (alt=""), `color-contrast` (background-image/gradient/opacity), `aria-hidden-focus` (dynamic toggle patterns), `empty-heading` (SVG/image alt), `link-in-text-block` (visual differentiators)
  - `src/index.js` — Added `--crawl` and `--interactive` CLI flags
  - `src/server.js` — Added `crawl` and `interactive` scan options to POST /api/scan
- **Testing**: All changes verified with unit tests and end-to-end scan of example.com. Confidence scoring verified: `color-contrast` → low, `html-has-lang` → high, contextual checks correctly downgrade nodes with `alt=""`, `background-image`, `aria-hidden+tabindex=-1`.
- **Backward compatible**: All new features are opt-in flags (disabled by default).

### Session 2026-03-09 — Sub-Phase 2.6 Implementation
- **Completed**: All 4 tasks across Sub-Phase 2.6 (Report Quality)
- **Files modified**:
  - `src/data/wcag-map.json` — **NEW**: Complete mapping of 55 WCAG 2.2 Level A+AA success criteria with name, level, principle, guideline, legalRelevance, description
  - `src/reporters/html.js` — Imported `wcag-map.json` and `calculateOverallScore`; added `getWcagDetails()` helper for SC lookup; added WCAG SC detail blocks (number, name, level badge, guideline, legal relevance) to each violation card; enhanced executive summary with risk assessment (HIGH/MODERATE/LOW), 4-card key metrics row (pages, violations, elements, est. fix time), recommended priority actions, and WebAIM Million 2025 percentile comparison; extracted `renderScreenshots()` helper for multi-region screenshot support; rewrote `renderDetailedFindingsByPage()` with per-page scores using `calculateOverallScore()`, per-page score cards, severity breakdowns, page summary table for multi-page scans, per-page TOC navigation; added CSS for metric cards, risk badges, priority list, WCAG SC items, level badges
  - `src/screenshotter.js` — Rewrote for multi-region capture: groups violations by vertical position, scrolls to each region (max 5), injects overlays per region, captures per-region screenshots. Returns `{base64, regions: [{base64, label, violationCount}]}`. Backward compatible via `result.base64` primary image.
  - `src/score.js` — Exported `calculateOverallScore` for use by HTML reporter per-page scoring
  - `src/web/index.html` — Updated `renderScreenshots()` to handle both `screenshot.image` and `screenshot.base64` formats; added multi-region screenshot rendering in dashboard
- **Testing**: All 4 report formats (JSON, CSV, HTML, PDF) generate successfully. WCAG SC details verified with mock data (9/9 assertions pass). End-to-end scan of example.com passes (score 100, 0 violations).

### Session 2026-03-09 — Sub-Phase 2.7 Implementation
- **Completed**: All 3 tasks across Sub-Phase 2.7 (Infrastructure & Performance)
- **Files modified**:
  - `src/server.js` — Added `SCAN_TTL_MS` (30min) and `MAX_CONCURRENT_SCANS` (3) constants; added `setInterval` cleanup that removes completed/errored scans older than TTL; added 429 response when concurrent scan limit exceeded; freed `progress` array on SSE client close; added `concurrency` to POST `/api/scan` body params and scan pipeline
  - `src/scanner.js` — Rewrote `scanAllPages()` sequential loop to batched `Promise.all` with configurable `concurrency` option (default: 1); URLs processed in batches of `concurrency` size
  - `src/index.js` — Added `--concurrency <n>` CLI flag (default: 1); added `--axe-config <path>` CLI flag that reads JSON config with `{disableRules, include, exclude}` and passes to `scanAllPages()`
- **Testing**: End-to-end scan of example.com passes (score 100, 0 violations, 9 passes). `--axe-config` verified: disabling `color-contrast` drops passes from 9 to 8. `--concurrency` flag accepted and parsed correctly.
- **Backward compatible**: All new options use safe defaults (concurrency=1, no axe-config).

### Session 2026-03-09 — Sub-Phase 2.8 Implementation
- **Completed**: Task 2.8.1 (Manual testing checklist in dashboard)
- **Files modified**:
  - `src/web/index.html` — Added CSS for checklist section (progress bar, checkbox styling, priority badges, group titles, checked state). Added HTML section between screenshots and violations with progress indicator. Added JavaScript: `STATIC_CHECKLIST` (8 items across "Core Testing" and "Content & Media" groups), `renderChecklist()` with dynamic items from `allIncomplete` results (contrast, ARIA roles, labels, link text), `toggleChecklistItem()` with sessionStorage persistence, `updateChecklistProgress()` for progress bar.
- **Testing**: End-to-end scan of example.com passes (score 100, all reports generate). Server loads without syntax errors.
- **Features**: 8 static checklist items (Keyboard Nav, Screen Reader, Zoom, Form Validation, Media, Color Independence, Motion, Touch Target). Dynamic items generated from incomplete axe-core results. Checkboxes persist via sessionStorage. Progress bar shows completion count.

### Session 2026-03-09 — Crawler Reliability Fix
- **Problem**: Sites behind Cloudflare or with restricted sitemaps (HTTP 403) resulted in only 1 page being scanned. The `--crawl` flag was required but not discoverable.
- **Root cause**: (1) `fetchUrl()` used default Node.js user-agent, blocked by Cloudflare/WAFs; (2) link crawling was Puppeteer-based, also blocked by Cloudflare JS challenges; (3) crawling was opt-in via `--crawl` flag.
- **Files modified**:
  - `src/crawler.js` — Added `BROWSER_HEADERS` with realistic Chrome user-agent to `fetchUrl()`, fixing sitemap 403 errors. Rewrote `crawlLinks()` from Puppeteer-based BFS to lightweight HTTP-based BFS (no browser needed) — faster, reliable through Cloudflare. Added `extractLinksFromHtml()` for regex-based link extraction from raw HTML. Auto-enables crawling when sitemap returns 0 pages (no `--crawl` flag needed). Added `MAX_CRAWL_DEPTH=2` to limit BFS depth.
  - `src/scanner.js` — Added `setUserAgent()` with realistic Chrome UA to `scanViewport()` for better bot-detection evasion during scanning.
- **Testing**: hereticparfum.com now discovers 20 pages from sitemap (was 0). Auto-crawl fallback works when sitemap unavailable. example.com regression test passes (score 100).

### Session 2026-03-09 — Cloudflare Bot-Detection Bypass
- **Problem**: Sites behind Cloudflare (e.g., hereticparfum.com) showed "Just a moment..." challenge page to Puppeteer. Scanner detected `meta-refresh` on the challenge page instead of real accessibility violations on the actual site. Score was 18 (fake) instead of 28 (real).
- **Files modified**:
  - `src/scanner.js` — Replaced `require('puppeteer')` with `puppeteer-extra` + `puppeteer-extra-plugin-stealth` to evade headless browser detection. Added `waitForChallengeResolution()` that detects Cloudflare challenge indicators (title "Just a moment...", `#challenge-running`, `.cf-browser-verification`, challenge meta-refresh) and polls up to 15s for resolution.
  - `package.json` — Added `puppeteer-extra` and `puppeteer-extra-plugin-stealth` dependencies.
- **Testing**: hereticparfum.com now scans the real site — 6 violations (37 elements), 33 passes, score 28. Before: 1 fake violation (meta-refresh), 10 passes, score 18. example.com regression passes (score 100).

### Session 2026-03-10 — Screenshot & Report Quality Fixes
- **Problems identified from hereticparfum.com scan results**:
  1. Screenshots were gray/empty — images blocked by request interception during scanning
  2. "10% OFF YOUR ORDER" Klaviyo popup appeared in every screenshot — not dismissed
  3. Too many region screenshots per page (up to 5 per viewport × 10 pages = 100 screenshots)
  4. Dashboard displayed ALL region screenshots without collapsing
- **Files modified**:
  - `src/scanner.js` — (1) Removed `'image'` from `BLOCKED_RESOURCE_TYPES` so screenshots show actual page content with images. (2) Added Klaviyo/Shopify-specific dismiss selectors (`.klaviyo-close-form`, `[aria-label="Close dialog"]`, `.popup-close`, etc.). (3) Rewrote `tryDismissOverlays()` with 4-strategy approach: overlay-checked click → relaxed click → accept fallback → force-remove any fixed overlay with z-index>999 via DOM manipulation. (4) Changed `loadPageDefensively()` to use `networkidle2` (with domcontentloaded fallback) for better full-page loading.
  - `src/screenshotter.js` — Reduced `MAX_REGIONS` from 5 to 2 and `MAX_OVERLAYS` from 50 to 30 to limit screenshot bloat.
  - `src/web/index.html` — Rewrote `renderScreenshots()` to only show primary desktop + mobile per page, limit to first 3 pages in "All Pages" view, and show "use page tabs" hint for remaining pages.
- **Testing**: hereticparfum.com CLI scan: 6 violations, 32 passes, 25 elements, score 43. Desktop screenshots 332-390KB (vs ~0KB before — now contain real images). HTML report: 6 images totaling 1.9MB (vs massive bloat before). Region screenshots: max 2 per viewport. Dashboard: 3 pages shown max with hint for more. example.com regression passes (score 100).

### Session 2026-03-10 — Audit Technical Accuracy Improvements (Phases 1–4)
- **Completed**: 4-phase plan to improve audit accuracy and transparency
- **Phase 1 — Confidence-weighted scoring** (`src/score.js`):
  - Added `CONFIDENCE_WEIGHTS` constant: high=1.0, medium=0.6, low=0.15
  - Modified `calculateOverallScore()`: violations now weighted by `nodeCount × confWeight` in base score, and penalty loop multiplies by `confWeight`
  - Added confirmed/review breakdown to `calculateScores()`: `confirmedViolations`, `needsReviewViolations`, `confirmedNodes`, `needsReviewNodes`
  - Exported `CONFIDENCE_WEIGHTS` alongside existing exports
- **Phase 2 — Keyboard trap detection + viewport fix** (`src/scanner.js`):
  - Added `detectKeyboardTraps(page)`: Tab-cycles through focusable elements, detects 3+ consecutive same-selector focus as a trap. Returns axe-core-format violation (`autoada-keyboard-trap`, critical, high confidence). Integrated into `scanViewport()` after interactive scanning.
  - Fixed desktop node viewport tagging: `combineViewportResults()` now tags desktop nodes with `_viewport: 'desktop'` (was only tagging mobile nodes before)
- **Phase 3 — Smart SPA readiness** (`src/scanner.js`):
  - Added `waitForFrameworkReady(page, maxWaitMs=8000)`: detects Next.js/React/Vue/Angular via `page.evaluate()`, uses MutationObserver-based DOM stability (1s of no mutations = ready), hard timeout 8s, fallback to 2s fixed wait
  - Replaced fixed 2s `setTimeout` in `loadPageDefensively()` with `waitForFrameworkReady()`
- **Phase 4 — Score transparency** (`src/reporters/html.js`, `src/web/index.html`):
  - HTML report: Added score disclaimer ("Automated Scan Score — ~30-40% of WCAG 2.2 criteria"), confidence badges (Confirmed/Likely/Needs Verification) on each violation card, confirmed/review metrics row (4 cards), sort violations by confidence then severity
  - Dashboard: Added score disclaimer under gauge, confidence stats row (4 cards), Confidence column in violations table with sort support, default sort changed from severity to confidence
- **Testing**: example.com scan passes (score 100, 0 violations, 9 passes). JSON output contains new confidence fields. HTML report contains disclaimer, badges, metrics. Dashboard JS syntax valid. Confidence weighting verified: low-confidence violations score 56 vs 0 for same high-confidence violations.

### Session 2026-03-10 — Comprehensive Test Plan Execution (47 Tests, 11 Phases)
- **Created**: `TEST-PLAN.md` — 47 automated tests across 11 phases covering scoring, confidence, scanner features, crawler, reports, dashboard, screenshots, edge cases, real-world accuracy, and CLI flags
- **Bug fixes during testing**:
  - `src/scanner.js` `detectKeyboardTraps()`: Fixed false positives — switched from viewport-relative `getBoundingClientRect()` to absolute page positions (`scrollY`/`scrollX`) so scrolled-off elements with same viewport coordinates aren't confused. Added `uniqueKey = selector + '@' + absTop:absLeft`. Added minimum 3 unique elements check before declaring a trap. Added Shift+Tab escape verification (real trap = Shift+Tab returns to same element).
  - `src/scanner.js` `waitForChallengeResolution()`: Tightened Cloudflare detection — removed generic `meta[http-equiv="refresh"]` match (was triggering on non-CF pages). Now requires strong CF indicators: title containing "just a moment"/"attention required", CF-specific DOM elements (`#challenge-running`, `#challenge-form`, `.cf-browser-verification`, `#cf-wrapper`), or `cdn-cgi` in meta-refresh content.
- **Files committed**: `src/scanner.js`, `TEST-PLAN.md`
- **Test Results Summary (47 tests)**:
  - Phase 1 (Real-World Scoring): ✅ All pass — GOV.UK=100, a11yproject=100, Deque Mars=33, the-internet=88, hereticparfum=69
  - Phase 2 (Confidence Scoring): ✅ All 4 pass — confidence fields on all violations, 56-point gap between low/high confidence, FP notes present, confirmed+review=total
  - Phase 3 (Scanner Features): ✅ 7/8 pass — dual viewport, SPA detection (partial: Vue detected, Next.js not), interactive scanning (10 expandables found), no false keyboard traps, request interception working; retry logic inconclusive
  - Phase 4 (Crawler): ✅ All 4 pass — sitemap discovery, auto-crawl fallback, --crawl with robots.txt, extra URLs file
  - Phase 5 (Reports): ✅ All 6 pass — JSON, CSV, HTML, PDF, all-at-once, client branding
  - Phase 6 (Dashboard/API): ✅ 5/7 pass — server, API, export formats, SSE streaming, concurrent limit; UI tests not automated
  - Phase 7 (Scoring Accuracy): ✅ All 4 pass — score ranges, severity breakdown, all 4 principles, benchmark context
  - Phase 8 (Screenshots): ✅ Pass — base64 PNGs embedded in HTML reports (JSON intentionally strips for file size)
  - Phase 9 (Edge Cases): ✅ 5/6 pass — invalid URL, empty page, concurrent scanning, axe-config; **BUG: unreachable domains scan browser error page**
  - Phase 10 (Real-World Accuracy): ✅ All 3 pass — score ordering correct: good sites (100) > bad sites (33-70)
  - Phase 11 (CLI Flags): ✅ All 2 pass — all flags together, exit codes (0=clean, 1=violations)
- **Known bugs discovered**:
  1. Unreachable domains (e.g., `thisdomaindoesnotexist12345.com`) scan the browser's error page instead of reporting a scan failure — produces score 88 instead of an error
  2. Keyboard trap detection says "Execution context was destroyed" on Deque Mars (page navigates during Tab cycling)
  3. Framework detection doesn't detect Next.js on vercel.com (but DOM stability wait still works correctly)
  4. Keyboard trap detected on hereticparfum.com/products/discovery-set — needs investigation (may be real or false positive)

### Session 2026-03-10 — Bug Fixes: Unreachable Domains + Keyboard Trap Crashes
- **Bug 1 Fix — Unreachable domains**: Previously, scanning `thisdomaindoesnotexist12345.com` produced score 88 by scanning the browser's error page. Now `loadPageDefensively()` detects unreachable pages via: (1) catching DNS/connection errors from `page.goto()` and throwing immediately, (2) checking if browser navigated to `chrome-error://` or `about:blank`, (3) detecting browser error page content patterns ("This site can't be reached", "ERR_NAME_NOT_RESOLVED", etc.). `withRetry()` skips retries for "Page unreachable" errors. `scanPage()` sets `error` field when both viewports fail. CLI displays "⚠ Unreachable" warning with error details.
- **Bug 2 Fix — Keyboard trap context destruction**: On pages where Tab keypress causes navigation (e.g., Deque Mars), `page.evaluate()` threw "Execution context was destroyed". Fixed by wrapping each Tab+evaluate cycle in individual try/catch. When context-destruction errors are detected (message contains "Execution context", "detached", "Target closed", "Session closed"), detection aborts gracefully with empty result instead of crashing. Shift+Tab verification section also wrapped in try/catch.
- **Files modified**:
  - `src/scanner.js` — `loadPageDefensively()` with error page detection, `withRetry()` skips non-transient errors, `scanPage()` error field propagation, `detectKeyboardTraps()` resilient Tab cycling + Shift+Tab verification
  - `src/index.js` — Added unreachable page warning display in `printSummary()`
- **Testing**:
  - `thisdomaindoesnotexist12345.com` → "Page unreachable: ERR_NAME_NOT_RESOLVED", error field in JSON, 0 violations, 0 passes (was: 88 score with fake violations)
  - `example.com` regression → score 100, 9 passes ✅
  - `gov.uk` → score 100, 31 passes, no false keyboard traps ✅

### Session 2026-03-12 — Phase 3 Complete + Restyle Planning
- **Phase 3 Implementation COMPLETE**: All 13 chunks implemented in `src/web/index.html` (2045 lines). New light "Ink & Paper" theme with 5 dashboard tabs (Overview/Impact/Roadmap/Violations/Exports), SSE progress with step indicators + violation feed + toasts, fix code generator (before/after from remediation.json), impact calculator with client-side score recalculation, roadmap kanban (Quick/Medium/Deep), badge SVG generator, dev handoff + quick fixes exports, confidence-weighted sorting.
- **Files modified**:
  - `src/web/index.html` — Complete rewrite (2045 lines, light theme + all Phase 3 features)
  - `src/reporters/html.js` — IT Geeks logo as default (`DEFAULT_LOGO_BASE64`)
  - `src/reporters/pdf.js` — Fixed `Buffer.from(pdfBuffer)` for Puppeteer Uint8Array
- **Verification**: 64/67 checks pass. Real scan of the-internet.herokuapp.com: Score 85, 1 violation (color-contrast, 89 nodes), 19 passes. All exports work (JSON/CSV/HTML/PDF/sitemap).
- **User feedback**: Rejected light theme. Requested: "bring back the old dashboard style from the last commit and make it compatible with all the new features"

### Session 2026-03-12 — Phase 3 Restyle: Old Dark Theme + New Features (IN PROGRESS)
**Plan**: Restore old dark purple dashboard theme from HEAD while keeping ALL Phase 3 features.
**Sub-Phases:**
- [ ] **Sub-Phase A**: CSS — Replace light theme with old dark theme (`--bg:#0f1117`, `--accent:#6c5ce7`, system fonts). Add new CSS for Phase 3 components styled in dark theme.
- [ ] **Sub-Phase B**: HTML Body — Restore old header, scan hero, features grid, about view, journey view. Add new: 5-tab dashboard, toast container, step indicators, violation feed, impact/roadmap/exports tabs.
- [ ] **Sub-Phase C**: JavaScript — Keep ALL 40+ Phase 3 functions. Update chart colors to dark theme. Update `showView()` for 5 views including journey.
- [ ] **Sub-Phase D**: Full verification — 67-check verification, all views, all exports, dark theme.
**Key context:**
- Old HEAD: 2425 lines (dark theme, 33 JS functions, no tabs, has journey view)
- Current working tree: 2045 lines (light theme, 40+ JS functions, 5 tabs, no journey view)
- Target: ~2600 lines (dark theme + all features + journey view)
- Single file: `src/web/index.html` — no backend changes
- Plan file: `/Users/tushartomar/.claude/plans/shiny-seeking-stardust.md`

### Session 2026-03-16 — AutoSEO Feature (Lighthouse + SEO Analysis Tab)
- **Completed**: Full AutoSEO feature — new dashboard tab with Lighthouse performance audits and comprehensive SEO analysis
- **Files created**:
  - `src/seo.js` — **NEW**: SEO engine module with 4 exported functions: `runFullSeoScan()` orchestrator, `runLighthouseAudit(url, opts)` (desktop/mobile Lighthouse via puppeteer), `runSeoAnalysis(url, opts)` (HTML-level SEO checks: meta tags, headings, images, links, structured data, Open Graph, Twitter Card, indexability, robots.txt), `generateSpeedSuggestions()` (code-level fix suggestions based on CWV thresholds and Lighthouse opportunities)
- **Files modified**:
  - `src/server.js` — Added SEO scan API layer: `POST /api/seo-scan` (starts scan, returns scanId), `GET /api/seo-scan/:id/progress` (SSE stream), `GET /api/seo-scan/:id/results` (JSON results), `GET /api/seo-scan/:id/export/:format` (json/html/pdf exports). Added `seoScans` Map with TTL cleanup, `runSeoScanJob()`, `broadcastSeoSSE()`, `closeSeoSSEClients()`, `generateSeoHtmlReport()` helpers.
  - `src/web/index.html` — Added AutoSEO tab (6th dashboard tab with "NEW" badge). CSS for `.seo-*` classes (score cards, tables, metric rows, suggestions, pass/warn/fail states). HTML: run bar with progress, 6-card score grid, 3 sub-tabs (SEO Overview, Speed Metrics, Suggestions), export buttons. JS functions: `startSeoScan()`, `loadSeoResults()`, `renderSeoTab()`, `renderSeoScores()`, `renderSeoOverview()`, `renderSpeedMetrics()`, `renderSpeedSuggestions()`, `switchSeoSubTab()`, `switchSpeedView()`, `exportSeoReport()`. Fixed `startSeoScan()` to fall back to URL input when ADA scan hasn't completed yet.
  - `package.json` — Added `lighthouse: ^13.0.3` dependency
- **Key fix**: Lighthouse v13 exports as ES module — `require('lighthouse')` returns `{default: fn}`. Fixed with `const lighthouse = lighthouseModule.default || lighthouseModule`.
- **Testing**: Verified on `theyamazakihome.com` — SEO Score 95, Desktop Performance 49, Mobile Performance 26, LH SEO 92, Best Practices 73. 3 speed suggestions with code snippets (LCP, TBT, DOM size). All 3 export formats work (JSON 19KB, HTML 7.6KB, PDF 374KB/3 pages). Dashboard renders all sections: score cards, meta tags, headings, images, links, structured data, OG tags, indexability, Core Web Vitals, diagnostics, suggestions with code examples.

### Session 2026-03-17 — Full Audit + Phase 1 Complete: Test Infrastructure + 17-Phase Plan
- **Code Audit**: Thorough audit of all 15 files (~7,000 lines) found 56 issues across categories: Bugs & Logic Errors (47), Edge Cases (38), Performance/Memory (27), Code Quality (36), Security/XSS (14), Reliability (16). ~35 Critical/High, ~75 Medium, ~68 Low severity.
- **17-Phase Execution Plan Created**: 84 tasks across 17 phases — Phases 1-9 (Code Health), 10-13 (UX Restructure), 14-15 (New Capabilities), 16 (Polish), 17 (Final Verification). Plan file: `/Users/tushartomar/.claude/plans/declarative-wiggling-dolphin.md`
- **Phase 1 COMPLETE**: Test infrastructure setup with Jest v30
- **Files created**:
  - `__tests__/unit/score.test.js` — 26 tests: calculateOverallScore (null handling, confidence weighting, score bounds), calculateScores (full structure, severity breakdown, unknown impact, confirmed vs needsReview), CONFIDENCE_WEIGHTS exports
  - `__tests__/unit/confidence.test.js` — Tests: high/low/medium confidence assignment, _isBestPractice flag, empty array handling, contextual background-image check (uses `_contextNote` not `_falsePositiveNote` for node-level)
  - `__tests__/unit/seo.test.js` — Tests calculateSeoScore (complete/missing/empty data), generateSpeedSuggestions (null/empty/slow/good). Mocks puppeteer-extra, stealth plugin, lighthouse to avoid ESM conflicts
  - `__tests__/smoke/server.test.js` — 9 smoke tests: landing page, scan input, tabs, invalid URL rejection, valid URL acceptance, remediation data, wcag-map data, nonexistent scan 404, SEO invalid URL. Spawns server as child process (avoids Lighthouse ESM/CJS conflict)
- **Files modified**:
  - `package.json` — Added jest@^30.3.0 devDependency, test scripts (test, test:unit, test:smoke, test:all)
  - `src/seo.js` — Added `calculateSeoScore` to module.exports
- **Test results**: 35/35 passing (26 unit + 9 smoke across 4 suites)
- **Key technical decisions**:
  - Smoke tests use child process spawn (not require) to avoid Lighthouse ESM/CJS conflict
  - Random port (30000+random) for smoke server to avoid conflicts
  - seo.test.js mocks puppeteer-extra, stealth plugin, lighthouse at module level
  - `calculateSeoScore({})` crashes on empty input — intentionally documented, Phase 3 will fix
- **Next up**: Phase 2 — Critical Bug Fixes (Scanner & Server) — 6 tasks starting with Puppeteer launch error handling

### Session 2026-03-17 — Phase 2 Complete: Critical Bug Fixes (Scanner & Server)
- **Phase 2 COMPLETE**: All 6 tasks implemented and tested
- **Files modified**:
  - `src/scanner.js` — (1) Wrapped `puppeteer.launch()` in try-catch with descriptive errors for ENOENT/EACCES/sandbox failures, emits `browser-error` progress event. (2) Added empty/blank page detection (Step 6 in `loadPageDefensively()`): checks `body.innerText.trim().length < 50` AND `structural elements < 3`, sets `page._emptyContent = true`. Propagated `_emptyContent` flag through `scanViewport()` → `scanPage()` → page result.
  - `src/server.js` — (1) Accept `clientLogoBase64` from POST `/api/scan` body, validate starts with `data:image/` and < 500KB, store in `scan.options.clientLogoBase64`, use in export handler instead of hardcoded `null`. (2) Added `MAX_PROGRESS_EVENTS = 500` cap to `broadcastSSE()` and `broadcastSeoSSE()` — shifts oldest event when cap exceeded. (3) Added `SCAN_STALE_TIMEOUT_MS = 3600000` (60 min) — cleanup interval force-marks stale running scans as error, sets `completedAt`, closes SSE clients. Applied to both `scans` and `seoScans` Maps.
  - `src/seo.js` — Refactored `runSeoAnalysis()` to accept optional `browser` param (`opts.browser`). `runFullSeoScan()` now launches one shared browser for SEO analysis (closed after), Lighthouse still gets its own browsers (requires exclusive debugging port control). Reduces total browser launches from 3 to 2 for SEO scans.
- **Testing**: All 35 unit/smoke tests pass. CLI scan of example.com: score 95, 2 violations, 14 passes. Server starts without errors. `_emptyContent` flag correctly NOT set on normal pages.
- **Next up**: Phase 3 — SEO & Score Null Safety — 5 tasks

### Session 2026-03-17 — Phase 3 Complete: SEO & Score Null Safety
- **Phase 3 COMPLETE**: All 5 tasks verified — all were already implemented in prior sessions
- **Verified fixes in `src/seo.js`**:
  - `generateSpeedSuggestions()`: `metricVal()` helper with optional chaining for all metric accesses (LCP, CLS, TBT, FCP, TTFB), `seoData?.domStats?.totalElements` for DOM size check, early return on `lighthouseData.error`
  - `runSeoAnalysis()`: `page.goto()` wrapped in try-catch with classified errors (unreachable/timeout/navigation), descriptive error messages thrown
  - `calculateSeoScore()`: Early return for `null`/non-object data, defensive destructuring for all sub-objects (`meta`, `headings`, `images`, `openGraph`, `twitterCard`, `structuredData`, `indexability`, `robotsTxt`), lazy-loaded image note on alt text check
  - `extractOpportunities()`: Added `totalItems` and `truncated` fields alongside the sliced `items` array
- **Verified fix in `src/score.js`**:
  - `getSeverityBreakdown()`: Added `unknown: 0` counter, unknown impact values increment `unknown` instead of being silently dropped
- **Testing**: All 35 unit/smoke tests pass. Targeted verification: `calculateSeoScore({})` returns score 32 with 9 issues (no crash), `calculateSeoScore(null)` returns `{score:0, issues:[...]}`, `generateSpeedSuggestions({metrics:{}})` returns empty array, unknown `impact:'banana'` correctly lands in `unknown` counter
- **Next up**: Phase 4 — Error Handling & Logging — 5 tasks

### Session 2026-03-17 — Phase 4 Complete: Error Handling & Logging
- **Phase 4 COMPLETE**: All 5 tasks implemented and tested
- **Files modified**:
  - `src/scanner.js` — Added `debugLog(context, msg)` function (outputs when `AUTOADA_DEBUG=1`). Replaced ~15 silent catch blocks with `debugLog()` calls (load, challenge, framework, overlay, interactive, scan contexts). Added `validateAxeConfig(config)` function — validates `disableRules` (array of strings), `include`/`exclude` (arrays), warns on unknown keys. Exported `validateAxeConfig`.
  - `src/index.js` — Imported `validateAxeConfig` from scanner. Calls it after parsing axe-config JSON, prints yellow warnings for any issues.
  - `src/server.js` — Moved `const fs = require('fs')` to top-level imports (was inline at line 201). Replaced 5 bare `catch { /* ... */ }` blocks with `catch (e) { console.warn(...) }` for reports dir creation and 4 file write operations (JSON, CSV, HTML, PDF).
  - `src/reporters/pdf.js` — Added `PDF_OVERALL_TIMEOUT_MS = 90000` (90s). Added `timeout: 30000` to browser launch. Wrapped PDF generation in `Promise.race` with 90s timeout. Added `timeout: 60000` to `page.pdf()` call.
  - `src/web/index.html` — Updated `showToast(title, body, type, duration)` to accept optional `type` parameter ('error', 'success'). Added CSS for `.toast-error` (red left border + red title) and `.toast-success` (green). Replaced all 10 `alert()` calls with `showToast()` — zero `alert()` remaining in codebase.
- **Testing**: All 35 unit/smoke tests pass. validateAxeConfig: valid config → no warnings, invalid disableRules → warning, unknown key → warning, non-string array element → warning. fs require at line 6 (top). PDF timeout constants present. Zero alert() calls in codebase.
- **Next up**: Phase 5 — Code Deduplication — 5 tasks

### Session 2026-03-17 — Phase 5 Complete: Code Deduplication
- **Phase 5 COMPLETE**: All 5 tasks implemented and tested
- **Files created**:
  - `src/reporters/utils.js` — **NEW**: Shared reporter utilities module with `escapeHtml`, `extractWcagCriteria`, `getWcagDetails`, `formatTarget`, `buildFailureSummary`. Loads `wcag-map.json` once. Eliminates duplicate definitions across html.js and csv.js.
- **Files modified**:
  - `src/reporters/csv.js` — Removed local `extractWcagCriteria`, `formatTarget`, `buildFailureSummary` definitions (~40 lines). Now imports from `./utils`.
  - `src/reporters/html.js` — Removed local `escapeHtml`, `extractWcagCriteria`, `getWcagDetails`, `formatTarget`, `buildFailureSummary`, `getPrinciple` definitions (~100 lines). Removed local `wcagMap` require (now in utils.js). Imports shared utils from `./utils` and `getPrinciple` from `../score`.
  - `src/score.js` — Exported `getPrinciple` alongside existing exports for use by html.js.
  - `src/confidence.js` — Consolidated `MEDIUM_CONFIDENCE_RULES` and `BEST_PRACTICE_RULES`: `BEST_PRACTICE_RULES` is now the canonical list, `MEDIUM_CONFIDENCE_RULES` is derived from it plus 5 WCAG-only medium rules (`list`, `listitem`, `label`, `frame-title`, `target-size`). Extracted `hasBackgroundImageContext(html)` helper with shared `BG_IMAGE_REGEX` — used by both `color-contrast` and `color-contrast-enhanced` checks.
  - `src/crawler.js` — Hoisted `parseRobotsTxt()` call to run once before the crawl/no-crawl branch. Previously called twice (once in crawl path, once in else path for status event). Now fetched once and result reused.
- **Testing**: All 35 unit/smoke tests pass. All modules load correctly. `getPrinciple`, `escapeHtml`, `formatTarget`, `extractWcagCriteria`, `getWcagDetails`, `buildFailureSummary` all verified working via require().
- **Next up**: Phase 6 — Security Hardening — 4 tasks

### Session 2026-03-17 — Phase 6 Complete: Security Hardening
- **Phase 6 COMPLETE**: All 4 tasks implemented and tested
- **Files modified**:
  - `src/web/index.html` — (1) Replaced inline `onclick="toggleChecklistItem('id')"` with event delegation: checklist items now use `data-checklist-id` attribute, single `grid.onclick` listener uses `e.target.closest('[data-checklist-id]')`. Zero inline onclick for checklist. (2) Replaced fragile `onclick="copyToClipboard('escaped-string')"` with `data-fix-key` attribute + `_fixCodeMap` JS Map. `renderFixExpand()` stores fix code text in Map keyed by `fix-{ruleId}-{idx}`, copy buttons reference key via `data-fix-key`. Event delegation on violations container handles clicks. Zero inline onclick for copy buttons.
  - `src/server.js` — Added `; charset=utf-8` to all text-based Content-Type headers: `text/event-stream` (×2), `application/json` (×2), `text/csv`, `text/html` (×2), `application/xml`. Binary `application/pdf` (×2) correctly left without charset.
  - `src/crawler.js` — Added `isSameDomain(url, baseDomain)` helper. `parseSitemap()` now validates every URL extracted from sitemap against the sitemap's own domain. Cross-domain URLs are skipped with a count logged (`[sitemap] Skipped N cross-domain URL(s)`). Prevents scanning unrelated domains that appear in shared/CDN sitemaps.
- **Testing**: All 35 unit/smoke tests pass. Verified: 0 inline `onclick="toggleChecklistItem"`, 0 inline `onclick="copyToClipboard"`, 3 `data-checklist-id` occurrences, 3 `data-fix-key` occurrences, all text Content-Type headers have charset.
- **Next up**: Phase 7 — Performance & Optimization — 5 tasks

### Session 2026-03-17 — Phases 7 & 8 Complete: Performance & Dashboard Reliability
- **Phase 7 COMPLETE**: All 5 tasks — Performance & Optimization
- **Phase 8 COMPLETE**: All 5 tasks — Dashboard Reliability
- **Files modified**:
  - `src/scanner.js` — Extracted 9 magic numbers to module-level JSDoc constants: `MAX_INTERACTIVE_ELEMENTS=10`, `MAX_TAB_PRESSES=50`, `KEYBOARD_TRAP_THRESHOLD=3`, `OVERLAY_DISMISS_WAIT_MS=500`, `CHALLENGE_TIMEOUT_MS=15000`, `FRAMEWORK_READY_TIMEOUT_MS=8000`, `DOM_STABILITY_WINDOW_MS=1000`, `NETWORK_IDLE_TIMEOUT_MS=5000`, `FALLBACK_LOAD_TIMEOUT_MS=15000`. All inline `500`, `15000`, `8000`, `50`, `10`, `3` values replaced with named constants.
  - `src/screenshotter.js` — Increased `MAX_REGIONS` from 2→3 for better violation coverage. Added JSDoc to constants. Improved `cleanupOverlays()` catch block.
  - `src/crawler.js` — (1) Added `MAX_REDIRECTS=5` constant and redirect counter to `fetchUrl()` — throws on redirect loops. (2) Added `MAX_RESPONSE_BYTES=5MB` limit — destroys response stream on exceed. (3) Added `TRACKING_PARAMS` array and `normalizeUrl()` function that strips `utm_*`, `fbclid`, `gclid`, `msclkid`, `ref`, `_ga`, `_gl` etc. Used in both `crawlLinks()` dedup and `discoverPages()` dedup. Removed local `normalize()` function from `crawlLinks()`.
  - `src/web/index.html` — (1) Added `scanEventSource` and `seoEventSource` module-level vars. `showView()` closes both when leaving progress/dashboard. `beforeunload` listener closes both. `listenProgress()` and `startSeoScan()` close previous connection before opening new one. All SSE `close()` calls also null the ref. (2) Added `clearInterval(elapsedInterval)` at start of `startScan()` to prevent timer accumulation. All completion/error handlers also null the timer ref. (3) Added `fetchWithTimeout(url, opts, timeoutMs)` helper with `AbortController` — shows toast on timeout. Replaced all 10 bare `fetch()` calls: start scan (10s), results (30s), data files (10s), exports (60s), sitemap (10s), SEO start (10s), SEO results (30s), SEO export (60s). (4) `renderChecklist()` early-returns with loading message when `scanResults` is null. (5) Replaced all 4 `innerHTML +=` patterns in `renderScreenshots()` and `renderViolationsTab()` — build string first, assign once.
- **Testing**: All 35 unit/smoke tests pass. All 9 modules load without errors. JS syntax check passes (73,296 chars).
- **Next up**: Phase 9 — Code Health Verification (testing only, no code changes)

### Session 2026-03-17 — Phase 9 Complete: Code Health Verification
- **Phase 9 COMPLETE**: Verification-only phase, no code changes
- **CLI scan gov.uk**: Score 78/100 (50 pages crawled), all 4 reports generated (JSON 124MB, CSV 59KB, HTML 24MB, PDF 12MB). Confidence levels present, WCAG SC details in HTML, no crashes.
- **CLI scan the-internet.herokuapp.com**: Score 84/100, 3 pages, color-contrast with `_confidence: 'low'`, severity non-zero
- **Code health markers**: 35/35 tests pass, 9/9 modules load, 0 alert(), 0 innerHTML+=, shared reporter utils working
- **Result**: GO for Phase 10

### Session 2026-03-17 — Phases 10, 11, 12 Complete: UX Restructure
- **Phase 10 COMPLETE**: Landing Page — Dual Value Proposition
- **Phase 11 COMPLETE**: Results Page — Top-Level Audit Toggle
- **Phase 12 COMPLETE**: Combined Summary Dashboard
- **Files modified**:
  - `src/web/index.html` — Extensive restructuring (~3900 lines):
    - **Phase 10**: Updated hero badge ("WCAG 2.2 + SEO Analysis"), dual title ("Accessibility & SEO Auditing Tool"), subtitle mentioning both ADA and SEO. Added scan type toggle (ADA Audit + SEO Audit checkboxes with `:has(input:checked)` styling). Updated 6 feature cards with tags (ADA purple, SEO green, BOTH blue). Updated How It Works (Lighthouse), What Gets Checked (SEO pillars: Meta & Content, Performance, Structured Data, Indexability). All 3 footers: "Powered by axe-core + Lighthouse".
    - **Phase 11**: Added audit switcher CSS (`.audit-switcher` segmented control, gradient for combined, green for SEO). Restructured dashboard: `#auditCombined` (Combined view), `#auditAda` (ADA view with 5 sub-tabs), `#auditSeo` (SEO view with 6 sub-tabs). JS: `switchAuditView(view, pushHistory)` with URL state management (replaceState default, pushState for user clicks), `updateAdaptiveSummary()`, `switchDashTab()` scoped to `#auditAda`, `switchSeoTab()` mapping to existing sub-panels. Event delegation for switcher, tabs, drill-through, popstate.
    - **Phase 12**: `OVERLAPPING_RULES` array (image-alt, heading-order, html-has-lang, document-title). `renderCombinedView()` with health score cards (ADA + SEO side-by-side), quick stats (pages/issues/overlapping/fix time), top 5 cross-audit issues sorted by severity, overlapping issues display. `getScoreLabel()` helper. `autoTriggerSeoIfChecked()` auto-starts SEO scan after ADA completes. Wired into `loadResults()` and SSE completion.
- **Bugs found and fixed during testing**:
  1. Combined view not defaulting: `renderDashboard()` now always calls `switchAuditView('combined')` when no URL state (was relying on HTML class only)
  2. SEO score path wrong: Fixed to `seoResults.seo.seoScore.score` (was looking for `seoResults.seo.score`)
  3. SEO issues path wrong: Fixed to `seoResults.seo.seoScore.issues` in all renderCombinedView references
  4. SEO issue label field: Added `i.msg` lookup (SEO issues use `msg` not `message`)
  5. History pollution: `switchAuditView` uses `replaceState` by default, `pushState` only from user clicks
- **Testing**: All 35 unit/smoke tests pass. Dashboard verified: landing page (hero, toggle, cards, footer), progress view (step indicators), Combined view (health cards, quick stats, top issues, overlapping), ADA view (all 5 sub-tabs), SEO view (all 6 sub-tabs, score cards, CWV metrics). Zero console errors. JS syntax valid (83,346 chars).
- **Next up**: Phase 13 — SEO Roadmap & Impact Simulator

### Session 2026-03-17 — Phases 13, 14, 15 Complete: Features (Roadmap, Annotations, Contrast)
- **Phase 13 COMPLETE**: SEO Roadmap & Impact Simulator
- **Phase 14 COMPLETE**: Screenshot Annotations with Issue Descriptions
- **Phase 15 COMPLETE**: Color Contrast Pixel Verification
- **Files created**:
  - `src/contrast-verify.js` — **NEW**: Color contrast pixel verification module. Exports: `relativeLuminance(r,g,b)` (WCAG 2.1 luminance), `contrastRatio(fg,bg)` (1-21 ratio), `passesWcagAA(ratio,isLargeText)` (AA thresholds: 4.5:1 normal, 3.0:1 large), `verifyContrastItems(page,incompleteItems)` (samples fg/bg colors from live Puppeteer page, walks DOM for background, detects background-image uncertainty, classifies as verified_fail/verified_pass/still_uncertain), `rgbToHex(color)`. Max 30 elements per page for performance.
- **Files modified**:
  - `src/web/index.html` — Phase 13: Added "Roadmap" and "Impact" tabs to SEO tab strip. Added `#seoSubRoadmap` panel (3-column kanban: Quick Wins/Medium Effort/Deep Fixes with severity badges and time estimates), `#seoSubImpact` panel (toggle switches grouped by severity, 3 gauge cards for Projected Score/Fix Time/Search Visibility, scatter plot of effort vs impact). Added `SEO_ISSUE_EFFORTS` lookup (27 SEO issue types with effort/minutes), `getSeoIssues()`, `renderSeoRoadmapTab()`, `renderSeoImpactTab()`, `recalculateSeoImpact()`, `renderSeoImpactScatter()`. Rewrote `switchSeoTab()` to handle all 8 sub-tabs with lazy rendering. Phase 14: Added annotation legend CSS (`.annotation-legend`, `.annotation-marker`, `.conf-badge`). Added `buildAnnotationLegend(annotations)` function rendering numbered markers with rule, description, severity badge, confidence badge in table format. Grouped by confidence (Confirmed → Likely → Needs Review). Wired into `renderScreenshots()`. Phase 15: Added contrast verification CSS (`.contrast-section`, `.contrast-card`, `.contrast-swatch`, `.contrast-ratio`, `.contrast-collapsible`). Added `<div id="contrastVerifySection">` in Overview tab. Added `renderContrastVerification()` function showing confirmed fails (expanded), verified passes (collapsible), and uncertain/needs-review (collapsible) with color swatches, hex values, and ratio display.
  - `src/screenshotter.js` — Phase 14: Enhanced element collection with `confidence` (from node/violation `_confidence`), `wcagCriteria` (extracted from axe-core tags via new `extractWcagFromTags()`), and `description` (failureSummary). Extended annotation data model with `selector`, `boundingBox`, `confidence`, `wcagCriteria`. Added invisible element filtering (zero dimensions, offscreen). Added `mergeOverlappingAnnotations()` and `calculateOverlap()` for >80% overlap merging (keeps higher severity).
  - `src/scanner.js` — Phase 15: Added `require('./contrast-verify')` import. Integrated `verifyContrastItems()` in `scanViewport()` after axe-core scan (while page still open). Propagated `_contrastVerified` through `combineViewportResults()`. Aggregated `allContrastVerified` in `scanAllPages()` return object.
- **Testing**: All 35 unit/smoke tests pass. All 9 modules load. JS syntax valid (103,573 chars). Contrast verification functional tests pass: black/white=21:1, same-color=1:1, WCAG AA thresholds correct, hex conversion correct. Zero `alert()`, zero `innerHTML +=`.
### Session 2026-03-18 — Phases 16, 17 Complete: Export Parity, Branding & Final Verification
- **Phase 16 COMPLETE**: Export Parity & Branding Cleanup
- **Phase 17 COMPLETE**: Final End-to-End Verification
- **Files modified**:
  - `src/server.js` — Added `GET /api/scan/:id/combined-export/:format` endpoint (HTML/PDF/JSON). Added `generateCombinedHtmlReport()` function that merges ADA violations, SEO issues, overlapping findings, performance metrics, and speed suggestions into a single self-contained HTML report. Finds matching SEO scan by URL. Supports branding (client name, logo).
  - `src/web/index.html` — (1) Added "Combined ADA + SEO Report" export card with HTML/PDF/JSON buttons in Exports tab. (2) Added `exportCombinedReport()` JS function. (3) Rewrote `downloadDevHandoff()` to include 3 sections: Overlapping ADA+SEO issues first (with dual source tags), ADA-only violations, SEO-only issues. Uses `OVERLAPPING_RULES` to identify cross-audit issues. (4) Updated `generateBadgeSvg()` to include SEO score alongside WCAG score when SEO results are available (wider 340px badge). (5) Updated page title to "AutoADA — Accessibility & SEO Scanner". (6) Updated About page description to mention SEO. (7) Changed export formats stat from 4 to 5.
- **Testing (Phase 16.4)**:
  - 14/14 dashboard checks: Combined buttons, handoff overlapping section, no NEW badge, badge SVG SEO, title, about, 5 formats, zero alert, zero innerHTML+=
  - 5/5 server checks: combined-export endpoint, generateCombinedHtmlReport, overlapping section, charset headers
  - 35/35 unit/smoke tests pass
  - JS syntax valid (108,714 chars)
  - All 11 modules load
- **Testing (Phase 17)**:
  - CLI example.com: Score 95, 2 violations, 14 passes, all 4 reports (JSON 236K, CSV 943B, HTML 104K, PDF 1MB)
  - CLI the-internet.herokuapp.com: Score 82, 5 violations (120 elements), 26 passes, color-contrast 90 elements (needs-review), confidence split working (4 confirmed/1 needs-review), all 4 reports, PDF 2.5MB
  - Dashboard API: 9/9 tests pass — landing page, data files, URL validation, scan start/results, 4 ADA exports, 3 combined exports, sitemap, 404 handling
  - Feature matrix: 43/43 checks across all 17 phases
  - Performance: 11/11 modules load, no regressions

### Session 2026-03-19 — Live Sitemap Generation with Terminal UI
- **Feature**: Complete rewrite of sitemap generation UX — terminal-like live UI with real-time page discovery
- **Problem**: Old sitemap generation was a synchronous POST returning XML after crawling. No live feedback. SPA sites (mergerecords.com) only found 1 page via HTTP crawl because Angular/React render links via JavaScript.
- **Files modified**:
  - `src/crawler.js` — Added optional `onPageFound` callback parameter to both `crawlLinks()` and `crawlLinksWithBrowser()`. Callback emits `{ url, depth, total, source: 'http'|'browser' }` after each discovered page. Backward compatible — existing callers unaffected.
  - `src/server.js` — Rewrote `POST /api/scan/:id/generate-sitemap` to async fire-and-forget (returns 202). Added `runSitemapGeneration()` async function with SSE progress streaming via `broadcastSitemapSSE()`. Added `GET /api/scan/:id/sitemap-progress` SSE endpoint (replay buffered events + live stream). Added `GET /api/scan/:id/sitemap-download` endpoint. Guards against duplicate generation (409 if already crawling).
  - `src/web/index.html` — Added `.sitemap-terminal` CSS (dark terminal theme, monospace font, scrollable body, pulse animation, phase/URL/error line styles). Replaced `#sitemapNotification` HTML with prompt card + terminal UI structure. Added `sitemapEventSource` state variable with cleanup in `showView()` and `beforeunload`. Rewrote `generateFullSitemap()` to POST then connect SSE. Added `listenSitemapProgress()` (EventSource client), `appendTermLine()` (DOM-safe line appender), `downloadSitemapGenerated()`. Event delegation on `#sitemapNotification` for `data-action` buttons (no inline onclick).
- **Testing**:
  - Non-SPA (the-internet.herokuapp.com): HTTP crawl found **144 pages**, complete event received, XML download works
  - SPA (mergerecords.com): HTTP found 1 page → auto-switched to browser crawl → discovered **40+ pages** (store categories, artists)
  - 26/26 unit tests pass
  - Zero `alert()`, zero `innerHTML +=`, JS syntax valid (116,558 chars)
  - All text Content-Type headers include `charset=utf-8`

### Session 2026-03-19 — Visual Verification of Sitemap Terminal UI
- **Preview server verification**: Started dev server, ran ADA scan of the-internet.herokuapp.com via dashboard
- **Scan results confirmed**: Score 85/100, 3 pages, 1 issue (color-contrast, 89 elements), Combined view working
- **Sitemap terminal UI verified**: Force-showed notification (site has sitemap, so notification hidden by design), clicked "Generate Sitemap" → terminal appeared with green dot + "144 pages" counter badge → URLs streamed live with `[d1]`/`[d2]`/`[d3]` depth tags → completion messages in green → footer with "Download Sitemap XML" button appeared
- **Zero console errors** during entire flow
- **All features working**: Dark theme terminal, monospace font, auto-scroll, event delegation (no inline onclick), SSE streaming, counter badge live updates

### Session 2026-03-19 — Fix SSE Connection Drops & Port Conflicts
- **Problem**: Scanning sites with 20+ pages (e.g., simplygum.com) caused "Connection lost. Could not recover results." after ~7 minutes. Scan actually completed on server, but client gave up. Also, EADDRINUSE crash when old server process still running.
- **Root causes**: (1) No SSE heartbeat — proxy/browser timeout idle connections after 60-90s of silence. (2) Client `onerror` handler closed connection immediately, tried `/results` once (got 202 = still running), then gave up permanently. (3) No graceful server error handling.
- **Files modified**:
  - `src/server.js` — (1) Added 25-second heartbeat (`:\n\n` SSE comment) to all 3 SSE endpoints (ADA progress, SEO progress, sitemap progress) via `setInterval` per client, cleared on disconnect. (2) Added `X-Accel-Buffering: no` header to all 3 SSE endpoints to prevent proxy buffering. (3) Added `server.on('error')` handler for EADDRINUSE with helpful instructions. (4) Added graceful shutdown via `SIGINT`/`SIGTERM` handlers that close all SSE clients and server.
  - `src/web/index.html` — (1) Rewrote ADA SSE `onerror`: tracks `reconnectAttempts`, allows 3 auto-reconnects (EventSource native retry), then falls back to `pollForResults()`. Added `onopen` handler to reset counter on restore. Added `scanDone` flag to prevent reconnect after intentional close. (2) Added `pollForResults(scanId, attempt, maxAttempts, intervalMs)`: polls `GET /api/scan/:id/results` every 5s, handles 200 (complete) and 202 (still running), retries up to 60 times (5 min), shows progress in activity log. (3) Rewrote SEO SSE `onerror` with same reconnect+polling pattern. (4) Added `pollForSeoResults()` with same polling logic (36 attempts = 3 min).
- **Testing**: 35/35 unit/smoke tests pass. Port conflict test: second server shows friendly "Port 3000 already in use" with instructions instead of crash. Graceful shutdown: SIGINT closes SSE clients + server cleanly. JS syntax valid (121,230 chars). Zero `alert()`, zero `innerHTML +=`.

### Session 2026-03-19 — Sitemap Generation Bug Fixes
- **Bug 1 — TTL cleanup deletes scan during sitemap generation**: The 30-minute scan TTL cleanup was deleting completed ADA scans even when sitemap generation was still actively crawling. Fixed by adding a guard in the cleanup interval: `if (scan.sitemapGeneration && scan.sitemapGeneration.status === 'crawling') continue`.
- **Bug 2 — Browser crawl too slow for large SPAs**: With maxPages=500 and depth=3, mergerecords.com was crawling 366+ pages and taking 10+ minutes. Reduced to `MAX_SITEMAP_PAGES=200` and `MAX_BROWSER_DEPTH=2` for sitemap generation — still comprehensive but finishes in ~3 minutes.
- **Files modified**: `src/server.js` — TTL cleanup guard (line 60), MAX_SITEMAP_PAGES/MAX_BROWSER_DEPTH constants in `runSitemapGeneration()`.
- **Testing**: mergerecords.com — HTTP crawl found 1 page → SPA fallback → browser crawl found **200 pages** (store categories, artists, products, bundles) → XML sitemap 35,967 bytes. Crawl completed in ~3 minutes. All tests pass.

### ALL 17 PHASES COMPLETE + POST-PHASE ENHANCEMENTS
