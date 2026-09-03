import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);
const DIALOG_TIMEOUT_MS = 5 * 60 * 1000;

type NativeDialogResult = {
  selectedPath: string | null;
};

type DialogCommand = {
  command: string;
  args: string[];
};

type ExecError = Error & {
  code?: number | string;
  stderr?: string;
  stdout?: string;
};

function normalizeDialogOutput(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return path.resolve(trimmed);
}

function isDialogCancelError(error: unknown, command: string): boolean {
  if (!(error instanceof Error)) return false;
  const message = error.message.toLowerCase();
  if (message.includes('cancel') || message.includes('canceled') || message.includes('cancelled')) {
    return true;
  }

  const execError = error as ExecError;
  const code = execError.code;

  // GUI pickers commonly use exit code 1 for user cancel/close instead of
  // writing an explicit "cancelled" message to stderr.
  if (code === 1 || code === '1') {
    return ['zenity', 'qarma', 'yad', 'kdialog', 'osascript'].includes(command);
  }

  // YAD can return 252 when the dialog is closed via ESC/window close.
  if (code === 252 || code === '252') {
    return command === 'yad';
  }

  return false;
}

function isCommandMissingError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function shouldStripDialogEnvVar(key: string): boolean {
  return (
    key.startsWith('SNAP') ||
    key.startsWith('GTK_') ||
    key.startsWith('GIO_') ||
    key === 'LD_LIBRARY_PATH' ||
    key === 'PYTHONHOME' ||
    key === 'PYTHONPATH'
  );
}

function buildDialogEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined || shouldStripDialogEnvVar(key)) {
      continue;
    }
    env[key] = value;
  }

  return env;
}

async function ensureStartingDirectory(candidate?: string): Promise<string> {
  const fallback = os.homedir();
  if (!candidate?.trim()) return fallback;

  const resolved = path.resolve(candidate.trim());
  try {
    const stats = await fs.stat(resolved);
    return stats.isDirectory() ? resolved : fallback;
  } catch {
    return fallback;
  }
}

async function runDialogCommand(command: string, args: string[]): Promise<string | null> {
  const { stdout } = await execFileAsync(command, args, {
    timeout: DIALOG_TIMEOUT_MS,
    windowsHide: false,
    env: buildDialogEnvironment(),
  });
  return normalizeDialogOutput(stdout);
}

function buildMacCommand(startDir: string, title: string): DialogCommand {
  return {
    command: 'osascript',
    args: [
      '-e',
      `set selectedFolder to choose folder with prompt "${title.replace(/"/g, '\\"')}" default location POSIX file "${startDir.replace(/"/g, '\\"')}"`,
      '-e',
      'POSIX path of selectedFolder',
    ],
  };
}

function buildLinuxCommands(startDir: string, title: string): DialogCommand[] {
  const normalizedStartDir = startDir.endsWith(path.sep) ? startDir : `${startDir}${path.sep}`;
  return [
    {
      command: 'zenity',
      args: ['--file-selection', '--directory', '--title', title, '--filename', normalizedStartDir],
    },
    {
      command: 'qarma',
      args: ['--file-selection', '--directory', '--title', title, '--filename', normalizedStartDir],
    },
    {
      command: 'yad',
      args: ['--file-selection', '--directory', '--title', title, '--filename', normalizedStartDir],
    },
    {
      command: 'kdialog',
      args: ['--getexistingdirectory', startDir, '--title', title],
    },
  ];
}

function buildWindowsCommands(startDir: string, title: string): DialogCommand[] {
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
    `$dialog.Description = '${title.replace(/'/g, "''")}'`,
    '$dialog.UseDescriptionForTitle = $true',
    `$dialog.SelectedPath = '${startDir.replace(/'/g, "''")}'`,
    'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {',
    '  [Console]::Out.WriteLine($dialog.SelectedPath)',
    '}',
  ].join('; ');

  return [
    {
      command: 'powershell',
      args: ['-NoProfile', '-STA', '-Command', script],
    },
    {
      command: 'pwsh',
      args: ['-NoProfile', '-STA', '-Command', script],
    },
  ];
}

async function pickWithCommands(commands: DialogCommand[]): Promise<string | null> {
  let sawMissingCommand = false;
  const failures: string[] = [];

  for (const entry of commands) {
    try {
      return await runDialogCommand(entry.command, entry.args);
    } catch (error) {
      if (isDialogCancelError(error, entry.command)) {
        return null;
      }
      if (isCommandMissingError(error)) {
        sawMissingCommand = true;
        continue;
      }

      const execError = error as ExecError;
      const stderr = execError.stderr?.trim();
      failures.push(stderr ? `${entry.command}: ${stderr}` : `${entry.command}: failed to open dialog`);
      continue;
    }
  }

  if (failures.length > 0) {
    throw new Error(failures[0]);
  }

  if (sawMissingCommand) {
    throw new Error('No supported native folder picker is available on the backend machine');
  }

  throw new Error('Failed to open native folder picker');
}

export async function openNativeDirectoryPicker(currentPath?: string): Promise<NativeDialogResult> {
  const startDir = await ensureStartingDirectory(currentPath);
  const title = 'Select output directory';

  if (process.platform === 'darwin') {
    return { selectedPath: await pickWithCommands([buildMacCommand(startDir, title)]) };
  }

  if (process.platform === 'win32') {
    return { selectedPath: await pickWithCommands(buildWindowsCommands(startDir, title)) };
  }

  return { selectedPath: await pickWithCommands(buildLinuxCommands(startDir, title)) };
}
