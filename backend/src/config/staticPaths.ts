import path from 'path';

/**
 * Resolves the directory that holds shipped assets: default prompts, the
 * skill library seed, and built-in resume templates.
 *
 * Never written - with one exception: `templates/` also holds the templates an
 * administrator saves (imported, extracted, built), as `<id>.json` files with
 * a `source` field (see database/templateFiles.ts). Everything else dynamic is
 * in the SQLite database.
 */
export function getStaticDir(): string {
  const configured = process.env.TAILOR_STATIC_DIR?.trim();
  return configured ? path.resolve(configured) : path.join(__dirname, '..', '..', 'static');
}

export function getStaticPromptsDir(): string {
  return path.join(getStaticDir(), 'prompts');
}

/** Built-in templates AND saved ones; a file with a `source` field is a saved one. */
export function getStaticTemplatesDir(): string {
  return path.join(getStaticDir(), 'templates');
}

export function getStaticSkillsFile(): string {
  return path.join(getStaticDir(), 'skills', 'skills.json');
}
