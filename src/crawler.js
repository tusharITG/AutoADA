const https = require('https');
const http = require('http');
const { URL } = require('url');

/**
 * Fetch a URL and return the response body as a string.
 */
function fetchUrl(url, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const client = parsedUrl.protocol === 'https:' ? https : http;

    const req = client.get(url, { timeout }, (res) => {
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

/**
 * Discover all pages to scan.
 *
 * Strategy:
 * 1. Fetch and parse sitemap.xml
 * 2. Read extra URLs from --extra-urls file
 * 3. Deduplicate, enforce same-domain, respect maxPages
 *
 * @param {string} baseUrl - The website base URL
 * @param {string|null} extraUrlsFile - Path to text file with additional URLs
 * @param {number} maxPages - Maximum pages to scan
 * @returns {Promise<string[]>} Array of deduplicated URLs
 */
async function discoverPages(baseUrl, extraUrlsFile, maxPages = 100) {
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

  // 3. Deduplicate and enforce same-domain
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
