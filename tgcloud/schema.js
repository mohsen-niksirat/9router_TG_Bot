import { table, integer, text, index, sql } from 'sdk/db';

// ─── Users ────────────────────────────────────────────────────────────────────
export const users = table('users', {
  id:            integer('id').primaryKey({ autoIncrement: true }),
  tgId:          integer('tg_id').unique().notNull(),
  name:          text('name'),
  username:      text('username'),
  activeComboId: integer('active_combo_id'),   // FK → combos.id (null = no combo selected)
  wizardState:   text('wizard_state').default('idle'),
  wizardData:    text('wizard_data'),           // JSON context for multi-step wizards
  createdAt:     integer('created_at').default(sql`(unixepoch())`),
}, (t) => ({
  tgIdx: index('idx_users_tg').on(t.tgId),
}));

// ─── User Providers ───────────────────────────────────────────────────────────
// Both built-in (gemini, groq, …) and custom (c_<ts>) per user
export const userProviders = table('user_providers', {
  id:           integer('id').primaryKey({ autoIncrement: true }),
  userId:       integer('user_id').notNull(),
  name:         text('name').notNull(),         // Display name, e.g. "Google Gemini"
  slug:         text('slug').notNull(),         // e.g. "gemini", "groq", "c_1234"
  baseUrl:      text('base_url').notNull(),
  defaultModel: text('default_model'),
  models:       text('models'),                 // JSON array of model name strings
  isBuiltin:    integer('is_builtin').default(0), // 1 = built-in seeded on start
  createdAt:    integer('created_at').default(sql`(unixepoch())`),
}, (t) => ({
  userProvIdx: index('idx_prov_user').on(t.userId),
  slugIdx:     index('idx_prov_slug').on(t.userId, t.slug),
}));

// ─── User Keys ────────────────────────────────────────────────────────────────
export const userKeys = table('user_keys', {
  id:           integer('id').primaryKey({ autoIncrement: true }),
  userId:       integer('user_id').notNull(),
  providerSlug: text('provider_slug').notNull(), // matches userProviders.slug
  apiKeyEnc:    text('api_key_enc').notNull(),    // XOR-encrypted, never plaintext
  label:        text('label'),
  status:       text('status').default('active'), // 'active' | 'cooldown' | 'dead'
  failureCount: integer('failure_count').default(0),
  cooldownUntil:integer('cooldown_until').default(0),
  sortOrder:    integer('sort_order').default(0),
  totalTokens:  integer('total_tokens').default(0),
  lastUsedAt:   integer('last_used_at').default(0),
  createdAt:    integer('created_at').default(sql`(unixepoch())`),
}, (t) => ({
  userKeyIdx: index('idx_keys_user').on(t.userId),
  provIdx:    index('idx_keys_prov').on(t.userId, t.providerSlug, t.status),
}));

// ─── Combos ───────────────────────────────────────────────────────────────────
// A combo = named routing preset: which providers to use + policy + optional model overrides
export const combos = table('combos', {
  id:            integer('id').primaryKey({ autoIncrement: true }),
  userId:        integer('user_id').notNull(),
  name:          text('name').notNull(),          // User-given label, e.g. "سریع و رایگان"
  providerSlugs: text('provider_slugs').notNull(),// JSON array of slugs in priority order
  routingPolicy: text('routing_policy').default('fallback'), // fallback|round_robin|smart_router|least_used
  modelOverrides:text('model_overrides'),         // JSON: {"gemini": "gemini-2.5-pro"}
  isDefault:     integer('is_default').default(0),
  createdAt:     integer('created_at').default(sql`(unixepoch())`),
}, (t) => ({
  userComboIdx: index('idx_combos_user').on(t.userId),
}));

// ─── Chat History ─────────────────────────────────────────────────────────────
export const chatHistory = table('chat_history', {
  id:        integer('id').primaryKey({ autoIncrement: true }),
  userId:    integer('user_id').notNull(),
  role:      text('role').notNull(),     // 'user' | 'assistant'
  content:   text('content').notNull(),
  provider:  text('provider'),
  model:     text('model'),
  tokens:    integer('tokens').default(0),
  createdAt: integer('created_at').default(sql`(unixepoch())`),
}, (t) => ({
  userHistIdx: index('idx_hist_user_time').on(t.userId, t.createdAt),
}));

// ─── Token Usage ──────────────────────────────────────────────────────────────
export const tokenUsage = table('token_usage', {
  id:               integer('id').primaryKey({ autoIncrement: true }),
  userId:           integer('user_id').notNull(),
  keyId:            integer('key_id'),
  provider:         text('provider').notNull(),
  model:            text('model'),
  promptTokens:     integer('prompt_tokens').default(0),
  completionTokens: integer('completion_tokens').default(0),
  totalTokens:      integer('total_tokens').default(0),
  createdAt:        integer('created_at').default(sql`(unixepoch())`),
}, (t) => ({
  userUsageIdx: index('idx_usage_user').on(t.userId, t.createdAt),
}));
