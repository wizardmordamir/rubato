/**
 * Fooocus control — wire types shared by the rubato server and the chat-page
 * control panel. The server can start/stop two local Fooocus processes and
 * report their status by probing their ports:
 *   - `api` → Fooocus-API (default :8888), the JSON server rubato's art engine
 *     calls (POST /v2/generation/text-to-image).
 *   - `ui`  → the standalone Fooocus Gradio web UI (default :7865).
 *
 * "running" is decided by a live port probe (the source of truth), so an
 * instance you started by hand is reflected too. "managed" means rubato spawned
 * the process in this server session — the one case where rubato will stop it.
 * An externally-started server is left alone (rubato ignores it).
 */

export type FooocusServerId = 'api' | 'ui';

export interface FooocusServerStatus {
	id: FooocusServerId;
	/** Human label, e.g. "Fooocus API" / "Fooocus Web UI". */
	label: string;
	/** Port it listens on. */
	port: number;
	/** Base URL the panel links to and the probe hits. */
	url: string;
	/** The port answered an HTTP request — the authoritative "is it up?" signal. */
	running: boolean;
	/** rubato spawned this process this session, so rubato may stop it. */
	managed: boolean;
	/** Spawned by rubato but not yet answering (e.g. loading models) → "Starting…". */
	starting: boolean;
	/** The install dir + entry script were found, so it can be started. */
	installed: boolean;
	/** Resolved install dir (for display/tooltip), or null when not found on disk. */
	dir: string | null;
	/** Last start/stop failure or unexpected exit, surfaced to the UI. */
	error?: string;
}

export interface FooocusStatus {
	api: FooocusServerStatus;
	ui: FooocusServerStatus;
}

/** Badge tone vocabulary (mirrors the UI Badge component's tones). */
export type FooocusTone = 'neutral' | 'accent' | 'success' | 'warn' | 'error';

/** Presentational view of one server's status — pure, so it's unit-testable. */
export interface FooocusServerView {
	tone: FooocusTone;
	/** Short status label for the badge. */
	text: string;
	/** Whether the toggle should be interactive (can act on the current state). */
	toggleEnabled: boolean;
	/** When the toggle is disabled, why — shown as a tooltip. Empty when enabled. */
	reason: string;
}

/**
 * Derive the badge tone + toggle affordance for a server's status. The toggle is
 * actionable only when the action makes sense:
 *  - stopped + installed → can start.
 *  - running + managed-by-rubato → can stop.
 * It is disabled (with a reason) while starting, when not installed (can't
 * start), or when running but external (rubato won't stop what it didn't start).
 */
export function fooocusServerView(s: FooocusServerStatus): FooocusServerView {
	if (s.starting) {
		return { tone: 'warn', text: 'Starting…', toggleEnabled: false, reason: 'Booting — can take a minute while models load.' };
	}
	if (s.running && s.managed) {
		return { tone: 'success', text: 'Running', toggleEnabled: true, reason: '' };
	}
	if (s.running) {
		return {
			tone: 'accent',
			text: 'Running · external',
			toggleEnabled: false,
			reason: 'Started outside rubato — stop it where you launched it.',
		};
	}
	if (!s.installed) {
		return {
			tone: 'error',
			text: 'Not installed',
			toggleEnabled: false,
			reason: `Couldn't find Fooocus on disk. Set fooocus.${s.id}.dir in ~/.rubato/config.json.`,
		};
	}
	return { tone: 'neutral', text: 'Stopped', toggleEnabled: true, reason: '' };
}
