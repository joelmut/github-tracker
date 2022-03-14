import { config } from "./config";

import { GithubNotionConnector } from "./connectors/github-notion";
import { GithubClient } from "./clients/github";
import { NotionClient } from "./clients/notion";

const github = new GithubClient({
  request: { token: config.github.secret },
  webhook: config.github.fetchPolicy.webhook,
});

const notion = new NotionClient(config.notion);

new GithubNotionConnector({
  github,
  notion,
  poolInterval: config.github.fetchPolicy.poolInterval.interval,
  listeners: config.github.listeners,
  repositories: config.github.repos,
});

github.webhook.listen();
console.log(
  `[Github Webhooks] Listening on http://localhost:${config.github.fetchPolicy.webhook.port}/api/github/webhooks`
);
