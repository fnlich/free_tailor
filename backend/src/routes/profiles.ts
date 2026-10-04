import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import pdf from 'pdf-parse';
import { CreateProfileDTO, Profile } from '../types/profile';
import { isAdmin, requireUser } from '../middleware/auth';
import { checkProfileModelChoice } from '../config/aiModelConfig';
import { ModelUnavailableError, modelUnavailableBody } from '../config/modelErrors';
import { pdfUpload } from '../middleware/pdfUpload';
import { extractProfileFromResume } from '../services/resumeService';
import { buildNewProfile, buildUpdatedProfile } from '../services/profileService';
import { buildImportedProfiles, ProfileImportError } from '../services/profileImport';
import {
  assertCanAddProfile,
  deleteProfile,
  getProfileFor,
  hasProfile,
  listProfilesFor,
  ProfileLimitError,
  saveProfile,
  saveProfiles,
} from '../database/profileRepository';

const router = Router();

/**
 * Reading is now signed-in too.
 *
 * It was open, which was fine while there was one user and nothing to separate.
 * A profile carries a name, an address, a phone number and an employment
 * history, so an open list endpoint on a machine reachable from a network hands
 * all of that to whoever asks.
 */
router.use(requireUser);

/**
 * A built profile with its model choice checked against the list its owner
 * picks from, before anything is stored. A changed choice the owner could not
 * have picked is refused (see checkProfileModelChoice); a retired one from a
 * page loaded before the upgrade is stored as inheriting.
 */
async function withCheckedModelChoice(built: Profile, stored?: Profile): Promise<Profile> {
  const settings = built.profileSettings;
  if (!settings) return built;
  const modelId = await checkProfileModelChoice(settings.ai?.modelId, stored?.profileSettings?.ai?.modelId);
  return {
    ...built,
    profileSettings: { ...settings, ai: modelId ? { ...settings.ai, modelId } : {} },
  };
}

// Get all profiles this account can see
router.get('/', (req: Request, res: Response) => {
  try {
    const includeDisabled = req.query.includeDisabled === 'true';
    // `allOwners` only for an admin who asked: the builder wants an admin's own
    // profiles, the admin pages want everybody's, and the query says which.
    const allOwners = req.query.allOwners === 'true';
    res.json(listProfilesFor(req.user!, { includeDisabled, allOwners }));
  } catch (error) {
    console.error('Error fetching profiles:', error);
    res.status(500).json({ error: 'Failed to fetch profiles' });
  }
});

// Get single profile
router.get('/:id', (req: Request<{ id: string }>, res: Response) => {
  // 404, not 403, for somebody else's profile. A 403 would confirm that a
  // profile with that id exists, which is more than a stranger should learn.
  const profile = getProfileFor(req.user!, req.params.id);
  if (!profile) {
    res.status(404).json({ error: 'Profile not found' });
    return;
  }
  res.json(profile);
});

// Create profile
router.post('/', async (req: Request, res: Response) => {
  try {
    assertCanAddProfile(req.user!);
    const profile = saveProfile({
      ...(await withCheckedModelChoice(buildNewProfile(req.body as CreateProfileDTO, uuidv4()))),
      // Set here rather than taken from the body: a client that could name the
      // owner could hand a profile to somebody else, or to nobody.
      ownerId: req.user!.id,
    });
    res.status(201).json(profile);
  } catch (error) {
    if (error instanceof ProfileLimitError) {
      res.status(402).json({ error: error.message, code: 'profile-limit', limit: error.limit });
      return;
    }
    if (error instanceof ModelUnavailableError) {
      res.status(error.status).json(modelUnavailableBody(error, isAdmin(req)));
      return;
    }
    console.error('Error creating profile:', error);
    const message = error instanceof Error ? error.message : 'Failed to create profile';
    const status = /output (token|file name)/i.test(message) ? 400 : 500;
    res.status(status).json({ error: message });
  }
});

