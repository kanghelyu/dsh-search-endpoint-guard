/**
 * dsh-search-endpoint-guard · 搜索端点守卫
 *
 * Keeps `web_search` on the endpoint that actually accepts your API key.
 *
 * DeepSeek Harness's `web_search` tool is backed by the web-search-deepseek
 * plugin, which by default calls the OFFICIAL DeepSeek endpoint
 * `https://api.deepseek.com/anthropic/v1` and authenticates with the
 * `DEEPSEEK_API_KEY` credential. When the chat LLM runs on a non-official
 * (proxy/gateway) provider, that key often only works on the gateway — the
 * official API then rejects it with:
 *
 *     Authentication Fails, Your api key: **** is invalid
 *
 * This plugin diagnoses exactly that state (chat endpoint ≠ official while
 * web_search still targets the official default), surfaces the exact fix
 * (set `web-search-deepseek.baseURL` to the chat endpoint), can apply the
 * alignment itself (autoAlign or `search_endpoint_check` with apply: true),
 * and can live-probe the effective search endpoint to prove the fix.
 *
 * Endpoint resolution mirrors the consumer plugins:
 *   chat    = settings `llm-deepseek.baseURL` ?? env `DEEPSEEK_BASE_URL` ?? https://api.deepseek.com
 *   search  = settings `web-search-deepseek.baseURL` ?? env `DEEPSEEK_SEARCH_BASE_URL` ?? https://api.deepseek.com/anthropic/v1
 *
 * @module dsh-search-endpoint-guard
 */
import z from "@deepseek-ai/schemastery";
import { defineTool } from "@deepseek-ai/dsh-tools";
import { launchEnvironmentOf } from "@deepseek-ai/dsh-launch-environment";
import { credentialRef } from "@deepseek-ai/dsh-credentials";

/** Cordis plugin name used by loader diagnostics. */
export const name = "search-endpoint-guard";
/** Services required by the guard (tools registry and system-prompt sections). */
export const inject = ["tools", "systemPrompt"];

/** Plugin configuration. */
export const Config = z.object({
	/** Align `web-search-deepseek.baseURL` to the chat LLM endpoint at startup when misaligned. */
	autoAlign: z.boolean().default(false),
	/** Run the endpoint check once at startup and log the verdict. */
	checkOnStartup: z.boolean().default(true),
	/** Timeout (ms) for one live probe request. */
	probeTimeoutMs: z.number().default(3e4)
});

/** Settings namespace of the chat LLM adapter. */
const LLM_NS = "llm-deepseek";
/** Settings namespace of the web_search provider. */
const SEARCH_NS = "web-search-deepseek";
/** Default credential reference shared by both consumer plugins. */
const DEFAULT_KEY_ENV = "DEEPSEEK_API_KEY";
/** Launch-environment keys honored by the consumer plugins. */
const CHAT_BASE_URL_ENV = "DEEPSEEK_BASE_URL";
const SEARCH_BASE_URL_ENV = "DEEPSEEK_SEARCH_BASE_URL";
/** Official DeepSeek endpoints (the defaults this guard protects against). */
const OFFICIAL_CHAT_BASE = "https://api.deepseek.com";
const OFFICIAL_SEARCH_BASE = "https://api.deepseek.com/anthropic/v1";
/** Default model the search provider sends (also used by the probe). */
const DEFAULT_SEARCH_MODEL = "deepseek-v4-flash";

/** Strip trailing slashes so equivalent URLs compare equal. */
function normalizeUrl(value) {
	return typeof value === "string" ? value.replace(/\/+$/, "") : "";
}

/** True when the chat LLM endpoint is the official DeepSeek API. */
function isOfficialChatBase(value) {
	const url = normalizeUrl(value);
	return url === OFFICIAL_CHAT_BASE || url === OFFICIAL_CHAT_BASE + "/v1";
}

/** True when the web_search endpoint is the official default. */
function isOfficialSearchBase(value) {
	return normalizeUrl(value) === OFFICIAL_SEARCH_BASE;
}

/** True when the value is a usable http(s) URL. */
function isHttpUrl(value) {
	try {
		const url = new URL(value);
		return url.protocol === "http:" || url.protocol === "https:";
	} catch {
		return false;
	}
}

/**
 * Resolve the effective endpoints exactly like the consumer plugins do:
 * settings section, then launch-environment variable, then the official default.
 * @param llm - resolved `llm-deepseek` settings section (or undefined).
 * @param search - resolved `web-search-deepseek` settings section (or undefined).
 * @param env - launch-environment-like object with `.get(name) -> {value} | undefined`.
 * @returns the effective endpoints and credential reference.
 */
