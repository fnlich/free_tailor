'use client';

import { useCallback, useEffect, useState } from 'react';

import { ErrorNotice, Section, Status } from '@/components/ui/kit';
import { ApiResponseError } from '@/lib/api';
import { authApi, type AccountOutputPath } from '@/lib/auth';
import { OUTPUT_SUFFIX_TOKEN_CHIPS, suffixSaveValue, suffixSourceLabel } from '@/lib/outputPath';
import { messageWithDetail } from '@/lib/userMessage';
import OutputPathBox from './OutputPathBox';

/** The account's folder path, as GET /auth/account sends it to a builder, or null when it sent none. */
function readOutputPath(account: Partial<AccountOutputPath>): AccountOutputPath | null {
  if (typeof account.effectiveOutputPathSuffix !== 'string') return null;
  return {
    outputPathSuffix: typeof account.outputPathSuffix === 'string' ? account.outputPathSuffix : null,
    outputPathSuffixSource: account.outputPathSuffixSource === 'account' ? 'account' : account.outputPathSuffixSource === 'env' ? 'env' : 'default',
    effectiveOutputPathSuffix: account.effectiveOutputPathSuffix,
    defaultOutputPathSuffix:
      typeof account.defaultOutputPathSuffix === 'string' ? account.defaultOutputPathSuffix : account.effectiveOutputPathSuffix,
  };
}

/**
 * Settings -> Profile -> Resume files (owner decisions O3, O5): where the
 * resumes this account builds are filed - the folder path after the
 * administrator's prefix, which may use {{date}}, {{profile_name}},
 * {{company_name}}, {{role}} and {{row_number}} with text around them.
 *
 * The chips insert a token at the caret, the preview is the server's own
 * rendering with this account's email and a sample run, and every refusal is
 * the server's sentence. Saving changes where the NEXT runs go: a run keeps
 * the folder it was placed in. A builder's only - the page does not draw it
 * for a reporter, whom the routes refuse.
 */
export default function ResumeFilesSection() {
  const [path, setPath] = useState<AccountOutputPath | null>(null);
  /** The account was read - with a folder path, or (an older server) without one. */
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [refusal, setRefusal] = useState('');
  const [note, setNote] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);

  const adopt = useCallback((account: Partial<AccountOutputPath>) => {
    const next = readOutputPath(account);
    setPath(next);
    setDraft(next ? next.outputPathSuffix ?? next.effectiveOutputPathSuffix : '');
    setRefusal('');
  }, []);

  useEffect(() => {
    let alive = true;
    authApi.account().then(
      ({ account }) => {
        if (!alive) return;
        adopt(account);
        setLoaded(true);
        setLoadError(null);
      },
      (error: unknown) => {
        if (alive) setLoadError(error ?? new Error('Could not load where your resumes are saved.'));
      }
    );
    return () => {
      alive = false;
    };
  }, [adopt, attempt]);

  const save = async (value: string | null, said: string) => {
    setSaving(true);
    setNote(null);
    setRefusal('');
    try {
      adopt((await authApi.saveOutputPathSuffix(value)).account);
      setNote({ tone: 'ok', text: said });
    } catch (error) {
      if (error instanceof ApiResponseError && error.body?.field === 'outputPathSuffix') {
        setRefusal(error.message);
      } else {
        setNote({ tone: 'error', text: messageWithDetail(error, 'Could not save the folder path.') });
      }
    } finally {
      setSaving(false);
    }
  };

  const description =
    'Where the resumes you build are saved on the server: the folders the administrator sets for everybody, ' +
    'then this folder path, then the file. Use the tokens below, with any text around them.';

  if (loadError) {
    return (
      <Section title="Resume files" description={description}>
        <ErrorNotice error={loadError} fallback="Could not load where your resumes are saved">
          <button type="button" className="tl-button-quiet mt-4" onClick={() => setAttempt((value) => value + 1)}>
            Try again
          </button>
        </ErrorNotice>
      </Section>
    );
  }
  if (!path) {
    return (
      <Section title="Resume files" description={description}>
        {/* Read, and no folder path in it: a server from before folder paths, which files by its own rule. */}
        <p className="text-sm text-subtle">{loaded ? 'This server does not say where your resumes are saved.' : 'Loading...'}</p>
      </Section>
    );
  }

  const inEffect = path.outputPathSuffix ?? path.effectiveOutputPathSuffix;
  const unchanged = draft.trim() === inEffect || (draft.trim() === '' && path.outputPathSuffixSource !== 'account');

  return (
    <Section title="Resume files" description={description}>
      <OutputPathBox
        id="settings-output-path-suffix"
        label="Folder path"
        value={draft}
        onChange={(next) => {
          setDraft(next);
          setRefusal('');
          setNote(null);
        }}
        chips={OUTPUT_SUFFIX_TOKEN_CHIPS}
        // An empty box is the default, as a save of it would be.
        preview={(text, signal) => authApi.previewOutputPath(suffixSaveValue(text), signal)}
        placeholder={path.defaultOutputPathSuffix}
        disabled={saving}
        refusal={refusal}
        hint="The preview uses your email, a sample order and today's date, your first profile and a made-up job. A run keeps the folder it was placed in: a change reaches only the runs you place after it."
        source={
          <p className="mt-2 text-xs text-subtle" data-suffix-source>
            <span className="font-medium text-muted">{suffixSourceLabel(path.outputPathSuffixSource)}</span>
            {path.outputPathSuffixSource === 'account' && (
              <>
                {' '}
                &middot; the default is <code className="font-mono">{path.defaultOutputPathSuffix}</code>
              </>
            )}
          </p>
        }
      />
      <div>
        <div className="flex flex-wrap items-center gap-3">
          <button
            type="button"
            className="tl-button"
            disabled={saving || unchanged}
            onClick={() => void save(suffixSaveValue(draft), 'Saved. Your next runs are filed there.')}
          >
            {saving ? 'Saving...' : 'Save'}
          </button>
          {path.outputPathSuffixSource === 'account' && (
            <button
              type="button"
              className="tl-button-quiet"
              disabled={saving}
              onClick={() => void save(null, 'Reset. Your next runs are filed under the default folder path.')}
            >
              Reset to default
            </button>
          )}
        </div>
        {note && <Status tone={note.tone}>{note.text}</Status>}
      </div>
    </Section>
  );
}
