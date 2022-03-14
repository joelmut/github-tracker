import ms from "ms";
import { Issue, IssueState } from "src/core/interfaces";
import R from "ramda";
import { categorize } from "src/core/categorize";
import { equalFields, move } from "src/core/utils";
import { GithubClient } from "../clients/github";
import { NotionClient } from "../clients/notion";
import { ReposConfig, WebhookFetchPolicy } from "src/config";

interface Options {
  github: GithubClient;
  notion: NotionClient;
  poolInterval: string;
  repositories: ReposConfig[];
  listeners: string[];
}

export class GithubNotionConnector {
  constructor(private options: Options) {
    // setInterval(
    //   this.registerRequests.bind(this),
    //   ms(this.options.poolInterval || "1h")
    // );
    this.registerWebhooks();
  }

  private async registerRequests(): Promise<void> {
    const { github, notion, repositories, listeners } = this.options;

    const repos = repositories
      .filter(
        ({ fetchPolicy }) => fetchPolicy === WebhookFetchPolicy.poolInterval
      )
      .map(({ name }) => name);

    if (R.isEmpty(repos)) {
      return;
    }

    const githubIssues = await github.issues.findMany({
      repositories: repos,
      assignees: listeners,
    });

    const notionIssues = await notion.issues.findMany({
      state: IssueState.open,
      issues: repos.map((repository) => ({ repository })),
    });

    const context = categorize(githubIssues, notionIssues);

    let [create, update] = [[], context.update];

    if (!R.isEmpty(context.create)) {
      const existingIssues = await notion.issues.findMany({
        issues: context.create,
      });

      const condition = equalFields(existingIssues, ["repository", "number"]);
      [create, update] = move(context.create, context.update, condition);
    }

    if (!R.isEmpty(context.unknown)) {
      const unknown = await github.issues.findMany({
        issues: context.unknown,
      });

      [, update] = move(unknown, update);
    }

    await Promise.all([
      create.map((issue) => notion.issues.insert(issue)),
      update.map((issue) => notion.issues.update(issue, issue)),
    ]);
  }

  private registerWebhooks(): void {
    const { github, notion, repositories, listeners } = this.options;

    const existRepos = repositories.some(
      ({ fetchPolicy }) => fetchPolicy === WebhookFetchPolicy.webhook
    );

    if (!existRepos) {
      return;
    }

    const mapIssue = ({ payload }) => {
      const { issue, pull_request } = payload;
      const item = issue || { ...pull_request, pull_request: true };
      return github.issues.mapFromGithub(item);
    };
    const mapPayload = ({ payload }) => payload;

    github.webhook.on(
      ["issues.opened", "pull_request.opened"],
      R.when(
        isListener(listeners),
        R.pipe(mapIssue, (issue) => notion.issues.insert(issue))
      )
    );
    github.webhook.on(
      [
        "issues.closed",
        "issues.reopened",
        "issues.labeled",
        "issues.unlabeled",
        "issues.assigned",
        "issues.unassigned",
        "issues.edited",
        "pull_request.closed",
        "pull_request.reopened",
        "pull_request.labeled",
        "pull_request.unlabeled",
        "pull_request.assigned",
        "pull_request.unassigned",
        "pull_request.edited",
      ],
      R.when(
        isListener(listeners),
        R.pipe(mapIssue, (issue) => notion.issues.update(issue, issue))
      )
    );
    github.webhook.on(
      ["issue_comment.created"],
      R.when(
        R.allPass([isListener(listeners), isPromoted, isForked]),
        R.pipe(mapPayload, this.promoteIssue.bind(this))
      )
    );
  }

  private async promoteIssue({ repository, comment, issue }): Promise<Issue> {
    const { github, notion } = this.options;

    const promoted = getPromotedIssueNumber(comment.body);

    const repo = await github.repositories.findOne({
      name: repository.full_name,
    });

    const notionIssue = await notion.issues.findOne({
      repository: repo.source.name,
      number: promoted,
    });

    if (notionIssue) {
      await notion.issues.delete({
        repository: repo.source.name,
        number: promoted,
      });
    }

    const promotedIssue = await github.issues.findOne({
      repository: repo.source.name,
      number: promoted,
    });

    return notion.issues.update(
      { repository: repo.name, number: issue.number },
      {
        ...promotedIssue,
        fork: issue.html_url,
      }
    );
  }
}

// Helpers

function isListener(listeners: string[]) {
  return ({ payload }): Boolean => {
    const { issue, pull_request } = payload;
    const item = issue || pull_request;

    if (!item) return;

    const assignees = item.assignees.map(({ login }) => login);
    const author = item.user.login;

    return listeners.some(
      (user) => assignees.includes(user) || author === user
    );
  };
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
