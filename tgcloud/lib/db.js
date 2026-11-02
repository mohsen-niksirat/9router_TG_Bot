import { db } from 'sdk';
import { eq, and, desc, asc, sql } from 'sdk/db';
import { users, userProviders, userKeys, combos, chatHistory, tokenUsage } from 'schema';
import { encryptKey, decryptKey } from 'lib/crypto';
import { BUILTIN_PROVIDERS } from 'lib/providers';

// ─── Helper ───────────────────────────────────────────────────────────────────
function parseJson(v, fallback = null) {
  if (!v) return fallback;
  if (typeof v === 'object') return v;
  try { return JSON.parse(v); } catch { return fallback; }
}

// ─── Users ────────────────────────────────────────────────────────────────────

export async function getOrCreateUser(tgUser) {
  let user = await db.select().from(users).where(eq(users.tgId, tgUser.id)).get();
  if (user) return { user, isNew: false };

  const [created] = await db
    .insert(users)
    .values({
      tgId:        tgUser.id,
      name:        tgUser.first_name || '',
      username:    tgUser.username || '',
      wizardState: 'idle',
    })
    .returning()
    .run();

  // Seed built-in providers for this user
  for (const p of BUILTIN_PROVIDERS) {
    await db.insert(userProviders).values({
      userId:       created.id,
      name:         p.name,
      slug:         p.slug,
      baseUrl:      p.baseUrl,
      defaultModel: p.defaultModel,
      models:       JSON.stringify(p.models),
      isBuiltin:    1,
    }).run();
  }

  return { user: created, isNew: true };
}

export async function getUser(tgId) {
  if (!tgId) return null;
  return await db.select().from(users).where(eq(users.tgId, tgId)).get() || null;
}

export async function updateUser(tgId, patch) {
  await db.update(users).set(patch).where(eq(users.tgId, tgId)).run();
  return getUser(tgId);
}

export async function setWizard(tgId, state, data = null) {
  const patch = { wizardState: state };
  if (data !== undefined) {
    patch.wizardData = data ? JSON.stringify(data) : null;
  }
  await db.update(users).set(patch).where(eq(users.tgId, tgId)).run();
}

export async function clearWizard(tgId) {
  await db.update(users).set({ wizardState: 'idle', wizardData: null }).where(eq(users.tgId, tgId)).run();
}

export function parseWizardData(user) {
  return parseJson(user.wizardData, {});
}

// ─── User Providers ───────────────────────────────────────────────────────────

export async function getUserProviders(userId) {
  return await db.select().from(userProviders)
    .where(eq(userProviders.userId, userId))
    .orderBy(asc(userProviders.id))
    .all();
}

export async function getProviderBySlug(userId, slug) {
  return await db.select().from(userProviders)
    .where(and(eq(userProviders.userId, userId), eq(userProviders.slug, slug)))
    .get() || null;
}

export async function addCustomProvider(userId, { name, baseUrl, defaultModel = null, models = [] }) {
  const slug = `c_${Date.now()}`;
  const [created] = await db.insert(userProviders).values({
    userId,
    name,
    slug,
    baseUrl: baseUrl.replace(/\/+$/, ''),
    defaultModel: defaultModel || models[0] || 'gpt-4o-mini',
    models: JSON.stringify(models.length ? models : ['gpt-4o-mini']),
    isBuiltin: 0,
  }).returning().run();
  return created;
}

export async function updateProviderModels(id, userId, models, defaultModel = null) {
  await db.update(userProviders).set({
    models:       JSON.stringify(models),
    defaultModel: defaultModel || models[0] || null,
  }).where(and(eq(userProviders.id, id), eq(userProviders.userId, userId))).run();
}

export async function deleteCustomProvider(id, userId) {
  const prov = await db.select().from(userProviders)
    .where(and(eq(userProviders.id, id), eq(userProviders.userId, userId), eq(userProviders.isBuiltin, 0)))
    .get();
  if (!prov) return false;
  // Remove all keys for this provider
  await db.delete(userKeys)
    .where(and(eq(userKeys.userId, userId), eq(userKeys.providerSlug, prov.slug)))
    .run();
  // Remove from combos' provider_slugs
  const userCombos = await db.select().from(combos).where(eq(combos.userId, userId)).all();
  for (const combo of userCombos) {
    const slugs = parseJson(combo.providerSlugs, []).filter((s) => s !== prov.slug);
    await db.update(combos).set({ providerSlugs: JSON.stringify(slugs) }).where(eq(combos.id, combo.id)).run();
  }
  await db.delete(userProviders)
    .where(and(eq(userProviders.id, id), eq(userProviders.userId, userId)))
    .run();
  return true;
}

