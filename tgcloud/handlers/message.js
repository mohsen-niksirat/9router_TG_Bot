import { api } from 'sdk';
import {
  getOrCreateUser,
  getUser,
  setWizard,
  clearWizard,
  parseWizardData,
  getKeys,
  addKey,
  getUserProviders,
  getProviderBySlug,
  addCustomProvider,
  updateProviderModels,
  getCombos,
  createCombo,
  getActiveCombo,
  parseCombo,
  getUsageStats,
} from 'lib/db';
import { sendChat, clearHistory } from 'lib/chat';
import {
  escHtml,
  buildMiniAppUrl,
  mainMenuKeyboard,
  mainReplyKeyboard,
  keysKeyboard,
  combosKeyboard,
  providersKeyboard,
  chatActionsKeyboard,
  backKeyboard,
} from 'lib/keyboards';
import { ROUTING_POLICIES } from 'lib/providers';

export default async function (message) {
  if (!message || !message.chat) return;
  const chat = message.chat;
  const from = message.from;
  if (!from || from.is_bot) return;

  const { user, isNew } = await getOrCreateUser(from);
  const text = (message.text || message.caption || '').trim();

  // Bind Telegram Menu Button directly to Mini App
  api.setChatMenuButton({
    chat_id: chat.id,
    menu_button: {
      type: 'web_app',
      text: 'مینی‌اپ چت 🤖',
      web_app: { url: buildMiniAppUrl(from.id) },
    },
  }).catch(() => {});

  // ─── Wizard FSM (intercept before commands) ────────────────────────────────
  const wState = user.wizardState || 'idle';

  if (wState !== 'idle' && text !== '/cancel' && !text.startsWith('/start')) {
    const ctx = parseWizardData(user);

    // ── Add Provider: step 1 — name ──
    if (wState === 'prov:name') {
      if (!text) { await api.sendMessage({ chat_id: chat.id, text: '⚠️ نام نمی‌تواند خالی باشد.' }); return; }
      await setWizard(from.id, 'prov:url', { name: text });
      await api.sendMessage({
        chat_id: chat.id,
        text: `🌐 نام: <b>${escHtml(text)}</b>\n\nحالا <b>Base URL</b> ارائه‌دهنده را بفرست:\n<i>مثال: https://api.openai.com/v1</i>`,
        parse_mode: 'HTML',
        reply_markup: backKeyboard('a:providers'),
      });
      return;
    }

    // ── Add Provider: step 2 — URL ──
    if (wState === 'prov:url') {
      const url = text.trim();
      if (!url.startsWith('http')) {
        await api.sendMessage({ chat_id: chat.id, text: '⚠️ URL باید با http یا https شروع شود.' });
        return;
      }
      const prov = await addCustomProvider(user.id, {
        name: ctx.name || 'ارائه‌دهنده سفارشی',
        baseUrl: url,
      });
      await clearWizard(from.id);
      await api.sendMessage({
        chat_id: chat.id,
        text: `✅ ارائه‌دهنده <b>${escHtml(ctx.name)}</b> با آدرس <code>${escHtml(url)}</code> ذخیره شد!\n\nحالا می‌توانید کلیدهای این ارائه‌دهنده را از منوی کلیدها اضافه کنید.`,
        parse_mode: 'HTML',
        reply_markup: backKeyboard('a:providers'),
      });
      return;
    }

    // ── Add Provider: step 3 — models (optional) ──
    if (wState.startsWith('prov:models:')) {
      const provId = parseInt(wState.replace('prov:models:', ''), 10);
      const models = text.split(/[,،\n]+/).map((s) => s.trim()).filter(Boolean);
      await updateProviderModels(provId, user.id, models);
      await clearWizard(from.id);
      await api.sendMessage({
        chat_id: chat.id,
        text: `✅ مدل‌های ارائه‌دهنده به‌روز شدند:\n<b>${escHtml(models.join(', '))}</b>`,
        parse_mode: 'HTML',
        reply_markup: backKeyboard('a:providers'),
      });
      return;
    }

    // ── Add Key: provider selected, awaiting API key ──
    if (wState.startsWith('key:add:')) {
      const slug = wState.replace('key:add:', '');
      const apiKey = text.trim();
      if (!apiKey || apiKey.length < 8) {
        await api.sendMessage({ chat_id: chat.id, text: '⚠️ کلید وارد شده بسیار کوتاه است. لطفاً مجدداً تلاش کنید.' });
        return;
      }
      await addKey(user.id, from.id, { providerSlug: slug, apiKey, label: ctx.label });
      await clearWizard(from.id);
      const allKeys = await getKeys(user.id);
      const providers = await getUserProviders(user.id);
      await api.sendMessage({
        chat_id: chat.id,
        text: '✅ کلید با موفقیت رمزگذاری و ذخیره شد!\n\n🔐 کلید شما به صورت رمزگذاری‌شده در سرور ذخیره است و هرگز به صورت خام نگهداری نمی‌شود.',
        parse_mode: 'HTML',
        reply_markup: keysKeyboard(allKeys, providers),
      });
      return;
    }

    // ── Create Combo: step 1 — name ──
    if (wState === 'combo:name') {
      if (!text) { await api.sendMessage({ chat_id: chat.id, text: '⚠️ نام کمبو نمی‌تواند خالی باشد.' }); return; }
      await setWizard(from.id, 'combo:policy', { name: text, providerSlugs: ctx.providerSlugs || [] });
      const policyButtons = Object.entries(ROUTING_POLICIES).map(([key, val]) => [
        { text: val.name, callback_data: `wiz:combo:pol:${key}`.slice(0, 64) },
      ]);
      await api.sendMessage({
        chat_id: chat.id,
        text: `✅ نام کمبو: <b>${escHtml(text)}</b>\n\nحالا <b>سیاست مسیریابی</b> را انتخاب کنید:`,
        parse_mode: 'HTML',
        reply_markup: { inline_keyboard: policyButtons },
      });
      return;
    }
  }

  // ─── /cancel ──────────────────────────────────────────────────────────────
  if (text === '/cancel' || text === '❌ لغو') {
    await clearWizard(from.id);
    const comboRaw = await getActiveCombo(user);
    const combo = parseCombo(comboRaw);
    await api.sendMessage({
      chat_id: chat.id,
      text: '❌ عملیات لغو شد.',
      reply_markup: mainMenuKeyboard(user, combo),
    });
    return;
  }

  // ─── /start ───────────────────────────────────────────────────────────────
  if (text.startsWith('/start')) {
    await clearWizard(from.id);
    const comboRaw = await getActiveCombo(user);
    const combo = parseCombo(comboRaw);

    const welcomeNew =
      `🤖 <b>سلام ${escHtml(from.first_name)}! به ربات چت 9Router خوش آمدی!</b>\n\n` +
      `این ربات مثل ۹روتر، کلیدهای هوش مصنوعی تو رو مدیریت می‌کنه:\n\n` +
      `🔑 <b>مرحله ۱:</b> از منوی «کلیدها» کلیدهای API خودت رو اضافه کن\n` +
      `🔀 <b>مرحله ۲:</b> از «کمبوها» یه ترکیب از ارائه‌دهنده‌ها بساز\n` +
      `💬 <b>مرحله ۳:</b> شروع به چت کن!\n\n` +
      `🔐 <i>کلیدهای تو رمزگذاری‌شده ذخیره می‌شن و فقط خودت بهشون دسترسی داری.</i>`;

    const welcomeReturning =
      `👋 <b>خوش برگشتی ${escHtml(from.first_name)}!</b>\n\n` +
      (combo
        ? `🔀 کمبوی فعال: <b>${escHtml(combo.name)}</b>\n💡 هر پیامی که بفرستی، با هوش مصنوعی چت می‌کنه!`
        : `⚠️ هنوز کمبویی انتخاب نکردی. از منوی «کمبوهای من» یه ترکیب بساز.`);

    await api.sendMessage({
      chat_id: chat.id,
      text: isNew ? welcomeNew : welcomeReturning,
      parse_mode: 'HTML',
      reply_markup: mainMenuKeyboard(user, combo),
    });
    await api.sendMessage({
      chat_id: chat.id,
      text: '👇 نوار دسترسی سریع:',
      reply_markup: mainReplyKeyboard(from.id),
    });
    return;
  }

  // ─── /new — Clear history ─────────────────────────────────────────────────
  if (text === '/new' || text === '💬 چت با هوش مصنوعی') {
    await clearHistory(user.id);
    const comboRaw = await getActiveCombo(user);
    const combo = parseCombo(comboRaw);
    const comboInfo = combo
      ? `🔀 کمبو فعال: <b>${escHtml(combo.name)}</b> (${ROUTING_POLICIES[combo.routingPolicy]?.name || combo.routingPolicy})`
      : '⚠️ <b>هنوز کمبویی انتخاب نشده.</b> از «کمبوهای من» یک کمبو فعال کن.';

    await api.sendMessage({
      chat_id: chat.id,
      text: `💬 <b>چت جدید شروع شد!</b> تاریخچه پاک شد.\n\n${comboInfo}\n\n<i>حالا پیامت رو بنویس...</i>`,
      parse_mode: 'HTML',
      reply_markup: chatActionsKeyboard(),
    });
    return;
  }

  // ─── /keys ────────────────────────────────────────────────────────────────
  if (text === '/keys' || text === '🔑 مدیریت کلیدها') {
    const allKeys = await getKeys(user.id);
    const providers = await getUserProviders(user.id);
    await api.sendMessage({
      chat_id: chat.id,
      text:
        `🔑 <b>مدیریت کلیدهای API</b>\n\n` +
        `تعداد کلیدهای موجود: <b>${allKeys.length}</b>\n` +
        `<i>🔐 تمامی کلیدها به‌صورت رمزگذاری‌شده ذخیره می‌شوند.</i>`,
      parse_mode: 'HTML',
      reply_markup: keysKeyboard(allKeys, providers),
    });
    return;
  }

  // ─── /combos ──────────────────────────────────────────────────────────────
  if (text === '/combos' || text === '🔀 کمبوهای من') {
    const comboList = await getCombos(user.id);
    const comboRaw = await getActiveCombo(user);
    const combo = parseCombo(comboRaw);
    await api.sendMessage({
      chat_id: chat.id,
      text:
        `🔀 <b>کمبوهای من</b>\n\n` +
        `کمبو فعال: <b>${combo ? escHtml(combo.name) : 'ندارم'}</b>\n` +
        `تعداد کمبوها: <b>${comboList.length}</b>\n\n` +
        `<i>هر کمبو = ترکیبی از ارائه‌دهنده‌ها + سیاست مسیریابی</i>`,
      parse_mode: 'HTML',
      reply_markup: combosKeyboard(comboList, user.activeComboId),
    });
    return;
  }

  // ─── /providers ───────────────────────────────────────────────────────────
  if (text === '/providers' || text === '🌐 ارائه‌دهنده‌ها') {
    const providers = await getUserProviders(user.id);
    await api.sendMessage({
      chat_id: chat.id,
      text:
        `🌐 <b>ارائه‌دهنده‌های هوش مصنوعی</b>\n\n` +
        `ارائه‌دهنده‌های پیش‌فرض (🏷️) + ارائه‌دهنده‌های سفارشی شما (🔧)`,
      parse_mode: 'HTML',
      reply_markup: providersKeyboard(providers),
    });
    return;
  }

  // ─── /stats ───────────────────────────────────────────────────────────────
  if (text === '/stats' || text === '📊 آمار توکن‌ها') {
    const stats = await getUsageStats(user.id);
    const provLines = Object.entries(stats.byProvider)
      .map(([p, t]) => `• <b>${p}</b>: <code>${t.toLocaleString()}</code> توکن`)
      .join('\n') || '—';
    await api.sendMessage({
      chat_id: chat.id,
      text:
        `📊 <b>آمار مصرف توکن‌ها</b>\n\n` +
        `🗓️ امروز: <code>${stats.today.toLocaleString()}</code> توکن\n` +
        `📅 ۷ روز: <code>${stats.week.toLocaleString()}</code> توکن\n` +
        `📆 ۳۰ روز: <code>${stats.month.toLocaleString()}</code> توکن\n` +
        `🌐 کل: <code>${stats.allTime.toLocaleString()}</code> توکن\n\n` +
        `<b>به تفکیک ارائه‌دهنده:</b>\n${provLines}`,
      parse_mode: 'HTML',
      reply_markup: backKeyboard('a:menu'),
    });
    return;
  }

  // ─── /help ────────────────────────────────────────────────────────────────
  if (text === '/help' || text === '❓ راهنما') {
    await api.sendMessage({
      chat_id: chat.id,
      text:
        `❓ <b>راهنمای ربات 9Router Chat</b>\n\n` +
        `<b>دستورات:</b>\n` +
        `/start — شروع / منوی اصلی\n` +
        `/new — شروع چت جدید + پاک کردن تاریخچه\n` +
        `/keys — مدیریت کلیدهای API\n` +
        `/combos — مدیریت کمبوها\n` +
        `/providers — مدیریت ارائه‌دهنده‌ها\n` +
        `/stats — آمار مصرف توکن‌ها\n` +
        `/cancel — لغو عملیات جاری\n\n` +
        `<b>سیاست‌های مسیریابی:</b>\n` +
        `🛡️ <b>فالبک:</b> اولویت‌بندی کلیدها — سوئیچ خودکار هنگام خطا\n` +
        `🔄 <b>راند رابین:</b> توزیع چرخشی بین کلیدها\n` +
        `🧠 <b>اسمارت روتر:</b> انتخاب سالم‌ترین کلید\n` +
        `⚖️ <b>کمترین مصرف:</b> کلید با کمترین توکن مصرف‌شده\n\n` +
        `<b>امنیت کلیدها:</b>\n` +
        `🔐 کلیدها با رمزگذاری XOR+FNV-1a ذخیره می‌شوند\n` +
        `🚫 هرگز به صورت plaintext در DB نیستند`,
      parse_mode: 'HTML',
      reply_markup: backKeyboard('a:menu'),
    });
    return;
  }

  // ─── AI Chat (any other text) ─────────────────────────────────────────────
  const comboRaw = await getActiveCombo(user);
  const combo = parseCombo(comboRaw);

  if (!combo || combo.providerSlugs.length === 0) {
    await api.sendMessage({
      chat_id: chat.id,
      text:
        `⚠️ <b>هنوز کمبویی فعال نیست!</b>\n\n` +
        `برای چت با هوش مصنوعی:\n` +
        `۱. از «🔑 مدیریت کلیدها» کلید API اضافه کن\n` +
        `۲. از «🔀 کمبوهای من» یک کمبو بساز و فعال کن\n` +
        `۳. پیامت رو بنویس!`,
      parse_mode: 'HTML',
      reply_markup: mainMenuKeyboard(user, null),
    });
    return;
  }

  // Show typing... then call AI
  const thinkMsg = await api.sendMessage({
    chat_id: chat.id,
    text: '⏳ <b>در حال پردازش...</b>',
    parse_mode: 'HTML',
  });

  try {
    const result = await sendChat(user, from.id, text);
    const footer = `\n\n<i>—— ${result.provider} / ${result.model}</i>`;
    const fullText = escHtml(result.text) + footer;

    await api.editMessageText({
      chat_id: chat.id,
      message_id: thinkMsg.message_id,
      text: fullText.slice(0, 4096),
      parse_mode: 'HTML',
      reply_markup: chatActionsKeyboard(),
    });
  } catch (err) {
    await api.editMessageText({
      chat_id: chat.id,
      message_id: thinkMsg.message_id,
      text:
        `❌ <b>خطا در پردازش پیام:</b>\n<code>${escHtml(err.message)}</code>\n\n` +
        `💡 مطمئن شو کلید API فعال در کمبو داری.`,
      parse_mode: 'HTML',
      reply_markup: chatActionsKeyboard(),
    });
  }
}
