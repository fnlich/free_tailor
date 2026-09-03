import { Request, Response } from 'express';
import {
  HardSkillCategory,
  SkillDatabaseError,
  addSkill,
  deleteSkill,
  isHardSkillCategory,
  isSkillType,
  readSkills,
  updateSkill,
} from '../database/skillsDatabase';
import { refreshAllowedTechSkills } from '../generators/pdfGenerator';
import { refreshSkillCaches } from '../services/claude';

type SkillBody = {
  type?: unknown;
  skill?: unknown;
  original?: unknown;
  priority?: unknown;
  category?: unknown;
};

function parseSkillValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function parsePriority(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(parsed)) return null;
  const priority = Math.trunc(parsed);
  return priority >= 1 && priority <= 5 ? priority : null;
}

function parseHardSkillMetadata(body: SkillBody): { priority: number; category: HardSkillCategory } | null {
  const priority = parsePriority(body.priority);
  return priority !== null && isHardSkillCategory(body.category)
    ? { priority, category: body.category }
    : null;
}

function sendSkillError(res: Response, error: unknown, fallbackMessage: string): void {
  if (error instanceof SkillDatabaseError) {
    res.status(error.statusCode).json({ error: error.message });
    return;
  }

  console.error(fallbackMessage, error);
  res.status(500).json({ error: fallbackMessage });
}

function refreshCachesForType(type: 'hard' | 'soft'): void {
  refreshSkillCaches();
  if (type === 'hard') {
    refreshAllowedTechSkills();
  }
}

export function listSkills(req: Request, res: Response): void {
  try {
    const { type } = req.query;
    if (!isSkillType(type)) {
      res.status(400).json({ error: 'Skill type is required' });
      return;
    }

    res.json({ skills: readSkills(type) });
  } catch (error) {
    sendSkillError(res, error, 'Failed to read skills');
  }
}

export function confirmSkill(req: Request, res: Response): void {
  try {
    const { type, skill } = req.body as SkillBody;
    if (!isSkillType(type) || !parseSkillValue(skill)) {
      res.status(400).json({ error: 'Skill type and value are required' });
      return;
    }

    const result = addSkill(type, parseSkillValue(skill));
    if (result.added) {
      refreshCachesForType(type);
    }

    res.json(result);
  } catch (error) {
    sendSkillError(res, error, 'Failed to confirm skill');
  }
}

export function createSkill(req: Request, res: Response): void {
  try {
    const body = req.body as SkillBody;
    const { type, skill } = body;
    if (!isSkillType(type) || !parseSkillValue(skill)) {
      res.status(400).json({ error: 'Skill type and value are required' });
      return;
    }

    const metadata = type === 'hard' ? parseHardSkillMetadata(body) : null;
    if (type === 'hard' && !metadata) {
      res.status(400).json({ error: 'Tech skill category and priority are required' });
      return;
    }

    const result = addSkill(type, parseSkillValue(skill), metadata ?? undefined);
    if (result.added) {
      refreshCachesForType(type);
    }

    res.json(result);
  } catch (error) {
    sendSkillError(res, error, 'Failed to add skill');
  }
}

export function updateSkillHandler(req: Request, res: Response): void {
  try {
    const body = req.body as SkillBody;
    const { type, original, skill } = body;
    if (!isSkillType(type) || !parseSkillValue(original) || !parseSkillValue(skill)) {
      res.status(400).json({ error: 'Skill type, original value, and new value are required' });
      return;
    }

    const metadata = type === 'hard' && (body.category !== undefined || body.priority !== undefined)
      ? parseHardSkillMetadata(body)
      : null;
    if (type === 'hard' && (body.category !== undefined || body.priority !== undefined) && !metadata) {
      res.status(400).json({ error: 'Valid tech skill category and priority are required' });
      return;
    }

    const result = updateSkill(type, parseSkillValue(original), parseSkillValue(skill), metadata ?? undefined);
    refreshCachesForType(type);
    res.json(result);
  } catch (error) {
    sendSkillError(res, error, 'Failed to update skill');
  }
}

export function deleteSkillHandler(req: Request, res: Response): void {
  try {
    const { type, skill } = req.body as SkillBody;
    if (!isSkillType(type) || !parseSkillValue(skill)) {
      res.status(400).json({ error: 'Skill type and value are required' });
      return;
    }

    const result = deleteSkill(type, parseSkillValue(skill));
    refreshCachesForType(type);
    res.json(result);
  } catch (error) {
    sendSkillError(res, error, 'Failed to delete skill');
  }
}
