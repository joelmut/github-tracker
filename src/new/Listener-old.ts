import { IPayloadData, ISubscriber, Subscriber } from "./Subscriber";
import { request } from "@octokit/request";
import { EmitterWebhookEventName } from "@octokit/webhooks";
import Scheduler from "croner";
import { WebhookProvider } from "./WebhookProvider";
import { equals, not, compose } from "ramda";
import { EmitterWebhookEvent } from "@octokit/webhooks/dist-types/types";
import { default as ev } from "extract-values";

export const ListenerEvents = {
  IssuesCreated: "issues.created",
  IssuesUpdated: "issues.updated",
  IssuesClosed: "issues.closed",
  IssuesPromoted: "issues.promoted",
  PullCreated: "pull.created",
  PullUpdated: "pull.updated",
} as const;

type ValueOf<T> = T[keyof T];
export type TListenerEvents = ValueOf<typeof ListenerEvents>;

export enum FetchPolicy {
  Schedule = "schedule",
  Realtime = "realtime",
}

interface IRepositoryOptions {
  name: string;
  fetchPolicy: FetchPolicy;
}

interface IListenerOptions {
  endpoint: string;
  scheduler: Scheduler;
  repos: IRepositoryOptions[];
  users: string[];
}

type Issues = EmitterWebhookEvent<"issues">["payload"]["issue"] & {
  repository: EmitterWebhookEvent<"issues">["payload"]["repository"];
  source: {
    name: string;
    issue: {
      number: number;
      html_url: string;
    };
  };
};
type Pull = EmitterWebhookEvent<"pull_request">["payload"]["pull_request"];

export interface Maps {
  "issues.created": Issues;
  "issues.updated": Issues;
  "issues.closed": Issues;
  "issues.promoted": Issues;
  "pull.created": Pull;
  "pull.updated": Pull;
}

interface ISubscribe {
  unsubscribe(): void;
}

enum Status {
  Idle = "idle",
  Started = "started",
}

export class Listener {
  private webhook: WebhookProvider;
  private request: typeof request;
  private status: Status;
  private subscriptions = new Set<
    | Subscriber<TListenerEvents, Maps, "Array">
    | ((data: IPayloadData<TListenerEvents, Maps, "Array">) => void)
  >();

  constructor(private options: IListenerOptions) {
    if (!options.repos?.length) {
      throw new Error(
        "[Listener] options.repos is empty, at least a value must be provided."
      );
    }

    this.status = Status.Idle;
    this.webhook = new WebhookProvider({ secret: "test" });
    this.request = request.defaults({
      headers: {
        authorization: `token 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`,
      },
    });
  }

  async subscribe(callback: ISubscriber): Promise<ISubscribe>;
  async subscribe(
    callback: (data: IPayloadData<TListenerEvents, Maps, "Array">) => void
  ): Promise<ISubscribe>;
  async subscribe(
    callback: ISubscriber &
      ((data: IPayloadData<TListenerEvents, Maps, "Array">) => void)
  ): Promise<ISubscribe> {
    this.subscriptions.add(callback);
    if (this.status === Status.Idle) {
      await this.start();
    }

    return {
      unsubscribe: () => this.subscriptions.delete(callback),
    };
  }

  async unsubscribe() {
    this.subscriptions.clear();
    this.status = Status.Idle;
    await this.webhook.removeAll();
    await this.webhook.close();
    this.options.scheduler.stop();
  }

