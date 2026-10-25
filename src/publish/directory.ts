import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExternalChange } from "../engine/context.ts";
import { shortHash } from "../engine/identity.ts";
import type { Report } from "../engine/report.ts";
import type { Publisher, PublishOutcome } from "./publisher.ts";

/**
 * Writes each planned change as a patch plus metadata, and each issue as Markdown. This is the
 * integration point for hosts other than GitHub: apply the patch on `baseCommit`, commit with
 * `commitMessage` (it carries the trailers), push `branch`, and open a merge request with `title`/`body`.
 */
export class DirectoryPublisher implements Publisher {
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  async externalChanges(): Promise<ExternalChange[]> {
    return [];
  }

  async publish(report: Report): Promise<PublishOutcome[]> {
    const outcomes: PublishOutcome[] = [];
    await mkdir(join(this.dir, "changes"), { recursive: true });
    await mkdir(join(this.dir, "issues"), { recursive: true });
    for (const change of report.changes) {
      const name = `${change.kind}-${shortHash(change.identity)}`;
      const { patch, ...meta } = change;
      await writeFile(join(this.dir, "changes", `${name}.patch`), patch);
      await writeFile(join(this.dir, "changes", `${name}.json`), `${JSON.stringify(meta, null, 2)}\n`);
      outcomes.push({ identity: change.identity, kind: "pull-request", action: "created", message: join(this.dir, "changes", `${name}.patch`) });
    }
    for (const issue of report.issues) {
      const name = `stale-${shortHash(issue.identity)}`;
      await writeFile(join(this.dir, "issues", `${name}.md`), `# ${issue.title}\n\n${issue.body}\n`);
      await writeFile(join(this.dir, "issues", `${name}.json`), `${JSON.stringify(issue, null, 2)}\n`);
      outcomes.push({ identity: issue.identity, kind: "issue", action: "created", message: join(this.dir, "issues", `${name}.md`) });
    }
    return outcomes;
  }
}
