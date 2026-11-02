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

      // Resolve model: override → provider default → fallback
      const provRow = providerRows.find((p) => p.slug === slug);
      const model = modelOverrides[slug] || provRow?.defaultModel || 'gpt-4o-mini';

      try {
        let result;
        if (slug === 'gemini') {
          result = await callGemini(plainKey, model, messages, maxTokens);
        } else {
          const baseUrl = provRow?.baseUrl || 'https://api.openai.com/v1';
          result = await callOpenAICompat(baseUrl, plainKey, model, messages, maxTokens);
        }

        if (result && result.text) {
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
        await markKeyResult(keyRow.id, false, err.status || 500);
        console.warn(`[9Router] ${slug} key #${keyRow.id} failed:`, err.message);
      }
    }
  }

  throw new Error(
    `تمام ارائه‌دهنده‌ها و کلیدهای کمبو شکست خوردند. آخرین خطا: ${lastError?.message || 'نامشخص'}`
  );
}
