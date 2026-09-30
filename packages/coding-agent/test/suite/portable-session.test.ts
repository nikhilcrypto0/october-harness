import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Message, TranscriptContext } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs } from "../../src/cli/args.ts";
import {
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../../src/core/agent-session-runtime.ts";
import { COMPACTION_SUMMARY_PREFIX } from "../../src/core/messages.ts";
import { SessionManager } from "../../src/core/session-manager.ts";
import {
	importPortableSession,
	PortableSessionError,
	SessionImportError,
	SessionImportIdConflictError,
	serializePortableSession,
} from "../../src/core/session-portable.ts";
import { SettingsManager } from "../../src/core/settings-manager.ts";
import type { ExtensionAPI, ExtensionFactory, SessionBeforeSwitchEvent, SessionStartEvent } from "../../src/index.ts";
import { createSessionManager } from "../../src/main.ts";
import { buildPortableFixture, FIXTURE_IMAGE } from "../fixtures/portable-session-fixture.ts";
import { createHarness, getMessageText, type Harness } from "./harness.ts";

const cleanups: Array<() => Promise<void> | void> = [];

afterEach(async () => {
	while (cleanups.length > 0) {
		await cleanups.pop()?.();
	}
});

function createTempDir(prefix: string): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
	cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

/** Export the canonical fixture from a source "machine" and return the portable file path. */
function writePortableFixture(): { path: string; sessionId: string; jsonl: string } {
	const source = SessionManager.inMemory(createTempDir("pi-portable-suite-source-"));
	buildPortableFixture(source, join(createTempDir("pi-portable-suite-bash-"), "bash.log"));
	const { jsonl } = serializePortableSession(source);
	const path = join(createTempDir("pi-portable-suite-file-"), "portable.jsonl");
	writeFileSync(path, jsonl);
	return { path, sessionId: source.getSessionId(), jsonl };
}

function listFiles(dir: string): string[] {
	try {
		return readdirSync(dir).sort();
	} catch {
		return [];
	}
}

describe("portable sessions in a running session", () => {
	// Regression test for #2.
	it("continues an imported session from the exported leaf with destination prompt and tools", async () => {
		const portable = writePortableFixture();
		const destinationCwd = createTempDir("pi-portable-suite-dest-");
		const sessionDir = join(destinationCwd, "sessions");
		const importedPath = importPortableSession(portable.path, { cwd: destinationCwd, sessionDir });
		const sessionManager = SessionManager.open(importedPath, sessionDir);
		const importedLeaf = sessionManager.getLeafId();

		const harness: Harness = await createHarness({ sessionManager });
		cleanups.push(() => harness.cleanup());
		let request: TranscriptContext | undefined;
		harness.setResponses([
			(context) => {
				request = context;
				return fauxAssistantMessage("continued");
			},
		]);

		await harness.session.prompt("continue please");

		const messages: Message[] = request!.messages;
		// The imported transcript carries no system state, so the destination declares its own
		// prompt sections and tools in one system message right before the new prompt.
		const systemMessages = messages.filter((message) => message.role === "system");
		expect(systemMessages).toHaveLength(1);
		const declared = messages.at(-2);
		if (declared?.role !== "system") throw new Error("expected the destination to declare its system prompt");
		expect(Object.keys(declared.sections ?? {}).length).toBeGreaterThan(0);
		expect(declared.toolsAdded?.map((tool) => tool.name)).toEqual(harness.session.getActiveToolNames());

		const texts = messages.map((message) => getMessageText(message));
		expect(texts).toContain(`${COMPACTION_SUMMARY_PREFIX}Built the project.\n</summary>`);
		expect(texts).toContain("Edited answer.");
		expect(texts).not.toContain("Original answer.");
		const attachment = messages.find((message) => getMessageText(message) === "Here is a screenshot.");
		expect(attachment?.content).toEqual([{ type: "text", text: "Here is a screenshot." }, FIXTURE_IMAGE]);
		expect(texts.at(-1)).toBe("continue please");

		const reopened = SessionManager.open(importedPath, sessionDir);
		const appended = reopened.getEntries().slice(portable.jsonl.trim().split("\n").length - 1);
		expect(appended[0]?.parentId).toBe(importedLeaf);
		expect(appended.map((entry) => (entry.type === "message" ? entry.message.role : entry.type))).toEqual([
			"system",
			"user",
			"assistant",
		]);
		expect(reopened.getSessionId()).toBe(portable.sessionId);
	});
});

describe("AgentSessionRuntime portable import", () => {
	async function createRuntimeForTest(extensionFactory: ExtensionFactory = () => {}, options = { persisted: true }) {
		const tempDir = createTempDir("pi-portable-runtime-");
		const sessionDir = join(tempDir, "sessions");
		const faux = registerFauxProvider();
		faux.setResponses([fauxAssistantMessage("one")]);
		cleanups.push(() => faux.unregister());

		const createRuntime: CreateAgentSessionRuntimeFactory = async ({ cwd, sessionManager, sessionStartEvent }) => {
			const services = await createAgentSessionServices({
				cwd,
				agentDir: tempDir,
				resourceLoaderOptions: {
					extensionFactories: [
						(pi: ExtensionAPI) => {
							pi.registerProvider(faux.getModel().provider, {
								baseUrl: faux.getModel().baseUrl,
								apiKey: "faux-key",
								api: faux.api,
								models: faux.models.map((model) => ({
									id: model.id,
									name: model.name,
									api: model.api,
									reasoning: model.reasoning,
									input: model.input,
									cost: model.cost,
									contextWindow: model.contextWindow,
									maxTokens: model.maxTokens,
								})),
							});
							extensionFactory(pi);
						},
					],
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
				},
			});
			return {
				...(await createAgentSessionFromServices({
					services,
					sessionManager,
					sessionStartEvent,
					model: faux.getModel(),
				})),
				services,
				diagnostics: services.diagnostics,
			};
		};
		const runtime = await createAgentSessionRuntime(createRuntime, {
			cwd: tempDir,
			agentDir: tempDir,
			sessionManager: options.persisted
				? SessionManager.create(tempDir, sessionDir)
				: SessionManager.inMemory(tempDir),
		});
		await runtime.session.bindExtensions({});
		cleanups.push(() => runtime.dispose());
		await runtime.session.prompt("hello");
		return { runtime, tempDir, sessionDir };
	}

	// Regression test for #2.
	it("switches to the imported session in the runtime cwd", async () => {
		const events: Array<SessionBeforeSwitchEvent | SessionStartEvent> = [];
		const { runtime, tempDir, sessionDir } = await createRuntimeForTest((pi: ExtensionAPI) => {
			pi.on("session_before_switch", (event) => void events.push(event));
			pi.on("session_start", (event) => void events.push(event));
		});
		const previousSessionFile = runtime.session.sessionFile;
		const portable = writePortableFixture();
		events.length = 0;

		const result = await runtime.importPortable(portable.path);
		await runtime.session.bindExtensions({});

		expect(result).toEqual({ cancelled: false });
		const imported = runtime.session.sessionManager;
		expect(runtime.cwd).toBe(tempDir);
		expect(imported.getCwd()).toBe(tempDir);
		expect(imported.getSessionId()).toBe(portable.sessionId);
		expect(runtime.session.sessionFile).toMatch(new RegExp(`^${sessionDir}/.+_${portable.sessionId}\\.jsonl$`));
		expect(JSON.parse(readFileSync(runtime.session.sessionFile!, "utf8").split("\n")[0])).toMatchObject({
			id: portable.sessionId,
			cwd: tempDir,
		});
		expect(events).toEqual([
			{ type: "session_before_switch", reason: "resume", targetSessionFile: runtime.session.sessionFile },
			{ type: "session_start", reason: "resume", previousSessionFile },
		]);
	});

	// Regression test for #2.
	it("writes nothing and keeps the session when the switch is cancelled, the file is invalid, or the id exists", async () => {
		let cancel = false;
		const { runtime, sessionDir } = await createRuntimeForTest((pi: ExtensionAPI) => {
			pi.on("session_before_switch", () => (cancel ? { cancel: true } : undefined));
		});
		const originalSession = runtime.session;
		const filesBefore = listFiles(sessionDir);
		const portable = writePortableFixture();

		cancel = true;
		expect(await runtime.importPortable(portable.path)).toEqual({ cancelled: true });
		expect(runtime.session).toBe(originalSession);
		expect(listFiles(sessionDir)).toEqual(filesBefore);
		cancel = false;

		const invalidPath = join(createTempDir("pi-portable-invalid-"), "invalid.jsonl");
		writeFileSync(invalidPath, portable.jsonl.replace('"portable":1,', '"portable":1,"cwd":"/home/alice",'));
		await expect(runtime.importPortable(invalidPath)).rejects.toThrow(PortableSessionError);
		expect(runtime.session).toBe(originalSession);
		expect(listFiles(sessionDir)).toEqual(filesBefore);

		await runtime.importPortable(portable.path);
		const importedSession = runtime.session;
		const filesAfterImport = listFiles(sessionDir);
		await expect(runtime.importPortable(portable.path)).rejects.toThrow(SessionImportIdConflictError);
		expect(runtime.session).toBe(importedSession);
		expect(listFiles(sessionDir)).toEqual(filesAfterImport);
	});

	// Regression test for #2.
	it("keeps native /import behavior and routes marked files to the portable importer", async () => {
		const { runtime, tempDir, sessionDir } = await createRuntimeForTest();
		const nativeDir = createTempDir("pi-portable-native-");
		const nativePath = join(nativeDir, "native.jsonl");
		const nativeContent = `${JSON.stringify({
			type: "session",
			version: 3,
			id: "native-session",
			timestamp: new Date().toISOString(),
			cwd: nativeDir,
		})}\n`;
		writeFileSync(nativePath, nativeContent);

		const portableError = await runtime.importPortable(nativePath).catch((error: unknown) => error);
		expect(portableError).toBeInstanceOf(PortableSessionError);
		expect((portableError as PortableSessionError).code).toBe("not_portable");

		await runtime.importFromJsonl(nativePath);
		expect(runtime.session.sessionFile).toBe(join(sessionDir, "native.jsonl"));
		// Copied verbatim; runtime creation then appends the restored model and thinking level.
		expect(readFileSync(runtime.session.sessionFile!, "utf8").startsWith(nativeContent)).toBe(true);
		expect(runtime.cwd).toBe(nativeDir);

		const portable = writePortableFixture();
		await runtime.importFromJsonl(portable.path, tempDir);
		expect(runtime.session.sessionManager.getSessionId()).toBe(portable.sessionId);
		// Portable files take the runtime cwd; the native cwd override does not apply.
		expect(runtime.session.sessionManager.getCwd()).toBe(nativeDir);
		expect(runtime.session.sessionFile).toMatch(new RegExp(`_${portable.sessionId}\\.jsonl$`));
	});

	// Regression test for #2.
	it("rejects import before switching when session persistence is disabled", async () => {
		const { runtime } = await createRuntimeForTest(undefined, { persisted: false });
		const originalSession = runtime.session;
		const error = await runtime.importPortable(writePortableFixture().path).catch((caught: unknown) => caught);
		expect(error).toBeInstanceOf(SessionImportError);
		expect((error as Error).message).toBe("Cannot import a session while session persistence is disabled");
		expect(runtime.session).toBe(originalSession);
	});
});

describe("same-machine sessions across entry points", () => {
	// Regression test for #2.
	it("opens an SDK-persisted session by id through the CLI session resolver", async () => {
		const cwd = createTempDir("pi-portable-same-machine-");
		const sessionDir = join(cwd, "sessions");
		mkdirSync(sessionDir);
		const harness = await createHarness({ sessionManager: SessionManager.create(cwd, sessionDir) });
		cleanups.push(() => harness.cleanup());
		harness.setResponses([fauxAssistantMessage("persisted")]);
		await harness.session.prompt("persist me");

		const sessionId = harness.sessionManager.getSessionId();
		const opened = await createSessionManager(
			parseArgs(["--session", sessionId]),
			cwd,
			sessionDir,
			SettingsManager.inMemory(),
		);

		expect(opened.getSessionFile()).toBe(harness.sessionManager.getSessionFile());
		expect(opened.getSessionId()).toBe(sessionId);
		expect(opened.getEntries()).toEqual(harness.sessionManager.getEntries());
		expect(opened.getLeafId()).toBe(harness.sessionManager.getLeafId());
	});
});
