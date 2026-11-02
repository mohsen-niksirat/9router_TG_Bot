import { api } from 'sdk';
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
  combosKeyboard,
  comboDetailKeyboard,
  routingPolicyKeyboard,
  comboProviderPickerKeyboard,
  chatActionsKeyboard,
  backKeyboard,
} from 'lib/keyboards';

export default async function (query) {
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

  // ─── New Chat ──────────────────────────────────────────────────────────────
  if (data === 'a:new_chat') {
    await clearHistory(user.id);
    const comboRaw = await getActiveCombo(user);
    const combo = parseCombo(comboRaw);
    await edit(
      `💬 <b>چت جدید شروع شد!</b> تاریخچه پاک شد.\n\n` +
      (combo
        ? `🔀 کمبوی فعال: <b>${escHtml(combo.name)}</b>\n<i>حالا پیامت رو بنویس...</i>`
        : `⚠️ کمبویی انتخاب نشده! از منوی کمبوها یک کمبو فعال کن.`),
      chatActionsKeyboard()
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

    const plain = decryptKey(k.apiKeyEnc, from.id);
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
    const providers = await getUserProviders(user.id);
    const prov = providers.find((p) => p.id === provId);
    if (!prov) { await edit('❌ ارائه‌دهنده یافت نشد.', backKeyboard('a:providers')); return; }

    const models = (() => {
      try { return JSON.parse(prov.models || '[]'); } catch { return []; }
    })();

    await edit(
      `🌐 <b>${escHtml(prov.name)}</b>\n\n` +
      `Slug: <code>${escHtml(prov.slug)}</code>\n` +
      `Base URL: <code>${escHtml(prov.baseUrl)}</code>\n` +
      `مدل پیش‌فرض: <code>${escHtml(prov.defaultModel || '—')}</code>\n` +
      `مدل‌ها: <code>${escHtml(models.join(', ') || '—')}</code>`,
      providerDetailKeyboard(prov)
    );
    return;
  }

  if (data === 'p:add') {
    await setWizard(from.id, 'prov:name');
    await edit(
      '🌐 <b>افزودن ارائه‌دهنده سفارشی</b>\n\nلطفاً <b>نام</b> ارائه‌دهنده را بنویسید:\n<i>مثال: Avalai, DeepInfra, ...</i>',
      backKeyboard('a:providers')
    );
    return;
  }

  if (data.startsWith('p:models:')) {
    const provId = parseInt(data.replace('p:models:', ''), 10);
    await setWizard(from.id, `prov:models:${provId}`);
    await edit(
      `✏️ <b>ویرایش مدل‌ها</b>\n\nلیست مدل‌ها را با کاما یا خط جدید جدا کرده بفرست:\n<i>مثال: gpt-4o, gpt-4o-mini, o1-mini</i>`,
      backKeyboard(`p:view:${provId}`)
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
    const combo = await getComboById(comboId, user.id);
    if (!combo) { await edit('❌ کمبو یافت نشد.', backKeyboard('a:combos')); return; }
    const parsed = parseCombo(combo);
    const isActive = user.activeComboId === comboId;
    const policy = ROUTING_POLICIES[parsed.routingPolicy] || { name: parsed.routingPolicy };

    await edit(
      `🔀 <b>${escHtml(parsed.name)}</b> ${isActive ? '✅' : ''}\n\n` +
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
    const updatedUser = await getUser(from.id);
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

  // Edit providers in combo
  if (data.startsWith('c:editprov:')) {
    const comboId = parseInt(data.replace('c:editprov:', ''), 10);
    const combo = await getComboById(comboId, user.id);
    if (!combo) { await edit('❌ کمبو یافت نشد.', backKeyboard('a:combos')); return; }
    const parsed = parseCombo(combo);
    const providers = await getUserProviders(user.id);
    await edit(
      `✏️ <b>ویرایش ارائه‌دهنده‌های کمبو</b>\n\nفعلاً: <code>${escHtml(parsed.providerSlugs.join(', '))}</code>\n\nارائه‌دهنده‌ها را تیک بزن یا بردار:`,
      comboProviderPickerKeyboard(providers, parsed.providerSlugs, comboId)
    );
    return;
  }

  // Toggle provider in combo edit
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

  // Save providers in combo
  if (data.startsWith('c:saveprov:')) {
    const comboId = parseInt(data.replace('c:saveprov:', ''), 10);
    const combo = await getComboById(comboId, user.id);
    await edit(
      `✅ ارائه‌دهنده‌های کمبو ذخیره شدند.`,
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

  // ─── Create Combo wizard (callback portion: policy selection) ───────────────
  if (data === 'c:create') {
    await clearWizard(from.id);
    await setWizard(from.id, 'combo:name', { providerSlugs: [] });
    await edit(
      `➕ <b>ایجاد کمبوی جدید</b>\n\nلطفاً <b>نام کمبو</b> را در چت بنویس:\n<i>مثال: سریع و رایگان، Gemini Pro، ترکیبی</i>`,
      backKeyboard('a:combos')
    );
    return;
  }

  // Wizard: combo policy selected via button
  if (data.startsWith('wiz:combo:pol:')) {
    const policy = data.replace('wiz:combo:pol:', '');
    const ctx = parseWizardData(user);

    const providers = await getUserProviders(user.id);
    await setWizard(from.id, 'combo:pickprov', { ...ctx, policy, providerSlugs: ctx.providerSlugs || [] });

    await edit(
      `✅ سیاست: <b>${ROUTING_POLICIES[policy]?.name || policy}</b>\n\n` +
      `حالا ارائه‌دهنده‌هایی که می‌خوای در این کمبو باشن رو انتخاب کن:`,
      comboProviderPickerKeyboard(providers, ctx.providerSlugs || [], `new_${policy}`)
    );
    return;
  }

  // Wizard: toggle provider during combo creation
  if (data.startsWith('c:togprov:new_')) {
    const parts = data.replace('c:togprov:new_', '').split(':');
    const policy = parts[0];
    const slug = parts.slice(1).join(':');
    const ctx = parseWizardData(user);
    let slugs = ctx.providerSlugs || [];
    if (slugs.includes(slug)) {
      slugs = slugs.filter((s) => s !== slug);
    } else {
      slugs = [...slugs, slug];
    }
    await setWizard(from.id, user.wizardState, { ...ctx, providerSlugs: slugs });
    const providers = await getUserProviders(user.id);
    await api.editMessageReplyMarkup({
      chat_id: chatId,
      message_id: messageId,
      reply_markup: comboProviderPickerKeyboard(providers, slugs, `new_${policy}`),
    }).catch(() => {});
    return;
  }

  // Wizard: save new combo
  if (data.startsWith('c:saveprov:new_')) {
    const policy = data.replace('c:saveprov:new_', '');
    const ctx = parseWizardData(user);
    const slugs = ctx.providerSlugs || [];

    if (slugs.length === 0) {
      await edit('⚠️ حداقل یک ارائه‌دهنده را انتخاب کن!',
        comboProviderPickerKeyboard(await getUserProviders(user.id), [], `new_${policy}`)
      );
      return;
    }

    const combo = await createCombo(user.id, {
      name:          ctx.name || 'کمبوی جدید',
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
      `✅ کمبوی <b>${escHtml(combo.name)}</b> ساخته شد!\n\n` +
      `ارائه‌دهنده‌ها: <code>${escHtml(slugs.join(' → '))}</code>\n` +
      `سیاست: <b>${ROUTING_POLICIES[policy]?.name || policy}</b>` +
      (updatedUser.activeComboId === combo.id ? '\n\n🎯 این کمبو فعال شد!' : ''),
      combosKeyboard(comboList, updatedUser.activeComboId)
    );
    return;
  }
}
