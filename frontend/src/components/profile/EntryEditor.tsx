'use client';

import { useCallback, useState } from 'react';
import { IconSparkle, IconTrash } from '@/components/icons';
import { ErrorNotice, Field, Spinner } from '@/components/ui/kit';
import {
  achievementsFromText,
  bulletCountNote,
  bulletsBlocker,
  bulletsRequestFor,
  bulletsTask,
  cleanSkillName,
  hasSkill,
  replaceEntry,
  type DraftEntry,
  type EntryRef,
  type ProfileDraft,
} from '@/lib/profileDraft';
import type { FieldSpec, SectionSpec } from '@/lib/profileSections';
import { AddInput, ChipList, DoneButton, EditorPanel, type UpdateDraft } from './parts';
import { useWriteBullets } from './useWriteBullets';
import css from './profileEditor.module.css';

/** The longest note the button sends with a request; the server cuts at 500, so this is well inside it. */
const MAX_INSTRUCTIONS_LENGTH = 300;

function fieldValue(row: object, name: string): string {
  const value = (row as Record<string, unknown>)[name];
  return typeof value === 'string' ? value : '';
}

/**
 * The Edit Entry panel: one entry's fields over `spec.fields`, two to a row
 * on a wide form, then - for a role - the skills it used, then - for a kind
 * with bullets - the achievements box with Write with AI under it. Delete is
 * the bin beside the title, Done the gradient at the foot. Mounted keyed by
 * the row, so its state is the row's.
 *
 * Every change goes into the draft at once (the preview keeps up); Done only
 * closes the panel, and the editor drops a row left blank.
 */
export function EntryEditor({
  spec,
  entryRef,
  row,
  draft,
  update,
  sectionLabel,
  libraryListId,
  ensureLibrarySkill,
  onDone,
  onBack,
  onDelete,
}: {
  spec: SectionSpec;
  entryRef: EntryRef;
  row: DraftEntry;
  draft: ProfileDraft;
  update: UpdateDraft;
  /** The card the row belongs to, for the panel's title. */
  sectionLabel: string;
  /** The shared <datalist> of the hard-skill library, for a role's skills. */
  libraryListId: string;
  /** The library's spelling of a skill, adding it first when the library lacks it. */
  ensureLibrarySkill: (skill: string) => Promise<string>;
  onDone: () => void;
  onBack: () => void;
  onDelete: () => void;
}) {
  const patch = useCallback(
    (change: object, immediate = false) => update((current) => replaceEntry(current, entryRef, change), { immediate }),
    [update, entryRef]
  );

  const noun = spec.entryNoun;
  const title = `Edit ${noun}`;

  return (
    <EditorPanel
      title={title}
      eyebrow={sectionLabel}
      onBack={onBack}
      actions={
        <button
          type="button"
          className={css.iconButton}
          data-tone="danger"
          onClick={onDelete}
          aria-label={`Delete this ${noun}`}
          title="Delete"
        >
          <IconTrash className="h-[18px] w-[18px]" />
        </button>
      }
      footer={<DoneButton onClick={onDone} />}
    >
      <div className="grid grid-cols-1 gap-x-4 gap-y-5 @lg:grid-cols-2">
        {spec.fields.map((field, index) => (
          <EntryField
            key={field.name}
            field={field}
            id={`entry-${field.name}-${row.key}`}
            value={fieldValue(row, field.name)}
            onChange={(value) => patch({ [field.name]: value })}
            autoFocus={index === 0}
          />
        ))}
      </div>
      {entryRef.kind === 'experience' && (
        <ExperienceSkills
          row={row}
          rowKey={row.key}
          patch={patch}
          update={update}
          libraryListId={libraryListId}
          ensureLibrarySkill={ensureLibrarySkill}
        />
      )}
      {spec.hasBullets && <Bullets spec={spec} row={row} draft={draft} patch={patch} />}
    </EditorPanel>
  );
}

function EntryField({
  field,
  id,
  value,
  onChange,
  autoFocus,
}: {
  field: FieldSpec;
  id: string;
  value: string;
  onChange: (value: string) => void;
  autoFocus: boolean;
}) {
  const wide = field.wide ? '@lg:col-span-2' : '';
  if (field.input === 'textarea') {
    return (
      <div className={wide}>
        <Field label={field.label} htmlFor={id}>
          <textarea
            id={id}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            className="tl-input"
            rows={2}
            placeholder={field.placeholder}
            autoFocus={autoFocus}
          />
        </Field>
      </div>
    );
  }
  // Text for every box, the url ones included: the browser's url check
  // refuses `github.com/x` and would block the whole save; `inputMode` still
  // brings up the right keyboard. Email and phone keep their own types, which
  // only pick a keyboard too.
  const type = field.input === 'email' || field.input === 'tel' ? field.input : 'text';
  return (
    <div className={wide}>
      <Field label={field.label} htmlFor={id}>
        <input
          id={id}
          type={type}
          inputMode={field.input === 'url' ? 'url' : undefined}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          className="tl-input"
          placeholder={field.placeholder}
          autoComplete="off"
          autoFocus={autoFocus}
        />
      </Field>
    </div>
  );
}

