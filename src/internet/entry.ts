import { runRelay } from "./cli";
void runRelay().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
