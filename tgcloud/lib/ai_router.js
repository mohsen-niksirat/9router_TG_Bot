/**
 * Multi-Provider AI Router with 9Router-style key rotation.
 * Supports: Gemini, Groq, DeepSeek, OpenAI, OpenRouter, Custom providers.
 * Policies: fallback | round_robin | smart_router | least_used
 */

import { db, fetch } from 'sdk';
import { eq, and, asc, notInArray, sql } from 'sdk/db';
import { userKeys } from 'schema';
import { decryptKey } from 'lib/crypto';
import { markKeyResult, recordUsage, getKeyById } from 'lib/db';
import { withTimeout } from 'lib/sleep';

// Every provider fetch hop is bounded: there is NO AbortController in the
// isolate, so withTimeout abandons the call instead of canceling it — and a
// hung fetch used to stall the whole handler forever (stuck ⏳ placeholder).
// Budgets measured live: CPU ≈ 3.0s/invoke, wall cap ∈ (25s, 30s].
const PROVIDER_HOP_MS = 22000;

// ─── Key Selection ────────────────────────────────────────────────────────────

/**
 * Picks the best available key for a given userId+providerSlug based on policy.
 *
 * `excludeIds` = keys already tried (and failed) in the current request — the
 * fallback policy would otherwise sort them right back to the top because a
 * plain 5xx leaves status='active', which used to abandon the provider after
 * 3 retries on the SAME key instead of moving to key #2.
 *
 * Dead (401/403) and still-cooling keys are never force-resurrected anymore:
 * if nothing is usable, the caller moves to the next provider / reports a
 * clear error instead of hammering a broken key on every request.
 */
export async function getNextKey(userId, providerSlug, policy = 'fallback', excludeIds = []) {
  const now = Math.floor(Date.now() / 1000);

  const common = [eq(userKeys.userId, userId), eq(userKeys.providerSlug, providerSlug)];
  if (excludeIds.length) common.push(notInArray(userKeys.id, excludeIds));
  const baseCond = and(...common, eq(userKeys.status, 'active'));

  let keyRow = null;

  if (policy === 'round_robin') {
    keyRow = await db.select().from(userKeys)
      .where(baseCond)
      .orderBy(asc(userKeys.lastUsedAt), asc(userKeys.id))
      .get();
  } else if (policy === 'smart_router') {
    keyRow = await db.select().from(userKeys)
      .where(baseCond)
      .orderBy(asc(userKeys.failureCount), asc(userKeys.lastUsedAt))
      .get();
  } else if (policy === 'least_used') {
    keyRow = await db.select().from(userKeys)
      .where(baseCond)
      .orderBy(asc(userKeys.totalTokens), asc(userKeys.id))
      .get();
  } else {
    // fallback — strict sort_order priority
    keyRow = await db.select().from(userKeys)
      .where(baseCond)
      .orderBy(asc(userKeys.sortOrder), asc(userKeys.id))
      .get();
  }

  // If no active key, check cooldown expiry
  if (!keyRow) {
    const recovered = await db.select().from(userKeys)
      .where(and(...common, eq(userKeys.status, 'cooldown'), sql`cooldown_until <= ${now}`))
      .orderBy(asc(userKeys.sortOrder), asc(userKeys.id))
      .get();

    if (recovered) {
      await db.update(userKeys)
        .set({ status: 'active', failureCount: 0 })
        .where(eq(userKeys.id, recovered.id))
        .run();
      keyRow = recovered;
    }
  }

  return keyRow;
}

// ─── Provider Callers ─────────────────────────────────────────────────────────

/**
 * Gemini via Google's OpenAI-compatible endpoint.
 */