export function computeEndpoints(llm, search, env) {
	const llmSection = llm ?? {};
	const searchSection = search ?? {};
	const envValue = (key) => {
		const hit = env?.get(key);
		return hit !== void 0 && hit.value.length > 0 ? hit.value : void 0;
	};
	const chatBaseURL = normalizeUrl(llmSection.baseURL ?? envValue(CHAT_BASE_URL_ENV) ?? OFFICIAL_CHAT_BASE);
	const searchBaseURL = normalizeUrl(searchSection.baseURL ?? envValue(SEARCH_BASE_URL_ENV) ?? OFFICIAL_SEARCH_BASE);
	return {
		chatBaseURL,
		searchBaseURL,
		chatOfficial: isOfficialChatBase(chatBaseURL),
		searchOfficial: isOfficialSearchBase(searchBaseURL),
		keyRef: searchSection.apiKeyEnv ?? DEFAULT_KEY_ENV
	};
}

/**
 * Classify the endpoint alignment.
 * @param endpoints - `computeEndpoints` output.
 * @returns verdict with a stable `status` and an actionable `message`.
 */
export function classify(endpoints) {
	const { chatBaseURL, searchBaseURL, chatOfficial, searchOfficial, keyRef } = endpoints;
	if (searchOfficial && !chatOfficial) {
		return {
			status: "misaligned",
			message:
				"web_search still targets the official endpoint (" + OFFICIAL_SEARCH_BASE + ") while the chat LLM uses " + chatBaseURL + ". " +
				"If " + chatBaseURL + " is a non-official provider (proxy/gateway), your \"" + keyRef + "\" key may be rejected by the official API with \"Authentication Fails, Your api key: **** is invalid\". " +
				"Align the search endpoint: set web-search-deepseek.baseURL to " + chatBaseURL + " (settings.yaml), or call search_endpoint_check with apply: true."
		};
	}
	if (chatOfficial && searchOfficial) {
		return {
			status: "aligned",
			message: "web_search and the chat LLM both use the official DeepSeek API (" + chatBaseURL + " / " + searchBaseURL + ")."
		};
	}
	if (searchBaseURL === chatBaseURL) {
		return {
			status: "aligned",
			message: "web_search endpoint (" + searchBaseURL + ") matches the chat LLM endpoint."
		};
	}
	return {
		status: "differing",
		message:
			"web_search uses " + searchBaseURL + " while the chat LLM uses " + chatBaseURL + ". " +
			"Verify that the search endpoint accepts the \"" + keyRef + "\" API key; if it is a gateway that only accepts the key on the chat endpoint, " +
			"set web-search-deepseek.baseURL to " + chatBaseURL + " (settings.yaml or search_endpoint_check with apply: true)."
	};
}

/**
 * Whether a resolvable credential exists for the key reference
 * (credentials service first, then the launch environment).
 */
async function resolveKeyPresent(ctx, keyRef) {
	const credentials = ctx.get("credentials");
	if (credentials !== void 0) {
		try {
			const hit = await credentials.resolve(credentialRef(keyRef));
			if (hit !== void 0 && hit.value.length > 0) return true;
		} catch {
			// fall through to the launch environment
		}
	}
	const ambient = launchEnvironmentOf(ctx).get(keyRef);
	return ambient !== void 0 && ambient.value.length > 0;
}

/** Resolve the credential's value, or undefined when absent. */
async function resolveKey(ctx, keyRef) {
	const credentials = ctx.get("credentials");
	if (credentials !== void 0) {
		try {
			const hit = await credentials.resolve(credentialRef(keyRef));
			if (hit !== void 0 && hit.value.length > 0) return hit.value;
		} catch {
			// fall through to the launch environment
		}
	}
	const ambient = launchEnvironmentOf(ctx).get(keyRef);
	return ambient !== void 0 && ambient.value.length > 0 ? ambient.value : void 0;
}

/**
 * Run one full diagnosis against the live settings.
 * @param ctx - plugin context.
 * @param readSettings - `(ns) => resolved section | undefined`.
 * @returns the report (endpoints + key presence + verdict).
 */
export async function diagnose(ctx, readSettings) {
	const endpoints = computeEndpoints(readSettings(LLM_NS), readSettings(SEARCH_NS), launchEnvironmentOf(ctx));
	const verdict = classify(endpoints);
	return {
		...endpoints,
		keyPresent: await resolveKeyPresent(ctx, endpoints.keyRef),
		status: verdict.status,
		message: verdict.message
	};
}

