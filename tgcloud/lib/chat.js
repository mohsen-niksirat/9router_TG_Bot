/**
 * Chat orchestrator: builds messages array from history and calls the router.
 */

import { getHistory, appendHistory, clearHistory, getActiveCombo, parseCombo, getUserProviders } from 'lib/db';
import { routeChat } from 'lib/ai_router';

const SYSTEM_PROMPT =
  'تو یک دستیار هوشمند هستی. پاسخ‌هایت را به صورت واضح، مفید و دوستانه بده. ' +
  'اگر کاربر فارسی نوشت، فارسی جواب بده. اگر انگلیسی نوشت، انگلیسی جواب بده.';

/**
 * Send a user message through the 9Router and record the exchange in history.
 *
 * @param {object} dbUser   Full DB user row
 * @param {number} tgId     Telegram user ID
 * @param {string} userText The user's message
 * @returns {Promise<{text, provider, model}>}
 */
export async function sendChat(dbUser, tgId, userText) {
  // 1. Load history
  const history = await getHistory(dbUser.id);

  // 2. Build messages array
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history,
    { role: 'user', content: userText },
  ];

  // 3. Get active combo (or fail gracefully)
  const comboRaw = await getActiveCombo(dbUser);
  const combo = parseCombo(comboRaw);

  let providerSlugs = ['gemini'];
  let routingPolicy = 'fallback';
  let modelOverrides = {};

  if (combo && combo.providerSlugs.length > 0) {
    providerSlugs  = combo.providerSlugs;
    routingPolicy  = combo.routingPolicy || 'fallback';
    modelOverrides = combo.modelOverrides || {};
  }

  // 4. Fetch provider rows for the selected slugs
  const allProviders = await getUserProviders(dbUser.id);
  const providerRows = allProviders.filter((p) => providerSlugs.includes(p.slug));

  // 5. Route
  const result = await routeChat({
    userId:       dbUser.id,
    tgId,
    messages,
    providerSlugs,
    routingPolicy,
    modelOverrides,
    providerRows,
    maxTokens:    1500,
  });

  // 6. Save to history
  await appendHistory(dbUser.id, 'user', userText);
  await appendHistory(
    dbUser.id,
    'assistant',
    result.text,
    result.provider,
    result.model,
    result.usage?.totalTokens || 0
  );

  return result;
}

export { clearHistory };
