/**
 * JSON reporter — raw data export preserving all axe-core data.
 */

function generateJson(scanResult, scores) {
  const output = {
    ...scanResult,
    scores,
    // Remove circular references and non-serializable data
    pages: scanResult.pages?.map((page) => ({
      ...page,
      desktop: {
        ...page.desktop,
        screenshot: page.desktop?.screenshot ? '[base64 screenshot data]' : null,
      },
      mobile: {
        ...page.mobile,
        screenshot: page.mobile?.screenshot ? '[base64 screenshot data]' : null,
      },
    })),
  };

  return JSON.stringify(output, (key, value) => {
    // Convert Sets to Arrays for serialization
    if (value instanceof Set) return Array.from(value);
    return value;
  }, 2);
}

module.exports = { generateJson };
