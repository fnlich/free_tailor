'use client';

import { useState, useEffect, useCallback } from 'react';
import {
  profilesApi,
  groupsApi,
  resumeApi,
  PublicAppSettings,
  Profile,
  Group,
  JobAnalysis,
  TailoredContent,
} from '@/lib/api';
import AppTopNav from '@/components/AppTopNav';
import GenerationProgress, { type GenerationProgressState } from '@/components/GenerationProgress';
import ProfileSelector from '@/components/ProfileSelector';
import ResumePreview from '@/components/ResumePreview';
import SheetsImportModal, { ImportedSheetJob } from '@/components/SheetsImportModal';
import { applyTheme, getStoredTheme, setStoredDefaultTheme } from '@/lib/theme';

type GenerateMode = 'single' | 'multiple';
type BuilderMode = 'manual' | 'sheets' | null;
type SheetsTargetMode = 'single' | 'all' | 'group';

type UnconfirmedSkill = { original: string; value: string };

type MultiplePreview = {
  profileId: string;
  profileName: string;
  html: string;
  tailoredContent?: TailoredContent;
  draft: string;
  error: string;
};

type GenerationFailure = {
  profileId: string;
  profileName: string;
  companyName: string;
  error: string;
};

function formatCompanySummary(companyNames: string[]): string {
  const uniqueCompanies = [...new Set(companyNames.map((name) => name.trim()).filter(Boolean))];
  if (uniqueCompanies.length === 0) return '';
  if (uniqueCompanies.length <= 3) return uniqueCompanies.join(', ');
  return `${uniqueCompanies.slice(0, 3).join(', ')}, ...`;
}

function getAnalysisJobTitle(analysis?: JobAnalysis): string {
  return analysis?.jobMeta?.title?.trim() ?? '';
}

