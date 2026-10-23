/// <reference path="../types/html-to-docx.d.ts" />
import fs from 'fs/promises';
import path from 'path';
import HTMLtoDOCX from 'html-to-docx';
import { Resume } from '../types/resume';
import type { TailoredContent, Template } from '../types/template';
import { prepareResumeRenderData } from './pdfGenerator';
import { resumeForTemplate } from '../services/resumeDocument';
import { customSectionByKey, type PreparedCustomSection } from '../services/extraSections';
import {
  effectiveSectionOrder,
  parseSectionRef,
  presenceOf,
  SECTION_KIND_IDS,
  sectionKindDefinition,
  type SectionKind,
} from '../config/sectionCatalogue';
import type { GeneratedPathInfo } from '../utils/generatedPath';
import { getResumeOutputFilename } from '../utils/generatedPath';

type RenderData = ReturnType<typeof prepareResumeRenderData>;

const esc = (s: unknown) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

const ACCENT_COLOR = '#2B5C8A';
const SECTION_STYLE = `margin: 5pt 0 6pt 0; font-size: 11pt; font-weight: bold; color: ${ACCENT_COLOR}; border-bottom: 1px solid ${ACCENT_COLOR}; padding-bottom: 2pt;`;
const BLANK_LINE = '<p style="margin: 0;"><br></p>';

const heading = (text: string) => `<p style="${SECTION_STYLE}"><u>${esc(text)}</u></p>`;
const skillParagraph = (body: string, gap: string) =>
  `<p style="font-size: 9pt; color: #1A1A1A; margin: 0 0 ${gap} 0; line-height: 1.35;">${body}</p>`;

/**
 * The DOCX's HTML: Arial, a centred header (name, title, contact), a blue
 * accent (#2B5C8A), underlined section headings. One fixed look whatever the
 * template - html-to-docx turns it into Word paragraphs.
 *
 * Built from the same render data as the PDF and the preview, so the sections
 * a resume switched off are already empty here (see `applySkillsLimit`).
 * `generateResumeDOCX` reads the resume through the template the PDF is
 * drawn with (`resumeForTemplate`), so on a template with no Strengths or
 * Soft Skills section those are off here too, and the optional sections
 * appear exactly when the PDF's do.
 *
 * The sections print in the resume's order (`effectiveSectionOrder`,
 * config/sectionCatalogue.ts): the stored one when the person arranged the
 * cards, else the canonical order - which is the order this file always
 * printed, so a resume nobody arranged reads as it did. A kind with nothing
 * in it prints nothing: a heading over nothing takes a whole row of the page
 * in Word. The nine kinds beyond the classic six print here whether or not
 * the PDF's template carries the extra-sections macro, as Education prints
 * for a template without one. Exported for the tests; `generateResumeDOCX` is
 * the only other caller.
 */
export function buildResumeDocxHTML(data: RenderData): string {
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

  const order = effectiveSectionOrder(data.sectionOrder, SECTION_KIND_IDS, presenceOf(data));
  const body = order
    .map((ref) => {
      const parsed = parseSectionRef(ref);
      if (!parsed) return '';
      if (parsed.kind === 'custom') {
        const section = customSectionByKey(data, parsed.key);
        return section ? customSectionBlock(section) : '';
      }
      return sectionBlock(parsed.kind, data);
    })
    .filter(Boolean)
    .join('\n');

  return `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"></head>
<body style="font-family: Arial, sans-serif; font-size: 10pt; color: #1A1A1A;">
  <div style="text-align: center;">
    <p style="font-size: 20pt; font-weight: bold; color: #1A1A1A; margin: 0 0 5pt 0; text-align: center;">${esc(data.name)}</p>
    <p style="font-size: 12pt; font-weight: bold; color: ${ACCENT_COLOR}; margin: 0 0 5pt 0; text-align: center;">${esc(data.title)}</p>
    <p style="font-size: 9pt; color: #555555; margin: 0 0 14pt 0; text-align: center;">${contactLine}</p>
    ${BLANK_LINE}
  </div>

${body}
</body>
</html>`;
}

