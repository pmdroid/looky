/**
 * Provider configuration from `LOOKY_PROVIDER*` environment variables.
 *
 *   LOOKY_PROVIDERS=local,hosted              configured provider ids
 *   LOOKY_PROVIDER=local                      selected provider
 *   LOOKY_PROVIDER_FALLBACK=hosted            optional fallbacks, in order
 *   LOOKY_PROVIDER_<ID>_KIND=openai|anthropic
 *   LOOKY_PROVIDER_<ID>_MODEL=…
 *   LOOKY_PROVIDER_<ID>_BASE_URL=…            optional
 *   LOOKY_PROVIDER_<ID>_API_KEY=…             optional
 *   LOOKY_PROVIDER_<ID>_TIMEOUT_MS=…          optional
 *   LOOKY_PROVIDER_<ID>_MAX_TOKENS_FIELD=…    optional, openai only
 *   LOOKY_PROVIDER_<ID>_MAX_REQUESTS_PER_MINUTE / _MAX_TOKENS_PER_MINUTE   optional quotas
 *
 * `<ID>` is the id upper-cased with `-` as `_`.
 */
import { ProviderConfigError, type ProviderPolicy } from "../contract/ports";
import {
  createHttpProvider,
  DEFAULT_PROVIDER_TIMEOUT_MS,
  PROVIDER_KINDS,
  type HttpProviderOptions,
  type ProviderKind,
} from "./http";
import { ProviderRouter, type ProviderQuota } from "./router";

export interface ProviderSettings extends Omit<HttpProviderOptions, "fetch"> {
  readonly quota: ProviderQuota;
}

export interface ProviderConfig {
  readonly providers: readonly ProviderSettings[];
  readonly policy: ProviderPolicy;
}

type Env = Record<string, string | undefined>;

const PROVIDER_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** `my-local` -> `LOOKY_PROVIDER_MY_LOCAL_<FIELD>`. */
export function providerEnvName(id: string, field: string): string {
  return `LOOKY_PROVIDER_${id.toUpperCase().replace(/-/g, "_")}_${field}`;
}

function list(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function positiveInt(env: Env, name: string): number | undefined {
  const raw = env[name]?.trim();
  if (raw === undefined || raw === "") return undefined;
  if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(Number(raw))) {
    throw new ProviderConfigError(`${name} must be a positive integer`);
  }
  return Number(raw);
}

function nonEmpty(env: Env, name: string): string | undefined {
  const raw = env[name]?.trim();
  return raw === undefined || raw === "" ? undefined : raw;
}

/**
 * Read provider configuration. Returns undefined when no provider is selected,
 * so commands that do not call a model keep working without configuration.
 */
export function loadProviderConfig(env: Env = process.env): ProviderConfig | undefined {
  const selected = nonEmpty(env, "LOOKY_PROVIDER");
  const fallback = list(env.LOOKY_PROVIDER_FALLBACK);
  if (selected === undefined) {
    if (fallback.length > 0) {
      throw new ProviderConfigError("LOOKY_PROVIDER_FALLBACK needs LOOKY_PROVIDER");
    }
    return undefined;
  }
  const declared = list(env.LOOKY_PROVIDERS);
  const ids = declared.length > 0 ? declared : [selected, ...fallback];
  const providers = ids.map((id): ProviderSettings => {
    if (!PROVIDER_ID.test(id)) {
      throw new ProviderConfigError(
        `Provider id ${JSON.stringify(id)} must be lowercase letters, digits, - or _`,
      );
    }
    const kind = nonEmpty(env, providerEnvName(id, "KIND"));
    if (kind === undefined || !(PROVIDER_KINDS as readonly string[]).includes(kind)) {
      throw new ProviderConfigError(
        `${providerEnvName(id, "KIND")} must be one of: ${PROVIDER_KINDS.join(", ")}`,
      );
    }
    const model = nonEmpty(env, providerEnvName(id, "MODEL"));
    if (model === undefined)
      throw new ProviderConfigError(`${providerEnvName(id, "MODEL")} is required`);
    const field = nonEmpty(env, providerEnvName(id, "MAX_TOKENS_FIELD"));
    if (field !== undefined && field !== "max_tokens" && field !== "max_completion_tokens") {
      throw new ProviderConfigError(
        `${providerEnvName(id, "MAX_TOKENS_FIELD")} must be max_tokens or max_completion_tokens`,
      );
    }
    const baseUrl = nonEmpty(env, providerEnvName(id, "BASE_URL"));
    const apiKey = nonEmpty(env, providerEnvName(id, "API_KEY"));
    const maxRequestsPerMinute = positiveInt(env, providerEnvName(id, "MAX_REQUESTS_PER_MINUTE"));
    const maxTokensPerMinute = positiveInt(env, providerEnvName(id, "MAX_TOKENS_PER_MINUTE"));
    return {
      id,
      kind: kind as ProviderKind,
      model,
      timeoutMs: positiveInt(env, providerEnvName(id, "TIMEOUT_MS")) ?? DEFAULT_PROVIDER_TIMEOUT_MS,
      ...(baseUrl !== undefined ? { baseUrl } : {}),
      ...(apiKey !== undefined ? { apiKey } : {}),
      ...(field !== undefined ? { maxTokensField: field } : {}),
      quota: {
        ...(maxRequestsPerMinute !== undefined ? { maxRequestsPerMinute } : {}),
        ...(maxTokensPerMinute !== undefined ? { maxTokensPerMinute } : {}),
      },
    };
  });
  return { providers, policy: { selected, ...(fallback.length > 0 ? { fallback } : {}) } };
}

/** Build the configured router, or undefined when no provider is selected. */
export function createConfiguredProvider(
  env: Env = process.env,
  options: { readonly fetch?: typeof fetch; readonly now?: () => number } = {},
): ProviderRouter | undefined {
  const config = loadProviderConfig(env);
  if (config === undefined) return undefined;
  return new ProviderRouter({
    providers: config.providers.map(({ quota, ...settings }) => ({
      provider: createHttpProvider({
        ...settings,
        ...(options.fetch ? { fetch: options.fetch } : {}),
      }),
      quota,
    })),
    policy: config.policy,
    ...(options.now ? { now: options.now } : {}),
  });
}
