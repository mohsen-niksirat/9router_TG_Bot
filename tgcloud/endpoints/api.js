/**
 * 9Router TG Bot — Mini App API Endpoint
 * Handles all Mini App requests: chat, key/combo management, stats
 * URL: https://app9029829582.tgcloud.ai/endpoints/api
 */

import { db } from 'sdk';
import { eq, and, gt, lt } from 'sdk/db';
import { users, chatClaims } from 'schema';
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
import { fingerprint } from 'lib/crypto';
import { withTimeout } from 'lib/sleep';
import { ROUTING_POLICIES } from 'lib/providers';

// ─── Auth Resolution ──────────────────────────────────────────────────────────
// ONLY platform-verified init data counts as identity. The gateway rejects any
// request without a valid Telegram init-data signature with 401 BEFORE this
// handler runs (verified live), so a client-supplied `initData`/uid must never
// be parsed or trusted here — those former fallbacks = full impersonation if
// this code ever runs on a non-validating host.
function resolveUserId(ctx) {
  const user = ctx && ctx.initData && ctx.initData.user;
  if (user && user.id) return { userId: Number(user.id), userObj: user };
  return { userId: null, userObj: null };
}

// ─── Main Handler ────────────────────────────────────────────────────────────
export default async function (input, ctx) {
  const { userId, userObj } = resolveUserId(ctx);

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

    // Duplicate suppression: a client that timed out re-sending `chat` would run
    // — and bill — the whole conversation twice. Claim (user, text) first; a
    // concurrent duplicate gets a short notice instead of a second AI call.
    const now = Math.floor(Date.now() / 1000);
    const fp = fingerprint(message);
    await db.delete(chatClaims).where(and(
      eq(chatClaims.userId, user.id),
      lt(chatClaims.createdAt, now - 60),
    )).run();
    const dupClaim = await db.select().from(chatClaims).where(and(
      eq(chatClaims.userId, user.id),
      eq(chatClaims.fingerprint, fp),
      gt(chatClaims.createdAt, now - 15),
    )).get();
    if (dupClaim) {
      return {
        ok: true,
        duplicate: true,
        text: '⏳ این پیام چند لحظه پیش هم ارسال شد و در حال پردازش است — اولین پاسخ به‌زودی می‌رسد.',
      };
    }
    const claimRows = await db.insert(chatClaims)
      .values({ userId: user.id, fingerprint: fp })
      .returning()
      .run();
    const claimId = claimRows && claimRows[0] ? claimRows[0].id : null;

    try {
      // Platform wall cap ∈ (25s, 30s] — 21s total here, leaving room for the
      // claim bookkeeping below so the frontend always gets JSON, never a 500.
      const result = await withTimeout(sendChat(user, userId, message), 21000);
      return {
        ok: true,
        text: result.text,
        provider: result.provider,
        model: result.model,
      };
    } catch (err) {
      if (err && err.isTimeout) {
        return {
          ok: false,
          error: '🕐 پاسخ ارائهدهنده بیش از ۲۱ ثانیه طول کشید و قطع شد. لطفاً دوباره تلاش کنید یا ارائهدهنده دیگری انتخاب کنید.',
        };
      }
      return { ok: false, error: err.message };
    } finally {
      if (claimId != null) {
        await db.delete(chatClaims).where(eq(chatClaims.id, claimId)).run();
      }
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