export default function Home() {
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [groups, setGroups] = useState<Group[]>([]);
  const [builderMode, setBuilderMode] = useState<BuilderMode>(null);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [generateMode, setGenerateMode] = useState<GenerateMode>('single');
  const [multipleTarget, setMultipleTarget] = useState<'all' | 'group'>('group');
  const [selectedGroupId, setSelectedGroupId] = useState<string>('');
  const [sheetsTargetMode, setSheetsTargetMode] = useState<SheetsTargetMode>('single');
  const [selectedSheetsProfileId, setSelectedSheetsProfileId] = useState<string | null>(null);
  const [selectedSheetsGroupId, setSelectedSheetsGroupId] = useState<string>('');
  const [selectedSheetsSourceId, setSelectedSheetsSourceId] = useState<string>('');
  const [companyName, setCompanyName] = useState('');
  const [role, setRole] = useState('');
  const [jobDescription, setJobDescription] = useState('');
  const [modelSettings, setModelSettings] = useState<PublicAppSettings>({
    openaiEnabled: true,
    claudeEnabled: true,
    openrouterEnabled: true,
    deepseekEnabled: true,
    defaultMode: 'preview',
    defaultTheme: 'light',
    defaultResumeSelection: 'single',
    defaultGroupId: '',
    defaultProfileId: '',
    defaultModelId: '',
    defaultResumeDocxEnabled: true,
    defaultCoverLetterDocxEnabled: true,
    outputPathUsesJobTitle: true,
    aiModels: [],
    googleSheetsSources: [],
  });
  const [jobAnalysis, setJobAnalysis] = useState<JobAnalysis | null>(null);
  const [previewHtml, setPreviewHtml] = useState('');
  const [previewTailored, setPreviewTailored] = useState(false);
  const [isSinglePreviewOpen, setIsSinglePreviewOpen] = useState(false);
  const [tailoredContent, setTailoredContent] = useState<TailoredContent | null>(null);
  const [tailoredContentDraft, setTailoredContentDraft] = useState('');
  const [tailoredContentError, setTailoredContentError] = useState('');
  const [unconfirmedHardSkills, setUnconfirmedHardSkills] = useState<UnconfirmedSkill[]>([]);
  const [unconfirmedSoftSkills, setUnconfirmedSoftSkills] = useState<UnconfirmedSkill[]>([]);
  const [multiplePreviews, setMultiplePreviews] = useState<MultiplePreview[]>([]);
  const [multiplePreviewTailored, setMultiplePreviewTailored] = useState(false);
  const [multiplePreviewIndex, setMultiplePreviewIndex] = useState(0);
  const [autoGenerate, setAutoGenerate] = useState(false);
  const [isSheetsImportOpen, setIsSheetsImportOpen] = useState(false);

  const [isLoadingData, setIsLoadingData] = useState(true);
  const [isGenerating, setIsGenerating] = useState(false);
  const [generationStep, setGenerationStep] = useState('');
  const [generationProgress, setGenerationProgress] = useState<GenerationProgressState | null>(null);
  const [error, setError] = useState('');
  const [successMessage, setSuccessMessage] = useState('');

  useEffect(() => {
    loadInitialData();
  }, []);

  const resetTailoredEditor = useCallback(() => {
    setTailoredContent(null);
    setTailoredContentDraft('');
    setTailoredContentError('');
  }, []);

  const resetGenerationOutputs = useCallback(() => {
    setPreviewHtml('');
    setPreviewTailored(false);
    setIsSinglePreviewOpen(false);
    resetTailoredEditor();
    setJobAnalysis(null);
    setSuccessMessage('');
    setUnconfirmedHardSkills([]);
    setUnconfirmedSoftSkills([]);
    setMultiplePreviews([]);
    setMultiplePreviewTailored(false);
    setMultiplePreviewIndex(0);
  }, [resetTailoredEditor]);

  useEffect(() => {
    resetGenerationOutputs();
  }, [builderMode, companyName, role, jobDescription, selectedProfileId, generateMode, resetGenerationOutputs]);

  const loadInitialData = async () => {
    try {
      const [profilesData, groupsData, modelData] = await Promise.all([
        profilesApi.getAll({ includeDisabled: true }),
        groupsApi.getAll().catch(() => []),
        resumeApi.getModels().catch(() => ({
          openaiEnabled: true,
          claudeEnabled: true,
          openrouterEnabled: true,
          deepseekEnabled: true,
          defaultMode: 'preview' as const,
          defaultTheme: 'light' as const,
          defaultResumeSelection: 'single' as const,
          defaultGroupId: '',
          defaultProfileId: '',
          defaultModelId: '',
          defaultResumeDocxEnabled: true,
          defaultCoverLetterDocxEnabled: true,
          outputPathUsesJobTitle: true,
          aiModels: [],
          googleSheetsSources: [],
        })),
      ]);
      const enabledProfiles = profilesData.filter((p) => !p.disabled);
      setProfiles(enabledProfiles);
      setGroups(groupsData);
      setModelSettings(modelData);
      setAutoGenerate(modelData.defaultMode === 'generate');
      setStoredDefaultTheme(modelData.defaultTheme);

      if (!getStoredTheme()) {
        applyTheme(modelData.defaultTheme);
      }

      if (enabledProfiles.length > 0) {
        const defaultProfileExists = enabledProfiles.some((profile) => profile.id === modelData.defaultProfileId);
        const initialProfileId = defaultProfileExists ? modelData.defaultProfileId : enabledProfiles[0].id;
        setSelectedProfileId(initialProfileId);
        setSelectedSheetsProfileId(initialProfileId);
      }

      setSelectedSheetsSourceId((current) => {
        if (current && modelData.googleSheetsSources.some((source) => source.id === current)) {
          return current;
        }
        return modelData.googleSheetsSources[0]?.id ?? '';
      });

      if (modelData.defaultResumeSelection === 'single') {
        setGenerateMode('single');
        setMultipleTarget('group');
        setSelectedGroupId('');
        setSheetsTargetMode('single');
        setSelectedSheetsGroupId('');
      } else if (modelData.defaultResumeSelection === 'all') {
        setGenerateMode('multiple');
        setMultipleTarget('all');
        setSelectedGroupId('');
        setSheetsTargetMode('all');
        setSelectedSheetsGroupId('');
      } else {
        const defaultGroupExists = groupsData.some((group) => group.id === modelData.defaultGroupId);
        setGenerateMode('multiple');
        setMultipleTarget('group');
        const initialGroupId = defaultGroupExists ? modelData.defaultGroupId : '';
        setSelectedGroupId(initialGroupId);
        setSheetsTargetMode('group');
        setSelectedSheetsGroupId(initialGroupId);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load data');
    } finally {
      setIsLoadingData(false);
    }
  };

  const toUnconfirmedItems = (skills?: string[]) =>
    (skills ?? []).map((skill) => ({ original: skill, value: skill }));

  const getDefaultGenerationOptions = () => ({
    format: (modelSettings.defaultResumeDocxEnabled ? 'both' : 'pdf') as 'both' | 'pdf',
    includeCoverLetterDocx: modelSettings.defaultCoverLetterDocxEnabled,
  });
  const shouldShowRoleInput = modelSettings.outputPathUsesJobTitle;
  const hasGoogleSheetSources = modelSettings.googleSheetsSources.length > 0;
  const selectedSheetsProfileName = sheetsTargetMode === 'single'
    ? profiles.find((profile) => profile.id === selectedSheetsProfileId)?.name ?? ''
    : '';

  useEffect(() => {
    if (hasGoogleSheetSources || !isSheetsImportOpen) return;
    setIsSheetsImportOpen(false);
  }, [hasGoogleSheetSources, isSheetsImportOpen]);

  const getSelectedProfilesForSheetsBuilder = () => {
    if (sheetsTargetMode === 'single') {
      if (!selectedSheetsProfileId) {
        throw new Error('Please select a profile before importing from Sheets.');
      }
      const profile = profiles.find((item) => item.id === selectedSheetsProfileId);
      if (!profile) {
        throw new Error('Selected profile could not be found.');
      }
      return [profile];
    }

    if (sheetsTargetMode === 'all') {
      if (!profiles.length) {
        throw new Error('No profiles available for multi-profile generation.');
      }
      return profiles;
    }

    const selectedGroup = groups.find((group) => group.id === selectedSheetsGroupId);
    if (!selectedGroup) {
      throw new Error('Please select a group before importing from Sheets.');
    }

    const selectedProfiles = profiles.filter((profile) => selectedGroup.profileIds.includes(profile.id));
    if (!selectedProfiles.length) {
      throw new Error('Selected group has no enabled profiles.');
    }

    return selectedProfiles;
  };

  const aggregateUnconfirmedFromPreviews = (previews: MultiplePreview[]) => {
    const hardMap = new Map<string, string>();
    const softMap = new Map<string, string>();
    for (const preview of previews) {
      const content = preview.tailoredContent;
      for (const skill of content?.unconfirmedHardSkills ?? []) {
        const key = skill.trim().toLowerCase();
        if (key && !hardMap.has(key)) hardMap.set(key, skill.trim());
      }
      for (const skill of content?.unconfirmedSoftSkills ?? []) {
        const key = skill.trim().toLowerCase();
        if (key && !softMap.has(key)) softMap.set(key, skill.trim());
      }
    }
    return {
      hard: toUnconfirmedItems(Array.from(hardMap.values())),
      soft: toUnconfirmedItems(Array.from(softMap.values())),
    };
  };

  const clearGenerationProgress = () => {
    setGenerationProgress(null);
  };

  const updateGenerationProgress = (
    total: number,
    completed: number,
    phase: string,
    currentProfileName?: string,
    currentCompanyName?: string,
    currentJobTitle?: string,
    currentJobNumber?: number,
    importedJobCount?: number
  ) => {
    setGenerationProgress({
      total,
      completed,
      phase,
      currentProfileName,
      currentCompanyName,
      currentJobTitle,
      currentJobNumber,
      importedJobCount,
    });
  };

  const collectUnconfirmedFromGenerateResult = (
    targetHard: Map<string, string>,
    targetSoft: Map<string, string>,
    result: {
      unconfirmedHardSkills?: string[];
      unconfirmedSoftSkills?: string[];
    }
  ) => {
    for (const skill of result.unconfirmedHardSkills ?? []) {
      const key = skill.trim().toLowerCase();
      if (key && !targetHard.has(key)) {
        targetHard.set(key, skill.trim());
      }
    }
    for (const skill of result.unconfirmedSoftSkills ?? []) {
      const key = skill.trim().toLowerCase();
      if (key && !targetSoft.has(key)) {
        targetSoft.set(key, skill.trim());
      }
    }
  };

  const getSelectedProfilesForManualBuilder = (): Profile[] => {
    if (multipleTarget === 'all') {
      return profiles;
    }

    const selectedGroup = groups.find((group) => group.id === selectedGroupId);
    if (!selectedGroup) {
      throw new Error('Please select a group');
    }

    const selectedProfiles = profiles.filter((profile) => selectedGroup.profileIds.includes(profile.id));
    if (!selectedProfiles.length) {
      throw new Error('Selected group has no enabled profiles.');
    }

    return selectedProfiles;
  };

  const generateSequentialResumes = async ({
    targetProfiles,
    analysis,
    targetCompanyName,
    resolvedRole,
    tailoredContentByProfileId,
  }: {
    targetProfiles: Profile[];
    analysis: JobAnalysis;
    targetCompanyName: string;
    resolvedRole: string;
    tailoredContentByProfileId?: Map<string, TailoredContent | undefined>;
  }) => {
    const failures: GenerationFailure[] = [];
    const unconfirmedHardMap = new Map<string, string>();
    const unconfirmedSoftMap = new Map<string, string>();
    const total = targetProfiles.length;
    let completed = 0;

    updateGenerationProgress(total, 0, 'Preparing resume generation', undefined, targetCompanyName);

    for (const profile of targetProfiles) {
      setGenerationStep(`Generating ${completed + 1}/${total}: ${profile.name} x ${targetCompanyName}`);
      updateGenerationProgress(total, completed, 'Building resumes', profile.name, targetCompanyName);

      try {
        const result = await resumeApi.generate({
          profileId: profile.id,
          templateId: profile.preferredTemplate || 'default',
          jobDescription,
          jobAnalysis: analysis,
          tailoredContent: tailoredContentByProfileId?.get(profile.id),
          companyName: targetCompanyName,
          role: resolvedRole,
          ...getDefaultGenerationOptions(),
        });
        collectUnconfirmedFromGenerateResult(unconfirmedHardMap, unconfirmedSoftMap, result);
      } catch (err) {
        failures.push({
          profileId: profile.id,
          profileName: profile.name,
          companyName: targetCompanyName,
          error: err instanceof Error ? err.message : 'Generation failed',
        });
      } finally {
        completed += 1;
        updateGenerationProgress(total, completed, 'Building resumes', profile.name, targetCompanyName);
      }
    }

    return {
      generated: total - failures.length,
      failed: failures.length,
      failures,
      failedCompanies: failures.length > 0 ? [targetCompanyName] : [],
      unconfirmedHardSkills: Array.from(unconfirmedHardMap.values()),
      unconfirmedSoftSkills: Array.from(unconfirmedSoftMap.values()),
    };
  };

  const handleImportJobsFromSheets = async (
    importedJobs: ImportedSheetJob[],
    meta: { skippedRows: number }
  ) => {
    const selectedProfiles = getSelectedProfilesForSheetsBuilder();
    const fallbackRole = shouldShowRoleInput ? role.trim() : '';
    const normalizedJobs = importedJobs.map((job) => ({
      ...job,
      jobTitle: job.jobTitle.trim() || fallbackRole,
    }));

    setIsGenerating(true);
    setError('');
    setSuccessMessage('');
    resetGenerationOutputs();

    const failures: string[] = [];
    const failedCompanies = new Set<string>();
    const unconfirmedHardMap = new Map<string, string>();
    const unconfirmedSoftMap = new Map<string, string>();
    const totalBuilds = selectedProfiles.length * normalizedJobs.length;
    let completedBuilds = 0;
    let failedBuilds = 0;
    let hasSetJobAnalysis = false;

    try {
      updateGenerationProgress(
        totalBuilds,
        0,
        'Preparing imported jobs',
        undefined,
        undefined,
        undefined,
        undefined,
        normalizedJobs.length
      );
      for (const [jobIndex, job] of normalizedJobs.entries()) {
        const trimmedJobDescription = job.jobDescription.trim();
        const normalizedCompanyName = job.companyName.trim();
        const importedJobTitle = job.jobTitle.trim();

        setGenerationStep(`Analyzing job ${jobIndex + 1}/${normalizedJobs.length}: ${normalizedCompanyName}`);
        updateGenerationProgress(
          totalBuilds,
          completedBuilds,
          'Analyzing job description',
          undefined,
          normalizedCompanyName,
          importedJobTitle,
          jobIndex + 1,
          normalizedJobs.length
        );

        try {
          const analysis = await resumeApi.analyze(trimmedJobDescription);
          if (!hasSetJobAnalysis) {
            setJobAnalysis(analysis);
            hasSetJobAnalysis = true;
          }

          const resolvedRole = shouldShowRoleInput
            ? (job.jobTitle.trim() || fallbackRole || getAnalysisJobTitle(analysis) || '')
            : (job.jobTitle.trim() || getAnalysisJobTitle(analysis) || '');

          for (const profile of selectedProfiles) {
            setGenerationStep(`Generating ${completedBuilds + 1}/${totalBuilds}: ${profile.name} x ${normalizedCompanyName}`);
            updateGenerationProgress(
              totalBuilds,
              completedBuilds,
              'Building resumes',
              profile.name,
              normalizedCompanyName,
              resolvedRole,
              jobIndex + 1,
              normalizedJobs.length
            );

            try {
              const result = await resumeApi.generate({
                profileId: profile.id,
                templateId: profile.preferredTemplate || 'default',
                jobDescription: trimmedJobDescription,
                jobAnalysis: analysis,
                companyName: normalizedCompanyName,
                role: resolvedRole,
                sourceRowNumber: job.sourceRowNumber,
                ...getDefaultGenerationOptions(),
              });
              collectUnconfirmedFromGenerateResult(unconfirmedHardMap, unconfirmedSoftMap, result);
            } catch (err) {
              failedCompanies.add(normalizedCompanyName);
              failedBuilds += 1;
              failures.push(
                `${normalizedCompanyName} / ${profile.name}: ${err instanceof Error ? err.message : 'Generation failed'}`
              );
            } finally {
              completedBuilds += 1;
              updateGenerationProgress(
                totalBuilds,
                completedBuilds,
                'Building resumes',
                profile.name,
                normalizedCompanyName,
                resolvedRole,
                jobIndex + 1,
                normalizedJobs.length
              );
            }
          }
        } catch (err) {
          failedCompanies.add(normalizedCompanyName);
          failedBuilds += selectedProfiles.length;
          failures.push(
            `Row ${job.sourceRowNumber} / ${normalizedCompanyName}: ${err instanceof Error ? err.message : 'Analysis failed'}`
          );
          completedBuilds += selectedProfiles.length;
          updateGenerationProgress(
            totalBuilds,
            completedBuilds,
            'Analyzing job description',
            undefined,
            normalizedCompanyName,
            importedJobTitle,
            jobIndex + 1,
            normalizedJobs.length
          );
        }
      }

      setUnconfirmedHardSkills(toUnconfirmedItems(Array.from(unconfirmedHardMap.values())));
      setUnconfirmedSoftSkills(toUnconfirmedItems(Array.from(unconfirmedSoftMap.values())));

      const generatedCount = totalBuilds - failedBuilds;
      const skippedNote = meta.skippedRows
        ? ` Skipped ${meta.skippedRows} imported row(s) with missing required values.`
        : '';
      setSuccessMessage(
        `Generated ${generatedCount} build(s) from ${normalizedJobs.length} imported job(s) across ${selectedProfiles.length} profile(s).${skippedNote}`
      );

      if (failures.length) {
        const failedCompanySummary = formatCompanySummary(Array.from(failedCompanies));
        setError(
          `Some builds failed (${failedBuilds}/${totalBuilds}). Failed companies: ${failedCompanySummary || 'Unknown'}. ${failures.slice(0, 3).join(' | ')}${failures.length > 3 ? ' | ...' : ''}`
        );
      }
    } finally {
      setIsGenerating(false);
      setGenerationStep('');
      clearGenerationProgress();
    }
  };

  const handleGenerate = async () => {
    if (!companyName.trim()) {
      setError('Please enter a company name');
      return;
    }
    if (shouldShowRoleInput && !role.trim()) {
      setError('Please enter a role');
      return;
    }
    if (jobDescription.trim().length < 50) {
      setError('Please provide a job description (minimum 50 characters)');
      return;
    }
    if (generateMode === 'single' && !selectedProfileId) {
      setError('Please select a profile');
      return;
    }
    if (generateMode === 'multiple' && profiles.length === 0) {
      setError('No profiles available');
      return;
    }
    if (generateMode === 'multiple' && multipleTarget === 'group') {
      const selectedGroup = groups.find((group) => group.id === selectedGroupId);
      if (!selectedGroup) {
        setError('Please select a group');
        return;
      }
      if (!selectedGroup.profileIds.length) {
        setError('Selected group has no members');
        return;
      }
    }

    setIsGenerating(true);
    setError('');
    setSuccessMessage('');
    setPreviewHtml('');
    setPreviewTailored(false);
    setIsSinglePreviewOpen(false);
    resetTailoredEditor();
    setJobAnalysis(null);
    setMultiplePreviews([]);
    setMultiplePreviewTailored(false);
    setMultiplePreviewIndex(0);

    try {
      setGenerationStep('Analyzing job description...');
      clearGenerationProgress();
      const analysis = await resumeApi.analyze(jobDescription, '');
      setJobAnalysis(analysis);

      if (generateMode === 'single' && !autoGenerate) {
        setGenerationStep('Building preview...');
        const profile = profiles.find((p) => p.id === selectedProfileId);
        const templateId = profile?.preferredTemplate || 'default';
        const preview = await resumeApi.preview({
          profileId: selectedProfileId!,
          templateId,
          jobDescription,
          jobAnalysis: analysis,
        });
        setPreviewHtml(preview.html);
        setPreviewTailored(preview.tailored);
        setIsSinglePreviewOpen(true);
        if (preview.tailoredContent) {
          setTailoredContent(preview.tailoredContent);
          setTailoredContentDraft(JSON.stringify(preview.tailoredContent, null, 2));
          setTailoredContentError('');
          setUnconfirmedHardSkills(toUnconfirmedItems(preview.tailoredContent.unconfirmedHardSkills));
          setUnconfirmedSoftSkills(toUnconfirmedItems(preview.tailoredContent.unconfirmedSoftSkills));
        }
        setSuccessMessage('Preview generated. Review, edit manually if needed, then click Generate Resume to finalize.');
        return;
      }

      if (generateMode === 'multiple' && !autoGenerate) {
        const profileIds =
          multipleTarget === 'group'
            ? groups.find((group) => group.id === selectedGroupId)?.profileIds
            : undefined;
        if (multipleTarget === 'group' && !profileIds) {
          setError('Please select a group');
          return;
        }

        setGenerationStep('Building previews...');
        const res = await resumeApi.previewAll({
          jobDescription,
          jobAnalysis: analysis,
          profileIds,
        });
        const previewsWithDrafts = res.previews.map((preview) => ({
          ...preview,
          draft: preview.tailoredContent
            ? JSON.stringify(preview.tailoredContent, null, 2)
            : '',
          error: '',
        }));
        setMultiplePreviews(previewsWithDrafts);
        setMultiplePreviewTailored(res.tailored);
        setMultiplePreviewIndex(0);
        const aggregated = aggregateUnconfirmedFromPreviews(previewsWithDrafts);
        setUnconfirmedHardSkills(aggregated.hard);
        setUnconfirmedSoftSkills(aggregated.soft);
        setSuccessMessage(`Preview generated for ${res.previews.length} profile(s). Review, then click Generate All to finalize.`);
        return;
      }


      if (generateMode === 'single') {
        const profile = profiles.find((p) => p.id === selectedProfileId);
        const templateId = profile?.preferredTemplate || 'default';
        updateGenerationProgress(1, 0, 'Building resume', profile?.name, companyName.trim());
        setGenerationStep(`Generating 1/1: ${profile?.name ?? 'Selected profile'} x ${companyName.trim()}`);
        const result = await resumeApi.generate({
          profileId: selectedProfileId!,
          templateId,
          jobDescription,
          jobAnalysis: analysis,
          companyName: companyName.trim(),
          role: shouldShowRoleInput ? role.trim() : (getAnalysisJobTitle(analysis) || ''),
          ...getDefaultGenerationOptions(),
        });
        updateGenerationProgress(1, 1, 'Building resume', profile?.name, companyName.trim());
        setSuccessMessage('Resume generated successfully.');
        setIsSinglePreviewOpen(false);
        setUnconfirmedHardSkills(toUnconfirmedItems(result.unconfirmedHardSkills));
        setUnconfirmedSoftSkills(toUnconfirmedItems(result.unconfirmedSoftSkills));
      } else {
        const targetProfiles = getSelectedProfilesForManualBuilder();
        const res = await generateSequentialResumes({
          targetProfiles,
          analysis,
          targetCompanyName: companyName.trim(),
          resolvedRole: shouldShowRoleInput ? role.trim() : (getAnalysisJobTitle(analysis) || ''),
        });
        if (multipleTarget === 'group') {
          const selectedGroup = groups.find((group) => group.id === selectedGroupId)!;
          setSuccessMessage(`Generated ${res.generated} resume(s) for group "${selectedGroup.name}".`);
        } else {
          setSuccessMessage(`Generated ${res.generated} resume(s) successfully.`);
        }
        if (res.failed > 0) {
          setError(
            `Skipped ${res.failed} build(s). Failed companies: ${formatCompanySummary(res.failedCompanies) || companyName.trim()}. ${res.failures.slice(0, 3).map((failure) => `${failure.profileName}: ${failure.error}`).join(' | ')}${res.failures.length > 3 ? ' | ...' : ''}`
          );
        }
        setUnconfirmedHardSkills(toUnconfirmedItems(res.unconfirmedHardSkills));
        setUnconfirmedSoftSkills(toUnconfirmedItems(res.unconfirmedSoftSkills));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate resume');
    } finally {
      setIsGenerating(false);
      setGenerationStep('');
      clearGenerationProgress();
    }
  };


  const handleTailoredContentChange = (value: string) => {
    setTailoredContentDraft(value);
    if (!value.trim()) {
      setTailoredContent(null);
      setTailoredContentError('');
      return;
    }
    try {
      const parsed = JSON.parse(value) as TailoredContent;
      setTailoredContent(parsed);
      setTailoredContentError('');
    } catch {
      setTailoredContentError('Invalid JSON. Fix errors before generating.');
    }
  };

  const handleUnconfirmedSkillEdit = (
    type: 'hard' | 'soft',
    original: string,
    value: string
  ) => {
    const update = (items: UnconfirmedSkill[]) =>
      items.map((item) => (item.original === original ? { ...item, value } : item));
    if (type === 'hard') {
      setUnconfirmedHardSkills(update);
    } else {
      setUnconfirmedSoftSkills(update);
    }
  };

  const handleRemoveUnconfirmedSkill = (type: 'hard' | 'soft', skill: UnconfirmedSkill) => {
    const remove = (items: UnconfirmedSkill[]) =>
      items.filter((item) => item.original !== skill.original);
    if (type === 'hard') {
      setUnconfirmedHardSkills(remove);
    } else {
      setUnconfirmedSoftSkills(remove);
    }

    if (tailoredContent) {
      const normalizedOriginal = skill.original.trim().toLowerCase();
      const nextTailored: TailoredContent = {
        ...tailoredContent,
        unconfirmedHardSkills:
          type === 'hard'
            ? (tailoredContent.unconfirmedHardSkills ?? []).filter(
                (item) => item.trim().toLowerCase() !== normalizedOriginal
              )
            : tailoredContent.unconfirmedHardSkills,
        unconfirmedSoftSkills:
          type === 'soft'
            ? (tailoredContent.unconfirmedSoftSkills ?? []).filter(
                (item) => item.trim().toLowerCase() !== normalizedOriginal
              )
            : tailoredContent.unconfirmedSoftSkills,
      };
      setTailoredContent(nextTailored);
      const currentDraft = tailoredContentDraft.trim();
      if (currentDraft && currentDraft === JSON.stringify(tailoredContent, null, 2)) {
        setTailoredContentDraft(JSON.stringify(nextTailored, null, 2));
      }
    } else if (multiplePreviews.length > 0) {
      const normalizedOriginal = skill.original.trim().toLowerCase();
      const nextPreviews = multiplePreviews.map((item) => {
        if (!item.tailoredContent) return item;
        const nextTailored: TailoredContent = {
          ...item.tailoredContent,
          unconfirmedHardSkills:
            type === 'hard'
              ? (item.tailoredContent.unconfirmedHardSkills ?? []).filter(
                  (value) => value.trim().toLowerCase() !== normalizedOriginal
                )
              : item.tailoredContent.unconfirmedHardSkills,
          unconfirmedSoftSkills:
            type === 'soft'
              ? (item.tailoredContent.unconfirmedSoftSkills ?? []).filter(
                  (value) => value.trim().toLowerCase() !== normalizedOriginal
                )
              : item.tailoredContent.unconfirmedSoftSkills,
        };
        return {
          ...item,
          tailoredContent: nextTailored,
          draft: JSON.stringify(nextTailored, null, 2),
        };
      });
      setMultiplePreviews(nextPreviews);
      const aggregated = aggregateUnconfirmedFromPreviews(nextPreviews);
      setUnconfirmedHardSkills(aggregated.hard);
      setUnconfirmedSoftSkills(aggregated.soft);
    }
  };

  const handleConfirmSkill = async (type: 'hard' | 'soft', skill: UnconfirmedSkill) => {
    const cleaned = skill.value.trim();
    if (!cleaned) {
      setError('Skill cannot be empty');
      return;
    }

    try {
      setIsGenerating(true);
      setError('');
      await resumeApi.confirmSkill({ type, skill: cleaned });

      const remove = (items: UnconfirmedSkill[]) =>
        items.filter((item) => item.original !== skill.original);

      if (type === 'hard') {
        setUnconfirmedHardSkills(remove);
      } else {
        setUnconfirmedSoftSkills(remove);
      }

      if (tailoredContent) {
        const normalizedOriginal = skill.original.trim().toLowerCase();
        const currentHard = tailoredContent.hardSkills ?? [];
        const currentSoft = tailoredContent.softSkills ?? [];
        const nextHard =
          type === 'hard'
            ? Array.from(
                new Set([
                  ...currentHard,
                  cleaned,
                ].map((item) => item.trim()).filter(Boolean))
              )
            : currentHard;
        const nextSoft =
          type === 'soft'
            ? Array.from(
                new Set([
                  ...currentSoft,
                  cleaned,
                ].map((item) => item.trim()).filter(Boolean))
              )
            : currentSoft;

        const nextTailored: TailoredContent = {
          ...tailoredContent,
          hardSkills: nextHard,
          softSkills: nextSoft,
          unconfirmedHardSkills:
            type === 'hard'
              ? (tailoredContent.unconfirmedHardSkills ?? []).filter(
                  (item) => item.trim().toLowerCase() !== normalizedOriginal
                )
              : tailoredContent.unconfirmedHardSkills,
          unconfirmedSoftSkills:
            type === 'soft'
              ? (tailoredContent.unconfirmedSoftSkills ?? []).filter(
                  (item) => item.trim().toLowerCase() !== normalizedOriginal
                )
              : tailoredContent.unconfirmedSoftSkills,
        };
        setTailoredContent(nextTailored);
        const currentDraft = tailoredContentDraft.trim();
        if (currentDraft && currentDraft === JSON.stringify(tailoredContent, null, 2)) {
          setTailoredContentDraft(JSON.stringify(nextTailored, null, 2));
        }
        if (selectedProfileId) {
          const profile = profiles.find((p) => p.id === selectedProfileId);
          const templateId = profile?.preferredTemplate || 'default';
          const refreshed = await resumeApi.preview({
            profileId: selectedProfileId!,
            templateId,
            jobDescription,
            jobAnalysis: jobAnalysis || undefined,
            tailoredContent: nextTailored,
          });
          setPreviewHtml(refreshed.html);
          setPreviewTailored(refreshed.tailored);
          setIsSinglePreviewOpen(true);
        }
      }

      if (!tailoredContent && multiplePreviews.length > 0) {
        const normalizedOriginal = skill.original.trim().toLowerCase();
        const updatedProfiles: Array<{ profileId: string; nextTailored: TailoredContent }> = [];
        let nextPreviews = multiplePreviews.map((item) => {
          if (!item.tailoredContent) return item;
          const unconfirmedHard = item.tailoredContent.unconfirmedHardSkills ?? [];
          const unconfirmedSoft = item.tailoredContent.unconfirmedSoftSkills ?? [];
          const hasMatch =
            (type === 'hard' && unconfirmedHard.some((value) => value.trim().toLowerCase() === normalizedOriginal)) ||
            (type === 'soft' && unconfirmedSoft.some((value) => value.trim().toLowerCase() === normalizedOriginal));
          if (!hasMatch) return item;

          const currentHard = item.tailoredContent.hardSkills ?? [];
          const currentSoft = item.tailoredContent.softSkills ?? [];
          const nextHard =
            type === 'hard'
              ? Array.from(
                  new Set(
                    [...currentHard, cleaned].map((value) => value.trim()).filter(Boolean)
                  )
                )
              : currentHard;
          const nextSoft =
            type === 'soft'
              ? Array.from(
                  new Set(
                    [...currentSoft, cleaned].map((value) => value.trim()).filter(Boolean)
                  )
                )
              : currentSoft;

          const nextTailored: TailoredContent = {
            ...item.tailoredContent,
            hardSkills: nextHard,
            softSkills: nextSoft,
            unconfirmedHardSkills:
              type === 'hard'
                ? unconfirmedHard.filter(
                    (value) => value.trim().toLowerCase() !== normalizedOriginal
                  )
                : unconfirmedHard,
            unconfirmedSoftSkills:
              type === 'soft'
                ? unconfirmedSoft.filter(
                    (value) => value.trim().toLowerCase() !== normalizedOriginal
                  )
                : unconfirmedSoft,
          };

          updatedProfiles.push({ profileId: item.profileId, nextTailored });

          return {
            ...item,
            tailoredContent: nextTailored,
            draft: JSON.stringify(nextTailored, null, 2),
            error: item.error,
          };
        });

        if (updatedProfiles.length > 0) {
          const refreshedList = await Promise.all(
            updatedProfiles.map(async ({ profileId, nextTailored }) => {
              const profile = profiles.find((p) => p.id === profileId);
              const templateId = profile?.preferredTemplate || 'default';
              const refreshed = await resumeApi.preview({
                profileId,
                templateId,
                jobDescription,
                jobAnalysis: jobAnalysis || undefined,
                tailoredContent: nextTailored,
              });
              return {
                profileId,
                html: refreshed.html,
                tailored: refreshed.tailored,
                tailoredContent: refreshed.tailoredContent ?? nextTailored,
              };
            })
          );
          if (refreshedList.some((item) => item.tailored)) {
            setMultiplePreviewTailored(true);
          }
          const refreshedMap = new Map(refreshedList.map((item) => [item.profileId, item]));
          nextPreviews = nextPreviews.map((item) => {
            const refreshed = refreshedMap.get(item.profileId);
            if (!refreshed) return item;
            return {
              ...item,
              html: refreshed.html,
              tailoredContent: refreshed.tailoredContent,
              draft: JSON.stringify(refreshed.tailoredContent, null, 2),
            };
          });
        }

        setMultiplePreviews(nextPreviews);
        const aggregated = aggregateUnconfirmedFromPreviews(nextPreviews);
        setUnconfirmedHardSkills(aggregated.hard);
        setUnconfirmedSoftSkills(aggregated.soft);
      }
      setSuccessMessage(`Added "${cleaned}" to ${type === 'hard' ? 'tech' : 'soft'} skills.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to confirm skill');
    } finally {
      setIsGenerating(false);
      setGenerationStep('');
    }
  };

  const handleUpdatePreview = async () => {
    if (!selectedProfileId) {
      setError('Please select a profile');
      return;
    }
    if (tailoredContentError) {
      setError('Fix manual edits before updating preview.');
      return;
    }
    if (!tailoredContent) {
      setError('No tailored content to preview.');
      return;
    }

    setIsGenerating(true);
    setError('');
    setSuccessMessage('');

    try {
      setGenerationStep('Updating preview...');
      const profile = profiles.find((p) => p.id === selectedProfileId);
      const templateId = profile?.preferredTemplate || 'default';
      const preview = await resumeApi.preview({
        profileId: selectedProfileId!,
        templateId,
        jobDescription,
        jobAnalysis: jobAnalysis || undefined,
        tailoredContent,
      });
      setPreviewHtml(preview.html);
      setPreviewTailored(preview.tailored);
      setIsSinglePreviewOpen(true);
      setUnconfirmedHardSkills(toUnconfirmedItems(preview.tailoredContent?.unconfirmedHardSkills));
      setUnconfirmedSoftSkills(toUnconfirmedItems(preview.tailoredContent?.unconfirmedSoftSkills));
      setSuccessMessage('Preview updated.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update preview');
    } finally {
      setIsGenerating(false);
      setGenerationStep('');
    }
  };

  const handleFinalizeGenerate = async () => {
    if (!companyName.trim() || (shouldShowRoleInput && !role.trim()) || jobDescription.trim().length < 50 || !selectedProfileId) {
      setError('Please complete the required fields before generating.');
      return;
    }
    if (tailoredContentError) {
      setError('Fix manual edits before generating.');
      return;
    }

    setIsGenerating(true);
    setError('');
    setSuccessMessage('');

    try {
      const analysis = jobAnalysis || (await resumeApi.analyze(jobDescription));
      if (!jobAnalysis) {
        setJobAnalysis(analysis);
      }
      const profile = profiles.find((p) => p.id === selectedProfileId);
      const templateId = profile?.preferredTemplate || 'default';
      updateGenerationProgress(1, 0, 'Building resume', profile?.name, companyName.trim());
      setGenerationStep(`Generating 1/1: ${profile?.name ?? 'Selected profile'} x ${companyName.trim()}`);
      const result = await resumeApi.generate({
        profileId: selectedProfileId!,
        templateId,
        jobDescription,
        jobAnalysis: analysis,
        tailoredContent: tailoredContent || undefined,
        companyName: companyName.trim(),
        role: shouldShowRoleInput ? role.trim() : (getAnalysisJobTitle(analysis) || ''),
        ...getDefaultGenerationOptions(),
      });
      updateGenerationProgress(1, 1, 'Building resume', profile?.name, companyName.trim());
      setSuccessMessage('Resume generated successfully.');
      setIsSinglePreviewOpen(false);
      setUnconfirmedHardSkills(toUnconfirmedItems(result.unconfirmedHardSkills));
      setUnconfirmedSoftSkills(toUnconfirmedItems(result.unconfirmedSoftSkills));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate resume');
    } finally {
      setIsGenerating(false);
      setGenerationStep('');
      clearGenerationProgress();
    }
  };

  const handleMultipleDraftChange = (profileId: string, value: string) => {
    setMultiplePreviews((prev) =>
      prev.map((preview) => {
        if (preview.profileId != profileId) return preview;
        let nextError = '';
        let nextTailored = preview.tailoredContent;
        if (!value.trim()) {
          nextTailored = undefined;
        } else {
          try {
            nextTailored = JSON.parse(value) as TailoredContent;
          } catch {
            nextError = 'Invalid JSON. Fix errors before updating preview.';
          }
        }
        return {
          ...preview,
          draft: value,
          error: nextError,
          tailoredContent: nextTailored,
        };
      })
    );
  };

  const handleUpdateMultiplePreview = async (profileId: string) => {
    const preview = multiplePreviews.find((item) => item.profileId === profileId);
    if (!preview) return;
    if (preview.error) {
      setError('Fix manual edits before updating preview.');
      return;
    }
    if (!preview.tailoredContent) {
      setError('No tailored content to preview.');
      return;
    }

    setIsGenerating(true);
    setError('');
    setSuccessMessage('');

    try {
      setGenerationStep(`Updating preview for ${preview.profileName}...`);
      const profile = profiles.find((p) => p.id === profileId);
      const templateId = profile?.preferredTemplate || 'default';
      const updated = await resumeApi.preview({
        profileId,
        templateId,
        jobDescription,
        jobAnalysis: jobAnalysis || undefined,
        tailoredContent: preview.tailoredContent,
      });
      const nextPreviews = multiplePreviews.map((item) => {
        if (item.profileId !== profileId) return item;
        const nextTailored = updated.tailoredContent;
        return {
          ...item,
          html: updated.html,
          tailoredContent: nextTailored,
          draft: nextTailored ? JSON.stringify(nextTailored, null, 2) : '',
          error: '',
        };
      });
      setMultiplePreviews(nextPreviews);
      const aggregated = aggregateUnconfirmedFromPreviews(nextPreviews);
      setUnconfirmedHardSkills(aggregated.hard);
      setUnconfirmedSoftSkills(aggregated.soft);
      setSuccessMessage(`Preview updated for ${preview.profileName}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update preview');
    } finally {
      setIsGenerating(false);
      setGenerationStep('');
    }
  };

  const handleFinalizeGenerateMultiple = async () => {
    if (!companyName.trim() || (shouldShowRoleInput && !role.trim()) || jobDescription.trim().length < 50) {
      setError('Please complete the required fields before generating.');
      return;
    }

    if (multipleTarget === 'group') {
      const selectedGroup = groups.find((group) => group.id === selectedGroupId);
      if (!selectedGroup) {
        setError('Please select a group');
        return;
      }
      if (!selectedGroup.profileIds.length) {
        setError('Selected group has no members');
        return;
      }
    }

    setIsGenerating(true);
    setError('');
    setSuccessMessage('');

    try {
      const analysis = jobAnalysis || (await resumeApi.analyze(jobDescription));
      if (!jobAnalysis) {
        setJobAnalysis(analysis);
      }

      if (!autoGenerate && multiplePreviews.length > 0) {
        const previewMap = new Map(multiplePreviews.map((p) => [p.profileId, p]));
        const targetProfiles =
          multipleTarget === 'group'
            ? profiles.filter((p) => p.id &&
                groups.find((g) => g.id === selectedGroupId)?.profileIds.includes(p.id))
            : profiles;
        const profilesToGenerate = targetProfiles.filter((profile) => previewMap.get(profile.id)?.tailoredContent);
        if (!profilesToGenerate.length) {
          throw new Error('No preview content available to generate.');
        }
        const total = profilesToGenerate.length;
        let completed = 0;

        updateGenerationProgress(total, 0, 'Preparing resume generation', undefined, companyName.trim());
        for (const profile of profilesToGenerate) {
          const preview = previewMap.get(profile.id);
          if (!preview?.tailoredContent) continue;
          const templateId = profile.preferredTemplate || 'default';
          setGenerationStep(`Generating ${completed + 1}/${total}: ${profile.name} x ${companyName.trim()}`);
          updateGenerationProgress(total, completed, 'Building resumes', profile.name, companyName.trim());
          await resumeApi.generate({
            profileId: profile.id,
            templateId,
            jobDescription,
            jobAnalysis: analysis,
            tailoredContent: preview.tailoredContent,
            companyName: companyName.trim(),
            role: shouldShowRoleInput ? role.trim() : (getAnalysisJobTitle(analysis) || ''),
            ...getDefaultGenerationOptions(),
          });
          completed += 1;
          updateGenerationProgress(total, completed, 'Building resumes', profile.name, companyName.trim());
        }
        setSuccessMessage(`Generated ${profilesToGenerate.length} resume(s) successfully.`);
        const aggregated = aggregateUnconfirmedFromPreviews(multiplePreviews);
        setUnconfirmedHardSkills(aggregated.hard);
        setUnconfirmedSoftSkills(aggregated.soft);
        setMultiplePreviews([]);
        setMultiplePreviewIndex(0);
        setMultiplePreviewTailored(false);
        return;
      }

      const targetProfiles = getSelectedProfilesForManualBuilder();
      const res = await generateSequentialResumes({
        targetProfiles,
        analysis,
        targetCompanyName: companyName.trim(),
        resolvedRole: shouldShowRoleInput ? role.trim() : (getAnalysisJobTitle(analysis) || ''),
      });
      if (multipleTarget === 'group') {
        const selectedGroup = groups.find((group) => group.id === selectedGroupId)!;
        setSuccessMessage(`Generated ${res.generated} resume(s) for group "${selectedGroup.name}".`);
      } else {
        setSuccessMessage(`Generated ${res.generated} resume(s) successfully.`);
      }
      if (res.failed > 0) {
        setError(
          `Skipped ${res.failed} build(s). Failed companies: ${formatCompanySummary(res.failedCompanies) || companyName.trim()}. ${res.failures.slice(0, 3).map((failure) => `${failure.profileName}: ${failure.error}`).join(' | ')}${res.failures.length > 3 ? ' | ...' : ''}`
        );
      }
      setUnconfirmedHardSkills(toUnconfirmedItems(res.unconfirmedHardSkills));
      setUnconfirmedSoftSkills(toUnconfirmedItems(res.unconfirmedSoftSkills));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate resume');
    } finally {
      setIsGenerating(false);
      setGenerationStep('');
      clearGenerationProgress();
    }
  };

  const activeMultiplePreview = multiplePreviews[multiplePreviewIndex];

  const unconfirmedPanel = (
    <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
      <div className="text-sm font-medium text-gray-700">Unregistered Skills</div>
      {unconfirmedHardSkills.length === 0 && unconfirmedSoftSkills.length === 0 && (
        <div className="text-xs text-gray-500">No unregistered skills found.</div>
      )}
      {unconfirmedHardSkills.length > 0 && (
        <div className="space-y-3">
          <div className="text-xs font-semibold text-gray-600">Tech Skills</div>
          <div className="grid grid-cols-2 gap-2">
            {unconfirmedHardSkills.map((skill) => (
              <div key={`uh-${skill.original}`} className="flex items-center gap-2">
                <input
                  type="text"
                  value={skill.value}
                  onChange={(e) =>
                    handleUnconfirmedSkillEdit('hard', skill.original, e.target.value)
                  }
                  disabled={isGenerating}
                  className="flex-1 px-2 py-1 border border-gray-300 rounded-md text-sm"
                />
                <button
                  type="button"
                  onClick={() => handleConfirmSkill('hard', skill)}
                  disabled={isGenerating}
                  className="px-2 py-1 text-xs bg-gray-800 text-white rounded-md hover:bg-gray-900 disabled:bg-gray-400"
                >
                  Add
                </button>
                <button
                  type="button"
                  onClick={() => handleRemoveUnconfirmedSkill('hard', skill)}
                  disabled={isGenerating}
                  className="px-2 py-1 text-xs border border-gray-300 text-gray-700 rounded-md hover:bg-gray-50 disabled:text-gray-400"
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
      {unconfirmedSoftSkills.length > 0 && (
        <div className="space-y-3">
          <div className="text-xs font-semibold text-gray-600">Soft Skills</div>
          <div className="grid grid-cols-2 gap-2">
            {unconfirmedSoftSkills.map((skill) => (
              <div key={`us-${skill.original}`} className="flex items-center gap-2">
                <input
                  type="text"
                  value={skill.value}
                  onChange={(e) =>
                    handleUnconfirmedSkillEdit('soft', skill.original, e.target.value)
                  }
                  disabled={isGenerating}
                  className="flex-1 px-2 py-1 border border-gray-300 rounded-md text-sm"
                />
                <button
                  type="button"
                  onClick={() => handleConfirmSkill('soft', skill)}
                  disabled={isGenerating}
                  className="px-2 py-1 text-xs bg-gray-800 text-white rounded-md hover:bg-gray-900 disabled:bg-gray-400"
                >
                  Add
                </button>
                <button
                  type="button"
                  onClick={() => handleRemoveUnconfirmedSkill('soft', skill)}
                  disabled={isGenerating}
                  className="px-2 py-1 text-xs border border-gray-300 text-gray-700 rounded-md hover:bg-gray-50 disabled:text-gray-400"
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );

  if (isLoadingData) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-50">
        <div className="text-center">
          <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-blue-600 mx-auto"></div>
          <p className="mt-4 text-gray-600">Loading...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      <AppTopNav />

      {/* Main Content */}
      <main className="max-w-2xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <h1 className="text-2xl font-bold text-gray-900 mb-6">Generate Resumes</h1>

        {error && (
          <div className="mb-6 bg-red-50 border border-red-200 text-red-700 px-4 py-3 rounded-lg flex justify-between items-center">
            <span>{error}</span>
            <button onClick={() => setError('')} className="text-red-700 hover:text-red-900 font-bold">
              ×
            </button>
          </div>
        )}

        {successMessage && (
          <div className="mb-6 bg-green-50 border border-green-200 text-green-700 px-4 py-3 rounded-lg">
            {successMessage}
          </div>
        )}

        {builderMode === 'sheets' && isGenerating && generationProgress && (
          <GenerationProgress progress={generationProgress} className="mb-6" />
        )}

        {builderMode === null && (
          <div className="mb-6 grid gap-4 md:grid-cols-2">
          <button
            type="button"
            onClick={() => setBuilderMode('manual')}
            disabled={isGenerating}
            className={`rounded-xl border px-6 py-6 text-left transition ${
              builderMode === 'manual'
                ? 'border-blue-300 bg-blue-50 shadow-sm'
                : 'border-gray-200 bg-white hover:border-gray-300 hover:bg-gray-50'
            }`}
          >
            <div className="text-lg font-semibold text-gray-900">Building Manually</div>
            <div className="mt-2 text-sm text-gray-600">
              Original builder flow. Enter company, role, and job description manually, then preview or generate.
            </div>
          </button>

          <button
            type="button"
            onClick={() => setBuilderMode('sheets')}
            disabled={isGenerating}
            className={`rounded-xl border px-6 py-6 text-left transition ${
              builderMode === 'sheets'
                ? 'border-blue-300 bg-blue-50 shadow-sm'
                : 'border-gray-200 bg-white hover:border-gray-300 hover:bg-gray-50'
            }`}
          >
            <div className="text-lg font-semibold text-gray-900">Building Automatically from Google Sheet</div>
            <div className="mt-2 text-sm text-gray-600">
              Import jobs from Google Sheets, map columns once, then generate every selected profile against every imported row.
            </div>
          </button>
          </div>
        )}

        {builderMode !== null && (builderMode === 'manual' ? (
          <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => {
                  setBuilderMode(null);
                  setIsSheetsImportOpen(false);
                }}
                disabled={isGenerating}
                className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60"
              >
                Back
              </button>
            </div>
            <button
              onClick={handleGenerate}
              disabled={isGenerating}
              className="w-full py-3 px-4 bg-blue-600 text-white font-medium rounded-lg hover:bg-blue-700 disabled:bg-blue-400 disabled:cursor-not-allowed flex items-center justify-center gap-2"
            >
              {isGenerating ? (
                <>
                  <span className="animate-spin rounded-full h-5 w-5 border-2 border-white border-t-transparent"></span>
                  {generationStep || 'Generating...'}
                </>
              ) : (
                generateMode === 'single'
                  ? autoGenerate
                    ? 'Generate Resume'
                    : 'Analyze & Preview'
                  : autoGenerate
                    ? `Generate All (${profiles.length} profiles)`
                    : 'Analyze & Preview'
              )}
            </button>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-3">
                Generate mode
              </label>
              <div className="flex gap-4">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="generateMode"
                    value="single"
                    checked={generateMode === 'single'}
                    onChange={() => setGenerateMode('single')}
                    disabled={isGenerating}
                    className="w-4 h-4 text-blue-600"
                  />
                  <span>Single (one profile)</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="generateMode"
                    value="multiple"
                    checked={generateMode === 'multiple'}
                    onChange={() => setGenerateMode('multiple')}
                    disabled={isGenerating}
                    className="w-4 h-4 text-blue-600"
                  />
                  <span>Multiple (all profiles)</span>
                </label>
              </div>
            </div>

            {generateMode === 'single' && (
              <ProfileSelector
                profiles={profiles}
                selectedId={selectedProfileId}
                onChange={setSelectedProfileId}
                isLoading={false}
              />
            )}

            {generateMode === 'multiple' && (
              <div className="space-y-4 border border-gray-200 rounded-lg p-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700 mb-2">Target</label>
                  <div className="flex gap-4">
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name="multipleTarget"
                        value="all"
                        checked={multipleTarget === 'all'}
                        onChange={() => setMultipleTarget('all')}
                        disabled={isGenerating}
                        className="w-4 h-4 text-blue-600"
                      />
                      <span>All profiles</span>
                    </label>
                    <label className="flex items-center gap-2 cursor-pointer">
                      <input
                        type="radio"
                        name="multipleTarget"
                        value="group"
                        checked={multipleTarget === 'group'}
                        onChange={() => setMultipleTarget('group')}
                        disabled={isGenerating}
                        className="w-4 h-4 text-blue-600"
                      />
                      <span>Specific group</span>
                    </label>
                  </div>
                </div>

                {multipleTarget === 'group' && (
                  <div>
                    <label className="block text-sm font-medium text-gray-700 mb-2">Select Group</label>
                    <select
                      value={selectedGroupId}
                      onChange={(e) => setSelectedGroupId(e.target.value)}
                      disabled={isGenerating}
                      className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      <option value="">Choose a group...</option>
                      {groups.map((group) => (
                        <option key={group.id} value={group.id}>
                          {group.name} ({group.profileIds.length})
                        </option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Company Name <span className="text-red-500">*</span>
              </label>
              <input
                type="text"
                value={companyName}
                onChange={(e) => setCompanyName(e.target.value)}
                disabled={isGenerating}
                placeholder="Enter company name"
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            {shouldShowRoleInput && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Role <span className="text-red-500">*</span>
                </label>
                <input
                  type="text"
                  value={role}
                  onChange={(e) => setRole(e.target.value)}
                  disabled={isGenerating}
                  placeholder="Enter job role/title"
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            )}

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Job Description <span className="text-red-500">*</span>
              </label>
              <textarea
                value={jobDescription}
                onChange={(e) => setJobDescription(e.target.value)}
                disabled={isGenerating}
                placeholder="Paste the job description (min 50 characters)"
                rows={4}
                className="w-full px-4 py-3 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
              />
              <p className="text-sm text-gray-500 mt-1">{jobDescription.length} characters</p>
            </div>

            <div
              className={`flex items-center justify-between border rounded-lg p-4 transition-colors ${
                autoGenerate ? 'border-blue-200 bg-blue-50' : 'border-red-200 bg-red-50'
              }`}
            >
              <div>
                <div className="text-sm font-semibold text-gray-800">
                  {autoGenerate ? 'Auto-generate (On)' : 'Preview mode (On)'}
                </div>
                <div className="text-xs text-gray-600">
                  {autoGenerate
                    ? 'Analyze + generate in one step.'
                    : 'Analyze + preview first. Generate manually.'}
                </div>
              </div>
              <label className="inline-flex items-center cursor-pointer">
                <input
                  type="checkbox"
                  checked={autoGenerate}
                  onChange={(e) => setAutoGenerate(e.target.checked)}
                  disabled={isGenerating}
                  className="sr-only"
                />
                <span
                  className={`relative w-11 h-6 rounded-full peer-focus:outline-none transition-colors ${
                    autoGenerate ? 'bg-blue-600' : 'bg-red-500'
                  }`}
                >
                  <span
                    className={`absolute top-0.5 left-0.5 h-5 w-5 bg-white rounded-full transition-transform ${
                      autoGenerate ? 'translate-x-5' : ''
                    }`}
                  />
                </span>
              </label>
            </div>
          </div>
        ) : (
          <div className="bg-white rounded-lg border border-gray-200 p-4 space-y-4">
            <div className="flex justify-end">
              <button
                type="button"
                onClick={() => {
                  setBuilderMode(null);
                  setIsSheetsImportOpen(false);
                }}
                disabled={isGenerating}
                className="rounded-md border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-60"
              >
                Back
              </button>
            </div>
            <div className="rounded-lg border border-blue-200 bg-blue-50 px-4 py-3 text-sm text-blue-800">
              Import a Google Sheet range where each row is one job. After column mapping, the builder will generate every selected profile against every imported row.
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-3">
                Build target
              </label>
              <div className="flex flex-wrap gap-4">
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="sheetsTargetMode"
                    value="single"
                    checked={sheetsTargetMode === 'single'}
                    onChange={() => setSheetsTargetMode('single')}
                    disabled={isGenerating}
                    className="w-4 h-4 text-blue-600"
                  />
                  <span>Single profile</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="sheetsTargetMode"
                    value="all"
                    checked={sheetsTargetMode === 'all'}
                    onChange={() => setSheetsTargetMode('all')}
                    disabled={isGenerating}
                    className="w-4 h-4 text-blue-600"
                  />
                  <span>All profiles</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <input
                    type="radio"
                    name="sheetsTargetMode"
                    value="group"
                    checked={sheetsTargetMode === 'group'}
                    onChange={() => setSheetsTargetMode('group')}
                    disabled={isGenerating}
                    className="w-4 h-4 text-blue-600"
                  />
                  <span>Specific group</span>
                </label>
              </div>
            </div>

            {sheetsTargetMode === 'single' && (
              <ProfileSelector
                profiles={profiles}
                selectedId={selectedSheetsProfileId}
                onChange={setSelectedSheetsProfileId}
                isLoading={false}
              />
            )}

            {sheetsTargetMode === 'group' && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">Select Group</label>
                <select
                  value={selectedSheetsGroupId}
                  onChange={(e) => setSelectedSheetsGroupId(e.target.value)}
                  disabled={isGenerating}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">Choose a group...</option>
                  {groups.map((group) => (
                    <option key={group.id} value={group.id}>
                      {group.name} ({group.profileIds.length})
                    </option>
                  ))}
                </select>
              </div>
            )}

            {shouldShowRoleInput && (
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Fallback Role
                </label>
                <input
                  type="text"
                  value={role}
                  onChange={(e) => setRole(e.target.value)}
                  disabled={isGenerating}
                  placeholder="Optional fallback if a sheet row has no mapped job title"
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <p className="mt-1 text-sm text-gray-500">
                  Leave this blank if your imported rows already include a mapped job title column.
                </p>
              </div>
            )}

            {!hasGoogleSheetSources && (
              <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
                Save at least one Google Sheet in the Admin Google Sheets panel before importing jobs here.
              </div>
            )}

            <button
              type="button"
              onClick={() => {
                if (!hasGoogleSheetSources) {
                  setError('Save at least one Google Sheet in the Admin Google Sheets panel before importing.');
                  return;
                }
                setError('');
                setIsSheetsImportOpen(true);
              }}
              disabled={isGenerating}
              className="w-full rounded-lg bg-blue-600 px-4 py-3 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-blue-400"
            >
              {isGenerating ? generationStep || 'Generating...' : 'Import from Google Sheet'}
            </button>
          </div>
        ))}

        {builderMode === 'manual' && generateMode === 'multiple' && autoGenerate && unconfirmedPanel && (
          <div className="mt-6">{unconfirmedPanel}</div>
        )}

        {builderMode === 'manual' && generateMode === 'multiple' && !autoGenerate && multiplePreviews.length > 0 && activeMultiplePreview && (
          <div className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm">
            <div className="absolute inset-4 bg-white rounded-xl shadow-2xl flex flex-col">
              <div className="flex items-center justify-between px-6 py-4 border-b">
                <div className="flex items-center gap-3">
                  <h3 className="text-lg font-semibold text-gray-900">Resume Preview</h3>
                  <span className="px-2 py-1 bg-gray-100 text-gray-700 text-xs rounded-full">
                    {multiplePreviewIndex + 1} / {multiplePreviews.length}
                  </span>
                  {multiplePreviewTailored && (
                    <span className="px-2 py-1 bg-green-100 text-green-700 text-xs rounded-full">
                      ATS OPTIMIZATION
                    </span>
                  )}
                  <span className="text-sm text-gray-600">{activeMultiplePreview.profileName}</span>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => setMultiplePreviewIndex((i) => Math.max(0, i - 1))}
                    disabled={multiplePreviewIndex === 0 || isGenerating}
                    className="px-3 py-2 text-sm bg-gray-100 text-gray-700 rounded-md hover:bg-gray-200 disabled:bg-gray-100 disabled:text-gray-400"
                  >
                    Previous
                  </button>
                  <button
                    type="button"
                    onClick={() => setMultiplePreviewIndex((i) => Math.min(multiplePreviews.length - 1, i + 1))}
                    disabled={multiplePreviewIndex >= multiplePreviews.length - 1 || isGenerating}
                    className="px-3 py-2 text-sm bg-gray-100 text-gray-700 rounded-md hover:bg-gray-200 disabled:bg-gray-100 disabled:text-gray-400"
                  >
                    Next
                  </button>
                  <button
                    onClick={handleFinalizeGenerateMultiple}
                    disabled={isGenerating}
                    className="px-4 py-2 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-blue-400 disabled:cursor-not-allowed font-medium transition-colors"
                  >
                    {isGenerating ? generationStep || 'Generating...' : 'Generate All'}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setMultiplePreviews([]);
                      setMultiplePreviewIndex(0);
                    }}
                    disabled={isGenerating}
                    className="px-3 py-2 text-sm bg-white text-gray-600 border border-gray-200 rounded-md hover:bg-gray-50"
                  >
                    Close
                  </button>
                </div>
              </div>
              <div className="flex-1 grid grid-cols-2 overflow-hidden">
                <div className="h-full overflow-y-auto bg-gray-100 p-6">
                  {isGenerating && generationProgress && (
                    <GenerationProgress progress={generationProgress} className="mb-4" />
                  )}
                  <div className="resume-paper-shell bg-white shadow-lg mx-auto max-w-[816px]">
                    <iframe
                      srcDoc={activeMultiplePreview.html}
                      className="w-full h-[1056px] border-0"
                      title={`Resume Preview - ${activeMultiplePreview.profileName}`}
                    />
                  </div>
                </div>
                <div className="h-full overflow-y-auto border-l p-6 space-y-6">
                  {unconfirmedPanel}

                  <div className="bg-gray-50 rounded-lg border border-gray-200 p-4">
                    <div className="text-sm font-medium text-gray-700 mb-2">Manual Edits (JSON)</div>
                    <textarea
                      value={activeMultiplePreview.draft}
                      onChange={(e) => handleMultipleDraftChange(activeMultiplePreview.profileId, e.target.value)}
                      rows={8}
                      className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
                      placeholder="Edit tailored content JSON here."
                    />
                    {activeMultiplePreview.error && (
                      <p className="text-sm text-red-600 mt-2">{activeMultiplePreview.error}</p>
                    )}
                    <div className="mt-3 flex items-center gap-3">
                      <button
                        type="button"
                        onClick={() => handleUpdateMultiplePreview(activeMultiplePreview.profileId)}
                        disabled={isGenerating || !!activeMultiplePreview.error}
                        className="px-3 py-2 text-sm bg-gray-800 text-white rounded-md hover:bg-gray-900 disabled:bg-gray-400"
                      >
                        Update Preview
                      </button>
                      <span className="text-xs text-gray-500">
                        Apply edits to preview before final generate.
                      </span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {builderMode === 'manual' && generateMode === 'single' && previewHtml && (
          <ResumePreview
            html={previewHtml}
            onGenerate={handleFinalizeGenerate}
            isGenerating={isGenerating}
            isTailored={previewTailored}
            isOpen={isSinglePreviewOpen}
            onClose={() => setIsSinglePreviewOpen(false)}
            generationStep={generationStep}
            sidebar={
              <>
                {unconfirmedPanel}
                <div className="bg-gray-50 rounded-lg border border-gray-200 p-4">
                  <div className="text-sm font-medium text-gray-700 mb-2">Manual Edits (JSON)</div>
                  <textarea
                    value={tailoredContentDraft}
                    onChange={(e) => handleTailoredContentChange(e.target.value)}
                    rows={8}
                    className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-blue-500"
                    placeholder="Edit tailored content JSON here."
                  />
                  {tailoredContentError && (
                    <p className="text-sm text-red-600 mt-2">{tailoredContentError}</p>
                  )}
                  <div className="mt-3 flex items-center gap-3">
                    <button
                      type="button"
                      onClick={handleUpdatePreview}
                      disabled={isGenerating || !!tailoredContentError}
                      className="px-3 py-2 text-sm bg-gray-800 text-white rounded-md hover:bg-gray-900 disabled:bg-gray-400"
                    >
                      Update Preview
                    </button>
                    <span className="text-xs text-gray-500">
                      Apply edits to preview before final generate.
                    </span>
                  </div>
                </div>
              </>
            }
          />
        )}

        {builderMode === 'manual' && generateMode === 'single' && previewHtml && !isSinglePreviewOpen && (
          <div className="mt-4">
            <button
              type="button"
              onClick={() => setIsSinglePreviewOpen(true)}
              className="px-3 py-2 text-sm bg-white text-gray-700 border border-gray-300 rounded-md hover:bg-gray-50"
            >
              Open Preview
            </button>
          </div>
        )}
      </main>

      <SheetsImportModal
        isOpen={isSheetsImportOpen}
        isSubmitting={isGenerating}
        showJobTitleMapping={shouldShowRoleInput}
        sources={modelSettings.googleSheetsSources}
        selectedSourceId={selectedSheetsSourceId}
        selectedProfileName={selectedSheetsProfileName}
        generationProgress={generationProgress}
        onSelectSource={setSelectedSheetsSourceId}
        onClose={() => setIsSheetsImportOpen(false)}
        onConfirm={handleImportJobsFromSheets}
      />

      {/* Footer */}
      <footer className="mt-auto py-6 text-center text-sm text-gray-500">
        <p>Tailored Resume Builder - Powered by OpenAI, Anthropic, OpenRouter, and DeepSeek</p>
      </footer>
    </div>
  );
}
