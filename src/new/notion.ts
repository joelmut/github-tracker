import { Client } from "@notionhq/client/build/src";
import type { GetPageResponse } from "@notionhq/client/build/src/api-endpoints";
import { DeepPartial, Issue, IssueState, Repository } from "./shared";
import { intersperse } from "ramda";
import { IssueType } from "src/core/interfaces";

interface INotionOptions {
  secret: string;
  database: string;
}

interface ICreate {
  data: Issue;
}

interface IUpdate {
  data: DeepPartial<Issue>;
  where: IWhere;
}

interface IDelete {
  where: IWhere;
}

interface IFindMany {
  where: IWhere[];
}

interface IWhere {
  number: number;
  repository: string;
}

export class Notion {
  private options: INotionOptions;
  private client: Client;
  private utils: NotionUtils;

  constructor(options: INotionOptions) {
    this.options = options;
    this.client = new Client({ auth: options.secret });
    this.utils = new NotionUtils({ ...options, client: this.client });
  }

  async create(options: ICreate): Promise<boolean> {
    const result = await this.client.pages.create({
      parent: { database_id: this.options.database },
      properties: this.utils.toPage(options.data),
    });
    return !!result?.id;
  }

  async update(options: IUpdate): Promise<boolean> {
    const page = await this.utils.getPage(options.where);
    if (!page) return false;

    const issue = this.utils.fromPage(page.properties as NotionIssue);

    // Maintain the promoted link from the page, otherwise it will be discarted.
    const data = {
      ...options.data,
      promoted: issue.promoted,
    } as Issue;

    const result = await this.client.pages.update({
      page_id: page.id,
      properties: this.utils.toPage(data),
    });
    return !!result?.id;
  }

  async delete(options: IDelete): Promise<boolean> {
    const page = await this.utils.getPage(options.where);
    if (!page) return false;

    const result = await this.client.blocks.delete({ block_id: page.id });
    return !!result?.id;
  }

  async findMany(
    options: IFindMany
  ): Promise<DeepPartial<Issue>[] | undefined> {
    const pages = await this.utils.getPages(options.where);
    if (!pages?.length) return;

    return pages
      .map((e) => e.properties as NotionIssue)
      .map(this.utils.fromPage);
  }
}

type Field<T extends GetPageResponse["properties"][string]["type"]> =
  GetPageResponse["properties"][string] & { type: T };

type NotionIssue = {
  Type: Field<"select">;
  State: Field<"select">;
  Number: Field<"number">;
  Title: Field<"title">;
  Repository: Field<"select">;
  Author: Field<"rich_text">;
  Assignees: Field<"rich_text">;
  Labels: Field<"multi_select">;
  Links: Field<"rich_text">;
};

interface INotionUtilsOptions extends INotionOptions {
  client: Client;
}

class NotionUtils {
  private options: INotionUtilsOptions;

  constructor(options: INotionUtilsOptions) {
    this.options = options;
  }

  getFilters(where: IWhere) {
    return [
      {
        property: "Repository",
        select: { equals: where.repository },
      },
      {
        property: "Number",
        number: { equals: where.number },
      },
    ];
  }

  async getPage(where: IWhere): Promise<GetPageResponse> {
    const {
      results: [page],
    } = await this.options.client.databases.query({
      database_id: this.options.database,
      filter: { and: this.getFilters(where) },
    });

    return page;
  }

  async getPages(where: IWhere[]): Promise<GetPageResponse[]> {
    const fetch = async (cursor?) => {
      const { has_more, next_cursor, results } =
        await this.options.client.databases.query({
          database_id: this.options.database,
          page_size: 100,
          start_cursor: cursor,
          filter: {
            or: where.map((e) => ({ and: this.getFilters(e) })),
          },
        });

      if (has_more) {
        return [...results, ...(await fetch(next_cursor))];
      }

      return results || [];
    };

    return fetch();
  }

  toPage(issue: DeepPartial<Issue>): NotionIssue {
    const properties = {
      Type: {
        select: { name: issue.type },
      },
      Repository: {
        select: { name: issue.repository?.fullname },
      },
      State: {
        select: { name: issue.state },
      },
      Number: {
        number: issue.number,
      },
      Title: {
        title: [{ text: { content: issue.title } }],
      },
      Labels: {
        multi_select: issue.labels?.map((name) => ({ name })) ?? [],
      },
      Links: {
        rich_text: issue.url
          ? [
              {
                text: { content: "source", link: { url: issue.url } },
              },
            ]
          : [],
      },
      Assignees: {
        rich_text: intersperse<any>(
          { text: { content: "\n" } },
          issue.assignees?.map((e) => ({
            text: { content: e?.name, link: { url: e?.url } },
          })) ?? []
        ),
      },
      Author: {
        rich_text: issue.author
          ? [
              {
                text: {
                  content: issue.author?.name,
                  link: { url: issue.author?.url },
                },
              },
            ]
          : [],
      },
    } as DeepPartial<NotionIssue>;

    if (issue.promoted) {
      properties.Links?.rich_text?.push(
        { text: { content: "\n" } },
        {
          text: { content: "promoted", link: { url: issue.promoted.url } },
        }
      );
    }

    return properties as NotionIssue;
  }

  fromPage(page: NotionIssue): DeepPartial<Issue> {
    return {
      type: page.Type.select?.name! as IssueType,
      state: page.State.select?.name! as IssueState,
      number: page.Number.number!,
      title: page.Title.title[0].plain_text,
      repository: {
        fullname: page.Repository.select?.name!,
      },
      author: page.Author.rich_text.map((e: any) => ({
        name: e.text.content,
        url: e.text.link?.url,
      }))[0],
      assignees: page.Assignees.rich_text.map((e: any) => ({
        name: e.text.content,
        url: e.text.link?.url,
      })),
      labels: page.Labels.multi_select.map((e) => e.name),
      url: page.Links.rich_text
        .filter((e: any) => e.text.content === "source")
        .map((e: any) => e.text.link?.url)[0],
      promoted: {
        url: page.Links.rich_text
          .filter((e: any) => e.text.content === "promoted")
          .map((e: any) => e.text.link?.url)[0],
      },
    };
  }
}
