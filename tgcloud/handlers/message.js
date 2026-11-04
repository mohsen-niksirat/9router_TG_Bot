import { api } from 'sdk';
import {
  getOrCreateUser,
  getUser,
  setWizard,
  clearWizard,
  parseWizardData,
  getKeys,
  getKeyById,
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
  consumeMediaGroupItems,
  startChatSession,
  endChatSession,
  addSavedPrompt,
  getSavedPrompts,
  getSavedPromptById,
  deleteSavedPrompt,
  resolveSavedPrompts,
} from 'lib/db';
import { sendChat, clearHistory } from 'lib/chat';
import { uint8ToBase64 } from 'lib/crypto';
import { sleep, withTimeout } from 'lib/sleep';
import { enqueuePendingTask, deliverPendingTasks } from 'lib/manus_pending';
import {
  escHtml,
  sanitizeTelegramHtml,
  buildMiniAppUrl,
  mainMenuKeyboard,
  mainReplyKeyboard,
  keysKeyboard,
  combosKeyboard,
  providersKeyboard,
  providerDetailKeyboard,
  chatActionsKeyboard,
  backKeyboard,
  promptsKeyboard,
  promptDetailKeyboard,
  newChatPickerKeyboard,
} from 'lib/keyboards';
import { ROUTING_POLICIES } from 'lib/providers';

