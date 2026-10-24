import { parseArgs } from "node:util";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline/promises";
import { CobbleService } from "./core/service";

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      data: { type: "string" },
      name: { type: "string" },
      "plan-file": { type: "string" },
      workspace: { type: "string" },
      file: { type: "string" },
      stdin: { type: "boolean" },
      "from-transcript": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const command = positionals[0];
  if (values.help || !command) {
    console.log(`Cobble — shared direction for your team

  cobble init --name NAME --plan-file PLAN.md --workspace FOLDER
  cobble ingest --stdin | --file FILE | --from-transcript
  cobble status
  cobble report

Optional: --data PATH uses an isolated SQLite database.
The desktop handles encrypted team hosting and IDE pairing.
Transcript ingest accepts current-turn text or {assistant_message: text}.
Agent hook installation is not yet automatic.`);
    return;
  }
  const data = resolve(
    values.data ??
      join(
        process.env.APPDATA ?? join(homedir(), ".config"),
        "cobble",
        "cobble.sqlite",
      ),
  );
  const service = new CobbleService(data);
  try {
    if (command === "init") {
      const prompt = createInterface({
        input: process.stdin,
        output: process.stdout,
      });
      try {
        let name = values.name;
        let plan: string;
        if (!name) name = await prompt.question("Team name: ");
        if (values["plan-file"])
          plan = await readFile(resolve(values["plan-file"]), "utf8");
        else {
          console.log("Starting plan (finish with a line containing END):");
          const lines: string[] = [];
          for (;;) {
            const line = await prompt.question("");
            if (line === "END") break;
            lines.push(line);
          }
          plan = lines.join("\n");
        }
        if (!service.store.profile()) {
          const displayName = await prompt.question("Your display name: ");
          await service.action({
            type: "profile",
            name: displayName,
            email: "",
          });
        }
        await service.action({
          type: "createTeam",
          name,
          plan,
          workspace: resolve(values.workspace ?? process.cwd()),
        });
        console.log(
          `Created ${name}. Starting plan stored as ${service.activeTeam()!.items.length} pieces.`,
        );
      } finally {
        prompt.close();
      }
    } else if (command === "status") {
      const s = service.state();
      console.log(
        JSON.stringify(
          {
            profile: s.profile?.name,
            team: service.activeTeam()?.name,
            workspace: service.activeTeam()?.workspace,
            planVersion: service.activeTeam()?.version,
            paused: s.paused,
            recentActivity: s.activities,
          },
          null,
          2,
        ),
      );
    } else if (command === "ingest") {
      const chunks: Buffer[] = [];
      let size = 0;
      let input: string;
      if (values.file) input = await readFile(resolve(values.file), "utf8");
      else {
        for await (const chunk of process.stdin) {
          size += chunk.length;
          if (size > 1_000_000) throw new Error("Input exceeds 1 MB");
          chunks.push(Buffer.from(chunk));
        }
        input = Buffer.concat(chunks).toString("utf8");
      }
      if (values["from-transcript"]) {
        try {
          const body = JSON.parse(input);
          if (typeof body.assistant_message === "string")
            input = body.assistant_message;
        } catch {
          /* plain transcript text */
        }
      }
      await service.monitor();
      console.log(JSON.stringify(await service.ingest(input), null, 2));
    } else if (command === "report") {
      const report = service.report();
      const directory = join(
        service.activeTeam()?.workspace || process.cwd(),
        ".cobble",
        "reports",
      );
      await mkdir(directory, { recursive: true });
      const file = join(
        directory,
        `session-${new Date().toISOString().replaceAll(":", "-")}.md`,
      );
      await writeFile(file, report, "utf8");
      console.log(file);
    } else throw new Error(`Unknown command: ${command}`);
  } finally {
    await service.close();
  }
}
void main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
