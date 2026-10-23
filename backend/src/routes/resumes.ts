import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import pdf from 'pdf-parse';
import { CreateResumeDTO, Resume } from '../types/resume';
import { isAdmin, requireUser } from '../middleware/auth';
import { PublicError, sendPublicError } from '../middleware/publicError';
import { requestSignal } from '../middleware/requestSignal';
import { checkResumeModelChoice } from '../config/aiModelConfig';
import { pdfUpload } from '../middleware/pdfUpload';
import { extractResumeFromText } from '../services/resumeService';
import { writeEntryBullets } from '../services/entryBullets';
import {
  buildNewResume,
  buildPreviewResume,
  buildUpdatedResume,
  resumeForTemplate,
} from '../services/resumeDocument';
import { withSampleDefaults } from '../services/sampleResume';
import { matchKeywordsOf, type ResumeKeywords } from '../services/resumeKeywords';
import { buildImportedResumes } from '../services/resumeImport';
import { getTemplateById } from '../extractors/templateExtractor';
import { noTemplateAvailable, resolveTemplateForResume } from '../services/templateChoice';
import { generateResumeDraftPreviewHTML } from '../generators/pdfGenerator';
import {
  fileUnfiledResumesFor,
  readRequestedProfileId,
  requireOwnProfile,
} from '../database/profileTree';
import {
  createResumes,
  createResumesWithProfiles,
  deleteResume,
  getResumeFor,
  hasResume,
  listResumesFor,
  saveEditedResume,
} from '../database/resumeRepository';

const router = Router();

/**
 * Reading is now signed-in too.
 *
 * It was open, which was fine while there was one user and nothing to separate.
 * A resume carries a name, an address, a phone number and an employment
 * history, so an open list endpoint on a machine reachable from a network hands
 * all of that to whoever asks.
 */
router.use(requireUser);

/**
 * A built resume with its model choice checked against the list its owner
 * picks from, before anything is stored. A changed choice the owner could not
 * have picked is refused (see checkResumeModelChoice); a retired one from a
 * page loaded before the upgrade is stored as inheriting.
 */
async function withCheckedModelChoice(built: Resume, stored?: Resume): Promise<Resume> {
  const settings = built.resumeSettings;
  if (!settings) return built;
  const modelId = await checkResumeModelChoice(settings.ai?.modelId, stored?.resumeSettings?.ai?.modelId);
  return {
    ...built,
    resumeSettings: { ...settings, ai: modelId ? { ...settings.ai, modelId } : {} },
  };
}

const UNREADABLE_PDF = 'Could not extract text from PDF. Please ensure the PDF contains readable text.';

/**
 * Files the viewer's old resumes under their people (lazy filing, instead of a
 * data migration) before a resume is listed or read, so every resume the
 * viewer is shown carries its `profileId`. One cheap read when there is
 * nothing to file; the viewer's own resumes only.
 */
function fileViewersResumes(req: Request): void {
  fileUnfiledResumesFor(req.user!);
}

/**
 * A resume as the two GETs serve it: with its keywords (services/resumeKeywords.ts),
 * computed now from what the resume says, so a resume saved before they existed,
 * or under an older vocabulary, is answered current. DERIVED and nothing else:
 * never stored (the save paths build the resume from named fields and write
 * none), never read from a body, and not in what the other routes answer -
 * a page that downloads a resume as a file leaves it out. A failure to work
 * them out leaves the field off; it never fails the read.
 */
function withMatchKeywords(resume: Resume): Resume & { matchKeywords?: ResumeKeywords } {
  const { matchKeywords: _kept, ...plain } = resume as Resume & { matchKeywords?: unknown };
  try {
    return { ...plain, matchKeywords: matchKeywordsOf(resume) };
  } catch {
    return plain;
  }
}

// Get all resumes this account can see
router.get('/', (req: Request, res: Response) => {
  try {
    fileViewersResumes(req);
    const includeDisabled = req.query.includeDisabled === 'true';
    // `allOwners` only for an admin who asked: the builder wants an admin's own
    // resumes, the admin pages want everybody's, and the query says which.
    const allOwners = req.query.allOwners === 'true';
    res.json(listResumesFor(req.user!, { includeDisabled, allOwners }).map(withMatchKeywords));
  } catch (error) {
    sendPublicError(req, res, error, 'Failed to fetch the resumes');
  }
});

