import Cron from "croner";
import * as yup from "yup";
import { RequestInterface } from "@octokit/types";
import { request } from "@octokit/request";
import { equals, not, compose, is } from "ramda";
import ms from "ms";
import { paths } from "@octokit/openapi-types";
import { IssueType } from "src/core/interfaces";
import { EventEmitter } from "events";
import {
  Events,
  Issue,
  IssueState,
  ISubscribeOptions,
  ISubscribeResult,
  ISubscription,
  parse,
  Repository,
  Status,
} from "./shared";

const optionsSchema = yup.object({
  schedule: yup.string().required(),
  token: yup.string().required(),
  startAt: yup.date().optional().default(new Date()),
  repos: yup
    .array(yup.string().required())
    .required()
    .transform((val) => [...new Set(val)]),
  users: yup
    .array(yup.string().required())
    .required()
    .transform((val) => [...new Set(val)]),
  keys: yup
    .object({
      promoted: yup.string().optional().default("/promoted"),
    })
    .optional(),
});

type PartialOptional<T, K extends keyof T> = Omit<T, K> & DeepPartial<T>;

type DeepPartial<T> = T extends object
  ? { [P in keyof T]?: DeepPartial<T[P]> }
  : T;

interface ISearcherOptions extends yup.InferType<typeof optionsSchema> {}

interface Query {
  event: Events;
  query: string;
  headers?: {
    accept?:
      | "application/vnd.github.v3.json"
      | "application/vnd.github.v3.text-match+json";
  };
}

export class Searcher implements ISubscription {
  private options: ISearcherOptions;
  private status: Status;
  private scheduler: Cron;
  private octokit: RequestInterface;
  private subscriptions = new EventEmitter();
  private state = new Map();
  private repos = new Map<string, Repository>();

  constructor(options: PartialOptional<ISearcherOptions, "keys" | "startAt">) {
    this.options = optionsSchema.validateSync(options);

    this.status = Status.Idle;
    this.scheduler = new Cron(this.options.schedule, {
      startAt: this.options.startAt,
    });
    this.octokit = request.defaults({
      headers: {
        authorization: `token ${this.options.token}`,
      },
    });
  }

  subscribe<T extends Events>(options: ISubscribeOptions<T>): ISubscribeResult;
  subscribe<T extends Events>(
    events: T[],
    listen: ISubscribeOptions<T>["listen"]
  ): ISubscribeResult;
  subscribe(listen: ISubscribeOptions["listen"]): ISubscribeResult;
  subscribe<T extends Events>(
    events: T[] & ISubscribeOptions & ISubscribeOptions["listen"],
    listen?: ISubscribeOptions<T>["listen"]
  ): ISubscribeResult {
    let schema = yup.object({
      events: yup.array(yup.string().required()).required(),
      listen: yup
        .mixed()
        .transform((e) => (is(Function, e) ? e : null))
        .required(),
    });

    if (yup.reach(schema, "listen").isValidSync(events)) {
      schema = schema.transform(() => ({ events: ["*"], listen: events }));
    } else if (yup.reach(schema, "events").isValidSync(events)) {
      schema = schema.transform(() => ({ events, listen }));
    }

    const options = schema.validateSync(events);
    options.events.forEach((e) => this.subscriptions.on(e, options.listen));

    if (this.status === Status.Idle) {
      this.scheduler.schedule(this.onSchedule.bind(this));
      this.status = Status.Started;
    }

    return {
      unsubscribe: () =>
        options.events.forEach((e) => this.subscriptions.off(e, Function)),
    };
  }

  private async onSchedule() {
    const date = this.scheduler.previous() ?? this.options.startAt;

    if (!this.repos.size) {
      const repos = await this.repositories();
      repos.map((e) => {
        const repo = parse.repository(e);
        this.repos.set(repo.fullname, repo);
      });
    }

    this.queries(date).forEach(async (query) => {
      const response = await this.search(query);
      let issues = response.map((issue) => {
        const name = issue.repository_url.replace(
          "https://api.github.com/repos/",
          ""
        );
        const repo = this.repos.get(name)!;
        return parse.issue(issue, repo);
      });
      const categorized = await this.processEvent(query.event, issues);
      categorized.forEach(([event, issues]) => {
        const processed = this.processState(event, issues);
        this.notify(event, processed);
      });
    });
  }

  private queries(date: Date): Query[] {
    const d = new Date(date);
    d.setSeconds(d.getSeconds() - 10);
    const iso = d.toISOString();

    const q = (query: string) =>
      [
        ...this.options.repos.map((repo) => `repo:${repo}`),
        ...this.options.users.map((user) => `involves:${user}`),
        query,
      ].join(" ");

    const { promoted } = this.options.keys;

    return [
      {
        event: Events.IssuesUpdated,
        query: q(`updated:>=${iso} NOT in:comments ${promoted}`),
      },
      {
        event: Events.IssuesPromoted,
        query: q(`updated:>=${iso} in:comments ${promoted}`),
        headers: { accept: "application/vnd.github.v3.text-match+json" },
      },
    ];
  }

