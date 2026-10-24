import { createVSIX } from "@vscode/vsce";
import { mkdir, copyFile } from "node:fs/promises";
import { resolve } from "node:path";
await mkdir("resources/integrations", { recursive: true });
const output = resolve("resources/integrations/cobble-workspace.vsix");
await copyFile(
  resolve("packaging/agent-relay.ps1"),
  resolve("resources/integrations/agent-relay.ps1"),
);
process.chdir(resolve("extensions/vscode"));
await createVSIX({
  cwd: process.cwd(),
  packagePath: output,
  dependencies: false,
  allowMissingRepository: true,
  skipLicense: true,
});
