'use client';

import { useEffect, useState } from 'react';
import { AdminOnly } from '@/components/auth/AuthGate';
import { HARD_SKILL_CATEGORIES, resumeApi, type HardSkillCategory } from '@/lib/api';
import { Field, Notice, Spinner } from '@/components/ui/kit';
import { messageWithDetail } from '@/lib/userMessage';

type SkillType = 'hard' | 'soft';
type SortOption = 'az' | 'za';

type EditingState = {
  type: SkillType;
  original: string;
  value: string;
} | null;

const normalize = (value: string) => value.trim().toLowerCase();
const PAGE_SIZE_OPTIONS = [10, 25, 50];
const PRIORITY_OPTIONS = [1, 2, 3, 4, 5];

function SkillsPageBody() {
  const [techSkills, setTechSkills] = useState<string[]>([]);
  const [softSkills, setSoftSkills] = useState<string[]>([]);
  const [newTech, setNewTech] = useState('');
  const [newTechCategory, setNewTechCategory] = useState<HardSkillCategory>('Languages');
  const [newTechPriority, setNewTechPriority] = useState(3);
  const [newSoft, setNewSoft] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [techSort, setTechSort] = useState<SortOption>('az');
  const [softSort, setSoftSort] = useState<SortOption>('az');
  const [techPage, setTechPage] = useState(1);
  const [softPage, setSoftPage] = useState(1);
  const [techPageSize, setTechPageSize] = useState(10);
  const [softPageSize, setSoftPageSize] = useState(10);
  const [editing, setEditing] = useState<EditingState>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const loadSkills = async () => {
    try {
      setIsLoading(true);
      const [tech, soft] = await Promise.all([
        resumeApi.listSkills('hard'),
        resumeApi.listSkills('soft'),
      ]);
      setTechSkills(tech.skills);
      setSoftSkills(soft.skills);
    } catch (err) {
      setError(messageWithDetail(err, 'Failed to load skills'));
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    loadSkills();
  }, []);

  const addSkill = async (
    type: SkillType,
    value: string,
    metadata?: { category: HardSkillCategory; priority: number }
  ) => {
    const cleaned = value.trim();
    if (!cleaned) return;

    const list = type === 'hard' ? techSkills : softSkills;
    if (list.some((item) => normalize(item) === normalize(cleaned))) {
      setError('Skill already exists.');
      return;
    }

    try {
      setIsSaving(true);
      setError('');
      setSuccess('');
      const res = await resumeApi.addSkill({ type, skill: cleaned, ...metadata });
      if (!res.added) {
        setError('Skill already exists.');
        return;
      }
      if (type === 'hard') {
        setTechSkills((prev) => [...prev, cleaned]);
        setNewTech('');
        setTechPage(1);
      } else {
        setSoftSkills((prev) => [...prev, cleaned]);
        setNewSoft('');
        setSoftPage(1);
      }
      setSuccess(`Added "${cleaned}".`);
    } catch (err) {
      setError(messageWithDetail(err, 'Failed to add skill'));
    } finally {
      setIsSaving(false);
    }
  };

  const updateSkill = async (type: SkillType, original: string, nextValue: string) => {
    const cleaned = nextValue.trim();
    if (!cleaned) return;

    const list = type === 'hard' ? techSkills : softSkills;
    if (list.some((item) => normalize(item) === normalize(cleaned) && normalize(item) !== normalize(original))) {
      setError('Skill already exists.');
      return;
    }

    try {
      setIsSaving(true);
      setError('');
      setSuccess('');
      await resumeApi.updateSkill({ type, original, skill: cleaned });
      const updateList = (items: string[]) => items.map((item) => (item === original ? cleaned : item));
      if (type === 'hard') {
        setTechSkills(updateList);
      } else {
        setSoftSkills(updateList);
      }
      setEditing(null);
      setSuccess(`Updated "${original}".`);
    } catch (err) {
      setError(messageWithDetail(err, 'Failed to update skill'));
    } finally {
      setIsSaving(false);
    }
  };

  const deleteSkill = async (type: SkillType, skill: string) => {
    try {
      setIsSaving(true);
      setError('');
      setSuccess('');
      await resumeApi.deleteSkill({ type, skill });
      const remove = (items: string[]) => items.filter((item) => item !== skill);
      if (type === 'hard') {
        setTechSkills(remove);
        setTechPage(1);
      } else {
        setSoftSkills(remove);
        setSoftPage(1);
      }
      if (editing && editing.original === skill) {
        setEditing(null);
      }
      setSuccess(`Deleted "${skill}".`);
    } catch (err) {
      setError(messageWithDetail(err, 'Failed to delete skill'));
    } finally {
      setIsSaving(false);
    }
  };

  const buildVisibleSkills = (skills: string[], query: string, sort: SortOption) => {
    const filtered = skills.filter((skill) => normalize(skill).includes(normalize(query)));
    filtered.sort((left, right) =>
      sort === 'az'
        ? left.localeCompare(right, undefined, { sensitivity: 'base' })
        : right.localeCompare(left, undefined, { sensitivity: 'base' })
    );
    return filtered;
  };

  const techVisibleSkills = buildVisibleSkills(techSkills, searchQuery, techSort);
  const softVisibleSkills = buildVisibleSkills(softSkills, searchQuery, softSort);
  const techTotalPages = Math.max(1, Math.ceil(techVisibleSkills.length / techPageSize));
  const softTotalPages = Math.max(1, Math.ceil(softVisibleSkills.length / softPageSize));
  const safeTechPage = Math.min(techPage, techTotalPages);
  const safeSoftPage = Math.min(softPage, softTotalPages);
  const techPageItems = techVisibleSkills.slice((safeTechPage - 1) * techPageSize, safeTechPage * techPageSize);
  const softPageItems = softVisibleSkills.slice((safeSoftPage - 1) * softPageSize, safeSoftPage * softPageSize);

  const renderList = (
    type: SkillType,
    allSkills: string[],
    visibleSkills: string[],
    pageItems: string[],
    sort: SortOption,
    page: number,
    totalPages: number,
    pageSize: number
  ) => (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="grid grid-cols-2 gap-2 sm:w-[18rem]">
          <select
            value={sort}
            onChange={(e) => {
              const nextSort = e.target.value as SortOption;
              if (type === 'hard') {
                setTechSort(nextSort);
                setTechPage(1);
              } else {
                setSoftSort(nextSort);
                setSoftPage(1);
              }
            }}
            aria-label={type === 'hard' ? 'Sort tech skills' : 'Sort soft skills'}
            className="tl-input"
          >
            <option value="az">Sort: A to Z</option>
            <option value="za">Sort: Z to A</option>
          </select>
          <select
            value={String(pageSize)}
            onChange={(e) => {
              const nextPageSize = Number(e.target.value);
              if (type === 'hard') {
                setTechPageSize(nextPageSize);
                setTechPage(1);
              } else {
                setSoftPageSize(nextPageSize);
                setSoftPage(1);
              }
            }}
            aria-label={type === 'hard' ? 'Tech skills per page' : 'Soft skills per page'}
            className="tl-input"
          >
            {PAGE_SIZE_OPTIONS.map((option) => (
              <option key={`${type}-page-size-${option}`} value={option}>
                {option}/page
              </option>
            ))}
          </select>
        </div>

        <div className="flex items-center gap-3 text-xs text-subtle">
          <span>
            {visibleSkills.length} {searchQuery.trim() ? 'matching' : 'visible'} skills
          </span>
          <span>{allSkills.length} total</span>
        </div>
      </div>

      <div className="tl-rows">
        {visibleSkills.length === 0 && (
          <div className="px-4 py-6 text-center text-sm text-muted">
            {searchQuery.trim() ? 'No skills match your search.' : 'No skills yet.'}
          </div>
        )}

        {pageItems.map((skill) => {
          const isEditing = editing?.type === type && editing?.original === skill;
          return (
            <div key={`${type}-${skill}`} className="flex items-center gap-2 px-4 py-2">
              {isEditing ? (
                <input
                  type="text"
                  value={editing?.value ?? ''}
                  onChange={(e) => setEditing({ type, original: skill, value: e.target.value })}
                  aria-label={`Rename ${skill}`}
                  className="tl-input min-w-0 flex-1"
                />
              ) : (
                <span className="min-w-0 flex-1 break-words text-sm text-ink">{skill}</span>
              )}
              {isEditing ? (
                <>
                  <button
                    type="button"
                    onClick={() => updateSkill(type, skill, editing?.value ?? '')}
                    disabled={isSaving}
                    className="tl-button"
                    data-size="sm"
                  >
                    Save
                  </button>
                  <button
                    type="button"
                    onClick={() => setEditing(null)}
                    disabled={isSaving}
                    className="tl-button-quiet"
                    data-size="sm"
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={() => setEditing({ type, original: skill, value: skill })}
                    disabled={isSaving}
                    className="tl-button-quiet"
                    data-size="sm"
                  >
                    Edit
                  </button>
                  <button
                    type="button"
                    onClick={() => deleteSkill(type, skill)}
                    disabled={isSaving}
                    className="tl-button-quiet"
                    data-size="sm"
                    data-tone="danger"
                  >
                    Delete
                  </button>
                </>
              )}
            </div>
          );
        })}
      </div>

      {visibleSkills.length > 0 && (
        <div className="flex items-center justify-between gap-3">
          <div className="text-xs text-subtle">
            Page {page} of {totalPages}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                if (type === 'hard') setTechPage((current) => Math.max(1, current - 1));
                else setSoftPage((current) => Math.max(1, current - 1));
              }}
              disabled={page <= 1}
              className="tl-button-quiet"
              data-size="sm"
            >
              Previous
            </button>
            <button
              type="button"
              onClick={() => {
                if (type === 'hard') setTechPage((current) => Math.min(totalPages, current + 1));
                else setSoftPage((current) => Math.min(totalPages, current + 1));
              }}
              disabled={page >= totalPages}
              className="tl-button-quiet"
              data-size="sm"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );

  return (
    <div className="space-y-6 pb-8">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-2xl font-bold tracking-tight text-ink">Skill Library</h2>
          <p className="mt-1 text-sm text-muted">
            The tech and soft skills every account&apos;s resumes draw on, shared across the installation.
          </p>
        </div>
        <button type="button" onClick={loadSkills} className="tl-button-quiet">
          Refresh
        </button>
      </div>

      <Field
        label="Search skills"
        htmlFor="skill-library-search"
        hint={`Showing ${techVisibleSkills.length + softVisibleSkills.length} of ${techSkills.length + softSkills.length} skills.`}
      >
        <div className="flex gap-2">
          <input
            id="skill-library-search"
            type="search"
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              setTechPage(1);
              setSoftPage(1);
            }}
            placeholder="Search tech and soft skills"
            className="tl-input"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => {
                setSearchQuery('');
                setTechPage(1);
                setSoftPage(1);
              }}
              className="tl-button-quiet shrink-0"
              style={{ minHeight: '2.5rem' }}
            >
              Clear
            </button>
          )}
        </div>
      </Field>

      {error && (
        <Notice tone="error" role="alert">
          {error}
        </Notice>
      )}
      {success && (
        <Notice tone="success" role="status">
          {success}
        </Notice>
      )}

      {isLoading ? (
        <Spinner label="Loading skills..." />
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
          <section className="tl-card min-w-0">
            <div className="tl-card-header">
              <h3 className="text-base font-semibold text-ink">Tech Skills</h3>
            </div>
            <div className="space-y-5 p-5">
              <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_7.5rem_auto] sm:items-start">
                <input
                  type="text"
                  value={newTech}
                  onChange={(e) => setNewTech(e.target.value)}
                  placeholder="Add a tech skill"
                  aria-label="New tech skill"
                  className="tl-input sm:col-span-3"
                />
                <div>
                  <select
                    value={newTechCategory}
                    onChange={(e) => setNewTechCategory(e.target.value as HardSkillCategory)}
                    className="tl-input"
                    aria-label="Tech skill category"
                  >
                    {HARD_SKILL_CATEGORIES.map((category) => (
                      <option key={category} value={category}>
                        {category}
                      </option>
                    ))}
                  </select>
                  <p className="mt-1 text-xs text-subtle">Category required</p>
                </div>
                <div>
                  <select
                    value={String(newTechPriority)}
                    onChange={(e) => setNewTechPriority(Number(e.target.value))}
                    className="tl-input"
                    aria-label="Tech skill priority"
                  >
                    {PRIORITY_OPTIONS.map((priority) => (
                      <option key={priority} value={priority}>
                        Priority {priority}
                      </option>
                    ))}
                  </select>
                  <p className="mt-1 text-xs text-subtle">1 is highest</p>
                </div>
                <button
                  type="button"
                  onClick={() => addSkill('hard', newTech, { category: newTechCategory, priority: newTechPriority })}
                  disabled={isSaving || !newTech.trim()}
                  className="tl-button"
                >
                  Add
                </button>
              </div>
              {renderList('hard', techSkills, techVisibleSkills, techPageItems, techSort, safeTechPage, techTotalPages, techPageSize)}
            </div>
          </section>

          <section className="tl-card min-w-0">
            <div className="tl-card-header">
              <h3 className="text-base font-semibold text-ink">Soft Skills</h3>
            </div>
            <div className="space-y-5 p-5">
              <div className="flex items-center gap-2">
                <input
                  type="text"
                  value={newSoft}
                  onChange={(e) => setNewSoft(e.target.value)}
                  placeholder="Add a soft skill"
                  aria-label="New soft skill"
                  className="tl-input min-w-0 flex-1"
                />
                <button
                  type="button"
                  onClick={() => addSkill('soft', newSoft)}
                  disabled={isSaving || !newSoft.trim()}
                  className="tl-button"
                >
                  Add
                </button>
              </div>
              {renderList('soft', softSkills, softVisibleSkills, softPageItems, softSort, safeSoftPage, softTotalPages, softPageSize)}
            </div>
          </section>
        </div>
      )}
    </div>
  );
}

/**
 * Administrator-only.
 *
 * This page changes things shared by everybody on the installation - the AI
 * providers, the prompts every account's resumes are built from, the shared
 * skill library - so it is not a per-user setting despite living behind a
 * "Settings" menu. `AdminOnly` explains that rather than rendering nothing: a
 * blank page reads as broken.
 */
export default function SkillsPage() {
  return (
    <AdminOnly>
      <SkillsPageBody />
    </AdminOnly>
  );
}
