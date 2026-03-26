import TelegramBot, { InlineKeyboardButton } from 'node-telegram-bot-api';
import { db } from '../../db';
import { SessionData, updateSession, clearSession, getSession } from '../services/sessionManager';
import { botUsername } from '../botInstance';

export async function refreshAllDocumentTopics(bot: TelegramBot) {
    try {
        const topics = await db.query("SELECT chat_id, topic_id, pinned_message_id FROM topics WHERE feature_type = 'documents' AND pinned_message_id IS NOT NULL");

        const docs = await db.query('SELECT id, title FROM documents ORDER BY created_at DESC');
        const keyboard: InlineKeyboardButton[][] = docs.rows.map(d => [{ text: `📄 ${d.title}`, callback_data: `docs_view_${d.id}` }]);

        const now = new Date();
        const timeStr = now.toLocaleTimeString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh', hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const dateStr = now.toLocaleDateString('vi-VN', { timeZone: 'Asia/Ho_Chi_Minh' });
        const text = '📁 *DANH SÁCH TÀI LIỆU BIỂU MẪU*\n\n' +
            (docs.rows.length > 0 ? 'Chọn một tài liệu bên dưới để xem và tải xuống:' : 'Hiện tại chưa có tài liệu nào.') +
            `\n\n_(Cập nhật lúc: ${timeStr} - ${dateStr})_`;

        for (const topic of topics.rows) {
            if (!topic.chat_id) continue;
            bot.editMessageText(text, {
                chat_id: topic.chat_id,
                message_id: topic.pinned_message_id,
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: keyboard }
            }).catch(async (err) => {
                if (!err.message.includes('message is not modified')) {
                    if (err.message.includes('message to edit not found')) {
                        try {
                            const sentMsg = await bot.sendMessage(topic.chat_id, text, {
                                message_thread_id: topic.topic_id || undefined,
                                parse_mode: 'Markdown',
                                reply_markup: { inline_keyboard: keyboard }
                            });
                            await bot.pinChatMessage(topic.chat_id, sentMsg.message_id).catch(console.error);
                            await db.query('UPDATE topics SET pinned_message_id = $1 WHERE chat_id = $2 AND topic_id = $3', [sentMsg.message_id, topic.chat_id, topic.topic_id]);
                        } catch (createErr) {
                            console.error(`Failed to recreate pinned message in chat ${topic.chat_id}:`, createErr);
                        }
                        return;
                    }
                    console.error(`Failed to edit pinned message in chat ${topic.chat_id}:`, err.message);
                }
            });
        }
    } catch (err) {
        console.error('Error refreshing document topics:', err);
    }
}

export async function sendDocumentsDashboard(bot: TelegramBot, chatId: number, messageId?: number, replyOptions?: TelegramBot.SendMessageOptions, userRole?: string) {
    try {
        const docs = await db.query('SELECT id, title FROM documents ORDER BY created_at DESC');

        let keyboard: InlineKeyboardButton[][] = [];
        let text = '';

        if (userRole === 'admin') {
            keyboard = docs.rows.map(d => [{ text: `📄 ${d.title}`, callback_data: `docs_admin_view_${d.id}` }]);
            keyboard.push([{ text: '➕ Thêm Tài liệu mới', callback_data: 'docs_add' }]);
            keyboard.push([{ text: '⚙️ Hủy cài đặt Topic', callback_data: 'topic_unset_request' }]);
            text = '📁 *QUẢN LÝ TÀI LIỆU BIỂU MẪU*\n\nChào Admin, vui lòng chọn chức năng quản lý bên dưới:';
            keyboard.push([{ text: '🔄 Làm mới', callback_data: 'docs_admin_list' }, { text: '❌ Đóng', callback_data: 'docs_close' }]);
        } else {
            keyboard = docs.rows.map(d => [{ text: `📄 ${d.title}`, callback_data: `docs_view_${d.id}` }]);
            text = '📁 *DANH SÁCH TÀI LIỆU BIỂU MẪU*\n\nVui lòng chọn một tài liệu bên dưới để xem chi tiết:';
            keyboard.push([{ text: '🔄 Làm mới', callback_data: 'docs_list' }, { text: '❌ Đóng', callback_data: 'docs_close' }]);
        }

        if (messageId) {
            bot.editMessageText(text, {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: keyboard }
            }).catch(console.error);
        } else {
            bot.sendMessage(chatId, text, {
                ...replyOptions,
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: keyboard }
            }).catch(console.error);
        }
    } catch (err) {
        console.error('Error sending documents dashboard:', err);
    }
}

