const https = require('https');
const http = require('http');
const { URL } = require('url');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());

// Browser-like headers to avoid bot detection (Cloudflare, etc.)
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

/** @const {number} Maximum number of HTTP redirects before aborting */
const MAX_REDIRECTS = 5;

/** @const {number} Maximum response body size in bytes (5 MB) */
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

/** @const {string[]} Tracking query parameters to strip during URL normalization */
const TRACKING_PARAMS = [
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'fbclid', 'gclid', 'gclsrc', 'dclid', 'msclkid',
  'ref', '_ga', '_gl', 'mc_cid', 'mc_eid',
];

/**
 * Fetch a URL and return the response body as a string.
 * Uses browser-like headers to avoid bot detection.
 * Follows up to MAX_REDIRECTS redirects and enforces MAX_RESPONSE_BYTES size limit.
 *
 * @param {string} url - URL to fetch
 * @param {number} [timeout=15000] - Request timeout in ms
 * @param {number} [_redirectCount=0] - Internal redirect counter (do not set manually)
 */
function fetchUrl(url, timeout = 15000, _redirectCount = 0) {
  return new Promise((resolve, reject) => {
    if (_redirectCount > MAX_REDIRECTS) {
      reject(new Error(`Too many redirects (>${MAX_REDIRECTS}) for ${url}`));
      return;
    }

    const parsedUrl = new URL(url);
    const client = parsedUrl.protocol === 'https:' ? https : http;

    const req = client.get(url, { timeout, headers: BROWSER_HEADERS }, (res) => {
      // Follow redirects with counter
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = new URL(res.headers.location, url).href;
        fetchUrl(redirectUrl, timeout, _redirectCount + 1).then(resolve).catch(reject);
        return;
      }

      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }

      let data = '';
      let byteLen = 0;
      res.on('data', (chunk) => {
        byteLen += Buffer.byteLength(chunk);
        if (byteLen > MAX_RESPONSE_BYTES) {
          res.destroy();
          reject(new Error(`Response too large (>${MAX_RESPONSE_BYTES} bytes) for ${url}`));
          return;
        }
        data += chunk;
      });
      res.on('end', () => resolve(data));
      res.on('error', reject);
    });

    req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout fetching ${url}`)); });
    req.on('error', reject);
  });
}

/**
 * Normalize a URL for deduplication: strips tracking parameters, trailing slashes,
 * and lowercases the hostname. Preserves meaningful params (page, q, search, etc.).
 *
 * @param {string} url - URL to normalize
 * @returns {string|null} Normalized URL or null if invalid
 */
function normalizeUrl(url) {
  try {
    const parsed = new URL(url);
    // Strip tracking parameters
    for (const param of TRACKING_PARAMS) {
      parsed.searchParams.delete(param);
    }
    // Remove trailing slash from pathname
    const pathname = parsed.pathname.replace(/\/$/, '') || '/';
    const search = parsed.searchParams.toString();
    return `${parsed.origin}${pathname}${search ? '?' + search : ''}`;
  } catch {
    return null;
  }
}

/**
 * Parse a sitemap XML string and extract all <loc> URLs.
 * Handles both <urlset> (regular sitemap) and <sitemapindex> (index of sitemaps).
 */
function extractUrlsFromSitemap(xml) {
  const urls = [];
  // Match all <loc>...</loc> entries
  const locRegex = /<loc>\s*(.*?)\s*<\/loc>/gi;
  let match;
  while ((match = locRegex.exec(xml)) !== null) {
    urls.push(match[1].trim());
  }
  return urls;
}

/**
 * Check if the XML is a sitemap index (contains <sitemapindex>).
 */
function isSitemapIndex(xml) {
  return /<sitemapindex/i.test(xml);
}

/**
 * Check if a URL belongs to the same domain as the sitemap.
 * Skips cross-domain URLs that may appear in shared sitemaps.
 */
function isSameDomain(url, baseDomain) {
  try {
    return new URL(url).hostname === baseDomain;
  } catch {
    return false;
  }
}

/**
 * Fetch and parse a sitemap, recursively handling sitemap indexes.
 * Validates all URLs are same-domain — skips cross-domain entries.
 * Returns an array of page URLs.
 */
async function parseSitemap(sitemapUrl, maxPages) {
  const pageUrls = [];
  let baseDomain;
  try {
    baseDomain = new URL(sitemapUrl).hostname;
  } catch {
    return pageUrls;
  }
  let crossDomainSkipped = 0;

  try {
    const xml = await fetchUrl(sitemapUrl);

    if (isSitemapIndex(xml)) {
      // This is an index — fetch ALL child sitemaps to ensure page type diversity
      // (smart dedup later will reduce to maxPerType samples per pattern)
      const childSitemapUrls = extractUrlsFromSitemap(xml);
      // Hard cap to prevent fetching thousands of child sitemaps
      const MAX_CHILD_SITEMAPS = 20;
      const childrenToFetch = childSitemapUrls.slice(0, MAX_CHILD_SITEMAPS);

      for (const childUrl of childrenToFetch) {
        try {
          const childXml = await fetchUrl(childUrl);
          const childPages = extractUrlsFromSitemap(childXml);
          // Take a sample from each child (first 50) to keep memory reasonable
          // while ensuring all page types are represented
          const SAMPLE_PER_CHILD = 50;
          for (let i = 0; i < childPages.length && i < SAMPLE_PER_CHILD; i++) {
            if (isSameDomain(childPages[i], baseDomain)) {
              pageUrls.push(childPages[i]);
            } else {
              crossDomainSkipped++;
            }
          }
        } catch (err) {
          console.warn(`  Warning: Could not fetch child sitemap ${childUrl}: ${err.message}`);
        }
      }
    } else {
      // Regular sitemap — extract page URLs directly
      const urls = extractUrlsFromSitemap(xml);
      for (const url of urls) {
        if (pageUrls.length >= maxPages) break;
        if (isSameDomain(url, baseDomain)) {
          pageUrls.push(url);
        } else {
          crossDomainSkipped++;
        }
      }
    }
  } catch (err) {
    console.warn(`  Warning: Could not fetch sitemap at ${sitemapUrl}: ${err.message}`);
  }

  if (crossDomainSkipped > 0) {
    console.log(`  [sitemap] Skipped ${crossDomainSkipped} cross-domain URL(s)`);
  }

  return pageUrls;
}

/**
 * Read extra URLs from a text file (one URL per line).
 * Skips empty lines and lines starting with #.
 */
function readExtraUrls(filePath) {
  const fs = require('fs');
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    return content
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
  } catch (err) {
    console.warn(`  Warning: Could not read extra URLs file ${filePath}: ${err.message}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// robots.txt parsing
// ---------------------------------------------------------------------------

/**
 * Fetch and parse /robots.txt, extracting Disallow patterns for *.
 * Returns an array of disallowed path prefixes.
 */
async function parseRobotsTxt(baseUrl) {
  const parsedBase = new URL(baseUrl);
  const robotsUrl = `${parsedBase.origin}/robots.txt`;

  try {
    const text = await fetchUrl(robotsUrl);
    const lines = text.split('\n').map((l) => l.trim());

    const disallowed = [];
    let inWildcardAgent = false;

    for (const line of lines) {
      // Skip comments
      if (line.startsWith('#') || line === '') continue;

      const lower = line.toLowerCase();
      if (lower.startsWith('user-agent:')) {
        const agent = line.slice('user-agent:'.length).trim();
        inWildcardAgent = agent === '*';
        continue;
      }

      if (inWildcardAgent && lower.startsWith('disallow:')) {
        const path = line.slice('disallow:'.length).trim();
        if (path) {
          disallowed.push(path);
        }
      }
    }

    if (disallowed.length > 0) {
      console.log(`  [robots.txt] Found ${disallowed.length} disallowed path(s)`);
    }
    return disallowed;
  } catch (err) {
    console.warn(`  Warning: Could not fetch robots.txt: ${err.message}`);
    return [];
  }
}

/**
 * Check if a URL path is disallowed by robots.txt rules.
 */
function isDisallowed(urlPath, disallowedPaths) {
  for (const pattern of disallowedPaths) {
    // Simple prefix match (handles most robots.txt patterns)
    if (pattern.endsWith('*')) {
      if (urlPath.startsWith(pattern.slice(0, -1))) return true;
    } else if (pattern.endsWith('$')) {
      if (urlPath === pattern.slice(0, -1)) return true;
    } else {
      if (urlPath.startsWith(pattern)) return true;
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// Link-based crawling (BFS via HTTP — no Puppeteer needed)
// ---------------------------------------------------------------------------

/**
 * Extract internal links from raw HTML.
 * Parses href attributes and resolves relative URLs.
 *
 * @param {string} html - Raw HTML content
 * @param {string} pageUrl - URL of the page (for resolving relative links)
 * @param {string} baseDomain - Only return links on this domain
 * @returns {string[]} Array of absolute same-domain URLs
 */
function extractLinksFromHtml(html, pageUrl, baseDomain) {
  const links = [];
  const hrefRegex = /href=["']([^"'#]+)["']/gi;
  let match;

  while ((match = hrefRegex.exec(html)) !== null) {
    try {
      const resolved = new URL(match[1], pageUrl).href;
      const parsed = new URL(resolved);
      if (parsed.hostname === baseDomain && parsed.protocol.startsWith('http')) {
        links.push(resolved);
      }
    } catch {
      // Skip invalid URLs
    }
  }

  return links;
}

// Skip non-page extensions
const SKIP_EXTENSIONS = /\.(pdf|zip|tar|gz|jpg|jpeg|png|gif|svg|webp|ico|mp3|mp4|avi|mov|doc|docx|xls|xlsx|ppt|pptx|css|js|xml|json|woff|woff2|ttf|eot)$/i;

/**
 * Extract same-domain links from a rendered Puppeteer page.
 * Evaluates the DOM after JavaScript execution — works for SPAs (React, Angular, Vue, etc.).
 *
 * @param {import('puppeteer').Page} page - Puppeteer page (already navigated)
 * @param {string} baseDomain - Only return links on this domain
 * @returns {Promise<string[]>} Array of absolute same-domain URLs
 */
async function extractLinksFromPage(page, baseDomain) {
  return page.evaluate((domain) => {
    const links = [];
    document.querySelectorAll('a[href]').forEach(a => {
      try {
        const url = new URL(a.href, window.location.origin);
        if (url.hostname === domain && url.protocol.startsWith('http')) {
          links.push(url.href.split('#')[0]); // Strip hash
        }
      } catch { /* skip invalid */ }
    });
    return [...new Set(links)];
  }, baseDomain);
}

/**
 * Crawl links using a real browser (Puppeteer) for JavaScript-rendered sites (SPAs).
 * BFS: visits pages, renders them, extracts links from the live DOM.
 * Slower than HTTP-based crawling but works on Angular/React/Vue/Next.js sites.
 *
 * @param {string} startUrl - URL to start crawling from
 * @param {number} maxPages - Maximum pages to discover
 * @param {string[]} disallowedPaths - Paths disallowed by robots.txt
 * @param {number} maxDepth - Maximum BFS depth
 * @returns {Promise<string[]>} Discovered URLs
 */
async function crawlLinksWithBrowser(startUrl, maxPages, disallowedPaths = [], maxDepth = 3, onPageFound = null) {
  const parsedBase = new URL(startUrl);
  const baseDomain = parsedBase.hostname;

  const visited = new Set();
  const discovered = [];
  const queue = [startUrl];
  const depthMap = new Map();
  depthMap.set(normalizeUrl(startUrl), 0);

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
    });

    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
    // Block heavy resources to speed up crawling
    await page.setRequestInterception(true);
    page.on('request', req => {
      const type = req.resourceType();
      if (['image', 'font', 'media', 'stylesheet'].includes(type)) req.abort();
      else req.continue();
    });

    while (queue.length > 0 && discovered.length < maxPages) {
      const currentUrl = queue.shift();
      const normalized = normalizeUrl(currentUrl);
      if (!normalized || visited.has(normalized)) continue;
      visited.add(normalized);

      const currentDepth = depthMap.get(normalized) || 0;

      // Check robots.txt
      try {
        const urlPath = new URL(currentUrl).pathname;
        if (isDisallowed(urlPath, disallowedPaths)) continue;
      } catch { continue; }

      // Skip non-page extensions
      try {
        if (SKIP_EXTENSIONS.test(new URL(currentUrl).pathname)) continue;
      } catch { continue; }

      discovered.push(currentUrl);
      if (onPageFound) onPageFound({ url: currentUrl, depth: currentDepth, total: discovered.length, source: 'browser' });
      if (discovered.length >= maxPages) break;

      // Only follow links if within depth limit
      if (currentDepth >= maxDepth) continue;

      // Navigate and extract links from rendered DOM
      try {
        await page.goto(currentUrl, { waitUntil: 'networkidle2', timeout: 15000 });
        // Wait a bit for SPA routers to settle
        await new Promise(r => setTimeout(r, 1000));

        const links = await extractLinksFromPage(page, baseDomain);
        console.log(`  [browser-crawl] ${currentUrl} → ${links.length} links`);

        for (const link of links) {
          try {
            const parsed = new URL(link);
            if (SKIP_EXTENSIONS.test(parsed.pathname)) continue;
            const norm = normalizeUrl(link);
            if (norm && !visited.has(norm)) {
              queue.push(link);
              if (!depthMap.has(norm)) depthMap.set(norm, currentDepth + 1);
            }
          } catch { /* skip */ }
        }
      } catch (err) {
        console.warn(`  [browser-crawl] Could not load ${currentUrl}: ${err.message}`);
      }
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  console.log(`  [browser-crawl] Discovered ${discovered.length} page(s) total`);
  return discovered;
}

/**
 * Crawl links from a starting URL using HTTP-based BFS.
 * Automatically falls back to browser-based crawling for SPAs that return few links.
 * Same-domain only, respects robots.txt disallowed paths.
 *
 * @param {string} startUrl - URL to start crawling from
 * @param {number} maxPages - Maximum pages to discover
 * @param {string[]} disallowedPaths - Paths disallowed by robots.txt
 * @returns {Promise<string[]>} Discovered URLs
 */
async function crawlLinks(startUrl, maxPages, disallowedPaths = [], onPageFound = null) {
  const parsedBase = new URL(startUrl);
  const baseDomain = parsedBase.hostname;

  const visited = new Set();
  const discovered = [];
  const queue = [startUrl];

  // BFS: crawl from start page, follow links up to 3 levels deep
  const MAX_CRAWL_DEPTH = 3;
  const depthMap = new Map();
  depthMap.set(normalizeUrl(startUrl), 0);

  while (queue.length > 0 && discovered.length < maxPages) {
    const currentUrl = queue.shift();
    const normalized = normalizeUrl(currentUrl);
    if (!normalized || visited.has(normalized)) continue;
    visited.add(normalized);

    const currentDepth = depthMap.get(normalized) || 0;

    // Check robots.txt
    try {
      const urlPath = new URL(currentUrl).pathname;
      if (isDisallowed(urlPath, disallowedPaths)) {
        console.log(`  [crawl] Skipping disallowed: ${urlPath}`);
        continue;
      }
    } catch {
      continue;
    }

    // Skip non-page extensions
    try {
      if (SKIP_EXTENSIONS.test(new URL(currentUrl).pathname)) continue;
    } catch {
      continue;
    }

    discovered.push(currentUrl);
    if (onPageFound) onPageFound({ url: currentUrl, depth: currentDepth, total: discovered.length, source: 'http' });
    if (discovered.length >= maxPages) break;

    // Only follow links if within depth limit
    if (currentDepth >= MAX_CRAWL_DEPTH) continue;

    // Fetch page HTML and extract links
    try {
      const html = await fetchUrl(currentUrl, 10000);

      const links = extractLinksFromHtml(html, currentUrl, baseDomain);

      for (const link of links) {
        try {
          const parsed = new URL(link);
          if (SKIP_EXTENSIONS.test(parsed.pathname)) continue;

          const norm = normalizeUrl(link);
          if (norm && !visited.has(norm)) {
            queue.push(link);
            if (!depthMap.has(norm)) {
              depthMap.set(norm, currentDepth + 1);
            }
          }
        } catch {
          // Skip invalid URLs
        }
      }
    } catch (err) {
      console.warn(`  [crawl] Could not fetch ${currentUrl}: ${err.message}`);
    }
  }

  console.log(`  [crawl] Discovered ${discovered.length} page(s) via link crawling`);
  return discovered;
}

// ---------------------------------------------------------------------------
// Smart page-type deduplication
// ---------------------------------------------------------------------------

/**
 * Classify a URL into a "page type" pattern by replacing dynamic path segments
 * (numeric IDs, slugs, hashes) with a placeholder.
 * E.g., /products/dirty-hinoki → /products/:slug
 *       /collections/all      → /collections/:slug
 *       /blogs/journal/post-1 → /blogs/:slug/:slug
 *       /                     → /
 *       /pages/about          → /pages/:slug
 */
function getPageTypePattern(url) {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split('/').filter(Boolean);
    if (segments.length === 0) return '/';

    // First segment is usually the "type" (products, collections, blogs, pages, etc.)
    // Subsequent segments are typically dynamic (product slug, collection name, etc.)
    const pattern = segments.map((seg, i) => {
      if (i === 0) return seg; // Keep the top-level type
      // If it looks like a fixed structural segment (short, common names), keep it
      const fixedSegments = ['all', 'new', 'featured', 'sale', 'tag', 'tagged', 'page', 'category', 'archive'];
      if (fixedSegments.includes(seg.toLowerCase())) return seg;
      return ':slug';
    });

    return '/' + pattern.join('/');
  } catch {
    return url;
  }
}

/**
 * Reduce URLs by limiting pages per URL type pattern.
 * Pages that don't match any pattern (unique paths) are always kept.
 * E.g., if maxPerType=3 and there are 200 /products/* URLs, keep only 3.
 *
 * @param {string[]} urls - Deduplicated URL list
 * @param {number} maxPerType - Max pages to keep per URL pattern
 * @returns {string[]} Reduced URL list preserving variety
 */
function deduplicateByPageType(urls, maxPerType = 3) {
  const typeCounts = new Map();
  const result = [];

  for (const url of urls) {
    const pattern = getPageTypePattern(url);
    const count = typeCounts.get(pattern) || 0;

    if (count < maxPerType) {
      result.push(url);
      typeCounts.set(pattern, count + 1);
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// Main page discovery
// ---------------------------------------------------------------------------

/**
 * Discover all pages to scan.
 *
 * Strategy:
 * 1. Fetch and parse sitemap.xml
 * 2. Read extra URLs from --extra-urls file
 * 3. (Optional) Crawl links from the base URL (--crawl)
 * 4. Deduplicate, enforce same-domain, respect maxPages
 *
 * @param {string} baseUrl - The website base URL
 * @param {string|null} extraUrlsFile - Path to text file with additional URLs
 * @param {number} maxPages - Maximum pages to scan
 * @param {object} [crawlOptions] - Crawl options
 * @param {boolean} [crawlOptions.enabled=false] - Enable link crawling
 * @returns {Promise<string[]>} Array of deduplicated URLs
 */
async function discoverPages(baseUrl, extraUrlsFile, maxPages = 100, crawlOptions = {}, onProgress = null) {
  const parsedBase = new URL(baseUrl);
  const baseDomain = parsedBase.hostname;
  const emit = onProgress || (() => {});

  // Emit SSL status
  emit({ phase: 'ssl-status', isHttps: parsedBase.protocol === 'https:' });

  // Always include the base URL itself
  const allUrls = [baseUrl];

  // 1. Try sitemap.xml
  const sitemapUrl = `${parsedBase.origin}/sitemap.xml`;
  console.log(`  Fetching sitemap: ${sitemapUrl}`);
  const sitemapUrls = await parseSitemap(sitemapUrl, maxPages);
  console.log(`  Found ${sitemapUrls.length} URLs in sitemap`);
  allUrls.push(...sitemapUrls);
  emit({ phase: 'sitemap-status', found: sitemapUrls.length > 0, count: sitemapUrls.length });

  // 2. Read extra URLs file
  if (extraUrlsFile) {
    const extraUrls = readExtraUrls(extraUrlsFile);
    // Resolve relative paths against base URL
    const resolvedExtra = extraUrls.map((u) => {
      try {
        return new URL(u, baseUrl).href;
      } catch {
        return null;
      }
    }).filter(Boolean);
    console.log(`  Found ${resolvedExtra.length} extra URLs from file`);
    allUrls.push(...resolvedExtra);
  }

  // 3. Fetch robots.txt once (used for both crawling and status event)
  let disallowedPaths = [];
  try {
    disallowedPaths = await parseRobotsTxt(baseUrl);
  } catch {
    // robots.txt unavailable — continue without restrictions
  }
  emit({ phase: 'robots-status', found: disallowedPaths.length > 0 });

  // 4. Link-based crawling
  // Auto-enable when sitemap found 0 pages (site has no sitemap or blocks it)
  const shouldCrawl = crawlOptions.enabled || sitemapUrls.length === 0;
  if (shouldCrawl) {
    if (!crawlOptions.enabled && sitemapUrls.length === 0) {
      console.log(`  No sitemap found — auto-crawling links to discover pages...`);
    } else {
      console.log(`  Link-based crawling enabled...`);
    }
    const crawledUrls = await crawlLinks(baseUrl, maxPages, disallowedPaths);
    allUrls.push(...crawledUrls);
  }

  // 5. Deduplicate and enforce same-domain (strips tracking params like utm_*, fbclid, gclid)
  const seen = new Set();
  const deduplicated = [];

  for (const url of allUrls) {
    try {
      const parsed = new URL(url);
      if (parsed.hostname !== baseDomain) continue; // Same-domain only
      const normalized = normalizeUrl(url);
      if (!normalized || seen.has(normalized)) continue;
      seen.add(normalized);
      deduplicated.push(url);
    } catch {
      // Skip invalid URLs
    }
  }

  // 6. Smart page-type deduplication — limit similar URL patterns to MAX_PER_TYPE samples
  // Applied BEFORE maxPages cap so all page types get representation
  // E.g., /products/x, /products/y, /products/z → only scan 3 of them
  const MAX_PER_TYPE = 3;
  const smartDeduped = deduplicateByPageType(deduplicated, MAX_PER_TYPE);

  if (smartDeduped.length < deduplicated.length) {
    // Log pattern breakdown for transparency
    const patternCounts = new Map();
    for (const url of deduplicated) {
      const p = getPageTypePattern(url);
      patternCounts.set(p, (patternCounts.get(p) || 0) + 1);
    }
    const breakdown = [...patternCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([p, c]) => `${p}(${c})`)
      .join(', ');
    console.log(`  [smart-dedup] Reduced from ${deduplicated.length} → ${smartDeduped.length} pages (max ${MAX_PER_TYPE} per URL pattern)`);
    console.log(`  [smart-dedup] Pattern breakdown: ${breakdown}`);
  }

  // 7. Enforce maxPages cap after type dedup
  const finalPages = smartDeduped.slice(0, maxPages);

  console.log(`  Total unique pages to scan: ${finalPages.length}`);
  return finalPages;
}

module.exports = { discoverPages, crawlLinks, crawlLinksWithBrowser, parseRobotsTxt };
