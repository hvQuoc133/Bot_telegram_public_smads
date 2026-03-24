import TelegramBot from 'node-telegram-bot-api';
import { db } from '../../db';
import { getSession, updateSession, clearSession, roleCache, topicCache, CACHE_TTL } from '../services/sessionManager';
import { botUsername } from '../botInstance';
import { handleAdminDashboard } from './adminTopic';
import { trackMessage, getTrackedMessages } from '../utils/messageTracker';

export async function broadcastRegulationUpdate(bot: TelegramBot) {
    const tracked = getTrackedMessages('regulation_list');
    if (tracked.length === 0) return;

    const regs = await db.query('SELECT id, title FROM regulations ORDER BY created_at DESC');

    for (const msg of tracked) {
        try {
            // Check user role for this specific chat
            const userRes = await db.query('SELECT role FROM users WHERE id = $1', [msg.chatId]);
            const userRole = userRes.rows[0]?.role || 'user';

            let text = '';
            let keyboard: any[][] = [];

            if (userRole === 'admin') {
                text = '📜 *QUẢN LÝ NỘI QUY CÔNG TY*\n\nChào Admin, vui lòng chọn chức năng quản lý bên dưới:';
                keyboard = regs.rows.length > 0
                    ? regs.rows.map(r => [{ text: `📖 ${r.title}`, callback_data: `reg_view_${r.id}` }])
                    : [];
                keyboard.push([
                    { text: '➕ Thêm Nội quy', url: `https://t.me/${botUsername}?start=create_regulation` },
                    { text: '⚙️ Hủy cài đặt Topic', callback_data: 'topic_unset_request' }
                ]);
            } else {
                text = '📜 *DANH SÁCH NỘI QUY CÔNG TY*\n\nVui lòng chọn một mục bên dưới để xem chi tiết:';
                keyboard = regs.rows.length > 0
                    ? regs.rows.map(r => [{ text: `📖 ${r.title}`, callback_data: `reg_view_${r.id}` }])
                    : [];
            }

            keyboard.push([{ text: '🔄 Làm mới', callback_data: 'reg_reload' }, { text: '❌ Đóng', callback_data: 'info_close_message' }]);

            await bot.editMessageText(text, {
                chat_id: msg.chatId,
                message_id: msg.messageId,
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: keyboard }
            });
        } catch (error: any) {
            if (!error.message.includes('is not modified')) {
                console.error(`Không thể update tin nhắn ${msg.messageId} ở chat ${msg.chatId}`);
            }
        }
    }
}

export async function refreshAllRegulationTopics(bot: TelegramBot) {
    try {
        console.log('Refreshing all regulation topics...');
        const topics = await db.query("SELECT chat_id, topic_id, pinned_message_id FROM topics WHERE feature_type = 'regulation' AND pinned_message_id IS NOT NULL");
        console.log(`Found ${topics.rows.length} topics to refresh.`);

        const regs = await db.query('SELECT id, title FROM regulations ORDER BY created_at DESC');
        console.log(`Found ${regs.rows.length} regulations.`);

        const keyboard: any[][] = regs.rows.length > 0
            ? regs.rows.map(r => [{ text: `📖 ${r.title}`, callback_data: `reg_view_${r.id}` }])
            : [];

        const now = new Date();
        const timeStr = now.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const dateStr = now.toLocaleDateString('vi-VN');
        const text = '📜 *DANH SÁCH NỘI QUY CÔNG TY*\n\n' +
            (regs.rows.length > 0 ? 'Chọn một mục bên dưới để xem chi tiết:' : 'Hiện tại chưa có nội quy nào.') +
            `\n\n_(Cập nhật lúc: ${timeStr} - ${dateStr})_`;

        for (const topic of topics.rows) {
            if (!topic.chat_id) {
                console.warn(`Skipping topic refresh: chat_id is null for topic_id ${topic.topic_id}`);
                continue;
            }
            bot.editMessageText(text, {
                chat_id: topic.chat_id,
                message_id: topic.pinned_message_id,
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: keyboard }
            }).catch((err) => {
                if (err.message.includes('message is not modified')) {
                    // Ignore this error
                    return;
                }
                console.error(`Failed to edit pinned message in chat ${topic.chat_id} (topic: ${topic.topic_id}):`, err.message);
            });
        }
        console.log('Refresh complete.');
    } catch (err) {
        console.error('Error refreshing regulation topics:', err);
    }
}

