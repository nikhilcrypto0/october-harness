/**
 * Canonical portable-session fixture shared by the codec, SDK, RPC, and CLI tests (#2).
 */

import type { AssistantMessage, ImageContent, ToolResultMessage, Usage } from "@earendil-works/pi-ai";
import type { SessionManager } from "../../src/core/session-manager.ts";

export const FIXTURE_IMAGE: ImageContent = {
	type: "image",
	mimeType: "image/png",
	data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
};

/** Values that must never appear in a portable export of the fixture. */
export const FIXTURE_SECRETS = {
	detailsApiKey: "sk-details-secret-123",
	errorSecret: "sk-error-secret-456",
	noteSecret: "sk-note-secret-789",
	errorPath: "/home/alice/.october/agent/auth.json",
	notePath: "/home/alice/usage-notes.txt",
	extensionPath: "/home/alice/extension-state.json",
	systemPromptPath: "/home/alice/source-system-prompt.md",
	signatures: ["text-sig-user", "text-sig-assistant", "thinking-sig", "thought-sig", "redacted-payload", "edit-sig"],
} as const;

/** Transcript content that must survive export unchanged, including a path the user typed. */
export const FIXTURE_TRANSCRIPT_PATH = "/home/alice/project/src/app.ts";

export interface PortableFixtureModel {
	api: string;
	provider: string;
	model: string;
}

export interface PortableFixture {
	/** Source-machine path written into the bash execution and the bash tool result text. */
	fullOutputPath: string;
	ids: {
		system: string;
		user: string;
		assistant: string;
		toolResult: string;
		compaction: string;
		errorAssistant: string;
		bashExecution: string;
		bashToolResult: string;
		retainNoneSystem: string;
		retainNoneCompaction: string;
		attachmentUser: string;
		editedAssistant: string;
		customMessage: string;
		contextEdit: string;
		custom: string;
		usage: string;
		deferred: string;
		abandoned: string[];
		branchSummary: string;
		userLabel: string;
		droppedLabel: string;
	};
}

function usage(total = 3): Usage {
	return {
		input: 1,
		output: 2,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: total,
		cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
	};
}

function assistant(model: PortableFixtureModel, fields: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: model.api,
		provider: model.provider,
		model: model.model,
		usage: usage(),
		stopReason: "stop",
		timestamp: Date.now(),
		...fields,
	};
}

function toolResult(fields: Partial<ToolResultMessage> & Pick<ToolResultMessage, "toolCallId" | "toolName">) {
	return {
		role: "toolResult",
		content: [],
		isError: false,
		timestamp: Date.now(),
		...fields,
	} as ToolResultMessage;
}

/**
 * Append every entry kind the portable contract covers, including the excluded ones, to an empty
 * session. The active leaf ends on the last kept entry and is not the last stored entry.
 */
