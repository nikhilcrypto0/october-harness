import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { discoverScenarios, loadScenario, writeRecordedScenario } from "./scenario.ts";
import { buildScenarioReport, formatScenarioMarkdown, writeScenarioReport } from "./scenario-report.ts";
import { runScenario, type ScenarioModelSelection } from "./scenario-runner.ts";

const packageRoot = resolve(import.meta.dirname, "..");
const { values } = parseArgs({
	options: {
		scenarios: { type: "string", multiple: true },
		out: { type: "string" },
		filter: { type: "string" },
		provider: { type: "string" },
		model: { type: "string" },
		record: { type: "string" },
	},
});

if (Boolean(values.provider) !== Boolean(values.model))
	throw new Error("Pass both --provider and --model, or neither.");
const model: ScenarioModelSelection | undefined =
	values.provider && values.model ? { provider: values.provider, id: values.model } : undefined;
if (values.record && !model) throw new Error("--record saves a real-model run; pass --provider and --model.");

const packs = values.scenarios ?? [join(packageRoot, "scenarios")];
const directories = (await Promise.all(packs.map((pack) => discoverScenarios(pack))))
	.flat()
	.filter((directory) => values.filter === undefined || directory.includes(values.filter));
if (directories.length === 0) throw new Error(`No scenarios found under ${packs.join(", ")}`);

const results = [];
for (const directory of directories) {
	const scenario = await loadScenario(directory);
	const result = await runScenario(scenario, { model });
	results.push(result);
	if (values.record) {
		const saved = await writeRecordedScenario(scenario, result.transcript, values.record);
		process.stdout.write(`Recorded ${scenario.id} -> ${saved}\n`);
	}
}
const report = buildScenarioReport(results);
const out = values.out ?? join(packageRoot, ".eval", `scenarios-${report.createdAt.replaceAll(":", "-")}`);
await writeScenarioReport(out, report);
process.stdout.write(`${formatScenarioMarkdown(report)}\nReport: ${out}\n`);
process.exitCode = report.passed === report.total ? 0 : 1;
