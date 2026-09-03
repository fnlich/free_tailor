import { Router, Request, Response } from 'express';
import fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import multer from 'multer';
import pdf from 'pdf-parse';
import { Profile, CreateProfileDTO, Contact, Education, Experience, Strength, Certification, ProfileSettings } from '../types/profile';
import { authMiddleware } from '../middleware/auth';
import { extractProfileFromResume } from '../services/claude';
import {
  DEFAULT_COMPANY_FOLDER_NAME_TEMPLATE,
  DEFAULT_COVER_LETTER_FILE_NAME_TEMPLATE,
  DEFAULT_RESUME_FILE_NAME_TEMPLATE,
  validateOutputFolderNameTemplate,
  validateOutputFileNameTemplate,
} from '../utils/outputStorage';

const router = Router();
const PROFILES_DIR = path.join(__dirname, '../../data/profiles');
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

// Ensure profiles directory exists
async function ensureProfilesDir() {
  try {
    await fs.access(PROFILES_DIR);
  } catch {
    await fs.mkdir(PROFILES_DIR, { recursive: true });
  }
}

function toSafeString(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.trim() : fallback;
}

function toOptionalPositiveNumber(value: unknown, fallback?: number): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  }
  return fallback;
}

function normalizeStringList(value: unknown, fallback: string[] = []): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string').map((item) => item.trim()).filter(Boolean)
    : fallback;
}

function normalizeContact(input: CreateProfileDTO['contact'] | undefined, existing?: Contact): Contact {
  return {
    phone: toSafeString(input?.phone, existing?.phone ?? ''),
    email: toSafeString(input?.email, existing?.email ?? ''),
    linkedin: toSafeString(input?.linkedin, existing?.linkedin ?? ''),
    github: toSafeString(input?.github, existing?.github ?? ''),
    portfolio: toSafeString(input?.portfolio, existing?.portfolio ?? ''),
    location: toSafeString(input?.location, existing?.location ?? ''),
  };
}

function normalizeExperience(experience: CreateProfileDTO['experience'] | undefined, existing?: Experience[]): Experience[] {
  if (!experience) return existing ?? [];
  return experience.map((exp): Experience => ({
    title: toSafeString(exp?.title),
    company: toSafeString(exp?.company),
    startDate: toSafeString(exp?.startDate),
    endDate: toSafeString(exp?.endDate),
    location: toSafeString(exp?.location),
    description: toSafeString(exp?.description),
    achievements: normalizeStringList(exp?.achievements),
    skills: normalizeStringList(exp?.skills),
  }));
}

function normalizeStrengths(strengths: CreateProfileDTO['strengths'] | undefined, existing?: Strength[]): Strength[] {
  if (!strengths) return existing ?? [];
  return strengths.map((item): Strength => ({
    title: toSafeString(item?.title),
    description: toSafeString(item?.description),
  }));
}

function normalizeEducation(education: CreateProfileDTO['education'] | undefined, existing?: Education[]): Education[] {
  if (!education) return existing ?? [];
  return education.map((item): Education => ({
    degree: toSafeString(item?.degree),
    institution: toSafeString(item?.institution),
    startDate: toSafeString(item?.startDate),
    endDate: toSafeString(item?.endDate),
    location: toSafeString(item?.location),
    gpa: toSafeString(item?.gpa),
    achievements: Array.isArray(item?.achievements)
      ? item.achievements.filter((a): a is string => typeof a === 'string').map((a) => a.trim()).filter(Boolean)
      : undefined,
  }));
}

function normalizeCertifications(certifications: CreateProfileDTO['certifications'] | undefined, existing?: Certification[]): Certification[] {
  if (!certifications) return existing ?? [];
  return certifications
    .filter((item): item is Certification => !!item && typeof item === 'object')
    .map((item) => ({
      name: toSafeString(item.name),
      issuer: toSafeString(item.issuer),
      date: toSafeString(item.date),
      expiryDate: toSafeString(item.expiryDate),
      credentialId: toSafeString(item.credentialId),
    }));
}

function normalizeProfileSettings(
  input: CreateProfileDTO['profileSettings'] | undefined,
  existing?: ProfileSettings
): ProfileSettings {
  const source = input && typeof input === 'object' ? input : undefined;
  const defaultAnalyzeJobPromptId = 'custom-analyze-job-description-extracting-prompt-v2';
  const existingAnalyzeJobPromptId =
    existing?.analyzeJobPromptId === 'analyze-job-description'
      ? defaultAnalyzeJobPromptId
      : existing?.analyzeJobPromptId;
  const resumePromptId = toSafeString(source?.resumePromptId, existing?.resumePromptId ?? 'tailor-resume') || 'tailor-resume';
  const rawAnalyzeJobPromptId =
    toSafeString(source?.analyzeJobPromptId, existingAnalyzeJobPromptId ?? defaultAnalyzeJobPromptId) ||
    defaultAnalyzeJobPromptId;
  const analyzeJobPromptId =
    rawAnalyzeJobPromptId === 'analyze-job-description' ? defaultAnalyzeJobPromptId : rawAnalyzeJobPromptId;
  const coverLetterPromptId =
    toSafeString(source?.coverLetterPromptId, existing?.coverLetterPromptId ?? 'generate-cover-letter') ||
    'generate-cover-letter';

  return {
    resumePromptId,
    analyzeJobPromptId,
    coverLetterPromptId,
    resumeFileNameTemplate: validateOutputFileNameTemplate(
      source?.resumeFileNameTemplate ?? existing?.resumeFileNameTemplate,
      DEFAULT_RESUME_FILE_NAME_TEMPLATE
    ),
    coverLetterFileNameTemplate: validateOutputFileNameTemplate(
      source?.coverLetterFileNameTemplate ?? existing?.coverLetterFileNameTemplate,
      DEFAULT_COVER_LETTER_FILE_NAME_TEMPLATE
    ),
    companyFolderNameTemplate: validateOutputFolderNameTemplate(
      source?.companyFolderNameTemplate ?? existing?.companyFolderNameTemplate,
      DEFAULT_COMPANY_FOLDER_NAME_TEMPLATE
    ),
  };
}

