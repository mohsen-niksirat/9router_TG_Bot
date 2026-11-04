/**
 * Keyboard builders for 9Router TG Bot.
 * All callback_data strings must be ≤ 64 bytes.
 */

import { ROUTING_POLICIES } from 'lib/providers';
import { APP_BASE_URL } from 'lib/config';

// ─── Mini App ─────────────────────────────────────────────────────────────────
export const MINI_APP_BASE_URL = APP_BASE_URL;

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

// Tags Telegram's createMessageHtml parse_mode accepts (attributes only on <a href>).
const TG_ALLOWED_TAG =
  /^<\/?(?:b|i|u|s|code|pre|blockquote|tg-spoiler)>$|^<a href="[^"<]{1,500}">$|^<\/a>$/;

/**
 * Sanitize model output for parse_mode: 'HTML'.
 *
 * Model replies routinely contain `<br>`, `3 < 4`, half-closed tags — the Bot
 * API rejects those with HTTP 400 ("can't parse entities") instead of sending
 * the message. Keeps Telegram-supported tags, escapes every other angle-bracket
 * fragment, and normalizes stray ampersands to valid entities.
 */
export function sanitizeTelegramHtml(str) {
  let s = String(str ?? '').replace(/&(?!(?:amp|lt|gt|quot|#39);)/g, '&amp;');
  s = s.replace(/<[^>]*>?/g, (frag) => {
    if (TG_ALLOWED_TAG.test(frag)) return frag;
    return frag.replace(/</g, '&lt;').replace(/>/g, '&gt;');
  });
  return s;
}

/**
 * Universal extractor for AI-generated images (Manus, Gemini, OpenAI, etc.).
 * Extracts all valid image URLs (including signed S3 query params) and strips
 * ugly download links or raw URLs from the descriptive text.
 */
export function extractMediaAndCleanText(rawText) {
  if (!rawText) return { images: [], cleanText: '' };

  const images = [];
  const foundUrls = new Set();

  // 1. Matches markdown links and images: [title](url) or ![title](url)
  const mdLinkRegex = /!?\[([^\]]*)\]\((https?:\/\/[^\s\)]+)\)/g;
  for (const m of rawText.matchAll(mdLinkRegex)) {
    const label = (m[1] || '').toLowerCase();
    const url = m[2];
    const u = url.toLowerCase();

    const isImage =
      u.includes('manuscdn.com') ||
      u.includes('files.manus') ||
      /\.(png|jpe?g|webp|gif|bmp)(\?|$)/i.test(u) ||
      /\.(png|jpe?g|webp|gif|bmp)$/i.test(label) ||
      label.includes('تصویر') ||
      label.includes('عکس') ||
      label.includes('image') ||
      label.includes('photo');

    if (isImage && !foundUrls.has(url)) {
      foundUrls.add(url);
      images.push(url);
    }
  }

  // 2. Matches bare URLs in text (including query params e.g. ?X-Amz-...)
  const bareUrlRegex = /https?:\/\/[^\s\)\"\'<>]+/gi;
  for (const m of rawText.matchAll(bareUrlRegex)) {
    const url = m[0];
    const u = url.toLowerCase();
    const isImage =
      u.includes('manuscdn.com') ||
      /\.(png|jpe?g|webp|gif|bmp)(\?|$)/i.test(u);

    if (isImage && !foundUrls.has(url)) {
      foundUrls.add(url);
      images.push(url);
    }
  }

  // 3. Clean the text: remove the markdown image/download links and unsightly URLs
  let cleanText = rawText;

  // Remove markdown links that point to images
  cleanText = cleanText.replace(/!?\[([^\]]*)\]\((https?:\/\/[^\s\)]+)\)/g, (fullMatch, label, url) => {
    if (foundUrls.has(url)) return '';
    return fullMatch;
  });

  // Remove standalone bare image URLs
  for (const imgUrl of images) {
    cleanText = cleanText.split(imgUrl).join('');
  }

  // Clean common phrases left behind like "دانلود تصویر:", "تصویر نهایی:", bracketed placeholders
  cleanText = cleanText
    .replace(/(?:دانلود\s+(?:تصویر|عکس|فایل)[^\n:]*[:：]?)/gi, '')
    .replace(/\[(?:تصویر|عکس)[^\]]*\]/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { images, cleanText };
}

