import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { discoverScenarios, loadScenario } from "./scenario.ts";
import { buildScenarioReport, formatScenarioMarkdown, writeScenarioReport } from "./scenario-report.ts";
import { runScenario } from "./scenario-runner.ts";

const packageRoot = resolve(import.meta.dirname, "..");
const { values } = parseArgs({
	options: {
		scenarios: { type: "string", default: join(packageRoot, "scenarios") },
		out: { type: "string" },
		filter: { type: "string" },
	},
});

const directories = (await discoverScenarios(values.scenarios)).filter(
	(directory) => values.filter === undefined || directory.includes(values.filter),
);
if (directories.length === 0) throw new Error(`No scenarios found under ${values.scenarios}`);

const results = [];
for (const directory of directories) {
	results.push(await runScenario(await loadScenario(directory)));
}
const report = buildScenarioReport(results);
const out = values.out ?? join(packageRoot, ".eval", `scenarios-${report.createdAt.replaceAll(":", "-")}`);
await writeScenarioReport(out, report);
process.stdout.write(`${formatScenarioMarkdown(report)}\nReport: ${out}\n`);
process.exitCode = report.passed === report.total ? 0 : 1;