  private async start() {
    this.status = Status.Started;

    let repos = this.options.repos.filter(
      (e) => e.fetchPolicy === FetchPolicy.Realtime
    );
    if (repos.length) {
      await this.webhook.listen(this.options.endpoint);

      this.register(ListenerEvents.IssuesCreated, ["issues.opened"]);
      this.register(ListenerEvents.IssuesUpdated, [
        "issues.closed",
        "issues.reopened",
        "issues.labeled",
        "issues.unlabeled",
        "issues.assigned",
        "issues.unassigned",
        "issues.edited",
      ]);
      this.register(ListenerEvents.PullCreated, ["pull_request.opened"]);
      this.register(ListenerEvents.PullUpdated, [
        "pull_request.closed",
        "pull_request.reopened",
        "pull_request.labeled",
        "pull_request.unlabeled",
        "pull_request.assigned",
        "pull_request.unassigned",
        "pull_request.edited",
      ]);
      this.webhook.on("issue_comment.created", (data) => {
        if (!(isForked(data) && isPromoted(data))) {
          return;
        }

        const { issue, comment, repository } = data.payload;

        const promoted = getPromotedIssueNumber(comment.body);

        const { owner, repo } = ev(
          repository.forks_url,
          "{protocol}://{domain}/{owner}/{repo}"
        );

        const result = {
          ...issue,
          repository,
          source: {
            name: `${owner}/${repo}`,
            issue: {
              number: promoted,
              html_url: issue.html_url
                .replace(repository.html_url, repository.forks_url)
                .replace(issue.number.toString(), promoted.toString()),
            },
          },
        };

        this.process(FetchPolicy.Realtime, ListenerEvents.IssuesPromoted, [
          result,
        ]);
      });
    }

    repos = this.options.repos.filter(
      (e) => e.fetchPolicy === FetchPolicy.Schedule
    );
    if (repos.length) {
      const baseQuery = [
        ...repos.map((repo) => `repo:${repo.name}`),
        ...this.options.users.map((user) => `involves:${user}`),
      ];

      const state = new Map();

      this.options.scheduler.schedule(async () => {
        const prev = this.options.scheduler.previous() ?? new Date();
        const date = prev.toISOString();

        const queries = [
          {
            event: ListenerEvents.IssuesCreated,
            query: `is:open is:issue created:>=${date}`,
          },
          {
            event: ListenerEvents.IssuesUpdated,
            query: `is:open is:issue updated:>=${date}`,
          },
          {
            event: ListenerEvents.PullCreated,
            query: `is:open is:pr created:>=${date}`,
          },
          {
            event: ListenerEvents.PullUpdated,
            query: `is:open is:pr updated:>=${date}`,
          },
          {
            event: ListenerEvents.IssuesClosed,
            query: `is:closed is:issue closed:>=${date} NOT in:comments /promoted`,
          },
          {
            event: ListenerEvents.IssuesPromoted,
            query: `is:closed is:issue closed:>=${date} in:comments /promoted`,
          },
        ];

        const refinePayload = (
          state: Map<TListenerEvents, any[]>,
          event: TListenerEvents,
          payload: any[]
        ) => {
          const statePayload = state.get(event);
          if (!statePayload?.length) {
            state.set(event, payload);
            return payload;
          }

          const equal = (e) => statePayload.some(equals(e));
          const result = payload.filter(equal);
          state.set(event, result);
          return payload.filter(compose(not, equal));
        };

        const promises = queries.map(async ({ event, query }) => {
          const q = [...baseQuery, query].join(" ");
          let payload = await this.search(q);
          payload = refinePayload(state, event, payload);

          this.process(FetchPolicy.Schedule, event, payload);
        });

        await Promise.all(promises);
      });
    }
  }

  private register(
    event: TListenerEvents,
    listeners: EmitterWebhookEventName[]
  ): void {
    this.webhook.on(listeners, (data: any) => {
      const result = {
        issues: data.payload.issue,
        pull_request: data.payload.pull_request,
      }[data.name];
      this.process(FetchPolicy.Realtime, event, [result]);
    });
  }

  private process<E extends TListenerEvents = TListenerEvents>(
    fetchPolicy: FetchPolicy,
    event: TListenerEvents,
    payload: IPayloadData<E, Maps, "Array">["payload"]
  ): void {
    if (!payload.length) {
      return;
    }

    let filtered = this.filterByListener(payload);
    filtered = this.filterByRepos(fetchPolicy, payload);

    if (filtered.length) {
      this.notify(event, filtered);
    }
  }

  private notify<E extends TListenerEvents = TListenerEvents>(
    event: TListenerEvents,
    payload: IPayloadData<E, Maps, "Array">["payload"]
  ): void {
    this.subscriptions.forEach((cb) => {
      if (cb instanceof Subscriber) {
        cb.notify([event], { event, payload });
      } else if (typeof cb === "function") {
        cb({ event, payload });
      }
    });
  }

  private async search(query: string): Promise<any[]> {
    const fetch = async (page = 1) => {
      const {
        data: { items, incomplete_results },
      } = await this.request("GET /search/issues", {
        q: query,
        page,
        per_page: 100,
      });

      if (incomplete_results) {
        return [...items, ...(await fetch(page + 1))];
      }

      return items || [];
    };

    return fetch();
  }

  private filterByListener(
    payload: IPayloadData<TListenerEvents, Maps, "Array">["payload"]
  ) {
    return payload.filter((item) => {
      const assignees = item.assignees.map(({ login }) => login);
      const author = item.user.login;

      return this.options.users.some(
        (user) => assignees.includes(user) || author === user
      );
    });
  }

  private filterByRepos(
    fetchPolicy: FetchPolicy,
    payload: IPayloadData<TListenerEvents, Maps, "Array">["payload"]
  ) {
    return payload.filter((item) => {
      const { owner, repo } = ev(
        item.html_url,
        "{protocol}://{domain}/{owner}/{repo}/{type}/{number}"
      );

      return this.options.repos.some(
        (e) => e.fetchPolicy === fetchPolicy && e.name === `${owner}/${repo}`
      );
    });
  }
}

function isPromoted({ payload: { comment } }) {
  return getPromotedIssueNumber(comment.body) > 0 ?? false;
}

function isForked({ payload: { repository } }) {
  return repository.fork;
}

function getPromotedIssueNumber(text: string) {
  // TODO: Make the promoted command customizable in the appsettings.json
  const result = text.trim().substr("/promoted".length).trim().split(" ")?.[0];

  if (Number.isNaN(result)) return;

  return Number(result);
}
