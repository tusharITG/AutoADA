#!/usr/bin/env node

/**
 * AutoADA — ADA/WCAG Compliance Checker CLI
 * Scan websites for accessibility issues and generate client-ready reports.
 */

const { Command } = require('commander');
const path = require('path');
const fs = require('fs');
const chalk = require('chalk');

const { discoverPages } = require('./crawler');
const { scanAllPages } = require('./scanner');
const { calculateScores } = require('./score');
const { generateJson } = require('./reporters/json');
const { generateCsv } = require('./reporters/csv');
const { generateHtml } = require('./reporters/html');
const { generatePdf } = require('./reporters/pdf');

const packageJson = require('../package.json');

/**
 * Print a rich terminal summary using chalk.
 */
function printSummary(scanResult, scores) {
  const { overall, severityBreakdown, totalViolations, totalPasses, totalViolationNodes } = scores;

  console.log('\n' + chalk.bold('═══════════════════════════════════════════════'));
  console.log(chalk.bold('  ADA/WCAG COMPLIANCE SCAN RESULTS'));
  console.log(chalk.bold('═══════════════════════════════════════════════'));

  // Overall score with color
  const scoreColor = overall >= 80 ? chalk.green : overall >= 50 ? chalk.yellow : chalk.red;
  console.log(`\n  ${chalk.bold('Overall Score:')} ${scoreColor.bold(overall + '/100')} ${scores.benchmarkContext?.label || ''}`);
  console.log(`  ${chalk.dim('Pages scanned:')} ${scanResult.pageCount}`);

  // Severity breakdown table
  console.log(`\n  ${chalk.bold('Severity Breakdown:')}`);
  console.log(`  ${chalk.bgRed.white.bold(' CRITICAL ')} ${severityBreakdown.critical}`);
  console.log(`  ${chalk.bgHex('#ea580c').white.bold(' SERIOUS  ')} ${severityBreakdown.serious}`);
  console.log(`  ${chalk.bgHex('#ca8a04').white.bold(' MODERATE ')} ${severityBreakdown.moderate}`);
  console.log(`  ${chalk.bgBlue.white.bold(' MINOR    ')} ${severityBreakdown.minor}`);

  // Summary stats
  console.log(`\n  ${chalk.bold('Summary:')}`);
  console.log(`  Violations: ${chalk.red(totalViolations)} rules (${chalk.red(totalViolationNodes)} elements)`);
  console.log(`  Passed:     ${chalk.green(totalPasses)} rules`);

  // Top 5 issues
  const topIssues = (scanResult.allViolations || [])
    .sort((a, b) => {
      const order = { critical: 0, serious: 1, moderate: 2, minor: 3 };
      return (order[a.impact] || 3) - (order[b.impact] || 3);
    })
    .slice(0, 5);

  if (topIssues.length > 0) {
    console.log(`\n  ${chalk.bold('Top Issues:')}`);
    for (const issue of topIssues) {
      const badge = issue.impact === 'critical' ? chalk.red('●')
        : issue.impact === 'serious' ? chalk.hex('#ea580c')('●')
        : issue.impact === 'moderate' ? chalk.yellow('●')
        : chalk.blue('●');
      console.log(`  ${badge} ${issue.help} (${issue.nodes?.length || 0} elements)`);
    }
  }

  // Benchmark context
  if (scores.benchmarkContext) {
    console.log(`\n  ${chalk.dim(scores.benchmarkContext.summary)}`);
  }

  console.log('\n' + chalk.bold('═══════════════════════════════════════════════'));
}

/**
 * Read and base64-encode a logo file.
 */
function readLogoAsBase64(logoPath) {
  try {
    const resolved = path.resolve(logoPath);
    const buffer = fs.readFileSync(resolved);
    const ext = path.extname(resolved).toLowerCase();
    const mime = ext === '.svg' ? 'image/svg+xml'
      : ext === '.png' ? 'image/png'
      : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
      : 'image/png';
    return `data:${mime};base64,${buffer.toString('base64')}`;
  } catch (err) {
    console.warn(chalk.yellow(`  Warning: Could not read logo file: ${err.message}`));
    return null;
  }
}

