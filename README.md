# AutoADA

**Automated ADA/WCAG Accessibility Compliance Scanner**

AutoADA scans websites for accessibility violations against WCAG 2.2 Level AA standards and generates professional, client-ready reports. Powered by [axe-core](https://github.com/dequelabs/axe-core), the industry-standard accessibility testing engine.

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

### Annotated Screenshots
- Multi-region capture — scrolls to violation clusters, captures up to 2 regions per viewport
- Color-coded severity overlays (critical, serious, moderate, minor) with numbered markers
- Both desktop and mobile viewport captures

### Remediation Guidance
- Fix suggestions for every violation
- WCAG success criteria mapping (all 55 Level A+AA criteria) with legal relevance
- Effort estimates per violation
- Before/after code examples
- Risk assessment (HIGH/MODERATE/LOW) with priority action recommendations

### Web Dashboard
- Live progress streaming via Server-Sent Events
- Interactive results with charts, filtering, and sorting
- Export in all 4 report formats
- Confidence column with sort support
- Manual testing checklist (8 static items + dynamic items from scan results)
- Concurrent scan limit (3 simultaneous scans, 30-min TTL cleanup)

---

## Tech Stack

- **Runtime:** Node.js (>=18.0.0)
- **Browser Automation:** Puppeteer + puppeteer-extra (stealth plugin)
- **Accessibility Engine:** axe-core (via @axe-core/puppeteer)
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
- URL input with advanced options (crawling, interactive scanning, concurrency)
- Live progress streaming via Server-Sent Events
- Interactive results dashboard with charts and exports

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
| `0` | Scan complete, no violations found |
| `1` | Scan complete, violations found |

---

## How It Works

1. **Discover Pages** — AutoADA finds pages via `sitemap.xml`. If no sitemap is found, it auto-crawls links from the homepage. You can also provide extra URLs via file.
2. **Load & Prepare** — Each page is loaded in a headless browser with stealth mode. Cloudflare challenges are detected and waited out. SPA frameworks are detected and the scanner waits for DOM stability.
3. **Scan** — axe-core runs at both desktop and mobile viewports. Popups are dismissed and the page is re-scanned. If `--interactive` is enabled, collapsed content is expanded and scanned. Keyboard trap detection runs automatically.
4. **Score** — Violations are deduplicated, tagged with confidence levels, and scored with severity-weighted logarithmic penalties. Low-confidence violations have reduced impact on the score.
5. **Report** — Results are compiled into professional reports with WCAG success criteria details, remediation guidance, annotated screenshots, and risk assessment.

---

## Page Discovery

AutoADA uses a multi-strategy approach to find pages:

1. **Sitemap** — Fetches `/sitemap.xml` (with browser-like headers to pass WAFs)
2. **Auto-crawl fallback** — If no sitemap found, BFS-crawls links from the start URL (max depth 2)
3. **Manual crawl** — `--crawl` flag enables link crawling even when sitemap exists
4. **Extra URLs** — `--extra-urls <file>` adds URLs from a text file
5. **robots.txt** — Respects `Disallow` directives when crawling

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
│   ├── reporters/
│   │   ├── json.js         # JSON report generator
│   │   ├── csv.js          # CSV report generator
│   │   ├── html.js         # HTML report generator (self-contained)
│   │   └── pdf.js          # PDF report generator (via Puppeteer)
│   ├── data/
│   │   ├── benchmarks.json # Industry benchmarks (WebAIM Million 2025)
│   │   ├── false-positives.json  # FP metadata per axe-core rule
│   │   ├── remediation.json      # Fix guidance + code examples
│   │   └── wcag-map.json         # WCAG 2.2 success criteria mapping
│   └── web/
│       └── index.html      # Web UI (single-page app, dark theme)
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

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/scan` | Start a new scan (body: `{url, formats, crawl, interactive, concurrency, ...}`) |
| `GET` | `/api/scan/:id` | Get scan status and results |
| `GET` | `/api/scan/:id/stream` | SSE progress stream |
| `GET` | `/api/scan/:id/export/:format` | Download report (json, csv, html, pdf) |

---

## Built With

Built by **Tushar Tomar** at **IT GEEKS**

Powered by [axe-core](https://github.com/dequelabs/axe-core) — WCAG 2.2 Level AA

---

## License

Proprietary — All rights reserved.
