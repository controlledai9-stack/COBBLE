import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";

console.log("===============================================================");
console.log("   COBBLE COMPREHENSIVE SYSTEM & DESIGN AUDIT RUNNER");
console.log("===============================================================\n");

const startTime = performance.now();

async function runStep(name, cmd, args) {
  process.stdout.write(`[*] Auditing: ${name}... `);
  const stepStart = performance.now();
  return new Promise((resolve) => {
    const fullCmd = Array.isArray(args) && args.length > 0 ? `${cmd} ${args.join(" ")}` : cmd;
    const child = spawn(fullCmd, { shell: true, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("close", (code) => {
      const duration = ((performance.now() - stepStart) / 1000).toFixed(2);
      if (code === 0) {
        console.log(`\x1b[32mPASSED\x1b[0m (${duration}s)`);
        resolve({ name, pass: true, duration, output: stdout });
      } else {
        console.log(`\x1b[31mFAILED\x1b[0m (${duration}s)`);
        console.error(stderr || stdout);
        resolve({ name, pass: false, duration, output: stderr || stdout });
      }
    });
  });
}

const auditSteps = [
  {
    name: "TypeScript Compiler Strict Check (tsc --noEmit)",
    cmd: "npx",
    args: ["tsc", "--noEmit"],
  },
  {
    name: "Apple HIG Design System, Contrast & Tokens",
    cmd: "npx",
    args: ["tsx", "--test", "test/audit-design-system.test.ts"],
  },
  {
    name: "Security, CSP, Multi-Port Resilience & Browser Mock",
    cmd: "npx",
    args: ["tsx", "--test", "test/audit-resilience-security.test.ts"],
  },
  {
    name: "A11y Optical Contrast & Modal ARIA Rules",
    cmd: "npx",
    args: ["tsx", "--test", "test/design-system-a11y.test.ts"],
  },
  {
    name: "Baseline Screenshot Suite (Light & Dark Themes)",
    cmd: "npx",
    args: ["tsx", "--test", "test/screenshots.test.ts"],
  },
  {
    name: "Production Bundle & Assets Build (Vite + esbuild)",
    cmd: "npm",
    args: ["run", "build"],
  },
];

const results = [];
for (const step of auditSteps) {
  const res = await runStep(step.name, step.cmd, step.args);
  results.push(res);
}

const totalDuration = ((performance.now() - startTime) / 1000).toFixed(2);
const allPassed = results.every((r) => r.pass);

console.log("\n===============================================================");
console.log("   AUDIT SCORECARD & INTEGRITY VERIFICATION");
console.log("===============================================================");
for (const r of results) {
  const icon = r.pass ? "\x1b[32m✔ PASS\x1b[0m" : "\x1b[31m✖ FAIL\x1b[0m";
  console.log(`  ${icon}  [${r.duration}s] ${r.name}`);
}
console.log("---------------------------------------------------------------");
console.log(`Total Audit Duration: ${totalDuration}s`);
if (allPassed) {
  console.log("\x1b[32mALL 6 AUDIT PILLARS VERIFIED: 100% PASS\x1b[0m");
  process.exit(0);
} else {
  console.log("\x1b[31mAUDIT DETECTED FAILURES - REVIEW LOGS ABOVE\x1b[0m");
  process.exit(1);
}