async function main() {
  const program = new Command();

  program
    .name('autoada')
    .description('Scan a website for ADA/WCAG compliance issues and generate reports')
    .version(packageJson.version)
    .argument('<url>', 'Website URL to scan')
    .option('-f, --format <type>', 'Report format: json, csv, html, pdf, all', 'all')
    .option('-o, --output <dir>', 'Output directory', './reports')
    .option('--extra-urls <file>', 'Text file with additional URLs to scan (one per line)')
    .option('--client-name <name>', 'Client name for report branding')
    .option('--client-logo <path>', 'Path to client logo image (PNG/SVG)')
    .option('--client-color <hex>', 'Client accent color hex code')
    .option('-t, --tags <tags>', 'WCAG tags, comma-separated', 'wcag2a,wcag2aa,wcag21a,wcag21aa,wcag22aa')
    .option('--timeout <ms>', 'Page load timeout in milliseconds', '30000')
    .option('--max-pages <n>', 'Maximum pages to scan', '100')
    .option('--crawl', 'Enable link-based page crawling with robots.txt respect', false)
    .option('--interactive', 'Scan interactive states (accordions, tabs, details)', false)
    .option('--concurrency <n>', 'Number of pages to scan concurrently', '1')
    .option('--axe-config <path>', 'Path to axe-core config JSON (disableRules, include, exclude)')
    .parse();

  const url = program.args[0];
  const opts = program.opts();

  // Validate URL
  try {
    new URL(url);
  } catch {
    console.error(chalk.red(`Error: Invalid URL "${url}". Please provide a valid URL including the protocol (e.g., https://example.com)`));
    process.exit(1);
  }

  // Validate client color
  if (opts.clientColor && !/^#[0-9a-fA-F]{3,6}$/.test(opts.clientColor)) {
    console.error(chalk.red(`Error: Invalid hex color "${opts.clientColor}". Use format like #ff6600`));
    process.exit(1);
  }

  const tags = opts.tags.split(',').map((t) => t.trim());
  const timeout = parseInt(opts.timeout, 10);
  const maxPages = parseInt(opts.maxPages, 10);
  const concurrency = Math.max(1, parseInt(opts.concurrency, 10) || 1);

  // Load optional axe-core configuration
  let axeConfig = {};
  if (opts.axeConfig) {
    try {
      const configPath = path.resolve(opts.axeConfig);
      const raw = fs.readFileSync(configPath, 'utf-8');
      axeConfig = JSON.parse(raw);
      console.log(`  axe-core config: ${configPath}`);
    } catch (err) {
      console.error(chalk.red(`Error reading axe-config file: ${err.message}`));
      process.exit(1);
    }
  }

  console.log(chalk.bold('\n🔍 AutoADA — ADA/WCAG Compliance Scanner\n'));
  console.log(`  Target: ${chalk.cyan(url)}`);
  console.log(`  Standard: WCAG 2.2 Level AA`);
  console.log(`  Viewports: Desktop (1280px) + Mobile (375px)`);
  if (opts.clientName) console.log(`  Client: ${opts.clientName}`);

  // --- Step 1: Discover pages ---
  console.log(chalk.bold('\n📄 Discovering pages...'));
  let pages;
  try {
    pages = await discoverPages(url, opts.extraUrls, maxPages, { enabled: opts.crawl });
  } catch (err) {
    console.error(chalk.red(`Error discovering pages: ${err.message}`));
    console.log(chalk.yellow('  Falling back to scanning only the provided URL.'));
    pages = [url];
  }

  // --- Step 2: Scan all pages ---
  console.log(chalk.bold(`\n🔎 Scanning ${pages.length} page(s)...`));
  let scanResult;
  try {
    scanResult = await scanAllPages(pages, { tags, timeout, interactive: opts.interactive, concurrency, axeConfig });
  } catch (err) {
    console.error(chalk.red(`\nFatal error during scanning: ${err.message}`));
    console.error(chalk.dim('  This might be a Puppeteer/Chrome issue. Ensure Chrome or Chromium is installed.'));
    console.error(chalk.dim('  You can also try setting PUPPETEER_EXECUTABLE_PATH to your Chrome binary path.'));
    process.exit(1);
  }

  // --- Step 3: Calculate scores ---
  console.log(chalk.bold('\n📊 Calculating scores...'));
  const scores = calculateScores(scanResult);

  // Print terminal summary
  printSummary(scanResult, scores);

  // --- Step 4: Generate reports ---
  const formats = opts.format === 'all'
    ? ['json', 'csv', 'html', 'pdf']
    : [opts.format];

  const outputDir = path.resolve(opts.output);
  fs.mkdirSync(outputDir, { recursive: true });

  const hostname = new URL(url).hostname.replace(/[^a-z0-9]/gi, '-');
  const dateStr = new Date().toISOString().slice(0, 10);
  const baseName = `${hostname}-ada-report-${dateStr}`;

  // Prepare branding options
  const brandingOptions = {
    clientName: opts.clientName || null,
    clientLogoBase64: opts.clientLogo ? readLogoAsBase64(opts.clientLogo) : null,
    clientColor: opts.clientColor || null,
  };

  console.log(chalk.bold('\n📝 Generating reports...'));

  let htmlContent = null;

  for (const fmt of formats) {
    const filePath = path.join(outputDir, `${baseName}.${fmt}`);

    try {
      switch (fmt) {
        case 'json': {
          const content = generateJson(scanResult, scores);
          fs.writeFileSync(filePath, content, 'utf-8');
          break;
        }
        case 'csv': {
          const content = generateCsv(scanResult);
          fs.writeFileSync(filePath, content, 'utf-8');
          break;
        }
        case 'html': {
          htmlContent = generateHtml(scanResult, scores, brandingOptions);
          fs.writeFileSync(filePath, htmlContent, 'utf-8');
          break;
        }
        case 'pdf': {
          // Generate HTML first if not already done
          if (!htmlContent) {
            htmlContent = generateHtml(scanResult, scores, brandingOptions);
          }
          const pdfBuffer = await generatePdf(htmlContent);
          fs.writeFileSync(filePath, pdfBuffer);
          break;
        }
        default:
          console.warn(chalk.yellow(`  Unknown format: ${fmt}`));
          continue;
      }
      console.log(`  ${chalk.green('✓')} ${fmt.toUpperCase()}: ${filePath}`);
    } catch (err) {
      console.error(chalk.red(`  ✗ ${fmt.toUpperCase()} generation failed: ${err.message}`));
    }
  }

  // --- Exit code ---
  const hasCriticalOrSerious = scores.severityBreakdown.critical > 0 || scores.severityBreakdown.serious > 0;
  console.log(chalk.bold('\n✅ Scan complete.\n'));

  if (hasCriticalOrSerious) {
    process.exit(1);
  } else {
    process.exit(0);
  }
}

main().catch((err) => {
  console.error(chalk.red(`\nUnexpected error: ${err.message}`));
  console.error(chalk.dim(err.stack));
  process.exit(1);
});
