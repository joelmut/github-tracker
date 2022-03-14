import {
  EmitterWebhookEvent,
  EmitterWebhookEventName,
} from "@octokit/webhooks";
import { IssueType } from "src/core/interfaces";
import { object, array, string, InferType, reach, mixed } from "yup";
import { WebhookProvider } from "./WebhookProvider";
import { is, mergeDeepRight, includes } from "ramda";
import EventEmitter from "events";
import type Types from "@octokit/webhooks-types";
import { request } from "@octokit/request";
import { RequestInterface } from "@octokit/auth-app/dist-types/types";
import { paths } from "@octokit/openapi-types";
import {
  Events,
  Issue,
  IssueState,
  ISubscribeOptions,
  ISubscribeResult,
  ISubscription,
  parse,
  Repository,
  ResponseRepository,
  Status,
} from "./shared";

const optionsSchema = object({
  token: string().required(),
  repos: array(string().required())
    .required()
    .transform((val) => [...new Set(val)]),
  users: array(string().required())
    .required()
    .transform((val) => [...new Set(val)]),
  keys: object({
    promoted: string().optional().default("/promoted"),
  }).optional(),
});

interface IListenerOptions extends InferType<typeof optionsSchema> {}

interface Event {
  event: Events;
  emitters: EmitterWebhookEventName[];
}

interface Payload {
  issue: Types.Issue;
  pull_request: Types.PullRequest;
  comment: Types.IssueComment;
  repository: Types.Repository;
  events: Events[];
}

type PartialOptional<T, K extends keyof T> = Omit<T, K> & DeepPartial<T>;

type DeepPartial<T> = T extends object
  ? { [P in keyof T]?: DeepPartial<T[P]> }
  : T;

export class Listener implements ISubscription {
  private options: IListenerOptions;
  private status: Status;
  private provider: WebhookProvider;
  private octokit: RequestInterface;
  private subscriptions = new EventEmitter();
  private repos = new Map<number, Repository>();

  constructor(options: PartialOptional<IListenerOptions, "keys">) {
    this.options = optionsSchema.validateSync(options);

    this.status = Status.Idle;
    this.provider = new WebhookProvider({ secret: this.options.token });
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
    let schema = object({
      events: array(string().required()).required(),
      listen: mixed()
        .transform((e) => (is(Function, e) ? e : null))
        .required(),
    });

    if (reach(schema, "listen").isValidSync(events)) {
      schema = schema.transform(() => ({ events: ["*"], listen: events }));
    } else if (reach(schema, "events").isValidSync(events)) {
      schema = schema.transform(() => ({ events, listen }));
    }

    const options = schema.validateSync(events);
    options.events.forEach((e) => this.subscriptions.on(e, options.listen));

    if (this.status === Status.Idle) {
      this.onStart();
      this.status = Status.Started;
    }

    return {
      unsubscribe: () =>
        options.events.forEach((e) => this.subscriptions.off(e, Function)),
    };
  }

  private async onStart() {
    await this.provider.listen("3000");

    if (!this.repos.size) {
      const repos = await this.repositories();
      repos.map((e) => {
        const repo = parse.repository(e);
        this.repos.set(e.id, repo);
      });
    }

    const processIssue = this.debounce((payload: Payload) => {
      const data = {
        ...(payload.issue ?? payload.pull_request),
        comment: payload.comment,
      };
      const repo = this.repos.get(payload.repository.id)!;
      const issue = parse.issue(data as any, repo);
      const [event, categorized] = this.processEvent(payload.events, issue);
      this.notify(event, categorized);
    });

    const state = new Map<number, Payload>();
    this.events().forEach(({ event, emitters }) => {
      this.provider.on(emitters, (data: any) => {
        const issue = data.payload.issue ?? data.payload.pull_request;
        const status = state.get(issue.id) ?? { events: [] };
        const payload: Payload = {
          ...mergeDeepRight(status, data.payload),
          events: [...status.events, event],
        };

        const isValid = this.validations(payload);
        if (!isValid) return;

        state.set(issue.id, payload);
        processIssue(issue.id, payload, () => state.delete(issue.id));
      });
    });
  }

  private validations(payload: Payload) {
    const issue = payload.issue ?? payload.pull_request;
    const repo = this.repos.get(payload?.repository?.id);
    const assignees = issue.assignees.map(({ login }) => login);
    const author = issue.user.login;
    const isListener = this.options.users.some(
      (user) => assignees.includes(user) || author === user
    );

    return repo && isListener;
  }

  private processEvent(events: Events[], payload: Issue): [Events, Issue?] {
    const { promoted } = this.options.keys;
    const all = (...arr) => arr.every((e) => events.includes(e));

    if (all(Events.IssuesPromoted, Events.IssuesClosed)) {
      const comment = payload.raw.comment.body;

      if (!comment?.trim().length) return [Events.IssuesPromoted];

      const index = comment.indexOf(promoted) + promoted.length;
      const [number] = comment.substring(index).trim().split(/\s+/);

      if (Number.isNaN(number) || !payload.repository.source)
        return [Events.IssuesPromoted];

      const issue: Issue = {
        ...payload,
        promoted: {
          number: Number(number),
          url: `${payload.repository.source?.url}/issues/${number}`,
        },
      };
      return [Events.IssuesPromoted, issue];
    } else if (all(Events.IssuesCreated, Events.IssuesUpdated)) {
      return [Events.IssuesCreated, payload];
    }

    return [[...events].pop()!, payload];
  }

