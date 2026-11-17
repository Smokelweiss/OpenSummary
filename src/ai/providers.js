/**
 * Provider catalog.
 *
 * A "provider" is any endpoint that exposes a chat-completions-like API:
 *   openai    — OpenAI-compatible /chat/completions (OpenRouter, Groq, Cerebras,
 *               Mistral, DeepSeek, Together, Fireworks, vLLM, LM Studio, …)
 *   google    — Gemini generateContent
 *   anthropic — Messages API
 *   ollama    — local Ollama /api/chat
 *
 * Free tiers change often: model lists here are only suggestions, the UI can
 * always fetch the live list from the endpoint.
 */

export const PROVIDER_TYPES = [
  { id: 'openai', name: 'OpenAI-совместимый (/chat/completions)', hint: 'Подходит для OpenRouter, Groq, Cerebras, vLLM, LM Studio и любых «openai-compatible» серверов.' },
  { id: 'google', name: 'Google Gemini (generateContent)', hint: 'AI Studio: /v1beta/models/{model}:generateContent' },
  { id: 'anthropic', name: 'Anthropic Messages API', hint: '/v1/messages с заголовком x-api-key' },
  { id: 'ollama', name: 'Ollama (локально)', hint: 'http://localhost:11434 — /api/chat, /api/tags' },
];

const P = (preset) => ({
  chatPath: '',
  modelsPath: '',
  authScheme: 'bearer',
  free: false,
  local: false,
  notes: '',
  models: [],
  group: 'other',
  ...preset,
});

