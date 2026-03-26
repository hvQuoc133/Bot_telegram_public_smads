import TelegramBot from 'node-telegram-bot-api';
import { getSession, updateSession, clearSession, roleCache, topicCache, CACHE_TTL } from '../services/sessionManager';
import { db } from '../../db';
import { bot, botUsername } from '../botInstance';
import { setAdminPrivateCommands, removeAdminPrivateCommands } from '../utils/setupCommands';
import { handleAdminCommand, handleAdminState, handleAdminDeepLink, handleAdminDashboard } from '../topics/adminTopic';
import { handleRegulationCommand, handleRegulationDeepLink, handleRegulationState, refreshAllRegulationTopics } from '../topics/regulationTopic';
import { handleSetTopicCommand, getTopicFeature } from '../topics/topicManager';
import { handleReportDeepLink, handleReportState, handleReportCallback } from '../topics/reportTopic';
import { handleInfoMessage, handleInfoDeepLink } from '../topics/infoTopic';
import { handleAnnouncementDeepLink, handleAnnouncementState } from '../topics/announcementTopic';
import { handleToolsDeepLink, handleToolsState, handleToolsCommand } from '../topics/toolsTopic';
import { handleProposalDeepLink, handleProposalState } from '../topics/proposalTopic';

const commandCache = new Map<string, number>();
const COMMAND_COOLDOWN = 15000; // 15 seconds