// ─── User Keys ────────────────────────────────────────────────────────────────

export async function addKey(userId, tgId, { providerSlug, apiKey, label }) {
  const encrypted = encryptKey(apiKey, tgId);
  const last = await db.select({ sortOrder: userKeys.sortOrder })
    .from(userKeys)
    .where(and(eq(userKeys.userId, userId), eq(userKeys.providerSlug, providerSlug)))
    .orderBy(desc(userKeys.sortOrder))
    .limit(1)
    .get();
  const nextOrder = (last?.sortOrder || 0) + 1;

  const [created] = await db.insert(userKeys).values({
    userId,
    providerSlug,
    apiKeyEnc: encrypted,
    label:     label || `${providerSlug.toUpperCase()} Key #${nextOrder}`,
    status:    'active',
    sortOrder: nextOrder,
  }).returning().run();
  return created;
}

export async function getKeys(userId, providerSlug = null) {
  let query = db.select().from(userKeys).where(eq(userKeys.userId, userId));
  if (providerSlug) {
    query = db.select().from(userKeys)
      .where(and(eq(userKeys.userId, userId), eq(userKeys.providerSlug, providerSlug)));
  }
  return await query.orderBy(asc(userKeys.sortOrder), asc(userKeys.id)).all();
}

export async function getKeyById(id, userId) {
  return await db.select().from(userKeys)
    .where(and(eq(userKeys.id, id), eq(userKeys.userId, userId)))
    .get() || null;
}

export async function deleteKey(id, userId) {
  await db.delete(userKeys).where(and(eq(userKeys.id, id), eq(userKeys.userId, userId))).run();
}

export async function moveKeyPriority(keyId, direction, userId) {
  const all = await db.select().from(userKeys)
    .where(eq(userKeys.userId, userId))
    .orderBy(asc(userKeys.sortOrder), asc(userKeys.id))
    .all();
  const idx = all.findIndex((k) => k.id === keyId);
  if (idx === -1) return;

  if (direction === 'up' && idx > 0) {
    const prev = all[idx - 1];
    const curr = all[idx];
    await db.update(userKeys).set({ sortOrder: prev.sortOrder }).where(eq(userKeys.id, curr.id)).run();
    await db.update(userKeys).set({ sortOrder: curr.sortOrder }).where(eq(userKeys.id, prev.id)).run();
  } else if (direction === 'down' && idx < all.length - 1) {
    const next = all[idx + 1];
    const curr = all[idx];
    await db.update(userKeys).set({ sortOrder: next.sortOrder }).where(eq(userKeys.id, curr.id)).run();
    await db.update(userKeys).set({ sortOrder: curr.sortOrder }).where(eq(userKeys.id, next.id)).run();
  }
}

export async function markKeyResult(keyId, success, statusCode = 200) {
  const now = Math.floor(Date.now() / 1000);
  if (success) {
    await db.update(userKeys).set({
      lastUsedAt:   now,
      failureCount: 0,
      status:       'active',
    }).where(eq(userKeys.id, keyId)).run();
    return;
  }

  if (statusCode === 429) {
    await db.update(userKeys).set({
      status:        'cooldown',
      cooldownUntil: now + 60,
      lastUsedAt:    now,
      failureCount:  sql`failure_count + 1`,
    }).where(eq(userKeys.id, keyId)).run();
    return;
  }

  if (statusCode === 401 || statusCode === 403) {
    await db.update(userKeys).set({
      status:       'dead',
      lastUsedAt:   now,
      failureCount: sql`failure_count + 1`,
    }).where(eq(userKeys.id, keyId)).run();
    return;
  }

  await db.update(userKeys).set({
    lastUsedAt:   now,
    failureCount: sql`failure_count + 1`,
  }).where(eq(userKeys.id, keyId)).run();
}

// ─── Combos ───────────────────────────────────────────────────────────────────

export async function getCombos(userId) {
  return await db.select().from(combos)
    .where(eq(combos.userId, userId))
    .orderBy(asc(combos.id))
    .all();
}

export async function getComboById(id, userId) {
  return await db.select().from(combos)
    .where(and(eq(combos.id, id), eq(combos.userId, userId)))
    .get() || null;
}

