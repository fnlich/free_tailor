import { Pill } from '@/components/ui/kit';
import { analysisFacts, type AnalysisFactsSource } from '@/lib/jobAnalysis';

/**
 * What the posting's analysis says about it, in one line: the job field it was
 * classified into, its job type, seniority and clearance, and the salary it
 * states - each only when there is one. The field, the job type, the
 * clearance and the salary are what the account's job sheet carries in its
 * Job Field, Job Type, Clearance and Salary columns; the seniority is what
 * the Job Filter judges. `withTitle` adds the job title the analysis read,
 * for a place that does not already show it.
 *
 * Nothing when the analysis has none of them, so a caller can drop it in anywhere.
 */
export default function AnalysisFacts({
  analysis,
  withTitle = false,
  className = '',
}: {
  analysis: AnalysisFactsSource | null | undefined;
  withTitle?: boolean;
  className?: string;
}) {
  const facts = analysisFacts(analysis);
  const title = withTitle ? facts.title : '';
  const details = [
    { label: 'Job type', value: facts.jobType },
    { label: 'Seniority', value: facts.seniority },
    { label: 'Clearance', value: facts.clearance },
  ].filter((detail) => detail.value);
  if (!title && !facts.jobField && !facts.salary && details.length === 0) return null;
  return (
    <span className={`inline-flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted ${className}`}>
      {title && <span className="font-medium text-ink">{title}</span>}
      {facts.jobField && (
        <span title="Job field">
          <span className="sr-only">Job field: </span>
          <Pill tone="sky">{facts.jobField}</Pill>
        </span>
      )}
      {details.map((detail) => (
        <span key={detail.label} title={detail.label}>
          <span className="sr-only">{detail.label}: </span>
          {detail.value}
        </span>
      ))}
      {facts.salary && (
        <span className="break-words">
          <span className="text-subtle">Salary </span>
          {facts.salary}
        </span>
      )}
    </span>
  );
}
