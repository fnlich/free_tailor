/**
 * One-off import of the legacy JSON storage layout into the SQLite database.
 *
 * Usage:
 *   npm run migrate:legacy -- <legacy-data-dir>
 *
 * The legacy directory is the old `backend/data` folder, which held:
 *   profiles/*.json, groups/*.json, templates/*.json,
 *   prompts/custom-*.json, config/ai-models.json, config/prompt-library.json,
 *   skills/skills.json, bid-assistant/profiles/*.json,
 *   bid-assistant/job-applications.db
 *
 * Records that already exist in the database are left untouched.
 */
import fs from 'fs';
import path from 'path';
import { getDatabasePath, getDb } from '../database/sqlite';
import { hasProfile, saveProfile } from '../database/profileRepository';
import { getGroup, saveGroup } from '../database/groupRepository';
import { hasStoredTemplate, saveStoredTemplate } from '../database/templateRepository';
import { hasStoredPrompt, readActivePrompts, saveStoredPrompt, writeActivePrompts } from '../database/promptRepository';
import { getSettingRaw, setSetting } from '../database/settingsRepository';
import { migrate001 } from '../database/migrations/001_openrouter_to_claude_cli';
import { APP_SETTINGS_KEY } from '../config/aiModelConfig';
import { addSkill, isHardSkillCategory } from '../database/skillsDatabase';
import { buildNewProfile, buildUpdatedProfile } from '../services/profileService';
import { Profile } from '../types/profile';
import { Group } from '../types/group';
import { Template } from '../types/template';

type Counter = { imported: number; skipped: number };

function readJsonFiles(dir: string): Array<{ id: string; data: Record<string, unknown> }> {
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((entry) => entry.endsWith('.json'))
    .flatMap((entry) => {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, entry), 'utf8')) as Record<string, unknown>;
        return [{ id: entry.replace(/\.json$/, ''), data }];
      } catch {
        console.warn(`Skipping invalid JSON file: ${path.join(dir, entry)}`);
        return [];
      }
    });
}

function importProfiles(dirs: string[]): Counter {
  const counter: Counter = { imported: 0, skipped: 0 };
  for (const dir of dirs) {
    for (const { id, data } of readJsonFiles(dir)) {
      const profileId = typeof data.id === 'string' && data.id.trim() ? data.id.trim() : id;
      if (hasProfile(profileId)) {
        counter.skipped += 1;
        continue;
      }
      const base = buildNewProfile(data as Partial<Profile>, profileId);
      const profile: Profile = {
        ...buildUpdatedProfile(base, data as Partial<Profile>),
        createdAt: typeof data.createdAt === 'string' ? data.createdAt : base.createdAt,
        updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : base.updatedAt,
      };
      saveProfile(profile);
      counter.imported += 1;
    }
  }
  return counter;
}

function importGroups(dir: string): Counter {
  const counter: Counter = { imported: 0, skipped: 0 };
  for (const { id, data } of readJsonFiles(dir)) {
    const group = data as Partial<Group>;
    const groupId = group.id || id;
    if (getGroup(groupId)) {
      counter.skipped += 1;
      continue;
    }
    const now = new Date().toISOString();
    saveGroup({
      id: groupId,
      name: group.name || 'Untitled Group',
      profileIds: Array.isArray(group.profileIds) ? group.profileIds.filter((value) => typeof value === 'string') : [],
      createdAt: group.createdAt || now,
      updatedAt: group.updatedAt || now,
    });
    counter.imported += 1;
  }
  return counter;
}

function importTemplates(dir: string, staticTemplatesDir: string): Counter {
  const counter: Counter = { imported: 0, skipped: 0 };
  for (const { id, data } of readJsonFiles(dir)) {
    const template = data as Partial<Template>;
    const templateId = template.id || id;
    const isStatic = fs.existsSync(path.join(staticTemplatesDir, `${templateId}.json`));
    if (isStatic || hasStoredTemplate(templateId) || typeof template.htmlContent !== 'string') {
      counter.skipped += 1;
      continue;
    }
    const now = new Date().toISOString();
    saveStoredTemplate({
      id: templateId,
      name: template.name || templateId,
      description: template.description || '',
      disabled: template.disabled === true,
      htmlContent: template.htmlContent,
      cssContent: template.cssContent || '',
      sections: Array.isArray(template.sections) ? template.sections : [],
      createdAt: template.createdAt || now,
      updatedAt: template.updatedAt || now,
      ...(template.manualConfig ? { manualConfig: template.manualConfig } : {}),
    });
    counter.imported += 1;
  }
  return counter;
}

function importPrompts(dir: string, staticPromptsDir: string): Counter {
  const counter: Counter = { imported: 0, skipped: 0 };
  for (const { id, data } of readJsonFiles(dir)) {
    const promptId = typeof data.id === 'string' && data.id.trim() ? data.id.trim() : id;
    const isBuiltIn = fs.existsSync(path.join(staticPromptsDir, `${promptId}.json`));
    if (hasStoredPrompt(promptId) || typeof data.content !== 'string' || !data.content.trim()) {
      counter.skipped += 1;
      continue;
    }
    const now = new Date().toISOString();
    saveStoredPrompt({
      ...data,
      id: promptId,
      content: data.content,
      isBuiltIn,
      createdAt: typeof data.createdAt === 'string' ? data.createdAt : now,
      updatedAt: typeof data.updatedAt === 'string' ? data.updatedAt : now,
    });
    counter.imported += 1;
  }
  return counter;
}