  private async processEvent(
    event: Events,
    payload: Issue[]
  ): Promise<[Events, Issue[]][]> {
    const { promoted } = this.options.keys;

    switch (event) {
      case Events.IssuesUpdated:
        const created = payload.filter(
          (e) => e.state === IssueState.Open && e.createdAt === e.updatedAt
        );
        const updated = payload.filter(
          (e) => e.state === IssueState.Open && e.createdAt < e.updatedAt
        );
        const closed = payload.filter((e) => e.state === IssueState.Closed);

        return [
          [Events.IssuesCreated, created],
          [Events.IssuesUpdated, updated],
          [Events.IssuesClosed, closed],
        ];

      case Events.IssuesPromoted:
        const result = payload.map(async (e) => {
          if (!e.raw.text_matches?.length) return e;

          const [comment] = e.raw.text_matches
            .filter((e) => e.object_type === "IssueComment")
            .map((e) => e.fragment);

          if (!comment?.trim().length) return e;

          const index = comment.indexOf(promoted) + promoted.length;
          const [number] = comment.substring(index).trim().split(/\s+/);

          if (Number.isNaN(number)) return e;
          if (!e.repository.source) return e;

          return {
            ...e,
            promoted: {
              number: Number(number),
              url: `${e.repository.source?.url}/issues/${number}`,
            },
          };
        });

        const data = await Promise.all(result);
        return [[event, data]];
    }

    return [[event, payload]];
  }

  private processState(event: Events, payload: Issue[]): Issue[] {
    const autodestroy = (after: number) =>
      setTimeout(() => this.state.delete(event), after);

    const statePayload = this.state.get(event);
    if (!statePayload?.length) {
      this.state.set(event, payload);
      autodestroy(ms("3m"));
      return payload;
    }

    const equal = (e) => statePayload.some(equals(e));
    const result = payload.filter(equal);
    this.state.set(event, result);
    return payload.filter(compose(not, equal));
  }

  private notify(event: Events, payload: Issue[]): void {
    if (!payload.length) return;
    const result = payload.map(({ raw, ...e }) => e);
    this.subscriptions.emit(event, event, result);
  }

  private async search(query: Query): Promise<ResponseIssue[]> {
    const fetch = async (page = 1) => {
      const {
        data: { items, incomplete_results },
      } = await this.octokit("GET /search/issues", {
        q: query.query,
        page,
        per_page: 100,
        headers: query.headers,
        sort: "updated",
        order: "desc",
      });

      if (incomplete_results) {
        return [...items, ...(await fetch(page + 1))];
      }

      return items;
    };

    return fetch();
  }

  private async repositories(): Promise<ResponseRepository[]> {
    const result = this.options.repos.map(async (e) => {
      const [owner, repo] = e.split("/");
      const { data } = await this.octokit("GET /repos/{owner}/{repo}", {
        owner,
        repo,
      });

      return data;
    });

    return Promise.all(result);
  }
}

// const parse = {
//   repository(repository: ResponseRepository): Repository {
//     return {
//       owner: repository.owner.login,
//       name: repository.name,
//       fullname: repository.full_name,
//       url: repository.html_url,
//       source: repository.source
//         ? parse.repository(repository.source as ResponseRepository)
//         : undefined,
//     };
//   },
//   issue(issue: ResponseIssue, repository: Repository): Issue {
//     return {
//       id: issue.id.toString(),
//       type: issue.pull_request ? IssueType.pull : IssueType.issue,
//       state: issue.state.toLowerCase() as IssueState,
//       number: issue.number,
//       title: issue.title,
//       url: issue.html_url,
//       createdAt: issue.created_at,
//       updatedAt: issue.updated_at,
//       author: { name: issue.user?.login!, url: issue.user?.html_url! },
//       assignees:
//         issue.assignees?.map((e) => ({
//           name: e.login,
//           url: e.html_url,
//         })) ?? [],
//       labels: issue.labels.map((e) => e.name!),
//       repository,
//       raw: issue,
//     };
//   },
// };

type ResponseItems<Path extends "/search/issues"> =
  paths[Path]["get"]["responses"][200]["content"]["application/json"]["items"] extends Array<
    infer T
  >
    ? T
    : never;

type ResponseItem<Path extends "/repos/{owner}/{repo}"> =
  paths[Path]["get"]["responses"][200]["content"]["application/json"];

interface ResponseIssue extends ResponseItems<"/search/issues"> {}
interface ResponseRepository extends ResponseItem<"/repos/{owner}/{repo}"> {}
