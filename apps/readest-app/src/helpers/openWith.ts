import { hasCli } from '@/services/environment';

declare global {
  interface Window {
    OPEN_WITH_FILES?: string[] | null;
  }
}

interface CliArgument {
  value: string;
  occurrences: number;
}

const parseWindowOpenWithFiles = () => {
  const params = new URLSearchParams(window.location.search);
  const files = params.getAll('file');
  return files.length > 0 ? files : window.OPEN_WITH_FILES;
};

const parseCLIOpenWithFiles = async () => {
  const { getMatches } = await import('@tauri-apps/plugin-cli');
  let matches;
  try {
    matches = await getMatches();
  } catch (err) {
    // getMatches() rejects when argv carries an option the file-only CLI schema
    // does not define. Treat a parse failure as "no CLI files" instead of
    // leaking an unhandled rejection.
    console.warn('Failed to parse CLI open-with args', err);
    return [];
  }
  const args = matches?.args;
  const files: string[] = [];
  if (args) {
    for (const name of ['file1', 'file2', 'file3', 'file4']) {
      const arg = args[name] as CliArgument;
      if (arg && arg.occurrences > 0) {
        files.push(arg.value);
      }
    }
  }

  return files;
};

export const parseOpenWithFiles = async () => {
  let files = parseWindowOpenWithFiles();
  if ((!files || files.length === 0) && hasCli()) {
    files = await parseCLIOpenWithFiles();
  }
  return files;
};
