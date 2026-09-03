import { Router, Request, Response } from 'express';
import fs from 'fs/promises';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { Group, CreateGroupDTO } from '../types/group';

const router = Router();
const GROUPS_DIR = path.join(__dirname, '../../data/groups');

async function ensureGroupsDir(): Promise<void> {
  try {
    await fs.access(GROUPS_DIR);
  } catch {
    await fs.mkdir(GROUPS_DIR, { recursive: true });
  }
}

function normalizeProfileIds(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const ids: string[] = [];
  for (const item of input) {
    if (typeof item !== 'string') continue;
    const id = item.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    ids.push(id);
  }
  return ids;
}

function normalizeGroupPayload(input: CreateGroupDTO, existing?: Group): Omit<Group, 'id' | 'createdAt' | 'updatedAt'> {
  return {
    name: typeof input.name === 'string' && input.name.trim()
      ? input.name.trim()
      : (existing?.name ?? 'Untitled Group'),
    profileIds: normalizeProfileIds(input.profileIds ?? existing?.profileIds ?? []),
  };
}

router.get('/', async (_req: Request, res: Response) => {
  try {
    await ensureGroupsDir();
    const files = await fs.readdir(GROUPS_DIR);
    const groups: Group[] = [];

    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const content = await fs.readFile(path.join(GROUPS_DIR, file), 'utf-8');
        groups.push(JSON.parse(content) as Group);
      } catch {
        // Skip invalid files
      }
    }

    groups.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
    res.json(groups);
  } catch (error) {
    console.error('Error fetching groups:', error);
    res.status(500).json({ error: 'Failed to fetch groups' });
  }
});

router.get('/:id', async (req: Request<{ id: string }>, res: Response) => {
  try {
    const filePath = path.join(GROUPS_DIR, `${req.params.id}.json`);
    const content = await fs.readFile(filePath, 'utf-8');
    res.json(JSON.parse(content) as Group);
  } catch {
    res.status(404).json({ error: 'Group not found' });
  }
});

router.post('/', async (req: Request, res: Response) => {
  try {
    await ensureGroupsDir();
    const input = req.body as CreateGroupDTO;
    const normalized = normalizeGroupPayload(input);

    if (!normalized.name) {
      res.status(400).json({ error: 'Group name is required' });
      return;
    }

    const now = new Date().toISOString();
    const group: Group = {
      ...normalized,
      id: uuidv4(),
      createdAt: now,
      updatedAt: now,
    };

    const filePath = path.join(GROUPS_DIR, `${group.id}.json`);
    await fs.writeFile(filePath, JSON.stringify(group, null, 2));
    res.status(201).json(group);
  } catch (error) {
    console.error('Error creating group:', error);
    res.status(500).json({ error: 'Failed to create group' });
  }
});

router.put('/:id', async (req: Request<{ id: string }>, res: Response) => {
  try {
    await ensureGroupsDir();
    const filePath = path.join(GROUPS_DIR, `${req.params.id}.json`);
    const existingContent = await fs.readFile(filePath, 'utf-8');
    const existing = JSON.parse(existingContent) as Group;

    const normalized = normalizeGroupPayload(req.body as CreateGroupDTO, existing);
    const updated: Group = {
      ...normalized,
      id: existing.id,
      createdAt: existing.createdAt,
      updatedAt: new Date().toISOString(),
    };

    await fs.writeFile(filePath, JSON.stringify(updated, null, 2));
    res.json(updated);
  } catch {
    res.status(404).json({ error: 'Group not found' });
  }
});

router.delete('/:id', async (req: Request<{ id: string }>, res: Response) => {
  try {
    const filePath = path.join(GROUPS_DIR, `${req.params.id}.json`);
    await fs.unlink(filePath);
    res.json({ message: 'Group deleted successfully' });
  } catch {
    res.status(404).json({ error: 'Group not found' });
  }
});

export default router;