/**
 * Send one minimal Messages request to the effective search endpoint to prove
 * key + endpoint compatibility (the same request the web_search provider makes,
 * trimmed to max_tokens: 1). The raw key is never included in the output.
 * @returns probe verdict; `detail` may carry the provider's own error text.
 */
export async function probeSearch(ctx, readSettings, timeoutMs) {
	const endpoints = computeEndpoints(readSettings(LLM_NS), readSettings(SEARCH_NS), launchEnvironmentOf(ctx));
	const search = readSettings(SEARCH_NS) ?? {};
	const key = await resolveKey(ctx, endpoints.keyRef);
	const mask = (text) => key !== void 0 && key.length > 0 ? text.split(key).join("****") : text;
	if (key === void 0) {
		return { ok: false, statusCode: 0, detail: "no API key resolved for \"" + endpoints.keyRef + "\"" };
	}
	const body = {
		model: search.model ?? DEFAULT_SEARCH_MODEL,
		max_tokens: 1,
		messages: [{
			role: "user",
			content: [{ type: "text", text: "ping" }]
		}],
		tools: [{ type: "web_search_20250305", name: "web_search", max_uses: 1 }]
	};
	let response;
	try {
		response = await fetch(endpoints.searchBaseURL + "/messages", {
			method: "POST",
			redirect: "error",
			signal: AbortSignal.timeout(timeoutMs),
			headers: {
				"x-api-key": key,
				"authorization": "Bearer " + key,
				"anthropic-version": "2023-06-01",
				"content-type": "application/json",
				"accept": "application/json"
			},
			body: JSON.stringify(body)
		});
	} catch (error) {
		return { ok: false, statusCode: 0, detail: mask(String(error)) };
	}
	let detail = "HTTP " + response.status;
	try {
		const parsed = await response.json();
		const found = typeof parsed.error === "string" ? parsed.error : parsed.error?.message ?? parsed.message;
		if (found !== void 0 && found.length > 0) detail = found;
	} catch {
		// non-JSON error body: keep the HTTP status line
	}
	return { ok: response.ok, statusCode: response.status, detail: mask(detail) };
}

/** Render one report as a compact text block for logs and tool output. */
export function formatReport(report) {
	const lines = [
		"status: " + report.status,
		"chat LLM endpoint: " + report.chatBaseURL + (report.chatOfficial ? " (official)" : ""),
		"web_search endpoint: " + report.searchBaseURL + (report.searchOfficial ? " (official default)" : ""),
		"search API key: " + report.keyRef + (report.keyPresent ? " (present)" : " (MISSING)")
	];
	if (report.applied === true) lines.push("alignment applied through settings (web-search-deepseek.baseURL)");
	if (report.applyError !== void 0) lines.push("alignment failed: " + report.applyError);
	if (report.probe !== void 0) {
		lines.push("probe: " + (report.probe.ok ? "OK" : "FAILED") + " (HTTP " + report.probe.statusCode + ") " + report.probe.detail);
	}
	lines.push("", report.message);
	return lines.join("\n");
}

/**
 * Register the model-facing `search_endpoint_check` tool: diagnose the
 * endpoint alignment, optionally apply the alignment, optionally live-probe.
 */
function registerCheckTool(ctx, wiring, probeTimeoutMs) {
	ctx.tools.register(defineTool({
		name: "search_endpoint_check",
		description:
			"Diagnose the web_search endpoint: reports whether web_search is aligned with the configured chat LLM endpoint, " +
			"especially when the LLM runs on a non-official (proxy/gateway) provider and web_search still targets the official " +
			"api.deepseek.com endpoint. Optionally applies the alignment (apply: true) or live-tests the effective search " +
			"endpoint with a minimal request (probe: true).",
		parameters: {
			apply: {
				type: "boolean",
				description: "When true and the search endpoint is misaligned, set web-search-deepseek.baseURL to the chat LLM endpoint through settings."
			},
			probe: {
				type: "boolean",
				description: "When true, send one minimal request to the effective search endpoint and report HTTP status / error detail."
			}
		},
		output: {
			schema: {
				type: "object",
				additionalProperties: false,
				properties: {
					status: { type: "string", required: true },
					chatBaseURL: { type: "string", required: true },
					searchBaseURL: { type: "string", required: true },
					chatOfficial: { type: "boolean", required: true },
					searchOfficial: { type: "boolean", required: true },
					keyRef: { type: "string", required: true },
					keyPresent: { type: "boolean", required: true },
					applied: { type: "boolean", required: true },
					applyError: { type: "string" },
					message: { type: "string", required: true },
					probe: {
						type: "object",
						additionalProperties: false,
						properties: {
							ok: { type: "boolean", required: true },
							statusCode: { type: "integer", required: true },
							detail: { type: "string", required: true }
						}
					}
				}
			},
			render: (_args, value) => [{ type: "text", text: formatReport(value) }]
		},
		timeoutMs: Math.max(probeTimeoutMs + 5000, 60000),
		isConcurrencySafe: () => true,
		async execute(args) {
			const readSettings = (ns) => wiring.read(ns);
			const report = await diagnose(ctx, readSettings);
			report.applied = false;
			if (args.apply === true) {
				if (report.status === "misaligned" && isHttpUrl(report.chatBaseURL)) {
					try {
						await wiring.write(SEARCH_NS, { baseURL: report.chatBaseURL });
						report.applied = true;
						const after = await diagnose(ctx, readSettings);
						report.status = after.status;
						report.message = after.message;
					} catch (error) {
						report.applyError = String(error);
					}
				} else if (report.status !== "misaligned") {
					report.message += " (apply: nothing to do — the endpoint is already aligned or only differing)";
				}
			}
			if (args.probe === true) {
				report.probe = await probeSearch(ctx, readSettings, probeTimeoutMs);
			}
			return report;
		}
	}));
}

