'use client';

import { useState, useEffect } from 'react';
import {
  Profile,
  CreateProfileDTO,
  Experience,
  Strength,
  Education,
  templatesApi,
  profilesApi,
  promptsApi,
  resumeApi,
  Template,
  PromptSummary,
  ProfileSettings,
  HardSkillOrdering,
  HardSkillCategory,
  HARD_SKILL_CATEGORIES,
  SkillCategoryGroup,
  TechnicalSkillsLayout,
  AiPreferences,
  UserAppSettings,
  DEFAULT_USER_APP_SETTINGS,
  normalizeAiPreferences,
} from '@/lib/api';
import AiPreferenceFields from '@/components/AiPreferenceFields';
import chrome from '@/components/admin/profileTemplateChrome.module.css';
import { Card, Field, Notice, Section } from '@/components/ui/kit';

interface ProfileFormProps {
  initialData?: Profile;
  onSubmit: (data: CreateProfileDTO) => Promise<void>;
  onCancel: () => void;
}

interface ManualProfileFormData {
  name: string;
  title: string;
  totalYearsExperience: string;
  preferredTemplate: string;
  profileSettings: Required<ProfileSettings>;
  contact: {
    phone: string;
    email: string;
    linkedin?: string;
    github?: string;
    portfolio?: string;
    location: string;
  };
  summary: string;
  experience: Experience[];
  strengths: Strength[];
  skills: string[];
  hardSkills: string[];
  softSkills: string[];
  education: Education[];
}

const DEFAULT_PROFILE_SETTINGS: Required<ProfileSettings> = {
  resumePromptId: 'tailor-resume',
  analyzeJobPromptId: 'analyze-job-description',
  coverLetterPromptId: 'generate-cover-letter',
  resumeFileNameTemplate: '{{profile name}}',
  coverLetterFileNameTemplate: '{{profile name}}_cover_letter',
  companyFolderNameTemplate: '{{row number}}_{{company name}}',
  hardSkillOrdering: 'library',
  technicalSkillsLayout: 'categorized',
  // Empty means every field inherits the app default, which is what a profile
  // that has never chosen should do.
  ai: {},
};

const TECHNICAL_SKILLS_LAYOUT_OPTIONS: Array<{
  value: TechnicalSkillsLayout;
  label: string;
  description: string;
}> = [
  {
    value: 'categorized',
    label: 'Grouped under headings',
    description:
      'Technical Skills is split into headings - Languages, Cloud and Infrastructure, and so on.',
  },
  {
    value: 'flat',
    label: 'One plain list',
    description: 'Technical Skills is a single list of skill names, with no headings over it.',
  },
];

function normalizeTechnicalSkillsLayout(value?: string): TechnicalSkillsLayout {
  return value === 'flat' ? 'flat' : DEFAULT_PROFILE_SETTINGS.technicalSkillsLayout;
}

/**
 * The profile's grouping, as a lookup from skill to heading.
 *
 * The form edits one heading per skill rather than a list of groups, because
 * that is the question being answered - "where does this skill go?" - and it
 * makes the two impossible states unrepresentable: a skill in two groups, and a
 * group holding a skill the profile no longer claims.
 */
function readSkillCategoryMap(groups?: SkillCategoryGroup[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const group of groups ?? []) {
    const category = group.category?.trim();
    if (!category) continue;
    for (const skill of group.skills ?? []) {
      if (skill && !map[skill]) map[skill] = category;
    }
  }
  return map;
}

/**
 * Turns the per-skill headings back into groups, in the library's own order.
 *
 * A heading the profile no longer has any skill under is dropped rather than
 * stored empty, and a skill with no heading is simply absent - the renderer
 * infers one for it. Both of those keep the stored shape the same as what an
 * imported file would produce, so a profile edited here and a profile uploaded
 * as JSON are indistinguishable afterwards.
 */
function buildSkillCategories(
  skills: string[],
  categoryBySkill: Record<string, string>
): SkillCategoryGroup[] {
  const order: string[] = [];
  const grouped = new Map<string, string[]>();
  for (const skill of skills) {
    const category = categoryBySkill[skill]?.trim();
    if (!category) continue;
    if (!grouped.has(category)) {
      grouped.set(category, []);
      order.push(category);
    }
    grouped.get(category)!.push(skill);
  }

  // The library's order first, so a profile reads down the page the way the
  // rendered resume does; anything the person typed themselves follows.
  const known = HARD_SKILL_CATEGORIES.filter((category) => grouped.has(category));
  const extra = order.filter((category) => !known.includes(category as HardSkillCategory));
  return [...known, ...extra].map((category) => ({
    category,
    skills: grouped.get(category) ?? [],
  }));
}

const HARD_SKILL_ORDERING_OPTIONS: Array<{ value: HardSkillOrdering; label: string; description: string }> = [
  {
    value: 'library',
    label: 'Skill library priority',
    description: 'Order hard skills by the priority stored in the skill library.',
  },
  {
    value: 'job-priority',
    label: 'Job relevance',
    description: 'Order hard skills by how strongly the analyzed job description asks for them.',
  },
];