export async function sendRegulationList(bot: TelegramBot, chatId: number, userRole: string) {
    const regs = await db.query('SELECT id, title FROM regulations ORDER BY created_at DESC');
    const keyboard = regs.rows.length > 0
        ? regs.rows.map(r => [{ text: r.title, callback_data: `reg_view_${r.id}` }])
        : [];

    if (userRole === 'admin') {
        keyboard.push([{ text: '➕ Thêm Nội Quy', callback_data: 'reg_add_new' }]);
        keyboard.push([{ text: '🛠 Bảng điều khiển Admin', callback_data: 'admin_dashboard' }]);
    }

    const text = regs.rows.length > 0 ? '📚 Danh sách Nội quy công ty:' : 'Hiện tại chưa có nội quy nào.';

    return bot.sendMessage(chatId, text, {
        reply_markup: { inline_keyboard: keyboard }
    }).then(m => {
        setTimeout(() => bot.deleteMessage(chatId, m.message_id).catch(() => { }), 60000);
        return m;
    });
}

export async function handleRegulationCommand(
    bot: TelegramBot,
    msg: TelegramBot.Message,
    command: string,
    userRole: string,
    session: any,
    replyOptions: TelegramBot.SendMessageOptions
): Promise<boolean> {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;

    if (!userId) return false;

    if (command === '/create_regulation') {
        if (userRole !== 'admin') {
            bot.sendMessage(chatId, '❌ Bạn không có quyền. Chỉ Admin mới có thể thực hiện thao tác này.', replyOptions)
                .then(m => setTimeout(() => bot.deleteMessage(chatId, m.message_id).catch(() => { }), 30000));
            return true;
        }
        updateSession(userId, { state: 'creating_regulation_step_1' });
        bot.sendMessage(chatId, '📝 Vui lòng nhập tiêu đề cho Nội quy mới:', replyOptions);
        return true;
    }

    if (command === '/edit_regulation') {
        if (userRole !== 'admin') {
            bot.sendMessage(chatId, '❌ Bạn không có quyền. Chỉ Admin mới có thể thực hiện thao tác này.', replyOptions)
                .then(m => setTimeout(() => bot.deleteMessage(chatId, m.message_id).catch(() => { }), 30000));
            return true;
        }
        const regs = await db.query('SELECT id, title FROM regulations ORDER BY created_at DESC');
        if (regs.rows.length === 0) {
            bot.sendMessage(chatId, 'Hiện tại chưa có nội quy nào để sửa.', replyOptions);
        } else {
            const keyboard = regs.rows.map(r => [{ text: `✏️ ${r.title}`, callback_data: `reg_edit_${r.id}` }]);
            bot.sendMessage(chatId, 'Vui lòng chọn Nội quy bạn muốn sửa:', { ...replyOptions, reply_markup: { inline_keyboard: keyboard } });
            updateSession(userId, { state: 'selecting_edit_regulation' });
        }
        return true;
    }

    if (command === '/delete_regulation') {
        if (userRole !== 'admin') {
            bot.sendMessage(chatId, '❌ Bạn không có quyền. Chỉ Admin mới có thể thực hiện thao tác này.', replyOptions);
            return true;
        }
        const regs = await db.query('SELECT id, title FROM regulations ORDER BY created_at DESC');
        if (regs.rows.length === 0) {
            bot.sendMessage(chatId, 'Hiện tại chưa có nội quy nào để xóa.', replyOptions);
        } else {
            const keyboard = regs.rows.map(r => [{ text: `🗑 ${r.title}`, callback_data: `reg_delete_${r.id}` }]);
            bot.sendMessage(chatId, 'Vui lòng chọn Nội quy bạn muốn xóa:', { ...replyOptions, reply_markup: { inline_keyboard: keyboard } });
            updateSession(userId, { state: 'selecting_delete_regulation' });
        }
        return true;
    }

    if (command === '/regulations') {
        await sendRegulationList(bot, chatId, userRole);
        return true;
    }

    return false;
}

