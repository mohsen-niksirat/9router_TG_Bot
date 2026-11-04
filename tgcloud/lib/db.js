import { db } from 'sdk';
import { eq, and, desc, asc, sql } from 'sdk/db';
import { users, userProviders, userKeys, combos, chatHistory, tokenUsage, mediaGroupBuffer, savedPrompts, chatClaims, config, chatSessions } from 'schema';
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
  const tgId = Number(tgUser.id);
  await db.run(sql`ALTER TABLE users ADD COLUMN stream_mode INTEGER DEFAULT 1`).catch(() => {});
  let user = await db.select().from(users).where(eq(users.tgId, tgId)).get();
  if (user) {
    // Auto-seed any newly added built-in providers in ONE pass: fetch the
    // user's existing slugs once instead of querying existence per built-in
    // (this ran on every message — 7 round-trips per chat before this fix).
    const existing = await db.select().from(userProviders)
      .where(eq(userProviders.userId, user.id))
      .all();
    const bySlug = new Map(existing.map((r) => [r.slug, r]));

    for (const p of BUILTIN_PROVIDERS) {
      const found = bySlug.get(p.slug);
      if (!found) {
        await db.insert(userProviders).values({
          userId:       user.id,
          name:         p.name,
          slug:         p.slug,
          baseUrl:      p.baseUrl,
          defaultModel: p.defaultModel,
          models:       JSON.stringify(p.models),
          isBuiltin:    1,
        }).run();
      } else if (p.slug === 'manus' && (found.baseUrl !== p.baseUrl || found.defaultModel === 'manus-1')) {
        await db.update(userProviders)
          .set({
            baseUrl:      p.baseUrl,
            defaultModel: p.defaultModel,
            models:       JSON.stringify(p.models),
          })
          .where(eq(userProviders.id, found.id))
          .run();
      } else {
        try {
          const currentModels = JSON.parse(found.models || '[]');
          const missing = p.models.filter((m) => !currentModels.includes(m));
          if (missing.length > 0) {
            await db.update(userProviders)
              .set({ models: JSON.stringify([...currentModels, ...missing]) })
              .where(eq(userProviders.id, found.id))
              .run();
          }
        } catch {}
      }
    }
    return { user, isNew: false };
  }

  const [created] = await db
    .insert(users)
    .values({
      tgId,
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

export async function toggleUserStreamMode(userId) {
  const u = await db.select().from(users).where(eq(users.id, userId)).get();
  const current = (u && typeof u.streamMode === 'number') ? u.streamMode : 1;
  const next = current === 1 ? 0 : 1;
  await db.update(users).set({ streamMode: next }).where(eq(users.id, userId)).run();
  return next;
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

export async function getProviderById(id, userId) {
  return await db.select().from(userProviders)
    .where(and(eq(userProviders.id, id), eq(userProviders.userId, userId)))
    .get() || null;
}

export async function updateProviderModels(id, userId, models, defaultModel = null) {
  const patch = {
    models: JSON.stringify(models),
  };
  if (defaultModel) patch.defaultModel = defaultModel;
  else if (models && models.length > 0) patch.defaultModel = models[0];

  await db.update(userProviders).set(patch)
    .where(and(eq(userProviders.id, id), eq(userProviders.userId, userId))).run();
}

export async function updateProviderDefaultModel(id, userId, defaultModel) {
  await db.update(userProviders).set({
    defaultModel,
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
  const encrypted = await encryptKey(apiKey, tgId);
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

export async function reactivateKey(id, userId) {
  await db.update(userKeys).set({
    status: 'active',
    cooldownUntil: 0,
    failureCount: 0,
  }).where(and(eq(userKeys.id, id), eq(userKeys.userId, userId))).run();
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

  if (statusCode >= 500) {
    // Upstream flaked (5xx / network failure — routeChat passes 500 when the
    // error has no status). Sit the key out briefly so the *next* request also
    // rotates past it instead of hitting the same broken endpoint first.
    await db.update(userKeys).set({
      status:        'cooldown',
      cooldownUntil: now + 30,
      lastUsedAt:    now,
      failureCount:  sql`failure_count + 1`,
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

  // Aggregate in SQL — token_usage grows by one row per chat, so loading the
  // whole table in memory made /stats progressively slower.
  const totals = await db.get(sql`
    SELECT
      COALESCE(SUM(CASE WHEN created_at >= ${dayStart}  THEN total_tokens END), 0) AS today,
      COALESCE(SUM(CASE WHEN created_at >= ${weekAgo}   THEN total_tokens END), 0) AS week,
      COALESCE(SUM(CASE WHEN created_at >= ${monthAgo}  THEN total_tokens END), 0) AS month,
      COALESCE(SUM(total_tokens), 0) AS alltime
    FROM token_usage
    WHERE user_id = ${userId}
  `) || {};

  const rows = await db.all(sql`
    SELECT COALESCE(provider, 'unknown') AS provider, COALESCE(SUM(total_tokens), 0) AS total
    FROM token_usage
    WHERE user_id = ${userId}
    GROUP BY provider
  `);

  const byProvider = {};
  for (const r of rows) {
    const key = String(r.provider).toLowerCase();
    byProvider[key] = (byProvider[key] || 0) + (Number(r.total) || 0); // merge, don't overwrite mixed-case rows
  }

  return {
    today:    Number(totals.today)    || 0,
    week:     Number(totals.week)     || 0,
    month:    Number(totals.month)    || 0,
    allTime:  Number(totals.alltime)  || 0,
    byProvider,
  };
}

// ─── Media Group Buffer (Multi-Photo Albums) ──────────────────────────────────
export async function addMediaGroupItem(mediaGroupId, userId, chatId, fileId, caption = '') {
  const [created] = await db.insert(mediaGroupBuffer).values({
    mediaGroupId: String(mediaGroupId),
    userId,
    chatId,
    fileId,
    caption: caption || '',
  }).returning().run();
  return created;
}

export async function getMediaGroupItems(mediaGroupId) {
  return await db.select().from(mediaGroupBuffer)
    .where(eq(mediaGroupBuffer.mediaGroupId, String(mediaGroupId)))
    .orderBy(asc(mediaGroupBuffer.id))
    .all();
}

export async function clearMediaGroupItems(mediaGroupId) {
  await db.delete(mediaGroupBuffer)
    .where(eq(mediaGroupBuffer.mediaGroupId, String(mediaGroupId)))
    .run();
}

/**
 * Remove exactly the rows a completed coordinator consumed. Rows inserted by
 * lagging sibling updates (after the coordinator's last read) are left in the
 * buffer so their own update can schedule them instead of losing them.
 */
export async function consumeMediaGroupItems(mediaGroupId, ids) {
  for (const id of ids) {
    await db.delete(mediaGroupBuffer)
      .where(and(
        eq(mediaGroupBuffer.id, id),
        eq(mediaGroupBuffer.mediaGroupId, String(mediaGroupId)),
      ))
      .run();
  }
}

// ─── Chat Session Management ──────────────────────────────────────────────────
export async function archiveCurrentSession(userId) {
  try {
    const user = await db.select().from(users).where(eq(users.id, userId)).get();
    if (!user) return null;

    const historyRows = await db.select()
      .from(chatHistory)
      .where(eq(chatHistory.userId, userId))
      .orderBy(asc(chatHistory.createdAt))
      .all();

    if ((!historyRows || historyRows.length === 0) && !user.currentTaskId) {
      return null;
    }

    const userMsgs = (historyRows || []).filter((r) => r.role === 'user');
    let title = '';
    if (userMsgs.length > 0) {
      title = (userMsgs[0].content || '')
        .replace(/\[Image:.*?\]/g, '')
        .replace(/📄 محتوای فایل ضمیمه‌شده.*?\`\`\`/s, '')
        .trim();
      title = title.split('\n')[0].trim().slice(0, 45);
    }
    if (!title) {
      title = user.currentTaskId
        ? `تسک مانوس (${user.currentTaskId.slice(0, 8)})`
        : `گفتگوی هوش مصنوعی (${new Date().toLocaleDateString('fa-IR')})`;
    }

    const lastAsst = [...(historyRows || [])].reverse().find((r) => r.role === 'assistant');
    const provider = lastAsst?.provider || null;
    const model = lastAsst?.model || null;

    const messagesJson = JSON.stringify(
      (historyRows || []).map((r) => ({
        role: r.role,
        content: r.content,
        provider: r.provider || null,
        model: r.model || null,
        tokens: r.tokens || 0,
      }))
    );

    const now = Math.floor(Date.now() / 1000);
    const [created] = await db.insert(chatSessions).values({
      userId,
      title,
      provider,
      model,
      taskId: user.currentTaskId || null,
      comboId: user.activeComboId || null,
      keyId: user.activeKeyId || null,
      messageCount: historyRows.length,
      messagesJson,
      createdAt: now,
      updatedAt: now,
    }).returning().run();

    // Prune old sessions beyond 25 per user
    const userSessions = await db.select({ id: chatSessions.id })
      .from(chatSessions)
      .where(eq(chatSessions.userId, userId))
      .orderBy(desc(chatSessions.updatedAt))
      .all();

    if (userSessions.length > 25) {
      const dropIds = userSessions.slice(25).map((s) => s.id);
      for (const dId of dropIds) {
        await db.delete(chatSessions).where(eq(chatSessions.id, dId)).run();
      }
    }

    return created;
  } catch (err) {
    console.warn('[9Router] archiveCurrentSession error:', err);
    return null;
  }
}

export async function getChatSessions(userId, limit = 10) {
  try {
    return await db.select({
      id: chatSessions.id,
      title: chatSessions.title,
      provider: chatSessions.provider,
      model: chatSessions.model,
      taskId: chatSessions.taskId,
      messageCount: chatSessions.messageCount,
      updatedAt: chatSessions.updatedAt,
      createdAt: chatSessions.createdAt,
    })
      .from(chatSessions)
      .where(eq(chatSessions.userId, userId))
      .orderBy(desc(chatSessions.updatedAt))
      .limit(limit)
      .all();
  } catch (err) {
    console.warn('[9Router] getChatSessions error:', err);
    return [];
  }
}

export async function getChatSessionById(sessionId, userId) {
  try {
    const sId = parseInt(sessionId, 10);
    return await db.select()
      .from(chatSessions)
      .where(and(eq(chatSessions.id, sId), eq(chatSessions.userId, userId)))
      .get();
  } catch (err) {
    console.warn('[9Router] getChatSessionById error:', err);
    return null;
  }
}

export async function deleteChatSession(sessionId, userId) {
  try {
    const sId = parseInt(sessionId, 10);
    await db.delete(chatSessions)
      .where(and(eq(chatSessions.id, sId), eq(chatSessions.userId, userId)))
      .run();
    return true;
  } catch (err) {
    console.warn('[9Router] deleteChatSession error:', err);
    return false;
  }
}

export async function restoreChatSession(sessionId, userId) {
  const sId = parseInt(sessionId, 10);
  const session = await getChatSessionById(sId, userId);
  if (!session) return null;

  // Archive current session first if active
  await archiveCurrentSession(userId);

  // Clear active chatHistory
  await clearHistory(userId);

  // Populate active chatHistory from session.messagesJson
  if (session.messagesJson) {
    try {
      const msgs = JSON.parse(session.messagesJson);
      for (const m of msgs) {
        await db.insert(chatHistory).values({
          userId,
          role: m.role,
          content: m.content,
          provider: m.provider || null,
          model: m.model || null,
          tokens: m.tokens || 0,
        }).run();
      }
    } catch (e) {
      console.warn('[9Router] restoreChatSession json parse failed:', e);
    }
  }

  // Reactivate session on user
  const patch = {
    chatSessionActive: 1,
    currentTaskId: session.taskId || null,
  };
  if (session.keyId) {
    patch.activeKeyId = session.keyId;
    patch.activeComboId = null;
  } else if (session.comboId) {
    patch.activeComboId = session.comboId;
    patch.activeKeyId = null;
  }
  await db.update(users).set(patch).where(eq(users.id, userId)).run();

  return session;
}

export async function startChatSession(userId, { comboId = null, keyId = null } = {}) {
  await archiveCurrentSession(userId);
  await clearHistory(userId);
  const patch = {
    chatSessionActive: 1,
    currentTaskId: null,
  };
  if (comboId !== null) {
    patch.activeComboId = comboId;
    patch.activeKeyId = null;
  } else if (keyId !== null) {
    patch.activeKeyId = keyId;
    patch.activeComboId = null;
  }
  await db.update(users).set(patch).where(eq(users.id, userId)).run();
}

export async function endChatSession(userId) {
  await archiveCurrentSession(userId);
  await clearHistory(userId);
  await db.update(users).set({
    chatSessionActive: 0,
    currentTaskId: null,
  }).where(eq(users.id, userId)).run();
}

export async function setSessionTaskId(userId, taskId) {
  await db.update(users).set({
    currentTaskId: taskId,
  }).where(eq(users.id, userId)).run();
}

// ─── Saved Prompts Library ────────────────────────────────────────────────────
export async function addSavedPrompt(userId, { title, prompt }) {
  const [created] = await db.insert(savedPrompts).values({
    userId,
    title: title.trim(),
    prompt: prompt.trim(),
  }).returning().run();
  return created;
}

export async function getSavedPrompts(userId) {
  return await db.select().from(savedPrompts)
    .where(eq(savedPrompts.userId, userId))
    .orderBy(desc(savedPrompts.id))
    .all();
}

export async function getSavedPromptById(id, userId) {
  return await db.select().from(savedPrompts)
    .where(and(eq(savedPrompts.id, id), eq(savedPrompts.userId, userId)))
    .get() || null;
}

export async function deleteSavedPrompt(id, userId) {
  await db.delete(savedPrompts)
    .where(and(eq(savedPrompts.id, id), eq(savedPrompts.userId, userId)))
    .run();
}

/**
 * Searches for any saved prompt references in text and expands them.
 * Supports:
 * - "پرامپت <نام>" or "پرامپت: <نام>"
 * - "#<نام>"
 * - Exact match of prompt title
 *
 * @returns {{ resolvedText: string, matchedTitle: string|null }}
 */
export async function resolveSavedPrompts(userId, text) {
  if (!text || typeof text !== 'string') return { resolvedText: text, matchedTitle: null };
  const prompts = await getSavedPrompts(userId);
  if (!prompts.length) return { resolvedText: text, matchedTitle: null };

  let resolved = text;
  let matchedTitle = null;

  for (const p of prompts) {
    const t = p.title.trim();
    if (!t) continue;
    const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    // 1. Exact match
    if (text.trim().toLowerCase() === t.toLowerCase()) {
      return { resolvedText: p.prompt, matchedTitle: t };
    }

    // 2. "پرامپت: <title>" or "پرامپت <title>"
    const promptRegex = new RegExp(`پرامپت\\s*:?\\s*${escaped}`, 'gi');
    if (promptRegex.test(resolved)) {
      resolved = resolved.replace(promptRegex, p.prompt);
      matchedTitle = t;
    }

    // 3. "#<title>"
    const tagRegex = new RegExp(`#${escaped}`, 'gi');
    if (tagRegex.test(resolved)) {
      resolved = resolved.replace(tagRegex, p.prompt);
      matchedTitle = t;
    }
  }

  return { resolvedText: resolved, matchedTitle };
}

// ─── Live Request Cancellation ────────────────────────────────────────────────
export async function cancelChatRequest(userId, reqId) {
  try {
    await db.insert(chatClaims).values({
      userId,
      fingerprint: `cancel_${reqId}`,
    }).run();
  } catch {}
}

export async function isChatRequestCancelled(userId, reqId) {
  try {
    const row = await db.select().from(chatClaims)
      .where(and(eq(chatClaims.userId, userId), eq(chatClaims.fingerprint, `cancel_${reqId}`)))
      .get();
    return !!row;
  } catch {
    return false;
  }
}

// ─── Group Chat Controls ──────────────────────────────────────────────────────
export async function setGroupMuted(chatId, isMuted) {
  try {
    const k = `group_muted_${chatId}`;
    await db.delete(config).where(eq(config.key, k)).run();
    if (isMuted) {
      await db.insert(config).values({ key: k, value: '1' }).run();
    }
  } catch (e) {
    console.warn('[9Router] setGroupMuted error:', e);
  }
}

export async function isGroupMuted(chatId) {
  try {
    const row = await db.select().from(config).where(eq(config.key, `group_muted_${chatId}`)).get();
    return row?.value === '1';
  } catch {
    return false;
  }
}

// ─── Bot Admin & Analytics ───────────────────────────────────────────────────
export async function getAdminTgIds() {
  try {
    const row = await db.select().from(config).where(eq(config.key, 'admin_tg_ids')).get();
    if (row && row.value) {
      return row.value.split(',').map((id) => id.trim()).filter(Boolean);
    }
    // If not explicitly configured, the first registered user is owner/admin
    const firstUser = await db.select({ tgId: users.tgId }).from(users).orderBy(asc(users.id)).limit(1).get();
    if (firstUser && firstUser.tgId) {
      return [String(firstUser.tgId)];
    }
    return [];
  } catch {
    return [];
  }
}

export async function isBotAdmin(tgId) {
  try {
    const admins = await getAdminTgIds();
    if (admins.length === 0) return true;
    return admins.includes(String(tgId));
  } catch {
    return false;
  }
}

export async function addAdminTgId(tgId) {
  try {
    const admins = await getAdminTgIds();
    const strId = String(tgId).trim();
    if (!admins.includes(strId)) {
      admins.push(strId);
      await db.delete(config).where(eq(config.key, 'admin_tg_ids')).run();
      await db.insert(config).values({ key: 'admin_tg_ids', value: admins.join(',') }).run();
    }
    return true;
  } catch {
    return false;
  }
}

export async function getBotAdminStats() {
  const totalUsersRow = await db.get(sql`SELECT COUNT(*) AS count FROM users`) || {};
  const totalSessionsRow = await db.get(sql`SELECT COUNT(*) AS count FROM chat_sessions`) || {};
  const totalKeysRow = await db.get(sql`SELECT COUNT(*) AS count FROM user_keys`) || {};
  const totalTokensRow = await db.get(sql`SELECT COALESCE(SUM(total_tokens), 0) AS count FROM token_usage`) || {};

  const now = Math.floor(Date.now() / 1000);
  const dayStart = now - (now % 86400);
  const todayActiveRow = await db.get(sql`
    SELECT COUNT(DISTINCT user_id) AS count FROM token_usage WHERE created_at >= ${dayStart}
  `) || {};

  return {
    totalUsers: totalUsersRow.count || 0,
    totalSessions: totalSessionsRow.count || 0,
    totalKeys: totalKeysRow.count || 0,
    totalTokens: totalTokensRow.count || 0,
    todayActive: todayActiveRow.count || 0,
  };
}

export async function getUsersPage(page = 0, pageSize = 10) {
  const offset = page * pageSize;
  const rows = await db.all(sql`
    SELECT id, tg_id AS tgId, name, username, created_at AS createdAt
    FROM users
    ORDER BY id DESC
    LIMIT ${pageSize} OFFSET ${offset}
  `) || [];

  const totalRow = await db.get(sql`SELECT COUNT(*) AS count FROM users`) || {};
  const total = totalRow.count || 0;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));

  return {
    users: rows,
    page,
    totalPages,
    total,
  };
}