export async function sendDocumentsList(bot: TelegramBot, chatId: number, messageId?: number, replyOptions?: TelegramBot.SendMessageOptions) {
    try {
        const docs = await db.query('SELECT id, title FROM documents ORDER BY created_at DESC');

        const keyboard: InlineKeyboardButton[][] = docs.rows.map(d => [{ text: `📄 ${d.title}`, callback_data: `docs_view_${d.id}` }]);
        keyboard.push([{ text: '🔄 Làm mới', callback_data: 'docs_list' }, { text: '❌ Đóng', callback_data: 'docs_close' }]);

        const text = '📁 **TÀI LIỆU BIỂU MẪU**\n\nChọn tài liệu để xem và tải xuống:';

        if (messageId) {
            bot.editMessageText(text, {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: keyboard }
            }).catch(console.error);
        } else {
            bot.sendMessage(chatId, text, {
                ...replyOptions,
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: keyboard }
            }).catch(console.error);
        }
    } catch (err) {
        console.error('Error sending documents list:', err);
    }
}

export async function handleDocumentCallback(
    bot: TelegramBot,
    query: TelegramBot.CallbackQuery,
    data: string,
    userRole: string,
    userId: number,
    chatId: number,
    messageId: number
): Promise<boolean> {
    if (data === 'docs_admin_list') {
        if (userRole !== 'admin') {
            bot.answerCallbackQuery(query.id, { text: '❌ Chỉ Admin mới có quyền quản lý tài liệu.', show_alert: true }).catch(() => { });
            return true;
        }
        await sendDocumentsDashboard(bot, chatId, messageId, undefined, userRole);
        bot.answerCallbackQuery(query.id).catch(() => { });
        return true;
    }

    if (data === 'docs_list') {
        await sendDocumentsList(bot, chatId, messageId);
        bot.answerCallbackQuery(query.id).catch(() => { });
        return true;
    }

    if (data === 'docs_close') {
        bot.deleteMessage(chatId, messageId).catch(() => { });
        bot.answerCallbackQuery(query.id).catch(() => { });
        return true;
    }

    if (data === 'docs_add') {
        if (userRole !== 'admin') {
            bot.answerCallbackQuery(query.id, { text: '❌ Chỉ Admin mới có quyền thêm tài liệu.', show_alert: true }).catch(() => { });
            return true;
        }
        const sentMsg = await bot.sendMessage(chatId, '➕ **THÊM TÀI LIỆU MỚI**\n\nVui lòng nhập tiêu đề tài liệu:', {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: '❌ Hủy', callback_data: 'docs_cancel' }]] }
        });
        updateSession(userId, { state: 'adding_document_title', tempData: { promptMessageId: sentMsg.message_id } });
        bot.answerCallbackQuery(query.id).catch(() => { });
        return true;
    }

    if (data === 'docs_cancel') {
        clearSession(userId);
        bot.deleteMessage(chatId, messageId).catch(() => { });
        bot.sendMessage(chatId, '❌ Đã hủy thao tác.').then(m => setTimeout(() => bot.deleteMessage(chatId, m.message_id).catch(() => { }), 3000));
        bot.answerCallbackQuery(query.id).catch(() => { });
        return true;
    }

    if (data.startsWith('docs_admin_view_')) {
        if (userRole !== 'admin') {
            bot.answerCallbackQuery(query.id, { text: '❌ Chỉ Admin mới có quyền quản lý tài liệu.', show_alert: true }).catch(() => { });
            return true;
        }
        const docId = parseInt(data.replace('docs_admin_view_', ''));
        try {
            const docRes = await db.query('SELECT * FROM documents WHERE id = $1', [docId]);
            if (docRes.rows.length > 0) {
                const doc = docRes.rows[0];
                const text = `📄 **${doc.title}**\n\n📝 Mô tả: ${doc.description || 'Không có'}\n\nBạn muốn làm gì với tài liệu này?`;
                const keyboard = [
                    [{ text: '✏️ Sửa Tiêu đề', callback_data: `docs_edit_title_${docId}` }],
                    [{ text: '✏️ Sửa Mô tả', callback_data: `docs_edit_desc_${docId}` }],
                    [{ text: '✏️ Cập nhật Tệp', callback_data: `docs_edit_file_${docId}` }],
                    [{ text: '🗑 Xóa Tài liệu', callback_data: `docs_delete_${docId}` }],
                    [{ text: '🔙 Quay lại', callback_data: 'docs_admin_list' }]
                ];
                bot.editMessageText(text, {
                    chat_id: chatId,
                    message_id: messageId,
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: keyboard }
                }).catch(console.error);
            } else {
                bot.answerCallbackQuery(query.id, { text: '❌ Không tìm thấy tài liệu.', show_alert: true }).catch(() => { });
            }
        } catch (err) {
            console.error('Error fetching document for admin view:', err);
        }
        bot.answerCallbackQuery(query.id).catch(() => { });
        return true;
    }

    if (data.startsWith('docs_edit_title_')) {
        const docId = parseInt(data.replace('docs_edit_title_', ''));
        const sentMsg = await bot.sendMessage(chatId, '✏️ Vui lòng nhập tiêu đề mới cho tài liệu:', {
            reply_markup: { inline_keyboard: [[{ text: '❌ Hủy', callback_data: 'docs_cancel' }]] }
        });
        updateSession(userId, { state: 'editing_document_title', tempData: { docId, promptMessageId: sentMsg.message_id } });
        bot.answerCallbackQuery(query.id).catch(() => { });
        return true;
    }

    if (data.startsWith('docs_edit_desc_')) {
        const docId = parseInt(data.replace('docs_edit_desc_', ''));
        const sentMsg = await bot.sendMessage(chatId, '✏️ Vui lòng nhập mô tả mới cho tài liệu:', {
            reply_markup: { inline_keyboard: [[{ text: '❌ Hủy', callback_data: 'docs_cancel' }]] }
        });
        updateSession(userId, { state: 'editing_document_desc', tempData: { docId, promptMessageId: sentMsg.message_id } });
        bot.answerCallbackQuery(query.id).catch(() => { });
        return true;
    }

    if (data.startsWith('docs_edit_file_')) {
        const docId = parseInt(data.replace('docs_edit_file_', ''));
        const sentMsg = await bot.sendMessage(chatId, '📎 Vui lòng gửi tệp đính kèm mới cho tài liệu:', {
            reply_markup: { inline_keyboard: [[{ text: '❌ Hủy', callback_data: 'docs_cancel' }]] }
        });
        updateSession(userId, { state: 'editing_document_file', tempData: { docId, promptMessageId: sentMsg.message_id } });
        bot.answerCallbackQuery(query.id).catch(() => { });
        return true;
    }

    if (data.startsWith('docs_delete_')) {
        const docId = parseInt(data.replace('docs_delete_', ''));
        try {
            await db.query('DELETE FROM documents WHERE id = $1', [docId]);
            bot.answerCallbackQuery(query.id, { text: '✅ Đã xóa tài liệu thành công.', show_alert: true }).catch(() => { });
            await sendDocumentsDashboard(bot, chatId, messageId, undefined, userRole);
            await refreshAllDocumentTopics(bot);
        } catch (err) {
            console.error('Error deleting document:', err);
            bot.answerCallbackQuery(query.id, { text: '❌ Có lỗi xảy ra khi xóa tài liệu.', show_alert: true }).catch(() => { });
        }
        return true;
    }

    if (data.startsWith('docs_view_')) {
        const docId = parseInt(data.replace('docs_view_', ''));
        try {
            const docRes = await db.query('SELECT * FROM documents WHERE id = $1', [docId]);
            if (docRes.rows.length > 0) {
                const doc = docRes.rows[0];
                const text = `📄 **${doc.title}**\n\n📝 Mô tả: ${doc.description || 'Không có'}`;

                bot.sendMessage(chatId, text, { parse_mode: 'Markdown' }).then(() => {
                    bot.sendDocument(chatId, doc.file_id).catch(console.error);
                });
            } else {
                bot.answerCallbackQuery(query.id, { text: '❌ Không tìm thấy tài liệu.', show_alert: true }).catch(() => { });
            }
        } catch (err) {
            console.error('Error viewing document:', err);
        }
        bot.answerCallbackQuery(query.id).catch(() => { });
        return true;
    }

    return false;
}