function normalizeProfilePayload(data: CreateProfileDTO, existing?: Profile): Omit<Profile, 'id' | 'createdAt' | 'updatedAt'> {
  const skills = normalizeStringList(data.skills, existing?.skills ?? []);

  return {
    name: toSafeString(data.name, existing?.name ?? 'Untitled Profile'),
    title: toSafeString(data.title, existing?.title ?? 'Professional'),
    totalYearsExperience: toOptionalPositiveNumber(data.totalYearsExperience, existing?.totalYearsExperience),
    preferredTemplate: toSafeString(data.preferredTemplate, existing?.preferredTemplate ?? ''),
    disabled: typeof data.disabled === 'boolean' ? data.disabled : (existing?.disabled ?? false),
    profileSettings: normalizeProfileSettings(data.profileSettings, existing?.profileSettings),
    contact: normalizeContact(data.contact, existing?.contact),
    summary: toSafeString(data.summary, existing?.summary ?? ''),
    experience: normalizeExperience(data.experience, existing?.experience),
    strengths: normalizeStrengths(data.strengths, existing?.strengths),
    skills,
    education: normalizeEducation(data.education, existing?.education),
    certifications: normalizeCertifications(data.certifications, existing?.certifications),
  };
}

// Get all profiles
router.get('/', async (req: Request, res: Response) => {
  try {
    await ensureProfilesDir();
    const files = await fs.readdir(PROFILES_DIR);
    const profiles: Profile[] = [];
    const includeDisabled = req.query.includeDisabled === 'true';

    for (const file of files) {
      if (file.endsWith('.json')) {
        const content = await fs.readFile(path.join(PROFILES_DIR, file), 'utf-8');
        profiles.push(JSON.parse(content));
      }
    }

    // Sort by updatedAt descending
    profiles.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

    const filteredProfiles = includeDisabled
      ? profiles
      : profiles.filter((profile) => !profile.disabled);

    res.json(filteredProfiles);
  } catch (error) {
    console.error('Error fetching profiles:', error);
    res.status(500).json({ error: 'Failed to fetch profiles' });
  }
});

// Get single profile
router.get('/:id', async (req: Request<{ id: string }>, res: Response) => {
  try {
    const filePath = path.join(PROFILES_DIR, `${req.params.id}.json`);
    const content = await fs.readFile(filePath, 'utf-8');
    res.json(JSON.parse(content));
  } catch (error) {
    res.status(404).json({ error: 'Profile not found' });
  }
});

// Create profile (protected)
router.post('/', authMiddleware, async (req: Request, res: Response) => {
  try {
    await ensureProfilesDir();
    const data: CreateProfileDTO = req.body;
    const normalized = normalizeProfilePayload(data);
    
    const profile: Profile = {
      ...normalized,
      id: uuidv4(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    const filePath = path.join(PROFILES_DIR, `${profile.id}.json`);
    await fs.writeFile(filePath, JSON.stringify(profile, null, 2));

    res.status(201).json(profile);
  } catch (error) {
    console.error('Error creating profile:', error);
    const message = error instanceof Error ? error.message : 'Failed to create profile';
    const status = /output (token|file name)/i.test(message) ? 400 : 500;
    res.status(status).json({
      error: error instanceof Error ? error.message : 'Failed to create profile',
    });
  }
});

// Update profile (protected)
router.put('/:id', authMiddleware, async (req: Request<{ id: string }>, res: Response) => {
  try {
    const filePath = path.join(PROFILES_DIR, `${req.params.id}.json`);
    
    // Check if profile exists
    const existingContent = await fs.readFile(filePath, 'utf-8');
    const existingProfile: Profile = JSON.parse(existingContent);
    const normalized = normalizeProfilePayload(req.body as CreateProfileDTO, existingProfile);

    const updatedProfile: Profile = {
      ...normalized,
      id: existingProfile.id, // Preserve ID
      createdAt: existingProfile.createdAt, // Preserve creation date
      updatedAt: new Date().toISOString()
    };

    await fs.writeFile(filePath, JSON.stringify(updatedProfile, null, 2));

    res.json(updatedProfile);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Profile not found';
    const maybeNodeError = error as NodeJS.ErrnoException;
    res.status(maybeNodeError.code === 'ENOENT' ? 404 : 400).json({ error: message });
  }
});

// Delete profile (protected)
router.delete('/:id', authMiddleware, async (req: Request<{ id: string }>, res: Response) => {
  try {
    const filePath = path.join(PROFILES_DIR, `${req.params.id}.json`);
    await fs.unlink(filePath);
    res.json({ message: 'Profile deleted successfully' });
  } catch (error) {
    res.status(404).json({ error: 'Profile not found' });
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

    // Extract profile using Claude
    const extractedData = await extractProfileFromResume(pdfData.text);

    // Create profile
    await ensureProfilesDir();
    const normalized = normalizeProfilePayload(extractedData);
    const profile: Profile = {
      ...normalized,
      id: uuidv4(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };

    const filePath = path.join(PROFILES_DIR, `${profile.id}.json`);
    await fs.writeFile(filePath, JSON.stringify(profile, null, 2));

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