// Get single resume
router.get('/:id', (req: Request<{ id: string }>, res: Response) => {
  try {
    fileViewersResumes(req);
    // 404, not 403, for somebody else's resume. A 403 would confirm that a
    // resume with that id exists, which is more than a stranger should learn.
    const resume = getResumeFor(req.user!, req.params.id);
    if (!resume) {
      res.status(404).json({ error: 'Resume not found' });
      return;
    }
    res.json(withMatchKeywords(resume));
  } catch (error) {
    sendPublicError(req, res, error, 'Failed to fetch the resume');
  }
});

/**
 * Create resume. `?profileId=` names the profile (the person) it is filed
 * under - the caller's own, else 404 `profile-not-found`; without one it goes
 * to the account's oldest profile named for the person, else a new profile is
 * made for them, which is what counts the subscription's profile limit
 * (database/resumeRepository.ts `createResumes`). A `profileId` or `ownerId`
 * in the body is not read.
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const profileId = readRequestedProfileId(req.query.profileId);
    const [resume] = createResumes(
      req.user!,
      [await withCheckedModelChoice(buildNewResume(req.body as CreateResumeDTO, uuidv4()))],
      { profileId }
    );
    res.status(201).json(resume);
  } catch (error) {
    // The subscription's profile limit (402 with `limit`), a profile that is
    // not there, a model the owner may not pick, and a file or folder name
    // template that cannot be used are the caller's to fix and say so;
    // anything else is generic.
    sendPublicError(req, res, error, 'Failed to create the resume');
  }
});

// Update resume
router.put('/:id', async (req: Request<{ id: string }>, res: Response) => {
  const existingResume = getResumeFor(req.user!, req.params.id);
  if (!existingResume) {
    res.status(404).json({ error: 'Resume not found' });
    return;
  }

  try {
    // The stored row is read again inside the save: a resume deleted since the
    // read above is 404, never recreated, and the owner and the profile are
    // the stored row's - a Move that landed meanwhile is not undone, and
    // nothing in the body can file the resume elsewhere.
    const updatedResume = saveEditedResume(
      await withCheckedModelChoice(
        buildUpdatedResume(existingResume, req.body as CreateResumeDTO),
        existingResume
      ),
      existingResume.ownerId
    );
    res.json(updatedResume);
  } catch (error) {
    sendPublicError(req, res, error, 'Failed to update the resume');
  }
});

// Delete resume
router.delete('/:id', (req: Request<{ id: string }>, res: Response) => {
  // Resolved through the viewer FIRST, so deleting somebody else's resume is
  // a 404 rather than a delete.
  if (!getResumeFor(req.user!, req.params.id) || !deleteResume(req.params.id)) {
    res.status(404).json({ error: 'Resume not found' });
    return;
  }
  res.json({ message: 'Resume deleted successfully' });
});

/**
 * The resume editor's live preview: the draft of a source resume, as it would print.
 *
 * Body `{ resume, resumeId?, templateId? }` - `resume` is the editor's
 * draft, laid over the stored resume when `resumeId` names one of the
 * caller's (somebody else's is a 404, as everywhere here). Answers
 * `{ html, templateId, page, sampled }`: a whole document to frame, the
 * template it was actually drawn with, the printed page's size to scale it by,
 * and which empty fields and sections were drawn from the sample person
 * instead (`SAMPLE_FIELDS` names, in that order) so the editor can say so.
 *
 * The sample is the one thing here that is not what will print: an empty
 * draft would otherwise preview as bare headings, which says nothing about how
 * a template looks. It is laid on HERE and nowhere else - after the draft is
 * read, never on the way to a save, a generation or a prompt - and not at all
 * when the body says `sample: false` (the Profiles page's thumbnails, which
 * show a stored resume as it stands; `sampled` is then []).
 *
 * Costs nothing and keeps nothing: no row is written, the subscription's profile
 * limit is not consulted (nothing is being added), no model is asked and no credit
 * is reserved. It renders untailored, through the same pipeline and template
 * choice as a generated resume (`resolveTemplateForResume`), so what it shows
 * is what the next PDF will look like before any job tailors it.
 *
 * The template is the requested one, else the draft's own, else `default`. A
 * template named in the request that does not exist, or is disabled for
 * anybody but an administrator, is a 404 rather than a quiet substitute - the
 * editor asked for that one by name. A draft whose own template is gone is
 * drawn with `default`, as generation draws it, and `templateId` says which.
 */
