import { Router, Request, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { Group, CreateGroupDTO } from '../types/group';
import { deleteGroup, getGroup, listGroups, saveGroup } from '../database/groupRepository';

const router = Router();

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

router.get('/', (_req: Request, res: Response) => {
  try {
    res.json(listGroups());
  } catch (error) {
    console.error('Error fetching groups:', error);
    res.status(500).json({ error: 'Failed to fetch groups' });
  }
});

router.get('/:id', (req: Request<{ id: string }>, res: Response) => {
  const group = getGroup(req.params.id);
  if (!group) {
    res.status(404).json({ error: 'Group not found' });
    return;
  }
  res.json(group);
});

router.post('/', (req: Request, res: Response) => {
  try {
    const normalized = normalizeGroupPayload(req.body as CreateGroupDTO);
    if (!normalized.name) {
      res.status(400).json({ error: 'Group name is required' });
      return;
    }

    const now = new Date().toISOString();
    const group = saveGroup({
      ...normalized,
      id: uuidv4(),
      createdAt: now,
      updatedAt: now,
    });
    res.status(201).json(group);
  } catch (error) {
    console.error('Error creating group:', error);
    res.status(500).json({ error: 'Failed to create group' });
  }
});

router.put('/:id', (req: Request<{ id: string }>, res: Response) => {
  const existing = getGroup(req.params.id);
  if (!existing) {
    res.status(404).json({ error: 'Group not found' });
    return;
  }

  const updated = saveGroup({
    ...normalizeGroupPayload(req.body as CreateGroupDTO, existing),
    id: existing.id,
    createdAt: existing.createdAt,
    updatedAt: new Date().toISOString(),
  });
  res.json(updated);
});

router.delete('/:id', (req: Request<{ id: string }>, res: Response) => {
  if (!deleteGroup(req.params.id)) {
    res.status(404).json({ error: 'Group not found' });
    return;
  }
  res.json({ message: 'Group deleted successfully' });
});

export default router;
