import path from 'path';

/**
 * Resolves the directory that holds read-only, shipped assets:
 * default prompts, the skill library seed, and built-in resume templates.
 * Dynamic data never lives here; it is stored in the SQLite database.
 */
export function getStaticDir(): string {
  const configured = process.env.TAILOR_STATIC_DIR?.trim();
  return configured ? path.resolve(configured) : path.join(__dirname, '..', '..', 'static');
}

export function getStaticPromptsDir(): string {
  return path.join(getStaticDir(), 'prompts');
}

export function getStaticTemplatesDir(): string {
  return path.join(getStaticDir(), 'templates');
}

export function getStaticSkillsFile(): string {
  return path.join(getStaticDir(), 'skills', 'skills.json');
}
