// Usage:
//   npm run import:sheet -- --file task-tracker.csv               # dry run: validates and prints the header mapping
//   npm run import:sheet -- --file task-tracker.csv --commit      # writes; re-running skips rows already imported
//   Options: --mapping mapping.json (override header names), --as admin@company.com, --report out.json
import { readFileSync, writeFileSync } from "node:fs";
import { importTaskTracker } from "../src/domain/importer";
import { prisma } from "../src/lib/db";

function arg(name: string) {
  const i = process.argv.indexOf(`--${name}`);
  return i > -1 ? process.argv[i + 1] : undefined;
}

async function main() {
  const file = arg("file");
  if (!file) throw new Error("--file is required");
  const commit = process.argv.includes("--commit");
  const mapping = arg("mapping") ? JSON.parse(readFileSync(arg("mapping")!, "utf8")) : undefined;
  const report = await importTaskTracker(readFileSync(file, "utf8"), { file, dryRun: !commit, mapping, createdByEmail: arg("as") });

  console.log(`\n${commit ? "IMPORT" : "DRY RUN"} — ${file}`);
  console.log("Header mapping (verify against the live sheet before committing — spec §7.2):");
  for (const [k, v] of Object.entries(report.headerMapping)) console.log(`  ${k.padEnd(14)} ← ${v ?? "(not found)"}`);
  if (report.unmappedHeaders.length) console.log(`Ignored columns: ${report.unmappedHeaders.join(", ")}`);
  for (const r of report.rows.filter((x) => x.status === "ERROR")) console.log(`  row ${r.row}: ${r.errors!.join("; ")}`);
  console.log("Totals:", report.totals);
  if (arg("report")) writeFileSync(arg("report")!, JSON.stringify(report, null, 2));
  if (!commit) console.log("\nNothing was written. Re-run with --commit to import.");
}

main()
  .catch((e) => {
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