async function callGemini(apiKey, model, messages, maxTokens) {
  const url = 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions';
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model, messages, temperature: 0.7, max_tokens: maxTokens }),
  });

  if (!res.ok) {
    const errText = await res.text();
    const err = new Error(`Gemini ${res.status}: ${errText.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }

  const data = await res.json();
  const text = (data?.choices?.[0]?.message?.content || '')
    .replace(/<thought>[\s\S]*?<\/thought>/gi, '')
    .trim();

  const usage = data?.usage || {};
  return {
    text,
    promptTokens:     usage.prompt_tokens || 0,
    completionTokens: usage.completion_tokens || 0,
    totalTokens:      usage.total_tokens || 0,
  };
}

/**
 * Any OpenAI-compatible endpoint (Groq, DeepSeek, OpenAI, OpenRouter, custom).
 */
async function callOpenAICompat(baseUrl, apiKey, model, messages, maxTokens) {
  const url = `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model, messages, temperature: 0.7, max_tokens: maxTokens }),
  });

  if (!res.ok) {
    const errText = await res.text();
    const err = new Error(`AI ${res.status}: ${errText.slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }

  const data = await res.json();
  const text = (data?.choices?.[0]?.message?.content || '')
    .replace(/<thought>[\s\S]*?<\/thought>/gi, '')
    .trim();

  const usage = data?.usage || {};
  return {
    text,
    promptTokens:     usage.prompt_tokens || 0,
    completionTokens: usage.completion_tokens || 0,
    totalTokens:      usage.total_tokens || 0,
  };
}


// ─── Manus AI (API v2 Tasks & Agents) ─────────────────────────────────────────

const MANUS_IMAGE_EXTS = ['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'];
const MANUS_INPUT_HINTS = [
  'user_input',
  'input_photo',
  'telegram_photo',
  'telegram_document',
  '/input/',
  'input_image',
  'source_image',
  'original_image',
  'upload',
  'attachment',
];

function looksLikeManusMedia(url) {
  if (!url || typeof url !== 'string') return false;
  const u = url.toLowerCase();
  return (
    MANUS_IMAGE_EXTS.some((ext) => u.includes(ext)) ||
    u.includes('manuscdn.com') ||
    u.includes('files.manus') ||
    u.includes('/asset') ||
    u.includes('/image')
  );
}

function isManusInputFile(url, name) {
  const s = `${name || ''} ${url || ''}`.toLowerCase();
  if (
    s.includes('output') ||
    s.includes('result') ||
    s.includes('edited') ||
    s.includes('export') ||
    s.includes('generated') ||
    s.includes('final')
  ) {
    return false;
  }
  return MANUS_INPUT_HINTS.some((hint) => s.includes(hint));
}

function extractManusMediaUrls(obj, list, depth = 0) {
  if (!obj || depth > 8) return;
  if (typeof obj === 'string') {
    const mdMatches = Array.from(obj.matchAll(/https?:\/\/[^\s\)\"']+/g));
    for (const m of mdMatches) {
      const u = m[0];
      if (looksLikeManusMedia(u) && !isManusInputFile(u, '')) {
        list.push(u);
      }
    }
    return;
  }
  if (Array.isArray(obj)) {
    for (const item of obj) extractManusMediaUrls(item, list, depth + 1);
    return;
  }
  if (typeof obj === 'object') {
    for (const key of ['fileUrl', 'file_url', 'url', 'download_url', 'downloadUrl', 'src', 'image_url', 'imageUrl']) {
      const val = obj[key];
      const name = obj.fileName || obj.filename || obj.name || '';
      if (typeof val === 'string' && val.startsWith('http') && looksLikeManusMedia(val)) {
        if (!isManusInputFile(val, name)) {
          list.push(val);
        }
      }
    }
    for (const v of Object.values(obj)) {
      extractManusMediaUrls(v, list, depth + 1);
    }
  }
}

const MANUS_TERMINAL_STATES = ['completed', 'stopped', 'failed', 'error'];

/**
 * ONE read of a Manus task: task.listMessages + task.detail merged into a
 * snapshot. Shared by callManus (in-window poll) and lib/manus_pending
 * (deferred delivery retried on the user's later updates — the platform
 * cannot wait long enough in a single invocation).
 *
 * @returns {{assistantText, mediaList, agentStatus, statusDetail, done}}
 */
export async function readManusTask(apiKey, taskId, prev) {
  let assistantText = (prev && prev.assistantText) || '';
  const mediaList = (prev && prev.mediaList) || [];
  let agentStatus = (prev && prev.agentStatus) || 'running';
  let statusDetail = (prev && prev.statusDetail) || {};

  const listRes = await fetch(
    `https://api.manus.ai/v2/task.listMessages?task_id=${taskId}&order=desc&limit=30`,
    { headers: { 'x-manus-api-key': apiKey } },
  );
  if (listRes.ok) {
    const listData = await listRes.json();
    const items = Array.isArray(listData)
      ? listData
      : (listData.messages || listData.data || listData.items || []);

    const assistantTexts = [];
    for (const item of items) {
      if (!item) continue;
      // STRICT FILTER: never extract text/media from user input messages
      if (item.type === 'user_message' || item.role === 'user' || item.user_message) {
        continue;
      }
      if (item.agent_status) agentStatus = item.agent_status;
      if (item.status_update?.agent_status) {
        agentStatus = item.status_update.agent_status;
        if (item.status_update.status_detail) statusDetail = item.status_update.status_detail;
      }
      const am = item.assistant_message || (item.type === 'assistant_message' ? item : null);
      if (am) {
        if (typeof am.content === 'string' && am.content.trim()) {
          assistantTexts.push(am.content.trim());
        } else if (Array.isArray(am.content)) {
          for (const part of am.content) {
            if (part.type === 'text' && part.text && part.text.trim()) {
              assistantTexts.push(part.text.trim());
            }
          }
        }
      }
      extractManusMediaUrls(item, mediaList);
    }
    if (assistantTexts.length > 0) {
      const uniqueTexts = [];
      for (const t of assistantTexts) if (!uniqueTexts.includes(t)) uniqueTexts.push(t);
      // reverse: listMessages is order=desc (newest first)
      assistantText = uniqueTexts.reverse().join('\n\n');
    }
  }

  const detailRes = await fetch(
    `https://api.manus.ai/v2/task.detail?task_id=${taskId}`,
    { headers: { 'x-manus-api-key': apiKey } },
  );
  if (detailRes.ok) {
    const detailData = await detailRes.json();
    const taskInfo = detailData.data || detailData.task || detailData;
    if (taskInfo.agent_status || taskInfo.status) {
      agentStatus = taskInfo.agent_status || taskInfo.status;
    }
    if (taskInfo.status_detail) statusDetail = taskInfo.status_detail;
    if (taskInfo.summary && !assistantText) assistantText = taskInfo.summary;
    extractManusMediaUrls(taskInfo, mediaList);
  }

  return {
    assistantText,
    mediaList,
    agentStatus,
    statusDetail,
    done: MANUS_TERMINAL_STATES.includes(agentStatus) || (agentStatus === 'waiting' && statusDetail?.waiting_for_event_type && statusDetail.waiting_for_event_type !== 'cascadeJobCall'),
  };
}

