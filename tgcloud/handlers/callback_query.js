import { api, db } from 'sdk';
import { eq, and } from 'sdk/db';
import { pendingTasks } from 'schema';
import { readManusTask } from 'lib/ai_router';
import { manusApiKeyFor, sendFullResult } from 'lib/manus_pending';
import {
  getOrCreateUser,
  getUser,
  updateUser,
  setWizard,
  clearWizard,
  parseWizardData,
  getKeys,
  getKeyById,
  deleteKey,
  moveKeyPriority,
  getUserProviders,
  getProviderBySlug,
  getProviderById,
  updateProviderModels,
  updateProviderDefaultModel,
  addCustomProvider,
  deleteCustomProvider,
  getCombos,
  getComboById,
  getActiveCombo,
  createCombo,
  updateCombo,
  deleteCombo,
  parseCombo,
  clearHistory,
  getUsageStats,
  startChatSession,
  endChatSession,
  getSavedPrompts,
  getSavedPromptById,
  deleteSavedPrompt,
  cancelChatRequest,
  getChatSessions,
  getChatSessionById,
  deleteChatSession,
  restoreChatSession,
} from 'lib/db';
import { sendChat } from 'lib/chat';
import { decryptKey, maskKey } from 'lib/crypto';
import { ROUTING_POLICIES } from 'lib/providers';
import {
  escHtml,
  mainMenuKeyboard,
  mainReplyKeyboard,
  keysKeyboard,
  keyDetailKeyboard,
  providerPickerForKey,
  providersKeyboard,
  providerDetailKeyboard,
  providerModelPickerKeyboard,
  providerDeleteModelKeyboard,
  combosKeyboard,
  comboDetailKeyboard,
  routingPolicyKeyboard,
  comboProviderPickerKeyboard,
  wizardComboProviderPickerKeyboard,
  chatActionsKeyboard,
  backKeyboard,
  promptsKeyboard,
  promptDetailKeyboard,
  newChatPickerKeyboard,
  sessionsKeyboard,
  sessionDetailKeyboard,
} from 'lib/keyboards';

export default async function (query) {
  try {
    await handleCallback(query);
  } finally {
    // Clear Telegram's button spinner on every path — some branches only
    // editMessage and never answered, leaving the client spinner up ~1-5s.
    // Branches that already answered get a harmless duplicate-error (caught).
    const qid = query && query.id;
    if (qid) {
      await api.answerCallbackQuery({ callback_query_id: qid }).catch(() => {});
    }
  }
}

