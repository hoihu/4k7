/**
 * The project a file the user picked becomes: its id is the file's name without .twd.json (or .json),
 * the way the server names the files in the projects folder. (tools/server/src/storage.ts).
 */
export function projectIdOf(fileName: string): string {
  return fileName.replace(/\.twd\.json$|\.json$/i, '');
}
