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
} from '@/lib/api';

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
};

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
        },
        skills: formData.hardSkills,
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
    <form onSubmit={handleSubmit} className="space-y-6">
      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-md">
          {error}
        </div>
      )}

      {/* Basic Info */}
      <div className="space-y-4">
        <h3 className="text-lg font-medium text-gray-900 border-b pb-2">
          Basic Information
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Full Name
            </label>
            <input
              type="text"
              value={formData.name}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Professional Title
            </label>
            <input
              type="text"
              value={formData.title}
              onChange={(e) => setFormData({ ...formData, title: e.target.value })}
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="e.g., Senior Backend Engineer | Django | FastAPI"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Total Years of Experience
            </label>
            <input
              type="number"
              min="0"
              step="0.5"
              value={formData.totalYearsExperience}
              onChange={(e) =>
                setFormData({ ...formData, totalYearsExperience: e.target.value })
              }
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="e.g., 4"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Default Template
            </label>
            <select
              value={formData.preferredTemplate}
              onChange={(e) =>
                setFormData({ ...formData, preferredTemplate: e.target.value })
              }
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
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
            <p className="mt-1 text-xs text-gray-500">
              When set, this template is used automatically when building resumes for this profile.
            </p>
          </div>
        </div>
      </div>

      {/* Profile Settings */}
      <div className="space-y-4 rounded-lg border border-gray-200 bg-gray-50 p-4">
        <div className="border-b border-gray-200 pb-2">
          <h3 className="text-lg font-medium text-gray-900">Profile Settings</h3>
        </div>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Building Prompt
            </label>
            <select
              value={formData.profileSettings.resumePromptId}
              onChange={(e) => updateProfileSetting('resumePromptId', e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
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
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Extracting Prompt
            </label>
            <select
              value={formData.profileSettings.analyzeJobPromptId}
              onChange={(e) => updateProfileSetting('analyzeJobPromptId', e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
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
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Resume File Name
            </label>
            <input
              type="text"
              value={formData.profileSettings.resumeFileNameTemplate}
              onChange={(e) => updateProfileSetting('resumeFileNameTemplate', e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder={DEFAULT_PROFILE_SETTINGS.resumeFileNameTemplate}
            />
            <p className="mt-1 text-xs text-gray-500">
              Available tokens: {FILE_NAME_TOKENS}
            </p>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Cover Letter File Name
            </label>
            <input
              type="text"
              value={formData.profileSettings.coverLetterFileNameTemplate}
              onChange={(e) => updateProfileSetting('coverLetterFileNameTemplate', e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder={DEFAULT_PROFILE_SETTINGS.coverLetterFileNameTemplate}
            />
            <p className="mt-1 text-xs text-gray-500">
              Available tokens: {FILE_NAME_TOKENS}
            </p>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Hard Skill Ordering
            </label>
            <select
              value={formData.profileSettings.hardSkillOrdering}
              onChange={(e) => updateProfileSetting('hardSkillOrdering', e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              {HARD_SKILL_ORDERING_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
            <p className="mt-1 text-xs text-gray-500">
              {HARD_SKILL_ORDERING_OPTIONS.find((option) => option.value === formData.profileSettings.hardSkillOrdering)?.description}
            </p>
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Company Folder Name
            </label>
            <input
              type="text"
              value={formData.profileSettings.companyFolderNameTemplate}
              onChange={(e) => updateProfileSetting('companyFolderNameTemplate', e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder={DEFAULT_PROFILE_SETTINGS.companyFolderNameTemplate}
            />
            <p className="mt-1 text-xs text-gray-500">
              Available tokens: {FOLDER_NAME_TOKENS}
            </p>
          </div>
        </div>
      </div>

      {/* Contact Info */}
      <div className="space-y-4">
        <h3 className="text-lg font-medium text-gray-900 border-b pb-2">
          Contact Information
        </h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Email
            </label>
            <input
              type="email"
              value={formData.contact.email}
              onChange={(e) =>
                setFormData({
                  ...formData,
                  contact: { ...formData.contact, email: e.target.value },
                })
              }
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Phone
            </label>
            <input
              type="tel"
              value={formData.contact.phone}
              onChange={(e) =>
                setFormData({
                  ...formData,
                  contact: { ...formData.contact, phone: e.target.value },
                })
              }
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              Location
            </label>
            <input
              type="text"
              value={formData.contact.location}
              onChange={(e) =>
                setFormData({
                  ...formData,
                  contact: { ...formData.contact, location: e.target.value },
                })
              }
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              placeholder="e.g., San Francisco, CA"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">
              LinkedIn URL
            </label>
            <input
              type="url"
              value={formData.contact.linkedin || ''}
              onChange={(e) =>
                setFormData({
                  ...formData,
                  contact: { ...formData.contact, linkedin: e.target.value },
                })
              }
              className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>
      </div>

      {/* Summary */}
      <div className="space-y-4">
        <h3 className="text-lg font-medium text-gray-900 border-b pb-2">
          Professional Summary
        </h3>
        <textarea
          rows={4}
          value={formData.summary}
          onChange={(e) => setFormData({ ...formData, summary: e.target.value })}
          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          placeholder="Write a compelling professional summary..."
        />
      </div>

      {/* Experience */}
      <div className="space-y-4">
        <div className="flex justify-between items-center border-b pb-2">
          <h3 className="text-lg font-medium text-gray-900">Experience</h3>
          <button
            type="button"
            onClick={addExperience}
            className="text-sm text-blue-600 hover:text-blue-700"
          >
            + Add Experience
          </button>
        </div>
        <p className="text-sm text-gray-500">
          For manual entry, you can add only role/company/duration. Missing role brief and key achievements will be generated from job description during tailoring.
        </p>
        {formData.experience.map((exp, index) => (
          <div key={index} className="p-4 border rounded-md space-y-3 bg-gray-50">
            <div className="flex justify-between">
              <span className="font-medium">Experience {index + 1}</span>
              <button
                type="button"
                onClick={() => removeExperience(index)}
                className="text-red-600 text-sm"
              >
                Remove
              </button>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <input
                type="text"
                placeholder="Job Title"
                value={exp.title}
                onChange={(e) => updateExperience(index, 'title', e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md"
              />
              <input
                type="text"
                placeholder="Company"
                value={exp.company}
                onChange={(e) => updateExperience(index, 'company', e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md"
              />
              <input
                type="text"
                placeholder="Start Date (MM/YYYY)"
                value={exp.startDate}
                onChange={(e) => updateExperience(index, 'startDate', e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md"
              />
              <input
                type="text"
                placeholder="End Date (MM/YYYY or Present)"
                value={exp.endDate}
                onChange={(e) => updateExperience(index, 'endDate', e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md"
              />
              <input
                type="text"
                placeholder="Location"
                value={exp.location}
                onChange={(e) => updateExperience(index, 'location', e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md md:col-span-2"
              />
            </div>
            <textarea
              placeholder="Brief description of the role"
              value={exp.description}
              onChange={(e) => updateExperience(index, 'description', e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md"
              rows={2}
            />
            <div className="space-y-2">
              <label className="block text-sm text-gray-600">
                Skills
              </label>
              <div className="flex gap-2">
                <input
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
                  className="flex-1 px-3 py-2 border border-gray-300 rounded-md"
                />
                <datalist id={`experience-skill-library-${index}`}>
                  {hardSkillLibrary.map((skill) => (
                    <option key={skill} value={skill} />
                  ))}
                </datalist>
                <button
                  type="button"
                  onClick={() => addExperienceSkill(index)}
                  className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700"
                >
                  Add
                </button>
              </div>
              <div className="flex flex-wrap gap-2">
                {(exp.skills || []).map((skill) => (
                  <span
                    key={skill}
                    className="px-3 py-1 bg-blue-100 text-blue-700 rounded-full flex items-center gap-2"
                  >
                    {skill}
                    <button
                      type="button"
                      onClick={() => removeExperienceSkill(index, skill)}
                      className="hover:text-blue-900"
                    >
                      x
                    </button>
                  </span>
                ))}
              </div>
            </div>
            <div>
              <label className="block text-sm text-gray-600 mb-1">
                Achievements (one per line)
              </label>
              <textarea
                placeholder="Led a team of 5 engineers...&#10;Improved performance by 50%..."
                value={exp.achievements.join('\n')}
                onChange={(e) =>
                  updateExperience(
                    index,
                    'achievements',
                    e.target.value.split('\n').filter((a) => a.trim())
                  )
                }
                className="w-full px-3 py-2 border border-gray-300 rounded-md"
                rows={4}
              />
            </div>
          </div>
        ))}
      </div>

      {/* Hard Skills */}
      <div className="space-y-4">
        <h3 className="text-lg font-medium text-gray-900 border-b pb-2">Hard Skills</h3>
        <div className="flex gap-2">
          <input
            type="text"
            list="profile-hard-skill-library"
            value={hardSkillInput}
            onChange={(e) => setHardSkillInput(e.target.value)}
            onKeyPress={(e) => e.key === 'Enter' && (e.preventDefault(), addHardSkill())}
            placeholder="Add a hard skill"
            className="flex-1 px-3 py-2 border border-gray-300 rounded-md"
          />
          <datalist id="profile-hard-skill-library">
            {hardSkillLibrary.map((skill) => (
              <option key={skill} value={skill} />
            ))}
          </datalist>
          <button
            type="button"
            onClick={addHardSkill}
            className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700"
          >
            Add
          </button>
        </div>
        <div className="flex flex-wrap gap-2">
          {formData.hardSkills.map((skill) => (
            <span
              key={skill}
              className="px-3 py-1 bg-blue-100 text-blue-700 rounded-full flex items-center gap-2"
            >
              {skill}
              <button
                type="button"
                onClick={() => removeHardSkill(skill)}
                className="hover:text-blue-900"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      </div>

      {/* Soft Skills */}
      <div className="space-y-4">
        <h3 className="text-lg font-medium text-gray-900 border-b pb-2">Soft Skills</h3>
        <div className="flex gap-2">
          <input
            type="text"
            value={softSkillInput}
            onChange={(e) => setSoftSkillInput(e.target.value)}
            onKeyPress={(e) => e.key === 'Enter' && (e.preventDefault(), addSoftSkill())}
            placeholder="Add a soft skill"
            className="flex-1 px-3 py-2 border border-gray-300 rounded-md"
          />
          <button
            type="button"
            onClick={addSoftSkill}
            className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700"
          >
            Add
          </button>
        </div>
        <div className="flex flex-wrap gap-2">
          {formData.softSkills.map((skill) => (
            <span
              key={skill}
              className="px-3 py-1 bg-green-100 text-green-700 rounded-full flex items-center gap-2"
            >
              {skill}
              <button
                type="button"
                onClick={() => removeSoftSkill(skill)}
                className="hover:text-green-900"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      </div>

      {/* Strengths */}
      <div className="space-y-4">
        <div className="flex justify-between items-center border-b pb-2">
          <h3 className="text-lg font-medium text-gray-900">Strengths</h3>
          <button
            type="button"
            onClick={addStrength}
            className="text-sm text-blue-600 hover:text-blue-700"
          >
            + Add Strength
          </button>
        </div>
        {formData.strengths.map((strength, index) => (
          <div key={index} className="p-4 border rounded-md space-y-3 bg-gray-50">
            <div className="flex justify-between">
              <span className="font-medium">Strength {index + 1}</span>
              <button
                type="button"
                onClick={() => removeStrength(index)}
                className="text-red-600 text-sm"
              >
                Remove
              </button>
            </div>
            <input
              type="text"
              placeholder="Strength Title (e.g., Customer-Centric)"
              value={strength.title}
              onChange={(e) => updateStrength(index, 'title', e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md"
            />
            <textarea
              placeholder="Description with metrics if possible"
              value={strength.description}
              onChange={(e) => updateStrength(index, 'description', e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md"
              rows={2}
            />
          </div>
        ))}
      </div>

      {/* Education */}
      <div className="space-y-4">
        <div className="flex justify-between items-center border-b pb-2">
          <h3 className="text-lg font-medium text-gray-900">Education</h3>
          <button
            type="button"
            onClick={addEducation}
            className="text-sm text-blue-600 hover:text-blue-700"
          >
            + Add Education
          </button>
        </div>
        {formData.education.map((edu, index) => (
          <div key={index} className="p-4 border rounded-md space-y-3 bg-gray-50">
            <div className="flex justify-between">
              <span className="font-medium">Education {index + 1}</span>
              <button
                type="button"
                onClick={() => removeEducation(index)}
                className="text-red-600 text-sm"
              >
                Remove
              </button>
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <input
                type="text"
                placeholder="Degree (e.g., Bachelor's in Computer Science)"
                value={edu.degree}
                onChange={(e) => updateEducation(index, 'degree', e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md"
              />
              <input
                type="text"
                placeholder="Institution"
                value={edu.institution}
                onChange={(e) => updateEducation(index, 'institution', e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md"
              />
              <input
                type="text"
                placeholder="Start Date (MM/YYYY)"
                value={edu.startDate}
                onChange={(e) => updateEducation(index, 'startDate', e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md"
              />
              <input
                type="text"
                placeholder="End Date (MM/YYYY)"
                value={edu.endDate}
                onChange={(e) => updateEducation(index, 'endDate', e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md"
              />
              <input
                type="text"
                placeholder="Location"
                value={edu.location}
                onChange={(e) => updateEducation(index, 'location', e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md md:col-span-2"
              />
            </div>
          </div>
        ))}
      </div>

      {/* Actions */}
      <div className="flex justify-end space-x-3 pt-4 border-t">
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2 border border-gray-300 rounded-md text-gray-700 hover:bg-gray-50"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={isSubmitting}
          className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50"
        >
          {isSubmitting ? 'Saving...' : initialData ? 'Update Profile' : 'Create Profile'}
        </button>
      </div>
    </form>
  );
}
