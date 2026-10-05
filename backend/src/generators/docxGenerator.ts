/// <reference path="../types/html-to-docx.d.ts" />
import fs from 'fs/promises';
import path from 'path';
import HTMLtoDOCX from 'html-to-docx';
import { Profile } from '../types/profile';
import type { TailoredContent, Template } from '../types/template';
import { prepareResumeRenderData } from './pdfGenerator';
import { profileForTemplate } from '../services/profileService';
import type { GeneratedPathInfo } from '../utils/generatedPath';
import { getResumeOutputFilename } from '../utils/generatedPath';

/**
 * The DOCX's HTML: Arial, a centred header (name, title, contact), a blue
 * accent (#2B5C8A), underlined section headings. One fixed layout whatever the
 * template - html-to-docx turns it into Word paragraphs.
 *
 * Built from the same render data as the PDF and the preview, so the sections
 * a profile switched off are already empty here (see `applySkillsLimit`).
 * `generateResumeDOCX` reads the profile through the template the PDF is
 * drawn with (`profileForTemplate`), so on a template with no Strengths or
 * Soft Skills section those are off here too, and the two optional sections
 * below appear exactly when the PDF's do. Exported for the tests;
 * `generateResumeDOCX` is the only other caller.
 */
export function buildResumeDocxHTML(data: ReturnType<typeof prepareResumeRenderData>): string {
  const esc = (s: string) =>
    String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');

  const contactParts: string[] = [];
  if (data.contact?.location) contactParts.push(esc(data.contact.location));
  if (data.contact?.phone) contactParts.push(esc(data.contact.phone));
  if (data.contact?.email) contactParts.push(esc(data.contact.email));
  if (data.contact?.linkedinHref) {
    contactParts.push(
      `<a href="${esc(data.contact.linkedinHref)}">${esc(data.contact.linkedinDisplay || data.contact.linkedinHref)}</a>`
    );
  }
  const contactLine = contactParts.filter(Boolean).join('  •  ');

  const accentColor = '#2B5C8A';
  const sectionStyle = `margin: 5pt 0 6pt 0; font-size: 11pt; font-weight: bold; color: ${accentColor}; border-bottom: 1px solid ${accentColor}; padding-bottom: 2pt;`;
  const skillCategories = data.skillCategories ?? [];
  const skillParagraph = (body: string, gap: string) =>
    `<p style="font-size: 9pt; color: #1A1A1A; margin: 0 0 ${gap} 0; line-height: 1.35;">${body}</p>`;
  const technicalSkillsHtml: string = skillCategories.length > 0
    ? skillCategories
      .map((group) => {
        // The flat layout arrives as one group whose heading is empty. Emitting
        // the <strong> and the <br> anyway would open the skills with a blank
        // bold line - and in Word, unlike a browser, that line takes up a whole
        // row of the page.
        const heading = esc(group.category ?? '');
        return skillParagraph(
          heading ? `<strong>${heading}</strong><br>${esc(group.skills.join(', '))}` : esc(group.skills.join(', ')),
          heading ? '4pt' : '14pt'
        );
      })
      .join('\n  ')
    : (data.hardSkills ?? data.skills ?? []).some(Boolean)
      ? skillParagraph(
        // Technical skills only. Soft skills were folded in here once, which put
        // "Communication" in a list of languages and frameworks; they have their
        // own section now.
        esc((data.hardSkills ?? data.skills ?? []).filter(Boolean).join(', ')),
        '14pt'
      )
      : '';
  // The same rule as the optional sections below: no heading over nothing.
  const technicalSkillsSection = technicalSkillsHtml
    ? `
  <p style="${sectionStyle}"><u>Technical Skills</u></p>
  ${technicalSkillsHtml}
  <p style="margin: 0;"><br></p>
`
    : '';

  // The two optional sections, each only when it has something in it - a
  // heading over nothing takes a whole row of the page in Word.
  const strengths = data.strengths ?? [];
  const strengthsHtml = strengths.length > 0
    ? `
  <p style="${sectionStyle}"><u>Key Strengths</u></p>
  ${strengths
    .map((item) => {
      const title = item.title ? `<strong>${esc(item.title)}</strong>` : '';
      const description = item.description ? esc(item.description) : '';
      return `<p style="font-size: 9pt; color: #1A1A1A; margin: 0 0 4pt 0; line-height: 1.35;">${
        title && description ? `${title}: ${description}` : title || description
      }</p>`;
    })
    .join('\n  ')}
  <p style="margin: 0;"><br></p>
`
    : '';
  const softSkills = data.softSkills ?? [];
  const softSkillsHtml = softSkills.length > 0
    ? `
  <p style="${sectionStyle}"><u>Soft Skills</u></p>
  ${skillParagraph(esc(softSkills.join(', ')), '14pt')}
  <p style="margin: 0;"><br></p>
`
    : '';

  let html = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="font-family: Arial, sans-serif; font-size: 10pt; color: #1A1A1A;">
  <div style="text-align: center;">
    <p style="font-size: 20pt; font-weight: bold; color: #1A1A1A; margin: 0 0 5pt 0; text-align: center;">${esc(data.name)}</p>
    <p style="font-size: 12pt; font-weight: bold; color: ${accentColor}; margin: 0 0 5pt 0; text-align: center;">${esc(data.title)}</p>
    <p style="font-size: 9pt; color: #555555; margin: 0 0 14pt 0; text-align: center;">${contactLine}</p>
    <p style="margin: 0;"><br></p>
  </div>

  <p style="${sectionStyle}"><u>Professional Summary</u></p>
  <p style="font-size: 10pt; color: #1A1A1A; margin: 0 0 12pt 0; line-height: 1.35;">${esc(data.summary || '')}</p>
  <p style="margin: 0;"><br></p>
${strengthsHtml}${technicalSkillsSection}${softSkillsHtml}

  <p style="${sectionStyle}"><u>Professional Experience</u></p>
  ${(data.experience ?? [])
    .map(
      (exp: {
        title?: string;
        company?: string;
        startDate?: string;
        endDate?: string;
        location?: string;
        description?: string;
        achievements?: string[];
      }) => {
        const dates = [exp.startDate, exp.endDate].filter(Boolean).join(' – ');
        const loc = exp.location ? ` • ${exp.location}` : '';
        const bullets = (exp.achievements ?? [])
          .map((a: string) => `<p style="font-size: 9pt; color: #1A1A1A; line-height: 1.35;">- ${esc(a)}</p>`)
          .join('\n  ');
        return `
  <p style="font-weight: bold; font-size: 11pt; color: #1A1A1A;">${esc(exp.company ?? '')}</p>
  <p style="font-size: 10pt; color: ${accentColor}; font-style: italic;">${esc(exp.title ?? '')}</p>
  <p style="font-size: 8pt; color: #555555;">${esc(dates)}${esc(loc)}</p>
  <p style="font-size: 9pt; color: #1A1A1A; line-height: 1.35;">${esc(exp.description ?? '')}</p>
  ${bullets}`;
      }
    )
    .join('\n')}
  <p style="margin: 0;"><br></p>

  <p style="${sectionStyle}"><u>Education</u></p>
  ${(data.education ?? [])
    .map(
      (edu: {
        degree?: string;
        institution?: string;
        startDate?: string;
        endDate?: string;
        location?: string;
      }) => {
        const dates = [edu.startDate, edu.endDate].filter(Boolean).join(' – ');
        const loc = edu.location ? ` • ${edu.location}` : '';
        return `
  <p style="font-weight: bold; font-size: 10pt; color: #1A1A1A;">${esc(edu.degree ?? '')}</p>
  <p style="font-size: 9pt; color: #555555;">${esc(edu.institution ?? '')}${esc(loc)}</p>
  <p style="font-size: 8pt; color: #555555;">${esc(dates)}</p>`;
      }
    )
    .join('\n')}
</body>
</html>`;

  return html;
}

/**
 * The resume as a Word file. `template` is the one the PDF of the same
 * generation is drawn with: the DOCX has one fixed layout and never renders
 * it, but it decides which of the optional sections exist, so the two files
 * of a "both" download carry the same sections.
 */
export async function generateResumeDOCX(
  profile: Profile,
  template: Template,
  tailoredContent: TailoredContent | undefined,
  pathInfo: GeneratedPathInfo,
  companyName: string,
  role: string
): Promise<string> {
  const renderData = prepareResumeRenderData(
    profileForTemplate(profile, template),
    tailoredContent,
    companyName,
    role
  );
  const html = buildResumeDocxHTML(renderData);

  const docxBuffer = await HTMLtoDOCX(html, null, {
    font: 'Arial',
    fontSize: 18, // 9pt = 18 half-points
    margins: { top: 720, right: 720, bottom: 720, left: 720 }, // 0.5in in twips
    orientation: 'portrait',
  });

  const docxFilename = getResumeOutputFilename(pathInfo, 'docx');
  const relativePath = `${pathInfo.storagePathBase}/${docxFilename}`;
  const filepath = path.join(pathInfo.absoluteDir, docxFilename);

  await fs.mkdir(path.dirname(filepath), { recursive: true });
  await fs.writeFile(filepath, Buffer.from(docxBuffer as ArrayBuffer));

  return relativePath;
}
