'use client';

import { useEffect, useState } from 'react';
import { resumeApi } from '@/lib/api';

type SkillType = 'hard' | 'soft';
type SortOption = 'az' | 'za';
type HardSkillCategory =
  | 'Languages'
  | 'Frameworks and Libraries'
  | 'Software Architecture & Design'
  | 'Security'
  | 'Cloud and Infrastructure'
  | 'Databases and Storage'
  | 'DevOps and CI/CD'
  | 'Observability and Monitoring'
  | 'Testing and Quality'
  | 'APIs and Integration'
  | 'Engineering Practices & Methodology'
  | 'Data Engineering & Streaming'
  | 'AI/ML & Data Science'
  | 'Version Control & Collaboration'
  | 'Operating Systems & Platforms'
  | 'Frontend & UI/UX Development'
  | 'Mobile Development';

type EditingState = {
  type: SkillType;
  original: string;
  value: string;
} | null;

const normalize = (value: string) => value.trim().toLowerCase();
const PAGE_SIZE_OPTIONS = [10, 25, 50];
const HARD_SKILL_CATEGORIES: HardSkillCategory[] = [
  'Languages',
  'Frameworks and Libraries',
  'Software Architecture & Design',
  'Security',
  'Cloud and Infrastructure',
  'Databases and Storage',
  'DevOps and CI/CD',
  'Observability and Monitoring',
  'Testing and Quality',
  'APIs and Integration',
  'Engineering Practices & Methodology',
  'Data Engineering & Streaming',
  'AI/ML & Data Science',
  'Version Control & Collaboration',
  'Operating Systems & Platforms',
  'Frontend & UI/UX Development',
  'Mobile Development',
];
const PRIORITY_OPTIONS = [1, 2, 3, 4, 5];