export async function handleRegulationDeepLink(
    bot: TelegramBot,
    msg: TelegramBot.Message,
    param: string,
    userRole: string,
    session: any
): Promise<boolean> {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;

    if (!userId) return false;

    if (param === 'create_regulation' && userRole === 'admin') {
        bot.sendMessage(chatId, '📝 Vui lòng nhập tiêu đề cho Nội quy mới:\n(/cancel để hủy)')
            .then(m => {
                updateSession(userId, { state: 'creating_regulation_step_1', tempData: { promptMessageId: m.message_id } });
            });
        return true;
    } else if (param === 'edit_regulation' && userRole === 'admin') {
        const regs = await db.query('SELECT id, title FROM regulations ORDER BY created_at DESC');
        if (regs.rows.length === 0) {
            bot.sendMessage(chatId, 'Hiện tại chưa có nội quy nào để sửa.');
        } else {
            const keyboard = regs.rows.map(r => [{ text: `✏️ ${r.title}`, callback_data: `reg_edit_${r.id}` }]);
            bot.sendMessage(chatId, 'Vui lòng chọn Nội quy bạn muốn sửa:', { reply_markup: { inline_keyboard: keyboard } });
            updateSession(userId, { state: 'selecting_edit_regulation' });
        }
        return true;
    } else if (param === 'delete_regulation' && userRole === 'admin') {
        const regs = await db.query('SELECT id, title FROM regulations ORDER BY created_at DESC');
        if (regs.rows.length === 0) {
            bot.sendMessage(chatId, 'Hiện tại chưa có nội quy nào để xóa.');
        } else {
            const keyboard = regs.rows.map(r => [{ text: `🗑 ${r.title}`, callback_data: `reg_delete_${r.id}` }]);
            bot.sendMessage(chatId, 'Vui lòng chọn Nội quy bạn muốn xóa:', { reply_markup: { inline_keyboard: keyboard } });
            updateSession(userId, { state: 'selecting_delete_regulation' });
        }
        return true;
    } else if (param.startsWith('editreg_') && userRole === 'admin') {
        const parts = param.split('_');
        const regId = parts[1];
        const sourceChatId = parts[2] ? parts[2].replace('m', '-') : undefined;
        const sourceMessageId = parts[3];

        const regRes = await db.query('SELECT title, content, locked_by FROM regulations WHERE id = $1', [regId]);
        if (regRes.rows.length === 0) {
            bot.sendMessage(chatId, '⚠️ Không tìm thấy nội quy.');
            return true;
        }
        const reg = regRes.rows[0];

        if (reg.locked_by && String(reg.locked_by) !== String(userId)) {
            bot.sendMessage(chatId, '⚠️ Nội quy này đang được chỉnh sửa bởi Admin khác.');
            return true;
        }
        await db.query('UPDATE regulations SET locked_by = $1, locked_at = NOW() WHERE id = $2', [userId, regId]);

        const text = `📝 *Đang sửa nội quy:*\n\n*Tiêu đề:* ${reg.title}\n*Nội dung:* ${reg.content.substring(0, 100)}...`;
        const keyboard = [
            [{ text: '📝 Sửa Tiêu đề', callback_data: `reg_edit_field_title_${regId}` }],
            [{ text: '📄 Sửa Nội dung', callback_data: `reg_edit_field_content_${regId}` }],
            [{ text: '🔙 Hủy', callback_data: `reg_edit_cancel_${regId}` }]
        ];

        bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } })
            .then(m => {
                updateSession(userId, { state: 'idle', tempData: { regId, sourceChatId, sourceMessageId, oldTitle: reg.title, oldContent: reg.content, promptMessageId: m.message_id } });
            });
        return true;
    } else if (param.startsWith('deletereg_') && userRole === 'admin') {
        const parts = param.split('_');
        const regId = parts[1];
        const sourceChatId = parts[2] ? parts[2].replace('m', '-') : undefined;
        const sourceMessageId = parts[3];

        updateSession(userId, { state: 'confirming_delete', tempData: { regId, sourceChatId, sourceMessageId } });
        const keyboard = [
            [{ text: '✅ Có, Xóa', callback_data: `reg_confirm_delete_${regId}` }],
            [{ text: '❌ Hủy', callback_data: 'reg_back' }]
        ];
        bot.sendMessage(chatId, '⚠️ Bạn có chắc chắn muốn xóa nội quy này không?', { reply_markup: { inline_keyboard: keyboard } })
            .then(m => setTimeout(() => bot.deleteMessage(chatId, m.message_id).catch(() => { }), 60000));
        return true;
    }

    return false;
}

