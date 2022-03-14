import dotenv from "dotenv";
import nconf from "nconf";

dotenv.config();

// Doccumentation in https://github.com/indexzero/nconf/tree/v0.11.3
nconf.use("file", {
  file: "appsettings.json",
  logicalSeparator: ".",
});

export const config: Config = {
  github: nconf.get("github"),
  notion: nconf.get("notion"),
  devops: nconf.get("devops"),
};

interface Config {
  github: GithubConfig;
  notion: NotionConfig;
  devops: DevopsConfig;
}

interface GithubConfig {
  schedule: string;
  token: string;
  listeners: string[];
  repos: ReposConfig;
}

interface NotionConfig {
  secret: string;
  database: string;
}

interface DevopsConfig {
  token: string;
  organization: string;
  project: string;
}

export interface ReposConfig {
  realtime: string[];
  poolinterval: string[];
}
