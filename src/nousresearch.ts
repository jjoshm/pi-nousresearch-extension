import {
	createAssistantMessageEventStream,
	type Api,
	type AssistantMessageEventStream,
	type Context,
	type Model,
	type OAuthCredentials,
	type OAuthLoginCallbacks,
	type SimpleStreamOptions,
	streamSimpleOpenAICompletions,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type NousPortalModel = {
	id: string;
	name?: string;
	context_length?: number;
	architecture?: {
		input_modalities?: string[];
		output_modalities?: string[];
	};
	pricing?: {
		prompt?: string | number;
		completion?: string | number;
		input_cache_read?: string | number;
		input_cache_write?: string | number;
	};
	supported_parameters?: string[];
	top_provider?: {
		context_length?: number;
		max_completion_tokens?: number | null;
	};
};

type NousAuthState = {
	access_token: string;
	refresh_token: string;
	client_id: string;
	portal_base_url: string;
	inference_base_url: string;
	token_type: string;
	scope: string;
	obtained_at: string;
	expires_at: string;
	expires_in?: number;
	agent_key?: string | null;
	agent_key_id?: string | null;
	agent_key_expires_at?: string | null;
	agent_key_expires_in?: number | null;
	agent_key_reused?: boolean | null;
	agent_key_obtained_at?: string | null;
};

type NousOAuthCredentials = OAuthCredentials & {
	nous_state?: NousAuthState;
};

const PROVIDER = "nousresearch";
const PROVIDER_NAME = "Nous Research";
const OAUTH_NAME = "Nous Portal Subscription";
const PORTAL_URL = "https://portal.nousresearch.com";
const BASE_URL = "https://inference-api.nousresearch.com/v1";
const CUSTOM_API = "nous-openai-completions" as Api;

const CLIENT_ID = "hermes-cli";
const SCOPE = "inference:mint_agent_key";

const DEFAULT_CONTEXT_WINDOW = 128000;
const DEFAULT_MAX_TOKENS = 32000;
const ACCESS_TOKEN_REFRESH_SKEW_SECONDS = 120;
const MIN_AGENT_KEY_TTL_SECONDS = 30 * 60;

function parseIso(value?: string | null): number {
	if (!value) return 0;
	const millis = Date.parse(value);
	return Number.isFinite(millis) ? millis : 0;
}

function isExpiring(iso?: string | null, skewSeconds = 0): boolean {
	const expiresAt = parseIso(iso);
	if (!expiresAt) return true;
	return expiresAt - skewSeconds * 1000 <= Date.now();
}

function coerceTtlSeconds(value: unknown, fallback = 3600): number {
	const ttl = Number(value);
	if (!Number.isFinite(ttl) || ttl <= 0) return fallback;
	return Math.max(1, Math.floor(ttl));
}

function parsePerMillion(raw?: string | number): number {
	const value = Number(raw ?? 0);
	if (!Number.isFinite(value) || value < 0) return 0;
	return Math.round(value * 1_000_000 * 1000) / 1000;
}

function isSupportedTextModel(model: NousPortalModel): boolean {
	const input = new Set(model.architecture?.input_modalities ?? ["text"]);
	const output = new Set(model.architecture?.output_modalities ?? ["text"]);
	return input.has("text") && output.has("text");
}

function normalizeInput(model: NousPortalModel): ("text" | "image")[] {
	const modalities = new Set(model.architecture?.input_modalities ?? ["text"]);
	return modalities.has("image") ? ["text", "image"] : ["text"];
}

function numberOrDefault(value: unknown, fallback: number): number {
	const n = Number(value);
	return Number.isFinite(n) && n > 0 ? n : fallback;
}

function toPiModel(model: NousPortalModel) {
	const supported = new Set(model.supported_parameters ?? []);
	const contextWindow = numberOrDefault(
		model.top_provider?.context_length ?? model.context_length,
		DEFAULT_CONTEXT_WINDOW,
	);
	const maxTokens = numberOrDefault(model.top_provider?.max_completion_tokens, DEFAULT_MAX_TOKENS);
	const maxTokensField = supported.has("max_completion_tokens") ? "max_completion_tokens" : "max_tokens";

	return {
		id: model.id,
		name: model.name ?? model.id,
		reasoning:
			supported.has("reasoning") ||
			supported.has("include_reasoning") ||
			supported.has("reasoning_effort"),
		input: normalizeInput(model),
		cost: {
			input: parsePerMillion(model.pricing?.prompt),
			output: parsePerMillion(model.pricing?.completion),
			cacheRead: parsePerMillion(model.pricing?.input_cache_read),
			cacheWrite: parsePerMillion(model.pricing?.input_cache_write),
		},
		contextWindow,
		maxTokens,
		compat: {
			supportsDeveloperRole: false,
			supportsReasoningEffort: false,
			supportsUsageInStreaming: false,
			maxTokensField,
		},
	};
}

function agentKeyUsable(state: NousAuthState, minTtlSeconds: number): boolean {
	return !!state.agent_key && !isExpiring(state.agent_key_expires_at, minTtlSeconds);
}

function credentialsToState(credentials: OAuthCredentials): NousAuthState {
	const state = (credentials as NousOAuthCredentials).nous_state;
	if (!state) {
		throw new Error("Nous OAuth state missing. Please run /login nousresearch again.");
	}
	return state;
}

function stateToCredentials(state: NousAuthState): OAuthCredentials {
	const expiresFromAgentKey = parseIso(state.agent_key_expires_at);
	const expiresFromOauthToken = parseIso(state.expires_at);
	const expires = Math.min(
		expiresFromAgentKey || Number.MAX_SAFE_INTEGER,
		expiresFromOauthToken || Number.MAX_SAFE_INTEGER,
	);

	if (!state.agent_key || !Number.isFinite(expires) || expires <= 0) {
		throw new Error("Nous OAuth session is missing a usable agent key.");
	}

	const payload: NousOAuthCredentials = {
		refresh: state.refresh_token,
		access: state.agent_key,
		expires,
		nous_state: state,
	};
	return payload;
}

async function requestDeviceCode(
	portalBaseUrl: string,
	clientId: string,
	scope: string,
): Promise<{
	device_code: string;
	user_code: string;
	verification_uri: string;
	verification_uri_complete: string;
	expires_in: number;
	interval: number;
}> {
	const response = await fetch(`${portalBaseUrl}/api/oauth/device/code`, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
		body: new URLSearchParams({ client_id: clientId, scope }).toString(),
	});
	if (!response.ok) {
		throw new Error(`Nous device-code request failed: ${response.status} ${await response.text()}`);
	}

	const data = (await response.json()) as {
		device_code?: string;
		user_code?: string;
		verification_uri?: string;
		verification_uri_complete?: string;
		expires_in?: number;
		interval?: number;
	};

	if (
		!data.device_code ||
		!data.user_code ||
		!data.verification_uri ||
		!data.verification_uri_complete ||
		!data.expires_in ||
		!data.interval
	) {
		throw new Error("Nous device-code response was missing required fields");
	}

	return {
		device_code: data.device_code,
		user_code: data.user_code,
		verification_uri: data.verification_uri,
		verification_uri_complete: data.verification_uri_complete,
		expires_in: data.expires_in,
		interval: data.interval,
	};
}