const FILE_NAME_TOKENS = '{{profile name}}, {{company name}}, {{row number}}, {{job title}}, {{date}}';
const FOLDER_NAME_TOKENS = '{{company name}}, {{row number}}';

function normalizeHardSkillOrdering(value?: string): HardSkillOrdering {
  return value === 'job-priority' ? 'job-priority' : DEFAULT_PROFILE_SETTINGS.hardSkillOrdering;
}

function normalizeExperienceList(experience?: Experience[]): Experience[] {
  return (experience || []).map((item) => ({
    ...item,
    achievements: item.achievements || [],
    skills: item.skills || [],
  }));
}

function getInitialProfileSettings(profile?: Profile): Required<ProfileSettings> {
  return {
    resumePromptId:
      profile?.profileSettings?.resumePromptId || DEFAULT_PROFILE_SETTINGS.resumePromptId,
    analyzeJobPromptId:
      profile?.profileSettings?.analyzeJobPromptId || DEFAULT_PROFILE_SETTINGS.analyzeJobPromptId,
    coverLetterPromptId:
      profile?.profileSettings?.coverLetterPromptId || DEFAULT_PROFILE_SETTINGS.coverLetterPromptId,
    resumeFileNameTemplate:
      profile?.profileSettings?.resumeFileNameTemplate ||
      DEFAULT_PROFILE_SETTINGS.resumeFileNameTemplate,
    coverLetterFileNameTemplate:
      profile?.profileSettings?.coverLetterFileNameTemplate ||
      DEFAULT_PROFILE_SETTINGS.coverLetterFileNameTemplate,
    companyFolderNameTemplate:
      profile?.profileSettings?.companyFolderNameTemplate ||
      DEFAULT_PROFILE_SETTINGS.companyFolderNameTemplate,
    hardSkillOrdering: normalizeHardSkillOrdering(profile?.profileSettings?.hardSkillOrdering),
    technicalSkillsLayout: normalizeTechnicalSkillsLayout(
      profile?.profileSettings?.technicalSkillsLayout
    ),
    ai: normalizeAiPreferences(profile?.profileSettings?.ai),
  };
}