async function handleCallback(query) {
  if (!query || !query.data) return;
  const data = query.data;
  const from = query.from;
  const message = query.message;
  if (!message || !message.chat) return;

  const chatId = message.chat.id;
  const messageId = message.message_id;

  try { await api.answerCallbackQuery({ callback_query_id: query.id }); } catch {}

  const { user } = await getOrCreateUser(from);

  // Helper to edit the current message
  async function edit(text, keyboard, parseMode = 'HTML') {
    try {
      await api.editMessageText({
        chat_id: chatId, message_id: messageId,
        text: text.slice(0, 4096), parse_mode: parseMode, reply_markup: keyboard,
      });
    } catch {}
  }

  // ─── Live Request Cancellation ─────────────────────────────────────────────
  if (data.startsWith('chat:cancel:')) {
    const reqId = data.replace('chat:cancel:', '');
    const ownerUserId = parseInt(reqId.split('_')[0], 10);
    if (user.id !== ownerUserId) {
      await api.answerCallbackQuery({
        callback_query_id: query.id,
        text: '⛔ این درخواست متعلق به شما نیست!',
        show_alert: true,
      }).catch(() => {});
      return;
    }
    await cancelChatRequest(user.id, reqId);
    await api.answerCallbackQuery({
      callback_query_id: query.id,
      text: '✅ درخواست متوقف شد.',
    }).catch(() => {});
    await edit('❌ <b>درخواست لغو شد.</b>\n\nبرای ادامه، پیام جدید بفرستید یا مکالمه را به پایان برسانید.', chatActionsKeyboard(true));
    return;
  }

  // ─── Manus Task Check ──────────────────────────────────────────────────────
  if (data.startsWith('manus:check:')) {
    const taskId = data.replace('manus:check:', '');
    const apiKey = await manusApiKeyFor(user);
    if (!apiKey) {
      await api.answerCallbackQuery({
        callback_query_id: query.id,
        text: '❌ کلید API مانوس یافت نشد.',
        show_alert: true,
      });
      return;
    }

    try {
      const snap = await readManusTask(apiKey, taskId);
      if (!snap.done && snap.agentStatus !== 'completed' && snap.agentStatus !== 'stopped') {
        await api.answerCallbackQuery({
          callback_query_id: query.id,
          text: '⏳ هنوز در حال پردازش تصویر است... لطفاً چند ثانیه دیگر دکمه را لمس کنید.',
          show_alert: true,
        });
        return;
      }

      await api.answerCallbackQuery({
        callback_query_id: query.id,
        text: '✅ خروجی آماده شد!',
      });

      await sendFullResult(chatId, taskId, snap);
      await db.delete(pendingTasks).where(and(eq(pendingTasks.userId, user.id), eq(pendingTasks.taskId, taskId))).run();
    } catch (err) {
      console.warn('[9Router] manus check error:', err);
      await api.answerCallbackQuery({
        callback_query_id: query.id,
        text: '⚠️ خطا در بررسی تسک.',
        show_alert: true,
      });
    }
    return;
  }

  // ─── Main Menu ─────────────────────────────────────────────────────────────
  if (data === 'a:menu') {
    await clearWizard(from.id);
    const comboRaw = await getActiveCombo(user);
    const combo = parseCombo(comboRaw);
    await edit(
      `🤖 <b>منوی اصلی 9Router Chat</b>\n\nکمبوی فعال: <b>${combo ? escHtml(combo.name) : 'انتخاب نشده'}</b>`,
      mainMenuKeyboard(user, combo)
    );
    return;
  }

  // ─── Help ──────────────────────────────────────────────────────────────────
  if (data === 'a:help') {
    await edit(
      `❓ <b>راهنما</b>\n\n` +
      `۱. کلید API اضافه کن (🔑 کلیدها)\n` +
      `۲. کمبو بساز (🔀 کمبوها)\n` +
      `۳. کمبو رو فعال کن\n` +
      `۴. پیام بنویس و چت کن!\n\n` +
      `سیاست‌ها: 🛡️ فالبک | 🔄 راند رابین | 🧠 اسمارت | ⚖️ کمترین مصرف`,
      backKeyboard('a:menu')
    );
    return;
  }

  // ─── New Chat Setup / Picker ───────────────────────────────────────────────
  if (data === 'a:new_chat') {
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

    await edit(
      `💬 <b>شروع گفتگوی جدید</b>\n\n` +
      `لطفاً انتخاب کنید این گفتگو با کدام <b>کمبو</b> یا <b>کلید / ارائه‌دهنده</b> انجام شود:\n\n` +
      `🎯 انتخاب فعال فعلی: ${currentTargetInfo}\n\n` +
      `<i>💡 با لمس کمبو یا کلید موردنظر از لیست زیر، گفتگوی پیوسته بلافاصله آغاز خواهد شد.</i>`,
      newChatPickerKeyboard(comboList, allKeys, providers, user.activeComboId, user.activeKeyId)
    );
    return;
  }

  // ─── Pick Combo for New Chat ───────────────────────────────────────────────
  if (data.startsWith('chat:pick:c:')) {
    const comboId = parseInt(data.replace('chat:pick:c:', ''), 10);
    const combo = await getComboById(comboId, user.id);
    if (!combo) {
      await api.answerCallbackQuery({ callback_query_id: query.id, text: '❌ کمبو یافت نشد.' }).catch(() => {});
      return;
    }
    await startChatSession(user.id, { comboId });
    const parsed = parseCombo(combo);
    const policy = ROUTING_POLICIES[parsed.routingPolicy] || { name: parsed.routingPolicy };

    await api.answerCallbackQuery({
      callback_query_id: query.id,
      text: `✅ گفتگو با کمبوی ${combo.name} آغاز شد`,
    }).catch(() => {});

    await edit(
      `💬 <b>گفتگوی جدید آغاز شد!</b>\n\n` +
      `🔀 کمبوی فعال: <b>${escHtml(parsed.name)}</b> (${escHtml(policy.name)})\n` +
      `🌐 ارائه‌دهنده‌ها: <code>${escHtml(parsed.providerSlugs.join(' → '))}</code>\n\n` +
      `<i>💡 پیام یا عکس‌های خود را ارسال فرمایید. تمامی تبادلات پیام تا زمان زدن «🛑 پایان مکالمه» در همین تسک به صورت پیوسته انجام خواهد شد.</i>\n\n` +
      `<i>📋 برای استفاده از پرامپت‌های ذخیره‌شده، از عبارت <code>پرامپت [عنوان]</code> یا <code>#[عنوان]</code> در کپشن یا پیام استفاده کنید.</i>`,
      chatActionsKeyboard(true)
    );
    await api.sendMessage({
      chat_id: chatId,
      text: '👇 نوار وضعیت گفتگو (چت فعال):',
      reply_markup: mainReplyKeyboard(from.id, true),
    }).catch(() => {});
    return;
  }

  // ─── Pick Key for New Chat ─────────────────────────────────────────────────
  if (data.startsWith('chat:pick:k:')) {
    const keyId = parseInt(data.replace('chat:pick:k:', ''), 10);
    const key = await getKeyById(keyId, user.id);
    if (!key) {
      await api.answerCallbackQuery({ callback_query_id: query.id, text: '❌ کلید یافت نشد.' }).catch(() => {});
      return;
    }
    const prov = await getProviderBySlug(key.providerSlug, user.id);
    await startChatSession(user.id, { keyId });

    const provName = prov ? prov.name : key.providerSlug;
    await api.answerCallbackQuery({
      callback_query_id: query.id,
      text: `✅ گفتگو با کلید ${key.label || provName} آغاز شد`,
    }).catch(() => {});

    await edit(
      `💬 <b>گفتگوی جدید آغاز شد!</b>\n\n` +
      `🔑 کلید فعال: <b>${escHtml(key.label || provName)}</b>\n` +
      `🌐 ارائه‌دهنده: <b>${escHtml(provName)}</b>\n` +
      `🎯 مدل پیش‌فرض: <code>${escHtml(prov?.defaultModel || 'تعیین‌نشده')}</code>\n\n` +
      `<i>💡 پیام یا عکس‌های خود را ارسال فرمایید. تمامی تبادلات پیام تا زمان زدن «🛑 پایان مکالمه» با همین کلید و تسک پیگیری خواهد شد.</i>\n\n` +
      `<i>📋 برای استفاده از پرامپت‌های ذخیره‌شده، از عبارت <code>پرامپت [عنوان]</code> یا <code>#[عنوان]</code> در کپشن یا پیام استفاده کنید.</i>`,
      chatActionsKeyboard(true)
    );
    await api.sendMessage({
      chat_id: chatId,
      text: '👇 نوار وضعیت گفتگو (چت فعال):',
      reply_markup: mainReplyKeyboard(from.id, true),
    }).catch(() => {});
    return;
  }

  // ─── End Chat Session ───────────────────────────────────────────────────────
  if (data === 'a:end_chat') {
    await endChatSession(user.id);
    const comboRaw = await getActiveCombo(user);
    const combo = parseCombo(comboRaw);
    await edit(
      `🛑 <b>گفتگو به پایان رسید.</b>\n\n` +
      `برای شروع گفتگوی جدید، روی «💬 شروع چت جدید» بزنید.`,
      mainMenuKeyboard(user, combo)
    );
    await api.sendMessage({
      chat_id: chatId,
      text: '👇 منوی اصلی:',
      reply_markup: mainReplyKeyboard(from.id, false),
    }).catch(() => {});
    return;
  }

  // ─── Saved Prompts ──────────────────────────────────────────────────────────
  if (data === 'a:prompts') {
    const prompts = await getSavedPrompts(user.id);
    await edit(
      `📋 <b>پرامپت‌های ذخیره‌شده شما</b>\n\n` +
      (prompts.length
        ? `تعداد پرامپت‌ها: <b>${prompts.length}</b>\n\n💡 برای استفاده در چت، کافیست در متن یا کپشن عکس عبارت <code>پرامپت [نام]</code> یا <code>#[نام]</code> را بنویسید.`
        : `هنوز پرامپتی ذخیره نکرده‌اید! با دکمه زیر می‌توانید پرامپت دلخواه خود را ثبت کنید.`),
      promptsKeyboard(prompts)
    );
    return;
  }

  if (data === 'prm:new') {
    await setWizard(from.id, 'prompt:title');
    await edit(
      `📝 <b>افزودن پرامپت جدید</b>\n\n` +
      `لطفاً یک <b>عنوان یا کلیدواژه کوتاه</b> برای این پرامپت ارسال فرمایید:\n` +
      `<i>مثال: عکس گچی</i>`,
      backKeyboard('a:prompts')
    );
    return;
  }

  if (data.startsWith('prm:view:')) {
    const promptId = parseInt(data.replace('prm:view:', ''), 10);
    const p = await getSavedPromptById(promptId, user.id);
    if (!p) {
      await edit('❌ پرامپت یافت نشد.', backKeyboard('a:prompts'));
      return;
    }
    await edit(
      `📝 <b>پرامپت: ${escHtml(p.title)}</b>\n\n` +
      `<code>${escHtml(p.prompt)}</code>\n\n` +
      `<i>💡 نحوه استفاده در چت:</i>\n` +
      `ارسال همراه عکس با کپشن <code>پرامپت ${escHtml(p.title)}</code>`,
      promptDetailKeyboard(promptId)
    );
    return;
  }

  if (data.startsWith('prm:del:')) {
    const promptId = parseInt(data.replace('prm:del:', ''), 10);
    await deleteSavedPrompt(promptId, user.id);
    const prompts = await getSavedPrompts(user.id);
    await edit(
      `🗑️ پرامپت با موفقیت حذف شد.\n\n` +
      `تعداد پرامپت‌های باقیمانده: <b>${prompts.length}</b>`,
      promptsKeyboard(prompts)
    );
    return;
  }

  // ─── Sessions Archive & Switcher ───────────────────────────────────────────
  if (data === 'a:sessions') {
    const list = await getChatSessions(user.id, 10);
    await edit(
      `📜 <b>آرشیو گفتگوهای شما</b>\n\n` +
      (list.length
        ? `تعداد گفتگوهای ذخیره‌شده: <b>${list.length}</b>\n\nبرای مشاهده جزئیات، ادامه یا بازیابی هر گفتگو، روی آن کلیک کنید:`
        : `هنوز هیچ گفتگوی ذخیره‌شده‌ای در آرشیو شما وجود ندارد.\nبا شروع چت جدید و تبادل پیام، گفتگوها به طور خودکار آرشیو می‌شوند.`),
      sessionsKeyboard(list)
    );
    return;
  }

  if (data.startsWith('ses:v:')) {
    const sId = parseInt(data.replace('ses:v:', ''), 10);
    const session = await getChatSessionById(sId, user.id);
    if (!session) {
      await edit('❌ گفتگو یافت نشد.', backKeyboard('a:sessions'));
      return;
    }
    const dt = new Date(session.updatedAt * 1000).toLocaleString('fa-IR');
    await edit(
      `📜 <b>گفتگو: ${escHtml(session.title)}</b>\n\n` +
      `🤖 ارائه‌دهنده/مدل: <code>${escHtml(session.provider || 'نامشخص')} / ${escHtml(session.model || 'نامشخص')}</code>\n` +
      `💬 تعداد پیام‌ها: <b>${session.messageCount || 0}</b>\n` +
      (session.taskId ? `⚡ تسک مانوس: <code>${escHtml(session.taskId)}</code>\n` : '') +
      `⏱ تاریخ: <code>${dt}</code>\n\n` +
      `<i>💡 با انتخاب دکمه «ادامه و فعال‌سازی»، این گفتگو به همراه حافظه پیام‌های قبلی بارگذاری خواهد شد:</i>`,
      sessionDetailKeyboard(sId)
    );
    return;
  }

  if (data.startsWith('ses:res:')) {
    const sId = parseInt(data.replace('ses:res:', ''), 10);
    const session = await restoreChatSession(sId, user.id);
    if (!session) {
      await edit('❌ گفتگو یافت نشد.', backKeyboard('a:sessions'));
      return;
    }
    await edit(
      `✅ <b>گفتگوی «${escHtml(session.title)}» با موفقیت فعال شد!</b>\n\n` +
      `💬 تمام پیام‌های قبلی و تسک فعال در حافظه ربات قرار گرفتند. شما هم‌اکنون می‌توانید مکالمه را ادامه دهید:`,
      chatActionsKeyboard(true)
    );
    await api.sendMessage({
      chat_id: chatId,
      text: '👇 نوار وضعیت گفتگو (چت فعال):',
      reply_markup: mainReplyKeyboard(from.id, true),
    }).catch(() => {});
    return;
  }

  if (data.startsWith('ses:del:')) {
    const sId = parseInt(data.replace('ses:del:', ''), 10);
    await deleteChatSession(sId, user.id);
    const list = await getChatSessions(user.id, 10);
    await edit(
      `🗑️ گفتگو با موفقیت از آرشیو حذف شد.\n\nتعداد گفتگوهای باقیمانده: <b>${list.length}</b>`,
      sessionsKeyboard(list)
    );
    return;
  }

  // ─── Clear History ─────────────────────────────────────────────────────────
  if (data === 'a:clear_history') {
    await clearHistory(user.id);
    await edit('🗑️ <b>تاریخچه چت پاک شد.</b>', chatActionsKeyboard());
    return;
  }

  // ─── Stats ─────────────────────────────────────────────────────────────────
  if (data === 'a:stats') {
    const stats = await getUsageStats(user.id);
    const provLines = Object.entries(stats.byProvider)
      .map(([p, t]) => `• <b>${p}</b>: <code>${t.toLocaleString()}</code>`)
      .join('\n') || '—';
    await edit(
      `📊 <b>آمار توکن‌ها</b>\n\n` +
      `امروز: <code>${stats.today.toLocaleString()}</code>\n` +
      `۷ روز: <code>${stats.week.toLocaleString()}</code>\n` +
      `۳۰ روز: <code>${stats.month.toLocaleString()}</code>\n` +
      `کل: <code>${stats.allTime.toLocaleString()}</code>\n\n` +
      `<b>به تفکیک:</b>\n${provLines}`,
      backKeyboard('a:menu')
    );
    return;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ─── KEYS ──────────────────────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  if (data === 'a:keys') {
    const allKeys = await getKeys(user.id);
    const providers = await getUserProviders(user.id);
    await edit(
      `🔑 <b>مدیریت کلیدهای API</b>\n\nتعداد: <b>${allKeys.length}</b> کلید\n🔐 رمزگذاری‌شده`,
      keysKeyboard(allKeys, providers)
    );
    return;
  }

  // View key detail
  if (data.startsWith('k:view:')) {
    const keyId = parseInt(data.replace('k:view:', ''), 10);
    const allKeys = await getKeys(user.id);
    const k = allKeys.find((x) => x.id === keyId);
    if (!k) { await edit('❌ کلید یافت نشد.', backKeyboard('a:keys')); return; }

    const plain = await decryptKey(k.apiKeyEnc, from.id);
    const statusIcon = k.status === 'active' ? '✅ فعال' : k.status === 'cooldown' ? '⏳ خنک‌سازی' : '❌ غیرفعال';
    await edit(
      `🔑 <b>${escHtml(k.label)}</b>\n\n` +
      `ارائه‌دهنده: <b>${escHtml(k.providerSlug)}</b>\n` +
      `وضعیت: <b>${statusIcon}</b>\n` +
      `کلید: <code>${escHtml(maskKey(plain))}</code>\n` +
      `توکن مصرفی: <code>${(k.totalTokens || 0).toLocaleString()}</code>\n` +
      `اولویت: <code>${k.sortOrder}</code>`,
      keyDetailKeyboard(k, allKeys)
    );
    return;
  }

  // Move key up/down
  if (data.startsWith('k:up:') || data.startsWith('k:dn:')) {
    const dir = data.startsWith('k:up:') ? 'up' : 'down';
    const keyId = parseInt(data.replace(`k:${dir === 'up' ? 'up' : 'dn'}:`, ''), 10);
    await moveKeyPriority(keyId, dir, user.id);
    const allKeys = await getKeys(user.id);
    const providers = await getUserProviders(user.id);
    await edit('✅ ترتیب کلید تغییر کرد.', keysKeyboard(allKeys, providers));
    return;
  }

  // Delete key
  if (data.startsWith('k:del:')) {
    const keyId = parseInt(data.replace('k:del:', ''), 10);
    await deleteKey(keyId, user.id);
    const allKeys = await getKeys(user.id);
    const providers = await getUserProviders(user.id);
    await edit('🗑️ کلید حذف شد.', keysKeyboard(allKeys, providers));
    return;
  }

  // Pick provider for new key
  if (data === 'k:add_pick_prov') {
    const providers = await getUserProviders(user.id);
    await edit(
      '🔑 <b>افزودن کلید جدید</b>\n\nکدام ارائه‌دهنده را انتخاب می‌کنید؟',
      providerPickerForKey(providers)
    );
    return;
  }

  // Provider selected for key — enter wizard
  if (data.startsWith('k:add:')) {
    const slug = data.replace('k:add:', '');
    const prov = await getProviderBySlug(user.id, slug);
    if (!prov) { await edit('❌ ارائه‌دهنده یافت نشد.', backKeyboard('a:keys')); return; }

    await setWizard(from.id, `key:add:${slug}`, { label: `${prov.name} Key` });
    await edit(
      `🔑 <b>افزودن کلید برای ${escHtml(prov.name)}</b>\n\n` +
      `لطفاً کلید API خود را در چت ارسال کنید:\n\n` +
      `<i>⚠️ کلید شما بلافاصله رمزگذاری می‌شود و هرگز خام ذخیره نمی‌گردد.</i>`,
      backKeyboard('k:add_pick_prov')
    );
    return;
  }

  // Noop (section headers)
  if (data === 'noop') {
    return;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ─── PROVIDERS ─────────────────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  if (data === 'a:providers') {
    const providers = await getUserProviders(user.id);
    await edit(
      `🌐 <b>ارائه‌دهنده‌های هوش مصنوعی</b>\n\n` +
      `🏷️ پیش‌فرض | 🔧 سفارشی\n` +
      `تعداد: <b>${providers.length}</b>`,
      providersKeyboard(providers)
    );
    return;
  }

  if (data.startsWith('p:view:')) {
    const provId = parseInt(data.replace('p:view:', ''), 10);
    const prov = await getProviderById(provId, user.id);
    if (!prov) { await edit('❌ ارائه‌دهنده یافت نشد.', backKeyboard('a:providers')); return; }

    const models = (() => {
      try { return JSON.parse(prov.models || '[]'); } catch { return []; }
    })();

    const modelsListStr = models.length > 0
      ? models.map((m) => `• <code>${escHtml(m)}</code> ${m === prov.defaultModel ? '<b>(پیش‌فرض فعلی ✅)</b>' : ''}`).join('\n')
      : '<i>هیچ مدلی تعریف نشده است</i>';

    await edit(
      `🌐 <b>${escHtml(prov.name)}</b>\n\n` +
      `🏷️ شناسه: <code>${escHtml(prov.slug)}</code>\n` +
      `🔗 آدرس: <code>${escHtml(prov.baseUrl)}</code>\n` +
      `🎯 <b>مدل پیش‌فرض:</b> <code>${escHtml(prov.defaultModel || 'تعیین‌نشده')}</code>\n\n` +
      `📋 <b>مدل‌های ثبت‌شده (${models.length}):</b>\n${modelsListStr}\n\n` +
      `💡 <i>روی هر یک از دکمه‌های شیشه‌ای زیر کلیک کنید تا به عنوان مدل پیش‌فرض انتخاب شود:</i>`,
      providerDetailKeyboard(prov)
    );
    return;
  }

  // Set default model by index (fast & ≤ 64 bytes)
  if (data.startsWith('p:sdm:')) {
    const parts = data.split(':');
    const provId = parseInt(parts[2], 10);
    const modelIdx = parseInt(parts[3], 10);
    const prov = await getProviderById(provId, user.id);
    if (!prov) { await edit('❌ ارائه‌دهنده یافت نشد.', backKeyboard('a:providers')); return; }

    let models = [];
    try { models = JSON.parse(prov.models || '[]'); } catch {}
    const chosenModel = models[modelIdx];
    if (!chosenModel) {
      await api.answerCallbackQuery({ callback_query_id: query.id, text: '⚠️ مدل یافت نشد!' }).catch(() => {});
      return;
    }

    await updateProviderDefaultModel(provId, user.id, chosenModel);
    prov.defaultModel = chosenModel;

    await api.answerCallbackQuery({
      callback_query_id: query.id,
      text: `✅ مدل پیش‌فرض روی ${chosenModel} تنظیم شد`,
    }).catch(() => {});

    const modelsListStr = models.map((m) => `• <code>${escHtml(m)}</code> ${m === chosenModel ? '<b>(پیش‌فرض فعلی ✅)</b>' : ''}`).join('\n');

    await edit(
      `🌐 <b>${escHtml(prov.name)}</b>\n\n` +
      `🏷️ شناسه: <code>${escHtml(prov.slug)}</code>\n` +
      `🔗 آدرس: <code>${escHtml(prov.baseUrl)}</code>\n` +
      `🎯 <b>مدل پیش‌فرض:</b> <code>${escHtml(chosenModel)}</code> ✅\n\n` +
      `📋 <b>مدل‌های ثبت‌شده (${models.length}):</b>\n${modelsListStr}\n\n` +
      `💡 <i>روی هر یک از دکمه‌های شیشه‌ای زیر کلیک کنید تا به عنوان مدل پیش‌فرض انتخاب شود:</i>`,
      providerDetailKeyboard(prov)
    );
    return;
  }

  // Add new model(s) to provider
  if (data.startsWith('p:addm:')) {
    const provId = parseInt(data.replace('p:addm:', ''), 10);
    const prov = await getProviderById(provId, user.id);
    if (!prov) { await edit('❌ ارائه‌دهنده یافت نشد.', backKeyboard('a:providers')); return; }
    await setWizard(from.id, `prov:models_add:${provId}`);
    await edit(
      `➕ <b>افزودن مدل جدید به ${escHtml(prov.name)}</b>\n\n` +
      `لطفاً نام مدل یا مدل‌های جدید را ارسال فرمایید:\n` +
      `• می‌توانید در <b>هر سطر نام یک مدل</b> را بنویسید\n` +
      `• یا با <b>ویرگول (،)</b> نام‌ها را جدا کنید\n\n` +
      `<i>مثال:</i>\n` +
      `<code>qwen7b\ndeepseek-r1\nllama-3.3-70b</code>\n\n` +
      `💡 مدل‌های ارسالی به لیست مدل‌های این سرویس‌دهنده اضافه خواهند شد.`,
      backKeyboard(`p:view:${provId}`)
    );
    return;
  }

  // Delete model picker
  if (data.startsWith('p:delmp:')) {
    const provId = parseInt(data.replace('p:delmp:', ''), 10);
    const prov = await getProviderById(provId, user.id);
    if (!prov) { await edit('❌ ارائه‌دهنده یافت نشد.', backKeyboard('a:providers')); return; }
    let models = [];
    try { models = JSON.parse(prov.models || '[]'); } catch {}

    if (models.length <= 1) {
      await api.answerCallbackQuery({
        callback_query_id: query.id,
        text: '⚠️ این ارائه‌دهنده حداقل باید یک مدل داشته باشد!',
        show_alert: true,
      }).catch(() => {});
      return;
    }

    await edit(
      `🗑️ <b>حذف مدل از ${escHtml(prov.name)}</b>\n\n` +
      `روی مدل موردنظر جهت حذف کلیک فرمایید:`,
      providerDeleteModelKeyboard(prov)
    );
    return;
  }

  // Remove model by index
  if (data.startsWith('p:rmm:')) {
    const parts = data.split(':');
    const provId = parseInt(parts[2], 10);
    const modelIdx = parseInt(parts[3], 10);
    const prov = await getProviderById(provId, user.id);
    if (!prov) { await edit('❌ ارائه‌دهنده یافت نشد.', backKeyboard('a:providers')); return; }

    let models = [];
    try { models = JSON.parse(prov.models || '[]'); } catch {}
    if (models.length <= 1) {
      await api.answerCallbackQuery({
        callback_query_id: query.id,
        text: '⚠️ حداقل یک مدل باید باقی بماند!',
        show_alert: true,
      }).catch(() => {});
      return;
    }

    const removed = models.splice(modelIdx, 1)[0];
    const newDefault = prov.defaultModel === removed ? models[0] : prov.defaultModel;
    await updateProviderModels(provId, user.id, models, newDefault);
    prov.defaultModel = newDefault;
    prov.models = JSON.stringify(models);

    await api.answerCallbackQuery({
      callback_query_id: query.id,
      text: `🗑️ مدل ${removed} حذف شد`,
    }).catch(() => {});

    await edit(
      `🌐 <b>${escHtml(prov.name)}</b>\n\n` +
      `مدل <code>${escHtml(removed)}</code> با موفقیت حذف شد.\n\n` +
      `🎯 <b>مدل پیش‌فرض:</b> <code>${escHtml(newDefault)}</code>`,
      providerDetailKeyboard(prov)
    );
    return;
  }

  // Compatibility for old p:defm: and p:models:
  if (data.startsWith('p:defm:') || data.startsWith('p:models:')) {
    const provId = parseInt(data.replace(/p:(defm|models):/, ''), 10);
    const prov = await getProviderById(provId, user.id);
    if (prov) {
      await edit(
        `🌐 <b>مدیریت مدل‌های ${escHtml(prov.name)}</b>\n\n` +
        `💡 مدل پیش‌فرض با کلیک روی هر دکمه فعال می‌شود:`,
        providerDetailKeyboard(prov)
      );
    }
    return;
  }

  if (data === 'p:add') {
    await setWizard(from.id, 'prov:name');
    await edit(
      '🌐 <b>افزودن ارائه‌دهنده سفارشی</b>\n\n' +
      'مرحله ۱ از ۳: لطفاً <b>نام ارائه‌دهنده</b> را بنویسید:\n' +
      '<i>مثال: AvalAI, DeepInfra, freeai, ...</i>',
      backKeyboard('a:providers')
    );
    return;
  }

  // Skip adding custom models and use default
  if (data.startsWith('prov:skip_models:')) {
    const provId = parseInt(data.replace('prov:skip_models:', ''), 10);
    await clearWizard(from.id);
    const prov = await getProviderById(provId, user.id);
    await edit(
      `✅ ارائه‌دهنده <b>${escHtml(prov?.name || 'سفارشی')}</b> با مدل پیش‌فرض <code>gpt-4o-mini</code> آماده شد!\n\n` +
      `اکنون می‌توانید کلیدهای این سرویس‌دهنده را از بخش «کلیدها» اضافه فرمایید.`,
      prov ? providerDetailKeyboard(prov) : backKeyboard('a:providers')
    );
    return;
  }

  if (data.startsWith('p:del:')) {
    const provId = parseInt(data.replace('p:del:', ''), 10);
    const deleted = await deleteCustomProvider(provId, user.id);
    const providers = await getUserProviders(user.id);
    await edit(
      deleted ? '🗑️ ارائه‌دهنده و کلیدهای مرتبط حذف شدند.' : '❌ حذف ممکن نیست (ارائه‌دهنده پیش‌فرض قابل حذف نیست).',
      providersKeyboard(providers)
    );
    return;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ─── COMBOS ────────────────────────────────────────────────────────────────
  // ═══════════════════════════════════════════════════════════════════════════

  if (data === 'a:combos') {
    const comboList = await getCombos(user.id);
    await edit(
      `🔀 <b>کمبوهای من</b>\n\nکمبوی فعال: <b>${user.activeComboId ? `#${user.activeComboId}` : 'ندارم'}</b>\n` +
      `تعداد: <b>${comboList.length}</b>\n\n<i>هر کمبو = ارائه‌دهنده‌ها + سیاست مسیریابی</i>`,
      combosKeyboard(comboList, user.activeComboId)
    );
    return;
  }

  if (data.startsWith('c:view:')) {
    const comboId = parseInt(data.replace('c:view:', ''), 10);
    if (!comboId || isNaN(comboId)) {
      await edit('❌ شناسه کمبو نامعتبر است.', backKeyboard('a:combos'));
      return;
    }
    const combo = await getComboById(comboId, user.id);
    if (!combo) { await edit('❌ کمبو یافت نشد.', backKeyboard('a:combos')); return; }
    const parsed = parseCombo(combo);
    const isActive = user.activeComboId === comboId;
    const policy = ROUTING_POLICIES[parsed.routingPolicy] || { name: parsed.routingPolicy };

    await edit(
      `🔀 <b>${escHtml(parsed.name)}</b> ${isActive ? '✅ (فعال)' : ''}\n\n` +
      `ارائه‌دهنده‌ها: <code>${escHtml(parsed.providerSlugs.join(' → '))}</code>\n` +
      `سیاست: <b>${policy.name}</b>\n` +
      `<i>${policy.desc || ''}</i>`,
      comboDetailKeyboard(parsed, isActive)
    );
    return;
  }

  // Select combo
  if (data.startsWith('c:select:')) {
    const comboId = parseInt(data.replace('c:select:', ''), 10);
    const combo = await getComboById(comboId, user.id);
    if (!combo) { await edit('❌ کمبو یافت نشد.', backKeyboard('a:combos')); return; }
    await updateUser(from.id, { activeComboId: comboId });
    const comboList = await getCombos(user.id);
    await edit(
      `✅ کمبوی <b>${escHtml(combo.name)}</b> فعال شد!\n\nحالا هر پیامی که بفرستی، از این کمبو استفاده می‌کنه.`,
      combosKeyboard(comboList, comboId)
    );
    return;
  }

  // Deselect combo
  if (data === 'c:deselect') {
    await updateUser(from.id, { activeComboId: null });
    const comboList = await getCombos(user.id);
    await edit('❎ کمبو غیرفعال شد.', combosKeyboard(comboList, null));
    return;
  }

  // Delete combo
  if (data.startsWith('c:del:')) {
    const comboId = parseInt(data.replace('c:del:', ''), 10);
    await deleteCombo(comboId, user.id);
    if (user.activeComboId === comboId) {
      await updateUser(from.id, { activeComboId: null });
    }
    const comboList = await getCombos(user.id);
    await edit('🗑️ کمبو حذف شد.', combosKeyboard(comboList, user.activeComboId === comboId ? null : user.activeComboId));
    return;
  }

  // Edit providers in existing combo
  if (data.startsWith('c:editprov:')) {
    const comboId = parseInt(data.replace('c:editprov:', ''), 10);
    const combo = await getComboById(comboId, user.id);
    if (!combo) { await edit('❌ کمبو یافت نشد.', backKeyboard('a:combos')); return; }
    const parsed = parseCombo(combo);
    const providers = await getUserProviders(user.id);
    await edit(
      `✏️ <b>ویرایش ارائه‌دهنده‌های کمبو: ${escHtml(parsed.name)}</b>\n\n` +
      `فعلاً: <code>${escHtml(parsed.providerSlugs.join(', '))}</code>\n\n` +
      `ارائه‌دهنده‌ها را تیک بزن یا بردار و سپس دکمه ذخیره را بزن:`,
      comboProviderPickerKeyboard(providers, parsed.providerSlugs, comboId)
    );
    return;
  }

  // Toggle provider in existing combo
  if (data.startsWith('c:togprov:')) {
    const parts = data.replace('c:togprov:', '').split(':');
    const comboId = parseInt(parts[0], 10);
    const slug = parts.slice(1).join(':');
    const combo = await getComboById(comboId, user.id);
    if (!combo) return;
    const parsed = parseCombo(combo);
    let slugs = parsed.providerSlugs;
    if (slugs.includes(slug)) {
      slugs = slugs.filter((s) => s !== slug);
    } else {
      slugs = [...slugs, slug];
    }
    await updateCombo(comboId, user.id, { providerSlugs: slugs });
    const providers = await getUserProviders(user.id);
    await api.editMessageReplyMarkup({
      chat_id: chatId,
      message_id: messageId,
      reply_markup: comboProviderPickerKeyboard(providers, slugs, comboId),
    }).catch(() => {});
    return;
  }

  // Save providers in existing combo
  if (data.startsWith('c:saveprov:')) {
    const comboId = parseInt(data.replace('c:saveprov:', ''), 10);
    const combo = await getComboById(comboId, user.id);
    await edit(
      `✅ ارائه‌دهنده‌های کمبو با موفقیت ذخیره شدند.`,
      comboDetailKeyboard(parseCombo(combo), user.activeComboId === comboId)
    );
    return;
  }

  // Change routing policy for combo
  if (data.startsWith('c:policy:')) {
    const comboId = parseInt(data.replace('c:policy:', ''), 10);
    await edit(
      `🔄 <b>انتخاب سیاست مسیریابی</b>\n\nکدام سیاست را برای این کمبو می‌خواهی؟`,
      routingPolicyKeyboard(comboId)
    );
    return;
  }

  if (data.startsWith('c:setpol:')) {
    const rest = data.replace('c:setpol:', '');
    const colonIdx = rest.indexOf(':');
    const comboId = parseInt(rest.slice(0, colonIdx), 10);
    const policy = rest.slice(colonIdx + 1);
    await updateCombo(comboId, user.id, { routingPolicy: policy });
    const combo = await getComboById(comboId, user.id);
    await edit(
      `✅ سیاست مسیریابی روی <b>${ROUTING_POLICIES[policy]?.name || policy}</b> تنظیم شد.`,
      comboDetailKeyboard(parseCombo(combo), user.activeComboId === comboId)
    );
    return;
  }

  // ─── Create Combo wizard ──────────────────────────────────────────────────
  if (data === 'c:create') {
    await clearWizard(from.id);
    await setWizard(from.id, 'combo:name', { providerSlugs: [] });
    await edit(
      `➕ <b>ایجاد کمبوی جدید</b>\n\nلطفاً <b>نام کمبو</b> را در چت بنویس:\n<i>مثال: سریع و رایگان، Gemini Pro، ترکیبی</i>`,
      backKeyboard('a:combos')
    );
    return;
  }

  // Wizard Step 2: Policy picked
  if (data.startsWith('wiz:combo:pol:')) {
    const policy = data.replace('wiz:combo:pol:', '');
    const ctx = parseWizardData(user);
    const providers = await getUserProviders(user.id);
    await setWizard(from.id, 'combo:pickprov', { ...ctx, policy, providerSlugs: ctx.providerSlugs || [] });

    await edit(
      `✅ سیاست: <b>${ROUTING_POLICIES[policy]?.name || policy}</b>\n\n` +
      `حالا ارائه‌دهنده‌هایی که می‌خوای در این کمبو باشن رو انتخاب کن (روی هر دکمه بزن تا تیک بخوره):`,
      wizardComboProviderPickerKeyboard(providers, ctx.providerSlugs || [])
    );
    return;
  }

  // Wizard Step 3: Toggle provider in new combo
  if (data.startsWith('wiz:togprov:')) {
    const slug = data.replace('wiz:togprov:', '');
    const ctx = parseWizardData(user);
    let slugs = ctx.providerSlugs || [];
    if (slugs.includes(slug)) {
      slugs = slugs.filter((s) => s !== slug);
    } else {
      slugs = [...slugs, slug];
    }
    await setWizard(from.id, 'combo:pickprov', { ...ctx, providerSlugs: slugs });
    const providers = await getUserProviders(user.id);
    await api.editMessageReplyMarkup({
      chat_id: chatId,
      message_id: messageId,
      reply_markup: wizardComboProviderPickerKeyboard(providers, slugs),
    }).catch(() => {});
    return;
  }

  // Wizard Step 4: Save new combo
  if (data === 'wiz:saveprov') {
    const ctx = parseWizardData(user);
    const slugs = ctx.providerSlugs || [];
    const policy = ctx.policy || 'fallback';

    if (slugs.length === 0) {
      await api.answerCallbackQuery({
        callback_query_id: query.id,
        text: '⚠️ حداقل یک ارائه‌دهنده را برای کمبو انتخاب کنید!',
        show_alert: true,
      }).catch(() => {});
      return;
    }

    const combo = await createCombo(user.id, {
      name: ctx.name || 'کمبوی جدید',
      providerSlugs: slugs,
      routingPolicy: policy,
    });

    await clearWizard(from.id);

    // Auto-activate if no combo active
    if (!user.activeComboId) {
      await updateUser(from.id, { activeComboId: combo.id });
    }

    const comboList = await getCombos(user.id);
    const updatedUser = await getUser(from.id);
    await edit(
      `🎉 <b>کمبوی «${escHtml(combo.name)}» با موفقیت ساخته شد!</b>\n\n` +
      `🌐 ارائه‌دهنده‌ها: <code>${escHtml(slugs.join(' → '))}</code>\n` +
      `🔄 سیاست مسیریابی: <b>${ROUTING_POLICIES[policy]?.name || policy}</b>` +
      (updatedUser.activeComboId === combo.id ? '\n\n🎯 <b>این کمبو بلافاصله به عنوان کمبوی فعال تنظیم شد!</b>' : ''),
      combosKeyboard(comboList, updatedUser.activeComboId)
    );
    return;
  }

  // Wizard Cancel
  if (data === 'wiz:cancel') {
    await clearWizard(from.id);
    const comboList = await getCombos(user.id);
    await edit('❌ عملیات ساخت کمبو لغو شد.', combosKeyboard(comboList, user.activeComboId));
    return;
  }
}
