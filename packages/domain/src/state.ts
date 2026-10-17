/** Per-repository state folder. Repositories reviewed before the rename keep `.reviewlab`. */
export const STATE_DIRECTORY = '.hunkyard';
export const LEGACY_STATE_DIRECTORY = '.reviewlab';
export const STATE_DIRECTORIES = [STATE_DIRECTORY, LEGACY_STATE_DIRECTORY] as const;

export const isStatePath = (path: string) =>
  STATE_DIRECTORIES.some((directory) => path === directory || path.startsWith(`${directory}/`));