export async function handleMessage(msg: TelegramBot.Message) {
  const chatId = msg.chat.id;
  const userId = msg.from?.id;
  const username = msg.from?.username;
  const isPrivate = msg.chat.type === 'private';
  const topicId = msg.message_thread_id;

  const text = msg.text || '';
  // Extract command properly: "/regulations@bot_username some text" -> "/regulations"
  const command = text.trim().split(/\s+/)[0].split('@')[0].toLowerCase();

  if (!userId) return;

  // Check if user is a Telegram Group Admin / Creator
  let isGroupAdmin = false;
  let isGroupCreator = false;
  if (!isPrivate) {
    if (msg.sender_chat) {
      isGroupAdmin = true; // Sent as channel/group
      isGroupCreator = true; // Treat channel sender as creator for admin purposes
    } else {
      try {
        const chatMember = await bot.getChatMember(chatId, userId);
        if (['creator', 'administrator'].includes(chatMember.status)) {
          isGroupAdmin = true;
        }
        if (chatMember.status === 'creator') {
          isGroupCreator = true;
        }
      } catch (err) {
        console.error('Error checking chat member status:', err);
      }
    }
  }

  // Ensure user exists in DB
  let userRole = 'user';
  const now = Date.now();
  const cachedRole = roleCache.get(userId);

  if (cachedRole && cachedRole.expire > now) {
    userRole = cachedRole.role;
  } else {
    try {
      const firstName = msg.from?.first_name || '';
      const lastName = msg.from?.last_name || '';
      const userRes = await db.query('SELECT role FROM users WHERE id = $1', [userId]);
      if (userRes.rows.length === 0) {
        const countRes = await db.query('SELECT COUNT(*) FROM users');
        const isFirstUser = parseInt(countRes.rows[0].count) === 0;
        userRole = (isFirstUser || isGroupCreator || isGroupAdmin) ? 'admin' : 'user';
        await db.query('INSERT INTO users (id, username, first_name, last_name, role) VALUES ($1, $2, $3, $4, $5)', [userId, username, firstName, lastName, userRole]);
      } else {
        userRole = userRes.rows[0].role;
        // Auto-promote group creator or admin to bot admin if they aren't already
        if ((isGroupCreator || isGroupAdmin) && userRole !== 'admin') {
          userRole = 'admin';
          await db.query("UPDATE users SET role = 'admin', first_name = $1, last_name = $2 WHERE id = $3", [firstName, lastName, userId]);
          await setAdminPrivateCommands(bot, userId);
        } else {
          await db.query("UPDATE users SET username = $1, first_name = $2, last_name = $3 WHERE id = $4", [username, firstName, lastName, userId]);
        }
      }
      roleCache.set(userId, { role: userRole, expire: now + CACHE_TTL });
    } catch (err) {
      console.error('Error ensuring user:', err);
    }
  }

  const session = getSession(userId);

  // Anti-spam for display commands
  const displayCommands = ['/regulations', '/edit_regulation', '/delete_regulation'];
  if (displayCommands.includes(command) && text.trim().split(/\s+/).length === 1) {
    const cacheKey = `${chatId}_${topicId || ''}_${command}`;
    const lastUsed = commandCache.get(cacheKey);
    if (lastUsed && now - lastUsed < COMMAND_COOLDOWN) {
      const replyOptions: TelegramBot.SendMessageOptions = {};
      if (topicId) replyOptions.message_thread_id = topicId;
      bot.sendMessage(chatId, '⚠️ Bảng thông tin này đã được hiển thị gần đây. Vui lòng xem tin nhắn ở trên để tránh spam.', replyOptions)
        .then(m => setTimeout(() => bot.deleteMessage(chatId, m.message_id).catch(() => { }), 5000));
      bot.deleteMessage(chatId, msg.message_id).catch(() => { });
      return;
    }
    commandCache.set(cacheKey, now);
  }

  const replyOptions: TelegramBot.SendMessageOptions = {};
  if (!isPrivate && topicId) replyOptions.message_thread_id = topicId;

  // 1. Group Chat Logic (Topic-based features)
  if (!isPrivate) {
    const { feature, targetId } = await getTopicFeature(chatId, topicId);

    // Prevent chatting in specific topics
    if ((feature === 'regulation' || feature === 'report' || feature === 'information' || feature === 'announcement' || feature === 'tools' || feature === 'contact') && !text.startsWith('/')) {
      bot.deleteMessage(chatId, msg.message_id).catch(() => { });
      bot.sendMessage(chatId, '⚠️ Topic này không được chat, chỉ được xem và sử dụng lệnh /.', replyOptions)
        .then(m => setTimeout(() => bot.deleteMessage(chatId, m.message_id).catch(() => { }), 5000));
      return;
    }

    // If it's a regulation, report, information, announcement, tools, or contact topic, auto-delete the user's message after 5s
    if (feature === 'regulation' || feature === 'report' || feature === 'information' || feature === 'announcement' || feature === 'tools' || feature === 'contact') {
      setTimeout(() => bot.deleteMessage(chatId, msg.message_id).catch(() => { }), 5000);
    }

    // Debug command to check if bot is alive in the group
    if (command === '/ping') {
      bot.sendMessage(chatId, '🏓 Pong! Bot đang hoạt động tốt trong nhóm/topic này.', replyOptions)
        .then(m => { if (feature === 'regulation' || feature === 'report') setTimeout(() => bot.deleteMessage(chatId, m.message_id).catch(() => { }), 30000); })
        .catch(console.error);
      return;
    }

    // Admin management commands (works in both group and private)
    if (command === '/menuadmin') {
      if (userRole !== 'admin') {
        bot.sendMessage(chatId, '❌ Chỉ Admin của bot mới có thể dùng lệnh này.', replyOptions)
          .then(m => setTimeout(() => bot.deleteMessage(chatId, m.message_id).catch(() => { }), 10000));
        bot.deleteMessage(chatId, msg.message_id).catch(() => { });
        return;
      }

      const deepLink = botUsername ? `https://t.me/${botUsername}?start=admin_dashboard` : 'https://t.me/your_bot';

      bot.sendMessage(chatId, '⚙️ Vui lòng chuyển sang nhắn tin riêng (Inbox) với bot để mở Menu Admin nhé!', {
        ...replyOptions,
        reply_markup: {
          inline_keyboard: [[{ text: '👉 Mở Menu Admin', url: deepLink }]]
        }
      }).then(m => setTimeout(() => bot.deleteMessage(chatId, m.message_id).catch(() => { }), 30000))
        .catch(console.error);

      bot.deleteMessage(chatId, msg.message_id).catch(() => { });
      return;
    }

    if (command === '/reload_regulations') {
      if (userRole !== 'admin') {
        bot.sendMessage(chatId, '❌ Chỉ Admin của bot mới có thể dùng lệnh này.', replyOptions)
          .then(m => setTimeout(() => bot.deleteMessage(chatId, m.message_id).catch(() => { }), 10000));
        return;
      }
      await refreshAllRegulationTopics(bot);
      bot.sendMessage(chatId, '✅ Đã tải lại danh sách nội quy!', replyOptions)
        .then(m => setTimeout(() => bot.deleteMessage(chatId, m.message_id).catch(() => { }), 10000));
      return;
    }

    if (await handleAdminCommand(bot, msg, command, userRole, session, replyOptions)) return;
    if (await handleToolsCommand(bot, msg, command, userRole, session, replyOptions)) return;

    // If user types management commands in group, tell them to DM the bot
    if (['/create_regulation', '/edit_regulation', '/delete_regulation', '/cancel'].includes(command)) {
      // Delete the command message to keep the group clean
      bot.deleteMessage(chatId, msg.message_id).catch(() => { });

      const deepLink = botUsername ? `https://t.me/${botUsername}?start=${command.replace('/', '')}` : 'https://t.me/your_bot';

      bot.sendMessage(chatId, '⚙️ Vui lòng chuyển sang nhắn tin riêng (Inbox) với bot để sử dụng các chức năng quản lý nhé!', {
        ...replyOptions,
        reply_markup: {
          inline_keyboard: [[{ text: '👉 Chuyển đến Inbox Bot', url: deepLink }]]
        }
      }).then(m => { if (feature === 'regulation' || feature === 'report') setTimeout(() => bot.deleteMessage(chatId, m.message_id).catch(() => { }), 30000); })
        .catch(console.error);
      return;
    }

    // Setup topic command for admins
    if (await handleSetTopicCommand(bot, msg, command, userRole, isGroupAdmin, replyOptions)) return;

    if (feature === 'discussion') {
      return;
    }

    // If no feature is set for this group/topic, just ignore messages
    return;
  }

  // 2. Private Chat Logic (Admin/User flows)
  if (isPrivate) {
    // Auto delete user's message in private chat after 15s to keep it clean
    setTimeout(() => bot.deleteMessage(chatId, msg.message_id).catch(() => { }), 15000);

    if (command === '/start' || command.startsWith('/start ') || command === '/menu') {
      console.log(`[DEBUG] User ${userId} (${username}) role: ${userRole} triggered ${command}`);
      clearSession(userId);

      // Force refresh command menu based on current role to fix stale UI issues
      if (userRole === 'admin') {
        await setAdminPrivateCommands(bot, userId);
      } else {
        await removeAdminPrivateCommands(bot, userId);
      }

      // Handle deep links like /start create_regulation
      const param = text.split(' ')[1];
      if (param && command.startsWith('/start')) {
        if (param.startsWith('edittool_')) {
          if (await handleToolsDeepLink(bot, msg, param, userRole, session)) return;
        }
        if (await handleRegulationDeepLink(bot, msg, param, userRole, session)) return;
        if (await handleAdminDeepLink(bot, msg, param, userRole)) return;
        if (await handleReportDeepLink(bot, msg, param, userRole)) return;
        if (await handleInfoDeepLink(bot, msg, param, userRole, session)) return;
        if (await handleAnnouncementDeepLink(bot, msg, param, userRole, session)) return;
        if (await handleToolsDeepLink(bot, msg, param, userRole, session)) return;
        if (await handleProposalDeepLink(bot, msg, param, userRole)) return;
      }

      if (userRole === 'admin') {
        await handleAdminDashboard(bot, chatId, userRole);
      } else {
        const welcomeText = '🛠 **BẢNG ĐIỀU KHIỂN USER**\n\nChào bạn, vui lòng chọn chức năng từ Menu bên dưới:';
        const keyboard = [
          [{ text: '📜 Xem Nội quy', callback_data: 'reg_list' }],
          [{ text: '📇 Xem Thông tin Nhân sự', callback_data: 'info_list' }],
          [{ text: '📢 Xem Thông báo', callback_data: 'ann_user_list' }],
          [{ text: '🛠 Xem Công cụ', callback_data: 'tools_list' }],
          [
            { text: '📝 Gửi báo cáo', callback_data: 'rep_create' },
            { text: '📋 Lịch sử báo cáo', callback_data: 'rep_my_list' }
          ],
          [
            { text: '💡 Tạo đề xuất', url: `https://t.me/${botUsername}?start=create_proposal` },
            { text: '📋 Lịch sử đề xuất', url: `https://t.me/${botUsername}?start=my_proposals` }
          ]
        ];

        bot.sendMessage(chatId, welcomeText, {
          parse_mode: 'Markdown',
          reply_markup: { inline_keyboard: keyboard }
        }).then(m => setTimeout(() => bot.deleteMessage(chatId, m.message_id).catch(() => { }), 60000));
      }
      return;
    }

    if (command === '/cancel') {
      if (session.tempData?.promptMessages) {
        session.tempData.promptMessages.forEach((id: number) => {
          bot.deleteMessage(chatId, id).catch(() => { });
        });
      } else if (session.tempData?.promptMessageId) {
        bot.deleteMessage(chatId, session.tempData.promptMessageId).catch(() => { });
      }
      clearSession(userId);
      bot.sendMessage(chatId, '✅ Đã hủy thao tác hiện tại.')
        .then(m => setTimeout(() => bot.deleteMessage(chatId, m.message_id).catch(() => { }), 10000));
      bot.deleteMessage(chatId, msg.message_id).catch(() => { });
      return;
    }

    if (text.startsWith('/') && session.state !== 'idle') {
      if (command === '/skip' && (
        session.state === 'editing_regulation_step_1' ||
        session.state === 'editing_regulation_step_2' ||
        session.state.startsWith('editing_personnel_') ||
        session.state.startsWith('editing_announcement_') ||
        session.state === 'adding_tool_desc' ||
        session.state === 'adding_tool_category_desc' ||
        session.state === 'editing_tool_desc' ||
        session.state === 'editing_tool_category_desc' ||
        session.state === 'editing_tool_link_or_file' ||
        session.state === 'editing_tool_category_name' ||
        session.state === 'editing_tool_name'
      )) {
        // allow /skip command to pass through to the state machine
      } else {
        bot.sendMessage(chatId, '⚠️ Bạn đang trong quá trình thực hiện một thao tác. Vui lòng hoàn thành hoặc gõ /cancel để hủy.')
          .then(m => setTimeout(() => bot.deleteMessage(chatId, m.message_id).catch(() => { }), 30000));
        return;
      }
    }

    // Handle state machine
    if (await handleRegulationState(bot, msg, command, userRole, session)) return;
    if (await handleReportState(bot, msg, session)) return;
    if (await handleInfoMessage(bot, msg, session.state, userId)) return;
    if (await handleAnnouncementState(bot, msg, command, userRole, session)) return;
    if (await handleToolsState(bot, msg, command, userRole, session)) return;
    if (await handleProposalState(bot, msg, session)) return;

    // Handle commands if idle
    if (command === '/admin') {
      await handleAdminDashboard(bot, chatId, userRole);
      return;
    }

    // Setup topic command for admins (handles /unset_topic in private)
    if (await handleSetTopicCommand(bot, msg, command, userRole, false, replyOptions)) return;

    if (await handleAdminCommand(bot, msg, command, userRole, session, replyOptions)) return;
    if (await handleRegulationCommand(bot, msg, command, userRole, session, replyOptions)) return;
    if (await handleToolsCommand(bot, msg, command, userRole, session, replyOptions)) return;

    // Add a secret command to claim admin if needed
    if (command === '/claim_admin') {
      await db.query("UPDATE users SET role = 'admin' WHERE id = $1", [userId]);
      roleCache.delete(userId);
      await setAdminPrivateCommands(bot, userId);
      bot.sendMessage(chatId, '✅ Bạn đã trở thành Admin!');
      return;
    }
  }
}
