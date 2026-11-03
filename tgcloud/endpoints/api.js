/**
 * 9Router TG Bot — Mini App API Endpoint
 * Handles all Mini App requests: chat, key/combo management, stats
 * URL: https://app9029829582.tgcloud.ai/endpoints/api
 */

import { db } from 'sdk';
import { eq, and } from 'sdk/db';
import { users } from 'schema';
import {
  getOrCreateUser,
  getUser,
  updateUser,
  getKeys,
  addKey,
  deleteKey,
  moveKeyPriority,
  getUserProviders,
  addCustomProvider,
  updateProviderModels,
  deleteCustomProvider,
  getCombos,
  getComboById,
  createCombo,
  getActiveCombo,
  deleteCombo,
  parseCombo,
  getHistory,
  clearHistory,
  getUsageStats,
} from 'lib/db';
import { sendChat } from 'lib/chat';
import { maskKey, decryptKey } from 'lib/crypto';
import { ROUTING_POLICIES } from 'lib/providers';

// ─── Auth Resolution ──────────────────────────────────────────────────────────
function resolveUserId(input, ctx) {
  // 1. Telegram-verified initData in ctx (when running inside telegram serverless)
  if (ctx?.initData?.user?.id) {
    return { userId: ctx.initData.user.id, userObj: ctx.initData.user, trusted: true };
  }

  // 2. Client sent initData in body or headers
  const rawInitData = input?.initData || ctx?.headers?.['x-telegram-init-data'];
  if (rawInitData && typeof rawInitData === 'string') {
    try {
      const sp = new URLSearchParams(rawInitData);
      const userStr = sp.get('user');
      if (userStr) {
        const u = JSON.parse(userStr);
        if (u && u.id) {
          return { userId: u.id, userObj: u, trusted: true };
        }
      }
    } catch {}
  }

  // 3. UID from query param or body
  const uid = parseInt(input?.uid || input?.userId || 0, 10);
  if (uid > 10000) {
    return { userId: uid, userObj: { id: uid, first_name: 'User' }, trusted: true };
  }

  return { userId: null, userObj: null, trusted: false };
}

