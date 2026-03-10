# AutoADA — Comprehensive Test Plan

> **Purpose**: Verify every feature, catch every bug, ensure accurate real-world audit output with minimal false positives.
> **Method**: Real-site testing across 7 categories. Each test has explicit pass/fail criteria.
> **Runtime estimate**: ~3-4 hours total across all phases.

---

## Test Sites Reference

| ID | URL | Category | Why |
|----|-----|----------|-----|
| T1 | `https://www.w3.org/WAI/demos/bad/before/home.html` | Known-bad | W3C's own inaccessible demo — missing alt, labels, tab order |
| T2 | `https://dequeuniversity.com/demo/mars/` | Known-bad | Deque's intentional-error demo (axe-core creators) |
| T3 | `https://the-internet.herokuapp.com/` | Known-bad + iframes | Broken images, iframes, nested frames, diverse UI patterns |
| T4 | `https://www.gov.uk/` | Known-good | UK Gov — built to WCAG 2.2 AA, Design System compliant |
| T5 | `https://www.a11yproject.com/` | Known-good | Community a11y resource, built with accessibility as core |
| T6 | `https://vercel.com/` | SPA (Next.js) | Tests SPA/framework readiness detection |
| T7 | `https://hereticparfum.com/` | Cloudflare + Shopify | Tests stealth bypass, popup dismissal, multi-page crawl |
| T8 | `https://colourpop.com/` | E-commerce + popups | Shopify, Klaviyo popups, contrast issues |
| T9 | `https://designsystem.digital.gov/components/accordion/` | Interactive | USWDS accordion with proper ARIA |
| T10 | `https://the-internet.herokuapp.com/nested_frames` | Iframes | Nested iframe scanning |
| T11 | `https://www.fashionnova.com/` | Keyboard traps + popups | Aggressive overlays, focus management issues |

---

## Phase 1: Core Scanning Accuracy

> Goal: Verify the scanner finds real issues and doesn't miss important ones.

### Test 1.1 — Known-Bad Site: W3C BAD Demo

```bash
node src/index.js https://www.w3.org/WAI/demos/bad/before/home.html -f json --timeout 60000
```

**PASS criteria:**
- [ ] Score is below 60 (site is intentionally broken)
- [ ] Detects `image-alt` violations (site has images without alt or with useless alt like phone numbers)
- [ ] Detects `label` or `input` form violations (survey page has unlabeled form fields)
- [ ] Detects `link-name` violations (links with no accessible text)
- [ ] Detects `color-contrast` violations
- [ ] Total violations > 5 distinct rules
- [ ] Total affected elements > 10
- [ ] No crash, no timeout, clean exit

**FAIL signals:**
- Score above 80 (missed too many real issues)
- 0 violations found (scanner broken)
- Only 1-2 violation rules (not catching enough)

---

### Test 1.2 — Known-Bad Site: Deque Mars Commuter

```bash
node src/index.js https://dequeuniversity.com/demo/mars/ -f json --timeout 60000
```

**PASS criteria:**
- [ ] Score is below 70 (intentional errors)
- [ ] Detects `button-name` or `link-name` violations
- [ ] Detects `image-alt` violations
- [ ] Total violations ≥ 3 distinct rules
- [ ] Exit code is 1 (critical/serious violations found)

---

### Test 1.3 — Known-Good Site: GOV.UK

```bash
node src/index.js https://www.gov.uk/ -f json --timeout 60000
```

**PASS criteria:**
- [ ] Score is above 80 (well-built accessible site)
- [ ] Total violations ≤ 5 rules (few real issues)
- [ ] No `image-alt` high-confidence violations on the homepage
- [ ] No `html-has-lang` violation (site has `lang="en"`)
- [ ] No `document-title` violation
- [ ] Most violations (if any) are low or medium confidence
- [ ] No crash, no timeout

**FAIL signals:**
- Score below 50 (too many false positives)
- More than 10 violation rules (over-reporting)
- High-confidence violations on things that are clearly correct

---

### Test 1.4 — Known-Good Site: A11Y Project

```bash
node src/index.js https://www.a11yproject.com/ -f json --timeout 60000
```

**PASS criteria:**
- [ ] Score is above 80
- [ ] Low false-positive count (≤ 3 high-confidence violations)
- [ ] If `color-contrast` flagged, it should be `_confidence: 'low'`

---

## Phase 2: Confidence Scoring & False Positive Reduction

