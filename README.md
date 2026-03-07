# AutoADA

**Automated ADA/WCAG Accessibility Compliance Scanner**

AutoADA scans websites for accessibility violations against WCAG 2.2 Level AA standards and generates professional, client-ready reports. Powered by [axe-core](https://github.com/dequelabs/axe-core), the industry-standard accessibility testing engine.

---

## Features

### Core Scanning
- **Multi-page site scanning** — Automatically discovers pages via `sitemap.xml`
- **Dual viewport testing** — Scans at desktop (1280px) and mobile (375px) to catch responsive accessibility issues
- **Smart popup handling** — Dismisses cookie banners, modals, and overlays before scanning
- **Defensive page loading** — Multiple loading strategies (DOM content, network idle, selector waits)
- **Browser context isolation** — Each scan runs in an isolated browser context for reliability

### Standards Coverage
| Standard | Levels |
|----------|--------|
| WCAG 2.0 | A, AA |
| WCAG 2.1 | A, AA |
| WCAG 2.2 | AA |
| ADA Title III | Compliance |
| Section 508 | Compliance |

### WCAG Principles Checked
- **Perceivable** — Image alt text, color contrast, text alternatives, captions, adaptable content
- **Operable** — Keyboard navigation, focus management, skip links, timing, seizure-safe animations
- **Understandable** — Language attributes, readable content, predictable navigation, form labels, error identification
- **Robust** — Valid HTML parsing, ARIA attributes, name-role-value compliance, assistive tech compatibility

### Scoring & Benchmarking
- **0–100 compliance score** with severity-weighted logarithmic penalties
- **Per-principle breakdown** (Perceivable, Operable, Understandable, Robust)
- **Industry benchmarking** — Compare against ecommerce, SaaS, healthcare, government, and more
- **Percentile rankings** — See where your site stands relative to peers

### Report Formats
| Format | Description |
|--------|-------------|
| **HTML** | Self-contained, branded, interactive report with charts and screenshots |
| **PDF** | Print-ready version of the HTML report |
| **JSON** | Complete raw data with all axe-core metadata |
| **CSV** | Per-element violations table for spreadsheet analysis |

### Annotated Screenshots
- Visual overlays highlight violations directly on page screenshots
- Color-coded severity indicators (critical, serious, moderate, minor)
- Both desktop and mobile viewport captures

### Remediation Guidance
- Fix suggestions for every violation
- WCAG success criteria mapping
- Effort estimates per violation
- Before/after code examples

---

## Tech Stack

- **Runtime:** Node.js (>=18.0.0)
- **Browser Automation:** Puppeteer
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
- URL input with advanced options
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

#### Examples

```bash
# Basic scan with HTML report
npm start -- https://example.com

# Full audit with all report formats
npm start -- https://example.com -f all --client-name "Acme Corp"

# Quick scan with page limit
npm start -- https://example.com --max-pages 10 -f html,pdf
```

---

## How It Works

1. **Enter URL** — Provide your website URL. AutoADA discovers all pages via `sitemap.xml` automatically.
2. **Crawl & Scan** — Each page is loaded in a headless browser and tested with axe-core at two viewports (desktop + mobile).
3. **Analyze** — Violations are deduplicated, scored, and mapped to WCAG success criteria with remediation tips.
4. **Review & Export** — Explore results in the interactive dashboard, then download reports in any format.

---

## Project Structure

```
AutoADA/
├── src/
│   ├── index.js            # CLI entry point
│   ├── server.js           # Express web server + API
│   ├── crawler.js          # Page discovery (sitemap + extra URLs)
│   ├── scanner.js          # Core scanning engine (Puppeteer + axe-core)
│   ├── score.js            # Scoring, benchmarking, and principle breakdown
│   ├── screenshotter.js    # Screenshot capture with violation overlays
│   ├── reporters/
│   │   ├── json.js         # JSON report generator
│   │   ├── csv.js          # CSV report generator
│   │   ├── html.js         # HTML report generator (self-contained)
│   │   └── pdf.js          # PDF report generator (via Puppeteer)
│   ├── data/
│   │   ├── benchmarks.json # Industry score benchmarks
│   │   ├── false-positives.json
│   │   └── remediation.json
│   └── web/
│       └── index.html      # Web UI (single-page app)
├── test-reports/           # Sample generated reports
├── package.json
└── start.command           # macOS launcher
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

## Industry Benchmarks

AutoADA compares your score against real-world data:

- **Overall industry average:** 34/100
- Top-performing sectors: Government (42), Education (40), SaaS (38)
- Most common issues: Low contrast (86% of sites), missing alt text (60%), empty links (51%)

| Score Range | Rating |
|-------------|--------|
| 90–100 | Excellent |
| 70–89 | Good |
| 50–69 | Needs Improvement |
| 30–49 | Poor |
| 0–29 | Critical |

---

## Built With

Built by **Tushar Tomar** at **IT GEEKS**

Powered by [axe-core](https://github.com/dequelabs/axe-core) — WCAG 2.2 Level AA

---

## License

Proprietary — All rights reserved.
