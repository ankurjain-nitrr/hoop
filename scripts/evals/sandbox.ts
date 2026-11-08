// The repository every eval trial starts in: its files and its first commit. A scenario's setup hash
// (`setupHash` in scenarios.ts) includes it, since a trial's behaviour depends on what it finds.

/** The trial repository's files, by path, before its first commit. */
export const SANDBOX_FILES: Record<string, string> = { "README.md": "# Orders\n\nA small web app that takes and ships orders.\n" };
/** The message of the trial repository's first commit. */
export const SANDBOX_COMMIT = "Start";
