/**
 * PDF reporter — generates PDF from the HTML report using Puppeteer.
 */

const puppeteer = require('puppeteer');

const PDF_OVERALL_TIMEOUT_MS = 90000; // 90s hard timeout for entire PDF generation

/**
 * Generate a PDF buffer from HTML content.
 *
 * @param {string} htmlContent - Complete HTML report string
 * @returns {Promise<Buffer>} PDF file buffer
 */
async function generatePdf(htmlContent) {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    timeout: 30000,
  });

  try {
    const pdfPromise = (async () => {
      const page = await browser.newPage();

      await page.setContent(htmlContent, {
        waitUntil: 'networkidle0',
        timeout: 60000,
      });

      // Wait for any base64 images to render
      await new Promise((r) => setTimeout(r, 1000));

      const pdfBuffer = await page.pdf({
        format: 'A4',
        printBackground: true,
        margin: {
          top: '1.5cm',
          bottom: '1.5cm',
          left: '1cm',
          right: '1cm',
        },
        displayHeaderFooter: true,
        headerTemplate: '<div></div>',
        footerTemplate: `
          <div style="width: 100%; font-size: 9px; color: #999; text-align: center; padding: 0 1cm;">
            <span>AutoADA Compliance Report</span>
            <span style="float: right;">Page <span class="pageNumber"></span> of <span class="totalPages"></span></span>
          </div>
        `,
        timeout: 60000,
      });

      return Buffer.from(pdfBuffer);
    })();

    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`PDF generation timed out after ${PDF_OVERALL_TIMEOUT_MS / 1000}s`)), PDF_OVERALL_TIMEOUT_MS)
    );

    return await Promise.race([pdfPromise, timeoutPromise]);
  } finally {
    await browser.close();
  }
}

module.exports = { generatePdf };
