import * as azdev from "azure-devops-node-api";
import { InferType, object, string } from "yup";
import { Issue } from "./shared";

const optionsSchema = object({
  token: string().required(),
  organization: string().required(),
  project: string().required(),
});

interface IDevOpsOptions extends InferType<typeof optionsSchema> {}

enum WorkingItemTypes {
  Feature = "Feature",
  Backlog = "Product Backlog Item",
  Task = "Task",
}

interface WorkingItem {
  type: WorkingItemTypes;
  title: string;
  tags?: string[];
  hyperlink?: string;
  parent?: number;
}

interface ICreate {
  data: Issue;
}

export class DevOps {
  private client: azdev.WebApi;
  private options: IDevOpsOptions;
  private utils: DevOpsUtils;

  constructor(options: IDevOpsOptions) {
    this.options = optionsSchema.validateSync(options);
    const handler = azdev.getPersonalAccessTokenHandler(options.token);
    this.client = new azdev.WebApi(options.organization, handler);
    this.utils = new DevOpsUtils({ ...this.options, client: this.client });
  }

  async create(options: ICreate): Promise<boolean> {
    const issue = options.data;

    const feature = await this.utils.create({
      type: WorkingItemTypes.Feature,
      title: `[${issue.repository.name}][#${issue.number}] ${issue.title}`,
      tags: ["automation"],
      hyperlink: issue.url,
    });

    const backlog = await this.utils.create({
      type: WorkingItemTypes.Backlog,
      title: `[#${issue.number}] ${issue.title}`,
      tags: ["automation"],
      hyperlink: issue.url,
      parent: feature,
    });

    const task = await this.utils.create({
      type: WorkingItemTypes.Task,
      title: `[#${issue.number}] ${issue.title}`,
      tags: ["automation"],
      parent: backlog,
      hyperlink: issue.url,
    });

    return !!feature && !!backlog && !!task;
  }
}

interface IDevOpsUtilsOptions extends IDevOpsOptions {
  client: azdev.WebApi;
}

class DevOpsUtils {
  constructor(private options: IDevOpsUtilsOptions) {}

  async create(item: WorkingItem): Promise<number> {
    const client = await this.options.client.getWorkItemTrackingApi();
    const properties: any[] = [
      {
        op: "add",
        path: "/fields/System.Title",
        value: item.title,
      },
    ];

    if (item.tags) {
      properties.push({
        op: "add",
        path: "/fields/System.Tags",
        value: item.tags.join(";"),
      });
    }

    if (item.hyperlink) {
      properties.push({
        op: "add",
        path: "/relations/-",
        value: {
          rel: "Hyperlink",
          url: item.hyperlink,
        },
      });
    }

    if (item.parent) {
      properties.push({
        op: "add",
        path: "/relations/-",
        value: {
          rel: "System.LinkTypes.Hierarchy-Reverse",
          url: `https://dev.azure.com/${this.options.organization}/_apis/wit/workItems/${item.parent}`,
        },
      });
    }

    const result = await client.createWorkItem(
      {},
      properties,
      this.options.project,
      item.type
    );

    return result?.id!;
  }
}
