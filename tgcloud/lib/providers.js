/**
 * Built-in provider configurations.
 * Each entry defines slug, display name, base URL, and default model list.
 * These are seeded into `user_providers` when a user first starts the bot.
 */

export const BUILTIN_PROVIDERS = [
  {
    slug: 'gemini',
    name: 'Google Gemini',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    defaultModel: 'gemini-2.5-flash-lite',
    models: [
      'gemini-2.5-flash-lite',
      'gemini-2.5-flash',
      'gemini-2.0-flash',
      'gemini-2.5-pro',
      'gemini-3.1-flash-lite',
      'gemini-3.1-flash',
      'gemma-4-26b-a4b-it',
    ],
  },
  {
    slug: 'groq',
    name: 'Groq',
    baseUrl: 'https://api.groq.com/openai/v1',
    defaultModel: 'llama-3.3-70b-versatile',
    models: [
      'llama-3.3-70b-versatile',
      'llama-3.1-8b-instant',
      'deepseek-r1-distill-llama-70b',
      'mixtral-8x7b-32768',
      'gemma2-9b-it',
    ],
  },
  {
    slug: 'deepseek',
    name: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    defaultModel: 'deepseek-chat',
    models: ['deepseek-chat', 'deepseek-reasoner'],
  },
  {
    slug: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini', 'gpt-4.1'],
  },
  {
    slug: 'openrouter',
    name: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    defaultModel: 'google/gemini-2.0-flash-lite-001',
    models: [
      'google/gemini-2.0-flash-lite-001',
      'google/gemini-2.5-flash',
      'deepseek/deepseek-r1',
      'deepseek/deepseek-chat',
      'meta-llama/llama-3.3-70b-instruct',
      'anthropic/claude-3.7-sonnet',
      'anthropic/claude-sonnet-4',
    ],
  },
  {
    slug: 'manus',
    name: 'Manus AI',
    baseUrl: 'https://api.manus.ai',
    defaultModel: 'standard',
    models: [
      'standard',
      'lite',
      'max',
      'manus-1',
      'manus-pro',
    ],
  },
  {
    slug: 'freeai',
    name: 'FreeAI',
    baseUrl: 'https://api.free.ai/v1',
    defaultModel: 'qwen7b',
    models: [
      'qwen7b',
      'deepseek-r1',
      'qwen-3.6-35b',
    ],
  },
];

export const ROUTING_POLICIES = {
  fallback: {
    name: '🛡️ فالبک اولویتی',
    desc: 'استفاده بر اساس ترتیب اولویت — سوئیچ خودکار هنگام خطا',
  },
  round_robin: {
    name: '🔄 راند رابین',
    desc: 'توزیع چرخشی و مساوی درخواست‌ها بین تمام کلیدها',
  },
  smart_router: {
    name: '🧠 اسمارت روتر',
    desc: 'انتخاب هوشمند سالم‌ترین کلید با کمترین نرخ خطا',
  },
  least_used: {
    name: '⚖️ کمترین مصرف',
    desc: 'انتخاب کلیدی که کمترین توکن را مصرف کرده است',
  },
};

/**
 * Returns a provider config by slug (from built-in list).
 */
export function getBuiltinProvider(slug) {
  return BUILTIN_PROVIDERS.find((p) => p.slug === slug) || null;
}

/**
 * Short display label for a provider slug (safe for buttons).
 */
export function providerLabel(slug) {
  const b = getBuiltinProvider(slug);
  if (b) return b.name;
  if (slug && slug.startsWith('c_')) return 'Custom';
  return slug || 'Unknown';
}
