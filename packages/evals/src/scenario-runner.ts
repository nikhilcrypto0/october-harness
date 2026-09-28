import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import {
	type Api,
	type AssistantMessage,
	fauxAssistantMessage,
	fauxProvider,
	fauxText,
	fauxToolCall,
	InMemoryCredentialStore,
	type JsonObject,
	type Model,
} from "@earendil-works/pi-ai";
import {
	type AgentSession,
	CONFIG_DIR_NAME,
	createAgentSession,
	DefaultResourceLoader,
	getAgentDir,
	type InlineExtension,
	ModelRuntime,
	readStoredCredential,
	SessionManager,
	SettingsManager,
} from "@october-dev/october";
// The October permission gate and Bus tools are not public exports; the runner loads them from source
// exactly as the `october` extension registers them.
import { parseOctoberBusEnv } from "../../coding-agent/src/extensions/october/bus/env.ts";
import { registerOctoberBusTools } from "../../coding-agent/src/extensions/october/bus/tools.ts";
import { registerOctoberPermissions } from "../../coding-agent/src/extensions/october/permissions.ts";
import { applyIsolatedEnvironment } from "./harness.ts";
import type { FauxStep, LoadedScenario } from "./scenario.ts";
import { type ScenarioBus, startScenarioBus } from "./scenario-bus.ts";
import {
	type CheckResult,
	type Compaction,
	evaluateChecks,
	scoreChecks,
	type ToolExecution,
} from "./scenario-checks.ts";

export type ScenarioModelSelection = { provider: string; id: string };

export type RunScenarioOptions = {
	/** Run against this real model instead of the scenario's `faux` script. */
	model?: ScenarioModelSelection;
	/** A prepared runtime for `model`; by default one is built from the host's stored credentials. */
	modelRuntime?: ModelRuntime;
};

export type ScenarioResult = {
	id: string;
	mode: "faux" | "model";
	/** `provider/id` of the model that ran. */
	model: string;
	score: number;
	passed: boolean;
	checks: CheckResult[];
	/** Problems with the run itself (for example an unconsumed faux script), separate from failed checks. */
	errors: string[];
	/** The model's assistant messages as faux steps, so a real run can be saved and replayed. */
	transcript: FauxStep[];
	metrics: {
		turns: number;
		toolCalls: number;
		toolErrors: number;
		inputTokens: number;
		outputTokens: number;
		totalTokens: number;
		/** Only reported for a priced real model; faux usage is estimated and unpriced. */
		costUsd: number | null;
		durationMs: number;
	};
};

type PreparedModel = {
	modelRuntime: ModelRuntime;
	model: Model<Api>;
	/** Faux steps never requested, or undefined for a real model. */
	pendingSteps: () => number | undefined;
};

function toAssistantMessage(step: FauxStep): AssistantMessage {
	if ("toolCall" in step) {
		return fauxAssistantMessage([fauxToolCall(step.toolCall.name, step.toolCall.args as JsonObject)], {
			stopReason: "toolUse",
		});
	}
	if ("toolCalls" in step) {
		const calls = step.toolCalls.map((call) => fauxToolCall(call.name, call.args as JsonObject));
		return fauxAssistantMessage(step.text ? [fauxText(step.text), ...calls] : calls, { stopReason: "toolUse" });
	}
	return fauxAssistantMessage([fauxText(step.text)]);
}

/** Convert one assistant message to a faux step. Thinking is dropped; an empty message has no step. */
export function toFauxStep(message: AgentSession["messages"][number]): FauxStep | undefined {
	if (message.role !== "assistant") return undefined;
	const text = message.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
	const toolCalls = message.content
		.filter((part) => part.type === "toolCall")
		.map((part) => ({ name: part.name, args: part.arguments as Record<string, unknown> }));
	if (toolCalls.length === 1 && !text) return { toolCall: toolCalls[0] };
	if (toolCalls.length > 0) return text ? { text, toolCalls } : { toolCalls };
	return text ? { text } : undefined;
}

async function prepareModel(
	scenario: LoadedScenario,
	options: RunScenarioOptions,
	hostAgentDir: string,
): Promise<PreparedModel> {
	if (!options.model) {
		const faux = fauxProvider({
			api: "faux",
			provider: "faux",
			models: scenario.model ? [{ id: "faux-1", ...scenario.model }] : undefined,
		});
		faux.setResponses(scenario.faux.map(toAssistantMessage));
		const credentials = new InMemoryCredentialStore();
		await credentials.modify("faux", async () => ({ type: "api_key", key: "scenario-only" }));
		const modelRuntime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
		modelRuntime.registerNativeProvider(faux.provider);
		await modelRuntime.refresh({ allowNetwork: false });
		return { modelRuntime, model: faux.getModel(), pendingSteps: () => faux.getPendingResponseCount() };
	}
	const { provider, id } = options.model;
	let modelRuntime = options.modelRuntime;
	let storedCredential: ReturnType<typeof readStoredCredential> | undefined;
	if (!modelRuntime) {
		const credentials = new InMemoryCredentialStore();
		storedCredential = readStoredCredential(provider, join(hostAgentDir, "auth.json"));
		if (storedCredential) await credentials.modify(provider, async () => storedCredential!);
		modelRuntime = await ModelRuntime.create({ credentials });
	}
	const model = modelRuntime.getModel(provider, id);
	if (!model) throw new Error(`Scenario model not found: ${provider}/${id}`);
	const auth = await modelRuntime.getAuth(model);
	if (!auth) throw new Error(`Scenario model has no configured authentication: ${provider}/${id}`);
	if (!options.modelRuntime && !storedCredential && auth.auth.apiKey) {
		await modelRuntime.setRuntimeApiKey(provider, auth.auth.apiKey);
	}
	return { modelRuntime, model, pendingSteps: () => undefined };
}

