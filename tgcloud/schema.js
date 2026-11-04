import { table, integer, text, index, sql } from 'sdk/db';

// ─── Users ────────────────────────────────────────────────────────────────────
export const users = table('users', {
  id:            integer('id').primaryKey({ autoIncrement: true }),
  tgId:          integer('tg_id').unique().notNull(),
  name:          text('name'),
  username:      text('username'),
  activeComboId:     integer('active_combo_id'),   // FK → combos.id (null = no combo selected)
  activeKeyId:       integer('active_key_id'),     // FK → user_keys.id (null = using combo)
  wizardState:       text('wizard_state').default('idle'),
  wizardData:        text('wizard_data'),           // JSON context for multi-step wizards
  chatSessionActive: integer('chat_session_active').default(0), // 1 = active continuous conversation session
  currentTaskId:     text('current_task_id'),       // active Manus task ID for multi-turn task.sendMessage
  streamMode:        integer('stream_mode').default(1), // 1 = live streaming & live thoughts, 0 = disabled (ticking only)
  createdAt:         integer('created_at').default(sql`(unixepoch())`),
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

// ─── Media Group Buffer (for Multi-Photo Albums) ─────────────────────────────
export const mediaGroupBuffer = table('media_group_buffer', {
  id:           integer('id').primaryKey({ autoIncrement: true }),
  mediaGroupId: text('media_group_id').notNull(),
  userId:       integer('user_id').notNull(),
  chatId:       integer('chat_id').notNull(),
  fileId:       text('file_id').notNull(),
  caption:      text('caption'),
  createdAt:    integer('created_at').default(sql`(unixepoch())`),
}, (t) => ({
  mgIdx: index('idx_mg_id').on(t.mediaGroupId),
}));

// ─── Chat Request Claims (duplicate suppression) ─────────────────────────────
// The Mini App re-sends `chat` when a slow reply outlives its client timeout;
// claiming (userId, fingerprint) before calling the AI keeps one message from
// running — and billing — twice. Rows are consumed on completion; stale ones
// are pruned opportunistically.
export const chatClaims = table('chat_claims', {
  id:          integer('id').primaryKey({ autoIncrement: true }),
  userId:      integer('user_id').notNull(),
  fingerprint: text('fingerprint').notNull(),
  createdAt:   integer('created_at').default(sql`(unixepoch())`),
}, (t) => ({
  claimIdx: index('idx_claim_user').on(t.userId, t.createdAt),
}));

// ─── Config KV (per-install secrets, e.g. the key-encryption secret) ─────────
export const config = table('config', {
  key:   text('key').primaryKey(),
  value: text('value'),
}, () => ({}));

// ─── Deferred Task Delivery Queue ────────────────────────────────────────────
// Manus tasks whose completion outran one invocation's wall/CPU budget. Each
// entry is retried on the user's subsequent updates (the platform is purely
// event-driven — no cron exists) and deleted once the full result is delivered
// into chat_id.
export const pendingTasks = table('pending_tasks', {
  id:        integer('id').primaryKey({ autoIncrement: true }),
  userId:    integer('user_id').notNull(),
  chatId:    integer('chat_id').notNull(),
  taskId:    text('task_id').notNull(),
  createdAt: integer('created_at').default(sql`(unixepoch())`),
}, (t) => ({
  pendIdx: index('idx_pending_user').on(t.userId, t.createdAt),
}));

// ─── Saved Prompts ───────────────────────────────────────────────────────────
// User's custom saved prompt library (e.g. "عکس گچی" with full long prompt)
export const savedPrompts = table('saved_prompts', {
  id:        integer('id').primaryKey({ autoIncrement: true }),
  userId:    integer('user_id').notNull(),
  title:     text('title').notNull(),
  prompt:    text('prompt').notNull(),
  createdAt: integer('created_at').default(sql`(unixepoch())`),
}, (t) => ({
  userPromptIdx: index('idx_prompts_user').on(t.userId),
}));

// ─── Chat Sessions Archive ───────────────────────────────────────────────────
export const chatSessions = table('chat_sessions', {
  id:           integer('id').primaryKey({ autoIncrement: true }),
  userId:       integer('user_id').notNull(),
  title:        text('title').notNull(),
  provider:     text('provider'),
  model:        text('model'),
  taskId:       text('task_id'),
  comboId:      integer('combo_id'),
  keyId:        integer('key_id'),
  messageCount: integer('message_count').default(0),
  messagesJson: text('messages_json'),
  createdAt:    integer('created_at').default(sql`(unixepoch())`),
  updatedAt:    integer('updated_at').default(sql`(unixepoch())`),
}, (t) => ({
  userSessionsIdx: index('idx_sessions_user').on(t.userId, t.updatedAt),
}));
