const puppeteer = require('puppeteer');

const generatePdfFromUrl = async (url, outputPath) => {
  const browser = await puppeteer.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'networkidle0', timeout: 60000 });
    await page.pdf({ path: outputPath, format: 'A4', printBackground: true });
    return outputPath;
  } finally {
    await browser.close();
  }
};

module.exports = { generatePdfFromUrl };