  private debounce<T>(callback: (payload: T) => void, timeout = 1000) {
    const timers = new Map<string, NodeJS.Timeout>();
    const clear = (id) => clearTimeout(timers.get(id)!);
    return <I extends string, T>(id: I, props: T, done?: () => void) => {
      clear(id);
      const timer = setTimeout(() => {
        callback.call(this, props);
        clear(id);
        done?.();
      }, timeout);
      timers.set(id, timer);
    };
  }

  private notify(event: Events, payload?: Issue): void {
    if (!payload) return;
    const { raw, ...result } = payload;
    this.subscriptions.emit(event, event, [result]);
  }

  private events(): Event[] {
    return [
      {
        event: Events.IssuesCreated,
        emitters: ["issues.opened", "pull_request.opened"],
      },
      {
        event: Events.IssuesUpdated,
        emitters: [
          "issues.reopened",
          "issues.labeled",
          "issues.unlabeled",
          "issues.assigned",
          "issues.unassigned",
          "issues.edited",
          "pull_request.reopened",
          "pull_request.labeled",
          "pull_request.unlabeled",
          "pull_request.assigned",
          "pull_request.unassigned",
          "pull_request.edited",
        ],
      },
      {
        event: Events.IssuesClosed,
        emitters: ["issues.closed", "pull_request.closed"],
      },
      {
        event: Events.IssuesPromoted,
        emitters: ["issue_comment.created"],
      },
    ];
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

// function processState(state: Map<string, Issue>, issue: Issue) {
//   const autodestroy = (after: number) =>
//     setTimeout(() => state.delete(issue.id), after);

//   const stateIssue = state.get(issue.id);
//   if (!stateIssue) {
//     state.set(issue.id, issue);
//     autodestroy(ms("3m"));
//     return issue;
//   }

//   const merge = mergeDeepWithKey(concat2, stateIssue);
//   const merged = merge(issue);
//   state.set(merged.id, merged);
//   return merged;
// }

// function debounce(func: Function, timeout = 300) {
//   let timer;
//   const state = new Map();
//   return (issue) => {
//     const result = processState(state, issue);
//     clearTimeout(timer);
//     timer = setTimeout(() => {
//       func.call(this, result);
//     }, timeout);
//   };
// }

// const test = debounce((e) => {
//   console.log(e);
// });

// test({ id: "1", number: 1, labels: ["a"] });
// test({ id: "1", number: 2, labels: ["b"] });
// test({ id: "1", number: 3, labels: ["c"] });

// const evaluate = includes([Events.IssuesClosed, Events.IssuesPromoted]);
// // const evaluate = includes([Events.IssuesPromoted]);
// // const evaluate = includes([Events.IssuesCreated, Events.IssuesUpdated]);
// // const evaluate = includes([Events.IssuesCreated]);

// const finalEvent = evaluate([[Events.IssuesPromoted, Events.IssuesClosed]])
//   ? Events.IssuesPromoted
//   : evaluate([[Events.IssuesCreated, Events.IssuesUpdated]])
//   ? Events.IssuesCreated
//   : "preEvent";

// console.log(finalEvent);

// console.log(includes(["a", "b"], [["a", "b"]]));

// function processEvent(events: Events[]): Events {
//   const all = (...arr) => arr.every((e) => events.includes(e));

//   if (all(Events.IssuesPromoted, Events.IssuesClosed)) {
//     return Events.IssuesPromoted;
//   } else if (all(Events.IssuesCreated, Events.IssuesUpdated)) {
//     return Events.IssuesCreated;
//   }

//   return [...events].pop()!;
// }

// const state = new Map<string, any>();

// function debounce<T>(callback: (payload: T) => void, timeout = 1000) {
//   const timers = new Map<string, NodeJS.Timeout>();
//   const clear = (id) => clearTimeout(timers.get(id)!);
//   return <I extends string, T>(id: I, props: T, done?: () => void) => {
//     clear(id);
//     const timer = setTimeout(() => {
//       callback.call(this, props);
//       clear(id);
//       done?.();
//     }, timeout);
//     timers.set(id, timer);
//   };
// }

// const processEntry = debounce((payload: Payload) => {
//   const data = {
//     ...(payload.issue ?? payload.pull_request),
//     repository: payload.repository,
//     comment: payload.comment,
//   };
//   const event = processEvent(payload.events);
//   console.log(event, payload.events, data);
//   // const repo = this.repos.get(payload.repository.full_name)!;
//   // const issue = parse.issue(data as any, payload.repository as any);
// });

// function test(event, data) {
//   const issue = data.payload.issue ?? data.payload.pull_request;
//   const status = state.get(issue.id) ?? { events: [] };
//   const payload: Payload = {
//     ...mergeDeepRight(status, data.payload),
//     events: [...status.events, event],
//   };
//   state.set(issue.id, payload);
//   processEntry(issue.id, payload, () => state.delete(issue.id));
// }

// let payload = { issue: { id: "1", title: "AAA", labels: ["A"] } };
// test(Events.IssuesClosed, { payload });
// test(Events.IssuesPromoted, { payload });

// payload = { issue: { id: "2", title: "AAA", labels: ["A"] } };
// test(Events.IssuesCreated, { payload });
// payload = { issue: { id: "2", title: "BBB", labels: ["A", "B"] } };
// test(Events.IssuesUpdated, { payload });