export default function ProfileForm({
  initialData,
  onSubmit,
  onCancel,
}: ProfileFormProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState('');

  const initialHardSkills = initialData?.hardSkills || initialData?.skills || [];
  const [skillCategoryBySkill, setSkillCategoryBySkill] = useState<Record<string, string>>(() =>
    readSkillCategoryMap(initialData?.skillCategories)
  );
  // Open straight away for a profile that already has headings - otherwise
  // editing one means finding a toggle to discover that the work is there.
  const [showSkillCategories, setShowSkillCategories] = useState(
    () => (initialData?.skillCategories?.length ?? 0) > 0
  );

  const [formData, setFormData] = useState<ManualProfileFormData>({
    name: initialData?.name || '',
    title: initialData?.title || '',
    totalYearsExperience:
      typeof initialData?.totalYearsExperience === 'number'
        ? String(initialData.totalYearsExperience)
        : '',
    preferredTemplate: initialData?.preferredTemplate || '',
    profileSettings: getInitialProfileSettings(initialData),
    contact: initialData?.contact || {
      phone: '',
      email: '',
      linkedin: '',
      location: '',
    },
    summary: initialData?.summary || '',
    experience: normalizeExperienceList(initialData?.experience),
    strengths: initialData?.strengths || [],
    skills: initialHardSkills,
    hardSkills: initialHardSkills,
    softSkills: initialData?.softSkills || [],
    education: initialData?.education || [],
  });

  const [hardSkillInput, setHardSkillInput] = useState('');
  const [softSkillInput, setSoftSkillInput] = useState('');
  const [templates, setTemplates] = useState<Template[]>([]);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [prompts, setPrompts] = useState<PromptSummary[]>([]);
  const [hardSkillLibrary, setHardSkillLibrary] = useState<string[]>([]);
  const [appSettings, setAppSettings] = useState<UserAppSettings>(DEFAULT_USER_APP_SETTINGS);
  /**
   * Whether the model list really arrived. An empty list from a failed request
   * must not be read as "nothing is available": that would drop a perfectly
   * good saved choice on the next save.
   */
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [experienceSkillInputs, setExperienceSkillInputs] = useState<Record<number, string>>({});

  useEffect(() => {
    templatesApi.getAll().then(setTemplates).catch(() => setTemplates([]));
  }, []);

  useEffect(() => {
    profilesApi.getAll({ includeDisabled: true }).then(setProfiles).catch(() => setProfiles([]));
  }, []);

  useEffect(() => {
    promptsApi.getAll().then(setPrompts).catch(() => setPrompts([]));
  }, []);

  useEffect(() => {
    resumeApi.listSkills('hard').then((res) => setHardSkillLibrary(res.skills)).catch(() => setHardSkillLibrary([]));
  }, []);

  // The model list and the app's own default, so the inherit
  // option can say what inheriting actually gets you.
  useEffect(() => {
    resumeApi
      .getModels()
      .then((settings) => {
        setAppSettings(settings);
        setModelsLoaded(true);
      })
      .catch(() => setAppSettings(DEFAULT_USER_APP_SETTINGS));
  }, []);

  // Template IDs already selected by other profiles (exclude current profile when editing)
  const templatesInUseByOthers = new Set(
    profiles
      .filter((p) => p.id !== initialData?.id && p.preferredTemplate)
      .map((p) => p.preferredTemplate!)
  );
  const resumePrompts = prompts.filter((prompt) => prompt.featureKey === 'tailor-resume');
  const analyzeJobPrompts = prompts.filter((prompt) => prompt.featureKey === 'analyze-job-description');

  const updateProfileSetting = (field: keyof Required<ProfileSettings>, value: string) => {
    setFormData({
      ...formData,
      profileSettings: {
        ...formData.profileSettings,
        [field]: value,
      },
    });
  };

  const updateAiPreferences = (ai: AiPreferences) => {
    setFormData({
      ...formData,
      profileSettings: { ...formData.profileSettings, ai },
    });
  };

  /**
   * The model choice as it can be saved.
   *
   * A choice that is no longer on offer is saved as "inherit". The server runs
   * such a profile on the app default already, and it refuses to SAVE a model
   * this account cannot pick - so keeping the stale id would make every later
   * edit of this profile fail over a setting the picker shows as unavailable.
   */
  const savableAiPreferences = (ai: AiPreferences): AiPreferences => {
    const preferences = normalizeAiPreferences(ai);
    if (
      modelsLoaded &&
      preferences.modelId &&
      !appSettings.models.some((model) => model.id === preferences.modelId)
    ) {
      return {};
    }
    return preferences;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    setIsSubmitting(true);

    try {
      const parsedYears = formData.totalYearsExperience.trim()
        ? Number(formData.totalYearsExperience)
        : undefined;

      await onSubmit({
        ...formData,
        totalYearsExperience:
          typeof parsedYears === 'number' && Number.isFinite(parsedYears) && parsedYears >= 0
            ? parsedYears
            : undefined,
        preferredTemplate: formData.preferredTemplate || undefined,
        profileSettings: {
          resumePromptId:
            formData.profileSettings.resumePromptId || DEFAULT_PROFILE_SETTINGS.resumePromptId,
          analyzeJobPromptId:
            formData.profileSettings.analyzeJobPromptId ||
            DEFAULT_PROFILE_SETTINGS.analyzeJobPromptId,
          coverLetterPromptId:
            formData.profileSettings.coverLetterPromptId ||
            DEFAULT_PROFILE_SETTINGS.coverLetterPromptId,
          resumeFileNameTemplate:
            formData.profileSettings.resumeFileNameTemplate.trim() ||
            DEFAULT_PROFILE_SETTINGS.resumeFileNameTemplate,
          coverLetterFileNameTemplate:
            formData.profileSettings.coverLetterFileNameTemplate.trim() ||
            DEFAULT_PROFILE_SETTINGS.coverLetterFileNameTemplate,
          companyFolderNameTemplate:
            formData.profileSettings.companyFolderNameTemplate.trim() ||
            DEFAULT_PROFILE_SETTINGS.companyFolderNameTemplate,
          hardSkillOrdering: normalizeHardSkillOrdering(formData.profileSettings.hardSkillOrdering),
          technicalSkillsLayout: normalizeTechnicalSkillsLayout(
            formData.profileSettings.technicalSkillsLayout
          ),
          ai: savableAiPreferences(formData.profileSettings.ai),
        },
        skills: formData.hardSkills,
        // Sent whether or not the layout is grouped. The grouping is storage
        // and the layout is rendering, so switching to the plain list and back
        // must not lose the headings somebody took the trouble to assign.
        skillCategories: buildSkillCategories(formData.hardSkills, skillCategoryBySkill),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save profile');
    } finally {
      setIsSubmitting(false);
    }
  };

  const addExperience = () => {
    setFormData({
      ...formData,
      experience: [
        ...formData.experience,
        {
          title: '',
          company: '',
          startDate: '',
          endDate: '',
          location: '',
          description: '',
          achievements: [],
          skills: [],
        },
      ],
    });
  };

  const updateExperience = (index: number, field: keyof Experience, value: string | string[]) => {
    const updated = [...formData.experience];
    updated[index] = { ...updated[index], [field]: value };
    setFormData({ ...formData, experience: updated });
  };

  const removeExperience = (index: number) => {
    setFormData({
      ...formData,
      experience: formData.experience.filter((_, i) => i !== index),
    });
  };

  const addExperienceSkill = async (index: number) => {
    const value = (experienceSkillInputs[index] || '').trim();
    if (!value) return;

    const experience = formData.experience[index];
    const currentSkills = experience.skills || [];
    if (currentSkills.some((skill) => skill.toLowerCase() === value.toLowerCase())) {
      setExperienceSkillInputs({ ...experienceSkillInputs, [index]: '' });
      return;
    }

    const librarySkill = hardSkillLibrary.find((skill) => skill.toLowerCase() === value.toLowerCase());
    const skillToAdd = librarySkill || value;

    if (!librarySkill) {
      try {
        await resumeApi.addSkill({ type: 'hard', skill: value });
        setHardSkillLibrary((skills) => [...skills, value].sort((a, b) => a.localeCompare(b)));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to add skill');
        return;
      }
    }

    const updatedExperience = [...formData.experience];
    updatedExperience[index] = {
      ...experience,
      skills: [...currentSkills, skillToAdd],
    };
    const hardSkills = formData.hardSkills.some((skill) => skill.toLowerCase() === skillToAdd.toLowerCase())
      ? formData.hardSkills
      : [...formData.hardSkills, skillToAdd];

    setFormData({
      ...formData,
      experience: updatedExperience,
      hardSkills,
      skills: hardSkills,
    });
    setExperienceSkillInputs({ ...experienceSkillInputs, [index]: '' });
  };

  const removeExperienceSkill = (index: number, skill: string) => {
    const currentSkills = formData.experience[index].skills || [];
    updateExperience(index, 'skills', currentSkills.filter((item) => item !== skill));
  };

  const addStrength = () => {
    setFormData({
      ...formData,
      strengths: [...formData.strengths, { title: '', description: '' }],
    });
  };

  const updateStrength = (index: number, field: keyof Strength, value: string) => {
    const updated = [...formData.strengths];
    updated[index] = { ...updated[index], [field]: value };
    setFormData({ ...formData, strengths: updated });
  };

  const removeStrength = (index: number) => {
    setFormData({
      ...formData,
      strengths: formData.strengths.filter((_, i) => i !== index),
    });
  };

  const addEducation = () => {
    setFormData({
      ...formData,
      education: [
        ...formData.education,
        {
          degree: '',
          institution: '',
          startDate: '',
          endDate: '',
          location: '',
        },
      ],
    });
  };

  const updateEducation = (index: number, field: keyof Education, value: string) => {
    const updated = [...formData.education];
    updated[index] = { ...updated[index], [field]: value };
    setFormData({ ...formData, education: updated });
  };

  const removeEducation = (index: number) => {
    setFormData({
      ...formData,
      education: formData.education.filter((_, i) => i !== index),
    });
  };

  // The library's headings, plus any this profile already uses. A profile
  // imported from a file may carry headings this build has never heard of, and
  // dropping them from the menu would silently reassign them on the next save.
  const headingOptions = [
    ...HARD_SKILL_CATEGORIES,
    ...Object.values(skillCategoryBySkill)
      .map((category) => category.trim())
      .filter(
        (category) =>
          category && !HARD_SKILL_CATEGORIES.includes(category as HardSkillCategory)
      ),
  ].filter((category, index, all) => all.indexOf(category) === index);

  const addHardSkill = async () => {
    const value = hardSkillInput.trim();
    if (!value) return;

    const librarySkill = hardSkillLibrary.find((skill) => skill.toLowerCase() === value.toLowerCase());
    const skillToAdd = librarySkill || value;

    if (!librarySkill) {
      try {
        await resumeApi.addSkill({ type: 'hard', skill: value });
        setHardSkillLibrary((skills) => [...skills, value].sort((a, b) => a.localeCompare(b)));
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to add skill');
        return;
      }
    }

    if (!formData.hardSkills.some((skill) => skill.toLowerCase() === skillToAdd.toLowerCase())) {
      const hardSkills = [...formData.hardSkills, skillToAdd];
      setFormData({ ...formData, hardSkills, skills: hardSkills });
      setHardSkillInput('');
    }
  };

  const removeHardSkill = (skill: string) => {
    const hardSkills = formData.hardSkills.filter((s) => s !== skill);
    setFormData({
      ...formData,
      hardSkills,
      skills: hardSkills,
    });
  };

  const addSoftSkill = () => {
    const value = softSkillInput.trim();
    if (value && !formData.softSkills.includes(value)) {
      setFormData({
        ...formData,
        softSkills: [...formData.softSkills, value],
      });
      setSoftSkillInput('');
    }
  };

  const removeSoftSkill = (skill: string) => {
    setFormData({
      ...formData,
      softSkills: formData.softSkills.filter((s) => s !== skill),
    });
  };

  return (
    <form onSubmit={handleSubmit} className={chrome.sectionedForm}>
      {error && (
        <Notice tone="error" role="alert" className="mt-6">
          {error}
        </Notice>
      )}

      {/* Basic Info */}
      <Section title="Basic Information">
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
          <Field label="Full Name" htmlFor="profile-name">
            <input
              id="profile-name"
              type="text"
              value={formData.name}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              className="tl-input"
            />
          </Field>
          <Field label="Professional Title" htmlFor="profile-title">
            <input
              id="profile-title"
              type="text"
              value={formData.title}
              onChange={(e) => setFormData({ ...formData, title: e.target.value })}
              className="tl-input"
              placeholder="e.g., Senior Backend Engineer | Django | FastAPI"
            />
          </Field>
          <Field label="Total Years of Experience" htmlFor="profile-years">
            <input
              id="profile-years"
              type="number"
              min="0"
              step="0.5"
              value={formData.totalYearsExperience}
              onChange={(e) =>
                setFormData({ ...formData, totalYearsExperience: e.target.value })
              }
              className="tl-input"
              placeholder="e.g., 4"
            />
          </Field>
          <Field
            label="Default Template"
            htmlFor="profile-template"
            hint="When set, this template is used automatically when building resumes for this profile."
          >
            <select
              id="profile-template"
              value={formData.preferredTemplate}
              onChange={(e) =>
                setFormData({ ...formData, preferredTemplate: e.target.value })
              }
              className="tl-input"
            >
              <option value="">None (select in builder)</option>
              {templates.map((t) => {
                const isInUseByOther = templatesInUseByOthers.has(t.id);
                return (
                  <option
                    key={t.id}
                    value={t.id}
                    disabled={isInUseByOther}
                  >
                    {t.name}
                    {isInUseByOther ? ' (in use by another profile)' : ''}
                  </option>
                );
              })}
            </select>
          </Field>
        </div>
      </Section>

      {/* AI defaults for this profile */}
      <Section
        title="AI Defaults"
        description="Used whenever this profile is generated. Any of them can be overridden for a single run on the builder page."
      >
        <AiPreferenceFields
          idPrefix="profile-ai"
          value={formData.profileSettings.ai}
          onChange={updateAiPreferences}
          models={appSettings.models}
          modelsLoaded={modelsLoaded}
          inheritedFrom="app default"
          inherited={{
            modelLabel:
              appSettings.models.find((model) => model.id === appSettings.defaultModelId)?.name ||
              'the first enabled model',
          }}
        />
      </Section>

      {/* Profile Settings */}
      <Section title="Profile Settings">
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
          <Field label="Building Prompt" htmlFor="profile-resume-prompt">
            <select
              id="profile-resume-prompt"
              value={formData.profileSettings.resumePromptId}
              onChange={(e) => updateProfileSetting('resumePromptId', e.target.value)}
              className="tl-input"
            >
              {!resumePrompts.some((prompt) => prompt.id === formData.profileSettings.resumePromptId) && (
                <option value={formData.profileSettings.resumePromptId}>
                  {formData.profileSettings.resumePromptId === DEFAULT_PROFILE_SETTINGS.resumePromptId
                    ? 'Built-in Resume Prompt'
                    : `Saved prompt (${formData.profileSettings.resumePromptId})`}
                </option>
              )}
              {resumePrompts.map((prompt) => (
                <option key={prompt.id} value={prompt.id}>
                  {prompt.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Extracting Prompt" htmlFor="profile-analyze-prompt">
            <select
              id="profile-analyze-prompt"
              value={formData.profileSettings.analyzeJobPromptId}
              onChange={(e) => updateProfileSetting('analyzeJobPromptId', e.target.value)}
              className="tl-input"
            >
              {!analyzeJobPrompts.some((prompt) => prompt.id === formData.profileSettings.analyzeJobPromptId) && (
                <option value={formData.profileSettings.analyzeJobPromptId}>
                  {formData.profileSettings.analyzeJobPromptId === DEFAULT_PROFILE_SETTINGS.analyzeJobPromptId
                    ? 'Built-in Extracting Prompt'
                    : `Saved prompt (${formData.profileSettings.analyzeJobPromptId})`}
                </option>
              )}
              {analyzeJobPrompts.map((prompt) => (
                <option key={prompt.id} value={prompt.id}>
                  {prompt.name}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label="Resume File Name"
            htmlFor="profile-resume-file-name"
            hint={<>Available tokens: {FILE_NAME_TOKENS}</>}
          >
            <input
              id="profile-resume-file-name"
              type="text"
              value={formData.profileSettings.resumeFileNameTemplate}
              onChange={(e) => updateProfileSetting('resumeFileNameTemplate', e.target.value)}
              className="tl-input"
              placeholder={DEFAULT_PROFILE_SETTINGS.resumeFileNameTemplate}
            />
          </Field>
          <Field
            label="Cover Letter File Name"
            htmlFor="profile-cover-letter-file-name"
            hint={<>Available tokens: {FILE_NAME_TOKENS}</>}
          >
            <input
              id="profile-cover-letter-file-name"
              type="text"
              value={formData.profileSettings.coverLetterFileNameTemplate}
              onChange={(e) => updateProfileSetting('coverLetterFileNameTemplate', e.target.value)}
              className="tl-input"
              placeholder={DEFAULT_PROFILE_SETTINGS.coverLetterFileNameTemplate}
            />
          </Field>
          <Field
            label="Hard Skill Ordering"
            htmlFor="profile-hard-skill-ordering"
            hint={HARD_SKILL_ORDERING_OPTIONS.find((option) => option.value === formData.profileSettings.hardSkillOrdering)?.description}
          >
            <select
              id="profile-hard-skill-ordering"
              value={formData.profileSettings.hardSkillOrdering}
              onChange={(e) => updateProfileSetting('hardSkillOrdering', e.target.value)}
              className="tl-input"
            >
              {HARD_SKILL_ORDERING_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label="Technical Skills Layout"
            htmlFor="profile-technical-skills-layout"
            hint={
              TECHNICAL_SKILLS_LAYOUT_OPTIONS.find(
                (option) => option.value === formData.profileSettings.technicalSkillsLayout
              )?.description
            }
          >
            <select
              id="profile-technical-skills-layout"
              value={formData.profileSettings.technicalSkillsLayout}
              onChange={(e) => updateProfileSetting('technicalSkillsLayout', e.target.value)}
              className="tl-input"
            >
              {TECHNICAL_SKILLS_LAYOUT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </Field>
          <Field
            label="Company Folder Name"
            htmlFor="profile-company-folder-name"
            hint={<>Available tokens: {FOLDER_NAME_TOKENS}</>}
          >
            <input
              id="profile-company-folder-name"
              type="text"
              value={formData.profileSettings.companyFolderNameTemplate}
              onChange={(e) => updateProfileSetting('companyFolderNameTemplate', e.target.value)}
              className="tl-input"
              placeholder={DEFAULT_PROFILE_SETTINGS.companyFolderNameTemplate}
            />
          </Field>
        </div>
      </Section>

      {/* Contact Info */}
      <Section title="Contact Information">
        <div className="grid grid-cols-1 gap-6 md:grid-cols-2">
          <Field label="Email" htmlFor="profile-email">
            <input
              id="profile-email"
              type="email"
              value={formData.contact.email}
              onChange={(e) =>
                setFormData({
                  ...formData,
                  contact: { ...formData.contact, email: e.target.value },
                })
              }
              className="tl-input"
            />
          </Field>
          <Field label="Phone" htmlFor="profile-phone">
            <input
              id="profile-phone"
              type="tel"
              value={formData.contact.phone}
              onChange={(e) =>
                setFormData({
                  ...formData,
                  contact: { ...formData.contact, phone: e.target.value },
                })
              }
              className="tl-input"
            />
          </Field>
          <Field label="Location" htmlFor="profile-location">
            <input
              id="profile-location"
              type="text"
              value={formData.contact.location}
              onChange={(e) =>
                setFormData({
                  ...formData,
                  contact: { ...formData.contact, location: e.target.value },
                })
              }
              className="tl-input"
              placeholder="e.g., San Francisco, CA"
            />
          </Field>
          <Field label="LinkedIn URL" htmlFor="profile-linkedin">
            <input
              id="profile-linkedin"
              type="url"
              value={formData.contact.linkedin || ''}
              onChange={(e) =>
                setFormData({
                  ...formData,
                  contact: { ...formData.contact, linkedin: e.target.value },
                })
              }
              className="tl-input"
            />
          </Field>
        </div>
      </Section>

      {/* Summary */}
      <Section title="Professional Summary">
        <textarea
          rows={4}
          value={formData.summary}
          onChange={(e) => setFormData({ ...formData, summary: e.target.value })}
          className="tl-input"
          aria-label="Professional Summary"
          placeholder="Write a compelling professional summary..."
        />
      </Section>

      {/* Experience */}
      <Section
        title="Experience"
        description="For manual entry, you can add only role/company/duration. Missing role brief and key achievements will be generated from job description during tailoring."
        actions={
          <button
            type="button"
            onClick={addExperience}
            className="tl-button-quiet"
            data-size="sm"
          >
            + Add Experience
          </button>
        }
      >
        {formData.experience.map((exp, index) => (
          <Card
            key={index}
            title={`Experience ${index + 1}`}
            actions={
              <button
                type="button"
                onClick={() => removeExperience(index)}
                className="tl-button-quiet"
                data-size="sm"
                data-tone="danger"
              >
                Remove
              </button>
            }
          >
            <div className="space-y-4">
              <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
                <input
                  type="text"
                  placeholder="Job Title"
                  value={exp.title}
                  onChange={(e) => updateExperience(index, 'title', e.target.value)}
                  className="tl-input"
                />
                <input
                  type="text"
                  placeholder="Company"
                  value={exp.company}
                  onChange={(e) => updateExperience(index, 'company', e.target.value)}
                  className="tl-input"
                />
                <input
                  type="text"
                  placeholder="Start Date (MM/YYYY)"
                  value={exp.startDate}
                  onChange={(e) => updateExperience(index, 'startDate', e.target.value)}
                  className="tl-input"
                />
                <input
                  type="text"
                  placeholder="End Date (MM/YYYY or Present)"
                  value={exp.endDate}
                  onChange={(e) => updateExperience(index, 'endDate', e.target.value)}
                  className="tl-input"
                />
                <div className="md:col-span-2">
                  <input
                    type="text"
                    placeholder="Location"
                    value={exp.location}
                    onChange={(e) => updateExperience(index, 'location', e.target.value)}
                    className="tl-input"
                  />
                </div>
              </div>
              <textarea
                placeholder="Brief description of the role"
                value={exp.description}
                onChange={(e) => updateExperience(index, 'description', e.target.value)}
                className="tl-input"
                rows={2}
              />
              <Field label="Skills" htmlFor={`experience-skill-input-${index}`}>
                <div className="flex gap-2">
                  <input
                    id={`experience-skill-input-${index}`}
                    type="text"
                    list={`experience-skill-library-${index}`}
                    value={experienceSkillInputs[index] || ''}
                    onChange={(e) =>
                      setExperienceSkillInputs({
                        ...experienceSkillInputs,
                        [index]: e.target.value,
                      })
                    }
                    onKeyPress={(e) =>
                      e.key === 'Enter' && (e.preventDefault(), addExperienceSkill(index))
                    }
                    placeholder="Select or add a hard skill"
                    className="tl-input"
                  />
                  <datalist id={`experience-skill-library-${index}`}>
                    {hardSkillLibrary.map((skill) => (
                      <option key={skill} value={skill} />
                    ))}
                  </datalist>
                  <button
                    type="button"
                    onClick={() => addExperienceSkill(index)}
                    className="tl-button-quiet"
                  >
                    Add
                  </button>
                </div>
                {(exp.skills || []).length > 0 && (
                  <div className="mt-3 flex flex-wrap gap-2">
                    {(exp.skills || []).map((skill) => (
                      <span key={skill} className="tl-pill" data-tone="sky">
                        {skill}
                        <button
                          type="button"
                          onClick={() => removeExperienceSkill(index, skill)}
                          aria-label={`Remove ${skill}`}
                          className="-mr-1 px-0.5 text-sm leading-none opacity-70 hover:opacity-100"
                        >
                          ×
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </Field>
              <Field label="Achievements (one per line)" htmlFor={`experience-achievements-${index}`}>
                <textarea
                  id={`experience-achievements-${index}`}
                  placeholder="Led a team of 5 engineers...&#10;Improved performance by 50%..."
                  value={exp.achievements.join('\n')}
                  onChange={(e) =>
                    updateExperience(
                      index,
                      'achievements',
                      e.target.value.split('\n').filter((a) => a.trim())
                    )
                  }
                  className="tl-input"
                  rows={4}
                />
              </Field>
            </div>
          </Card>
        ))}
      </Section>

      {/* Hard Skills */}
      <Section
        title="Hard Skills"
        actions={
          <button
            type="button"
            onClick={() => setShowSkillCategories((shown) => !shown)}
            className="tl-button-quiet"
            data-size="sm"
          >
            {showSkillCategories ? 'Hide headings' : 'Assign headings'}
          </button>
        }
      >
        {showSkillCategories && (
          <p className="text-sm text-muted">
            A skill left on <span className="font-medium text-ink">Work it out</span> is filed by the shared
            skill library. Set one here when the library would put it somewhere else — it has no way
            to know that your Vault is infrastructure rather than a library.
            {formData.profileSettings.technicalSkillsLayout === 'flat' && (
              <>
                {' '}
                This profile currently renders Technical Skills as one plain list, so these headings
                are stored but not shown. They come back if you switch the layout under Profile
                Settings.
              </>
            )}
          </p>
        )}
        <div className="flex gap-2">
          <input
            type="text"
            list="profile-hard-skill-library"
            value={hardSkillInput}
            onChange={(e) => setHardSkillInput(e.target.value)}
            onKeyPress={(e) => e.key === 'Enter' && (e.preventDefault(), addHardSkill())}
            placeholder="Add a hard skill"
            aria-label="Add a hard skill"
            className="tl-input"
          />
          <datalist id="profile-hard-skill-library">
            {hardSkillLibrary.map((skill) => (
              <option key={skill} value={skill} />
            ))}
          </datalist>
          <button
            type="button"
            onClick={addHardSkill}
            className="tl-button-quiet"
          >
            Add
          </button>
        </div>
        {formData.hardSkills.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {formData.hardSkills.map((skill) => (
              <span key={skill} className="tl-pill" data-tone="sky">
                {skill}
                {showSkillCategories && (
                  <select
                    value={skillCategoryBySkill[skill] ?? ''}
                    onChange={(e) =>
                      setSkillCategoryBySkill((current) => ({ ...current, [skill]: e.target.value }))
                    }
                    aria-label={`Heading for ${skill}`}
                    className={chrome.chipSelect}
                  >
                    <option value="">Work it out</option>
                    {headingOptions.map((category) => (
                      <option key={category} value={category}>
                        {category}
                      </option>
                    ))}
                  </select>
                )}
                <button
                  type="button"
                  onClick={() => removeHardSkill(skill)}
                  aria-label={`Remove ${skill}`}
                  className="-mr-1 px-0.5 text-sm leading-none opacity-70 hover:opacity-100"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
      </Section>

      {/* Soft Skills */}
      <Section title="Soft Skills">
        <div className="flex gap-2">
          <input
            type="text"
            value={softSkillInput}
            onChange={(e) => setSoftSkillInput(e.target.value)}
            onKeyPress={(e) => e.key === 'Enter' && (e.preventDefault(), addSoftSkill())}
            placeholder="Add a soft skill"
            aria-label="Add a soft skill"
            className="tl-input"
          />
          <button
            type="button"
            onClick={addSoftSkill}
            className="tl-button-quiet"
          >
            Add
          </button>
        </div>
        {formData.softSkills.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {formData.softSkills.map((skill) => (
              <span key={skill} className="tl-pill" data-tone="green">
                {skill}
                <button
                  type="button"
                  onClick={() => removeSoftSkill(skill)}
                  aria-label={`Remove ${skill}`}
                  className="-mr-1 px-0.5 text-sm leading-none opacity-70 hover:opacity-100"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
      </Section>

      {/* Strengths */}
      <Section
        title="Strengths"
        actions={
          <button
            type="button"
            onClick={addStrength}
            className="tl-button-quiet"
            data-size="sm"
          >
            + Add Strength
          </button>
        }
      >
        {formData.strengths.map((strength, index) => (
          <Card
            key={index}
            title={`Strength ${index + 1}`}
            actions={
              <button
                type="button"
                onClick={() => removeStrength(index)}
                className="tl-button-quiet"
                data-size="sm"
                data-tone="danger"
              >
                Remove
              </button>
            }
          >
            <div className="space-y-4">
              <input
                type="text"
                placeholder="Strength Title (e.g., Customer-Centric)"
                value={strength.title}
                onChange={(e) => updateStrength(index, 'title', e.target.value)}
                className="tl-input"
              />
              <textarea
                placeholder="Description with metrics if possible"
                value={strength.description}
                onChange={(e) => updateStrength(index, 'description', e.target.value)}
                className="tl-input"
                rows={2}
              />
            </div>
          </Card>
        ))}
      </Section>

      {/* Education */}
      <Section
        title="Education"
        actions={
          <button
            type="button"
            onClick={addEducation}
            className="tl-button-quiet"
            data-size="sm"
          >
            + Add Education
          </button>
        }
      >
        {formData.education.map((edu, index) => (
          <Card
            key={index}
            title={`Education ${index + 1}`}
            actions={
              <button
                type="button"
                onClick={() => removeEducation(index)}
                className="tl-button-quiet"
                data-size="sm"
                data-tone="danger"
              >
                Remove
              </button>
            }
          >
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
              <input
                type="text"
                placeholder="Degree (e.g., Bachelor's in Computer Science)"
                value={edu.degree}
                onChange={(e) => updateEducation(index, 'degree', e.target.value)}
                className="tl-input"
              />
              <input
                type="text"
                placeholder="Institution"
                value={edu.institution}
                onChange={(e) => updateEducation(index, 'institution', e.target.value)}
                className="tl-input"
              />
              <input
                type="text"
                placeholder="Start Date (MM/YYYY)"
                value={edu.startDate}
                onChange={(e) => updateEducation(index, 'startDate', e.target.value)}
                className="tl-input"
              />
              <input
                type="text"
                placeholder="End Date (MM/YYYY)"
                value={edu.endDate}
                onChange={(e) => updateEducation(index, 'endDate', e.target.value)}
                className="tl-input"
              />
              <div className="md:col-span-2">
                <input
                  type="text"
                  placeholder="Location"
                  value={edu.location}
                  onChange={(e) => updateEducation(index, 'location', e.target.value)}
                  className="tl-input"
                />
              </div>
            </div>
          </Card>
        ))}
      </Section>

      {/* Actions */}
      <div className={chrome.dialogFoot}>
        <button
          type="button"
          onClick={onCancel}
          className="tl-button-quiet"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={isSubmitting}
          className="tl-button"
        >
          {isSubmitting ? 'Saving...' : initialData ? 'Update Profile' : 'Create Profile'}
        </button>
      </div>
    </form>
  );
}