export const PRESETS = [
  /* ------------------------------------------------------------ most popular */
  P({
    id: 'google',
    name: 'Google AI Studio (Gemini)',
    group: 'popular',
    type: 'google',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
    authScheme: 'query',
    authQueryParam: 'key',
    free: true,
    defaultModel: 'gemini-2.5-flash',
    models: ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro', 'gemini-2.0-flash'],
    docs: 'https://ai.google.dev/gemini-api/docs',
    keyUrl: 'https://aistudio.google.com/app/apikey',
    notes: 'Щедрый бесплатный тариф, отличное соотношение цена/качество и большой контекст. Ключ — «API key» из AI Studio.',
  }),
  P({
    id: 'openrouter',
    name: 'OpenRouter',
    group: 'popular',
    type: 'openai',
    baseUrl: 'https://openrouter.ai/api/v1',
    chatPath: '/chat/completions',
    modelsPath: '/models',
    free: true,
    // `openrouter/free` is OpenRouter's own router: it picks a free model for
    // each request, so the preset never goes stale as models come and go.
    defaultModel: 'openrouter/free',
    models: ['openrouter/free'],
    docs: 'https://openrouter.ai/docs',
    keyUrl: 'https://openrouter.ai/keys',
    notes:
      'Один ключ — сотни моделей. «openrouter/free» — встроенный роутер по бесплатным моделям. Список меняется часто: нажмите ⟳ у списка моделей в панели (или «Загрузить модели» в настройках), чтобы подтянуть актуальные ID, включая варианты «:free».',
  }),
  P({
    id: 'groq',
    name: 'Groq Cloud',
    group: 'popular',
    type: 'openai',
    baseUrl: 'https://api.groq.com/openai/v1',
    chatPath: '/chat/completions',
    modelsPath: '/models',
    jsonMode: true,
    free: true,
    defaultModel: 'llama-3.3-70b-versatile',
    models: ['llama-3.3-70b-versatile', 'llama-3.1-8b-instant', 'openai/gpt-oss-120b', 'openai/gpt-oss-20b', 'qwen/qwen3-32b', 'gemma2-9b-it'],
    docs: 'https://console.groq.com/docs',
    keyUrl: 'https://console.groq.com/keys',
    notes: 'Самый быстрый инференс: саммари длинного видео приходит за секунды. Бесплатные лимиты по минутам.',
  }),
  P({
    id: 'cerebras',
    name: 'Cerebras Cloud',
    group: 'popular',
    type: 'openai',
    baseUrl: 'https://api.cerebras.ai/v1',
    chatPath: '/chat/completions',
    modelsPath: '/models',
    jsonMode: true,
    free: true,
    defaultModel: 'llama-3.3-70b',
    models: ['llama-3.3-70b', 'llama3.1-8b', 'qwen-3-32b', 'gpt-oss-120b'],
    docs: 'https://inference-docs.cerebras.ai/',
    keyUrl: 'https://cloud.cerebras.ai/',
    notes: 'Очень быстрая генерация, есть бесплатный уровень. Хорош для map-reduce по большим транскриптам.',
  }),
  P({
    id: 'mistral',
    name: 'Mistral AI',
    group: 'popular',
    type: 'openai',
    baseUrl: 'https://api.mistral.ai/v1',
    chatPath: '/chat/completions',
    modelsPath: '/models',
    jsonMode: true,
    free: true,
    defaultModel: 'mistral-small-latest',
    models: ['mistral-small-latest', 'open-mistral-nemo', 'ministral-8b-latest', 'mistral-large-latest'],
    docs: 'https://docs.mistral.ai/',
    keyUrl: 'https://console.mistral.ai/api-keys',
    notes: 'Есть бесплатный тариф (La Plateforme / Experiment) с ограничением по rate limit.',
  }),
  P({
    id: 'openai',
    name: 'OpenAI',
    group: 'popular',
    type: 'openai',
    baseUrl: 'https://api.openai.com/v1',
    chatPath: '/chat/completions',
    modelsPath: '/models',
    jsonMode: true,
    free: false,
    defaultModel: 'gpt-4o-mini',
    models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1', 'o4-mini', 'gpt-4.1-nano'],
    docs: 'https://platform.openai.com/docs/api-reference/chat',
    keyUrl: 'https://platform.openai.com/api-keys',
    notes: 'Платный, но самый предсказуемый. gpt-4o-mini дёшев и хорошо держит JSON.',
  }),
  P({
    id: 'anthropic',
    name: 'Anthropic (Claude)',
    group: 'popular',
    type: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    authScheme: 'x-api-key',
    free: false,
    defaultModel: 'claude-3-5-haiku-latest',
    models: ['claude-3-5-haiku-latest', 'claude-3-7-sonnet-latest', 'claude-sonnet-4-20250514', 'claude-opus-4-20250514'],
    docs: 'https://docs.anthropic.com/en/api/messages',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    notes: 'Платный. Расширение автоматически добавляет заголовок anthropic-dangerous-direct-browser-access.',
  }),
  P({
    id: 'deepseek',
    name: 'DeepSeek',
    group: 'popular',
    type: 'openai',
    baseUrl: 'https://api.deepseek.com/v1',
    chatPath: '/chat/completions',
    modelsPath: '/models',
    jsonMode: true,
    free: false,
    defaultModel: 'deepseek-chat',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    docs: 'https://api-docs.deepseek.com/',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    notes: 'Очень низкая цена, есть бесплатные промо-кредиты. deepseek-chat быстрее, reasoner точнее.',
  }),

  /* --------------------------------------------------------- other free tiers */
  P({
    id: 'github',
    name: 'GitHub Models',
    group: 'free',
    type: 'openai',
    baseUrl: 'https://models.inference.ai.azure.com',
    chatPath: '/chat/completions',
    modelsPath: '/models',
    free: true,
    defaultModel: 'gpt-4o-mini',
    models: ['gpt-4o-mini', 'gpt-4o', 'Phi-3.5-mini-instruct', 'Llama-3.3-70B-Instruct', 'Mistral-small'],
    docs: 'https://docs.github.com/en/github-models',
    keyUrl: 'https://github.com/settings/tokens',
    notes: 'Бесплатно с обычным GitHub PAT (нужен только scope models:read или классический токен без scope).',
  }),
  P({
    id: 'sambanova',
    name: 'SambaNova Cloud',
    group: 'free',
    type: 'openai',
    baseUrl: 'https://api.sambanova.ai/v1',
    chatPath: '/chat/completions',
    modelsPath: '/models',
    free: true,
    defaultModel: 'Meta-Llama-3.3-70B-Instruct',
    models: ['Meta-Llama-3.3-70B-Instruct', 'Meta-Llama-3.1-8B-Instruct', 'Qwen2.5-72B-Instruct', 'DeepSeek-R1-Distill-Llama-70B'],
    docs: 'https://docs.sambanova.ai/',
    keyUrl: 'https://cloud.sambanova.ai/apis',
    notes: 'Бесплатный уровень с лимитом по запросам в час/день.',
  }),
  P({
    id: 'together',
    name: 'Together AI',
    group: 'free',
    type: 'openai',
    baseUrl: 'https://api.together.xyz/v1',
    chatPath: '/chat/completions',
    modelsPath: '/models',
    jsonMode: true,
    free: true,
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct-Turbo-Free',
    models: ['meta-llama/Llama-3.3-70B-Instruct-Turbo-Free', 'meta-llama/Llama-Vision-Free', 'deepseek-ai/DeepSeek-R1-Distill-Llama-70B-free'],
    docs: 'https://docs.together.ai/',
    keyUrl: 'https://api.together.xyz/settings/api-keys',
    notes: 'Есть бесплатные «-Free» модели; остальные — по цене за токены.',
  }),
  P({
    id: 'cloudflare',
    name: 'Cloudflare Workers AI',
    group: 'free',
    type: 'openai',
    baseUrl: 'https://api.cloudflare.com/client/v4/accounts/{accountId}/ai/v1',
    chatPath: '/chat/completions',
    modelsPath: '/models',
    free: true,
    defaultModel: '@cf/meta/llama-3.1-8b-instruct',
    models: ['@cf/meta/llama-3.3-70b-instruct-fp8-fast', '@cf/meta/llama-3.1-8b-instruct', '@cf/qwen/qwen1.5-14b-chat-awq', '@cf/mistral/mistral-7b-instruct-v0.2'],
    docs: 'https://developers.cloudflare.com/workers-ai/',
    keyUrl: 'https://dash.cloudflare.com/profile/api-tokens',
    notes: 'Нужно указать Account ID (вставьте его в поле «Идентификатор аккаунта»). Есть бесплатная дневная квота.',
  }),
  P({
    id: 'nvidia',
    name: 'NVIDIA NIM',
    group: 'free',
    type: 'openai',
    baseUrl: 'https://integrate.api.nvidia.com/v1',
    chatPath: '/chat/completions',
    modelsPath: '/models',
    free: true,
    defaultModel: 'meta/llama-3.3-70b-instruct',
    models: ['meta/llama-3.3-70b-instruct', 'meta/llama-3.1-8b-instruct', 'mistralai/mistral-nemo-12b-instruct', 'qwen/qwen2.5-72b-instruct'],
    docs: 'https://docs.api.nvidia.com/',
    keyUrl: 'https://build.nvidia.com/',
    notes: 'Бесплатные кредиты при регистрации, ключ вида nvapi-…',
  }),
  P({
    id: 'qwen',
    name: 'Alibaba Qwen (DashScope)',
    group: 'free',
    type: 'openai',
    baseUrl: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1',
    chatPath: '/chat/completions',
    modelsPath: '/models',
    free: true,
    defaultModel: 'qwen-plus',
    models: ['qwen-plus', 'qwen-turbo', 'qwen-max', 'qwen2.5-72b-instruct'],
    docs: 'https://www.alibabacloud.com/help/en/model-studio/',
    keyUrl: 'https://bailian.console.alibabacloud.com/',
    notes: 'Много бесплатной квоты на новые аккаунты. Хорошо работает с русским текстом.',
  }),
  P({
    id: 'zhipu',
    name: 'Zhipu GLM (Z.ai)',
    group: 'free',
    type: 'openai',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    chatPath: '/chat/completions',
    modelsPath: '/models',
    free: true,
    defaultModel: 'glm-4-flash',
    models: ['glm-4-flash', 'glm-4-air', 'glm-4-plus'],
    docs: 'https://docs.z.ai/',
    keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    notes: 'glm-4-flash бесплатен и очень быстрый — хороший вариант «по умолчанию» без затрат.',
  }),
  P({
    id: 'moonshot',
    name: 'Moonshot Kimi',
    group: 'free',
    type: 'openai',
    baseUrl: 'https://api.moonshot.ai/v1',
    chatPath: '/chat/completions',
    modelsPath: '/models',
    free: true,
    defaultModel: 'moonshot-v1-8k',
    models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'kimi-k2-0711-preview'],
    docs: 'https://platform.moonshot.ai/docs',
    keyUrl: 'https://platform.moonshot.ai/console/api-keys',
    notes: 'Большой контекст и бесплатные стартовые кредиты.',
  }),
  P({
    id: 'siliconflow',
    name: 'SiliconFlow',
    group: 'free',
    type: 'openai',
    baseUrl: 'https://api.siliconflow.cn/v1',
    chatPath: '/chat/completions',
    modelsPath: '/models',
    free: true,
    defaultModel: 'Qwen/Qwen2.5-7B-Instruct',
    models: ['Qwen/Qwen2.5-7B-Instruct', 'Qwen/Qwen2.5-72B-Instruct', 'deepseek-ai/DeepSeek-V3', 'meta-llama/Llama-3.3-70B-Instruct'],
    docs: 'https://docs.siliconflow.cn/',
    keyUrl: 'https://cloud.siliconflow.cn/account/ak',
    notes: 'Ряд моделей бесплатен без лимита по токенам (с ограничением RPS).',
  }),
  P({
    id: 'chutes',
    name: 'Chutes.ai',
    group: 'free',
    type: 'openai',
    baseUrl: 'https://llm.chutes.ai/v1',
    chatPath: '/chat/completions',
    modelsPath: '/models',
    free: true,
    defaultModel: 'deepseek-ai/DeepSeek-V3-0324',
    models: ['deepseek-ai/DeepSeek-V3-0324', 'unsloth/Llama-3.3-70B-Instruct', 'Qwen/Qwen3-32B'],
    docs: 'https://chutes.ai/docs',
    keyUrl: 'https://chutes.ai/app/api',
    notes: 'Дешёвые/бесплатные децентрализованные модели, ключ вида cpk_…',
  }),
  P({
    id: 'xai',
    name: 'xAI Grok',
    group: 'other',
    type: 'openai',
    baseUrl: 'https://api.x.ai/v1',
    chatPath: '/chat/completions',
    modelsPath: '/models',
    free: false,
    defaultModel: 'grok-3-mini',
    models: ['grok-3-mini', 'grok-3', 'grok-2-1212'],
    docs: 'https://docs.x.ai/',
    keyUrl: 'https://console.x.ai/',
    notes: 'Платный, иногда дают бесплатные кредиты.',
  }),
  P({
    id: 'fireworks',
    name: 'Fireworks AI',
    group: 'other',
    type: 'openai',
    baseUrl: 'https://api.fireworks.ai/inference/v1',
    chatPath: '/chat/completions',
    modelsPath: '/models',
    free: false,
    defaultModel: 'accounts/fireworks/models/llama-v3p3-70b-instruct',
    models: ['accounts/fireworks/models/llama-v3p3-70b-instruct', 'accounts/fireworks/models/qwen2p5-72b-instruct'],
    docs: 'https://docs.fireworks.ai/',
    keyUrl: 'https://fireworks.ai/account/api-keys',
    notes: 'Оплата по токенам, часто дают стартовые кредиты.',
  }),
  P({
    id: 'deepinfra',
    name: 'DeepInfra',
    group: 'other',
    type: 'openai',
    baseUrl: 'https://api.deepinfra.com/v1/openai',
    chatPath: '/chat/completions',
    modelsPath: '/models',
    free: false,
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct',
    models: ['meta-llama/Llama-3.3-70B-Instruct', 'Qwen/Qwen2.5-72B-Instruct', 'deepseek-ai/DeepSeek-V3'],
    docs: 'https://deepinfra.com/docs',
    keyUrl: 'https://deepinfra.com/dash/api_keys',
    notes: 'Очень дешёвые токены, OpenAI-совместимый путь /v1/openai.',
  }),
  P({
    id: 'novita',
    name: 'Novita AI',
    group: 'other',
    type: 'openai',
    baseUrl: 'https://api.novita.ai/v3/openai',
    chatPath: '/chat/completions',
    modelsPath: '/models',
    free: false,
    defaultModel: 'meta-llama/llama-3.3-70b-instruct',
    models: ['meta-llama/llama-3.3-70b-instruct', 'deepseek/deepseek-v3', 'qwen/qwen-2.5-72b-instruct'],
    docs: 'https://novita.ai/docs',
    keyUrl: 'https://novita.ai/settings/key-management',
    notes: 'Есть бесплатные модели и стартовые кредиты.',
  }),
  P({
    id: 'hyperbolic',
    name: 'Hyperbolic',
    group: 'other',
    type: 'openai',
    baseUrl: 'https://api.hyperbolic.xyz/v1',
    chatPath: '/chat/completions',
    modelsPath: '/models',
    free: true,
    defaultModel: 'meta-llama/Llama-3.3-70B-Instruct',
    models: ['meta-llama/Llama-3.3-70B-Instruct', 'Qwen/Qwen2.5-72B-Instruct', 'deepseek-ai/DeepSeek-V3'],
    docs: 'https://docs.hyperbolic.xyz/',
    keyUrl: 'https://app.hyperbolic.xyz/settings',
    notes: 'Небольшой бесплатный кредит, низкие цены.',
  }),
  P({
    id: 'arliai',
    name: 'ArliAI',
    group: 'free',
    type: 'openai',
    baseUrl: 'https://api.arliai.com/v1',
    chatPath: '/chat/completions',
    modelsPath: '/models',
    free: true,
    defaultModel: 'Llama-3.3-70B-Instruct',
    models: ['Llama-3.3-70B-Instruct', 'Qwen3-32B', 'Mistral-Nemo-12B-Instruct-2407'],
    docs: 'https://www.arliai.com/',
    keyUrl: 'https://www.arliai.com/',
    notes: 'Бесплатный дневной лимит запросов.',
  }),

  /* ------------------------------------------------------------- local / self */
  P({
    id: 'ollama',
    name: 'Ollama (локально)',
    group: 'local',
    type: 'ollama',
    baseUrl: 'http://localhost:11434',
    free: true,
    local: true,
    authScheme: 'none',
    defaultModel: 'llama3.1:8b',
    models: ['llama3.1:8b', 'qwen2.5:7b', 'gemma2:9b', 'mistral:7b', 'phi4:14b'],
    docs: 'https://github.com/ollama/ollama/blob/main/docs/api.md',
    keyUrl: 'https://ollama.com/download',
    notes: 'Полностью офлайн: данные не покидают компьютер. Список моделей подтягивается из /api/tags.',
  }),
  P({
    id: 'lmstudio',
    name: 'LM Studio (локально)',
    group: 'local',
    type: 'openai',
    baseUrl: 'http://localhost:1234/v1',
    chatPath: '/chat/completions',
    modelsPath: '/models',
    free: true,
    local: true,
    authScheme: 'none',
    defaultModel: 'local-model',
    models: ['local-model'],
    docs: 'https://lmstudio.ai/docs/local-server',
    keyUrl: 'https://lmstudio.ai/',
    notes: 'Включите Local Server в LM Studio — порт по умолчанию 1234.',
  }),
  P({
    id: 'llamacpp',
    name: 'llama.cpp server (локально)',
    group: 'local',
    type: 'openai',
    baseUrl: 'http://localhost:8080/v1',
    chatPath: '/chat/completions',
    modelsPath: '/models',
    free: true,
    local: true,
    authScheme: 'none',
    defaultModel: 'local-model',
    models: ['local-model'],
    docs: 'https://github.com/ggml-org/llama.cpp/tree/master/tools/server',
    notes: 'llama-server поддерживает OpenAI-совместимый /v1/chat/completions.',
  }),
  P({
    id: 'vllm',
    name: 'vLLM (локально/сервер)',
    group: 'local',
    type: 'openai',
    baseUrl: 'http://localhost:8000/v1',
    chatPath: '/chat/completions',
    modelsPath: '/models',
    free: true,
    local: true,
    authScheme: 'none',
    defaultModel: 'local-model',
    models: ['local-model'],
    docs: 'https://docs.vllm.ai/en/latest/serving/openai_compatible_server.html',
    notes: 'Подходит и для удалённого self-hosted сервера — укажите свой URL и, при необходимости, ключ.',
  }),
  P({
    id: 'jan',
    name: 'Jan (локально)',
    group: 'local',
    type: 'openai',
    baseUrl: 'http://localhost:1337/v1',
    chatPath: '/chat/completions',
    modelsPath: '/models',
    free: true,
    local: true,
    authScheme: 'none',
    defaultModel: 'local-model',
    models: ['local-model'],
    docs: 'https://jan.ai/docs',
    notes: 'Откройте Settings → Local API Server в Jan.',
  }),
  P({
    id: 'textgen',
    name: 'text-generation-webui (локально)',
    group: 'local',
    type: 'openai',
    baseUrl: 'http://localhost:5000/v1',
    chatPath: '/chat/completions',
    modelsPath: '/models',
    free: true,
    local: true,
    authScheme: 'none',
    defaultModel: 'local-model',
    models: ['local-model'],
    docs: 'https://github.com/oobabooga/text-generation-webui',
    notes: 'Запустите с флагом --api и включённым OpenAI-совместимым режимом.',
  }),

  /* ------------------------------------------------------------------ custom */
  P({
    id: 'custom-openai',
    name: 'Свой OpenAI-совместимый endpoint',
    group: 'custom',
    type: 'openai',
    baseUrl: '',
    chatPath: '/chat/completions',
    modelsPath: '/models',
    free: false,
    defaultModel: '',
    models: [],
    notes: 'Любой сервер с /chat/completions: корпоративный шлюз, LiteLLM, OpenWebUI, Azure OpenAI, Cloudflare AI Gateway и т.п.',
  }),
  P({
    id: 'custom-other',
    name: 'Свой endpoint (Gemini/Anthropic/иной)',
    group: 'custom',
    type: 'openai',
    baseUrl: '',
    free: false,
    defaultModel: '',
    notes: 'Выберите тип API, укажите базовый URL и (при необходимости) путь и заголовок авторизации.',
  }),
];

