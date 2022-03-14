import nconf from "nconf";
import { request as octokit } from "@octokit/request";

import { config, WebhookFetchPolicy } from "../config";

const { github } = config;

const request = octokit.defaults({
  headers: {
    // Create a personal access token at https://github.com/settings/tokens/new?scopes=repo
    authorization: `token ${github.secret}`,
  },
});

async function main({ cmd, endpoint }) {
  if (!endpoint) {
    throw new Error("Must enter a valid endpoint!");
  }

  switch (cmd.toLocaleLowerCase()) {
    case "create": {
      const promises = github.repos
        .filter(
          ({ fetchPolicy, id }) =>
            fetchPolicy === WebhookFetchPolicy.webhook && id == null
        )
        .map(async ({ name }, index) => {
          const { webhook } = github.fetchPolicy;
          const [owner, repo] = name.split("/");
          const { data } = await request("POST /repos/{owner}/{repo}/hooks", {
            owner,
            repo,
            config: {
              url: endpoint,
              secret: webhook.secret,
              content_type: "json",
            },
            events: webhook.events,
          });

          nconf.set(`github.repos.${index}.id`, data.id);
        });
      await Promise.all(promises);

      break;
    }

    case "update":
      await main({ cmd: "delete", endpoint });
      await main({ cmd: "create", endpoint });

      break;

    case "delete": {
      const promises = github.repos
        .filter(
          ({ fetchPolicy, id }) =>
            fetchPolicy === WebhookFetchPolicy.webhook && !!id
        )
        .map(async ({ name, id }, index) => {
          const [owner, repo] = name.split("/");
          await request("DELETE /repos/{owner}/{repo}/hooks/{hook_id}", {
            owner,
            repo,
            hook_id: id!,
          });

          nconf.set(`github.repos.${index}.id`, null);
        });
      await Promise.all(promises);

      break;
    }

    default:
      throw new Error(`Command '${cmd}' not supported!`);
  }

  nconf.save(null);
}

const [, , cmd, hostname] = process.argv;
const endpoint = `${hostname}/api/github/webhooks`;
main({ cmd, endpoint });
