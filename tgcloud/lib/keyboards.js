/**
 * Keyboard builders for 9Router TG Bot.
 * All callback_data strings must be ≤ 64 bytes.
 */

import { ROUTING_POLICIES } from 'lib/providers';

// ─── Mini App ─────────────────────────────────────────────────────────────────
export const MINI_APP_BASE_URL = 'https://app9029829582.tgcloud.ai';

export function buildMiniAppUrl(tgId) {
  return `${MINI_APP_BASE_URL}/?uid=${tgId || 0}`;
}

// ─── Escape HTML ──────────────────────────────────────────────────────────────
export function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ─── Main Menu ────────────────────────────────────────────────────────────────
export function mainMenuKeyboard(user, combo) {
  const comboLabel = combo ? `🔀 ${combo.name}` : '🔀 بدون کمبو';
  const miniAppUrl = buildMiniAppUrl(user?.tgId || 0);
  return {
    inline_keyboard: [
      [{ text: '📱 مینی‌اپ چت', web_app: { url: miniAppUrl } }],
      [{ text: '💬 شروع چت جدید', callback_data: 'a:new_chat' }],
      [{ text: comboLabel, callback_data: 'a:combos' }],
      [
        { text: '🔑 کلیدها', callback_data: 'a:keys' },
        { text: '🌐 ارائه‌دهنده‌ها', callback_data: 'a:providers' },
      ],
      [
        { text: '📊 آمار توکن‌ها', callback_data: 'a:stats' },
        { text: '❓ راهنما', callback_data: 'a:help' },
      ],
    ],
  };
}

export function mainReplyKeyboard(tgId) {
  const rows = [];
  if (tgId) {
    rows.push([{ text: '📱 باز کردن مینی‌اپ چت (Mini App)', web_app: { url: buildMiniAppUrl(tgId) } }]);
  }
  rows.push(['💬 چت با هوش مصنوعی', '🔀 کمبوهای من']);
  rows.push(['🔑 مدیریت کلیدها', '🌐 ارائه‌دهنده‌ها']);
  rows.push(['📊 آمار توکن‌ها', '❓ راهنما']);
  return {
    keyboard: rows,
    resize_keyboard: true,
    persistent: true,
  };
}

export function backKeyboard(cb = 'a:menu') {
  return { inline_keyboard: [[{ text: '🔙 بازگشت', callback_data: cb }]] };
}

// ─── Keys Management ──────────────────────────────────────────────────────────
export function keysKeyboard(keys, providers) {
  const rows = [];

  // Group by provider slug
  const byProvider = {};
  for (const k of keys) {
    if (!byProvider[k.providerSlug]) byProvider[k.providerSlug] = [];
    byProvider[k.providerSlug].push(k);
  }

  for (const [slug, kList] of Object.entries(byProvider)) {
    const prov = providers.find((p) => p.slug === slug);
    const provName = prov ? prov.name : slug;
    rows.push([{ text: `─── ${provName} ───`, callback_data: 'noop' }]);
    for (const k of kList) {
      const statusIcon = k.status === 'active' ? '✅' : k.status === 'cooldown' ? '⏳' : '❌';
      rows.push([
        { text: `${statusIcon} ${k.label || k.providerSlug}`, callback_data: `k:view:${k.id}` },
      ]);
    }
  }

  rows.push([{ text: '➕ افزودن کلید جدید', callback_data: 'k:add_pick_prov' }]);
  rows.push([{ text: '🔙 منوی اصلی', callback_data: 'a:menu' }]);
  return { inline_keyboard: rows };
}

export function keyDetailKeyboard(key, allKeys) {
  const sorted = allKeys
    .filter((k) => k.providerSlug === key.providerSlug)
    .sort((a, b) => a.sortOrder - b.sortOrder);
  const idx = sorted.findIndex((k) => k.id === key.id);
  const rows = [];

  const navRow = [];
  if (idx > 0) navRow.push({ text: '⬆️ بالاتر', callback_data: `k:up:${key.id}` });
  if (idx < sorted.length - 1) navRow.push({ text: '⬇️ پایین‌تر', callback_data: `k:dn:${key.id}` });
  if (navRow.length > 0) rows.push(navRow);

  rows.push([{ text: '🗑️ حذف این کلید', callback_data: `k:del:${key.id}` }]);
  rows.push([{ text: '🔙 بازگشت به لیست کلیدها', callback_data: 'a:keys' }]);
  return { inline_keyboard: rows };
}

export function providerPickerForKey(providers) {
  const rows = providers.map((p) => [
    { text: p.name, callback_data: `k:add:${p.slug}`.slice(0, 64) },
  ]);
  rows.push([{ text: '🔙 بازگشت', callback_data: 'a:keys' }]);
  return { inline_keyboard: rows };
}

// ─── Providers Management ─────────────────────────────────────────────────────
export function providersKeyboard(providers) {
  const rows = providers.map((p) => [
    {
      text: `${p.isBuiltin ? '🏷️' : '🔧'} ${p.name}`,
      callback_data: `p:view:${p.id}`,
    },
  ]);
  rows.push([{ text: '➕ افزودن ارائه‌دهنده سفارشی', callback_data: 'p:add' }]);
  rows.push([{ text: '🔙 منوی اصلی', callback_data: 'a:menu' }]);
  return { inline_keyboard: rows };
}

