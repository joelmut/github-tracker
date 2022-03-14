import { Webhooks, createNodeMiddleware } from "@octokit/webhooks";
import { Options } from "@octokit/webhooks/dist-types/types";
import http from "http";
import { promisify } from "util";

interface WebhookOptions extends Options {
  secret: string;
}

export class WebhookProvider extends Webhooks {
  private Server: http.Server;

  constructor(options: WebhookOptions) {
    super(options);
    this.Server = http.createServer(createNodeMiddleware(this));
  }

  listen(path: string): Promise<void> {
    return promisify(this.Server.listen.bind(this.Server))(3000);
  }

  close(): Promise<void> {
    return promisify(this.Server.close)();
  }

  removeAll(): Promise<void> {
    return promisify(this.removeListener)("*");
  }
}