> Goal: Verify confidence levels are accurate and FP-prone rules don't tank the score.

### Test 2.1 — Confidence Field Presence

Using output from Test 1.1 (W3C BAD):

```bash
node -e "
const r = require('./reports/<W3C-BAD-report>.json');
const v = r.scanResult.allViolations;
const missing = v.filter(x => !x._confidence);
console.log('Total violations:', v.length);
console.log('Missing _confidence:', missing.length);
console.log('High:', v.filter(x => x._confidence === 'high').length);
console.log('Medium:', v.filter(x => x._confidence === 'medium').length);
console.log('Low:', v.filter(x => x._confidence === 'low').length);
"
```

**PASS criteria:**
- [ ] Every violation has `_confidence` field (missing count = 0)
- [ ] `color-contrast` violations (if any) are `_confidence: 'low'`
- [ ] `html-has-lang` or `document-title` violations (if any) are `_confidence: 'high'`
- [ ] `image-alt` violations are `_confidence: 'high'` (deterministic rule)
- [ ] Some violations have `_falsePositiveNote` where applicable

---

### Test 2.2 — Confidence-Weighted Score Impact

```bash
node -e "
const { calculateOverallScore, CONFIDENCE_WEIGHTS } = require('./src/score');

// Simulate: 5 high-conf violations, 5 passes
const highV = [{id:'a', impact:'serious', _confidence:'high', nodes:[{},{},{},{},{}]}];
const lowV = [{id:'a', impact:'serious', _confidence:'low', nodes:[{},{},{},{},{}]}];
const passes = [{id:'p', nodes:[{},{},{},{},{}]}];

console.log('High-confidence score:', calculateOverallScore(highV, passes));
console.log('Low-confidence score:', calculateOverallScore(lowV, passes));
console.log('No violations:', calculateOverallScore([], passes));
console.log('WEIGHTS:', JSON.stringify(CONFIDENCE_WEIGHTS));
"
```

**PASS criteria:**
- [ ] Low-confidence score is significantly higher than high-confidence score (>20 point gap)
- [ ] No violations → score 100
- [ ] CONFIDENCE_WEIGHTS has high: 1.0, medium: 0.6, low: 0.15

---

### Test 2.3 — Contextual FP Checks

Using output from any scan with `color-contrast` violations:

**PASS criteria:**
- [ ] `color-contrast` nodes on elements with `background-image` get `_falsePositiveNote` mentioning gradient/background
- [ ] `image-alt` nodes where `alt=""` get note about decorative images
- [ ] Confidence levels on contextually-downgraded nodes are `'low'`

---

### Test 2.4 — Confirmed vs Review Breakdown in Scores

Using any JSON report output:

```bash
node -e "
const r = require('./reports/<any-report>.json');
const s = r.scores;
console.log('confirmedViolations:', s.confirmedViolations);
console.log('needsReviewViolations:', s.needsReviewViolations);
console.log('confirmedNodes:', s.confirmedNodes);
console.log('needsReviewNodes:', s.needsReviewNodes);
console.log('totalViolations:', s.totalViolations);
console.log('Check: confirmed + review = total:',
  s.confirmedViolations + s.needsReviewViolations === s.totalViolations);
"
```

**PASS criteria:**
- [ ] `confirmedViolations + needsReviewViolations === totalViolations`
- [ ] `confirmedNodes + needsReviewNodes` approximately equals `totalViolationNodes`
- [ ] All four fields are numbers (not undefined/null)

---

## Phase 3: Scanner Features

### Test 3.1 — Dual Viewport Scanning

Using JSON output from any scan:

```bash
node -e "
const r = require('./reports/<any-report>.json');
const pages = r.scanResult.pages;
for (const p of pages) {
  console.log(p.url);
  console.log('  Desktop violations:', p.desktop?.violations?.length || 0);
  console.log('  Mobile violations:', p.mobile?.violations?.length || 0);
  console.log('  Combined violations:', p.combined?.violations?.length || 0);
}
// Check viewport tags
const allV = r.scanResult.allViolations || [];
for (const v of allV.slice(0, 5)) {
  console.log(v.id, '_viewport:', v._viewport);
  if (v.nodes?.[0]) console.log('  node _viewport:', v.nodes[0]._viewport);
}
"
```

**PASS criteria:**
- [ ] Each page has both `desktop` and `mobile` results
- [ ] Combined violations merge desktop + mobile correctly
- [ ] Violation nodes have `_viewport: 'desktop'` or `_viewport: 'mobile'`
- [ ] Violation-level `_viewport` is `'desktop-only'`, `'mobile-only'`, or `'both'`

