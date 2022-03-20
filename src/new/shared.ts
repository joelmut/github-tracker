import { EmitterWebhookEvent } from "@octokit/webhooks";
import { IssueType } from "src/core/interfaces";
import { paths } from "@octokit/openapi-types";

export enum Status {
  Idle = "idle",
  Started = "started",
}

export enum Events {
  IssuesCreated = "issues.created",
  IssuesUpdated = "issues.updated",
  IssuesClosed = "issues.closed",
  IssuesPromoted = "issues.promoted",
}

export interface ISubscribeOptions<T extends Events = Events> {
  events: T[];
  listen(event: T, payload: Issue[]): void;
}

export interface ISubscribeResult {
  unsubscribe(): void;
}

export interface User {
  name: string;
  url: string;
}

export interface Repository {
  owner: string;
  name: string;
  fullname: string;
  url: string;
  source?: Repository;
}

export interface Issue {
  id: string;
  type: IssueType;
  state: IssueState;
  number: number;
  title: string;
  author: User;
  assignees: User[];
  labels: string[];
  url: string;
  createdAt: string;
  updatedAt: string;
  repository: Repository;
  promoted?: Pick<Issue, "number" | "url">;
  description: string;
  raw?: any;
}

export enum IssueState {
  Open = "open",
  Closed = "closed",
}

type ResponseItems<Path extends "/search/issues"> =
  paths[Path]["get"]["responses"][200]["content"]["application/json"]["items"] extends Array<
    infer T
  >
    ? T
    : never;

type ResponseItem<Path extends "/repos/{owner}/{repo}"> =
  paths[Path]["get"]["responses"][200]["content"]["application/json"];

interface ResponseIssue extends ResponseItems<"/search/issues"> {}
export interface ResponseRepository
  extends ResponseItem<"/repos/{owner}/{repo}"> {}

export const parse = {
  repository(repository: ResponseRepository): Repository {
    return {
      owner: repository.owner.login,
      name: repository.name,
      fullname: repository.full_name,
      url: repository.html_url,
      source: repository.source
        ? parse.repository(repository.source as ResponseRepository)
        : undefined,
    };
  },
  issue(issue: ResponseIssue, repository: Repository): Issue {
    return {
      id: issue.id.toString(),
      type: issue.pull_request ? IssueType.pull : IssueType.issue,
      state: issue.state!.toLowerCase() as IssueState,
      number: issue.number,
      title: issue.title,
      url: issue.html_url,
      createdAt: issue.created_at,
      updatedAt: issue.updated_at,
      author: { name: issue.user?.login!, url: issue.user?.html_url! },
      assignees:
        issue.assignees?.map((e) => ({
          name: e.login,
          url: e.html_url,
        })) ?? [],
      labels: issue.labels!.map((e) => e.name!),
      repository,
      description: issue.body ?? "",
      raw: issue,
    };
  },
};

export type DeepPartial<T> = {
  [P in keyof T]?: DeepPartial<T[P]>;
};

export function bind<T extends any[], T2 extends keyof T[0]>(
  args: T,
  key: T2
): T[0][T2][] {
  return args.map((e) => {
    const val = e[key];
    if (typeof val === "function") {
      return val.bind(e);
    }
    return val;
  });
}

export interface ISubscription<Result = ISubscribeResult> {
  subscribe<T extends Events>(options: ISubscribeOptions<T>): Result;
  subscribe<T extends Events>(
    events: T[],
    listen: ISubscribeOptions<T>["listen"]
  ): Result;
  subscribe(listen: ISubscribeOptions["listen"]): Result;
}

export function register<T extends ISubscription[]>(
  listeners: T
): ISubscription<ISubscribeResult[]>["subscribe"] {
  return ((...props) =>
    listeners.map((e) => e.subscribe.call(e, ...props))) as any;
}