/** One classic or extra kind's block, or '' when it has nothing to print. */
function sectionBlock(kind: SectionKind, data: RenderData): string {
  switch (kind) {
    case 'summary':
      // Always printed, as it always was: the summary is the one section a
      // resume is not a resume without.
      return `  ${heading('Professional Summary')}
  <p style="font-size: 10pt; color: #1A1A1A; margin: 0 0 12pt 0; line-height: 1.35;">${esc(data.summary || '')}</p>
  ${BLANK_LINE}
`;
    case 'strengths':
      return strengthsBlock(data);
    case 'skills':
      return technicalSkillsBlock(data);
    case 'softSkills': {
      const softSkills = data.softSkills ?? [];
      if (softSkills.length === 0) return '';
      return `  ${heading('Soft Skills')}
  ${skillParagraph(esc(softSkills.join(', ')), '14pt')}
  ${BLANK_LINE}
`;
    }
    case 'experience':
      return experienceBlock(data);
    case 'education':
      return educationBlock(data);
    case 'certifications':
      return entriesBlock(
        kind,
        data.certifications,
        (item) => item.name || item.issuer,
        (item) => [entryTitle(item.name), entrySub(item.issuer), entryMeta(item.dates), entryMeta(item.note)]
      );
    case 'projects':
      return entriesBlock(
        kind,
        data.projects,
        (item) => item.name || item.role || item.description || item.achievements.length > 0,
        (item) => [
          entryTitle(item.name, item.linkText),
          entrySub(item.role),
          entryMeta(item.dates),
          entryText(item.description),
          ...bullets(item.achievements),
        ]
      );
    case 'volunteering':
      return entriesBlock(
        kind,
        data.volunteering,
        (item) => item.role || item.organization,
        (item) => [
          entryTitle(item.role),
          entrySub(item.organization),
          entryMeta([item.dates, item.location].filter(Boolean).join(' • ')),
          entryText(item.description),
          ...bullets(item.achievements),
        ]
      );
    case 'awards':
      return entriesBlock(
        kind,
        data.awards,
        (item) => item.title || item.issuer,
        (item) => [entryTitle(item.title), entrySub(item.issuer), entryMeta(item.dates), entryText(item.description)]
      );
    case 'publications':
      return entriesBlock(
        kind,
        data.publications,
        (item) => item.title,
        (item) => [
          entryTitle(item.title, item.linkText),
          entrySub(item.publisher),
          entryMeta(item.dates),
          entryText(item.description),
        ]
      );
    case 'courses':
      return entriesBlock(
        kind,
        data.courses,
        (item) => item.name,
        (item) => [entryTitle(item.name), entrySub(item.institution), entryMeta(item.dates)]
      );
    case 'languages':
      return entriesBlock(
        kind,
        data.languages,
        (item) => item.language,
        (item) => [entryText([item.language, item.proficiency].filter(Boolean).join(' - '))]
      );
    case 'interests': {
      const interests = data.interests ?? [];
      if (interests.length === 0) return '';
      return `  ${heading(sectionKindDefinition(kind).heading)}
  ${skillParagraph(esc(interests.join(', ')), '14pt')}
  ${BLANK_LINE}
`;
    }
    case 'references':
      return entriesBlock(
        kind,
        data.references,
        (item) => item.name,
        (item) => [entryTitle(item.name), entrySub(item.subline), entryMeta(item.contactLine)]
      );
  }
}

function strengthsBlock(data: RenderData): string {
  const strengths = data.strengths ?? [];
  if (strengths.length === 0) return '';
  return `  ${heading('Key Strengths')}
  ${strengths
    .map((item) => {
      const title = item.title ? `<strong>${esc(item.title)}</strong>` : '';
      const description = item.description ? esc(item.description) : '';
      return `<p style="font-size: 9pt; color: #1A1A1A; margin: 0 0 4pt 0; line-height: 1.35;">${
        title && description ? `${title}: ${description}` : title || description
      }</p>`;
    })
    .join('\n  ')}
  ${BLANK_LINE}
`;
}