// Photos are re-encoded to a base64 data URL (+37%) inside the chat payload.
// 6MB keeps BOTH sides healthy: provider payload limits (OpenAI/Gemini ~20MB
// raw) and the isolate's ~3.0s CPU budget (the encode loop is pure JS).
const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

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

  // Deliver ANY completed deferred Manus task first — queued when a task
  // outran one invocation's budget; results land in this chat automatically
  // on the user's next update, no website visit needed.
  await deliverPendingTasks(user, chat);

  // ─── Wizard FSM (intercept before commands) ────────────────────────────────
  const wState = user.wizardState || 'idle';

  const isNavText = text.startsWith('/') || [
    '🌐 ارائه‌دهنده‌ها',
    '🔑 مدیریت کلیدها',
    '🔀 کمبوهای من',
    '💬 چت با هوش مصنوعی',
    '💬 شروع چت جدید',
    '🛑 پایان مکالمه',
    '🔄 چت جدید',
    '📋 پرامپت‌های من',
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

    // Combo-wizard steps (policy & provider pick) are button-driven — stray
    // typing must not fall through to the AI chat while the wizard is open.
    if (wState === 'combo:policy' || wState === 'combo:pickprov') {
      await api.sendMessage({
        chat_id: chat.id,
        text: '👆 لطفاً با دکمه‌های همین مرحله جلو بروید، یا «❌ لغو» بزنید.',
      });
      return;
    }

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

    // ── Add Saved Prompt: step 1 — title ──
    if (wState === 'prompt:title') {
      if (!text) { await api.sendMessage({ chat_id: chat.id, text: '⚠️ عنوان نمی‌تواند خالی باشد.' }); return; }
      await setWizard(from.id, 'prompt:text', { title: text.trim() });
      await api.sendMessage({
        chat_id: chat.id,
        text:
          `✏️ عنوان پرامپت: <b>${escHtml(text.trim())}</b>\n\n` +
          `حالا <b>متن کامل و جامع پرامپت</b> خود را ارسال کنید (بدون محدودیت در طول متن):\n\n` +
          `<i>این متن دفعه بعد با فراخوانی عبارت «پرامپت ${escHtml(text.trim())}» جایگزین خواهد شد.</i>`,
        parse_mode: 'HTML',
        reply_markup: backKeyboard('a:prompts'),
      });
      return;
    }

    // ── Add Saved Prompt: step 2 — prompt text ──
    if (wState === 'prompt:text') {
      if (!text) { await api.sendMessage({ chat_id: chat.id, text: '⚠️ متن پرامپت نمی‌تواند خالی باشد.' }); return; }
      const title = ctx.title || 'پرامپت سفارشی';
      await addSavedPrompt(user.id, { title, prompt: text.trim() });
      await clearWizard(from.id);
      const prompts = await getSavedPrompts(user.id);
      await api.sendMessage({
        chat_id: chat.id,
        text:
          `✅ <b>پرامپت «${escHtml(title)}» با موفقیت ذخیره شد!</b>\n\n` +
          `💡 <b>نحوه استفاده آسان:</b>\n` +
          `کافیست در هنگام چت یا ارسال عکس، عبارت <code>پرامپت ${escHtml(title)}</code> یا <code>#${escHtml(title)}</code> را بفرستید تا متن پرامپت به صورت خودکار اعمال گردد.`,
        parse_mode: 'HTML',
        reply_markup: promptsKeyboard(prompts),
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
      `💬 <b>مرحله ۳:</b> روی «شروع چت جدید» بزن و گفتگوی پیوسته رو آغاز کن!\n\n` +
      `🔐 <i>کلیدهای تو رمزگذاری‌شده ذخیره می‌شن و فقط خودت بهشون دسترسی داری.</i>`;

    const welcomeReturning =
      `👋 <b>خوش برگشتی ${escHtml(from.first_name)}!</b>\n\n` +
      (combo
        ? `🔀 کمبوی فعال: <b>${escHtml(combo.name)}</b>\n💡 برای ارسال پیام یا تصویر به هوش مصنوعی، روی <b>«💬 شروع چت جدید»</b> بزنید.`
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
      reply_markup: mainReplyKeyboard(from.id, !!user.chatSessionActive),
    });
    return;
  }

  // ─── /new or /chat — Pick Combo or Key to start new chat ──────────────────
  if (
    text === '/new' ||
    text === '/chat' ||
    text === '💬 شروع چت جدید' ||
    text === '🔄 چت جدید' ||
    text === '💬 چت با هوش مصنوعی'
  ) {
    await clearWizard(from.id);
    const comboList = await getCombos(user.id);
    const allKeys = await getKeys(user.id);
    const providers = await getUserProviders(user.id);
    const comboRaw = await getActiveCombo(user);
    const activeCombo = parseCombo(comboRaw);
    const activeKey = user.activeKeyId ? await getKeyById(user.activeKeyId, user.id) : null;
    const activeKeyProv = activeKey ? providers.find((p) => p.slug === activeKey.providerSlug) : null;

    let currentTargetInfo = 'تعیین‌نشده';
    if (activeKey) {
      currentTargetInfo = `🔑 کلید <b>${escHtml(activeKey.label || activeKeyProv?.name || activeKey.providerSlug)}</b> (${escHtml(activeKeyProv?.name || activeKey.providerSlug)})`;
    } else if (activeCombo) {
      currentTargetInfo = `🔀 کمبوی <b>${escHtml(activeCombo.name)}</b> (${escHtml(ROUTING_POLICIES[activeCombo.routingPolicy]?.name || activeCombo.routingPolicy)})`;
    }

    await api.sendMessage({
      chat_id: chat.id,
      text:
        `💬 <b>شروع گفتگوی جدید</b>\n\n` +
        `لطفاً انتخاب کنید این گفتگو با کدام <b>کمبو</b> یا <b>کلید / ارائه‌دهنده</b> انجام شود:\n\n` +
        `🎯 انتخاب فعال فعلی: ${currentTargetInfo}\n\n` +
        `<i>💡 با لمس کمبو یا کلید موردنظر از لیست زیر، گفتگوی پیوسته بلافاصله آغاز خواهد شد:</i>`,
      parse_mode: 'HTML',
      reply_markup: newChatPickerKeyboard(comboList, allKeys, providers, user.activeComboId, user.activeKeyId),
    });
    return;
  }

  // ─── /end or /stop — End chat session ─────────────────────────────────────
  if (text === '/end' || text === '/stop' || text === '🛑 پایان مکالمه') {
    await clearWizard(from.id);
    await endChatSession(user.id);
    const comboRaw = await getActiveCombo(user);
    const combo = parseCombo(comboRaw);

    await api.sendMessage({
      chat_id: chat.id,
      text:
        `🛑 <b>گفتگو به پایان رسید.</b>\n\n` +
        `تسک این مکالمه بسته شد و پیام‌های عادی دیگر به مدل هوش مصنوعی ارسال نمی‌شوند.\n` +
        `برای شروع یک گفتگوی جدید، روی «💬 شروع چت جدید» یا دکمه زیر بزنید.`,
      parse_mode: 'HTML',
      reply_markup: mainMenuKeyboard(user, combo),
    });
    await api.sendMessage({
      chat_id: chat.id,
      text: '👇 نوار منوی اصلی:',
      reply_markup: mainReplyKeyboard(from.id, false),
    }).catch(() => {});
    return;
  }

  // ─── /prompts — Saved prompts library ─────────────────────────────────────
  if (text === '/prompts' || text === '/prompt' || text === '📋 پرامپت‌های من') {
    const prompts = await getSavedPrompts(user.id);
    await api.sendMessage({
      chat_id: chat.id,
      text:
        `📋 <b>پرامپت‌های ذخیره‌شده شما</b>\n\n` +
        (prompts.length
          ? `تعداد پرامپت‌ها: <b>${prompts.length}</b>\n\n` +
            `💡 برای استفاده در چت، کافیست در متن یا کپشن عکس عبارت <code>پرامپت [نام]</code> یا <code>#[نام]</code> را بنویسید.`
          : `هنوز پرامپتی ذخیره نکرده‌اید! با دکمه زیر می‌توانید پرامپت دلخواه با متن طولانی ثبت کنید تا بدون نیاز به تایپ طولانی همراه عکس‌ها ارسال شود.`),
      parse_mode: 'HTML',
      reply_markup: promptsKeyboard(prompts),
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
        `/new یا /chat — شروع گفتگوی پیوسته جدید\n` +
        `/end یا /stop — پایان مکالمه جاری\n` +
        `/prompts — کتابخانه پرامپت‌های ذخیره‌شده\n` +
        `/keys — مدیریت کلیدهای API\n` +
        `/combos — مدیریت کمبوها\n` +
        `/providers — مدیریت ارائه‌دهنده‌ها\n` +
        `/stats — آمار مصرف توکن‌ها\n` +
        `/cancel — لغو عملیات جاری\n\n` +
        `<b>مکالمه پیوسته (Session Continuity):</b>\n` +
        `🔒 در حالت عادی ربات پیام‌های متفرقه را به هوش مصنوعی ارسال نمی‌کند. با زدن «شروع چت جدید» یک گفتگوی پیوسته آغاز می‌شود و تمامی عکس‌ها و پیام‌ها تا زمان «پایان مکالمه» داخل همان تسک دنبال می‌شوند تا صفحه گفتگوهای مانوس یا سایر ارائه‌دهنده‌ها شلوغ نشود.\n\n` +
        `<b>کتابخانه پرامپت دلخواه:</b>\n` +
        `📋 به دلیل محدودیت کپشن تلگرام، می‌توانید پرامپت‌های طولانی را ذخیره کنید و هنگام ارسال عکس فقط بنویسید <code>پرامپت [عنوان]</code> یا <code>#[عنوان]</code> تا کل پرامپت خودکار اعمال و ارسال شود.\n\n` +
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
  if (message.voice || message.audio) {
    await api.sendMessage({
      chat_id: chat.id,
      text: '🎙️ دریافت پیام صوتی در حال حاضر پشتیبانی نمی‌شود. لطفاً پیام خود را به صورت متن یا تصویر ارسال فرمایید.',
    });
    return;
  }

  if (message.sticker) {
    await api.sendMessage({
      chat_id: chat.id,
      text: '🎨 استیکر پشتیبانی نمی‌شود. لطفاً پیام متنی یا عکس بفرستید.',
    });
    return;
  }

  // ─── Session Gate ─────────────────────────────────────────────────────────
  // In normal mode, do not process stray messages into AI unless an active session is open.
  if (!user.chatSessionActive) {
    const activeKey = user.activeKeyId ? await getKeyById(user.activeKeyId, user.id) : null;
    const comboRaw = await getActiveCombo(user);
    const combo = parseCombo(comboRaw);
    let targetLabel = '';
    if (activeKey) {
      targetLabel = `🔑 کلید آماده: <b>${escHtml(activeKey.label || activeKey.providerSlug)}</b>\n\n`;
    } else if (combo) {
      targetLabel = `🔀 کمبوی آماده: <b>${escHtml(combo.name)}</b>\n\n`;
    }

    await api.sendMessage({
      chat_id: chat.id,
      text:
        `🔒 <b>هیچ گفتگوی فعالی باز نیست.</b>\n\n` +
        `برای اینکه مکالمات و تصاویر ارسالی شما به صورت منظم و پیوسته در قالب یک تسک مشخص تبادل شوند و گفتگوهای مانوس شلوغ نشوند، لطفاً ابتدا یک گفتگوی جدید آغاز کنید:\n\n` +
        targetLabel +
        `<i>👇 با زدن دکمه زیر، انتخاب کمبو/کلید و شروع چت فعال خواهد شد:</i>`,
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [{ text: '💬 شروع چت جدید (انتخاب کمبو / کلید)', callback_data: 'a:new_chat' }],
          [{ text: '🔀 کمبوهای من', callback_data: 'a:combos' }, { text: '🔑 کلیدها', callback_data: 'a:keys' }],
          [{ text: '📋 پرامپت‌های من', callback_data: 'a:prompts' }],
        ],
      },
    });
    return;
  }

  const activeKey = user.activeKeyId ? await getKeyById(user.activeKeyId, user.id) : null;
  const comboRaw = await getActiveCombo(user);
  const combo = parseCombo(comboRaw);

  if (!activeKey && (!combo || combo.providerSlugs.length === 0)) {
    await api.sendMessage({
      chat_id: chat.id,
      text:
        `⚠️ <b>هنوز کمبو یا کلیدی انتخاب نشده است!</b>\n\n` +
        `برای چت با هوش مصنوعی:\n` +
        `۱. روی «💬 شروع چت جدید» یا /new بزنید و کمبو یا کلید موردنظر را انتخاب کنید\n` +
        `۲. یا از «🔑 مدیریت کلیدها» کلید اضافه کنید.`,
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
  let appliedPromptTitle = null;

  // Resolve saved prompts against incoming text/caption
  if (text) {
    const pRes = await resolveSavedPrompts(user.id, text);
    promptWithImages = pRes.resolvedText;
    appliedPromptTitle = pRes.matchedTitle;
  }

  if (photos || isImageDoc) {
    const fileId = photos ? photos[photos.length - 1].file_id : message.document.file_id;

    if (mgId) {
      // Album of multiple photos in Telegram — delivered as separate,
      // concurrent updates that all run this handler.
      const inserted = await addMediaGroupItem(mgId, user.id, chat.id, fileId, text);

      // Debounce: poll the shared buffer until it stops growing (the isolate
      // has no setTimeout — sleep() spins with db yields). Sibling updates do
      // the same; whoever inserted the earliest row runs the batch once.
      let items = [];
      let prevCount = -1;
      let stable = 0;
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline && stable < 4) {
        items = await getMediaGroupItems(mgId);
        if (items.length > 0 && items.length === prevCount) stable++;
        else {
          stable = 0;
          prevCount = items.length;
        }
        if (stable < 4) await sleep(350);
      }

      if (!items.length || items[0].id !== inserted.id) {
        return; // not the earliest row — the coordinator owns this batch
      }

      // Consume only the rows we actually read; anything inserted after our
      // last poll survives for its own late update instead of being dropped.
      await consumeMediaGroupItems(mgId, items.map((r) => r.id));

      const imgParts = [];
      let albumCaption = '';
      let droppedBig = 0;
      for (const it of items) {
        if (it.caption && !albumCaption) albumCaption = it.caption;
        try {
          const bytes = await withTimeout(api.getFileContent(it.fileId), 5000);
          if (bytes && bytes.length > MAX_IMAGE_BYTES) {
            droppedBig++;
            console.warn(`[9Router] Album image too large (${bytes.length} B), skipped`);
          } else if (bytes) {
            imgParts.push(`[Image: data:image/jpeg;base64,${uint8ToBase64(bytes)}]`);
          }
        } catch (e) {
          console.warn('[9Router] Failed to fetch album photo:', e);
        }
      }

      if (!imgParts.length) {
        await api.sendMessage({
          chat_id: chat.id,
          text: droppedBig
            ? `⚠️ عکسهای این آلبوم بزرگتر از سقف ۶MB هستند و برای مدل ارسال نشدند؛ لطفاً عکس کوچکتری بفرستید.`
            : '⚠️ دریافت عکسهای این آلبوم ممکن نشد؛ لطفاً دوباره تلاش کنید.',
        });
        return;
      }

      if (albumCaption) {
        const pRes = await resolveSavedPrompts(user.id, albumCaption);
        albumCaption = pRes.resolvedText;
        if (pRes.matchedTitle) appliedPromptTitle = pRes.matchedTitle;
      }

      promptWithImages = (albumCaption ? `${albumCaption}\n\n` : '') + imgParts.join('\n');
    } else {
      // Single photo
      try {
        const bytes = await withTimeout(api.getFileContent(fileId), 5000);
        if (bytes && bytes.length > MAX_IMAGE_BYTES) {
          const mb = (bytes.length / 1048576).toFixed(1);
          await api.sendMessage({
            chat_id: chat.id,
            text: `⚠️ عکس ارسالی ${mb}MB است و بزرگتر از سقف مجاز ۶MB میباشد؛ لطفاً عکس کوچکتری بفرستید.`,
          });
          return;
        }
        if (bytes) {
          const imgPart = `[Image: data:image/jpeg;base64,${uint8ToBase64(bytes)}]`;
          promptWithImages = promptWithImages ? `${promptWithImages}\n\n${imgPart}` : imgPart;
        }
      } catch (e) {
        console.warn('[9Router] Failed to fetch single photo:', e);
      }
    }
  }

  if (!promptWithImages) return;

  // Show typing... then call AI
  const thinkPromptNotice = appliedPromptTitle
    ? `\n<i>(پرامپت «${escHtml(appliedPromptTitle)}» اعمال شد)</i>`
    : '';

  const thinkMsg = await api.sendMessage({
    chat_id: chat.id,
    text: `⏳ <b>در حال پردازش...</b>${thinkPromptNotice}`,
    parse_mode: 'HTML',
  });

  // Watchdog: tick the placeholder while a slow reply is pending so it can
  // never look frozen. Net-paced sleeps — a Date.now() spin used to burn the
  // isolate's ~3.0s CPU budget and get the invocation killed silently, which
  // is exactly how the placeholder used to get stuck on forever.
  let finished = false;
  const watchdog = (async () => {
    const t0 = Date.now();
    while (!finished && Date.now() - t0 < 23000) {
      await sleep(7000);
      if (finished) return;
      const seconds = Math.floor((Date.now() - t0) / 1000);
      await api.editMessageText({
        chat_id: chat.id,
        message_id: thinkMsg.message_id,
        text: `⏳ <b>در حال پردازش...</b>${thinkPromptNotice}\n⏱ <code>${seconds} ثانیه</code>`,
        parse_mode: 'HTML',
      }).catch(() => {});
    }
  })();

  try {
    // Wall-cap of the platform is ∈ (25s, 30s] — 17s for the whole chat call
    // leaves room for the photo download above and the cleanup below.
    const result = await withTimeout(sendChat(user, from.id, promptWithImages), 24000);

    const deferredTaskId = result?.deferredTaskId || result?.usage?.deferredTaskId;
    if (deferredTaskId) {
      await enqueuePendingTask(user.id, chat.id, deferredTaskId);
    }
    const footer = `\n\n<i>—— ${result.provider} / ${result.model}</i>`;

    // 1. Collect all AI-generated or returned image URLs
    const mdImgMatches = Array.from(result.text.matchAll(/!\[.*?\]\((https?:\/\/[^\s\)]+)\)/g)).map((m) => m[1]);
    const directImgMatches = Array.from(result.text.matchAll(/(https?:\/\/\S+\.(?:png|jpe?g|webp))/gi)).map((m) => m[1]);
    const generatedImages = Array.from(new Set([...mdImgMatches, ...directImgMatches]));

    const cleanDesc = result.text.replace(/!\[.*?\]\(https?:\/\/[^\s\)]+\)/g, '').trim();

    if (generatedImages.length > 0) {
      const firstImg = generatedImages[0];
      // Telegram parses caption as HTML — sanitize so `<br>` / `3 < 4` in model
      // output can't cause a "can't parse entities" 400 instead of delivery.
      const formattedDesc = sanitizeTelegramHtml(cleanDesc);

      // If caption fits within Telegram's 1024 photo caption limit
      if (formattedDesc.length <= 880) {
        try {
          await api.sendPhoto({
            chat_id: chat.id,
            photo: firstImg,
            caption: formattedDesc ? `${formattedDesc}${footer}` : footer.trim(),
            parse_mode: 'HTML',
            reply_markup: chatActionsKeyboard(true),
          });
          await api.deleteMessage({ chat_id: chat.id, message_id: thinkMsg.message_id }).catch(() => {});

          for (let i = 1; i < generatedImages.length; i++) {
            await api.sendPhoto({
              chat_id: chat.id,
              photo: generatedImages[i],
              caption: `🖼️ تصویر خروجی ${i + 1}`,
            }).catch(() => {});
          }
          return;
        } catch (photoErr) {
          console.warn('[9Router] sendPhoto caption failed, falling back:', photoErr);
        }
      }

      // If caption is long (> 880 chars): send photo with brief caption, then full text via message!
      try {
        await api.sendPhoto({
          chat_id: chat.id,
          photo: firstImg,
          caption: `🖼️ <b>تصویر خروجی هوش مصنوعی</b>${footer}`,
          parse_mode: 'HTML',
        });
        for (let i = 1; i < generatedImages.length; i++) {
          await api.sendPhoto({
            chat_id: chat.id,
            photo: generatedImages[i],
            caption: `🖼️ تصویر خروجی ${i + 1}`,
          }).catch(() => {});
        }
        await api.editMessageText({
          chat_id: chat.id,
          message_id: thinkMsg.message_id,
          text: (formattedDesc.slice(0, 3950) + footer).slice(0, 4096),
          parse_mode: 'HTML',
          reply_markup: chatActionsKeyboard(true),
        });
        return;
      } catch (photoErr) {
        console.warn('[9Router] sendPhoto split failed, falling back to text:', photoErr);
      }
    }

    const fullText = sanitizeTelegramHtml(result.text) + footer;

    const finalKeyboard = deferredTaskId
      ? {
          inline_keyboard: [
            [{ text: '🔄 دریافت تصویر و نتیجه نهایی', callback_data: `manus:check:${deferredTaskId}` }],
            [{ text: '🛑 پایان مکالمه', callback_data: 'a:end_chat' }],
            [{ text: '💬 شروع چت جدید', callback_data: 'a:new_chat' }],
          ],
        }
      : chatActionsKeyboard(true);

    await api.editMessageText({
      chat_id: chat.id,
      message_id: thinkMsg.message_id,
      text: fullText.slice(0, 4096),
      parse_mode: 'HTML',
      reply_markup: finalKeyboard,
    });
  } catch (err) {
    const timedOut = !!(err && err.isTimeout);
    await api.editMessageText({
      chat_id: chat.id,
      message_id: thinkMsg.message_id,
      text: timedOut
        ? '🕐 <b>زمان پاسخ تمام شد</b>\n' +
          'ارائهدهنده بیش از ۱۷ ثانیه پاسخ نداد و اتصال قطع شد — معمولاً به معنی ازدحام یا محدودیت موقت ارائهدهنده است.\n\n' +
          'یکبار دوباره پیام بفرست، یا از منوی «🔀 کمبوها» ارائهدهنده/کلید دیگری انتخاب کن.'
        : `❌ <b>خطا در پردازش پیام:</b>\n<code>${escHtml(err.message)}</code>\n\n` +
          `💡 مطمئن شو کلید API فعال در کمبو داری.`,
      parse_mode: 'HTML',
      reply_markup: chatActionsKeyboard(true),
    }).catch(() => {});
  } finally {
    finished = true;
    await watchdog; // let the ticker observe `finished` and exit on its own
  }
}