// Update profile
router.put('/:id', async (req: Request<{ id: string }>, res: Response) => {
  const existingProfile = getProfileFor(req.user!, req.params.id);
  if (!existingProfile) {
    res.status(404).json({ error: 'Profile not found' });
    return;
  }

  try {
    const updatedProfile = saveProfile({
      ...(await withCheckedModelChoice(
        buildUpdatedProfile(existingProfile, req.body as CreateProfileDTO),
        existingProfile
      )),
      // Carried through explicitly. `buildUpdatedProfile` composes a new object
      // from the DTO, and an owner dropped by an edit would make the profile
      // vanish from its owner's list on save.
      ownerId: existingProfile.ownerId,
    });
    res.json(updatedProfile);
  } catch (error) {
    if (error instanceof ModelUnavailableError) {
      res.status(error.status).json(modelUnavailableBody(error, isAdmin(req)));
      return;
    }
    res.status(400).json({ error: error instanceof Error ? error.message : 'Failed to update profile' });
  }
});

// Delete profile
router.delete('/:id', (req: Request<{ id: string }>, res: Response) => {
  // Resolved through the viewer FIRST, so deleting somebody else's profile is
  // a 404 rather than a delete.
  if (!getProfileFor(req.user!, req.params.id) || !deleteProfile(req.params.id)) {
    res.status(404).json({ error: 'Profile not found' });
    return;
  }
  res.json({ message: 'Profile deleted successfully' });
});

/**
 * Import profiles from an uploaded JSON file (protected).
 *
 * The file is read and parsed in the browser and arrives here as the request
 * body, so there is no upload to write to disk and clean up afterwards - and a
 * file that is not JSON at all is reported before it crosses the network. The
 * body is still treated as entirely untrusted: `buildImportedProfiles` is what
 * decides whether any of it is a profile.
 *
 * Unlike /upload this costs no AI call. It is the path for moving a profile
 * between installs, restoring one from a backup, or writing one by hand.
 */
router.post('/import', (req: Request, res: Response) => {
  try {
    const imported = buildImportedProfiles(req.body, { idExists: hasProfile, newId: uuidv4 });
    // Counted as a whole before any of it is written: importing six profiles
    // into a plan with room for two must refuse all six, not land two and fail.
    assertCanAddProfile(req.user!, imported.length);
    const profiles = saveProfiles(
      imported.map((entry) => ({ ...entry.profile, ownerId: req.user!.id }))
    );

    res.status(201).json({
      profiles,
      imported: profiles.length,
      keptIds: imported.filter((entry) => entry.keptId).length,
    });
  } catch (error) {
    if (error instanceof ProfileLimitError) {
      res.status(402).json({ error: error.message, code: 'profile-limit', limit: error.limit });
      return;
    }
    if (error instanceof ProfileImportError) {
      res.status(400).json({ error: error.message });
      return;
    }
    console.error('Error importing profiles:', error);
    const message = error instanceof Error ? error.message : 'Failed to import profiles';
    // The template validators throw for a stored file-name template the admin
    // form would also have refused; that is the file's fault, not the server's.
    const status = /output (token|file name|folder name)/i.test(message) ? 400 : 500;
    res.status(status).json({ error: message });
  }
});

/**
 * Upload a resume PDF and extract a profile from it (protected).
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
    // part, and refusing afterwards would spend it for nothing.
    try {
      assertCanAddProfile(req.user!);
    } catch (error) {
      if (error instanceof ProfileLimitError) {
        return res.status(402).json({ error: error.message, code: 'profile-limit', limit: error.limit });
      }
      throw error;
    }

    const pdfData = await pdf(req.file.buffer);

    if (!pdfData.text || pdfData.text.trim().length < 50) {
      return res.status(400).json({ error: 'Could not extract text from PDF. Please ensure the PDF contains readable text.' });
    }

    const extractedData = await extractProfileFromResume(pdfData.text);
    const profile = saveProfile({
      ...buildNewProfile(extractedData, uuidv4()),
      ownerId: req.user!.id,
    });

    res.status(201).json(profile);
  } catch (error) {
    console.error('Error extracting profile from PDF:', error);
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to extract profile from PDF' });
  }
});

export default router;
