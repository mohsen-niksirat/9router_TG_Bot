/**
 * Multi-Provider AI Router with 9Router-style key rotation.
 * Supports: Gemini, Groq, DeepSeek, OpenAI, OpenRouter, Custom providers.
 * Policies: fallback | round_robin | smart_router | least_used
 */

import { db, fetch } from 'sdk';
import { eq, and, asc, sql } from 'sdk/db';
import { userKeys } from 'schema';
import { decryptKey } from 'lib/crypto';
import { markKeyResult, recordUsage } from 'lib/db';

// ─── Key Selection ────────────────────────────────────────────────────────────

/**
 * Picks the best available key for a given userId+providerSlug based on policy.
 */
export async function getNextKey(userId, providerSlug, policy = 'fallback') {
  const now = Math.floor(Date.now() / 1000);

  // Build ordered query depending on policy
  const baseCond = and(
    eq(userKeys.userId, userId),
    eq(userKeys.providerSlug, providerSlug),
    eq(userKeys.status, 'active')
  );

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
      .where(and(
        eq(userKeys.userId, userId),
        eq(userKeys.providerSlug, providerSlug),
        eq(userKeys.status, 'cooldown'),
        sql`cooldown_until <= ${now}`
      ))
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

  // Last resort: reactivate oldest cooldown key so bot never hangs
  if (!keyRow) {
    const fallback = await db.select().from(userKeys)
      .where(and(eq(userKeys.userId, userId), eq(userKeys.providerSlug, providerSlug)))
      .orderBy(asc(userKeys.lastUsedAt))
      .get();

    if (fallback) {
      await db.update(userKeys)
        .set({ status: 'active', failureCount: 0, cooldownUntil: 0 })
        .where(eq(userKeys.id, fallback.id))
        .run();
      keyRow = fallback;
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

function extractManusMediaUrls(obj, list, depth = 0) {
  if (!obj || depth > 7) return;
  if (typeof obj === 'string') {
    const mdMatches = Array.from(obj.matchAll(/https?:\/\/[^\s\)\"']+/g));
    for (const m of mdMatches) {
      if (looksLikeManusMedia(m[0])) list.push(m[0]);
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
      if (typeof val === 'string' && val.startsWith('http') && looksLikeManusMedia(val)) {
        list.push(val);
      }
    }
    for (const v of Object.values(obj)) {
      extractManusMediaUrls(v, list, depth + 1);
    }
  }
}

/**
 * Manus AI via official API v2 async task system.
 * Docs: https://open.manus.ai/docs/v2/introduction
 */
async function callManus(apiKey, model, messages, maxTokens) {
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
        filename: `photo_${i + 1}.jpg`,
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
          filename: `photo_${imgIdx}.jpg`,
        });
      }
    }
  }

  if (!promptText && attachments.length > 0) {
    promptText = 'کیفیت این تصویر را با دقت بهبود بده، جزئیات را تقویت کن و نتیجه را ارائه بده.';
  } else if (!promptText) {
    promptText = 'سلام، لطفاً خودت را معرفی کن و بگو چه امکاناتی داری.';
  }

  const contentParts = [{ type: 'text', text: promptText }];
  for (const att of attachments) {
    contentParts.push(att);
  }

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
  const taskId = createData.task_id || createData.data?.task_id;
  const taskUrl = createData.task_url || createData.data?.task_url || `https://manus.im/app/${taskId}`;

  if (!taskId) {
    throw new Error('Manus API did not return a valid task_id.');
  }

  // 4. Check task execution and message events (no setTimeout in serverless)
  let assistantText = '';
  const mediaList = [];
  const maxAttempts = 6;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const listRes = await fetch(
        `https://api.manus.ai/v2/task.listMessages?task_id=${taskId}&order=desc&limit=25`,
        {
          headers: { 'x-manus-api-key': apiKey },
        }
      );

      if (listRes.ok) {
        const listData = await listRes.json();
        const items = Array.isArray(listData)
          ? listData
          : (listData.messages || listData.data || listData.items || []);

        let agentStatus = null;
        for (const item of items) {
          if (item.agent_status) agentStatus = item.agent_status;
          if (item.status_update?.agent_status) agentStatus = item.status_update.agent_status;

          const am = item.assistant_message || (item.type === 'assistant_message' ? item : null);
          if (am) {
            if (typeof am.content === 'string' && am.content.trim()) {
              assistantText = am.content.trim();
            } else if (Array.isArray(am.content)) {
              const joined = am.content.map((p) => p.text || '').join('\n').trim();
              if (joined) assistantText = joined;
            }
          }

          extractManusMediaUrls(item, mediaList);
        }

        if (['completed', 'stopped', 'waiting'].includes(agentStatus) || mediaList.length > 0) {
          break;
        }
      }
    } catch (pollErr) {
      console.warn('[9Router] Manus check error:', pollErr);
    }
  }

  // 5. Build final text with markdown image embeds
  let finalContent = assistantText;
  const uniqueFiles = Array.from(new Set(mediaList));
  const imageMarkdown = uniqueFiles
    .map((u) => `![تصویر Manus](${u})`)
    .join('\n\n');

  if (imageMarkdown) {
    finalContent = finalContent ? `${finalContent}\n\n${imageMarkdown}` : imageMarkdown;
  }

  if (!finalContent) {
    finalContent =
      `🦾 <b>تسک مانوس ایجاد شد و در حال انجام است!</b>\n\n` +
      `پردازش مانوس ممکن است کمی زمان ببرد. می‌توانید روند پیشرفت زنده یا فایل‌های تولیدشده را در لینک زیر پیگیری نمایید:\n` +
      `🔗 <a href="${taskUrl}">مشاهده تسک در Manus</a>`;
  } else {
    finalContent += `\n\n🔗 <a href="${taskUrl}">مشاهده تسک در وب‌سایت Manus</a>`;
  }

  return {
    text: finalContent,
    promptTokens: 120,
    completionTokens: 250,
    totalTokens: 370,
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
}) {
  let lastError = null;

  for (const slug of providerSlugs) {
    // Try up to 3 keys per provider before moving on
    for (let attempt = 0; attempt < 3; attempt++) {
      const keyRow = await getNextKey(userId, slug, routingPolicy);
      if (!keyRow) break; // No keys for this provider

      const plainKey = decryptKey(keyRow.apiKeyEnc, tgId);

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
            result = await callGemini(plainKey, model, messages, maxTokens);
          } else if (slug === 'manus') {
            result = await callManus(plainKey, model, messages, maxTokens);
          } else {
            const baseUrl = provRow?.baseUrl || 'https://api.openai.com/v1';
            result = await callOpenAICompat(baseUrl, plainKey, model, messages, maxTokens);
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
            return { text: result.text, provider: slug, model, usage: result };
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
