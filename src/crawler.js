const https = require('https');
const http = require('http');
const { URL } = require('url');

// Browser-like headers to avoid bot detection (Cloudflare, etc.)
const BROWSER_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language': 'en-US,en;q=0.9',
};

/**
 * Fetch a URL and return the response body as a string.
 * Uses browser-like headers to avoid bot detection.
 */
function fetchUrl(url, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const client = parsedUrl.protocol === 'https:' ? https : http;

    const req = client.get(url, { timeout, headers: BROWSER_HEADERS }, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        const redirectUrl = new URL(res.headers.location, url).href;
        fetchUrl(redirectUrl, timeout).then(resolve).catch(reject);
        return;
      }

      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        return;
      }

      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve(data));
      res.on('error', reject);
    });

    req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout fetching ${url}`)); });
    req.on('error', reject);
  });
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
 * Fetch and parse a sitemap, recursively handling sitemap indexes.
 * Returns an array of page URLs.
 */
async function parseSitemap(sitemapUrl, maxPages) {
  const pageUrls = [];

  try {
    const xml = await fetchUrl(sitemapUrl);

    if (isSitemapIndex(xml)) {
      // This is an index — extract child sitemap URLs and fetch each
      const childSitemapUrls = extractUrlsFromSitemap(xml);
      for (const childUrl of childSitemapUrls) {
        if (pageUrls.length >= maxPages) break;
        try {
          const childXml = await fetchUrl(childUrl);
          const childPages = extractUrlsFromSitemap(childXml);
          for (const page of childPages) {
            if (pageUrls.length >= maxPages) break;
            pageUrls.push(page);
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
        pageUrls.push(url);
      }
    }
  } catch (err) {
    console.warn(`  Warning: Could not fetch sitemap at ${sitemapUrl}: ${err.message}`);
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
 * Crawl links from a starting URL using HTTP-based BFS.
 * Uses lightweight HTTP requests (no Puppeteer) for speed and reliability.
 * Works through Cloudflare and other bot-detection systems that block headless browsers.
 * Same-domain only, respects robots.txt disallowed paths.
 *
 * @param {string} startUrl - URL to start crawling from
 * @param {number} maxPages - Maximum pages to discover
 * @param {string[]} disallowedPaths - Paths disallowed by robots.txt
 * @returns {Promise<string[]>} Discovered URLs
 */
async function crawlLinks(startUrl, maxPages, disallowedPaths = []) {
  const parsedBase = new URL(startUrl);
  const baseDomain = parsedBase.hostname;

  const visited = new Set();
  const discovered = [];
  const queue = [startUrl];

  // Normalize URL for dedup
  function normalize(url) {
    try {
      const parsed = new URL(url);
      return `${parsed.origin}${parsed.pathname.replace(/\/$/, '')}${parsed.search}`;
    } catch {
      return null;
    }
  }

  // BFS: crawl depth-first from start page, then follow links up to 2 levels deep
  const MAX_CRAWL_DEPTH = 2;
  const depthMap = new Map();
  depthMap.set(normalize(startUrl), 0);

  while (queue.length > 0 && discovered.length < maxPages) {
    const currentUrl = queue.shift();
    const normalized = normalize(currentUrl);
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

          const norm = normalize(link);
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
async function discoverPages(baseUrl, extraUrlsFile, maxPages = 100, crawlOptions = {}) {
  const parsedBase = new URL(baseUrl);
  const baseDomain = parsedBase.hostname;

  // Always include the base URL itself
  const allUrls = [baseUrl];

  // 1. Try sitemap.xml
  const sitemapUrl = `${parsedBase.origin}/sitemap.xml`;
  console.log(`  Fetching sitemap: ${sitemapUrl}`);
  const sitemapUrls = await parseSitemap(sitemapUrl, maxPages);
  console.log(`  Found ${sitemapUrls.length} URLs in sitemap`);
  allUrls.push(...sitemapUrls);

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

  // 3. Link-based crawling
  // Auto-enable when sitemap found 0 pages (site has no sitemap or blocks it)
  const shouldCrawl = crawlOptions.enabled || sitemapUrls.length === 0;
  if (shouldCrawl) {
    if (!crawlOptions.enabled && sitemapUrls.length === 0) {
      console.log(`  No sitemap found — auto-crawling links to discover pages...`);
    } else {
      console.log(`  Link-based crawling enabled...`);
    }
    const disallowedPaths = await parseRobotsTxt(baseUrl);
    const crawledUrls = await crawlLinks(baseUrl, maxPages, disallowedPaths);
    allUrls.push(...crawledUrls);
  }

  // 4. Deduplicate and enforce same-domain
  const seen = new Set();
  const deduplicated = [];

  for (const url of allUrls) {
    try {
      const parsed = new URL(url);
      // Normalize: remove trailing slash, lowercase hostname
      const normalized = `${parsed.origin}${parsed.pathname.replace(/\/$/, '')}${parsed.search}`;

      if (parsed.hostname !== baseDomain) continue; // Same-domain only
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      deduplicated.push(url);

      if (deduplicated.length >= maxPages) break;
    } catch {
      // Skip invalid URLs
    }
  }

  console.log(`  Total unique pages to scan: ${deduplicated.length}`);
  return deduplicated;
}

module.exports = { discoverPages };
