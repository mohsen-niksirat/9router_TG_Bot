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
  getProviderById,
  addCustomProvider,
  updateProviderModels,
  getCombos,
  createCombo,
  getActiveCombo,
  parseCombo,
  getUsageStats,
  addMediaGroupItem,
  getMediaGroupItems,
  clearMediaGroupItems,
} from 'lib/db';
import { sendChat, clearHistory } from 'lib/chat';
import { uint8ToBase64 } from 'lib/crypto';
import {
  escHtml,
  buildMiniAppUrl,
  mainMenuKeyboard,
  mainReplyKeyboard,
  keysKeyboard,
  combosKeyboard,
  providersKeyboard,
  providerDetailKeyboard,
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

  const isNavText = text.startsWith('/') || [
    '🌐 ارائه‌دهنده‌ها',
    '🔑 مدیریت کلیدها',
    '🔀 کمبوهای من',
    '💬 چت با هوش مصنوعی',
    '📊 آمار توکن‌ها',
    '❓ راهنما',
    '❌ لغو',
    '🔙 بازگشت',
  ].includes(text);

  if (isNavText && wState !== 'idle') {
    await clearWizard(from.id);
  }

  if (wState !== 'idle' && !isNavText) {
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
        await api.sendMessage({ chat_id: chat.id, text: '⚠️ آدرس باید با http:// یا https:// شروع شود.' });
        return;
      }
      const prov = await addCustomProvider(user.id, {
        name: ctx.name || 'ارائه‌دهنده سفارشی',
        baseUrl: url,
        defaultModel: 'gpt-4o-mini',
        models: ['gpt-4o-mini'],
      });

      // Move directly to Step 3: Models
      await setWizard(from.id, `prov:models:${prov.id}`, { name: ctx.name, baseUrl: url });
      await api.sendMessage({
        chat_id: chat.id,
        text:
          `✅ ارائه‌دهنده <b>${escHtml(ctx.name)}</b> با آدرس <code>${escHtml(url)}</code> ثبت شد!\n\n` +
          `📝 <b>مرحله ۳ از ۳: مدل‌های فعال این ارائه‌دهنده</b>\n\n` +
          `لطفاً نام مدل‌ها را ارسال فرمایید:\n` +
          `• می‌توانید در <b>هر سطر نام یک مدل</b> را بنویسید\n` +
          `• یا با <b>ویرگول (،)</b> نام‌ها را جدا کنید\n\n` +
          `<i>مثال:</i>\n<code>gpt-4o\ngpt-4o-mini\no1-mini</code>\n\n` +
          `💡 <i>اولین مدل به عنوان مدل پیش‌فرض انتخاب خواهد شد و سایر مدل‌ها در چرخش یا فالبک پشتیبانی می‌شوند.</i>`,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '⚡ استفاده از مدل پیش‌فرض (gpt-4o-mini)', callback_data: `prov:skip_models:${prov.id}` }],
            [{ text: '🔙 لغو و بازگشت', callback_data: 'a:providers' }],
          ],
        },
      });
      return;
    }

    // ── Add / Append Provider Models ──
    if (wState.startsWith('prov:models_add:') || wState.startsWith('prov:models:')) {
      const isAppend = wState.startsWith('prov:models_add:');
      const provId = parseInt(wState.replace(/prov:models(_add)?:/, ''), 10);
      const prov = await getProviderById(provId, user.id);
      if (!prov) {
        await clearWizard(from.id);
        await api.sendMessage({ chat_id: chat.id, text: '❌ ارائه‌دهنده یافت نشد.' });
        return;
      }

      const inputModels = text.split(/[\r\n,،]+/).map((s) => s.trim()).filter(Boolean);
      if (inputModels.length === 0) {
        await api.sendMessage({
          chat_id: chat.id,
          text: '⚠️ حداقل نام یک مدل را وارد کنید.',
        });
        return;
      }

      let existingModels = [];
      try { existingModels = JSON.parse(prov.models || '[]'); } catch {}

      // If appending, combine unique models
      let finalModels = isAppend
        ? Array.from(new Set([...existingModels, ...inputModels]))
        : inputModels;

      const defaultModel = prov.defaultModel && finalModels.includes(prov.defaultModel)
        ? prov.defaultModel
        : finalModels[0];

      await updateProviderModels(provId, user.id, finalModels, defaultModel);
      await clearWizard(from.id);
      const updatedProv = await getProviderById(provId, user.id);

      await api.sendMessage({
        chat_id: chat.id,
        text:
          `🎉 <b>مدل‌های ارائه‌دهنده «${escHtml(updatedProv.name)}» با موفقیت ذخیره شدند!</b>\n\n` +
          `📋 <b>تعداد کل مدل‌ها:</b> <code>${finalModels.length}</code>\n` +
          `🎯 <b>مدل پیش‌فرض:</b> <code>${escHtml(defaultModel)}</code>\n\n` +
          `💡 <i>با کلیک روی دکمه‌های شیشه‌ای زیر، می‌توانید مدل پیش‌فرض را مستقیماً تغییر دهید:</i>`,
        parse_mode: 'HTML',
        reply_markup: providerDetailKeyboard(updatedProv),
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

  // ─── AI Chat (any text or photo) ──────────────────────────────────────────
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
        `۳. پیامت رو بنویس یا عکس بفرست!`,
      parse_mode: 'HTML',
      reply_markup: mainMenuKeyboard(user, null),
    });
    return;
  }

  // ─── Multimodal Photos & Media Group (Albums) ─────────────────────────────
  const photos = message.photo;
  const isImageDoc = message.document && (message.document.mime_type || '').startsWith('image/');
  const mgId = message.media_group_id;

  let promptWithImages = text;

  if (photos || isImageDoc) {
    const fileId = photos ? photos[photos.length - 1].file_id : message.document.file_id;

    if (mgId) {
      // Album of multiple photos in Telegram
      await addMediaGroupItem(mgId, user.id, chat.id, fileId, text);
      // Brief async yields to allow concurrent album updates to insert
      for (let i = 0; i < 4; i++) {
        await db.run('SELECT 1');
      }

      const items = await getMediaGroupItems(mgId);
      // Only the first item coordinates the batch request
      if (!items || items.length === 0 || items[0].fileId !== fileId) {
        return;
      }
      await clearMediaGroupItems(mgId);

      const imgParts = [];
      let albumCaption = '';
      for (const it of items) {
        if (it.caption && !albumCaption) albumCaption = it.caption;
        try {
          const bytes = await api.getFileContent(it.fileId);
          if (bytes) {
            imgParts.push(`[Image: data:image/jpeg;base64,${uint8ToBase64(bytes)}]`);
          }
        } catch (e) {
          console.warn('[9Router] Failed to fetch album photo:', e);
        }
      }

      promptWithImages = (albumCaption ? `${albumCaption}\n\n` : '') + imgParts.join('\n');
    } else {
      // Single photo
      try {
        const bytes = await api.getFileContent(fileId);
        if (bytes) {
          const imgPart = `[Image: data:image/jpeg;base64,${uint8ToBase64(bytes)}]`;
          promptWithImages = text ? `${text}\n\n${imgPart}` : imgPart;
        }
      } catch (e) {
        console.warn('[9Router] Failed to fetch single photo:', e);
      }
    }
  }

  if (!promptWithImages) return;

  // Show typing... then call AI
  const thinkMsg = await api.sendMessage({
    chat_id: chat.id,
    text: '⏳ <b>در حال پردازش...</b>',
    parse_mode: 'HTML',
  });

  try {
    const result = await sendChat(user, from.id, promptWithImages);
    const footer = `\n\n<i>—— ${result.provider} / ${result.model}</i>`;

    // Check if AI generated or returned an image URL
    const imgUrlMatch = result.text.match(/!\[.*?\]\((https?:\/\/[^\s\)]+)\)/) ||
                        result.text.match(/(https?:\/\/\S+\.(?:png|jpe?g|webp))/i);

    if (imgUrlMatch) {
      const generatedImageUrl = imgUrlMatch[1];
      const cleanDesc = result.text.replace(/!\[.*?\]\(https?:\/\/[^\s\)]+\)/g, '').trim();
      const photoCaption = (cleanDesc.slice(0, 950) + footer).slice(0, 1024);

      try {
        await api.sendPhoto({
          chat_id: chat.id,
          photo: generatedImageUrl,
          caption: photoCaption,
          parse_mode: 'HTML',
          reply_markup: chatActionsKeyboard(),
        });
        await api.deleteMessage({ chat_id: chat.id, message_id: thinkMsg.message_id }).catch(() => {});
        return;
      } catch (photoErr) {
        console.warn('[9Router] sendPhoto failed, falling back to text:', photoErr);
      }
    }

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