export const PRESET_GROUPS = [
  { id: 'popular', name: 'Популярные и бесплатные' },
  { id: 'free', name: 'Бесплатные тарифы' },
  { id: 'local', name: 'Локальные модели (офлайн)' },
  { id: 'other', name: 'Другие сервисы' },
  { id: 'custom', name: 'Свои endpoint’ы' },
];

export function getPreset(presetId) {
  return PRESETS.find((p) => p.id === presetId) || null;
}

export function groupPresets() {
  return PRESET_GROUPS.map((g) => ({ ...g, presets: PRESETS.filter((p) => p.group === g.id) }));
}

/** Creates a provider config object from a preset. */
export function providerFromPreset(presetId, extra = {}) {
  const preset = getPreset(presetId);
  if (!preset) throw new Error(`Неизвестный пресет: ${presetId}`);
  return {
    id: `${preset.id}-${Math.random().toString(36).slice(2, 6)}`,
    presetId: preset.id,
    name: preset.name,
    type: preset.type,
    baseUrl: preset.baseUrl,
    chatPath: preset.chatPath || '',
    modelsPath: preset.modelsPath || '',
    authScheme: preset.authScheme || 'bearer',
    authHeader: '',
    authQueryParam: preset.authQueryParam || 'key',
    accountId: '',
    headers: {},
    models: preset.models ? preset.models.slice() : [],
    defaultModel: preset.defaultModel || '',
    enabled: true,
    free: !!preset.free,
    local: !!preset.local,
    docs: preset.docs || '',
    keyUrl: preset.keyUrl || '',
    notes: preset.notes || '',
    jsonMode: !!preset.jsonMode,
    ...extra,
  };
}

