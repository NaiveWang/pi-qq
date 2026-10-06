/** Shared mock types (kept separate so mock.ts and qq.test.ts don't cycle). */

export interface MockEntry {
	id: string;
	type: string; // "message" | "custom" | ...
	parentId: string | null;
	message?: { role: string; content: unknown };
}

export class MockSession {
	entries = new Map<string, MockEntry>();
	leafId: string | null = null;
	sessionId = "session-1";
	private n = 0;

	// SessionManager method surface (the extension calls these):
	getLeafId(): string | null {
		return this.leafId;
	}
	getSessionId(): string {
		return this.sessionId;
	}
	getBranch(leafId?: string): MockEntry[] {
		return this.branch(leafId);
	}

	add(type: string, message?: { role: string; content: unknown }, parentId?: string): MockEntry {
		const parent = parentId !== undefined ? parentId : this.leafId;
		const e: MockEntry = { id: `e${++this.n}`, type, parentId: parent, message };
		this.entries.set(e.id, e);
		this.leafId = e.id;
		return e;
	}

	/** Entries from the root to the given leaf (default: current leaf). */
	branch(leafId?: string): MockEntry[] {
		let cur = leafId ?? this.leafId;
		const out: MockEntry[] = [];
		while (cur && this.entries.has(cur)) {
			out.unshift(this.entries.get(cur)!);
			cur = this.entries.get(cur)!.parentId;
		}
		return out;
	}

	/** A small main conversation so a branch point exists. */
	seed(): void {
		this.add("message", { role: "user", content: "main question" });
		this.add("message", { role: "assistant", content: [{ type: "text", text: "main answer" }] });
	}

	/** Find the entry whose user text starts with a prefix (side messages are "qq: ..."). */
	findUserEntry(prefix: string): MockEntry | undefined {
		return this.branch().find(
			(e) => e.type === "message" && e.message?.role === "user" && typeof e.message.content === "string" && (e.message.content as string).startsWith(prefix),
		);
	}
}

export class MockCtx {
	/** Mirrors pi's ExtensionCommandContext.sessionManager. */
	sessionManager: MockSession;
	idle = true;
	notifs: { message: string; level?: string }[] = [];
	statuses: { key: string; status: string | undefined }[] = [];
	terminal = new Set<(data: string) => { consume?: boolean } | undefined>();
	navigatedTo: string[] = [];
	model = { id: "mock-model", provider: "mock" };
	contextUsage: { tokens: number | null; contextWindow: number } | null = null;
	/** Autocomplete wrapper factories passed to ui.addAutocompleteProvider. */
	autocompleteFactories: Array<(current: unknown) => unknown> = [];
	/** setEditorComponent calls, in order (last = current; undefined = default). */
	editorComponents: Array<unknown> = [];
	get editorComponent(): unknown {
		return this.editorComponents[this.editorComponents.length - 1] ?? undefined;
	}

	constructor(session: MockSession) {
		this.sessionManager = session;
	}

	isIdle(): boolean {
		return this.idle;
	}

	/** Mirrors pi's guard: refuse to navigate while a run/compaction is active. */
	async navigateTree(leafId: string): Promise<void> {
		if (!this.sessionManager.entries.has(leafId)) throw new Error(`navigateTree: no such leaf ${leafId}`);
		if (!this.idle) throw new Error("navigateTree: session busy");
		this.sessionManager.leafId = leafId;
		this.navigatedTo.push(leafId);
	}

	getContextUsage(): { tokens: number | null; contextWindow: number } {
		return this.contextUsage ?? { tokens: null, contextWindow: 0 };
	}

	ui = {
		addAutocompleteProvider: (factory: (current: unknown) => unknown) => {
			this.autocompleteFactories.push(factory);
		},
		setEditorComponent: (factory: unknown) => {
			this.editorComponents.push(factory);
		},
		notify: (message: string, level?: string) => {
			this.notifs.push({ message, level });
		},
		setStatus: (key: string, status: string | undefined) => {
			this.statuses.push({ key, status });
		},
		onTerminalInput: (handler: (data: string) => { consume?: boolean } | undefined): (() => void) => {
			this.terminal.add(handler);
			return () => {
				this.terminal.delete(handler);
			};
		},
	};

	/** Simulate a physical keypress while PENDING; returns the handler results. */
	press(data: string): ({ consume?: boolean } | undefined)[] {
		const handlers = [...this.terminal];
		if (handlers.length === 0) throw new Error("press() but no terminal handler active (not PENDING)");
		return handlers.map((h) => h(data));
	}

	/** Find a notification whose message matches. */
	notifyOf(pred: (m: string) => boolean): { message: string; level?: string } | undefined {
		return this.notifs.find((n) => pred(n.message));
	}
}