// ─── Main Handler ─────────────────────────────────────────────────────────────
export default async function (input, ctx) {
  const { userId, userObj, trusted } = resolveUserId(input, ctx);

  if (!userId) {
    return { ok: false, status: 401, error: 'احراز هویت الزامی است. لطفاً ربات را مجدداً استارت کنید.' };
  }

  const action = (input?.action || 'get_data').toLowerCase();

  // Get or create user
  const tgUser = userObj || { id: userId, first_name: 'User' };
  const { user } = await getOrCreateUser(tgUser);

  // ─── get_data ───────────────────────────────────────────────────────────────
  if (action === 'get_data' || action === 'overview') {
    const allKeys = await getKeys(user.id);
    const providers = await getUserProviders(user.id);
    const comboList = await getCombos(user.id);
    const comboRaw = await getActiveCombo(user);
    const stats = await getUsageStats(user.id);

    return {
      ok: true,
      user: {
        id: user.id,
        tgId: user.tgId,
        name: user.name,
        username: user.username,
        activeComboId: user.activeComboId,
      },
      keys: allKeys.map((k) => ({
        id: k.id,
        providerSlug: k.providerSlug,
        label: k.label,
        status: k.status,
        sortOrder: k.sortOrder,
        totalTokens: k.totalTokens || 0,
        failureCount: k.failureCount || 0,
      })),
      providers: providers.map((p) => ({
        id: p.id,
        slug: p.slug,
        name: p.name,
        baseUrl: p.baseUrl,
        defaultModel: p.defaultModel,
        models: (() => { try { return JSON.parse(p.models || '[]'); } catch { return []; } })(),
        isBuiltin: Boolean(p.isBuiltin),
      })),
      combos: comboList.map((c) => ({
        id: c.id,
        name: c.name,
        providerSlugs: (() => { try { return JSON.parse(c.providerSlugs || '[]'); } catch { return []; } })(),
        routingPolicy: c.routingPolicy,
        isActive: c.id === user.activeComboId,
      })),
      activeCombo: parseCombo(comboRaw),
      stats: {
        today: stats.today,
        week: stats.week,
        month: stats.month,
        allTime: stats.allTime,
        byProvider: stats.byProvider,
      },
      routingPolicies: ROUTING_POLICIES,
    };
  }

  // ─── get_history ────────────────────────────────────────────────────────────
  if (action === 'get_history') {
    const history = await getHistory(user.id);
    return { ok: true, history };
  }

  // ─── chat ───────────────────────────────────────────────────────────────────
  if (action === 'chat') {
    const message = (input.message || '').trim();
    if (!message) {
      return { ok: false, error: 'پیام نمی‌تواند خالی باشد.' };
    }

    const comboRaw = await getActiveCombo(user);
    const combo = parseCombo(comboRaw);
    if (!combo || !combo.providerSlugs || combo.providerSlugs.length === 0) {
      return { ok: false, error: 'هیچ کمبویی فعال نیست. ابتدا یک کمبو انتخاب یا ایجاد کنید.' };
    }

    try {
      const result = await sendChat(user, userId, message);
      return {
        ok: true,
        text: result.text,
        provider: result.provider,
        model: result.model,
      };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  // ─── clear_history ──────────────────────────────────────────────────────────
  if (action === 'clear_history') {
    await clearHistory(user.id);
    return { ok: true };
  }

  // ─── get_stats ──────────────────────────────────────────────────────────────
  if (action === 'get_stats') {
    const stats = await getUsageStats(user.id);
    return { ok: true, stats };
  }

  // ─── add_key ────────────────────────────────────────────────────────────────
  if (action === 'add_key') {
    const providerSlug = (input.providerSlug || '').trim();
    const apiKey = (input.apiKey || '').trim();
    const label = (input.label || '').trim();

    if (!providerSlug || !apiKey) {
      return { ok: false, error: 'ارائه‌دهنده و کلید API الزامی هستند.' };
    }
    if (apiKey.length < 8) {
      return { ok: false, error: 'طول کلید وارد شده بیش از حد کوتاه است.' };
    }

    const created = await addKey(user.id, userId, { providerSlug, apiKey, label });
    return { ok: true, key: { id: created.id, label: created.label, providerSlug } };
  }

  // ─── delete_key ─────────────────────────────────────────────────────────────
  if (action === 'delete_key') {
    const keyId = parseInt(input.keyId || input.id, 10);
    if (!keyId) return { ok: false, error: 'شناسه کلید الزامی است.' };
    await deleteKey(keyId, user.id);
    return { ok: true };
  }

  // ─── move_key ───────────────────────────────────────────────────────────────
  if (action === 'move_key') {
    const keyId = parseInt(input.keyId, 10);
    const direction = input.direction; // 'up' | 'down'
    if (!keyId || !['up', 'down'].includes(direction)) {
      return { ok: false, error: 'پارامترهای نادرست.' };
    }
    await moveKeyPriority(keyId, direction, user.id);
    return { ok: true };
  }

  // ─── create_combo ───────────────────────────────────────────────────────────
  if (action === 'create_combo') {
    const name = (input.name || '').trim();
    const providerSlugs = Array.isArray(input.providerSlugs) ? input.providerSlugs : [];
    const routingPolicy = input.routingPolicy || 'fallback';

    if (!name) {
      return { ok: false, error: 'نام کمبو الزامی است.' };
    }
    if (providerSlugs.length === 0) {
      return { ok: false, error: 'حداقل یک ارائه‌دهنده باید انتخاب شود.' };
    }

    const created = await createCombo(user.id, {
      name,
      providerSlugs,
      routingPolicy,
    });

    // Auto-select if no combo currently active
    if (!user.activeComboId) {
      await updateUser(userId, { activeComboId: created.id });
    }

    return { ok: true, combo: created };
  }

  // ─── select_combo ───────────────────────────────────────────────────────────
  if (action === 'select_combo') {
    const comboId = parseInt(input.comboId || input.id, 10);
    if (!comboId) return { ok: false, error: 'شناسه کمبو الزامی است.' };
    const combo = await getComboById(comboId, user.id);
    if (!combo) return { ok: false, error: 'کمبو یافت نشد.' };
    await updateUser(userId, { activeComboId: comboId });
    return { ok: true };
  }

  // ─── deselect_combo ─────────────────────────────────────────────────────────
  if (action === 'deselect_combo') {
    await updateUser(userId, { activeComboId: null });
    return { ok: true };
  }

  // ─── delete_combo ───────────────────────────────────────────────────────────
  if (action === 'delete_combo') {
    const comboId = parseInt(input.comboId || input.id, 10);
    if (!comboId) return { ok: false, error: 'شناسه کمبو الزامی است.' };
    await deleteCombo(comboId, user.id);
    if (user.activeComboId === comboId) {
      await updateUser(userId, { activeComboId: null });
    }
    return { ok: true };
  }

  // ─── add_provider ───────────────────────────────────────────────────────────
  if (action === 'add_provider') {
    const name = (input.name || '').trim();
    const baseUrl = (input.baseUrl || '').trim();
    const defaultModel = (input.defaultModel || '').trim() || null;
    const models = Array.isArray(input.models) ? input.models : [];

    if (!name || !baseUrl) {
      return { ok: false, error: 'نام و Base URL ارائه‌دهنده الزامی هستند.' };
    }

    const created = await addCustomProvider(user.id, {
      name,
      baseUrl,
      defaultModel,
      models,
    });
    return { ok: true, provider: created };
  }

  // ─── update_provider_models ─────────────────────────────────────────────────
  if (action === 'update_provider_models') {
    const provId = parseInt(input.providerId || input.id, 10);
    const modelsRaw = input.models;
    let models = [];
    if (Array.isArray(modelsRaw)) {
      models = modelsRaw.map((s) => String(s).trim()).filter(Boolean);
    } else if (typeof modelsRaw === 'string') {
      models = modelsRaw.split(/[\r\n,،]+/).map((s) => s.trim()).filter(Boolean);
    }
    const defaultModel = input.defaultModel || (models[0] || null);

    if (!provId) return { ok: false, error: 'شناسه ارائه‌دهنده الزامی است.' };
    if (models.length === 0) return { ok: false, error: 'حداقل یک مدل باید وارد شود.' };

    await updateProviderModels(provId, user.id, models, defaultModel);
    return { ok: true, models, defaultModel };
  }

  // ─── delete_provider ────────────────────────────────────────────────────────
  if (action === 'delete_provider') {
    const provId = parseInt(input.providerId || input.id, 10);
    if (!provId) return { ok: false, error: 'شناسه ارائه‌دهنده الزامی است.' };
    const deleted = await deleteCustomProvider(provId, user.id);
    if (!deleted) return { ok: false, error: 'ارائه‌دهنده پیش‌فرض قابل حذف نیست.' };
    return { ok: true };
  }

  return { ok: false, error: `عملیات ناشناخته: ${action}` };
}
