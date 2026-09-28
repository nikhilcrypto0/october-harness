import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverScenarios, loadScenario } from "../src/scenario.ts";
import { buildScenarioReport, formatScenarioMarkdown } from "../src/scenario-report.ts";
import { runScenario } from "../src/scenario-runner.ts";

const bundled = resolve(import.meta.dirname, "../scenarios");

describe("scenario evals", () => {
	let tempDir: string;

	beforeEach(() => {
		tempDir = mkdtempSync(join(tmpdir(), "pi-scenario-test-"));
	});

	afterEach(() => {
		rmSync(tempDir, { recursive: true, force: true });
	});

	function write(relativePath: string, content: string | object): void {
		const path = join(tempDir, relativePath);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, typeof content === "string" ? content : JSON.stringify(content));
	}

	const renameScenario = {
		formatVersion: 1,
		id: "test/rename",
		prompt: "Rename old to new in a.txt.",
		tools: ["edit"],
		faux: [
			{ toolCall: { name: "edit", args: { path: "a.txt", edits: [{ oldText: "old", newText: "new" }] } } },
			{ text: "Done." },
		],
		expect: [{ file: "a.txt", contains: "new" }, { toolCalls: { name: "edit", min: 1, errors: 0 } }],
	};

	it("passes every bundled scenario with the faux model", async () => {
		const directories = await discoverScenarios(bundled);
		expect(directories.length).toBeGreaterThanOrEqual(2);
		for (const directory of directories) {
			const result = await runScenario(await loadScenario(directory));
			expect(result, result.id).toMatchObject({ passed: true, score: 1, errors: [] });
		}
	});

	it("fails checks when the run leaves the wrong end state", async () => {
		write("s/scenario.json", {
			...renameScenario,
			faux: [
				{ toolCall: { name: "edit", args: { path: "a.txt", edits: [{ oldText: "old", newText: "wrong" }] } } },
				{ text: "Done." },
			],
		});
		write("s/workspace/a.txt", "old\n");

		const result = await runScenario(await loadScenario(join(tempDir, "s")));

		expect(result.passed).toBe(false);
		expect(result.score).toBe(0.5);
		expect(result.checks[0]).toMatchObject({ check: "file a.txt", passed: false, detail: 'missing "new"' });
	});

	it("counts a failing tool call as an error", async () => {
		write("s/scenario.json", {
			...renameScenario,
			faux: [
				{ toolCall: { name: "edit", args: { path: "a.txt", edits: [{ oldText: "absent", newText: "x" }] } } },
				{ text: "Done." },
			],
		});
		write("s/workspace/a.txt", "old\n");

		const result = await runScenario(await loadScenario(join(tempDir, "s")));

		expect(result.metrics).toMatchObject({ toolCalls: 1, toolErrors: 1 });
		expect(result.checks[1]).toMatchObject({ passed: false, detail: "1 errors, expected 0" });
	});

	it("reports a faux script the run never finished as a run error", async () => {
		write("s/scenario.json", {
			...renameScenario,
			faux: [{ text: "Stopping early." }, ...renameScenario.faux],
		});
		write("s/workspace/a.txt", "old\n");

		const result = await runScenario(await loadScenario(join(tempDir, "s")));

		expect(result.passed).toBe(false);
		expect(result.errors).toEqual(["2 faux step(s) were never requested; the run ended early."]);
	});

	it("runs in a copy and leaves the fixture untouched", async () => {
		write("s/scenario.json", renameScenario);
		write("s/workspace/a.txt", "old\n");

		const result = await runScenario(await loadScenario(join(tempDir, "s")));

		expect(result.passed).toBe(true);
		expect(readFileSync(join(tempDir, "s/workspace/a.txt"), "utf8")).toBe("old\n");
	});

	it("rejects an invalid scenario with every problem path", async () => {
		write("s/scenario.json", { ...renameScenario, formatVersion: 2, sandbox: true, expect: [] });

		await expect(loadScenario(join(tempDir, "s"))).rejects.toThrow(/\/formatVersion[\s\S]*\/expect/);
	});

	it("summarizes results as Markdown with failures listed", async () => {
		write("s/scenario.json", { ...renameScenario, expect: [{ file: "a.txt", contains: "absent" }] });
		write("s/workspace/a.txt", "old\n");
		const result = await runScenario(await loadScenario(join(tempDir, "s")));

		const markdown = formatScenarioMarkdown(buildScenarioReport([result], new Date("2026-01-01T00:00:00Z")));

		expect(markdown).toContain("0/1 scenarios passed.");
		expect(markdown).toContain("| test/rename | FAIL | 0.00 |");
		expect(markdown).toContain('- test/rename: file a.txt: missing "absent"');
	});
});