router.post('/preview', async (req: Request, res: Response) => {
  try {
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as {
      resume?: unknown;
      resumeId?: unknown;
      templateId?: unknown;
      sample?: unknown;
    };

    const resumeId = typeof body.resumeId === 'string' ? body.resumeId.trim() : '';
    const existing = resumeId ? getResumeFor(req.user!, resumeId) : null;
    if (resumeId && !existing) {
      res.status(404).json({ error: 'Resume not found' });
      return;
    }

    const admin = isAdmin(req);
    const templateId = typeof body.templateId === 'string' ? body.templateId.trim() : '';
    if (templateId) {
      const requested = await getTemplateById(templateId);
      if (!requested || (requested.disabled && !admin)) {
        res.status(404).json({ error: 'Template not found' });
        return;
      }
    }

    const draft = buildPreviewResume(body.resume, existing);
    const template = await resolveTemplateForResume(draft, templateId || undefined, {
      allowDisabledRequested: admin,
    });
    if (!template) {
      throw noTemplateAvailable();
    }

    // Through the template first, so a section the template has no room for
    // is not filled - or reported as filled - from the sample. `sample: false`
    // draws the resume exactly as it stands - the Profiles page's thumbnails,
    // where another person's text in an empty section would pass for the
    // resume's own with no notice beside it to say so.
    const fitted = resumeForTemplate(draft, template);
    const { resume: shown, sampled } =
      body.sample === false ? { resume: fitted, sampled: [] } : withSampleDefaults(fitted);
    const preview = generateResumeDraftPreviewHTML(shown, template);
    res.json({ html: preview.html, templateId: template.id, page: preview.page, sampled });
  } catch (error) {
    sendPublicError(req, res, error, 'Failed to render the preview');
  }
});

/**
 * Import resumes from an uploaded JSON file (protected).
 *
 * The file is read and parsed in the browser and arrives here as the request
 * body, so there is no upload to write to disk and clean up afterwards - and a
 * file that is not JSON at all is reported before it crosses the network. The
 * body is still treated as entirely untrusted: `buildImportedResumes` is what
 * decides whether any of it is a resume.
 *
 * Unlike /upload this costs no AI call. It is the path for moving a resume
 * between installs, restoring one from a backup, or writing one by hand.
 *
 * With `?profileId=` (the caller's own profile) every resume goes there.
 * Without one each is filed by its person, in file order: the account's oldest
 * profile named for them, else a new one - so a file of two people makes two
 * profiles, and two resumes of one person share one. The profile limit is
 * counted for the profiles that would make, as a whole: an import that would
 * pass it writes nothing. The answer adds `profileIds` (the distinct profiles,
 * in file order) and `createdProfiles` (`{ id, name }` of the ones it made). A
 * `profileId` an entry carries is not read.
 */
