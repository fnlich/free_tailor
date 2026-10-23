import { NextFunction, Router, Request, Response } from 'express';
import { requireUser } from '../middleware/auth';
import { sendPublicError } from '../middleware/publicError';
import { readProfileName } from '../services/profileRules';
import {
  createProfileFor,
  deleteProfileFor,
  getProfileSummaryFor,
  listProfileSummariesFor,
  moveResumesIntoProfile,
  updateProfileFor,
} from '../database/profileRepository';
import { fileUnfiledResumesFor, ProfileNotFoundError, ProfileRefusal } from '../database/profileTree';

/**
 * /api/profiles: the people, and the resumes each holds.
 *
 * A profile is a person; the resumes live under /api/resumes and point at their
 * profile. Every refusal is a PublicError (a sentence written for anybody, with
 * a code a page can branch on) sent through `sendPublicError`; nothing here
 * answers with `err.message`.
 */
const router = Router();
/**
 * Everything below needs a signed-in account.
 *
 * At the router rather than per route, so a route added later is protected by
 * default. Before v2 these were open, which was defensible with one user on one
 * machine and is not once each record belongs to an account.
 *
 * Nothing else: profiles are open on every subscription. The subscription's
 * cap is on HOW MANY a person may make (402 `profile-limit`, counted when one
 * is made), not on using them. An administrator reaches any profile by id.
 */
router.use(requireUser);

/**
 * Files the viewer's old resumes under their people before anything is read or
 * counted (lazy filing, instead of a data migration), so a list never shows a
 * resume nobody holds and the limit is counted against the profiles they make.
 * One cheap read when there is nothing to file. The viewer's own resumes only.
 */
router.use((req: Request, res: Response, next: NextFunction) => {
  try {
    fileUnfiledResumesFor(req.user!);
    next();
  } catch (error) {
    sendPublicError(req, res, error, 'Failed to read the profiles');
  }
});

/** What POST accepts, and nothing else: a body carrying any other key is a page from before profiles were people. */
const CREATE_KEYS = new Set(['name', 'resumeIds']);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The body as an object; an absent body is empty. Anything else is not a body these routes can read. */
function readBody(value: unknown): Record<string, unknown> | null {
  if (value === undefined || value === null) return {};
  return isPlainObject(value) ? value : null;
}

router.get('/', (req: Request, res: Response) => {
  try {
    res.json(listProfileSummariesFor(req.user!, { allOwners: req.query.allOwners === 'true' }));
  } catch (error) {
    sendPublicError(req, res, error, 'Failed to fetch the profiles');
  }
});

router.get('/:id', (req: Request<{ id: string }>, res: Response) => {
  try {
    const summary = getProfileSummaryFor(req.user!, req.params.id);
    if (!summary) throw new ProfileNotFoundError();
    res.json(summary);
  } catch (error) {
    sendPublicError(req, res, error, 'Failed to fetch the profile');
  }
});

/**
 * Makes a profile: `{ name?, resumeIds? }` -> 201 with its summary. Counts the
 * limit (402 `profile-limit`); the resumes listed are moved in, all or nothing.
 * A name left out or blank is 'Untitled Profile'.
 *
 * A body naming anything else is 400 `stale-page`. Until v4.2 this route took a
 * RESUME's body (a stale editor tab, or a script, still sends one), and
 * reading it as a profile would quietly make a person out of a resume.
 */
router.post('/', (req: Request, res: Response) => {
  try {
    const body = readBody(req.body);
    if (body === null || Object.keys(body).some((key) => !CREATE_KEYS.has(key))) {
      throw new ProfileRefusal('This page is out of date; reload it before saving.', 400, 'stale-page');
    }

    let name: string | undefined;
    if (body.name !== undefined && body.name !== null && !(typeof body.name === 'string' && !body.name.trim())) {
      const read = readProfileName(body.name);
      if (!read.ok) throw new ProfileRefusal(read.message, 400, read.code);
      name = read.name;
    }
    if (body.resumeIds !== undefined && !Array.isArray(body.resumeIds)) {
      throw new ProfileRefusal('Choose the resumes to move.', 400, 'nothing-to-move');
    }

    res.status(201).json(createProfileFor(req.user!, { name, resumeIds: body.resumeIds }));
  } catch (error) {
    sendPublicError(req, res, error, 'Failed to create the profile');
  }
});

/**
 * Renames a profile and/or chooses its default resume: `{ name?,
 * defaultResumeId? }` -> 200 with its summary. A profile's resumes are not
 * changed here (`resumeIds` is 400 `use-move`), and a body naming neither
 * field is 400 `nothing-to-change`.
 */
router.put('/:id', (req: Request<{ id: string }>, res: Response) => {
  try {
    const body = readBody(req.body) ?? {};
    if ('resumeIds' in body) {
      throw new ProfileRefusal(
        "A profile's resumes are not changed here: move them with Move.",
        400,
        'use-move'
      );
    }
    res.json(updateProfileFor(req.user!, req.params.id, { name: body.name, defaultResumeId: body.defaultResumeId }));
  } catch (error) {
    sendPublicError(req, res, error, 'Failed to update the profile');
  }
});

/**
 * Moves resumes into this profile: `{ resumeIds }` -> 200 `{ moved, profiles }`
 * (the profile and every profile a resume came from). All or nothing; a moved
 * resume keeps its `updatedAt`.
 */
router.post('/:id/move', (req: Request<{ id: string }>, res: Response) => {
  try {
    const body = readBody(req.body) ?? {};
    res.json(moveResumesIntoProfile(req.user!, req.params.id, body.resumeIds));
  } catch (error) {
    sendPublicError(req, res, error, 'Failed to move the resumes');
  }
});

/**
 * Deletes a profile with every resume in it and their Bid Assistant answers,
 * in one transaction: `{ deleted: true, deletedResumes }`. There is no count
 * to send and no refusal for a profile that still holds resumes - the page
 * warns first.
 */
router.delete('/:id', (req: Request<{ id: string }>, res: Response) => {
  try {
    const { deletedResumes } = deleteProfileFor(req.user!, req.params.id);
    res.json({ deleted: true, deletedResumes });
  } catch (error) {
    sendPublicError(req, res, error, 'Failed to delete the profile');
  }
});

export default router;