export async function handleDocumentMessage(
    bot: TelegramBot,
    msg: TelegramBot.Message,
    userRole: string,
    session: SessionData
): Promise<boolean> {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    if (!userId) return false;

    const state = session.state;
    const text = msg.text || '';

    if (state === 'adding_document_title') {
        if (!text) {
            bot.sendMessage(chatId, '❌ Vui lòng nhập văn bản cho tiêu đề.').then(m => setTimeout(() => bot.deleteMessage(chatId, m.message_id).catch(() => { }), 5000));
            bot.deleteMessage(chatId, msg.message_id).catch(() => { });
            return true;
        }
        if (session.tempData?.promptMessageId) {
            bot.deleteMessage(chatId, session.tempData.promptMessageId).catch(() => { });
        }
        const sentMsg = await bot.sendMessage(chatId, '📝 Đã lưu tiêu đề.\n\nVui lòng nhập mô tả cho tài liệu (hoặc gõ /skip để bỏ qua):', {
            reply_markup: { inline_keyboard: [[{ text: '❌ Hủy', callback_data: 'docs_cancel' }]] }
        });
        updateSession(userId, { state: 'adding_document_desc', tempData: { title: text, promptMessageId: sentMsg.message_id } });
        bot.deleteMessage(chatId, msg.message_id).catch(() => { });
        return true;
    }

    if (state === 'adding_document_desc') {
        const desc = text === '/skip' ? null : text;
        const tempData = session.tempData;
        if (tempData?.promptMessageId) {
            bot.deleteMessage(chatId, tempData.promptMessageId).catch(() => { });
        }
        const sentMsg = await bot.sendMessage(chatId, '📎 Đã lưu mô tả.\n\nVui lòng gửi tệp đính kèm cho tài liệu:', {
            reply_markup: { inline_keyboard: [[{ text: '❌ Hủy', callback_data: 'docs_cancel' }]] }
        });
        updateSession(userId, { state: 'adding_document_file', tempData: { ...tempData, desc, promptMessageId: sentMsg.message_id } });
        bot.deleteMessage(chatId, msg.message_id).catch(() => { });
        return true;
    }

    if (state === 'adding_document_file') {
        if (!msg.document && !msg.photo) {
            bot.sendMessage(chatId, '❌ Vui lòng gửi một tệp đính kèm (document hoặc photo).').then(m => setTimeout(() => bot.deleteMessage(chatId, m.message_id).catch(() => { }), 5000));
            bot.deleteMessage(chatId, msg.message_id).catch(() => { });
            return true;
        }

        let fileId = '';
        let fileType = '';

        if (msg.document) {
            fileId = msg.document.file_id;
            fileType = 'document';
        } else if (msg.photo) {
            fileId = msg.photo[msg.photo.length - 1].file_id;
            fileType = 'photo';
        }

        const tempData = session.tempData;
        if (tempData?.promptMessageId) {
            bot.deleteMessage(chatId, tempData.promptMessageId).catch(() => { });
        }

        try {
            await db.query(
                'INSERT INTO documents (title, description, file_id, file_type, created_by) VALUES ($1, $2, $3, $4, $5)',
                [tempData.title, tempData.desc, fileId, fileType, userId]
            );

            clearSession(userId);
            bot.sendMessage(chatId, '✅ Đã thêm tài liệu thành công!').then(m => setTimeout(() => bot.deleteMessage(chatId, m.message_id).catch(() => { }), 3000));
            bot.deleteMessage(chatId, msg.message_id).catch(() => { });
            await sendDocumentsDashboard(bot, chatId, undefined, undefined, userRole);
            await refreshAllDocumentTopics(bot);
        } catch (err) {
            console.error('Error adding document:', err);
            bot.sendMessage(chatId, '❌ Có lỗi xảy ra khi lưu tài liệu.');
        }
        return true;
    }

    if (state === 'editing_document_title') {
        if (!text) {
            bot.sendMessage(chatId, '❌ Vui lòng nhập văn bản cho tiêu đề.').then(m => setTimeout(() => bot.deleteMessage(chatId, m.message_id).catch(() => { }), 5000));
            bot.deleteMessage(chatId, msg.message_id).catch(() => { });
            return true;
        }
        const docId = session.tempData.docId;
        if (session.tempData?.promptMessageId) {
            bot.deleteMessage(chatId, session.tempData.promptMessageId).catch(() => { });
        }
        try {
            await db.query('UPDATE documents SET title = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [text, docId]);
            clearSession(userId);
            bot.sendMessage(chatId, '✅ Đã cập nhật tiêu đề thành công!').then(m => setTimeout(() => bot.deleteMessage(chatId, m.message_id).catch(() => { }), 3000));
            bot.deleteMessage(chatId, msg.message_id).catch(() => { });
            await sendDocumentsDashboard(bot, chatId, undefined, undefined, userRole);
            await refreshAllDocumentTopics(bot);
        } catch (err) {
            console.error('Error updating document title:', err);
            bot.sendMessage(chatId, '❌ Có lỗi xảy ra khi cập nhật.');
        }
        return true;
    }

    if (state === 'editing_document_desc') {
        const docId = session.tempData.docId;
        if (session.tempData?.promptMessageId) {
            bot.deleteMessage(chatId, session.tempData.promptMessageId).catch(() => { });
        }
        try {
            await db.query('UPDATE documents SET description = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2', [text, docId]);
            clearSession(userId);
            bot.sendMessage(chatId, '✅ Đã cập nhật mô tả thành công!').then(m => setTimeout(() => bot.deleteMessage(chatId, m.message_id).catch(() => { }), 3000));
            bot.deleteMessage(chatId, msg.message_id).catch(() => { });
            await sendDocumentsDashboard(bot, chatId, undefined, undefined, userRole);
            await refreshAllDocumentTopics(bot);
        } catch (err) {
            console.error('Error updating document desc:', err);
            bot.sendMessage(chatId, '❌ Có lỗi xảy ra khi cập nhật.');
        }
        return true;
    }

    if (state === 'editing_document_file') {
        if (!msg.document && !msg.photo) {
            bot.sendMessage(chatId, '❌ Vui lòng gửi một tệp đính kèm (document hoặc photo).').then(m => setTimeout(() => bot.deleteMessage(chatId, m.message_id).catch(() => { }), 5000));
            bot.deleteMessage(chatId, msg.message_id).catch(() => { });
            return true;
        }

        let fileId = '';
        let fileType = '';

        if (msg.document) {
            fileId = msg.document.file_id;
            fileType = 'document';
        } else if (msg.photo) {
            fileId = msg.photo[msg.photo.length - 1].file_id;
            fileType = 'photo';
        }

        const docId = session.tempData.docId;
        if (session.tempData?.promptMessageId) {
            bot.deleteMessage(chatId, session.tempData.promptMessageId).catch(() => { });
        }
        try {
            await db.query('UPDATE documents SET file_id = $1, file_type = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3', [fileId, fileType, docId]);
            clearSession(userId);
            bot.sendMessage(chatId, '✅ Đã cập nhật tệp đính kèm thành công!').then(m => setTimeout(() => bot.deleteMessage(chatId, m.message_id).catch(() => { }), 3000));
            bot.deleteMessage(chatId, msg.message_id).catch(() => { });
            await sendDocumentsDashboard(bot, chatId, undefined, undefined, userRole);
            await refreshAllDocumentTopics(bot);
        } catch (err) {
            console.error('Error updating document file:', err);
            bot.sendMessage(chatId, '❌ Có lỗi xảy ra khi cập nhật.');
        }
        return true;
    }

    return false;
}
