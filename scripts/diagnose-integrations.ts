import { resolve } from "node:path";
import { discoverIdes } from "../src/main/ide-discovery";
import { diagnoseIntegrations } from "../src/main/integration-diagnostics";
console.log(
  JSON.stringify(
    await diagnoseIntegrations(
      await discoverIdes(),
      process.argv[2] ? resolve(process.argv[2]) : undefined,
      { state: "disconnected" },
    ),
    null,
    2,
  ),
);