/** Expands {accountId} and similar placeholders. */
export function expandBaseUrl(provider) {
  return String(provider?.baseUrl || '')
    .replace(/\{accountId\}/g, provider?.accountId || '')
    .replace(/\/+$/, '');
}

export function resolveChatUrl(provider, model) {
  const base = expandBaseUrl(provider);
  if (!base) throw new Error('Не задан базовый URL провайдера');
  if (provider.type === 'google') {
    const path = provider.chatPath || `/models/${encodeURIComponent(model)}:generateContent`;
    const withModel = path.includes('{model}') ? path.replace('{model}', encodeURIComponent(model)) : path;
    return `${base}${withModel.startsWith('/') ? '' : '/'}${withModel}`;
  }
  if (provider.type === 'anthropic') {
    const path = provider.chatPath || '/v1/messages';
    return `${base}${path.startsWith('/') ? '' : '/'}${path}`;
  }
  if (provider.type === 'ollama') {
    const path = provider.chatPath || '/api/chat';
    return `${base}${path.startsWith('/') ? '' : '/'}${path}`;
  }
  const path = provider.chatPath || '/chat/completions';
  return `${base}${path.startsWith('/') ? '' : '/'}${path}`;
}

export function resolveModelsUrl(provider) {
  const base = expandBaseUrl(provider);
  if (!base) return '';
  if (provider.type === 'ollama') {
    const root = base.replace(/\/v1$/, '');
    return `${root}/api/tags`;
  }
  if (provider.type === 'google') {
    return `${base}/models`;
  }
  if (provider.type === 'anthropic') {
    return `${base}/v1/models`;
  }
  const path = provider.modelsPath || '/models';
  return `${base}${path.startsWith('/') ? '' : '/'}${path}`;
}

/** Human summary of where a provider sends data (used in the privacy hint). */
export function providerHost(provider) {
  try {
    return new URL(expandBaseUrl(provider)).host;
  } catch {
    return '';
  }
}