export default function SkillsPage() {
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
      setError(err instanceof Error ? err.message : 'Failed to load skills');
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
      setError(err instanceof Error ? err.message : 'Failed to add skill');
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
      setError(err instanceof Error ? err.message : 'Failed to update skill');
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
      setError(err instanceof Error ? err.message : 'Failed to delete skill');
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
      <div className="grid gap-3 sm:grid-cols-[160px_120px]">
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
          className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
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
          className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
        >
          {PAGE_SIZE_OPTIONS.map((option) => (
            <option key={`${type}-page-size-${option}`} value={option}>
              {option}/page
            </option>
          ))}
        </select>
      </div>

      <div className="flex items-center justify-between text-xs text-gray-500">
        <span>
          {visibleSkills.length} {searchQuery.trim() ? 'matching' : 'visible'} skills
        </span>
        <span>{allSkills.length} total</span>
      </div>

      {visibleSkills.length === 0 && (
        <div className="text-sm text-gray-500">
          {searchQuery.trim() ? 'No skills match your search.' : 'No skills yet.'}
        </div>
      )}

      {pageItems.map((skill) => {
        const isEditing = editing?.type === type && editing?.original === skill;
        return (
          <div key={`${type}-${skill}`} className="flex items-center gap-2">
            {isEditing ? (
              <input
                type="text"
                value={editing?.value ?? ''}
                onChange={(e) => setEditing({ type, original: skill, value: e.target.value })}
                className="flex-1 px-3 py-2 border border-gray-300 rounded-md text-sm"
              />
            ) : (
              <span className="flex-1 text-sm text-gray-800">{skill}</span>
            )}
            {isEditing ? (
              <>
                <button
                  type="button"
                  onClick={() => updateSkill(type, skill, editing?.value ?? '')}
                  disabled={isSaving}
                  className="px-3 py-1.5 text-xs bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:bg-blue-300"
                >
                  Save
                </button>
                <button
                  type="button"
                  onClick={() => setEditing(null)}
                  disabled={isSaving}
                  className="px-3 py-1.5 text-xs bg-white text-gray-700 border border-gray-200 rounded-md hover:bg-gray-50"
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
                  className="px-3 py-1.5 text-xs bg-white text-gray-700 border border-gray-200 rounded-md hover:bg-gray-50"
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => deleteSkill(type, skill)}
                  disabled={isSaving}
                  className="px-3 py-1.5 text-xs bg-red-600 text-white rounded-md hover:bg-red-700 disabled:bg-red-300"
                >
                  Delete
                </button>
              </>
            )}
          </div>
        );
      })}

      {visibleSkills.length > 0 && (
        <div className="flex items-center justify-between border-t border-gray-200 pt-3">
          <div className="text-xs text-gray-500">
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
              className="px-3 py-1.5 text-xs bg-white text-gray-700 border border-gray-200 rounded-md hover:bg-gray-50 disabled:bg-gray-100 disabled:text-gray-400"
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
              className="px-3 py-1.5 text-xs bg-white text-gray-700 border border-gray-200 rounded-md hover:bg-gray-50 disabled:bg-gray-100 disabled:text-gray-400"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-bold text-gray-900">Skill Library</h1>
        <button
          type="button"
          onClick={loadSkills}
          className="px-3 py-1.5 text-sm bg-white border border-gray-200 rounded-md hover:bg-gray-50"
        >
          Refresh
        </button>
      </div>

      <div className="mb-6 rounded-lg border border-gray-200 bg-white p-4">
        <label htmlFor="skill-library-search" className="mb-2 block text-sm font-medium text-gray-700">
          Search skills
        </label>
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
            className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 shadow-sm focus:border-blue-500 focus:outline-none focus:ring-2 focus:ring-blue-500/20"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => {
                setSearchQuery('');
                setTechPage(1);
                setSoftPage(1);
              }}
              className="shrink-0 rounded-md border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700 hover:bg-gray-50"
            >
              Clear
            </button>
          )}
        </div>
        <p className="mt-2 text-xs text-gray-500">
          Showing {techVisibleSkills.length + softVisibleSkills.length} of {techSkills.length + softSkills.length} skills.
        </p>
      </div>

      {error && (
        <div className="mb-4 bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg">
          {error}
        </div>
      )}
      {success && (
        <div className="mb-4 bg-green-50 border border-green-200 text-green-700 px-4 py-3 rounded-lg">
          {success}
        </div>
      )}

      {isLoading ? (
        <div className="text-sm text-gray-500">Loading skills...</div>
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          <section className="bg-white border border-gray-200 rounded-lg p-4 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-gray-900">Tech Skills</h2>
            </div>
            <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_220px_120px_auto]">
              <input
                type="text"
                value={newTech}
                onChange={(e) => setNewTech(e.target.value)}
                placeholder="Add a tech skill"
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
              />
              <select
                value={newTechCategory}
                onChange={(e) => setNewTechCategory(e.target.value as HardSkillCategory)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm bg-white"
                aria-label="Tech skill category"
              >
                {HARD_SKILL_CATEGORIES.map((category) => (
                  <option key={category} value={category}>
                    {category}
                  </option>
                ))}
              </select>
              <select
                value={String(newTechPriority)}
                onChange={(e) => setNewTechPriority(Number(e.target.value))}
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm bg-white"
                aria-label="Tech skill priority"
              >
                {PRIORITY_OPTIONS.map((priority) => (
                  <option key={priority} value={priority}>
                    Priority {priority}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => addSkill('hard', newTech, { category: newTechCategory, priority: newTechPriority })}
                disabled={isSaving || !newTech.trim()}
                className="px-3 py-2 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:bg-blue-300"
              >
                Add
              </button>
            </div>
            <div className="grid gap-1 text-xs text-gray-500 sm:grid-cols-[minmax(0,1fr)_220px_120px_auto]">
              <span />
              <span>Category required</span>
              <span>1 is highest</span>
              <span />
            </div>
            {renderList('hard', techSkills, techVisibleSkills, techPageItems, techSort, safeTechPage, techTotalPages, techPageSize)}
          </section>

          <section className="bg-white border border-gray-200 rounded-lg p-4 space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold text-gray-900">Soft Skills</h2>
            </div>
            <div className="flex items-center gap-2">
              <input
                type="text"
                value={newSoft}
                onChange={(e) => setNewSoft(e.target.value)}
                placeholder="Add a soft skill"
                className="flex-1 px-3 py-2 border border-gray-300 rounded-md text-sm"
              />
              <button
                type="button"
                onClick={() => addSkill('soft', newSoft)}
                disabled={isSaving || !newSoft.trim()}
                className="px-3 py-2 text-sm bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:bg-blue-300"
              >
                Add
              </button>
            </div>
            {renderList('soft', softSkills, softVisibleSkills, softPageItems, softSort, safeSoftPage, softTotalPages, softPageSize)}
          </section>
        </div>
      )}
    </div>
  );
}
