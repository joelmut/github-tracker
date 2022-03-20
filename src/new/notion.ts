import { Client } from "@notionhq/client/build/src";
import type { GetPageResponse } from "@notionhq/client/build/src/api-endpoints";
import { Issue, IssueState, Repository } from "./shared";
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
  data: Issue;
  where: IWhere;
}

interface IDelete {
  where: IWhere;
}

interface IFindUnique {
  where: IWhere;
}

interface IFindMany {
  where: IWhere[];
}

interface IWhere {
  number: number;
  repository: string;
}

interface PageInfo {
  pageId: string;
}

export class Notion {
  private options: INotionOptions;
  private client: Client;
  private utils: NotionUtils;
  private issues: Issue[];

  constructor(options: INotionOptions) {
    this.options = options;
    this.client = new Client({ auth: options.secret });
    this.utils = new NotionUtils({ ...options, client: this.client });
  }

  async load(): Promise<Issue[]> {
    const pages = await this.utils.getPages();
    if (!pages?.length) return [];

    return (this.issues = pages
      .map((e) => e.properties as NotionIssue)
      .map(this.utils.fromPage));
  }

  async create(options: ICreate): Promise<Issue> {
    const result = await this.client.pages.create({
      parent: { database_id: this.options.database },
      properties: this.utils.toPage(options.data),
    });
    const issue = this.utils.fromPage(result.properties as NotionIssue);
    this.issues.push(issue);

    return issue;
  }

  async update(options: IUpdate): Promise<Issue> {
    const page = await this.utils.getPage(options.where);
    if (!page) return;

    const pi = this.utils.fromPage(page.properties as NotionIssue);

    // Maintain the promoted link from the page, otherwise it will be discarted.
    const data = {
      ...options.data,
      promoted: pi.promoted?.url ? pi.promoted : options.data.promoted,
    };

    const result = await this.client.pages.update({
      page_id: page.id,
      properties: this.utils.toPage(data),
    });

    const issue = this.utils.fromPage(result.properties as NotionIssue);

    const index = this.issues.findIndex(this.utils.getId(options.where));
    if (index >= 0) {
      this.issues[index] = issue;
    }

    return issue;
  }

  async delete(options: IDelete): Promise<Issue> {
    const page = await this.utils.getPage(options.where);
    if (!page) return;

    await this.client.blocks.delete({ block_id: page.id });

    const index = this.issues.findIndex(this.utils.getId(options.where));
    const issue = this.issues[index];
    this.issues = this.issues.filter((_, i) => i !== index);

    return issue;
  }

  findUnique(options: IFindUnique): Issue {
    return this.issues.find(this.utils.getId(options.where));
  }

  findMany(options?: IFindMany): Issue[] {
    if (!options) return this.issues;

    return this.issues.filter((e) =>
      options.where.some((x) => this.utils.getId(x)(e))
    );
  }

  async sync(issue: Issue): Promise<void> {
    const where: IWhere = {
      repository: issue.repository.fullname,
      number: issue.number,
    };

    this.findUnique({ where })
      ? await this.update({ data: issue, where })
      : await this.create({ data: issue });
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
  Raw: Field<"rich_text">;
};

interface INotionUtilsOptions extends INotionOptions {
  client: Client;
}

class NotionUtils {
  private options: INotionUtilsOptions;

  constructor(options: INotionUtilsOptions) {
    this.options = options;
  }

  getId(where: IWhere) {
    return (issue: Issue) =>
      issue.repository?.fullname === where.repository &&
      issue.number === where.number;
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

  async getPages(where?: IWhere[]): Promise<GetPageResponse[]> {
    const fetch = async (cursor?) => {
      const filter = where
        ? {
            or: where.map((e) => ({ and: this.getFilters(e) })),
          }
        : undefined;
      const { has_more, next_cursor, results } =
        await this.options.client.databases.query({
          database_id: this.options.database,
          page_size: 100,
          start_cursor: cursor,
          filter,
        });

      if (has_more) {
        return [...results, ...(await fetch(next_cursor))];
      }

      return results || [];
    };

    return fetch();
  }

  toPage(issue: Issue): NotionIssue {
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
                text: { content: "source", link: { url: issue.url ?? "" } },
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
      Raw: {
        rich_text: [{ text: { content: JSON.stringify(issue) } }],
      },
    } as NotionIssue;

    if (issue.promoted?.url) {
      properties.Links?.rich_text?.push(
        { text: { content: "\n" } } as any,
        {
          text: { content: "promoted", link: { url: issue.promoted.url } },
        } as any
      );
    }

    return properties as NotionIssue;
  }

  fromPage(page: NotionIssue): Issue {
    const raw = page.Raw.rich_text[0]?.plain_text;
    return raw ? JSON.parse(raw) : {};
  }

  private getFilters(where: IWhere) {
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
}