export function buildPortableFixture(
	sm: SessionManager,
	fullOutputPath: string,
	model: PortableFixtureModel = { api: "faux-api", provider: "faux-provider", model: "faux-model" },
): PortableFixture {
	const system = sm.appendMessage({
		role: "system",
		content: `Source prompt loaded from ${FIXTURE_SECRETS.systemPromptPath}`,
		timestamp: Date.now(),
	});
	sm.appendModelChange(model.provider, model.model);
	sm.appendThinkingLevelChange("high");

	const user = sm.appendMessage({
		role: "user",
		content: [
			{ type: "text", text: `Please review ${FIXTURE_TRANSCRIPT_PATH}`, textSignature: "text-sig-user" },
			FIXTURE_IMAGE,
		],
		timestamp: Date.now(),
	});
	const assistantEntry = sm.appendMessage(
		assistant(model, {
			content: [
				{ type: "text", text: "Reading the file.", textSignature: "text-sig-assistant" },
				{ type: "thinking", thinking: "I should read it.", thinkingSignature: "thinking-sig" },
				{ type: "thinking", thinking: "", thinkingSignature: "redacted-payload", redacted: true },
				{
					type: "toolCall",
					id: "call-read",
					name: "read",
					arguments: { path: FIXTURE_TRANSCRIPT_PATH },
					thoughtSignature: "thought-sig",
				},
			],
			responseId: "resp-123",
			diagnostics: [{ type: "retry", timestamp: Date.now() }],
			stopReason: "toolUse",
		}),
	);
	const toolResultEntry = sm.appendMessage(
		toolResult({
			toolCallId: "call-read",
			toolName: "read",
			content: [{ type: "text", text: "export const app = 1;" }, FIXTURE_IMAGE],
			details: { fullOutputPath, apiKey: FIXTURE_SECRETS.detailsApiKey },
		}),
	);
	const compaction = sm.appendCompaction(
		"Reviewed app.ts.",
		user,
		1234,
		{ readFiles: [FIXTURE_TRANSCRIPT_PATH] },
		false,
		usage(),
	);

	const errorAssistant = sm.appendMessage(
		assistant(model, {
			stopReason: "error",
			errorMessage: `401 invalid key ${FIXTURE_SECRETS.errorSecret} from ${FIXTURE_SECRETS.errorPath}`,
			rawStopReason: "provider_auth_failure",
		}),
	);
	const bashExecution = sm.appendMessage({
		role: "bashExecution",
		command: "cat build.log",
		output: "line 1\nline 2",
		exitCode: 0,
		cancelled: false,
		truncated: true,
		fullOutputPath,
		timestamp: Date.now(),
	});
	sm.appendMessage(
		assistant(model, {
			content: [{ type: "toolCall", id: "call-bash", name: "bash", arguments: { command: "cat build.log" } }],
			stopReason: "toolUse",
		}),
	);
	const bashToolResult = sm.appendMessage(
		toolResult({
			toolCallId: "call-bash",
			toolName: "bash",
			content: [{ type: "text", text: `line 1\n\n[Showing lines 1-1. Full output: ${fullOutputPath}]` }],
		}),
	);

	// A system entry directly before a compaction that keeps it: no later kept entry exists.
	const retainNoneSystem = sm.appendMessage({
		role: "system",
		content: "Mid-session instructions",
		timestamp: Date.now(),
	});
	const retainNoneCompaction = sm.appendCompaction("Built the project.", retainNoneSystem, 2345);

	const attachmentUser = sm.appendMessage({
		role: "user",
		content: [{ type: "text", text: "Here is a screenshot." }, FIXTURE_IMAGE],
		timestamp: Date.now(),
	});
	const editedAssistant = sm.appendMessage(
		assistant(model, {
			content: [
				{ type: "text", text: "Original answer." },
				{ type: "thinking", thinking: "Original reasoning.", thinkingSignature: "thinking-sig" },
			],
		}),
	);
	const customMessage = sm.appendCustomMessageEntry("review-note", [{ type: "text", text: "Extension note." }], true, {
		file: FIXTURE_SECRETS.extensionPath,
	});
	const custom = sm.appendCustomEntry("review-state", { file: FIXTURE_SECRETS.extensionPath });
	const contextEdit = sm.appendContextEdit(editedAssistant, {
		content: [
			{ type: "text", text: "Edited answer." },
			{ type: "thinking", thinking: "Edited reasoning.", thinkingSignature: "edit-sig" },
			{ type: "thinking", thinking: "", thinkingSignature: "redacted-payload", redacted: true },
		],
	});
	const usageEntry = sm.appendUsage(
		"cache_warm",
		model.provider,
		model.model,
		usage(),
		`warmed with ${FIXTURE_SECRETS.noteSecret} from ${FIXTURE_SECRETS.notePath}`,
	);
	const deferred = sm.appendMessage(
		assistant(model, {
			stopReason: "deferred",
			deferred: { provider: model.provider, modelId: model.model, api: model.api, id: "batch-1" },
		}),
	);

	const beforeAbandoned = sm.getLeafId()!;
	const abandoned = [
		sm.appendMessage({ role: "user", content: "Try another approach", timestamp: Date.now() }),
		sm.appendMessage(assistant(model, { content: [{ type: "text", text: "Abandoned reply." }] })),
	];
	const branchSummary = sm.branchWithSummary(beforeAbandoned, "Tried another approach and dropped it.");

	sm.appendSessionInfo("Portable fixture");
	const userLabel = sm.appendLabelChange(user, "start");
	const droppedLabel = sm.appendLabelChange(system, "system prompt");

	return {
		fullOutputPath,
		ids: {
			system,
			user,
			assistant: assistantEntry,
			toolResult: toolResultEntry,
			compaction,
			errorAssistant,
			bashExecution,
			bashToolResult,
			retainNoneSystem,
			retainNoneCompaction,
			attachmentUser,
			editedAssistant,
			customMessage,
			contextEdit,
			custom,
			usage: usageEntry.id,
			deferred,
			abandoned,
			branchSummary,
			userLabel,
			droppedLabel,
		},
	};
}
