import { ChangedFile } from '../domain/models';

/**
 * Single cursor over the current review's changed files, so keyboard nav
 * (next/prev file) shares one position regardless of how a file was opened
 * (SPEC §5.7).
 */
export class NavigationCursor {
  private index = -1;
  private files: ChangedFile[] = [];

  setFiles(files: ChangedFile[]): void {
    this.files = files;
    this.index = -1;
  }

  setCurrent(file: ChangedFile): void {
    this.index = this.files.findIndex((f) => f.path === file.path);
  }

  next(): ChangedFile | undefined {
    if (this.files.length === 0) {
      return undefined;
    }
    this.index = (this.index + 1) % this.files.length;
    return this.files[this.index];
  }

  prev(): ChangedFile | undefined {
    if (this.files.length === 0) {
      return undefined;
    }
    this.index = (this.index - 1 + this.files.length) % this.files.length;
    return this.files[this.index];
  }
}