export function providerDetailKeyboard(prov) {
  const rows = [];
  const models = (() => {
    try { return JSON.parse(prov.models || '[]'); } catch { return []; }
  })();

  // Render all registered models as clickable glass buttons
  if (models.length > 0) {
    let currentRow = [];
    models.forEach((m, idx) => {
      const isDef = m === prov.defaultModel;
      const label = `${isDef ? '✅ ' : ''}${m}`;
      // Put 2 short models per row, or 1 if longer
      if (label.length > 18 && currentRow.length > 0) {
        rows.push(currentRow);
        currentRow = [];
      }
      currentRow.push({
        text: label,
        callback_data: `p:sdm:${prov.id}:${idx}`,
      });
      if (currentRow.length >= 2 || label.length > 18) {
        rows.push(currentRow);
        currentRow = [];
      }
    });
    if (currentRow.length > 0) rows.push(currentRow);
  }

  // Model actions
  rows.push([
    { text: '➕ افزودن مدل جدید', callback_data: `p:addm:${prov.id}` },
    { text: '🗑️ حذف مدل', callback_data: `p:delmp:${prov.id}` },
  ]);

  if (!prov.isBuiltin) {
    rows.push([{ text: '🗑️ حذف این ارائه‌دهنده', callback_data: `p:del:${prov.id}` }]);
  }
  rows.push([{ text: '🔙 بازگشت به ارائه‌دهنده‌ها', callback_data: 'a:providers' }]);
  return { inline_keyboard: rows };
}

export function providerDeleteModelKeyboard(prov) {
  const rows = [];
  const models = (() => {
    try { return JSON.parse(prov.models || '[]'); } catch { return []; }
  })();

  models.forEach((m, idx) => {
    rows.push([{
      text: `❌ حذف ${m}`,
      callback_data: `p:rmm:${prov.id}:${idx}`,
    }]);
  });
  rows.push([{ text: '🔙 بازگشت به ارائه‌دهنده', callback_data: `p:view:${prov.id}` }]);
  return { inline_keyboard: rows };
}

export function providerModelPickerKeyboard(prov, models) {
  const rows = models.map((m, idx) => {
    const isDef = m === prov.defaultModel ? '✅ ' : '';
    return [{
      text: `${isDef}${m}`,
      callback_data: `p:sdm:${prov.id}:${idx}`,
    }];
  });
  rows.push([{ text: '🔙 بازگشت', callback_data: `p:view:${prov.id}` }]);
  return { inline_keyboard: rows };
}

// ─── Combos ───────────────────────────────────────────────────────────────────
export function combosKeyboard(comboList, activeComboId) {
  const rows = comboList.map((c) => {
    const active = c.id === activeComboId ? '✅ ' : '';
    return [{ text: `${active}🔀 ${c.name}`, callback_data: `c:view:${c.id}` }];
  });
  rows.push([{ text: '➕ ایجاد کمبو جدید', callback_data: 'c:create' }]);
  rows.push([{ text: '🔙 منوی اصلی', callback_data: 'a:menu' }]);
  return { inline_keyboard: rows };
}

export function comboDetailKeyboard(combo, isActive) {
  const rows = [];
  if (!isActive) {
    rows.push([{ text: '✅ فعال کردن این کمبو', callback_data: `c:select:${combo.id}` }]);
  } else {
    rows.push([{ text: '❎ غیرفعال کردن (بدون کمبو)', callback_data: 'c:deselect' }]);
  }
  rows.push([{ text: '✏️ ویرایش ارائه‌دهنده‌ها', callback_data: `c:editprov:${combo.id}` }]);
  rows.push([{ text: '🔄 تغییر سیاست مسیریابی', callback_data: `c:policy:${combo.id}` }]);
  rows.push([{ text: '🗑️ حذف این کمبو', callback_data: `c:del:${combo.id}` }]);
  rows.push([{ text: '🔙 بازگشت به کمبوها', callback_data: 'a:combos' }]);
  return { inline_keyboard: rows };
}

export function routingPolicyKeyboard(comboId) {
  const rows = Object.entries(ROUTING_POLICIES).map(([key, val]) => [
    { text: val.name, callback_data: `c:setpol:${comboId}:${key}`.slice(0, 64) },
  ]);
  rows.push([{ text: '🔙 بازگشت', callback_data: `c:view:${comboId}` }]);
  return { inline_keyboard: rows };
}

// For editing an existing combo
export function comboProviderPickerKeyboard(providers, selected, comboId) {
  const rows = providers.map((p) => {
    const checked = selected.includes(p.slug) ? '✅ ' : '';
    return [{
      text: `${checked}${p.name}`,
      callback_data: `c:togprov:${comboId}:${p.slug}`.slice(0, 64),
    }];
  });
  rows.push([{ text: '💾 ذخیره تغییرات', callback_data: `c:saveprov:${comboId}` }]);
  rows.push([{ text: '🔙 بازگشت', callback_data: `c:view:${comboId}` }]);
  return { inline_keyboard: rows };
}

// For creating a NEW combo during wizard
export function wizardComboProviderPickerKeyboard(providers, selected) {
  const rows = providers.map((p) => {
    const checked = selected.includes(p.slug) ? '✅ ' : '';
    return [{
      text: `${checked}${p.name}`,
      callback_data: `wiz:togprov:${p.slug}`.slice(0, 64),
    }];
  });
  rows.push([{ text: '💾 ذخیره و ساخت کمبو', callback_data: 'wiz:saveprov' }]);
  rows.push([{ text: '🔙 لغو', callback_data: 'wiz:cancel' }]);
  return { inline_keyboard: rows };
}

// ─── Chat ─────────────────────────────────────────────────────────────────────
export function chatActionsKeyboard() {
  return {
    inline_keyboard: [
      [
        { text: '🔄 پیام جدید', callback_data: 'a:new_chat' },
        { text: '🗑️ پاک کردن تاریخچه', callback_data: 'a:clear_history' },
      ],
      [{ text: '🔙 منوی اصلی', callback_data: 'a:menu' }],
    ],
  };
}
