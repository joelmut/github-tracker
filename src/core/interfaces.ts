export interface Issue {
  type: IssueType;
  state: IssueState;
  number: number;
  title: string;
  repository: string;
  author: User;
  assignees: User[];
  labels: string[];
  url: string;
  fork?: string;
}

export interface User {
  name: string;
  url: string;
}

export interface Repository {
  name: string;
  source: Omit<Repository, "source">;
}

export enum IssueState {
  open = "open",
  closed = "closed",
}

export enum IssueType {
  issue = "issue",
  pull = "pull",
}