/**
 * A role's skills. A skill used in a role is a skill the profile claims, so
 * it joins the Technical Skills list too - as the old form did - through the
 * library's spelling of it.
 */
function ExperienceSkills({
  row,
  rowKey,
  patch,
  update,
  libraryListId,
  ensureLibrarySkill,
}: {
  row: DraftEntry;
  rowKey: string;
  patch: (change: object) => void;
  update: UpdateDraft;
  libraryListId: string;
  ensureLibrarySkill: (skill: string) => Promise<string>;
}) {
  const [pending, setPending] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const skills = 'skills' in row && Array.isArray(row.skills) ? row.skills : [];

  const addSkill = async () => {
    const value = cleanSkillName(pending);
    if (!value) return;
    if (hasSkill(skills, value)) {
      setPending('');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const skill = await ensureLibrarySkill(value);
      update((current) => ({
        ...current,
        experience: current.experience.map((item) =>
          item.key === rowKey && !hasSkill(item.skills, skill) ? { ...item, skills: [...item.skills, skill] } : item
        ),
        skills: hasSkill(current.skills, skill) ? current.skills : [...current.skills, skill],
      }));
      setPending('');
    } catch (err) {
      setError(err ?? 'Failed to add the skill.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Field label="Skills used" htmlFor={`experience-skill-${rowKey}`}>
      <div className="space-y-3">
        <AddInput
          id={`experience-skill-${rowKey}`}
          list={libraryListId}
          value={pending}
          onChange={setPending}
          onAdd={addSkill}
          busy={busy}
          placeholder="Select or add a hard skill"
          label="Add a skill to this role"
        />
        <ErrorNotice error={error} onDismiss={() => setError(null)} />
        <ChipList
          items={skills}
          tone="sky"
          onRemove={(skill) => patch({ skills: skills.filter((item) => item !== skill) })}
        />
      </div>
    </Field>
  );
}

/**
 * The achievements box and, for the kinds the route serves, Write with AI
 * under it: the button, a one-line note for the model, and the state of the
 * last call - running, its failure, or its answer with Undo.
 */
function Bullets({
  spec,
  row,
  draft,
  patch,
}: {
  spec: SectionSpec;
  row: DraftEntry;
  draft: ProfileDraft;
  patch: (change: object, immediate?: boolean) => void;
}) {
  const text = fieldValue(row, 'achievementsText');
  const apply = useCallback((next: string) => patch({ achievementsText: next }, true), [patch]);
  const ai = useWriteBullets(apply);
  const [instructions, setInstructions] = useState('');

  const aiKind = spec.aiKind;
  const task = bulletsTask(text);
  const blocker = aiKind ? bulletsBlocker(aiKind, row) : null;
  const running = ai.state.status === 'running';
  const countNote = bulletCountNote(text);

  const ask = () => {
    if (!aiKind || blocker || running) return;
    void ai.run(bulletsRequestFor(aiKind, row, draft, task, instructions), text);
  };

  const done = ai.state.status === 'done' && ai.state.replacedWith === text ? ai.state : null;

  return (
    <div className="space-y-3">
      <Field label="Achievements, one per line" htmlFor={`entry-achievements-${row.key}`} hint={countNote ?? undefined}>
        <textarea
          id={`entry-achievements-${row.key}`}
          placeholder={'Led a team of 5 engineers...\nImproved performance by 50%...'}
          value={text}
          onChange={(event) => patch({ achievementsText: event.target.value })}
          className="tl-input"
          rows={Math.min(12, Math.max(4, achievementsFromText(text).length + 1))}
          disabled={running}
        />
      </Field>
      {aiKind && (
        <div className="space-y-2">
          <div className={css.aiRow}>
            <button
              type="button"
              className={css.aiButton}
              onClick={ask}
              disabled={Boolean(blocker) || running}
              aria-describedby={blocker ? `entry-ai-blocker-${row.key}` : undefined}
            >
              <IconSparkle className="h-[18px] w-[18px]" strokeWidth={2} />
              {task === 'improve' ? 'Improve with AI' : 'Write with AI'}
            </button>
            <input
              type="text"
              className="tl-input"
              aria-label="A note for the AI (optional)"
              placeholder="Optional: what to bring out, e.g. the cost savings"
              maxLength={MAX_INSTRUCTIONS_LENGTH}
              value={instructions}
              disabled={running}
              onChange={(event) => setInstructions(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== 'Enter') return;
                event.preventDefault();
                ask();
              }}
            />
          </div>
          {blocker && (
            <p id={`entry-ai-blocker-${row.key}`} className="text-sm text-subtle">
              {blocker}
            </p>
          )}
          {running && <Spinner compact label={task === 'improve' ? 'Improving the bullets...' : 'Writing the bullets...'} />}
          {ai.state.status === 'failed' && <ErrorNotice error={ai.state.error} onDismiss={ai.reset} />}
          {done && (
            <p className="tl-status" data-tone="ok" role="status">
              {done.task === 'improve' ? 'Bullets improved.' : 'Bullets written.'}{' '}
              <button type="button" className="tl-link" onClick={ai.undo}>
                Undo
              </button>
            </p>
          )}
        </div>
      )}
    </div>
  );
}