export async function handleRegulationState(
    bot: TelegramBot,
    msg: TelegramBot.Message,
    command: string,
    userRole: string,
    session: any
): Promise<boolean> {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    const text = msg.text || '';

    if (!userId) return false;

    if (command === '/cancel') {
        if (session.tempData?.promptMessageId) bot.deleteMessage(chatId, session.tempData.promptMessageId).catch(() => { });
        bot.deleteMessage(chatId, msg.message_id).catch(() => { });
        bot.sendMessage(chatId, '✅ Đã hủy thao tác.', {
            reply_markup: { inline_keyboard: [[{ text: '🔙 Quay lại Quản lý Nội quy', callback_data: 'admin_manage_regs' }]] }
        });

        if (session.tempData?.regId) {
            await db.query('UPDATE regulations SET locked_by = NULL, locked_at = NULL WHERE id = $1', [session.tempData.regId]);
        }

        clearSession(userId);
        return true;
    }

    switch (session.state) {
        case 'selecting_edit_regulation':
        case 'selecting_delete_regulation':
            bot.sendMessage(chatId, '⚠️ Vui lòng click vào nút của nội quy bạn muốn chọn ở tin nhắn trên, hoặc gõ /cancel để hủy thao tác.')
                .then(m => setTimeout(() => bot.deleteMessage(chatId, m.message_id).catch(() => { }), 30000));
            return true;
        case 'creating_regulation_step_1':
            if (session.tempData?.promptMessageId) bot.deleteMessage(chatId, session.tempData.promptMessageId).catch(() => { });
            bot.sendMessage(chatId, '✍️ Vui lòng nhập nội dung chi tiết của Nội quy:\n(/cancel để hủy)')
                .then(m => {
                    updateSession(userId, { state: 'creating_regulation_step_2', tempData: { title: text, promptMessageId: m.message_id } });
                });
            return true;
        case 'creating_regulation_step_2':
            if (session.tempData?.promptMessageId) bot.deleteMessage(chatId, session.tempData.promptMessageId).catch(() => { });
            const title = session.tempData.title;
            const content = text;
            await db.query('INSERT INTO regulations (title, content, created_by) VALUES ($1, $2, $3)', [title, content, userId]);
            clearSession(userId);
            await bot.sendMessage(chatId, '✅ Tạo Nội quy thành công!')
                .then(m => setTimeout(() => bot.deleteMessage(chatId, m.message_id).catch(() => { }), 15000));
            await refreshAllRegulationTopics(bot);
            await broadcastRegulationUpdate(bot);
            return true;
        case 'editing_regulation_title':
        case 'editing_regulation_content': {
            if (session.tempData?.promptMessageId) bot.deleteMessage(chatId, session.tempData.promptMessageId).catch(() => { });
            bot.deleteMessage(chatId, msg.message_id).catch(() => { });

            const regId = session.tempData.regId;
            const field = session.state.replace('editing_regulation_', '');

            try {
                let updateQuery = '';
                let updateParams: any[] = [];

                if (field === 'title') {
                    updateQuery = 'UPDATE regulations SET title = $1, locked_by = NULL, locked_at = NULL WHERE id = $2';
                    updateParams = [text, regId];
                } else if (field === 'content') {
                    updateQuery = 'UPDATE regulations SET content = $1, locked_by = NULL, locked_at = NULL WHERE id = $2';
                    updateParams = [text, regId];
                }

                await db.query(updateQuery, updateParams);

                bot.sendMessage(chatId, '✅ Đã cập nhật nội quy thành công!').then(m => setTimeout(() => bot.deleteMessage(chatId, m.message_id).catch(() => { }), 5000));

                await refreshAllRegulationTopics(bot);
                await broadcastRegulationUpdate(bot);

                const sourceChatId = session.tempData.sourceChatId;
                const sourceMessageId = session.tempData.sourceMessageId;
                if (sourceChatId && sourceMessageId) {
                    bot.deleteMessage(sourceChatId, sourceMessageId).catch(() => { });
                }

                if (session.tempData.viewMessageId) {
                    const fakeQuery = {
                        id: 'fake',
                        from: msg.from,
                        message: { chat: { id: chatId }, message_id: session.tempData.viewMessageId }
                    } as TelegramBot.CallbackQuery;
                    await handleRegulationCallback(bot, fakeQuery, `reg_view_${regId}`, 'admin', session);
                }

            } catch (err) {
                console.error('Error updating regulation:', err);
                bot.sendMessage(chatId, '❌ Có lỗi xảy ra khi cập nhật nội quy.');
            }

            clearSession(userId);
            return true;
        }
    }

    return false;
}

