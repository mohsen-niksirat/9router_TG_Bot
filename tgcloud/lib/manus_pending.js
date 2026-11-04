/**
 * Deferred delivery of slow Manus tasks — "results come to you in the chat".
 *
 * Constraints measured live on this platform (temporary probes, now removed):
 *   - one invocation: CPU ~3.0s, wall cap in (25s, 30s]
 *   - no cron/delayed execution anywhere (event-driven only)
 *   - no timers/AbortController inside the isolate
 *
 * So when a task outruns the synchronous poll window, callManus queues the
 * task id here; EVERY subsequent user update retries ONE short read, and the
 * moment the task is complete the FULL result (final images + complete text)
 * is sent into the same chat — the user never needs the Manus website.
 */
import { db, api, fetch, InputFile } from 'sdk';
import { eq, and, asc } from 'sdk/db';
import { pendingTasks, userKeys } from 'schema';
import { decryptKey } from 'lib/crypto';
import { readManusTask } from 'lib/ai_router';
import { withTimeout } from 'lib/sleep';
import { sanitizeTelegramHtml, extractMediaAndCleanText } from 'lib/keyboards';

const STALE_SECONDS = 30 * 60;

function taskLink(taskId) {
  return `https://manus.im/app/${taskId}`;
}

export async function enqueuePendingTask(userId, chatId, taskId) {
  try {
    const id = String(taskId);
    const existing = await db.select().from(pendingTasks).where(and(
      eq(pendingTasks.userId, userId),
      eq(pendingTasks.taskId, id),
    )).get();
    if (existing) return;
    await db.insert(pendingTasks).values({ userId, chatId, taskId: id }).run();
  } catch (e) {
    console.warn('[9Router] enqueue pending task failed:', e);
  }
}

export async function manusApiKeyFor(user) {
  if (user?.activeKeyId) {
    try {
      const k = await db.select().from(userKeys)
        .where(and(eq(userKeys.id, user.activeKeyId), eq(userKeys.userId, user.id)))
        .get();
      if (k && k.providerSlug === 'manus') {
        return await decryptKey(k.apiKeyEnc, user.tgId);
      }
    } catch {}
  }
  const keys = await db.select().from(userKeys)
    .where(and(eq(userKeys.userId, user.id), eq(userKeys.providerSlug, 'manus')))
    .orderBy(asc(userKeys.sortOrder), asc(userKeys.id))
    .all();
  if (!keys.length) return '';
  const pick = keys.find((k) => k.status === 'active') || keys[0];
  if (!pick) return '';
  try {
    return await decryptKey(pick.apiKeyEnc, user.tgId);
  } catch {
    return '';
  }
}

async function toPhotoPayload(url) {
  try {
    const res = await withTimeout(fetch(url), 10000);
    if (res && res.ok) {
      const buf = await res.arrayBuffer();
      if (buf && buf.byteLength > 0) {
        const ct = (res.headers.get('content-type') || 'image/png').split(';')[0].trim();
        const mime = ct.includes('webp') ? 'image/webp' : (ct.includes('jpeg') || ct.includes('jpg') ? 'image/jpeg' : 'image/png');
        return new InputFile(new Uint8Array(buf), 'output.png', { type: mime });
      }
    }
  } catch (e) {
    console.warn('[9Router] toPhotoPayload fetch failed:', e);
  }
  return url;
}