export async function getActiveCombo(user) {
  if (!user.activeComboId) return null;
  return await db.select().from(combos)
    .where(and(eq(combos.id, user.activeComboId), eq(combos.userId, user.id)))
    .get() || null;
}

export async function createCombo(userId, { name, providerSlugs, routingPolicy = 'fallback', modelOverrides = {} }) {
  const [created] = await db.insert(combos).values({
    userId,
    name,
    providerSlugs:  JSON.stringify(providerSlugs),
    routingPolicy,
    modelOverrides: JSON.stringify(modelOverrides),
    isDefault:      0,
  }).returning().run();
  return created;
}

export async function updateCombo(id, userId, patch) {
  if (patch.providerSlugs && Array.isArray(patch.providerSlugs)) {
    patch.providerSlugs = JSON.stringify(patch.providerSlugs);
  }
  if (patch.modelOverrides && typeof patch.modelOverrides === 'object') {
    patch.modelOverrides = JSON.stringify(patch.modelOverrides);
  }
  await db.update(combos).set(patch).where(and(eq(combos.id, id), eq(combos.userId, userId))).run();
}

export async function deleteCombo(id, userId) {
  await db.delete(combos).where(and(eq(combos.id, id), eq(combos.userId, userId))).run();
}

export function parseCombo(combo) {
  if (!combo) return null;
  return {
    ...combo,
    providerSlugs:  parseJson(combo.providerSlugs, []),
    modelOverrides: parseJson(combo.modelOverrides, {}),
  };
}

// ─── Chat History ─────────────────────────────────────────────────────────────

export const HISTORY_LIMIT = 20; // last N turns kept per user

export async function appendHistory(userId, role, content, provider = null, model = null, tokens = 0) {
  await db.insert(chatHistory).values({ userId, role, content, provider, model, tokens }).run();

  // Prune old messages (keep last HISTORY_LIMIT * 2 rows = HISTORY_LIMIT turns)
  const allRows = await db.select({ id: chatHistory.id })
    .from(chatHistory)
    .where(eq(chatHistory.userId, userId))
    .orderBy(desc(chatHistory.id))
    .all();

  if (allRows.length > HISTORY_LIMIT * 2) {
    const keepIds = allRows.slice(0, HISTORY_LIMIT * 2).map((r) => r.id);
    const minKeepId = Math.min(...keepIds);
    await db.run(
      `DELETE FROM chat_history WHERE user_id = :uid AND id < :minId`,
      { ':uid': userId, ':minId': minKeepId }
    );
  }
}

export async function getHistory(userId) {
  const rows = await db.select()
    .from(chatHistory)
    .where(eq(chatHistory.userId, userId))
    .orderBy(asc(chatHistory.createdAt))
    .all();

  return rows.map((r) => ({ role: r.role, content: r.content }));
}

export async function clearHistory(userId) {
  await db.run(`DELETE FROM chat_history WHERE user_id = :uid`, { ':uid': userId });
}

// ─── Token Usage ──────────────────────────────────────────────────────────────

export async function recordUsage({ userId, keyId, provider, model, promptTokens, completionTokens }) {
  const total = (promptTokens || 0) + (completionTokens || 0);
  await db.insert(tokenUsage).values({
    userId, keyId, provider, model,
    promptTokens, completionTokens, totalTokens: total,
  }).run();
  if (keyId && total > 0) {
    await db.update(userKeys).set({
      totalTokens: sql`COALESCE(total_tokens, 0) + ${total}`,
    }).where(eq(userKeys.id, keyId)).run();
  }
}

export async function getUsageStats(userId) {
  const now = Math.floor(Date.now() / 1000);
  const dayStart = now - (now % 86400);
  const weekAgo  = now - 7 * 86400;
  const monthAgo = now - 30 * 86400;

  const all = await db.select().from(tokenUsage)
    .where(eq(tokenUsage.userId, userId))
    .all();

  let today = 0, week = 0, month = 0, allTime = 0;
  const byProvider = {};

  for (const row of all) {
    const t = row.totalTokens || 0;
    allTime += t;
    if (row.createdAt >= monthAgo) month += t;
    if (row.createdAt >= weekAgo)  week  += t;
    if (row.createdAt >= dayStart) today += t;
    const p = (row.provider || 'unknown').toLowerCase();
    byProvider[p] = (byProvider[p] || 0) + t;
  }

  return { today, week, month, allTime, byProvider };
}