export async function handleRegulationCallback(
    bot: TelegramBot,
    query: TelegramBot.CallbackQuery,
    data: string,
    userRole: string,
    session: any
): Promise<boolean> {
    const chatId = query.message?.chat.id;
    const messageId = query.message?.message_id;
    const userId = query.from.id;

    if (!chatId || !messageId) return false;

    if (data.startsWith('reg_view_')) {
        const regId = data.split('_')[2];
        const regRes = await db.query('SELECT title, content FROM regulations WHERE id = $1', [regId]);
        if (regRes.rows.length > 0) {
            const { title, content } = regRes.rows[0];
            const text = `*${title}*\n\n${content}`;

            // If in a group, send a temporary message instead of editing the pinned list
            if (query.message?.chat.type !== 'private') {
                const tempMsg = await bot.sendMessage(chatId, text, {
                    message_thread_id: query.message?.message_thread_id,
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: [[{ text: '🗑 Đóng', callback_data: 'reg_close_temp' }]] }
                });

                if (userRole === 'admin') {
                    const formattedChatId = chatId.toString().replace('-', 'm');
                    const inlineKeyboard: any[][] = [[{ text: '🗑 Đóng', callback_data: 'reg_close_temp' }]];
                    inlineKeyboard.push([
                        { text: '✏️ Sửa (Chỉ Admin)', url: `https://t.me/${botUsername}?start=editreg_${regId}_${formattedChatId}_${tempMsg.message_id}` },
                        { text: '🗑 Xóa (Chỉ Admin)', url: `https://t.me/${botUsername}?start=deletereg_${regId}_${formattedChatId}_${tempMsg.message_id}` }
                    ]);
                    bot.editMessageReplyMarkup({ inline_keyboard: inlineKeyboard }, { chat_id: chatId, message_id: tempMsg.message_id }).catch(() => { });
                }

                bot.answerCallbackQuery(query.id);

                // Auto delete after 2 minutes to keep topic clean
                setTimeout(() => {
                    bot.deleteMessage(chatId, tempMsg.message_id).catch(() => { });
                }, 120000);
                return true;
            }

            const keyboard = [[{ text: '🔙 Quay lại', callback_data: 'reg_back' }]];

            if (userRole === 'admin') {
                keyboard.push([
                    { text: '✏️ Sửa', callback_data: `reg_edit_${regId}` },
                    { text: '🗑 Xóa', callback_data: `reg_delete_${regId}` }
                ]);
            }

            bot.editMessageText(text, {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: keyboard }
            });
        }
        return true;
    } else if (data === 'reg_list') {
        bot.deleteMessage(chatId, messageId).catch(() => { });
        await sendRegulationList(bot, chatId, userRole);
        bot.answerCallbackQuery(query.id);
        return true;
    } else if (data === 'reg_close_temp') {
        bot.deleteMessage(chatId, messageId).catch(() => { });
        bot.answerCallbackQuery(query.id);
        return true;
    } else if (data === 'reg_reload') {
        await refreshAllRegulationTopics(bot);
        await broadcastRegulationUpdate(bot);
        bot.answerCallbackQuery(query.id, { text: '✅ Đã tải lại danh sách nội quy' });
        return true;
    } else if (data === 'reg_back') {
        bot.deleteMessage(chatId, messageId).catch(() => { });
        await sendRegulationList(bot, chatId, userRole);
        bot.answerCallbackQuery(query.id);
        return true;
    } else if (data === 'reg_edit_list' || data === 'reg_delete_list') {
        if (userRole !== 'admin') {
            bot.answerCallbackQuery(query.id, { text: '❌ Bạn không có quyền.', show_alert: true });
            return true;
        }
        const regs = await db.query('SELECT id, title FROM regulations ORDER BY created_at DESC');
        if (regs.rows.length === 0) {
            bot.answerCallbackQuery(query.id, { text: '⚠️ Hiện tại chưa có nội quy nào.', show_alert: true });
            return true;
        }
        const isEdit = data === 'reg_edit_list';
        const keyboard = regs.rows.map(r => [{
            text: `${isEdit ? '✏️' : '🗑'} ${r.title}`,
            callback_data: `reg_${isEdit ? 'edit' : 'delete'}_${r.id}`
        }]);
        keyboard.push([{ text: '🔙 Quay lại', callback_data: 'admin_manage_regs' }]);

        bot.editMessageText(`Vui lòng chọn Nội quy bạn muốn ${isEdit ? 'sửa' : 'xóa'}:`, {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: { inline_keyboard: keyboard }
        }).catch(console.error);
        bot.answerCallbackQuery(query.id);
        return true;
    } else if (data === 'reg_add_new') {
        if (userRole !== 'admin') {
            bot.answerCallbackQuery(query.id, { text: '❌ Bạn không có quyền.', show_alert: true });
            return true;
        }
        bot.sendMessage(chatId, '📝 Vui lòng nhập tiêu đề cho Nội quy mới:')
            .then(m => {
                updateSession(userId, { state: 'creating_regulation_step_1', tempData: { promptMessageId: m.message_id } });
            });
        bot.answerCallbackQuery(query.id);
        return true;
    } else if (data.startsWith('reg_edit_field_')) {
        const parts = data.split('_');
        const field = parts[3];
        const regId = parts[4];

        let promptText = '';
        if (field === 'title') promptText = '📝 Vui lòng nhập *Tiêu đề* mới cho Nội quy:';
        if (field === 'content') promptText = '📄 Vui lòng nhập *Nội dung* mới cho Nội quy:';

        bot.sendMessage(chatId, promptText, { parse_mode: 'Markdown' }).then(m => {
            updateSession(userId, {
                state: `editing_regulation_${field}` as any,
                tempData: { ...session.tempData, regId, promptMessageId: m.message_id, viewMessageId: messageId }
            });
        });
        bot.answerCallbackQuery(query.id);
        return true;
    } else if (data.startsWith('reg_edit_cancel_')) {
        const regId = data.split('_')[3];
        await db.query('UPDATE regulations SET locked_by = NULL, locked_at = NULL WHERE id = $1', [regId]);
        bot.deleteMessage(chatId, messageId).catch(() => { });
        bot.sendMessage(chatId, '✅ Đã hủy chỉnh sửa nội quy.').then(m => {
            setTimeout(() => bot.deleteMessage(chatId, m.message_id).catch(() => { }), 15000);
        });
        clearSession(userId);
        bot.answerCallbackQuery(query.id);
        return true;
    } else if (data.startsWith('reg_edit_')) {
        const regId = data.split('_')[2];

        if (userRole !== 'admin') {
            bot.answerCallbackQuery(query.id, { text: '❌ Bạn không có quyền.', show_alert: true });
            return true;
        }

        const isPrivate = query.message?.chat.type === 'private';
        if (!isPrivate) {
            const deepLink = botUsername ? `https://t.me/${botUsername}?start=editreg_${regId}` : 'https://t.me/your_bot';
            bot.answerCallbackQuery(query.id, { text: '⚙️ Vui lòng chuyển sang Inbox bot để sửa.', show_alert: true, url: deepLink });
            return true;
        }

        // Delete the list message in private chat to keep it clean
        bot.deleteMessage(chatId, messageId).catch(() => { });

        // Lock mechanism
        const lockRes = await db.query('SELECT title, content, locked_by FROM regulations WHERE id = $1', [regId]);
        if (lockRes.rows.length === 0) {
            bot.answerCallbackQuery(query.id, { text: '⚠️ Không tìm thấy nội quy.', show_alert: true });
            return true;
        }
        const reg = lockRes.rows[0];
        if (reg.locked_by && String(reg.locked_by) !== String(userId)) {
            bot.answerCallbackQuery(query.id, { text: '⚠️ Nội quy này đang được chỉnh sửa bởi Admin khác.', show_alert: true });
            return true;
        }

        await db.query('UPDATE regulations SET locked_by = $1, locked_at = NOW() WHERE id = $2', [userId, regId]);

        const text = `📝 *Đang sửa nội quy:*\n\n*Tiêu đề:* ${reg.title}\n*Nội dung:* ${reg.content.substring(0, 100)}...`;
        const keyboard = [
            [{ text: '📝 Sửa Tiêu đề', callback_data: `reg_edit_field_title_${regId}` }],
            [{ text: '📄 Sửa Nội dung', callback_data: `reg_edit_field_content_${regId}` }],
            [{ text: '🔙 Hủy', callback_data: `reg_edit_cancel_${regId}` }]
        ];

        bot.sendMessage(userId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } })
            .then(m => {
                updateSession(userId, { state: 'idle', tempData: { regId, oldTitle: reg.title, oldContent: reg.content, promptMessageId: m.message_id } });
            });
        bot.answerCallbackQuery(query.id);
        return true;
    } else if (data.startsWith('reg_delete_')) {
        const regId = data.split('_')[2];

        if (userRole !== 'admin') {
            bot.answerCallbackQuery(query.id, { text: '❌ Bạn không có quyền.', show_alert: true });
            return true;
        }

        const isPrivate = query.message?.chat.type === 'private';
        if (!isPrivate) {
            const deepLink = botUsername ? `https://t.me/${botUsername}?start=deletereg_${regId}` : 'https://t.me/your_bot';
            bot.answerCallbackQuery(query.id, { text: '⚙️ Vui lòng chuyển sang Inbox bot để xóa.', show_alert: true, url: deepLink });
            return true;
        }

        // Delete the list message in private chat to keep it clean
        bot.deleteMessage(chatId, messageId).catch(() => { });

        const keyboard = [
            [{ text: '✅ Có, Xóa', callback_data: `reg_confirm_delete_${regId}` }],
            [{ text: '❌ Hủy', callback_data: 'reg_back' }]
        ];

        bot.sendMessage(chatId, '⚠️ Bạn có chắc chắn muốn xóa nội quy này không?', {
            reply_markup: { inline_keyboard: keyboard }
        }).then(m => {
            updateSession(userId, { tempData: { ...getSession(userId).tempData, promptMessageId: m.message_id } });
        });
        bot.answerCallbackQuery(query.id);
        return true;
    } else if (data.startsWith('reg_confirm_delete_')) {
        const regId = data.split('_')[3];
        await db.query('DELETE FROM regulations WHERE id = $1', [regId]);
        bot.answerCallbackQuery(query.id, { text: '✅ Đã xóa thành công' });
        await refreshAllRegulationTopics(bot);
        await broadcastRegulationUpdate(bot);

        const sourceChatId = session?.tempData?.sourceChatId;
        const sourceMessageId = session?.tempData?.sourceMessageId;
        if (sourceChatId && sourceMessageId) {
            bot.deleteMessage(sourceChatId, sourceMessageId).catch(() => { });
        }

        clearSession(userId);

        // Go back to dashboard
        bot.deleteMessage(chatId, messageId).catch(() => { });
        return true;
    }

    return false;
}
