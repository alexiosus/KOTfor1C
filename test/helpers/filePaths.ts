import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const localFileUri = (file: string): string => pathToFileURL(path.resolve(file)).href;

// Virtual fixtures use one slash-based namespace on every host filesystem.
export const virtualFilePath = (file: string): string => path.posix.normalize(file.replace(/\\/gu, '/').replace(/^\/?[a-z]:/iu, ''));
