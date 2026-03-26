# AutoADA

**Automated ADA/WCAG Accessibility & SEO Compliance Scanner**

AutoADA scans websites for accessibility violations against WCAG 2.2 Level AA standards and performs comprehensive SEO health analysis, generating professional, client-ready reports. Powered by [axe-core](https://github.com/dequelabs/axe-core) and [Google Lighthouse](https://developer.chrome.com/docs/lighthouse/).

---

## Features

### Core Scanning
- **Multi-page site scanning** — Discovers pages via `sitemap.xml`, link crawling, or manual URL lists
- **Dual viewport testing** — Scans at desktop (1280px) and mobile (375px) to catch responsive issues
- **Smart popup handling** — Dismisses cookie banners, modals, Klaviyo popups, and overlays before scanning
- **Cloudflare bypass** — Stealth plugin automatically handles bot-detection challenges
- **SPA framework support** — Detects React, Vue, Next.js, and Angular; waits for DOM stability before scanning
- **Interactive state scanning** — Expands accordions, tabs, and `<details>` elements to find hidden violations
- **Keyboard trap detection** — Simulates Tab cycling to detect focus traps (WCAG 2.1.1)
- **Concurrent scanning** — Scan multiple pages in parallel for faster audits
- **Retry with backoff** — Automatically retries failed pages (2 retries, exponential delay)

### SEO Analysis
- **Lighthouse performance audits** — Desktop and mobile performance scores via Google Lighthouse
- **Core Web Vitals** — LCP, CLS, TBT, FCP, and TTFB measurement with pass/fail thresholds
- **Meta tag analysis** — Title, description, canonical, Open Graph, and Twitter Card validation
- **Heading structure** — H1-H6 hierarchy analysis with SEO recommendations
- **Image optimization** — Alt text, lazy loading, and file size checks
- **Link health** — Internal/external link counts, broken link detection
- **Structured data** — Schema.org and JSON-LD validation
- **Indexability** — Robots meta tags, robots.txt, canonical URL, and crawlability checks
- **Speed suggestions** — Code-level fix recommendations based on CWV thresholds and Lighthouse opportunities

### Color Contrast Verification
- **Pixel-level color sampling** — Verifies incomplete `color-contrast` items by sampling actual foreground/background colors from the live page
- **Confirmed vs. Needs Review** — Separates verified fails from uncertain items (e.g., elements with `background-image`)
- **WCAG AA ratio calculation** — 4.5:1 for normal text, 3.0:1 for large text
- **Background color walking** — Traverses parent elements to find the effective background color

### Standards Coverage
| Standard | Levels |
|----------|--------|
| WCAG 2.0 | A, AA |
| WCAG 2.1 | A, AA |
| WCAG 2.2 | AA |
| ADA Title III | Compliance |
| Section 508 | Compliance |

### Scoring & Confidence
- **0-100 compliance score** with severity-weighted logarithmic penalties, weighted by node count
- **Confidence-weighted scoring** — Low-confidence violations (e.g., `color-contrast` false positives) penalize 85% less than confirmed issues
- **Per-principle breakdown** (Perceivable, Operable, Understandable, Robust)
- **Confirmed vs. Needs Review** — Every violation tagged as high, medium, or low confidence
- **Industry benchmarking** — Compare against WebAIM Million 2025 data (ecommerce, SaaS, healthcare, government)
- **Score disclaimer** — Reports clearly state automated scanning covers ~30-40% of WCAG criteria

### Report Formats
| Format | Description |
|--------|-------------|
| **HTML** | Self-contained report with WCAG SC details, confidence badges, per-page breakdown, and screenshots |
| **PDF** | Print-ready version of the HTML report |
| **JSON** | Complete raw data with all axe-core metadata, confidence scores, and error fields |
| **CSV** | Per-element violations table for spreadsheet analysis |
| **Combined** | Unified ADA + SEO report merging accessibility violations, SEO issues, and overlapping findings |

### Annotated Screenshots
- Multi-region capture — scrolls to violation clusters, captures up to 3 regions per viewport
- Color-coded severity overlays (critical, serious, moderate, minor) with numbered markers and legend table
- Confidence badges on annotations (Confirmed, Likely, Needs Verification)
- Invisible element filtering and overlap merging
- Both desktop and mobile viewport captures

### Remediation Guidance
- Fix suggestions for every violation with before/after code examples
- WCAG success criteria mapping (all 55 Level A+AA criteria) with legal relevance
- Effort estimates per violation
- Risk assessment (HIGH/MODERATE/LOW) with priority action recommendations

### Sitemap Generation
- **Terminal UI** — Real-time crawl progress with live URL discovery feed
- **BFS HTTP crawl** — Lightweight link extraction, no browser needed
- **SPA browser fallback** — Automatic switch to headless browser for JavaScript-rendered sites
- **robots.txt respect** — Skips disallowed paths during crawl
- **XML sitemap download** — W3C-compliant sitemap ready for search engine submission

### Web Dashboard
- **Audit switcher** — Segmented control: Combined / ADA / SEO views with URL state management
- **Combined dashboard** — Health score cards (ADA + SEO side-by-side), overlapping issues, quick stats
- **Impact simulator** — Toggle violations on/off to see projected score changes with effort estimates
- **SEO roadmap** — 3-column kanban layout (Quick Wins / Medium Effort / Deep Fixes)
- **Contrast verification display** — Confirmed fails, verified passes, and uncertain items with color swatches
- **Sitemap generation terminal** — Live crawl progress with page counter and depth tags
- Live progress streaming via Server-Sent Events with reconnection and polling fallback
- Interactive results with charts, filtering, sorting by confidence/severity
- Export in all 5 report formats (HTML, PDF, JSON, CSV, Combined)
- Confidence column with sort support
- Manual testing checklist (8 static items + dynamic items from scan results)
- Badge SVG generator with ADA score and SEO score
- Developer Handoff export (overlapping ADA+SEO issues first, then per-audit)
- Concurrent scan limit (3 simultaneous scans, 30-min TTL cleanup)
- SSE heartbeat (25s) to prevent proxy/browser connection timeouts

---

## Tech Stack

- **Runtime:** Node.js (>=18.0.0)
- **Browser Automation:** Puppeteer + puppeteer-extra (stealth plugin)
- **Accessibility Engine:** axe-core (via @axe-core/puppeteer)
- **SEO & Performance:** Google Lighthouse
- **Web Server:** Express.js
- **CLI Framework:** Commander.js
- **Charts:** Chart.js (frontend)

---

## Installation

```bash
# Clone the repository
git clone <repo-url>
cd AutoADA

# Install dependencies
npm install
```

---

## Usage

### Web UI (Recommended)

```bash
npm run web
```

Opens a web server at `http://localhost:3000` with an interactive dashboard featuring:
- URL input with scan type toggle (ADA + SEO checkboxes)
- Advanced options (crawling, interactive scanning, concurrency, WCAG tags)
- Live progress streaming via Server-Sent Events
- Combined/ADA/SEO audit views with sub-tabs
- Impact simulator, SEO roadmap, contrast verification, and all exports

On macOS, you can also double-click `start.command` to launch.

### CLI

```bash
npm start -- <url> [options]
```

#### Options

| Flag | Description | Default |
|------|-------------|---------|
| `-f, --format <formats>` | Report format(s): `json`, `csv`, `html`, `pdf`, `all` | `html` |
| `-o, --output <dir>` | Output directory | `./reports` |
| `--client-name <name>` | Client name for branding | — |
| `--client-logo <path>` | Client logo path | — |
| `--client-color <hex>` | Accent color (hex) | — |
| `-t, --tags <tags>` | WCAG tags (comma-separated) | all |
| `--timeout <ms>` | Page load timeout | `30000` |
| `--max-pages <n>` | Maximum pages to scan | `100` |
| `--crawl` | Enable link-based page discovery (BFS crawl) | `false` |
| `--interactive` | Scan interactive states (accordions, tabs, details) | `false` |
| `--concurrency <n>` | Number of pages to scan in parallel | `1` |
| `--extra-urls <file>` | Text file with additional URLs (one per line) | — |
| `--axe-config <path>` | JSON config to disable rules, include/exclude selectors | — |

#### Examples

```bash
# Basic scan with HTML report
npm start -- https://example.com

# Full audit with all report formats and client branding
npm start -- https://example.com -f all --client-name "Acme Corp" --client-color "#ff6600"

# Thorough scan with crawling, interactive states, and concurrency
npm start -- https://example.com --crawl --interactive --concurrency 3 --max-pages 20

# Scan with custom axe-core config (disable specific rules)
npm start -- https://example.com --axe-config ./axe-config.json

# Quick single-page scan as JSON
npm start -- https://example.com --max-pages 1 -f json
```

#### Exit Codes

| Code | Meaning |
|------|---------|
| `0` | Scan complete, no critical/serious violations |
| `1` | Scan complete, critical or serious violations found |

---

## How It Works

1. **Discover Pages** — AutoADA finds pages via `sitemap.xml`. If no sitemap is found, it auto-crawls links from the homepage. You can also provide extra URLs via file.
2. **Load & Prepare** — Each page is loaded in a headless browser with stealth mode. Cloudflare challenges are detected and waited out. SPA frameworks are detected and the scanner waits for DOM stability.
3. **Scan** — axe-core runs at both desktop and mobile viewports. Popups are dismissed and the page is re-scanned. If `--interactive` is enabled, collapsed content is expanded and scanned. Keyboard trap detection runs automatically.
4. **Verify Contrast** — Incomplete `color-contrast` items are verified by sampling actual pixel colors from the live page, separating confirmed failures from uncertain results.
5. **Score** — Violations are deduplicated, tagged with confidence levels, and scored with severity-weighted logarithmic penalties. Low-confidence violations have reduced impact on the score.
6. **SEO Audit** — Google Lighthouse runs performance audits at both desktop and mobile. HTML-level SEO analysis checks meta tags, headings, images, links, structured data, and indexability.
7. **Report** — Results are compiled into professional reports with WCAG success criteria details, remediation guidance, annotated screenshots, risk assessment, and SEO health metrics.

---

## Page Discovery

AutoADA uses a multi-strategy approach to find pages:

1. **Sitemap** — Fetches `/sitemap.xml` (with browser-like headers to pass WAFs)
2. **Auto-crawl fallback** — If no sitemap found, BFS-crawls links from the start URL (max depth 2)
3. **Manual crawl** — `--crawl` flag enables link crawling even when sitemap exists
4. **Extra URLs** — `--extra-urls <file>` adds URLs from a text file
5. **robots.txt** — Respects `Disallow` directives when crawling
6. **SPA browser crawl** — Falls back to headless browser for JavaScript-rendered sites

---

## Project Structure

```
AutoADA/
├── src/
│   ├── index.js            # CLI entry point
│   ├── server.js           # Express web server + API
│   ├── crawler.js          # Page discovery (sitemap + crawl + robots.txt)
│   ├── scanner.js          # Core scanning engine (Puppeteer + axe-core)
│   ├── score.js            # Scoring, benchmarking, and principle breakdown
│   ├── confidence.js       # False-positive confidence scoring
│   ├── screenshotter.js    # Multi-region screenshot capture with overlays
│   ├── seo.js              # SEO analysis engine (Lighthouse + HTML checks)
│   ├── contrast-verify.js  # Pixel-level color contrast verification
│   ├── reporters/
│   │   ├── json.js         # JSON report generator
│   │   ├── csv.js          # CSV report generator
│   │   ├── html.js         # HTML report generator (self-contained)
│   │   ├── pdf.js          # PDF report generator (via Puppeteer)
│   │   └── utils.js        # Shared reporter utilities
│   ├── data/
│   │   ├── benchmarks.json # Industry benchmarks (WebAIM Million 2025)
│   │   ├── false-positives.json  # FP metadata per axe-core rule
│   │   ├── remediation.json      # Fix guidance + code examples
│   │   └── wcag-map.json         # WCAG 2.2 success criteria mapping
│   └── web/
│       └── index.html      # Web UI (single-page app, dark theme)
├── __tests__/
│   ├── unit/               # Unit tests (score, confidence, seo)
│   └── smoke/              # Smoke tests (server API)
├── reports/                 # Generated reports output
├── package.json
└── start.command            # macOS launcher
```

---

## Severity Levels

| Level | Description |
|-------|-------------|
| **Critical** | Barriers that completely prevent access for some users |
| **Serious** | Significant barriers that make content very difficult to access |
| **Moderate** | Barriers that cause some difficulty for users with disabilities |
| **Minor** | Issues that slightly degrade the user experience |

---

## Confidence Levels

Every violation is tagged with a confidence level indicating how likely it is to be a real issue:

| Confidence | Weight | Description |
|------------|--------|-------------|
| **High** | 1.0 | Deterministic rules (`html-has-lang`, `document-title`, `button-name`, `image-alt`, etc.) |
| **Medium** | 0.6 | Rules with moderate false-positive rates (`heading-order`, `region`, `label`) |
| **Low** | 0.15 | Rules known for false positives (`color-contrast`, `link-in-text-block`) — reduced score impact |

Contextual checks further adjust confidence at the node level (e.g., `alt=""` on decorative images, contrast issues on elements with `background-image`).

---

## Industry Benchmarks

AutoADA compares your score against WebAIM Million 2025 data:

- **Overall industry average:** 34/100
- **94.8%** of sites fail at least one WCAG criterion
- Top-performing sectors: Government (42), Education (40), SaaS (38)
- Most common issues: Low contrast (79.1% of sites), missing alt text (55.5%), empty links (94.8% failing)

| Score Range | Rating |
|-------------|--------|
| 90-100 | Excellent |
| 70-89 | Good |
| 50-69 | Needs Improvement |
| 30-49 | Poor |
| 0-29 | Critical |

---

## API

When running the web server (`npm run web`), these endpoints are available:

### ADA Scanning
| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/scan` | Start a new ADA scan |
| `GET` | `/api/scan/:id` | Get scan status and results |
| `GET` | `/api/scan/:id/stream` | SSE progress stream |
| `GET` | `/api/scan/:id/export/:format` | Download ADA report (json, csv, html, pdf) |

### SEO Scanning
| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/seo-scan` | Start a new SEO scan |
| `GET` | `/api/seo-scan/:id/progress` | SSE progress stream for SEO scan |
| `GET` | `/api/seo-scan/:id/results` | Get SEO scan results |
| `GET` | `/api/seo-scan/:id/export/:format` | Download SEO report (json, html, pdf) |

### Combined Reports
| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/scan/:id/combined-export/:format` | Download combined ADA+SEO report (html, pdf, json) |

### Sitemap Generation
| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/scan/:id/generate-sitemap` | Start sitemap generation (async, returns 202) |
| `GET` | `/api/scan/:id/sitemap-progress` | SSE progress stream for sitemap crawl |
| `GET` | `/api/scan/:id/sitemap-download` | Download generated sitemap XML |

---

## Testing

```bash
# Run all tests
npm test

# Unit tests only
npm run test:unit

# Smoke tests only (starts server)
npm run test:smoke
```

---

## Built With

Built by **Tushar Tomar** at **IT GEEKS**

Powered by [axe-core](https://github.com/dequelabs/axe-core) + [Google Lighthouse](https://developer.chrome.com/docs/lighthouse/) — WCAG 2.2 Level AA

---

## License

Proprietary — All rights reserved.