router.post('/import', (req: Request, res: Response) => {
  try {
    const profileId = readRequestedProfileId(req.query.profileId);
    // Checked before the file is read, so a profile that is not there is the
    // answer however the file looks.
    if (profileId) requireOwnProfile(req.user!, profileId);
    // `new` is the chooser's address (/admin/resumes/new), so a file's id of
    // that spelling is never kept.
    const imported = buildImportedResumes(req.body, {
      idExists: (id) => id === 'new' || hasResume(id),
      newId: uuidv4,
    });
    // One transaction for the whole file: the limit is counted inside it, and
    // an entry refused leaves nothing behind - no resume and no new profile.
    const { resumes, createdProfiles } = createResumesWithProfiles(
      req.user!,
      imported.map((entry) => entry.resume),
      { profileId }
    );

    res.status(201).json({
      resumes,
      imported: resumes.length,
      keptIds: imported.filter((entry) => entry.keptId).length,
      profileIds: [...new Set(resumes.map((resume) => resume.profileId as string))],
      createdProfiles: createdProfiles.map((profile) => ({ id: profile.id, name: profile.name })),
    });
  } catch (error) {
    // A file that is not a resume, a profile that is not there, an import past
    // the subscription's profile limit, and a file-name template the resume
    // form would also have refused are the file's fault and are said so;
    // anything else is generic.
    sendPublicError(req, res, error, 'Failed to import the resumes');
  }
});

/**
 * Upload a resume PDF and extract a source resume from it (protected).
 *
 * The file is held in memory (`req.file.buffer`) and never written to disk. The
 * extraction only ever needed the bytes; the copy it used to write under a
 * fixed `backend/uploads` was read straight back and then had to be unlinked on
 * each of four exit paths. Its size cap is UPLOAD_MAX_MB, and `pdfUpload`
 * answers 413 for a file over it.
 */
router.post('/upload', pdfUpload('resume'), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No PDF file uploaded' });
    }

    // Checked before the AI call, not after: the extraction is the expensive
    // part, and refusing afterwards would spend it for nothing. The profile the
    // resume is to be filed under (`?profileId=`) must be the caller's own; it
    // is checked again at the save, which is the one that decides.
    const profileId = readRequestedProfileId(req.query.profileId);
    if (profileId) requireOwnProfile(req.user!, profileId);

    // pdf-parse's own exceptions quote the library's internals; what the
    // uploader can act on is that this file could not be read.
    const pdfData = await pdf(req.file.buffer).catch((error: unknown) => {
      throw new PublicError(UNREADABLE_PDF, { detail: error instanceof Error ? error.message : String(error) });
    });

    if (!pdfData.text || pdfData.text.trim().length < 50) {
      return res.status(400).json({ error: UNREADABLE_PDF });
    }

    const extractedData = await extractResumeFromText(pdfData.text);
    const [resume] = createResumes(req.user!, [buildNewResume(extractedData, uuidv4())], { profileId });

    res.status(201).json(resume);
  } catch (error) {
    // An AI failure is one of its four public sentences here, never the seat's
    // stderr; the profile limit stays a 402 (a resume for a person who has no
    // profile, when the account is at its limit).
    sendPublicError(req, res, error, 'Failed to read a resume from that PDF');
  }
});

/**
 * Write or improve one entry's bullets (services/entryBullets.ts): the resume
 * editor's Write with AI / Improve with AI. Free, one call per account at a
 * time, on the app default model; nothing is stored - the editor puts the
 * bullets into its draft. The body is the entry as the editor holds it, so no
 * resume is read here: `{ kind: 'experience' | 'project' | 'volunteering',
 * entry, resume?: { name, title, totalYearsExperience, summary, skills },
 * task: 'write' | 'improve', instructions? }`. Refusals about the entry are
 * 400 by code (`bad-kind`, `bad-task`, `entry-incomplete`,
 * `nothing-to-improve`), a second call while one runs 409 `already-running`,
 * no runnable model the AI-unavailable sentence, a seat failure one of the
 * four public AI sentences, anything else the generic sentence with a ref.
 * Aborted with the request, like a resume's calls. No POST /:id exists, so
 * the path cannot be read as an id.
 */
router.post('/entries/bullets', async (req: Request, res: Response) => {
  try {
    const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
    const bullets = await writeEntryBullets({
      accountId: req.user!.id,
      kind: body.kind,
      entry: body.entry,
      resume: body.resume,
      task: body.task,
      instructions: body.instructions,
      signal: requestSignal(req, res),
    });
    res.json({ bullets });
  } catch (error) {
    sendPublicError(req, res, error, 'Failed to write the bullets');
  }
});

export default router;