/**
 * Startup check: log the verdict; when `autoAlign` is on and the state is
 * misaligned, apply the alignment through settings. Retries briefly so the
 * llm-deepseek / web-search-deepseek namespaces can register first.
 */
function startupCheck(ctx, config, wiring) {
	if (config.checkOnStartup !== true) return;
	void (async () => {
		const readSettings = (ns) => wiring.read(ns);
		let report;
		for (let attempt = 0; attempt < 4; attempt += 1) {
			report = await diagnose(ctx, readSettings);
			if (report.keyPresent || report.chatBaseURL !== OFFICIAL_CHAT_BASE) break;
			await new Promise((resolve) => setTimeout(resolve, 1000));
		}
		if (report.status === "misaligned") {
			if (config.autoAlign === true && isHttpUrl(report.chatBaseURL)) {
				try {
					await wiring.write(SEARCH_NS, { baseURL: report.chatBaseURL });
					const after = await diagnose(ctx, readSettings);
					ctx.logger.info("search-endpoint-guard: auto-aligned web_search endpoint to %s (status: %s)", report.chatBaseURL, after.status);
				} catch (error) {
					ctx.logger.warn("search-endpoint-guard: autoAlign failed: %s", String(error));
				}
			} else {
				ctx.logger.warn(
					"search-endpoint-guard: web_search MISALIGNED — chat LLM uses %s but web_search still targets the official %s. " +
					"Fix: add to settings.yaml: web-search-deepseek: { baseURL: %s } (or call search_endpoint_check with apply: true)",
					report.chatBaseURL, report.searchBaseURL, report.chatBaseURL
				);
			}
		} else if (report.status === "differing") {
			ctx.logger.info(
				"search-endpoint-guard: web_search endpoint %s differs from chat LLM endpoint %s — verify the \"%s\" key is accepted there",
				report.searchBaseURL, report.chatBaseURL, report.keyRef
			);
		} else {
			ctx.logger.info("search-endpoint-guard: web_search endpoint aligned (%s)", report.searchBaseURL);
		}
	})().catch((error) => {
		ctx.logger.warn("search-endpoint-guard: startup check failed: %s", String(error));
	});
}

/** Mount the guard: settings wiring, system-prompt guidance, tool, startup check. */
export function apply(ctx, config) {
	// Mutable wiring: the settings service may mount after apply() returns, so
	// the tool and startup check resolve reads/writes through this object.
	const wiring = {
		read: () => void 0,
		write: async () => {
			throw new Error("settings service unavailable — cannot align");
		}
	};
	ctx.inject(["settings"], (sctx) => {
		wiring.read = (ns) => sctx.settings.get(ns);
		wiring.write = async (ns, patch) => {
			await sctx.settings.update(ns, patch);
		};
	});
	ctx.systemPrompt.section({
		name: "search-endpoint-guard:usage",
		order: 118,
		text:
			"When a web_search call fails with an authentication or endpoint error (for example " +
			"\"Authentication Fails, Your api key: **** is invalid\") or the user reports web search not working, " +
			"call search_endpoint_check to diagnose whether the web_search endpoint is aligned with the configured " +
			"LLM provider endpoint; the tool can also align it (apply: true) or live-probe it (probe: true)."
	});
	registerCheckTool(ctx, wiring, config.probeTimeoutMs ?? 3e4);
	startupCheck(ctx, config, wiring);
}
