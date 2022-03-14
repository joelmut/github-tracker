import { config } from "src/config";
import { Listener } from "./Listener";
import { Searcher } from "./searcher";
import { Events, IssueState, register } from "./shared";
import { Notion } from "./notion";
import { Semaphore } from "./semaphore";
import { IssueType } from "src/core/interfaces";
import { DevOps } from "./devops";

const semaphore = new Semaphore<Events>(1);
const notion = new Notion(config.notion);
const devops = new DevOps(config.devops);

const listener = new Listener({
  token: config.github.token,
  users: config.github.listeners,
  repos: config.github.repos.realtime,
});
const searcher = new Searcher({
  // schedule: "*/20 * * * * *",
  schedule: config.github.schedule,
  token: config.github.token,
  users: config.github.listeners,
  repos: config.github.repos.poolinterval,
});

const subscribe = register([listener, searcher]);

subscribe({
  events: [Events.IssuesCreated],
  listen(event, payload) {
    payload.map(async (issue) => {
      const { release, context } = await semaphore.acquire(issue.url);
      if (context === Events.IssuesUpdated) {
        await notion.update({
          data: issue,
          where: {
            repository: issue.repository.fullname,
            number: issue.number,
          },
        });
        return release(context);
      }

      await notion.create({
        data: issue,
      });
      release(Events.IssuesCreated);

      if (issue.type === IssueType.issue) {
        await devops.create({ data: issue });
      }
    });
  },
});

subscribe({
  events: [Events.IssuesUpdated, Events.IssuesClosed],
  async listen(event, payload) {
    payload.map(async (issue) => {
      const { release } = await semaphore.acquire(issue.url);
      await notion.update({
        data: issue,
        where: {
          repository: issue.repository.fullname,
          number: issue.number,
        },
      });
      release(Events.IssuesUpdated);
    });
  },
});

subscribe({
  events: [Events.IssuesPromoted],
  async listen(event, payload) {
    const notionIssues = await notion.findMany({
      where: payload.map((issue) => ({
        repository: issue.repository.source?.fullname!,
        number: issue.promoted?.number!,
      })),
    });

    payload.map(async (issue) => {
      const { release } = await semaphore.acquire(issue.promoted?.url);

      const created = notionIssues?.find(
        (e) =>
          e.repository?.fullname === issue.repository.source?.fullname &&
          e.number === issue.promoted?.number
      )!;

      if (created) {
        await notion.delete({
          where: {
            repository: issue.repository.source?.fullname!,
            number: issue.promoted?.number!,
          },
        });
      }

      await notion.update({
        data: {
          type: IssueType.issue,
          state: IssueState.Open,
          title: issue.title,
          repository: issue.repository.source!,
          ...issue.promoted,
          ...created,
          promoted: {
            url: issue.url,
          },
        },
        where: {
          repository: issue.repository.fullname,
          number: issue.number,
        },
      });

      release(Events.IssuesUpdated);
    });
  },
});