function isPriced(model: Model<Api>): boolean {
	return [model.cost, ...(model.cost.tiers ?? [])].some(
		({ input, output, cacheRead, cacheWrite }) => input > 0 || output > 0 || cacheRead > 0 || cacheWrite > 0,
	);
}

/** Inline extensions for the scenario's permission mode and fake Bus. */
function scenarioExtensions(scenario: LoadedScenario, bus: ScenarioBus | undefined): InlineExtension[] {
	const extensions: InlineExtension[] = [];
	if (scenario.permissionMode) {
		extensions.push({ name: "scenario-permissions", hidden: true, factory: (pi) => registerOctoberPermissions(pi) });
	}
	if (bus) {
		const env = parseOctoberBusEnv({
			OCTOBER_BUS_PORT: String(bus.port),
			OCTOBER_BUS_CANVAS: "scenario-canvas",
			OCTOBER_BUS_NODE: "scenario-node",
		});
		if (!env) throw new Error("Fake Bus environment was not recognized.");
		extensions.push({ name: "scenario-bus", hidden: true, factory: (pi) => registerOctoberBusTools(pi, env) });
	}
	return extensions;
}

/**
 * Run one scenario in an isolated temp workspace and home. By default the scenario's scripted faux model
 * runs with no credentials or network; `options.model` runs a real model against the same checks instead.
 */
export async function runScenario(scenario: LoadedScenario, options: RunScenarioOptions = {}): Promise<ScenarioResult> {
	// Read before isolating the environment, which points the agent dir at the temp home.
	const hostAgentDir = getAgentDir();
	const root = await mkdtemp(join(tmpdir(), "pi-scenario-"));
	const workspace = join(root, "workspace");
	const home = join(root, "home");
	const agentDir = join(home, CONFIG_DIR_NAME, "agent");
	const restoreEnvironment = applyIsolatedEnvironment(home, agentDir);
	// The permission gate reads its mode from the environment when it registers.
	const previousPermissionMode = process.env.OCTOBER_PERMISSION_MODE;
	if (scenario.permissionMode) process.env.OCTOBER_PERMISSION_MODE = scenario.permissionMode;
	else delete process.env.OCTOBER_PERMISSION_MODE;
	let bus: ScenarioBus | undefined;
	const compactions: Compaction[] = [];
	// Every model request in order: assistant messages and compaction summaries, which are not session messages.
	const transcript: FauxStep[] = [];
	const toolExecutions: ToolExecution[] = [];
	const errors: string[] = [];
	let turns = 0;
	try {
		if (scenario.workspaceDirectory) await cp(scenario.workspaceDirectory, workspace, { recursive: true });
		else await mkdir(workspace);
		await mkdir(agentDir, { recursive: true });

		const { modelRuntime, model, pendingSteps } = await prepareModel(scenario, options, hostAgentDir);
		if (scenario.bus) bus = await startScenarioBus(scenario.bus.tools);
		const settingsManager = SettingsManager.inMemory({
			retry: { enabled: false },
			compaction: scenario.compaction ? { enabled: true, ...scenario.compaction } : { enabled: false },
		});
		const resourceLoader = new DefaultResourceLoader({
			cwd: workspace,
			agentDir,
			settingsManager,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
			extensionFactories: scenarioExtensions(scenario, bus),
		});
		await resourceLoader.reload();
		const { session } = await createAgentSession({
			cwd: workspace,
			agentDir,
			model,
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
			if (event.type === "message_end") {
				const step = toFauxStep(event.message);
				if (step) transcript.push(step);
			}
			if (event.type === "compaction_end") {
				compactions.push({ reason: event.reason, ok: !event.aborted && event.errorMessage === undefined });
				if (event.result) transcript.push({ text: event.result.summary });
			}
		});

		const startedAt = performance.now();
		try {
			await session.prompt(scenario.prompt);
		} finally {
			unsubscribe();
		}
		const durationMs = performance.now() - startedAt;

		const pending = pendingSteps();
		if (pending) errors.push(`${pending} faux step(s) were never requested; the run ended early.`);
		const last = [...session.messages].reverse().find((message) => message.role === "assistant");
		if (last?.role === "assistant" && last.stopReason === "error") {
			errors.push(`Run ended with an error: ${last.errorMessage ?? "unknown"}`);
		}

		const checks = await evaluateChecks(scenario.expect, {
			workspace,
			toolExecutions,
			finalText: session.getLastAssistantText() ?? "",
			turns,
			compactions,
			busCalls: bus?.calls ?? [],
		});
		const stats = session.getSessionStats();
		session.dispose();
		return {
			id: scenario.id,
			mode: options.model ? "model" : "faux",
			model: `${model.provider}/${model.id}`,
			score: scoreChecks(checks),
			passed: errors.length === 0 && checks.every((check) => check.passed),
			checks,
			errors,
			transcript,
			metrics: {
				turns,
				toolCalls: toolExecutions.length,
				toolErrors: toolExecutions.filter((execution) => execution.isError).length,
				inputTokens: stats.tokens.input,
				outputTokens: stats.tokens.output,
				totalTokens: stats.tokens.total,
				costUsd: options.model && isPriced(model) ? stats.cost : null,
				durationMs: Math.round(durationMs),
			},
		};
	} finally {
		await bus?.close();
		if (previousPermissionMode === undefined) delete process.env.OCTOBER_PERMISSION_MODE;
		else process.env.OCTOBER_PERMISSION_MODE = previousPermissionMode;
		restoreEnvironment();
		await rm(root, { recursive: true, force: true });
	}
}