/**
 * Manus AI via official API v2 async task system.
 * Docs: https://open.manus.ai/docs/v2/introduction
 */
async function callManus(apiKey, model, messages, maxTokens, existingTaskId = null) {
  // 1. Resolve agent profile (standard | lite | max)
  let profile = 'standard';
  const m = (model || '').toLowerCase();
  if (m.includes('lite')) profile = 'lite';
  else if (m.includes('max') || m.includes('pro')) profile = 'max';

  // 2. Extract last user prompt & any image attachments
  const userMessages = messages.filter((msg) => msg.role === 'user');
  const lastUserMsg = userMessages[userMessages.length - 1] || messages[messages.length - 1];

  let promptText = '';
  const attachments = [];

  if (typeof lastUserMsg.content === 'string') {
    promptText = lastUserMsg.content;
    const imgRegex = /\[Image: (data:[^\]]+)\]/g;
    const matches = Array.from(promptText.matchAll(imgRegex));
    for (let i = 0; i < matches.length; i++) {
      attachments.push({
        type: 'file',
        file_data: matches[i][1],
        filename: `user_input_photo_${i + 1}.jpg`,
      });
    }
    promptText = promptText.replace(/\[Image: data:[^\]]+\]/g, '').trim();
  } else if (Array.isArray(lastUserMsg.content)) {
    let imgIdx = 0;
    for (const part of lastUserMsg.content) {
      if (part.type === 'text') {
        promptText += (promptText ? '\n' : '') + (part.text || '');
      } else if (part.type === 'image_url' && part.image_url?.url) {
        imgIdx++;
        attachments.push({
          type: 'file',
          file_data: part.image_url.url,
          filename: `user_input_photo_${imgIdx}.jpg`,
        });
      }
    }
  }

  if (!promptText && attachments.length > 0) {
    promptText = 'کیفیت این تصویر را با دقت بسیار بالا ببر، رنگ‌ها و جزئیات آن را بهبود ببخش و نسخه نهایی باکیفیت را ارائه بده.';
  } else if (!promptText) {
    promptText = 'سلام، لطفاً خودت را معرفی کن و بگو چه امکاناتی داری.';
  }

  const contentParts = [{ type: 'text', text: promptText }];
  for (const att of attachments) {
    contentParts.push(att);
  }

  let taskId = existingTaskId;
  let taskUrl = taskId ? `https://manus.im/app/${taskId}` : '';

  if (taskId) {
    // Multi-turn: Send follow-up to the existing task! (POST /v2/task.sendMessage)
    const sendPayload = {
      task_id: taskId,
      message: { content: contentParts },
    };
    try {
      const sendRes = await fetch('https://api.manus.ai/v2/task.sendMessage', {
        method: 'POST',
        headers: {
          'x-manus-api-key': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(sendPayload),
      });

      if (!sendRes.ok) {
        console.warn(`[9Router] task.sendMessage failed on task ${taskId}, falling back to task.create`);
        taskId = null;
      }
    } catch {
      taskId = null;
    }
  }

  if (!taskId) {
    // 3. Create Task (POST /v2/task.create)
    const createPayload = {
      message: { content: contentParts },
      agent_profile: profile,
      hide_in_task_list: false,
      interactive_mode: false,
    };

    const createRes = await fetch('https://api.manus.ai/v2/task.create', {
      method: 'POST',
      headers: {
        'x-manus-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(createPayload),
    });

    if (!createRes.ok) {
      const errText = await createRes.text();
      const err = new Error(`Manus task.create ${createRes.status}: ${errText.slice(0, 200)}`);
      err.status = createRes.status;
      throw err;
    }

    const createData = await createRes.json();
    taskId = createData.task_id || createData.data?.task_id;
    taskUrl = createData.task_url || createData.data?.task_url || `https://manus.im/app/${taskId}`;

    if (!taskId) {
      throw new Error('Manus API did not return a valid task_id.');
    }
  }

  // 4. Poll task execution & retrieve assistant output
  let assistantText = '';
  let mediaList = [];
  let agentStatus = 'running';
  let statusDetail = {};
  // Poll window stays under PROVIDER_HOP_MS/global 17s so this loop always
  // reaches the graceful fallback below (that alignment fixed the 17s bug).
  const deadline = Date.now() + 18000;
  let stillInFlight = false;

  while (Date.now() < deadline) {
    try {
      const snap = await readManusTask(apiKey, taskId, { assistantText, mediaList, agentStatus, statusDetail });
      assistantText = snap.assistantText;
      mediaList = snap.mediaList;
      agentStatus = snap.agentStatus;
      statusDetail = snap.statusDetail;
      if (snap.done) {
        stillInFlight = false;
        break;
      }
      stillInFlight = true;
    } catch (pollErr) {
      console.warn('[9Router] Manus check error:', pollErr);
      stillInFlight = true; // network trouble — the task itself keeps running
    }
    // Rounds are naturally paced by two api.manus.ai round-trips each (no
    // busy-spin: HTML-date-free CPU budget of the isolate is ~3.0s/invoke).
  }

  // 5. Build final text with markdown image embeds
  let finalContent = stillInFlight ? '⏳ <b>پردازش تصویر در مانوس در حال انجام است...</b>\n\nاین تسک شامل پردازش هوشمند تصویر است و معمولاً ۳۰ تا ۹۰ ثانیه زمان می‌برد.\nتصویر و خروجی نهایی مستقیماً در همین چت تلگرام برای شما ارسال خواهد شد:' : assistantText;
  const uniqueFiles = Array.from(new Set(mediaList));
  const imageMarkdown = uniqueFiles
    .map((u) => `![تصویر Manus](${u})`)
    .join('\n\n');

  if (imageMarkdown) {
    finalContent = finalContent ? `${finalContent}\n\n${imageMarkdown}` : imageMarkdown;
  }

  if (!finalContent) {
    if (agentStatus === 'waiting') {
      const waitReason = statusDetail.waiting_description || 'نیاز به تأیید کاربر در مانوس';
      finalContent =
        `⏸ <b>تسک مانوس در انتظار اقدام شما است:</b>\n${waitReason}\n\n` +
        `🔗 <a href="${taskUrl}">مشاهده و اقدام در وب‌سایت Manus</a>`;
    } else {
      finalContent =
        `⏳ <b>تسک مانوس ایجاد شد و پردازش تصویر در سرور ادامه دارد...</b>\n\n` +
        `پردازش‌های هوشمند و سنگین مانوس در پس‌زمینه در حال اجرا هستند. به محض پایان پردازش می‌توانید نتیجه را در پنل زیر نیز دریافت نمایید:\n` +
        `🔗 <a href="${taskUrl}">مشاهده زنده روند در وب‌سایت Manus</a>`;
    }
  } else {
    if (!stillInFlight) finalContent += `\n\n🔗 <a href="${taskUrl}">مشاهده تسک در وب‌سایت Manus</a>`;
  }

  return {
    text: finalContent,
    promptTokens: 120,
    completionTokens: 250,
    totalTokens: 370,
    taskId,
    // Task outran the sync window -> the message handler queues deferred
    // delivery; results arrive in-chat on the user's next update.
    ...(stillInFlight ? { deferredTaskId: taskId } : {}),
  };
}

// ─── Universal Chat ───────────────────────────────────────────────────────────

/**
 * Main entry point: routes a chat request through a combo's provider chain.
 *
 * @param {object} opts
 * @param {number}   opts.userId          DB user id (not tgId)
 * @param {number}   opts.tgId            Telegram user id (for key decryption)
 * @param {object[]} opts.messages        OpenAI-format message array [{role, content}]
 * @param {string[]} opts.providerSlugs   Ordered list of providers to try
 * @param {string}   opts.routingPolicy   fallback|round_robin|smart_router|least_used
 * @param {object}   opts.modelOverrides  { slug: model }
 * @param {object[]} opts.providerRows    userProviders rows for the given slugs
 * @param {number}   [opts.maxTokens=1024]
 * @returns {Promise<{text, provider, model, usage}>}
 */
export async function routeChat({
  userId,
  tgId,
  messages,
  providerSlugs,
  routingPolicy = 'fallback',
  modelOverrides = {},
  providerRows = [],
  maxTokens = 1024,
  existingTaskId = null,
  pinnedKeyId = null,
}) {
  let lastError = null;

  for (const slug of providerSlugs) {
    const triedKeys = [];
    // Try up to 3 *distinct* keys per provider before moving on
    for (let attempt = 0; attempt < 3; attempt++) {
      let keyRow = null;
      if (pinnedKeyId && attempt === 0) {
        keyRow = await getKeyById(pinnedKeyId, userId);
        if (!keyRow || keyRow.providerSlug !== slug || keyRow.status === 'dead') {
          keyRow = null;
        }
      }
      if (!keyRow) {
        if (pinnedKeyId && attempt > 0) break;
        keyRow = await getNextKey(userId, slug, routingPolicy, triedKeys);
      }
      if (!keyRow) break; // No keys for this provider
      triedKeys.push(keyRow.id);

      const plainKey = await decryptKey(keyRow.apiKeyEnc, tgId);

      // Resolve candidate models: override → provider default → provider's registered models → fallback
      const provRow = providerRows.find((p) => p.slug === slug);
      let provModels = [];
      try { provModels = JSON.parse(provRow?.models || '[]'); } catch {}

      const candidateModels = [
        modelOverrides[slug],
        provRow?.defaultModel,
        ...provModels,
        slug === 'gemini' ? 'gemini-2.5-flash-lite' : 'gpt-4o-mini',
      ].filter((m, i, arr) => m && arr.indexOf(m) === i);

      let keySucceeded = false;
      for (const model of candidateModels) {
        try {
          let result;
          if (slug === 'gemini') {
            result = await withTimeout(callGemini(plainKey, model, messages, maxTokens), PROVIDER_HOP_MS);
          } else if (slug === 'manus') {
            result = await withTimeout(callManus(plainKey, model, messages, maxTokens, existingTaskId), PROVIDER_HOP_MS);
          } else {
            const baseUrl = provRow?.baseUrl || 'https://api.openai.com/v1';
            result = await withTimeout(callOpenAICompat(baseUrl, plainKey, model, messages, maxTokens), PROVIDER_HOP_MS);
          }

          if (result && result.text) {
            keySucceeded = true;
            await markKeyResult(keyRow.id, true);
            await recordUsage({
              userId,
              keyId:            keyRow.id,
              provider:         slug,
              model,
              promptTokens:     result.promptTokens,
              completionTokens: result.completionTokens,
            }).catch(() => {});
            return { text: result.text, provider: slug, model, usage: result, taskId: result.taskId, deferredTaskId: result.deferredTaskId };
          }
        } catch (err) {
          lastError = err;
          // If model not found or not served, fall back to the next registered model for this provider!
          const isModelError = err.status === 404 ||
            (err.status === 400 && /model|not found|not serve|does not exist/i.test(err.message || ''));
          if (isModelError) {
            console.warn(`[9Router] Model ${model} not served by ${slug}, trying next candidate model in chain...`);
            continue;
          }
          // Auth (401/403) or Rate Limit (429): break model loop to trigger key failover
          break;
        }
      }

      if (!keySucceeded) {
        await markKeyResult(keyRow.id, false, lastError?.status || 500);
        console.warn(`[9Router] ${slug} key #${keyRow.id} failed:`, lastError?.message);
      }
    }
  }

  throw new Error(
    `تمام ارائه‌دهنده‌ها و کلیدهای کمبو شکست خوردند. آخرین خطا: ${lastError?.message || 'نامشخص'}`
  );
}
