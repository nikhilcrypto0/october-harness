import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
	type AssistantMessage,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
	InMemoryCredentialStore,
	type JsonObject,
} from "@earendil-works/pi-ai";
import {
	CONFIG_DIR_NAME,
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@october-dev/october";
import { applyIsolatedEnvironment } from "./harness.ts";
import type { FauxStep, LoadedScenario } from "./scenario.ts";
import { type CheckResult, evaluateChecks, scoreChecks, type ToolExecution } from "./scenario-checks.ts";

export type ScenarioResult = {
	id: string;
	mode: "faux";
	score: number;
	passed: boolean;
	checks: CheckResult[];
	/** Problems with the run itself (for example an unconsumed faux script), separate from failed checks. */
	errors: string[];
	metrics: {
		turns: number;
		toolCalls: number;
		toolErrors: number;
		inputTokens: number;
		outputTokens: number;
		totalTokens: number;
		/** Faux usage is estimated and unpriced, so cost is only reported for real models. */
		costUsd: number | null;
		durationMs: number;
	};
};

function toAssistantMessage(step: FauxStep): AssistantMessage {
	if ("text" in step) return fauxAssistantMessage([fauxText(step.text)]);
	return fauxAssistantMessage([fauxToolCall(step.toolCall.name, step.toolCall.args as JsonObject)], {
		stopReason: "toolUse",
	});
}

/** Run one scenario against its scripted faux model in an isolated temp workspace and home. */
export async function runScenario(scenario: LoadedScenario): Promise<ScenarioResult> {
	const root = await mkdtemp(join(tmpdir(), "pi-scenario-"));
	const workspace = join(root, "workspace");
	const home = join(root, "home");
	const agentDir = join(home, CONFIG_DIR_NAME, "agent");
	const restoreEnvironment = applyIsolatedEnvironment(home, agentDir);
	const toolExecutions: ToolExecution[] = [];
	const errors: string[] = [];
	let turns = 0;
	try {
		if (scenario.workspaceDirectory) await cp(scenario.workspaceDirectory, workspace, { recursive: true });
		else await mkdir(workspace);
		await mkdir(agentDir, { recursive: true });

		const faux = fauxProvider({ api: "faux", provider: "faux" });
		faux.setResponses(scenario.faux.map(toAssistantMessage));
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("faux", async () => ({ type: "api_key", key: "scenario-only" }));
		const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
		modelRuntime.registerNativeProvider(faux.provider);
		await modelRuntime.refresh({ allowNetwork: false });

		const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
		const resourceLoader = new DefaultResourceLoader({
			cwd: workspace,
			agentDir,
			settingsManager,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: workspace,
			agentDir,
			model: faux.getModel(),
			modelRuntime,
			resourceLoader,
			sessionManager: SessionManager.inMemory(workspace),
			settingsManager,
			thinkingLevel: "off",
			tools: scenario.tools,
		});
		const unsubscribe = session.subscribe((event) => {
			if (event.type === "tool_execution_end") toolExecutions.push({ name: event.toolName, isError: event.isError });
			if (event.type === "turn_end") turns++;
		});

		const startedAt = performance.now();
		try {
			await session.prompt(scenario.prompt);
		} finally {
			unsubscribe();
		}
		const durationMs = performance.now() - startedAt;

		const pending = faux.getPendingResponseCount();
		if (pending > 0) errors.push(`${pending} faux step(s) were never requested; the run ended early.`);
		const last = [...session.messages].reverse().find((message) => message.role === "assistant");
		if (last?.role === "assistant" && last.stopReason === "error") {
			errors.push(`Run ended with an error: ${last.errorMessage ?? "unknown"}`);
		}

		const checks = await evaluateChecks(scenario.expect, {
			workspace,
			toolExecutions,
			finalText: session.getLastAssistantText() ?? "",
			turns,
		});
		const stats = session.getSessionStats();
		session.dispose();
		const score = scoreChecks(checks);
		return {
			id: scenario.id,
			mode: "faux",
			score,
			passed: errors.length === 0 && checks.every((check) => check.passed),
			checks,
			errors,
			metrics: {
				turns,
				toolCalls: toolExecutions.length,
				toolErrors: toolExecutions.filter((execution) => execution.isError).length,
				inputTokens: stats.tokens.input,
				outputTokens: stats.tokens.output,
				totalTokens: stats.tokens.total,
				costUsd: null,
				durationMs: Math.round(durationMs),
			},
		};
	} finally {
		restoreEnvironment();
		await rm(root, { recursive: true, force: true });
	}
}