async function pollForToken(
	portalBaseUrl: string,
	clientId: string,
	deviceCode: string,
	expiresIn: number,
	interval: number,
	signal?: AbortSignal,
): Promise<{
	access_token: string;
	refresh_token?: string;
	token_type?: string;
	scope?: string;
	expires_in?: number;
	inference_base_url?: string;
}> {
	const deadline = Date.now() + Math.max(1, expiresIn) * 1000;
	let currentIntervalMs = Math.max(1000, interval * 1000);

	while (Date.now() < deadline) {
		if (signal?.aborted) throw new Error("Nous login cancelled");

		const response = await fetch(`${portalBaseUrl}/api/oauth/token`, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
			body: new URLSearchParams({
				grant_type: "urn:ietf:params:oauth:grant-type:device_code",
				client_id: clientId,
				device_code: deviceCode,
			}).toString(),
			signal,
		});

		if (response.ok) {
			const payload = (await response.json()) as {
				access_token?: string;
				refresh_token?: string;
				token_type?: string;
				scope?: string;
				expires_in?: number;
				inference_base_url?: string;
			};
			if (!payload.access_token) throw new Error("Nous token response was missing access_token");
			return payload as {
				access_token: string;
				refresh_token?: string;
				token_type?: string;
				scope?: string;
				expires_in?: number;
				inference_base_url?: string;
			};
		}

		const errorPayload = (await response.json().catch(() => ({}))) as {
			error?: string;
			error_description?: string;
		};

		if (errorPayload.error === "authorization_pending" || errorPayload.error === "slow_down") {
			if (errorPayload.error === "slow_down") {
				currentIntervalMs = Math.min(currentIntervalMs + 1000, 30000);
			}
			await new Promise<void>((resolve, reject) => {
				const timeout = setTimeout(resolve, currentIntervalMs);
				signal?.addEventListener(
					"abort",
					() => {
						clearTimeout(timeout);
						reject(new Error("Nous login cancelled"));
					},
					{ once: true },
				);
			});
			continue;
		}

		throw new Error(errorPayload.error_description || errorPayload.error || `Nous token polling failed: ${response.status}`);
	}

	throw new Error("Timed out waiting for Nous device approval");
}