---

### Test 3.2 — SPA/Framework Detection (Next.js)

```bash
node src/index.js https://vercel.com/ -f json --timeout 60000 2>&1 | grep -i "framework\|next\|react\|hydrat\|mutation\|DOM stable"
```

**PASS criteria:**
- [ ] Console output mentions detected framework (Next.js or React)
- [ ] Scan completes without timeout (framework detection doesn't hang)
- [ ] Score is reasonable (not 0, not distorted by loading issues)
- [ ] Violations found are real issues, not artifacts of incomplete loading

---

### Test 3.3 — Cloudflare Bypass

```bash
node src/index.js https://hereticparfum.com/ -f json --timeout 90000 --max-pages 3 2>&1
```

**PASS criteria:**
- [ ] Does NOT report "Just a moment..." as page content
- [ ] Does NOT report `meta-refresh` as the only violation
- [ ] Finds real violations (contrast, alt text, etc.) — at least 3 rules
- [ ] Score is in the 20-60 range (real score, not challenge page score)
- [ ] Multiple pages discovered (sitemap or crawl finds > 1 page)

**FAIL signals:**
- Score of 18 or similar (scanning challenge page, not real site)
- Only 1 violation found (meta-refresh from Cloudflare)
- Only 1 page scanned when site has many pages

---

### Test 3.4 — Interactive State Scanning

```bash
# Without --interactive
node src/index.js https://designsystem.digital.gov/components/accordion/ -f json --timeout 60000 2>&1

# With --interactive
node src/index.js https://designsystem.digital.gov/components/accordion/ -f json --interactive --timeout 60000 2>&1
```

**PASS criteria:**
- [ ] With `--interactive`: scanner finds and expands accordion panels
- [ ] Console mentions "interactive" or "expanded" during scan
- [ ] If violations exist inside collapsed content, they're found with `--interactive` but missed without
- [ ] Violations from interactive scanning tagged with `_source: 'interactive'`
- [ ] No crash from clicking interactive elements
- [ ] Max 10 interactive elements clicked (not infinite loop)

---

### Test 3.5 — Keyboard Trap Detection

```bash
node src/index.js https://www.fashionnova.com/ -f json --timeout 90000 2>&1
```

**PASS criteria:**
- [ ] If aggressive popups trap focus, `autoada-keyboard-trap` violation appears
- [ ] If no trap exists, no false `autoada-keyboard-trap` is reported
- [ ] `autoada-keyboard-trap` has `impact: 'critical'`, `_confidence: 'high'`
- [ ] No false keyboard trap on example.com (already verified, regression check)

```bash
# Regression: example.com should NOT have keyboard traps
node src/index.js https://example.com -f json 2>&1 | grep -c "keyboard-trap"
```
Expected output: `0`

---

### Test 3.6 — Popup/Overlay Dismissal

```bash
node src/index.js https://colourpop.com/ -f json --timeout 90000 2>&1
```

**PASS criteria:**
- [ ] Scan completes (popup doesn't block scanner)
- [ ] Screenshots (if captured) show actual page content, not popup covering everything
- [ ] Violations found are from the actual page, not just the popup
- [ ] Console may show "Dismissed overlay" or similar log

---

### Test 3.7 — Retry Logic

```bash
# Test with a very short timeout to trigger retries
node src/index.js https://www.gov.uk/ -f json --timeout 5000 2>&1 | grep -i "retry\|attempt\|backoff"
```

**PASS criteria:**
- [ ] If first attempt fails due to timeout, retry occurs
- [ ] Scanner doesn't crash on retry
- [ ] Final result is either successful scan or graceful error

---

### Test 3.8 — Request Interception

Using any scan, verify resources are blocked:

```bash
node src/index.js https://example.com -f json 2>&1
# Then check: screenshots should have images (images NOT blocked)
node -e "
const r = require('./reports/example-com-*.json');
// If pages have screenshots, they should have base64 data
"
```

**PASS criteria:**
- [ ] Fonts, media, beacons are blocked (scan is faster)
- [ ] Images are NOT blocked (screenshots show real page appearance)
- [ ] Tracker domains (google-analytics, doubleclick, facebook) are blocked
- [ ] Stylesheets are NOT blocked (page renders correctly)

---

## Phase 4: Crawler & Page Discovery

### Test 4.1 — Sitemap Discovery

```bash
node src/index.js https://www.gov.uk/ -f json --max-pages 5 --timeout 60000 2>&1 | head -20
```

**PASS criteria:**
- [ ] "Fetching sitemap" message appears
- [ ] Multiple pages discovered (> 1)
- [ ] All discovered URLs are same-domain (gov.uk)
- [ ] Respects `--max-pages` limit

---

### Test 4.2 — Auto-Crawl Fallback

```bash
# Site with no sitemap should auto-crawl
node src/index.js https://the-internet.herokuapp.com/ -f json --max-pages 5 --timeout 60000 2>&1 | head -25
```

**PASS criteria:**
- [ ] "auto-crawling links" message appears (sitemap returns 0)
- [ ] Link crawling discovers multiple pages (> 1)
- [ ] Discovered pages are same-domain
- [ ] No crash from crawling

---

### Test 4.3 — Explicit --crawl Flag

```bash
node src/index.js https://hereticparfum.com/ -f json --crawl --max-pages 5 --timeout 90000 2>&1 | head -25
```

**PASS criteria:**
- [ ] Crawling discovers pages beyond sitemap
- [ ] robots.txt is fetched and respected
- [ ] Only same-domain pages crawled
- [ ] Non-page extensions (.jpg, .pdf, .css) are skipped

---

### Test 4.4 — Extra URLs File

Create a test file:
```bash
echo "https://www.w3.org/WAI/demos/bad/before/home.html
https://www.w3.org/WAI/demos/bad/before/news.html
# This is a comment
https://www.w3.org/WAI/demos/bad/before/tickets.html" > /tmp/test-urls.txt

node src/index.js https://www.w3.org/WAI/demos/bad/before/home.html --extra-urls /tmp/test-urls.txt -f json --timeout 60000 2>&1 | head -20
```

**PASS criteria:**
- [ ] All 3 URLs are scanned (comments ignored)
- [ ] Multi-page scan produces per-page results
- [ ] Report contains data for all scanned pages

---

## Phase 5: Report Generation

### Test 5.1 — JSON Report Completeness

Using output from Test 1.1:

```bash
node -e "
const r = require('./reports/<W3C-BAD-report>.json');
const required = [
  'url', 'scanDate', 'toolVersion', 'pageCount', 'pages',
  'allViolations', 'allPasses', 'allIncomplete'
];
const scoreFields = [
  'overall', 'severityBreakdown', 'byPrinciple', 'benchmarkContext',
  'totalViolations', 'totalPasses', 'totalIncomplete',
  'confirmedViolations', 'needsReviewViolations'
];
for (const f of required) {
  console.log('scanResult.' + f + ':', r.scanResult[f] !== undefined ? 'OK' : 'MISSING');
}
for (const f of scoreFields) {
  console.log('scores.' + f + ':', r.scores[f] !== undefined ? 'OK' : 'MISSING');
}
"
```

**PASS criteria:**
- [ ] All required fields present in `scanResult`
- [ ] All score fields present in `scores`
- [ ] `pages` array has correct length
- [ ] Each page has `url`, `desktop`, `mobile`, `combined`
- [ ] `benchmarkContext` has `score`, `label`, `summary`
- [ ] `byPrinciple` has all 4 principles (Perceivable, Operable, Understandable, Robust)

---

### Test 5.2 — CSV Report Completeness

```bash
node src/index.js https://www.w3.org/WAI/demos/bad/before/home.html -f csv --timeout 60000

# Then check CSV
head -5 reports/*bad*before*.csv
wc -l reports/*bad*before*.csv
```

**PASS criteria:**
- [ ] CSV has header row with: Page URL, Rule ID, Impact, Description, Help, WCAG Criteria, Viewport, Element Selector, HTML Snippet, Help URL, Failure Summary
- [ ] One row per affected element (not per rule)
- [ ] Row count = total affected elements + 1 (header)
- [ ] Special characters (quotes, commas, newlines) properly escaped
- [ ] WCAG criteria formatted as "X.Y.Z"

---

### Test 5.3 — HTML Report Quality

```bash
node src/index.js https://www.w3.org/WAI/demos/bad/before/home.html -f html --timeout 60000
```

Open the HTML file in a browser and verify:

**PASS criteria:**
- [ ] Report opens and renders without errors
- [ ] **Score disclaimer** visible: "Automated Scan Score — ~30-40% of WCAG 2.2 criteria"
- [ ] **Score card** shows score with color coding
- [ ] **Risk assessment** shows HIGH/MODERATE/LOW with badge
- [ ] **Key metrics row** shows 4 cards (pages, violations, elements, fix time)
- [ ] **Confirmed/Review metrics** row shows 4 cards
- [ ] **Severity breakdown** chart present
- [ ] **Principle scores** section with 4 principles
- [ ] **Violation cards** each have:
  - Severity badge (critical/serious/moderate/minor)
  - **Confidence badge** (Confirmed/Likely/Needs Verification)
  - WCAG SC details (number, name, level badge, legal relevance)
  - "Why This Matters" section
  - Affected elements list (expandable)
  - Before/After code examples (where available)
  - Recommended fix with Deque link
- [ ] Violations sorted by **confidence first** (Confirmed at top), then severity
- [ ] **Per-page breakdown** with individual page scores (if multi-page)
- [ ] **Screenshots** with numbered overlays and legend
- [ ] All internal CSS (no external dependencies)
- [ ] All images as base64 (self-contained)
- [ ] TOC navigation works (anchor links)

---

### Test 5.4 — PDF Report Generation

```bash
node src/index.js https://www.w3.org/WAI/demos/bad/before/home.html -f pdf --timeout 60000
```

**PASS criteria:**
- [ ] PDF file generated without error
- [ ] PDF opens in any viewer
- [ ] Content matches HTML report (same data)
- [ ] Page numbers in footer ("Page X of Y")
- [ ] "AutoADA Compliance Report" in footer
- [ ] Reasonable file size (< 10MB for single page)

---

### Test 5.5 — All Formats at Once

```bash
node src/index.js https://www.w3.org/WAI/demos/bad/before/home.html -f all --timeout 60000
ls -la reports/*bad*before*
```

**PASS criteria:**
- [ ] All 4 files generated: .json, .csv, .html, .pdf
- [ ] No errors during generation
- [ ] All files non-empty and reasonable size

---

### Test 5.6 — Client Branding

```bash
node src/index.js https://example.com -f html --client-name "Acme Corp" --client-color "#ff6600" --timeout 60000
```

Open the HTML report:

**PASS criteria:**
- [ ] "Acme Corp" appears in the report header
- [ ] Client color (#ff6600) is used for accent styling
- [ ] Report still renders correctly with custom branding

---

## Phase 6: Web Dashboard & API

### Test 6.1 — Server Startup

```bash
npm run web &
sleep 3
curl -s http://localhost:3000/ | head -5
```

**PASS criteria:**
- [ ] Server starts without errors
- [ ] Responds with HTML dashboard
- [ ] No console errors on startup

---

### Test 6.2 — Scan API Workflow

```bash
# Start scan
SCAN_ID=$(curl -s -X POST http://localhost:3000/api/scan \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com","maxPages":1}' | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).scanId))")

echo "Scan ID: $SCAN_ID"

# Wait for completion
sleep 30

# Get results
curl -s http://localhost:3000/api/scan/$SCAN_ID/results | node -e "
process.stdin.on('data', d => {
  const r = JSON.parse(d);
  console.log('Status:', r.status);
  console.log('Score:', r.scores?.overall);
  console.log('Violations:', r.scores?.totalViolations);
});
"
```

**PASS criteria:**
- [ ] POST returns `{scanId: <uuid>}`
- [ ] Results endpoint returns complete data after scan finishes
- [ ] Score and violation count match CLI results for same site

---

### Test 6.3 — Export API

```bash
# Export each format
for fmt in json csv html pdf; do
  STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://localhost:3000/api/scan/$SCAN_ID/export/$fmt)
  echo "$fmt export: HTTP $STATUS"
done
```

**PASS criteria:**
- [ ] All 4 formats return HTTP 200
- [ ] JSON Content-Type: application/json
- [ ] CSV Content-Type: text/csv
- [ ] HTML Content-Type: text/html
- [ ] PDF Content-Type: application/pdf
- [ ] Content-Disposition header has correct filename

---

### Test 6.4 — SSE Progress Stream

```bash
# Start scan and listen to SSE
curl -s -X POST http://localhost:3000/api/scan \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com","maxPages":1}' > /tmp/scan-response.json &

sleep 1
SCAN_ID=$(cat /tmp/scan-response.json | node -e "process.stdin.on('data',d=>console.log(JSON.parse(d).scanId))")

# Listen to SSE for 30s
timeout 30 curl -s -N http://localhost:3000/api/scan/$SCAN_ID/progress 2>&1 | head -30
```

**PASS criteria:**
- [ ] SSE stream delivers events with correct format: `data: {...}`
- [ ] Events include phases: `discovering`, `scanning`, `page-done`, `scoring`, `done`
- [ ] Final `done` event contains complete results
- [ ] Progress percentage increases monotonically

---

### Test 6.5 — Concurrent Scan Limit

```bash
# Start 4 scans simultaneously (limit is 3)
for i in 1 2 3 4; do
  curl -s -X POST http://localhost:3000/api/scan \
    -H "Content-Type: application/json" \
    -d '{"url":"https://example.com","maxPages":1}' &
done
wait
```

**PASS criteria:**
- [ ] First 3 scans accepted (HTTP 200 with scanId)
- [ ] 4th scan rejected with HTTP 429
- [ ] Error message mentions concurrent limit

---

### Test 6.6 — Dashboard UI (Manual Browser Test)

Open `http://localhost:3000` in browser, run a scan of `https://www.w3.org/WAI/demos/bad/before/home.html`:

**PASS criteria:**
- [ ] Scan form accepts URL and starts scan
- [ ] Progress bar shows real-time progress
- [ ] Progress log shows page-by-page updates
- [ ] After completion, dashboard renders with:
  - Score gauge (animated fill)
  - **Score disclaimer**: "Automated scan · ~30-40% of WCAG criteria · Manual testing required"
  - Severity breakdown (4 colored cards)
  - Stats row (pages, violations, passes, elements)
  - **Confidence stats row** (confirmed issues, needs review, confirmed elements, review elements)
  - WCAG principles chart
  - Violations table with **Confidence column** (Confirmed/Likely/Review badges)
  - **Default sort by confidence** (high-confidence issues first)
  - Clicking column headers sorts correctly
  - Expanding violation rows shows detail panel
  - Screenshots with numbered overlays and legend
  - Manual testing checklist with checkboxes
- [ ] Export buttons download files (not open in new tab)
- [ ] All 4 export formats work (JSON, CSV, HTML, PDF)
- [ ] Severity filter buttons filter the table
- [ ] Search box filters violations by keyword

---

### Test 6.7 — Dashboard Export Download Fix

In the browser dashboard after a scan:

**PASS criteria:**
- [ ] Click JSON export → file downloads (not popup, not new tab)
- [ ] Click HTML export → file downloads as .html
- [ ] Click PDF export → file downloads as .pdf
- [ ] Click CSV export → file downloads as .csv
- [ ] Downloaded filenames follow pattern: `{hostname}-ada-report-{YYYY-MM-DD}.{ext}`
- [ ] Files are non-empty and valid

---

## Phase 7: Scoring System Accuracy

### Test 7.1 — Score Ranges

| Site | Expected Score Range | Rationale |
|------|---------------------|-----------|
| example.com | 95-100 | Simple, accessible HTML |
| gov.uk | 75-100 | Government accessibility standards |
| a11yproject.com | 75-100 | Built for accessibility |
| W3C BAD demo | 10-60 | Intentionally broken |
| Deque Mars | 20-70 | Intentional errors |

**PASS criteria:**
- [ ] All scores fall within expected ranges
- [ ] Scores are not all 100 (scanner is finding real issues)
- [ ] Scores are not all 0 (scanner isn't broken)

---

### Test 7.2 — Severity Breakdown Accuracy

Using W3C BAD demo output:

**PASS criteria:**
- [ ] `critical + serious + moderate + minor` = total violation nodes
- [ ] Critical/serious violations are actually severe (missing alt on content images, not decorative)
- [ ] Minor violations are genuinely low-impact

---

### Test 7.3 — Principle Scores

Using any scan output:

```bash
node -e "
const r = require('./reports/<any>.json');
const p = r.scores.byPrinciple;
for (const [name, data] of Object.entries(p)) {
  console.log(name + ': ' + data.score + '/100 (' + data.status + ')');
  console.log('  violations:', data.violations, 'passes:', data.passes, 'review:', data.needsReview);
}
"
```

**PASS criteria:**
- [ ] All 4 principles present (Perceivable, Operable, Understandable, Robust)
- [ ] Scores are 0-100
- [ ] Status is "Good", "Needs Work", or "Critical" matching score range
- [ ] Incomplete (needsReview) NOT counted in score calculation

---

### Test 7.4 — Benchmark Context

```bash
node -e "
const r = require('./reports/<any>.json');
const b = r.scores.benchmarkContext;
console.log('Score:', b.score);
console.log('Label:', b.label);
console.log('Industry avg:', b.industryAverage);
console.log('Position:', b.position);
console.log('Difference:', b.difference);
console.log('Summary:', b.summary);
"
```

**PASS criteria:**
- [ ] Industry average is 34 (WebAIM Million 2025)
- [ ] Position is 'above' or 'below' relative to average
- [ ] Difference = abs(score - industryAverage)
- [ ] Label matches interpretation range
- [ ] Summary is a coherent sentence

---

## Phase 8: Screenshot Quality

### Test 8.1 — Screenshot Content

Using a scan that produces violations (W3C BAD or colourpop):

**PASS criteria:**
- [ ] Screenshots are not blank/gray (images loaded during capture)
- [ ] Screenshots show actual page content (not Cloudflare challenge, not popup overlay)
- [ ] Numbered overlay markers visible on violation elements
- [ ] Overlay colors match severity (red=critical, orange=serious, yellow=moderate, blue=minor)
- [ ] Screenshot dimensions are reasonable (not 0×0)

---

### Test 8.2 — Multi-Region Screenshots

**PASS criteria:**
- [ ] Max 2 regions per viewport (not 5+)
- [ ] Regions prioritized by severity (critical violations shown first)
- [ ] Each region has `base64`, `label`, `violationCount`, `annotations`
- [ ] Annotations array has `index`, `ruleId`, `severity`, `color`, `help`

---

### Test 8.3 — Screenshot Legend in Dashboard

In dashboard after scan with violations:

**PASS criteria:**
- [ ] Legend appears below each screenshot
- [ ] Legend shows numbered markers with severity color
- [ ] Each marker maps to a rule ID and description
- [ ] Colors in legend match overlay colors in screenshot

---

## Phase 9: Edge Cases & Error Handling

### Test 9.1 — Invalid URL

```bash
node src/index.js not-a-url -f json 2>&1
```

**PASS criteria:**
- [ ] Graceful error message (not stack trace)
- [ ] Non-zero exit code

---

### Test 9.2 — Unreachable Site

```bash
node src/index.js https://this-domain-definitely-does-not-exist-12345.com -f json --timeout 15000 2>&1
```

**PASS criteria:**
- [ ] Graceful error message
- [ ] No crash
- [ ] Reasonable timeout (doesn't hang forever)

---

### Test 9.3 — Empty Page

```bash
node src/index.js https://example.com -f json 2>&1
```

**PASS criteria:**
- [ ] Score is 100 (no violations on minimal valid HTML)
- [ ] 0 violations
- [ ] Passes ≥ 5 (basic rules pass: lang, title, etc.)

---

### Test 9.4 — Very Large Page

```bash
node src/index.js https://en.wikipedia.org/wiki/Accessibility -f json --timeout 90000 2>&1
```

**PASS criteria:**
- [ ] Scan completes without OOM or crash
- [ ] Results are reasonable (Wikipedia has some a11y issues but is generally decent)
- [ ] Screenshot captures without error

---

### Test 9.5 — Concurrent Page Scanning

```bash
node src/index.js https://the-internet.herokuapp.com/ -f json --crawl --max-pages 4 --concurrency 2 --timeout 60000 2>&1
```

**PASS criteria:**
- [ ] All pages scanned (no pages skipped)
- [ ] Results consistent with sequential scanning
- [ ] No race conditions or duplicate results

---

### Test 9.6 — axe-config Rule Disabling

```bash
echo '{"disableRules":["color-contrast"]}' > /tmp/axe-config.json
node src/index.js https://colourpop.com/ -f json --axe-config /tmp/axe-config.json --timeout 90000 2>&1
# Then verify no color-contrast violations
node -e "
const r = require('./reports/colourpop*');
const cc = r.scanResult.allViolations.filter(v => v.id === 'color-contrast');
console.log('color-contrast violations:', cc.length);
"
```

**PASS criteria:**
- [ ] `color-contrast` violations count = 0 (rule disabled)
- [ ] Other violations still detected normally
- [ ] Total passes may be fewer (disabled rule not counted)

---

## Phase 10: Real-World Accuracy Validation

> Goal: Scan multiple real sites and manually verify the findings make sense.

### Test 10.1 — E-Commerce Audit (ColourPop)

```bash
node src/index.js https://colourpop.com/ -f all --max-pages 3 --timeout 90000 2>&1
```

Open the HTML report and manually spot-check:

**PASS criteria:**
- [ ] `image-alt` violations reference actual product images missing alt text (not decorative images)
- [ ] `color-contrast` violations (if high confidence) are on text that is genuinely hard to read
- [ ] `link-name` violations reference links that truly have no accessible name
- [ ] Score reflects reality — if the site looks cluttered/inaccessible, score should be low
- [ ] No violation references elements that don't exist on the page
- [ ] Remediation suggestions are actionable and specific

---

### Test 10.2 — Government Site Audit (GOV.UK)

Using output from Test 1.3:

**PASS criteria:**
- [ ] High score reflects the site's genuine commitment to accessibility
- [ ] Any violations found are real issues (not false positives)
- [ ] Low-confidence violations are correctly flagged as needing review
- [ ] Report would be useful to a real auditor

---

### Test 10.3 — Cross-Site Score Comparison

After scanning all test sites, compare scores:

| Site | Score | Makes Sense? |
|------|-------|--------------|
| example.com | ~100 | Yes — minimal HTML |
| gov.uk | 75+ | Yes — government standards |
| a11yproject.com | 75+ | Yes — a11y-focused |
| W3C BAD demo | <60 | Yes — intentionally broken |
| colourpop.com | 20-50 | Yes — typical e-commerce |
| fashionnova.com | 20-50 | Yes — heavy popups/overlays |

**PASS criteria:**
- [ ] Known-good sites score higher than known-bad sites
- [ ] Score ordering matches intuitive accessibility quality
- [ ] No site gets 100 except truly accessible ones
- [ ] No site gets 0 unless completely broken

---

## Phase 11: CLI Flag Combinations

### Test 11.1 — All Flags Together

```bash
node src/index.js https://the-internet.herokuapp.com/ \
  -f all \
  --crawl \
  --interactive \
  --concurrency 2 \
  --max-pages 3 \
  --timeout 60000 \
  --client-name "Test Client" \
  --client-color "#3498db" \
  2>&1
```

**PASS criteria:**
- [ ] No flag conflicts
- [ ] All flags applied correctly
- [ ] Crawl discovers pages
- [ ] Interactive scanning runs
- [ ] Concurrency works
- [ ] Client branding in HTML/PDF reports
- [ ] All 4 report formats generated

---

### Test 11.2 — Exit Codes

```bash
# Should exit 0 (no critical/serious)
node src/index.js https://example.com -f json; echo "Exit: $?"

# Should exit 1 (has critical/serious violations)
node src/index.js https://www.w3.org/WAI/demos/bad/before/home.html -f json --timeout 60000; echo "Exit: $?"
```

**PASS criteria:**
- [ ] example.com exits with code 0
- [ ] W3C BAD exits with code 1 (has serious violations)

---

## Execution Checklist

Run phases in order. Mark each as you go:

- [ ] **Phase 1**: Core Scanning Accuracy (Tests 1.1-1.4)
- [ ] **Phase 2**: Confidence Scoring (Tests 2.1-2.4)
- [ ] **Phase 3**: Scanner Features (Tests 3.1-3.8)
- [ ] **Phase 4**: Crawler & Page Discovery (Tests 4.1-4.4)
- [ ] **Phase 5**: Report Generation (Tests 5.1-5.6)
- [ ] **Phase 6**: Web Dashboard & API (Tests 6.1-6.7)
- [ ] **Phase 7**: Scoring System (Tests 7.1-7.4)
- [ ] **Phase 8**: Screenshot Quality (Tests 8.1-8.3)
- [ ] **Phase 9**: Edge Cases (Tests 9.1-9.6)
- [ ] **Phase 10**: Real-World Accuracy (Tests 10.1-10.3)
- [ ] **Phase 11**: CLI Flag Combinations (Tests 11.1-11.2)

**Total tests: 47**
**Estimated time: 3-4 hours (most time is waiting for scans)**

---

## Bug Report Template

When a test fails, document it:

```
### Bug: [Short Title]
- **Test**: [Test ID, e.g., Test 3.3]
- **Command**: [Exact command run]
- **Expected**: [What should happen]
- **Actual**: [What actually happened]
- **Impact**: [High/Medium/Low]
- **Files**: [Which source files are likely involved]
- **Notes**: [Any additional context]
```
