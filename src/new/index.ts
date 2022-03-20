import { config } from "src/config";
import { Listener } from "./Listener";
import { Searcher } from "./searcher";
import { Events, IssueState, register } from "./shared";
import { Notion } from "./notion";
import { Semaphore } from "./semaphore";
import { IssueType } from "src/core/interfaces";
import { DevOps } from "./devops";

main();

async function main() {
  const semaphore = new Semaphore<Events>(1);
  const notion = new Notion(config.notion);
  const devops = new DevOps(config.devops);

  const listener = new Listener({
    token: config.github.token,
    users: config.github.listeners,
    repos: config.github.repos.realtime,
  });

  const startAt = new Date("2022-03-19T19:00:00.000Z");

  const searcher = new Searcher({
    // schedule: "*/10 * * * * *",
    schedule: config.github.schedule,
    token: config.github.token,
    users: config.github.listeners,
    repos: config.github.repos.poolinterval,
    startAt,
  });

  await notion.load();

  const subscribe = register([listener, searcher]);

  subscribe({
    events: [Events.IssuesCreated],
    listen(event, payload) {
      payload.map(async (issue) => {
        const { release } = await semaphore.acquire(issue.url);
        await notion.sync(issue);
        release();

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
        const { release, context } = await semaphore.acquire(issue.url);
        await notion.sync(issue);
        release();
      });
    },
  });

  subscribe({
    events: [Events.IssuesPromoted],
    async listen(event, payload) {
      payload.map(async (issue) => {
        const { release } = await semaphore.acquire(issue.promoted?.url);

        const si = notion.findUnique({
          where: {
            repository: issue.repository.source?.fullname!,
            number: issue.promoted?.number!,
          },
        });

        const data = {
          ...issue,
          state: IssueState.Open,
          number: issue.promoted?.number,
          repository: issue.repository.source,
          url: issue.promoted?.url,
          ...si,
          promoted: {
            number: issue.number,
            url: issue.url,
          },
        };

        await notion.sync(data);
        release();

        // Remove fork issue
        const where = {
          repository: issue.repository.fullname,
          number: issue.number,
        };
        await notion.delete({ where });
      });
    },
  });
}