export async function sendFullResult(chatId, taskId, snap) {
  const rawText = (snap.assistantText || '').trim();
  const fromTask = Array.from(new Set(snap.mediaList || []))
    .filter((u) => typeof u === 'string' && u.startsWith('http'));
  const extracted = extractMediaAndCleanText(rawText);
  const images = Array.from(new Set([...fromTask, ...extracted.images]));
  const text = extracted.cleanText;
  const header = '🎨 <b>نتیجه نهایی Manus آماده شد</b>';

  if (images.length) {
    const captionParts = [header];
    if (text) captionParts.push(sanitizeTelegramHtml(text).slice(0, 900));
    let photoSent = false;
    const photoPayload = await toPhotoPayload(images[0]);
    try {
      await api.sendPhoto({
        chat_id: chatId,
        photo: photoPayload,
        caption: captionParts.join('\n\n'),
        parse_mode: 'HTML',
      });
      photoSent = true;
    } catch (e) {
      console.warn('[9Router] sendPhoto failed, attempting sendDocument:', e);
      try {
        await api.sendDocument({
          chat_id: chatId,
          document: photoPayload,
          caption: captionParts.join('\n\n'),
          parse_mode: 'HTML',
        });
        photoSent = true;
      } catch (docErr) {
        console.warn('[9Router] sendDocument also failed:', docErr);
      }
    }

    if (!photoSent) {
      await api.sendMessage({
        chat_id: chatId,
        text: `${header}\n\n${sanitizeTelegramHtml(text).slice(0, 3900)}`,
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🖼️ دانلود مستقیم تصویر خروجی', url: images[0] }],
          ],
        },
      });
    }

    for (let i = 1; i < images.length; i++) {
      const extraPayload = await toPhotoPayload(images[i]);
      await api.sendPhoto({
        chat_id: chatId,
        photo: extraPayload,
        caption: `🖼️ خروجی ${i + 1}`,
      }).catch(async () => {
        await api.sendDocument({
          chat_id: chatId,
          document: extraPayload,
          caption: `🖼️ خروجی ${i + 1}`,
        }).catch(() => {});
      });
    }

    if (photoSent && text.length > 800) {
      await api.sendMessage({
        chat_id: chatId,
        text: `📝 <b>متن کامل پاسخ:</b>\n\n${sanitizeTelegramHtml(text).slice(0, 3900)}`,
        parse_mode: 'HTML',
      }).catch(() => {});
    }
    return;
  }

  if (text) {
    await api.sendMessage({
      chat_id: chatId,
      text: `${header}\n\n${sanitizeTelegramHtml(text).slice(0, 3900)}`,
      parse_mode: 'HTML',
    });
    return;
  }

  await api.sendMessage({
    chat_id: chatId,
    text: `✅ تسک Manus تمام شد ولی خروجیای در آن ثبت نشد.\n🔗 <a href="${taskLink(taskId)}">مشاهده تسک</a>`,
    parse_mode: 'HTML',
  }).catch(() => {});
}

/**
 * Called at the top of EVERY incoming update. Cheap when the queue is empty
 * (one SELECT); when entries exist exactly one bounded read is attempted per
 * entry — done tasks are delivered immediately, unfinished ones wait for the
 * next update (never longer than STALE_SECONDS).
 */
export async function deliverPendingTasks(user, chat) {
  try {
    const rows = await db.select().from(pendingTasks)
      .where(eq(pendingTasks.userId, user.id))
      .all();
    if (!rows.length) return;

    const now = Math.floor(Date.now() / 1000);
    for (const row of rows) {
      const age = now - (row.createdAt || now);
      if (age > STALE_SECONDS) {
        await api.sendMessage({
          chat_id: row.chatId,
          text:
            `⌛ <b>زمان انتظار تسک Manus تمام شد</b>\n` +
            `پردازش بیش از ۳۰ دقیقه طول کشید؛ نتیجه در وبسایت موجود است.\n` +
            `🔗 <a href="${taskLink(row.taskId)}">مشاهده تسک</a>`,
          parse_mode: 'HTML',
        }).catch(() => {});
        await db.delete(pendingTasks).where(eq(pendingTasks.id, row.id)).run();
        continue;
      }

      const apiKey = await manusApiKeyFor(user);
      if (!apiKey) return; // keys rotated/removed — keep rows, retry later

      try {
        const snap = await withTimeout(readManusTask(apiKey, row.taskId), 9000);

        if (!snap.done) continue; // still cooking — wait for the next update

        if (snap.agentStatus === 'waiting') {
          await api.sendMessage({
            chat_id: row.chatId,
            text:
              `⏸ <b>تسک Manus در انتظار تأیید شماست</b>\n` +
              `🔗 <a href="${taskLink(row.taskId)}">تأیید و مشاهده</a>`,
            parse_mode: 'HTML',
          }).catch(() => {});
          await db.delete(pendingTasks).where(eq(pendingTasks.id, row.id)).run();
          continue;
        }

        if (snap.assistantText || (snap.mediaList && snap.mediaList.length) || snap.agentStatus === 'completed' || snap.agentStatus === 'stopped') {
          await sendFullResult(row.chatId, row.taskId, snap);
          await db.delete(pendingTasks).where(eq(pendingTasks.id, row.id)).run();
          continue;
        }

        if (snap.agentStatus === 'failed' || snap.agentStatus === 'error') {
          await api.sendMessage({
            chat_id: row.chatId,
            text:
              `❌ <b>تسک Manus ناموفق بود</b> (${snap.agentStatus})\n` +
              `🔗 <a href="${taskLink(row.taskId)}">جزئیات تسک</a>`,
            parse_mode: 'HTML',
          }).catch(() => {});
          await db.delete(pendingTasks).where(eq(pendingTasks.id, row.id)).run();
          continue;
        }
      } catch (e) {
        console.warn('[9Router] pending delivery attempt failed:', e);
        // row survives — the next update retries
      }
    }
  } catch (e) {
    console.warn('[9Router] deliverPendingTasks error:', e);
  }
}