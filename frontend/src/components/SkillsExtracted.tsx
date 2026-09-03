'use client';

import { JobAnalysis } from '@/lib/api';

interface SkillsExtractedProps {
  analysis: JobAnalysis;
}

export default function SkillsExtracted({ analysis }: SkillsExtractedProps) {
  const unique = (items: string[]) => Array.from(new Set(items.filter(Boolean)));

  const hardSkills = Array.from(
    new Set([
      ...(analysis.skills.technical ?? []),
      ...(analysis.skills.required ?? []),
      ...(analysis.skills.preferred ?? []),
      ...(analysis.skills.tools ?? []),
      ...(analysis.technologies ?? []),
      ...(analysis.skills.technologies ?? []),
      ...(analysis.protocols ?? []),
      ...(analysis.methodologies ?? []),
      ...(analysis.architecturePatterns ?? []),
    ])
  );
  const keywords = unique([
    ...(analysis.keywords.actionVerbs ?? []),
    ...(analysis.keywords.buzzwords ?? []),
    ...(analysis.keywords.mustInclude ?? []),
  ]);
  const softSkills = unique([
    ...(analysis.softSkills ?? []),
    ...(analysis.skills.soft ?? []),
  ]);
  const industryTerms = unique([
    analysis.jobMeta.industry,
    analysis.jobMeta.department,
    ...(analysis.domainKnowledge ?? []),
  ]);

  return (
    <div className="bg-white rounded-lg border border-gray-200 p-6">
      <div className="flex items-center justify-between mb-4">
        <h3 className="text-lg font-semibold text-black">
          Job Analysis Results
        </h3>
        <span className="px-3 py-1 bg-green-100 text-green-700 text-sm rounded-full">
          ATS Keywords Extracted
        </span>
      </div>

      {/* Job Title & Level */}
      <div className="mb-4 p-3 bg-blue-50 rounded-lg">
        <p className="text-sm text-blue-600 font-medium">
          {analysis.jobMeta.title}
        </p>
        <p className="text-xs text-blue-500">
          Seniority: {analysis.jobMeta.seniority || 'Not specified'}
        </p>
      </div>

      {/* Hard Skills (merge Required + Preferred into one list) */}
      {hardSkills.length > 0 && (
        <div className="mb-4">
          <h4 className="text-sm font-medium text-black mb-2">Hard Skills</h4>
          <div className="flex flex-wrap gap-2">
            {hardSkills.map((skill, idx) => (
              <span
                key={idx}
                className="px-3 py-1 bg-indigo-100 text-indigo-700 text-sm rounded-full"
              >
                {skill}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Keywords */}
      {keywords.length > 0 && (
        <div className="mb-4">
          <h4 className="text-sm font-medium text-black mb-2">
            ATS Keywords
          </h4>
          <div className="flex flex-wrap gap-2">
            {keywords.map((keyword, idx) => (
              <span
                key={idx}
                className="px-3 py-1 bg-purple-100 text-purple-700 text-sm rounded-full"
              >
                {keyword}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Industry Terms */}
      {industryTerms.length > 0 && (
        <div className="mb-4">
          <h4 className="text-sm font-medium text-black mb-2">
            Industry Terms
          </h4>
          <div className="flex flex-wrap gap-2">
            {industryTerms.map((term, idx) => (
              <span
                key={idx}
                className="px-3 py-1 bg-gray-100 text-black text-sm rounded-full"
              >
                {term}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Soft Skills (limit to 5) */}
      {softSkills.length > 0 && (
        <div className="mb-4">
          <h4 className="text-sm font-medium text-black mb-2">Soft Skills</h4>
          <div className="flex flex-wrap gap-2">
            {softSkills.slice(0, 5).map((skill, idx) => (
              <span
                key={idx}
                className="px-3 py-1 bg-green-100 text-green-700 text-sm rounded-full"
              >
                {skill}
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Key Responsibilities */}
      {analysis.responsibilities.length > 0 && (
        <div className="mb-4">
          <h4 className="text-sm font-medium text-black mb-2">
            Key Responsibilities
          </h4>
          <ul className="list-disc list-inside text-sm text-black space-y-1">
            {analysis.responsibilities.slice(0, 5).map((resp, idx) => (
              <li key={idx}>{resp}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