function technicalSkillsBlock(data: RenderData): string {
  const skillCategories = data.skillCategories ?? [];
  const technicalSkillsHtml: string =
    skillCategories.length > 0
      ? skillCategories
          .map((group) => {
            // The flat layout arrives as one group whose heading is empty. Emitting
            // the <strong> and the <br> anyway would open the skills with a blank
            // bold line - and in Word, unlike a browser, that line takes up a whole
            // row of the page.
            const headingText = esc(group.category ?? '');
            return skillParagraph(
              headingText ? `<strong>${headingText}</strong><br>${esc(group.skills.join(', '))}` : esc(group.skills.join(', ')),
              headingText ? '4pt' : '14pt'
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
  // The same rule as every optional section: no heading over nothing.
  if (!technicalSkillsHtml) return '';
  return `  ${heading('Technical Skills')}
  ${technicalSkillsHtml}
  ${BLANK_LINE}
`;
}

function experienceBlock(data: RenderData): string {
  // Always printed, as it always was.
  return `  ${heading('Professional Experience')}
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
        const bulletLines = (exp.achievements ?? [])
          .map((a: string) => `<p style="font-size: 9pt; color: #1A1A1A; line-height: 1.35;">- ${esc(a)}</p>`)
          .join('\n  ');
        // No paragraph for a role with no description - every tailored one.
        // An empty paragraph is a whole blank row in Word, between the dates
        // and the first bullet.
        const description = (exp.description ?? '').trim();
        const descriptionHtml = description
          ? `\n  <p style="font-size: 9pt; color: #1A1A1A; line-height: 1.35;">${esc(description)}</p>`
          : '';
        return `
  <p style="font-weight: bold; font-size: 11pt; color: #1A1A1A;">${esc(exp.company ?? '')}</p>
  <p style="font-size: 10pt; color: ${ACCENT_COLOR}; font-style: italic;">${esc(exp.title ?? '')}</p>
  <p style="font-size: 8pt; color: #555555;">${esc(dates)}${esc(loc)}</p>${descriptionHtml}
  ${bulletLines}`;
      }
    )
    .join('\n')}
  ${BLANK_LINE}
`;
}

function educationBlock(data: RenderData): string {
  // Always printed, as it always was.
  return `  ${heading('Education')}
  ${(data.education ?? [])
    .map(
      (edu: { degree?: string; institution?: string; startDate?: string; endDate?: string; location?: string }) => {
        const dates = [edu.startDate, edu.endDate].filter(Boolean).join(' – ');
        const loc = edu.location ? ` • ${edu.location}` : '';
        return `
  <p style="font-weight: bold; font-size: 10pt; color: #1A1A1A;">${esc(edu.degree ?? '')}</p>
  <p style="font-size: 9pt; color: #555555;">${esc(edu.institution ?? '')}${esc(loc)}</p>
  <p style="font-size: 8pt; color: #555555;">${esc(dates)}</p>`;
      }
    )
    .join('\n')}
  ${BLANK_LINE}
`;
}

/*
 * The nine kinds beyond the classic six, drawn plainly: a bold entry title
 * (with a link's text in brackets), an italic-free sub line, a small grey
 * meta line (dates, a credential, a contact line), a description, "- bullet"
 * lines. An entry with nothing in it prints nothing, and so does a kind with
 * no entry.
 */
const entryTitle = (text: string, linkText = '') =>
  text || linkText
    ? `<p style="font-weight: bold; font-size: 10pt; color: #1A1A1A; margin: 4pt 0 0 0;">${esc(text)}${
        linkText ? ` (${esc(linkText)})` : ''
      }</p>`
    : '';
const entrySub = (text: string) => (text ? `<p style="font-size: 9pt; color: #555555; margin: 0;">${esc(text)}</p>` : '');
const entryMeta = (text: string) => (text ? `<p style="font-size: 8pt; color: #555555; margin: 0;">${esc(text)}</p>` : '');
const entryText = (text: string) =>
  text ? `<p style="font-size: 9pt; color: #1A1A1A; margin: 0; line-height: 1.35;">${esc(text)}</p>` : '';
const bullets = (items: readonly string[]) =>
  items.map((item) => `<p style="font-size: 9pt; color: #1A1A1A; margin: 0; line-height: 1.35;">- ${esc(item)}</p>`);

function entriesBlock<T>(
  kind: SectionKind,
  items: readonly T[] | undefined,
  typed: (item: T) => unknown,
  lines: (item: T) => string[]
): string {
  const printable = (items ?? []).filter((item) => Boolean(typed(item)));
  if (printable.length === 0) return '';
  return `  ${heading(sectionKindDefinition(kind).heading)}
  ${printable.map((item) => lines(item).filter(Boolean).join('\n  ')).join('\n')}
  ${BLANK_LINE}
`;
}

/** A custom section: its own title as the heading (none when it has none), its entries like a role's. */
function customSectionBlock(section: PreparedCustomSection): string {
  if (!section.hasEntries) return '';
  return `  ${section.title ? heading(section.title) : ''}
  ${section.entries
    .map((entry) =>
      [
        entryTitle(entry.heading),
        entrySub(entry.subheading),
        entryMeta([entry.dates, entry.location].filter(Boolean).join(' • ')),
        entryText(entry.description),
        ...bullets(entry.achievements),
      ]
        .filter(Boolean)
        .join('\n  ')
    )
    .join('\n')}
  ${BLANK_LINE}
`;
}

/**
 * The resume as a Word file. `template` is the one the PDF of the same
 * generation is drawn with: the DOCX has one fixed look and never renders
 * it, but it decides which of the optional sections exist, so the two files
 * of a "both" download carry the same sections.
 */
export async function generateResumeDOCX(
  resume: Resume,
  template: Template,
  tailoredContent: TailoredContent | undefined,
  pathInfo: GeneratedPathInfo,
  companyName: string,
  role: string
): Promise<string> {
  const renderData = prepareResumeRenderData(
    resumeForTemplate(resume, template),
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
