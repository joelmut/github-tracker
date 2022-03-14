import R from "ramda";
import http from "http";
import { Webhooks, createNodeMiddleware } from "@octokit/webhooks";
import { RequestInterface } from "@octokit/types";
import { Issue, IssueState, IssueType, Repository } from "src/core/interfaces";
import { request } from "@octokit/request";
import { default as ev } from "extract-values";

interface RequestOptions {
  token: string;
}

interface WebhookOptions {
  secret: string;
  port: number;
}

interface Options {
  request: RequestOptions;
  webhook: WebhookOptions;
}

interface GithubToIssue {
  state: string;
  number: number;
  title: string;
  repository_url: string;
  assignees?: any[];
  labels: any[];
  html_url: string;
  user: any;
  pull_request?: any;
}

interface IssuesFindMany {
  state?: IssueState;
  issues?: IssuesFindOne[];
  repositories?: string[];
  assignees?: string[];
}

interface IssuesFindOne {
  repository: string;
  number: number;
}
type RepositoriesOne = Pick<Repository, "name">;

export class GithubClient {
  request: RequestInterface;
  webhook: GithubWebhookProvider;
  repositories: Repositories;
  issues: Issues;

  constructor(options: Options) {
    this.webhook = new GithubWebhookProvider(options.webhook);
    this.request = request.defaults({
      headers: {
        authorization: `token ${options.request.token}`,
      },
    });

    this.repositories = new Repositories(this.request);
    this.issues = new Issues(this.request);
  }
}

class Issues {
  constructor(private request: RequestInterface) {}

  async findOne(where: IssuesFindOne): Promise<Issue> {
    const [owner, repo] = where.repository.split("/");
    const { data } = await this.request(
      "GET /repos/{owner}/{repo}/issues/{issue_number}",
      {
        owner,
        repo,
        issue_number: where.number,
      }
    );

    return this.mapFromGithub(data);
  }

  async findMany(where: IssuesFindMany): Promise<Issue[]> {
    if (where.issues) {
      const repos: Record<string, any> = R.groupBy(
        R.prop("repository"),
        where.issues
      );
      const promises = Object.entries(repos).map(
        async ([repository, issues]: any) => {
          const query = `repo:${repository} # ${issues.join(" ")}`;
          const result = await this.search(query);
          return result.map(this.mapFromGithub);
        }
      );

      return (await Promise.all(promises)).flat();
    }

    // TODO add from time in the filter, so search for issues after the previous check
    const query = [
      `is:${where.state || IssueState.open}`,
      ...where.repositories?.map((repo) => `repo:${repo}`),
      ...where.assignees?.map((assignee) => `involves:${assignee}`),
    ].join(" ");

    const result = await this.search(query);
    return result.map(this.mapFromGithub);
  }

  async search(query: string): Promise<any[]> {
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

  mapFromGithub(issue: GithubToIssue): Issue {
    const { owner, repo } = ev(
      issue.html_url,
      "{protocol}://{domain}/{owner}/{repo}/{type}/{number}"
    );

    return {
      type: issue.pull_request ? IssueType.pull : IssueType.issue,
      state: issue.state as IssueState,
      number: issue.number,
      title: issue.title,
      repository: `${owner}/${repo}`,
      author: { name: issue.user.login, url: issue.user.html_url },
      assignees: issue.assignees?.map((e) => ({
        name: e.login,
        url: e.html_url,
      }))!,
      labels: issue.labels.map((e) => e.name),
      url: issue.html_url,
    };
  }
}

class Repositories {
  constructor(private request: RequestInterface) {}

  async findOne(where: RepositoriesOne): Promise<Repository> {
    const [owner, repo] = where.name.split("/");
    const { data } = await this.request("GET /repos/{owner}/{repo}", {
      owner,
      repo,
    });

    return {
      name: data?.full_name,
      source: {
        name: data?.source?.full_name!,
      },
    };
  }
}

export class GithubWebhookProvider extends Webhooks<Issue> {
  constructor(private options: WebhookOptions) {
    super(options);
  }

  listen(listener?: () => void): http.Server {
    return http
      .createServer(createNodeMiddleware(this))
      .listen(this.options.port, listener);
  }
}
