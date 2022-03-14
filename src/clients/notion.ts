import { Client } from "@notionhq/client/build/src";
import { GetPageResponse } from "@notionhq/client/build/src/api-endpoints";
import { Issue } from "src/core/interfaces";
import R from "ramda";

interface Options {
  secret: string;
  database: string;
}

type NotionIssuesUpdate = Pick<Issue, "repository" | "number">;
type NotionIssuesFindOne = NotionIssuesUpdate;

interface NotionIssuesFindMany {
  state?: "open" | "closed";
  issues?: Partial<Pick<Issue, "repository" | "number">>[];
}

export class NotionClient {
  client: Client;
  issues: Issues;

  constructor(options: Options) {
    this.client = new Client({ auth: options.secret });

    this.issues = new Issues(this.client, options.database);
  }

  static merge(clients: NotionClient[]): NotionClient {
    const [base] = clients;
    return {
      ...base,
      issues: Object.keys(base.issues).reduce((acc, val) => {
        acc[val] = (...args) =>
          clients.map(({ issues }) => issues[val](...args))[0];
        return acc;
      }, {} as NotionClient["issues"]),
    };
  }
}

class Issues {
  constructor(private client: Client, private database: string) {}

  async insert(issue: Issue): Promise<Issue> {
    const data = await this.client.pages.create({
      parent: { database_id: this.database },
      properties: this.mapToNotion(issue),
    });

    return this.mapFromNotion(data);
  }

  async update(where: NotionIssuesUpdate, issue: Issue): Promise<Issue> {
    const item = await this.findIssuePage(this.database, where);
    if (!item) return;

    const baseIssue = this.mapFromNotion(item);
    const updatedIssue = R.mergeDeepLeft(issue, baseIssue);

    const data = await this.client.pages.update({
      page_id: item.id,
      properties: this.mapToNotion(updatedIssue),
    });

    return this.mapFromNotion(data);
  }

  async delete(where: NotionIssuesUpdate): Promise<void> {
    const item = await this.findIssuePage(this.database, where);
    if (!item) return;

    await this.client.blocks.delete({
      block_id: item.id,
    });
  }

  async findOne(where: NotionIssuesFindOne): Promise<Issue> {
    const issue = await this.findIssuePage(this.database, where);
    return this.mapFromNotion(issue);
  }

  async findMany(where: NotionIssuesFindMany): Promise<Issue[]> {
    let filters = [];

    if (where.issues) {
      filters = where.issues.map((issue) => {
        const filters = [];

        if (where.state) {
          filters.push({ property: "State", select: { equals: where.state } });
        }

        if (issue.number) {
          filters.push({
            property: "Number",
            number: { equals: issue.number },
          });
        }

        if (issue.repository) {
          filters.push({
            property: "Repository",
            select: { equals: issue.repository },
          });
        }

        return { and: filters };
      });
    }

    const fetch = async (cursor?) => {
      const { has_more, next_cursor, results } =
        await this.client.databases.query({
          database_id: this.database,
          page_size: 100,
          start_cursor: cursor,
          filter: { or: filters },
        });

      if (has_more) {
        return [...results, ...(await fetch(next_cursor))];
      }

      return results || [];
    };

    const result = await fetch();
    return result.map(this.mapFromNotion);
  }

  mapToNotion({
    type,
    title,
    number,
    state,
    labels,
    repository,
    url,
    fork,
    assignees,
    author,
  }: Issue) {
    const properties: any = {
      Type: {
        select: { name: type },
      },
      Repository: {
        select: { name: repository },
      },
      State: {
        select: { name: state },
      },
      Number: {
        number,
      },
      Title: {
        title: [{ text: { content: title } }],
      },
      Labels: {
        multi_select: labels?.map((name) => ({ name })),
      },
      Links: {
        rich_text: [
          {
            text: { content: "source", link: { type: "url", url } },
          },
        ],
      },
      Assignees: {
        rich_text: R.intersperse(
          { text: { content: "\n" } },
          assignees.map((e) => ({
            text: { content: e.name, link: { type: "url", url: e.url } },
          }))
        ),
      },
      Author: {
        rich_text: [
          {
            text: {
              content: author.name,
              link: { type: "url", url: author.url },
            },
          },
        ],
      },
    };

    if (fork) {
      properties.Links.rich_text.push(
        { text: { content: "\n" } },
        { text: { content: "fork", link: { type: "url", url: fork } } }
      );
    }

    return properties;
  }

  mapFromNotion(issue): Issue {
    if (!issue) return;

    const { properties: prop } = issue;
    return {
      type: prop.Type.select.name,
      state: prop.State.select.name,
      number: prop.Number.number,
      title: prop.Title.title[0].text.content,
      repository: prop.Repository.select.name,
      author: prop.Author.rich_text
        .filter((e) => e.text.link?.url)
        .map(({ text }) => ({
          name: text.content,
          url: text.link.url,
        }))[0],
      assignees: prop.Assignees.rich_text
        .filter((e) => e.text.link?.url)
        .map(({ text }) => ({
          name: text.content,
          url: text.link.url,
        })),
      labels: prop.Labels.multi_select.map((e) => e.name),
      url: prop.Links.rich_text.find((e) => e.text.content === "source")?.text
        ?.link?.url,
      fork: prop.Links.rich_text.find((e) => e.text.content === "fork")?.text
        ?.link?.url,
    };
  }

  private async findIssuePage(
    database: string,
    where: NotionIssuesFindOne
  ): Promise<GetPageResponse> {
    const {
      results: [item],
    } = await this.client.databases.query({
      database_id: database,
      filter: {
        and: [
          { property: "Repository", select: { equals: where.repository } },
          { property: "Number", number: { equals: where.number } },
        ],
      },
    });

    return item;
  }
}
