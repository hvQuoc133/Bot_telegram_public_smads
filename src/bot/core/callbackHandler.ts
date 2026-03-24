import TelegramBot from 'node-telegram-bot-api';
import { bot, botUsername } from '../botInstance';
import { db } from '../../db';
import { getSession, updateSession, clearSession, roleCache, CACHE_TTL } from '../services/sessionManager';
import { handleRegulationCallback } from '../topics/regulationTopic';
import { handleAdminCallback } from '../topics/adminTopic';
import { handleReportCallback } from '../topics/reportTopic';
import { handleTopicCallback } from '../topics/topicManager';
import { handleInfoCallback } from '../topics/infoTopic';
import { handleAnnouncementCallback } from '../topics/announcementTopic';
import { handleToolsCallback } from '../topics/toolsTopic';
import { handleProposalCallback } from '../topics/proposalTopic';

export async function handleCallbackQuery(query: TelegramBot.CallbackQuery) {
  const chatId = query.message?.chat.id;
  const messageId = query.message?.message_id;
  const data = query.data;
  const userId = query.from.id;

  if (!chatId || !messageId || !data) return;

  try {
    const session = getSession(userId);

    // Check role
    let userRole = 'user';
    const now = Date.now();
    const cachedRole = roleCache.get(userId);
    if (cachedRole && cachedRole.expire > now) {
      userRole = cachedRole.role;
    } else {
      const userRes = await db.query('SELECT role FROM users WHERE id = $1', [userId]);
      userRole = userRes.rows[0]?.role || 'user';
      roleCache.set(userId, { role: userRole, expire: now + CACHE_TTL });
    }

    if (data.startsWith('reg_')) {
      const handled = await handleRegulationCallback(bot, query, data, userRole, session);
      if (handled) return;
    }

    if (data.startsWith('rep_')) {
      const handled = await handleReportCallback(bot, query, data, userRole, session);
      if (handled) return;
    }

    if (data.startsWith('admin_')) {
      const infoHandled = await handleInfoCallback(bot, query, data, userRole);
      if (infoHandled) return;

      const handled = await handleAdminCallback(bot, query, data, userRole);
      if (handled) return;
    }

    if (data.startsWith('info_')) {
      const handled = await handleInfoCallback(bot, query, data, userRole);
      if (handled) return;
    }

    if (data.startsWith('ann_')) {
      const handled = await handleAnnouncementCallback(bot, query, data, userRole);
      if (handled) return;
    }

    if (data.startsWith('tools_')) {
      const handled = await handleToolsCallback(bot, query, data, userRole, session);
      if (handled) return;
    }

    if (data.startsWith('prop_')) {
      const handled = await handleProposalCallback(bot, query, data, userRole, session);
      if (handled) return;
    }

    if (data.startsWith('topic_')) {
      console.log(`[Callback] Handling topic callback: ${data}`);
      const handled = await handleTopicCallback(bot, query, data, userRole);
      if (handled) return;

      console.log(`[Callback] Topic callback NOT handled: ${data}`);
      bot.answerCallbackQuery(query.id, { text: 'Thao tác topic này hiện chưa được xử lý.' }).catch(() => { });
      return;
    }

    if (data === 'user_dashboard') {
      const welcomeText = '🛠 **BẢNG ĐIỀU KHIỂN USER**\n\nChào bạn, vui lòng chọn chức năng từ Menu bên dưới:';
      const keyboard = [
        [{ text: '📜 Xem Nội quy', callback_data: 'reg_list' }],
        [{ text: '📇 Xem Thông tin Nhân sự', callback_data: 'info_list' }],
        [{ text: '📢 Xem Thông báo', callback_data: 'ann_user_list' }],
        [{ text: '🛠 Xem Công cụ', callback_data: 'tools_list' }],
        [
          { text: '📝 Gửi báo cáo', callback_data: 'rep_create' },
          { text: '📋 Lịch sử báo cáo', callback_data: 'rep_my_stats' }
        ],
        [
          { text: '💡 Tạo đề xuất', url: `https://t.me/${botUsername}?start=create_proposal` },
          { text: '📋 Lịch sử đề xuất', url: `https://t.me/${botUsername}?start=my_proposals` }
        ]
      ];

      bot.editMessageText(welcomeText, {
        chat_id: chatId,
        message_id: messageId,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboard }
      }).catch(() => { });
      bot.answerCallbackQuery(query.id).catch(() => { });
      return;
    }

    // Fallback for unknown callbacks
    bot.answerCallbackQuery(query.id, { text: 'Tính năng này chưa được hỗ trợ.' }).catch(() => { });
  } catch (error) {
    console.error('Error handling callback query:', error);
    bot.answerCallbackQuery(query.id, { text: 'Có lỗi xảy ra, vui lòng thử lại sau.', show_alert: true }).catch(() => { });
  }
}
