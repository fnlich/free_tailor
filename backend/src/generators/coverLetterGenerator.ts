import puppeteer from 'puppeteer';
import fs from 'fs/promises';
import path from 'path';
/// <reference path="../types/html-to-docx.d.ts" />
import HTMLtoDOCX from 'html-to-docx';
import { Profile } from '../types/profile';
import type { GeneratedPathInfo } from '../utils/generatedPath';
import { getCoverLetterOutputFilename } from '../utils/generatedPath';

const COVER_LETTER_GREETINGS = ['Hello Hiring Team,', 'Hi Hiring Team,', 'Hello Team,', 'Hi Team,'];

function getCoverLetterGreeting(): string {
  return COVER_LETTER_GREETINGS[Math.floor(Math.random() * COVER_LETTER_GREETINGS.length)];
}

function esc(s: string): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Convert plain text content to HTML paragraphs */
function contentToHtmlParagraphs(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) return '';
  const paragraphs = trimmed.split(/\n\s*\n/).filter((p) => p.trim());
  return paragraphs
    .map((p) => `<p style="margin: 0 0 12pt 0; line-height: 1.5;">${esc(p.trim().replace(/\n/g, ' '))}</p>`)
    .join('\n  ');
}

/**
 * Build professional PDF-style HTML for the cover letter.
 * Structure: greeting, {content}, Best regards, {Profile name}
 */
function buildCoverLetterHTML(content: string, profileName: string): string {
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="font-family: Arial, sans-serif; font-size: 11pt; color: #1A1A1A; line-height: 1.5;">
  <p style="margin: 0 0 12pt 0;">${getCoverLetterGreeting()}</p>
  ${contentToHtmlParagraphs(content)}
  <p style="margin: 12pt 0 6pt 0;">Best regards,</p>
  <p style="margin: 0; color: black;">${esc(profileName.trim())}</p>
</body>
</html>`;
}

/**
 * Build cover letter HTML for DOCX with explicit line breaks between sections.
 * Structure: greeting, (line break), {content}, (line break), Best regards, {profile name}
 */
function buildCoverLetterHTMLForDocx(content: string, profileName: string): string {
  const lineBreak = '<p style="margin: 0 0 12pt 0;"></p>';
  return `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="font-family: Arial, sans-serif; font-size: 11pt; color: #1A1A1A; line-height: 1.5;">
  <p style="margin: 0 0 12pt 0;">${getCoverLetterGreeting()}</p>
  ${lineBreak}
  ${contentToHtmlParagraphs(content)}
  ${lineBreak}
  <p style="margin: 0 0 12pt 0;">Best regards,</p>
  <p style="margin: 0; font-weight: bold; color: black; font-size: 12pt;">${esc(profileName.trim())}</p>
</body>
</html>`;
}

/**
 * Save cover letter as PDF in the same directory as the resume.
 * Path: {profile}/{count+1}_{company}/{role}/{profile}_cover_letter.pdf
 */
export async function saveCoverLetter(
  profile: Profile,
  content: string,
  pathInfo: GeneratedPathInfo
): Promise<string> {
  const filename = getCoverLetterOutputFilename(pathInfo, 'pdf');
  const relativePath = `${pathInfo.storagePathBase}/${filename}`;
  const filepath = path.join(pathInfo.absoluteDir, filename);

  const html = buildCoverLetterHTML(content.trim(), profile.name);

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 595, height: 842, deviceScaleFactor: 1 }); // A4 at 72 DPI
    await page.emulateMediaType('print');
    await page.setContent(html, { waitUntil: 'load' });

    const pdfBuffer = await page.pdf({
      format: 'A4',
      margin: { top: '0.75in', right: '0.75in', bottom: '0.75in', left: '0.75in' },
      printBackground: true,
    });

    await fs.mkdir(path.dirname(filepath), { recursive: true });
    await fs.writeFile(filepath, Buffer.from(pdfBuffer));

    return relativePath;
  } finally {
    await browser.close();
  }
}

/**
 * Save cover letter as DOCX in the same directory as the resume.
 * Path: {profile}/{date}/{company}/{role}/{profile}_cover_letter.docx
 */
export async function saveCoverLetterDOCX(
  profile: Profile,
  content: string,
  pathInfo: GeneratedPathInfo
): Promise<string> {
  const filename = getCoverLetterOutputFilename(pathInfo, 'docx');
  const relativePath = `${pathInfo.storagePathBase}/${filename}`;
  const filepath = path.join(pathInfo.absoluteDir, filename);

  const html = buildCoverLetterHTMLForDocx(content.trim(), profile.name);

  const docxBuffer = await HTMLtoDOCX(html, null, {
    font: 'Arial',
    fontSize: 22, // 11pt = 22 half-points
    margins: { top: 1080, right: 1080, bottom: 1080, left: 1080 }, // 0.75in in twips
    orientation: 'portrait',
  });

  await fs.mkdir(path.dirname(filepath), { recursive: true });
  await fs.writeFile(filepath, Buffer.from(docxBuffer as ArrayBuffer));

  return relativePath;
}