// ─── Main Menu ────────────────────────────────────────────────────────────────
export function mainMenuKeyboard(user, combo, key = null) {
  let comboLabel = combo ? `🔀 ${combo.name}` : '🔀 بدون کمبو';
  if (user?.activeKeyId && key) {
    comboLabel = `🔑 ${key.label || key.providerSlug}`;
  }
  const sessionBtn = user?.chatSessionActive
    ? { text: '🛑 پایان مکالمه', callback_data: 'a:end_chat' }
    : { text: '💬 شروع چت جدید', callback_data: 'a:new_chat' };
  const miniAppUrl = buildMiniAppUrl(user?.tgId || 0);
  return {
    inline_keyboard: [
      [{ text: '📱 مینی‌اپ چت', web_app: { url: miniAppUrl } }],
      [sessionBtn, { text: comboLabel, callback_data: 'a:combos' }],
      [
        { text: '📜 آرشیو گفتگوها', callback_data: 'a:sessions' },
        { text: '📋 پرامپت‌ها', callback_data: 'a:prompts' },
      ],
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

export function newChatPickerKeyboard(combos, keys, providers, activeComboId = null, activeKeyId = null) {
  const rows = [];

  // Fast-track active selection
  if (activeKeyId) {
    const k = (keys || []).find((item) => item.id === activeKeyId);
    const p = k ? (providers || []).find((prov) => prov.slug === k.providerSlug) : null;
    const label = k ? (k.label || p?.name || k.providerSlug) : '';
    if (label) {
      rows.push([{ text: `⚡ ادامه با کلید فعال: ${label}`, callback_data: `chat:pick:k:${activeKeyId}` }]);
    }
  } else if (activeComboId) {
    const c = (combos || []).find((item) => item.id === activeComboId);
    if (c) {
      rows.push([{ text: `⚡ ادامه با کمبوی فعال: ${c.name}`, callback_data: `chat:pick:c:${activeComboId}` }]);
    }
  }

  // Combos section
  if (combos && combos.length > 0) {
    rows.push([{ text: '─── 🔀 کمبوهای من ───', callback_data: 'noop' }]);
    for (const c of combos) {
      const activeMark = (!activeKeyId && c.id === activeComboId) ? '✅ ' : '';
      rows.push([{ text: `${activeMark}🔀 ${c.name}`, callback_data: `chat:pick:c:${c.id}` }]);
    }
  }

  // Keys / Providers section
  if (keys && keys.length > 0) {
    rows.push([{ text: '─── 🔑 کلیدهای ارائه‌دهنده‌ها ───', callback_data: 'noop' }]);
    for (const k of keys) {
      const p = (providers || []).find((prov) => prov.slug === k.providerSlug);
      const provName = p ? p.name : k.providerSlug;
      const keyLabel = k.label ? `${k.label} (${provName})` : provName;
      const activeMark = (k.id === activeKeyId) ? '✅ ' : '';
      rows.push([{ text: `${activeMark}🔑 ${keyLabel}`, callback_data: `chat:pick:k:${k.id}` }]);
    }
  }

  // Actions
  rows.push([
    { text: '➕ کمبو جدید', callback_data: 'c:create' },
    { text: '➕ کلید جدید', callback_data: 'k:add_pick_prov' },
  ]);
  rows.push([{ text: '🔙 بازگشت به منو', callback_data: 'a:menu' }]);

  return { inline_keyboard: rows };
}

export function mainReplyKeyboard(tgId, isSessionActive = false) {
  const rows = [];
  if (isSessionActive) {
    rows.push(['🛑 پایان مکالمه', '🔄 چت جدید']);
    rows.push(['📜 آرشیو گفتگوها', '📋 پرامپت‌های من']);
  } else {
    rows.push(['💬 شروع چت جدید', '🔀 کمبوهای من']);
    rows.push(['📜 آرشیو گفتگوها', '📋 پرامپت‌های من']);
    rows.push(['🔑 مدیریت کلیدها', '📊 آمار توکن‌ها']);
  }
  if (tgId) {
    rows.push([{ text: '📱 باز کردن مینی‌اپ چت (Mini App)', web_app: { url: buildMiniAppUrl(tgId) } }]);
  }
  return {
    keyboard: rows,
    resize_keyboard: true,
    persistent: true,
  };
}

// ─── Saved Prompts Keyboards ──────────────────────────────────────────────────
export function promptsKeyboard(prompts) {
  const rows = [
    [{ text: '➕ افزودن پرامپت جدید', callback_data: 'prm:new' }],
  ];
  for (const p of prompts) {
    rows.push([
      { text: `📝 ${p.title}`, callback_data: `prm:view:${p.id}` },
      { text: '🗑️ حذف', callback_data: `prm:del:${p.id}` },
    ]);
  }
  rows.push([{ text: '🔙 بازگشت به منو', callback_data: 'a:menu' }]);
  return { inline_keyboard: rows };
}

export function promptDetailKeyboard(promptId) {
  return {
    inline_keyboard: [
      [{ text: '🗑️ حذف این پرامپت', callback_data: `prm:del:${promptId}` }],
      [{ text: '🔙 بازگشت به پرامپت‌ها', callback_data: 'a:prompts' }],
    ],
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

  if (key.status === 'cooldown' || key.status === 'dead') {
    rows.push([{ text: '🔄 فعال‌سازی مجدد (خروج از خنک‌سازی)', callback_data: `k:reset:${key.id}` }]);
  }

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
export function chatActionsKeyboard(isSessionActive = true) {
  const rows = [];
  if (isSessionActive) {
    rows.push([
      { text: '🛑 پایان مکالمه', callback_data: 'a:end_chat' },
      { text: '🔄 چت جدید', callback_data: 'a:new_chat' },
    ]);
  } else {
    rows.push([
      { text: '💬 شروع چت جدید', callback_data: 'a:new_chat' },
    ]);
  }
  rows.push([
    { text: '📜 آرشیو گفتگوها', callback_data: 'a:sessions' },
    { text: '📋 پرامپت‌ها', callback_data: 'a:prompts' },
  ]);
  rows.push([
    { text: '🔙 منوی اصلی', callback_data: 'a:menu' },
  ]);
  return { inline_keyboard: rows };
}

// ─── Sessions Keyboards ───────────────────────────────────────────────────────
export function sessionsKeyboard(sessionsList) {
  const rows = [];
  if (!sessionsList || sessionsList.length === 0) {
    rows.push([{ text: '💬 شروع چت جدید', callback_data: 'a:new_chat' }]);
    rows.push([{ text: '🔙 منوی اصلی', callback_data: 'a:menu' }]);
    return { inline_keyboard: rows };
  }

  for (const s of sessionsList) {
    const titleSnippet = s.title.length > 28 ? `${s.title.slice(0, 26)}…` : s.title;
    const taskTag = s.taskId ? ' ⚡[Manus]' : '';
    rows.push([
      { text: `📜 ${titleSnippet}${taskTag} (${s.messageCount || 0})`, callback_data: `ses:v:${s.id}` },
    ]);
  }

  rows.push([
    { text: '💬 شروع چت جدید', callback_data: 'a:new_chat' },
    { text: '🔙 منوی اصلی', callback_data: 'a:menu' },
  ]);
  return { inline_keyboard: rows };
}

export function sessionDetailKeyboard(sessionId) {
  return {
    inline_keyboard: [
      [{ text: '🔄 ادامه و فعال‌سازی این گفتگو', callback_data: `ses:res:${sessionId}` }],
      [
        { text: '🗑️ حذف گفتگو', callback_data: `ses:del:${sessionId}` },
        { text: '🔙 لیست گفتگوها', callback_data: 'a:sessions' },
      ],
    ],
  };
}

// ─── Admin Keyboards ──────────────────────────────────────────────────────────
export function adminPanelKeyboard(page = 0, totalPages = 1) {
  const rows = [];
  const navRow = [];
  if (page > 0) {
    navRow.push({ text: '◀️ صفحه قبل', callback_data: `adm:users:${page - 1}` });
  }
  if (page < totalPages - 1) {
    navRow.push({ text: 'صفحه بعد ▶️', callback_data: `adm:users:${page + 1}` });
  }
  if (navRow.length > 0) {
    rows.push(navRow);
  }
  rows.push([
    { text: '🔄 به‌روزرسانی آمار', callback_data: `adm:users:${page}` },
    { text: '🔙 منوی اصلی', callback_data: 'a:menu' },
  ]);
  return { inline_keyboard: rows };
}