async function refreshAccessToken(state: NousAuthState): Promise<NousAuthState> {
	const response = await fetch(`${state.portal_base_url}/api/oauth/token`, {
		method: "POST",
		headers: {
			"Content-Type": "application/x-www-form-urlencoded",
			Accept: "application/json",
			"x-nous-refresh-token": state.refresh_token,
		},
		body: new URLSearchParams({
			grant_type: "refresh_token",
			client_id: state.client_id,
		}).toString(),
	});

	if (!response.ok) {
		const errorPayload = (await response.json().catch(() => ({}))) as { error?: string; error_description?: string };
		throw new Error(errorPayload.error_description || errorPayload.error || `Nous refresh failed: ${response.status}`);
	}

	const payload = (await response.json()) as {
		access_token?: string;
		refresh_token?: string;
		token_type?: string;
		scope?: string;
		expires_in?: number;
		inference_base_url?: string;
	};
	if (!payload.access_token) throw new Error("Nous refresh response was missing access_token");

	const now = new Date();
	const ttl = coerceTtlSeconds(payload.expires_in);
	return {
		...state,
		access_token: payload.access_token,
		refresh_token: payload.refresh_token || state.refresh_token,
		token_type: payload.token_type || state.token_type || "Bearer",
		scope: payload.scope || state.scope,
		inference_base_url: payload.inference_base_url?.trim() || state.inference_base_url,
		obtained_at: now.toISOString(),
		expires_in: ttl,
		expires_at: new Date(now.getTime() + ttl * 1000).toISOString(),
	};
}

