// Pure domain enums/aliases. No vscode or ADO dependencies.

export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed';

export type ThreadStatus =
  | 'active'
  | 'fixed'
  | 'wontFix'
  | 'closed'
  | 'pending'
  | 'byDesign';

export type FileOrder = 'ado' | 'logical';

export type Side = 'left' | 'right';
