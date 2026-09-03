import pdf from 'pdf-parse';
import puppeteer from 'puppeteer';

const MAX_HTML_BYTES = 2_000_000;
const FETCH_TIMEOUT_MS = 20_000;
const PUPPETEER_TIMEOUT_MS = 25_000;
const MIN_EXTRACTED_TEXT_LENGTH = 200;

function normalizeWhitespace(value: string): string {
  return value
    .replace(/\r/g, '\n')
    .replace(/\t/g, ' ')
    .replace(/\u00a0/g, ' ')
    .replace(/[ ]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x27;/gi, "'");
}

function stripHtmlToText(html: string): string {
  const withoutNoise = html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<img\b[^>]*>/gi, ' ')
    .replace(/<!--([\s\S]*?)-->/g, ' ')
    .replace(/<\/(p|div|section|article|li|tr|h1|h2|h3|h4|h5|h6|br)>/gi, '\n');

  const text = withoutNoise.replace(/<[^>]+>/g, ' ');
  return normalizeWhitespace(decodeHtmlEntities(text));
}

function withTimeoutSignal(timeoutMs: number): AbortSignal {
  return AbortSignal.timeout(timeoutMs);
}

async function fetchResponse(url: string): Promise<Response> {
  return fetch(url, {
    redirect: 'follow',
    signal: withTimeoutSignal(FETCH_TIMEOUT_MS),
    headers: {
      'User-Agent':
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,application/pdf;q=0.7,*/*;q=0.5',
      'Accept-Language': 'en-US,en;q=0.9',
      'Cache-Control': 'no-cache',
      Pragma: 'no-cache',
    },
  });
}

async function extractPdfContent(buffer: Buffer): Promise<string> {
  const parsed = await pdf(buffer);
  return normalizeWhitespace(parsed.text || '');
}

async function extractHtmlViaFetch(url: string): Promise<string> {
  const response = await fetchResponse(url);
  if (!response.ok) {
    throw new Error(`Job page request failed with status ${response.status}.`);
  }

  const contentType = (response.headers.get('content-type') || '').toLowerCase();
  const arrayBuffer = await response.arrayBuffer();
  const cappedBuffer = Buffer.from(arrayBuffer).subarray(0, MAX_HTML_BYTES);

  if (contentType.includes('application/pdf')) {
    return extractPdfContent(cappedBuffer);
  }

  const html = cappedBuffer.toString('utf8');
  return stripHtmlToText(html);
}

async function extractHtmlViaPuppeteer(url: string): Promise<string> {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    );
    await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout: PUPPETEER_TIMEOUT_MS,
    });

    const text = await page.evaluate(() => {
      const browserGlobal = globalThis as {
        document?: {
          body?: {
            innerText?: string;
          };
        };
      };

      return browserGlobal.document?.body?.innerText || '';
    });
    return normalizeWhitespace(text);
  } finally {
    await browser.close();
  }
}

export async function extractJobPageContent(url: string): Promise<string> {
  const normalizedUrl = url.trim();
  if (!/^https?:\/\//i.test(normalizedUrl)) {
    throw new Error('Job link must be an absolute http(s) URL.');
  }

  try {
    const fetchedText = await extractHtmlViaFetch(normalizedUrl);
    if (fetchedText.length >= MIN_EXTRACTED_TEXT_LENGTH) {
      return fetchedText;
    }
  } catch (fetchError) {
    // Fall through to Puppeteer for JS-rendered or protected pages.
    if (!(fetchError instanceof Error)) {
      throw fetchError;
    }
  }

  return extractHtmlViaPuppeteer(normalizedUrl);
}