async function mintAgentKey(state: NousAuthState, minTtlSeconds = MIN_AGENT_KEY_TTL_SECONDS): Promise<NousAuthState> {
	const response = await fetch(`${state.portal_base_url}/api/oauth/agent-key`, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${state.access_token}`,
			"Content-Type": "application/json",
			Accept: "application/json",
		},
		body: JSON.stringify({ min_ttl_seconds: Math.max(60, minTtlSeconds) }),
	});

	if (!response.ok) {
		const errorPayload = (await response.json().catch(() => ({}))) as { error?: string; error_description?: string };
		throw new Error(errorPayload.error_description || errorPayload.error || `Nous agent-key mint failed: ${response.status}`);
	}

	const payload = (await response.json()) as {
		api_key?: string;
		key_id?: string;
		expires_at?: string;
		expires_in?: number;
		reused?: boolean;
		inference_base_url?: string;
	};
	if (!payload.api_key) throw new Error("Nous agent-key response was missing api_key");

	return {
		...state,
		inference_base_url: payload.inference_base_url?.trim() || state.inference_base_url,
		agent_key: payload.api_key,
		agent_key_id: payload.key_id || null,
		agent_key_expires_at: payload.expires_at || null,
		agent_key_expires_in: payload.expires_in ?? null,
		agent_key_reused: !!payload.reused,
		agent_key_obtained_at: new Date().toISOString(),
	};
}

async function refreshOAuthState(state: NousAuthState, forceRefresh = false, forceMint = false): Promise<NousAuthState> {
	let next = state;
	if (forceRefresh || isExpiring(next.expires_at, ACCESS_TOKEN_REFRESH_SKEW_SECONDS)) {
		next = await refreshAccessToken(next);
	}
	if (forceMint || !agentKeyUsable(next, MIN_AGENT_KEY_TTL_SECONDS)) {
		next = await mintAgentKey(next, MIN_AGENT_KEY_TTL_SECONDS);
	}
	return next;
}

async function loginNous(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
	const device = await requestDeviceCode(PORTAL_URL, CLIENT_ID, SCOPE);
	callbacks.onAuth({
		url: device.verification_uri_complete,
		instructions: `If prompted, enter code: ${device.user_code}`,
	});
	callbacks.onProgress?.("Waiting for Nous approval...");

	const token = await pollForToken(
		PORTAL_URL,
		CLIENT_ID,
		device.device_code,
		device.expires_in,
		device.interval,
		callbacks.signal,
	);

	const now = new Date();
	const ttl = coerceTtlSeconds(token.expires_in);
	let state: NousAuthState = {
		portal_base_url: PORTAL_URL,
		inference_base_url: token.inference_base_url?.trim() || BASE_URL,
		client_id: CLIENT_ID,
		scope: token.scope || SCOPE,
		token_type: token.token_type || "Bearer",
		access_token: token.access_token,
		refresh_token: token.refresh_token || "",
		obtained_at: now.toISOString(),
		expires_in: ttl,
		expires_at: new Date(now.getTime() + ttl * 1000).toISOString(),
	};
	state = await refreshOAuthState(state, false, true);
	return stateToCredentials(state);
}

async function refreshNousToken(credentials: OAuthCredentials): Promise<OAuthCredentials> {
	let state = credentialsToState(credentials);
	state = await refreshOAuthState(state, false, false);
	return stateToCredentials(state);
}

function getApiKey(credentials: OAuthCredentials): string {
	const state = credentialsToState(credentials);
	if (!state.agent_key) {
		throw new Error("Nous OAuth session did not produce an agent key. Please /login nousresearch again.");
	}
	return state.agent_key;
}

function streamNous(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
): AssistantMessageEventStream {
	const stream = createAssistantMessageEventStream();

	(async () => {
		try {
			const delegated = streamSimpleOpenAICompletions(
				{ ...model, baseUrl: model.baseUrl || BASE_URL } as Model<"openai-completions">,
				context,
				options,
			);
			for await (const event of delegated) {
				stream.push(event);
			}
			stream.end();
		} catch (error) {
			stream.push({
				type: "error",
				reason: options?.signal?.aborted ? "aborted" : "error",
				error: {
					role: "assistant",
					content: [],
					api: model.api,
					provider: model.provider,
					model: model.id,
					usage: {
						input: 0,
						output: 0,
						cacheRead: 0,
						cacheWrite: 0,
						totalTokens: 0,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					},
					stopReason: options?.signal?.aborted ? "aborted" : "error",
					errorMessage: error instanceof Error ? error.message : String(error),
					timestamp: Date.now(),
				},
			});
			stream.end();
		}
	})();

	return stream;
}

async function fetchModelsFromApi(baseUrl = BASE_URL): Promise<ReturnType<typeof toPiModel>[]> {
	const response = await fetch(`${baseUrl}/models`);
	if (!response.ok) {
		throw new Error(`Failed to load models (${response.status})`);
	}

	const payload = (await response.json()) as { data?: NousPortalModel[] };
	const models = (payload.data ?? [])
		.filter(isSupportedTextModel)
		.map(toPiModel)
		.sort((a, b) => a.name.localeCompare(b.name));

	if (models.length === 0) {
		throw new Error("Nous API returned no supported text models");
	}

	return models;
}

async function loadModels(): Promise<ReturnType<typeof toPiModel>[]> {
	return await fetchModelsFromApi(BASE_URL);
}

export default async function (pi: ExtensionAPI) {
	const models = await loadModels();

	pi.registerProvider(PROVIDER, {
		name: PROVIDER_NAME,
		baseUrl: BASE_URL,
		api: CUSTOM_API,
		models,
		oauth: {
			name: OAUTH_NAME,
			login: loginNous,
			refreshToken: refreshNousToken,
			getApiKey,
		},
		streamSimple: streamNous,
	});
}
