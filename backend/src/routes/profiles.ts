import { Router, Request, Response } from 'express';
import fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import multer from 'multer';
import pdf from 'pdf-parse';
import { CreateProfileDTO } from '../types/profile';
import { authMiddleware } from '../middleware/auth';
import { extractProfileFromResume } from '../services/resumeService';
import { buildNewProfile, buildUpdatedProfile } from '../services/profileService';
import { buildImportedProfiles, ProfileImportError } from '../services/profileImport';
import {
  deleteProfile,
  getProfile,
  hasProfile,
  listProfiles,
  saveProfile,
  saveProfiles,
} from '../database/profileRepository';

const router = Router();
const UPLOADS_DIR = path.join(__dirname, '../../uploads');

// Configure multer for PDF uploads
const storage = multer.diskStorage({
  destination: async (req, file, cb) => {
    try {
      await fs.mkdir(UPLOADS_DIR, { recursive: true });
      cb(null, UPLOADS_DIR);
    } catch (error) {
      cb(error as Error, UPLOADS_DIR);
    }
  },
  filename: (req, file, cb) => {
    cb(null, `resume-${Date.now()}-${file.originalname}`);
  }
});

const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are allowed'));
    }
  },
  limits: { fileSize: 10 * 1024 * 1024 } // 10MB limit
});

// Get all profiles
router.get('/', (req: Request, res: Response) => {
  try {
    const includeDisabled = req.query.includeDisabled === 'true';
    res.json(listProfiles({ includeDisabled }));
  } catch (error) {
    console.error('Error fetching profiles:', error);
    res.status(500).json({ error: 'Failed to fetch profiles' });
  }
});

// Get single profile
router.get('/:id', (req: Request<{ id: string }>, res: Response) => {
  const profile = getProfile(req.params.id);
  if (!profile) {
    res.status(404).json({ error: 'Profile not found' });
    return;
  }
  res.json(profile);
});

// Create profile (protected)
router.post('/', authMiddleware, (req: Request, res: Response) => {
  try {
    const profile = saveProfile(buildNewProfile(req.body as CreateProfileDTO, uuidv4()));
    res.status(201).json(profile);
  } catch (error) {
    console.error('Error creating profile:', error);
    const message = error instanceof Error ? error.message : 'Failed to create profile';
    const status = /output (token|file name)/i.test(message) ? 400 : 500;
    res.status(status).json({ error: message });
  }
});

// Update profile (protected)
router.put('/:id', authMiddleware, (req: Request<{ id: string }>, res: Response) => {
  const existingProfile = getProfile(req.params.id);
  if (!existingProfile) {
    res.status(404).json({ error: 'Profile not found' });
    return;
  }

  try {
    const updatedProfile = saveProfile(buildUpdatedProfile(existingProfile, req.body as CreateProfileDTO));
    res.json(updatedProfile);
  } catch (error) {
    res.status(400).json({ error: error instanceof Error ? error.message : 'Failed to update profile' });
  }
});

// Delete profile (protected)
router.delete('/:id', authMiddleware, (req: Request<{ id: string }>, res: Response) => {
  if (!deleteProfile(req.params.id)) {
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
router.post('/import', authMiddleware, (req: Request, res: Response) => {
  try {
    const imported = buildImportedProfiles(req.body, { idExists: hasProfile, newId: uuidv4 });
    const profiles = saveProfiles(imported.map((entry) => entry.profile));

    res.status(201).json({
      profiles,
      imported: profiles.length,
      keptIds: imported.filter((entry) => entry.keptId).length,
    });
  } catch (error) {
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

// Upload resume PDF and extract profile (protected)
router.post('/upload', authMiddleware, upload.single('resume'), async (req: Request, res: Response) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No PDF file uploaded' });
    }

    // Read and parse PDF
    const pdfBuffer = await fs.readFile(req.file.path);
    const pdfData = await pdf(pdfBuffer);

    if (!pdfData.text || pdfData.text.trim().length < 50) {
      await fs.unlink(req.file.path); // Clean up
      return res.status(400).json({ error: 'Could not extract text from PDF. Please ensure the PDF contains readable text.' });
    }

    const extractedData = await extractProfileFromResume(pdfData.text);
    const profile = saveProfile(buildNewProfile(extractedData, uuidv4()));

    // Clean up uploaded file
    await fs.unlink(req.file.path);

    res.status(201).json(profile);
  } catch (error) {
    console.error('Error extracting profile from PDF:', error);
    // Clean up uploaded file if it exists
    if (req.file) {
      try {
        await fs.unlink(req.file.path);
      } catch {}
    }
    res.status(500).json({ error: error instanceof Error ? error.message : 'Failed to extract profile from PDF' });
  }
});

export default router;