function importPromptLibrary(configDir: string): boolean {
  const filePath = path.join(configDir, 'prompt-library.json');
  if (!fs.existsSync(filePath) || Object.keys(readActivePrompts()).length > 0) return false;
  const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { activePrompts?: Record<string, unknown> };
  const active: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed.activePrompts ?? {})) {
    if (typeof value === 'string' && value.trim()) active[key] = value.trim();
  }
  writeActivePrompts(active);
  return true;
}

function importAppSettings(configDir: string): boolean {
  const filePath = path.join(configDir, 'ai-models.json');
  if (!fs.existsSync(filePath) || getSettingRaw(APP_SETTINGS_KEY) !== null) return false;
  setSetting(APP_SETTINGS_KEY, JSON.parse(fs.readFileSync(filePath, 'utf8')));
  // A legacy `ai-models.json` is written here VERBATIM and unnormalized, and
  // this importer runs long after the boot migration stamped itself as done -
  // so `runDataMigrations` would return immediately on the version check and
  // leave the row we just planted un-migrated. `migrate001` is called directly
  // because it is idempotent by inspection rather than by version stamp.
  migrate001(getDb());
  return true;
}

function importSkills(skillsFile: string): Counter {
  const counter: Counter = { imported: 0, skipped: 0 };
  if (!fs.existsSync(skillsFile)) return counter;
  const parsed = JSON.parse(fs.readFileSync(skillsFile, 'utf8')) as { hard?: unknown[]; soft?: unknown[] };
  for (const item of parsed.hard ?? []) {
    const record = typeof item === 'string' ? { skill: item } : (item as { skill?: string; priority?: number; category?: string });
    if (!record.skill) continue;
    const result = addSkill('hard', record.skill, {
      priority: typeof record.priority === 'number' ? record.priority : undefined,
      category: isHardSkillCategory(record.category) ? record.category : undefined,
    });
    counter[result.added ? 'imported' : 'skipped'] += 1;
  }
  for (const item of parsed.soft ?? []) {
    if (typeof item !== 'string') continue;
    const result = addSkill('soft', item);
    counter[result.added ? 'imported' : 'skipped'] += 1;
  }
  return counter;
}

/** Copies the bid-assistant tables from the legacy standalone database. */
function importBidAssistantDatabase(legacyDbPath: string): Record<string, number> {
  const copied: Record<string, number> = {};
  if (!fs.existsSync(legacyDbPath)) return copied;

  const db = getDb();
  db.exec(`ATTACH DATABASE '${legacyDbPath.replace(/'/g, "''")}' AS legacy`);
  try {
    const legacyTables = new Set(
      (db.prepare("SELECT name FROM legacy.sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
        .map((row) => row.name)
    );
    const tables = ['jobs', 'answers', 'google_sheets', 'app_settings'];
    db.transaction(() => {
      for (const table of tables) {
        if (!legacyTables.has(table)) continue;
        const columns = (db.prepare(`PRAGMA main.table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
        const legacyColumns = new Set(
          (db.prepare(`PRAGMA legacy.table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name)
        );
        const shared = columns.filter((column) => legacyColumns.has(column));
        if (shared.length === 0) continue;
        const list = shared.join(', ');
        const result = db.prepare(`INSERT OR IGNORE INTO main.${table} (${list}) SELECT ${list} FROM legacy.${table}`).run();
        copied[table] = result.changes;
      }
    })();
  } finally {
    db.exec('DETACH DATABASE legacy');
  }
  return copied;
}

function main(): void {
  const legacyDir = process.argv[2] ? path.resolve(process.argv[2]) : '';
  if (!legacyDir || !fs.existsSync(legacyDir)) {
    console.error('Usage: npm run migrate:legacy -- <path-to-legacy-data-dir>');
    process.exit(1);
  }

  // Ensure bid-assistant tables exist before copying legacy rows into them.
  require('../bidAssistant/database');

  const staticDir = path.join(__dirname, '..', '..', 'static');
  console.log(`Importing legacy data from ${legacyDir} into ${getDatabasePath()}`);
  console.log('profiles:', importProfiles([path.join(legacyDir, 'profiles'), path.join(legacyDir, 'bid-assistant', 'profiles')]));
  console.log('groups:', importGroups(path.join(legacyDir, 'groups')));
  console.log('templates:', importTemplates(path.join(legacyDir, 'templates'), path.join(staticDir, 'templates')));
  console.log('prompts:', importPrompts(path.join(legacyDir, 'prompts'), path.join(staticDir, 'prompts')));
  console.log('active prompts:', importPromptLibrary(path.join(legacyDir, 'config')) ? 'imported' : 'skipped');
  console.log('app settings:', importAppSettings(path.join(legacyDir, 'config')) ? 'imported' : 'skipped');
  console.log('skills:', importSkills(path.join(legacyDir, 'skills', 'skills.json')));
  console.log('bid-assistant tables:', importBidAssistantDatabase(path.join(legacyDir, 'bid-assistant', 'job-applications.db')));
  console.log('Done.');
}

main();
