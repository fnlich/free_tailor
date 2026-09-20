import type Database from 'better-sqlite3';

/**
 * Hands the profiles and groups that predate accounts to the first admin.
 *
 * Ownership arrives with v2, and every row written before it has none. Left
 * that way they would belong to nobody, and a scoped list - which is what every
 * read becomes - would show a user their own empty app while their profiles sat
 * in the database. So they go to the first admin, who is the closest thing to
 * "whoever was using this install", and an admin can hand them on from there.
 *
 * It only runs once there IS an admin. A fresh install migrates before anybody
 * has signed in, so the step reports nothing to do and, crucially, does not
 * write its version - it is retried on each boot until the first sign-in
 * creates the admin it needs.
 */

export const OWNERSHIP_SCHEMA_VERSION = 3;

export type OwnershipMigrationReport = {
  ran: boolean;
  /** False when there is no admin yet, which is not a failure. */
  deferred: boolean;
  profiles: number;
  groups: number;
  ownerEmail: string;
  notes: string[];
};

function hasColumn(db: Database.Database, table: string, column: string): boolean {
  try {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    return columns.some((entry) => entry.name === column);
  } catch {
    return false;
  }
}

export function migrate003(db: Database.Database): OwnershipMigrationReport {
  const report: OwnershipMigrationReport = {
    ran: false,
    deferred: false,
    profiles: 0,
    groups: 0,
    ownerEmail: '',
    notes: [],
  };

  const admin = db
    .prepare("SELECT id, email FROM users WHERE role = 'admin' ORDER BY created_at ASC LIMIT 1")
    .get() as { id: string; email: string } | undefined;

  if (!admin) {
    report.deferred = true;
    return report;
  }

  const targets: Array<{ table: string; key: 'profiles' | 'groups' }> = [
    { table: 'profiles', key: 'profiles' },
    { table: 'profile_groups', key: 'groups' },
  ];

  db.transaction(() => {
    for (const target of targets) {
      if (!hasColumn(db, target.table, 'owner_id')) {
        report.notes.push(
          `${target.table} has no owner_id column, so its rows were left unowned. ` +
            'They will be assigned on the next start if the column can be added.'
        );
        continue;
      }

      // BOTH the column and the JSON. The column is what the count and the
      // limit read; the JSON blob is what every actual read parses back into a
      // Profile. Setting only the column leaves rows that the database says
      // belong to the admin and the app says belong to nobody - which is worse
      // than not migrating at all, because the count is then right and the
      // list is empty.
      const rows = db
        .prepare(`SELECT id, data FROM ${target.table} WHERE owner_id IS NULL OR owner_id = ''`)
        .all() as Array<{ id: string; data: string }>;

      const write = db.prepare(`UPDATE ${target.table} SET owner_id = ?, data = ? WHERE id = ?`);
      for (const row of rows) {
        let document: Record<string, unknown>;
        try {
          const parsed = JSON.parse(row.data) as unknown;
          if (!parsed || typeof parsed !== 'object') throw new Error('not an object');
          document = parsed as Record<string, unknown>;
        } catch {
          // A row this build cannot parse is left exactly as it is. Writing a
          // repaired blob over it would destroy whatever it actually holds.
          report.notes.push(`${target.table} row ${row.id} could not be read, so it was left unowned.`);
          continue;
        }
        document.ownerId = admin.id;
        write.run(admin.id, JSON.stringify(document), row.id);
        report[target.key] += 1;
      }
    }
  })();

  report.ran = report.profiles > 0 || report.groups > 0;
  report.ownerEmail = admin.email;
  return report;
}
