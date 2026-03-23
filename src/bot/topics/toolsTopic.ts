import TelegramBot, { InlineKeyboardButton } from 'node-telegram-bot-api';
import { db } from '../../db';
import { SessionData, updateSession, clearSession } from '../services/sessionManager';
import { botUsername } from '../botInstance';

export async function handleToolsCommand(
    bot: TelegramBot,
    msg: TelegramBot.Message,
    command: string,
    userRole: string,
    session: SessionData,
    replyOptions: TelegramBot.SendMessageOptions
): Promise<boolean> {
    const chatId = msg.chat.id;
    if (command === '/tools') {
        await sendToolsList(bot, chatId, undefined, replyOptions);
        return true;
    }
    return false;
}

export async function handleToolsDeepLink(
    bot: TelegramBot,
    msg: TelegramBot.Message,
    param: string,
    userRole: string,
    session: SessionData
): Promise<boolean> {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    if (!userId) return false;

    if (param === 'tools_list') {
        await sendToolsList(bot, chatId);
        return true;
    }

    if (param === 'tools_add') {
        await startAddingTool(bot, chatId, userId, session);
        return true;
    }

    if (param === 'tools_cat_add') {
        if (userRole !== 'admin') {
            bot.sendMessage(chatId, '❌ Chỉ Admin mới có quyền thêm danh mục công cụ.');
            return true;
        }
        updateSession(userId, { state: 'adding_tool_category_name' });
        bot.sendMessage(chatId, '➕ **THÊM DANH MỤC CÔNG CỤ**\n\nVui lòng nhập tên danh mục:', {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: '❌ Hủy', callback_data: 'tools_cancel' }]] }
        });
        return true;
    }

    return false;
}

export async function handleToolsState(
    bot: TelegramBot,
    msg: TelegramBot.Message,
    command: string,
    userRole: string,
    session: SessionData
): Promise<boolean> {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    const text = msg.text || '';
    if (!userId) return false;

    if (session.state === 'adding_tool_category_name') {
        updateSession(userId, { state: 'adding_tool_category_desc', tempData: { name: text } });
        bot.sendMessage(chatId, `Tên danh mục: *${text}*\n\nVui lòng nhập mô tả cho danh mục này (hoặc gõ /skip để bỏ qua):`, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: '❌ Hủy', callback_data: 'tools_cancel' }]] }
        });
        return true;
    }

    if (session.state === 'adding_tool_category_desc') {
        const desc = command === '/skip' ? null : text;
        const name = session.tempData.name;

        try {
            await db.query(
                'INSERT INTO tool_categories (name, description, created_by) VALUES ($1, $2, $3)',
                [name, desc, userId]
            );
            bot.sendMessage(chatId, `✅ Đã thêm danh mục công cụ: *${name}*`, { parse_mode: 'Markdown' });
        } catch (err) {
            console.error('Error adding tool category:', err);
            bot.sendMessage(chatId, '❌ Có lỗi xảy ra khi thêm danh mục.');
        }
        clearSession(userId);
        return true;
    }

    if (session.state === 'adding_tool_name') {
        updateSession(userId, { state: 'adding_tool_desc', tempData: { ...session.tempData, name: text } });
        bot.sendMessage(chatId, `Tên công cụ: *${text}*\n\nVui lòng nhập mô tả cho công cụ này (hoặc gõ /skip để bỏ qua):`, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: '❌ Hủy', callback_data: 'tools_cancel' }]] }
        });
        return true;
    }

    if (session.state === 'adding_tool_desc') {
        const desc = command === '/skip' ? null : text;
        updateSession(userId, { state: 'adding_tool_link_or_file', tempData: { ...session.tempData, description: desc } });
        bot.sendMessage(chatId, `Mô tả đã được lưu.\n\nVui lòng gửi link (URL) hoặc đính kèm tệp cho công cụ này (hoặc gõ /skip để bỏ qua):`, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: '❌ Hủy', callback_data: 'tools_cancel' }]] }
        });
        return true;
    }

    if (session.state === 'adding_tool_link_or_file') {
        let link = null;
        let fileId = null;
        let fileType = null;

        if (command !== '/skip') {
            if (msg.document) {
                fileId = msg.document.file_id;
                fileType = 'document';
            } else if (msg.photo && msg.photo.length > 0) {
                fileId = msg.photo[msg.photo.length - 1].file_id;
                fileType = 'photo';
            } else if (text) {
                link = text;
            } else {
                bot.sendMessage(chatId, '⚠️ Vui lòng gửi link hoặc tệp hợp lệ, hoặc gõ /skip.');
                return true;
            }
        }

        const { categoryId, name, description } = session.tempData;

        try {
            await db.query(
                'INSERT INTO tools (category_id, name, description, link, file_id, file_type, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7)',
                [categoryId, name, description, link, fileId, fileType, userId]
            );
            bot.sendMessage(chatId, `✅ Đã thêm công cụ: *${name}*`, { parse_mode: 'Markdown' });
        } catch (err) {
            console.error('Error adding tool:', err);
            bot.sendMessage(chatId, '❌ Có lỗi xảy ra khi thêm công cụ.');
        }
        clearSession(userId);
        return true;
    }

    if (session.state === 'editing_tool_category_name') {
        const newName = command === '/skip' ? session.tempData.oldName : text;
        updateSession(userId, { state: 'editing_tool_category_desc', tempData: { ...session.tempData, name: newName } });
        bot.sendMessage(chatId, `Tên danh mục: *${newName}*\n\nMô tả hiện tại: ${session.tempData.oldDesc || 'Không có'}\n\nVui lòng nhập mô tả mới (hoặc gõ /skip để giữ nguyên):`, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: '❌ Hủy', callback_data: 'tools_cancel' }]] }
        });
        return true;
    }

    if (session.state === 'editing_tool_category_desc') {
        const newDesc = command === '/skip' ? session.tempData.oldDesc : text;
        const { categoryId, name } = session.tempData;

        try {
            await db.query(
                'UPDATE tool_categories SET name = $1, description = $2 WHERE id = $3',
                [name, newDesc, categoryId]
            );
            bot.sendMessage(chatId, `✅ Đã cập nhật danh mục công cụ: *${name}*`, { parse_mode: 'Markdown' });
        } catch (err) {
            console.error('Error updating tool category:', err);
            bot.sendMessage(chatId, '❌ Có lỗi xảy ra khi cập nhật danh mục.');
        }
        clearSession(userId);
        return true;
    }

    if (session.state === 'editing_tool_name') {
        const newName = command === '/skip' ? session.tempData.oldName : text;
        updateSession(userId, { state: 'editing_tool_desc', tempData: { ...session.tempData, name: newName } });
        bot.sendMessage(chatId, `Tên công cụ: *${newName}*\n\nMô tả hiện tại: ${session.tempData.oldDesc || 'Không có'}\n\nVui lòng nhập mô tả mới (hoặc gõ /skip để giữ nguyên):`, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: '❌ Hủy', callback_data: 'tools_cancel' }]] }
        });
        return true;
    }

    if (session.state === 'editing_tool_desc') {
        const newDesc = command === '/skip' ? session.tempData.oldDesc : text;
        updateSession(userId, { state: 'editing_tool_link_or_file', tempData: { ...session.tempData, description: newDesc } });

        let currentLinkOrFile = 'Không có';
        if (session.tempData.oldLink) currentLinkOrFile = `Link: ${session.tempData.oldLink}`;
        else if (session.tempData.oldFileId) currentLinkOrFile = `Tệp đính kèm (${session.tempData.oldFileType})`;

        bot.sendMessage(chatId, `Mô tả đã được lưu.\n\nHiện tại: ${currentLinkOrFile}\n\nVui lòng gửi link (URL) hoặc đính kèm tệp mới cho công cụ này (hoặc gõ /skip để giữ nguyên):`, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: '❌ Hủy', callback_data: 'tools_cancel' }]] }
        });
        return true;
    }

    if (session.state === 'editing_tool_link_or_file') {
        let link = session.tempData.oldLink;
        let fileId = session.tempData.oldFileId;
        let fileType = session.tempData.oldFileType;

        if (command !== '/skip') {
            if (msg.document) {
                fileId = msg.document.file_id;
                fileType = 'document';
                link = null;
            } else if (msg.photo && msg.photo.length > 0) {
                fileId = msg.photo[msg.photo.length - 1].file_id;
                fileType = 'photo';
                link = null;
            } else if (text) {
                link = text;
                fileId = null;
                fileType = null;
            } else {
                bot.sendMessage(chatId, '⚠️ Vui lòng gửi link hoặc tệp hợp lệ, hoặc gõ /skip.');
                return true;
            }
        }

        const { toolId, name, description } = session.tempData;

        try {
            await db.query(
                'UPDATE tools SET name = $1, description = $2, link = $3, file_id = $4, file_type = $5 WHERE id = $6',
                [name, description, link, fileId, fileType, toolId]
            );
            bot.sendMessage(chatId, `✅ Đã cập nhật công cụ: *${name}*`, { parse_mode: 'Markdown' });
        } catch (err) {
            console.error('Error updating tool:', err);
            bot.sendMessage(chatId, '❌ Có lỗi xảy ra khi cập nhật công cụ.');
        }
        clearSession(userId);
        return true;
    }

    return false;
}

export async function handleToolsCallback(
    bot: TelegramBot,
    query: TelegramBot.CallbackQuery,
    data: string,
    userRole: string,
    session: SessionData
): Promise<boolean> {
    const chatId = query.message?.chat.id;
    const messageId = query.message?.message_id;
    const topicId = query.message?.message_thread_id;
    const userId = query.from.id;
    if (!chatId || !messageId) return false;

    const replyOptions: TelegramBot.SendMessageOptions = {};
    if (topicId) replyOptions.message_thread_id = topicId;

    if (data === 'tools_cancel') {
        clearSession(userId);
        bot.editMessageText('✅ Đã hủy thao tác.', { chat_id: chatId, message_id: messageId }).catch(() => { });
        bot.answerCallbackQuery(query.id);
        return true;
    }

    if (data === 'tools_list') {
        bot.deleteMessage(chatId, messageId).catch(() => { });
        await sendToolsList(bot, chatId, undefined, replyOptions);
        bot.answerCallbackQuery(query.id);
        return true;
    }

    if (data === 'tools_cat_list') {
        if (userRole !== 'admin') {
            bot.answerCallbackQuery(query.id, { text: '❌ Chỉ Admin mới có quyền.', show_alert: true });
            return true;
        }
        bot.deleteMessage(chatId, messageId).catch(() => { });
        await sendToolCategoriesList(bot, chatId);
        bot.answerCallbackQuery(query.id);
        return true;
    }

    if (data === 'tools_admin_list') {
        if (userRole !== 'admin') {
            bot.answerCallbackQuery(query.id, { text: '❌ Chỉ Admin mới có quyền.', show_alert: true });
            return true;
        }
        bot.deleteMessage(chatId, messageId).catch(() => { });
        await sendToolsList(bot, chatId, undefined, replyOptions);
        bot.answerCallbackQuery(query.id);
        return true;
    }

    if (data.startsWith('tools_cat_view_')) {
        const catId = parseInt(data.replace('tools_cat_view_', ''));
        bot.deleteMessage(chatId, messageId).catch(() => { });
        await sendToolsInCategory(bot, chatId, catId, undefined, replyOptions);
        bot.answerCallbackQuery(query.id);
        return true;
    }

    if (data.startsWith('tools_cat_add_tool_')) {
        const catId = parseInt(data.replace('tools_cat_add_tool_', ''));
        updateSession(userId, { state: 'adding_tool_name', tempData: { categoryId: catId } });
        bot.sendMessage(chatId, '➕ **THÊM CÔNG CỤ MỚI**\n\nVui lòng nhập tên công cụ:', {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: '❌ Hủy', callback_data: 'tools_cancel' }]] }
        });
        bot.answerCallbackQuery(query.id);
        return true;
    }

    if (data === 'tools_close_msg') {
        bot.deleteMessage(chatId, messageId).catch(() => { });
        bot.answerCallbackQuery(query.id);
        return true;
    }

    if (data.startsWith('tools_view_')) {
        const toolId = parseInt(data.replace('tools_view_', ''));
        bot.deleteMessage(chatId, messageId).catch(() => { });
        await sendToolDetails(bot, chatId, toolId, userRole, userId, replyOptions);
        bot.answerCallbackQuery(query.id);
        return true;
    }

    if (data.startsWith('tools_delete_')) {
        const toolId = parseInt(data.replace('tools_delete_', ''));
        try {
            const toolRes = await db.query('SELECT created_by, category_id FROM tools WHERE id = $1', [toolId]);
            if (toolRes.rows.length > 0) {
                const tool = toolRes.rows[0];
                if (userRole === 'admin' || tool.created_by === userId) {
                    await db.query('DELETE FROM tools WHERE id = $1', [toolId]);
                    bot.answerCallbackQuery(query.id, { text: '✅ Đã xóa công cụ.' });
                    bot.deleteMessage(chatId, messageId).catch(() => { });
                    await sendToolsInCategory(bot, chatId, tool.category_id, undefined, replyOptions);
                } else {
                    bot.answerCallbackQuery(query.id, { text: '❌ Bạn không có quyền xóa công cụ này.', show_alert: true });
                }
            }
        } catch (err) {
            console.error('Error deleting tool:', err);
            bot.answerCallbackQuery(query.id, { text: '❌ Có lỗi xảy ra.', show_alert: true });
        }
        return true;
    }

    if (data.startsWith('tools_cat_delete_')) {
        if (userRole !== 'admin') {
            bot.answerCallbackQuery(query.id, { text: '❌ Chỉ Admin mới có quyền.', show_alert: true });
            return true;
        }
        const catId = parseInt(data.replace('tools_cat_delete_', ''));
        try {
            await db.query('DELETE FROM tool_categories WHERE id = $1', [catId]);
            bot.answerCallbackQuery(query.id, { text: '✅ Đã xóa danh mục.' });
            await sendToolCategoriesList(bot, chatId, messageId);
        } catch (err) {
            console.error('Error deleting tool category:', err);
            bot.answerCallbackQuery(query.id, { text: '❌ Có lỗi xảy ra.', show_alert: true });
        }
        return true;
    }

    if (data.startsWith('tools_cat_edit_')) {
        if (userRole !== 'admin') {
            bot.answerCallbackQuery(query.id, { text: '❌ Chỉ Admin mới có quyền.', show_alert: true });
            return true;
        }
        const catId = parseInt(data.replace('tools_cat_edit_', ''));
        bot.deleteMessage(chatId, messageId).catch(() => { });
        try {
            const catRes = await db.query('SELECT name, description FROM tool_categories WHERE id = $1', [catId]);
            if (catRes.rows.length > 0) {
                updateSession(userId, { state: 'editing_tool_category_name', tempData: { categoryId: catId, oldName: catRes.rows[0].name, oldDesc: catRes.rows[0].description } });
                bot.sendMessage(chatId, `✏️ **SỬA DANH MỤC CÔNG CỤ**\n\nTên hiện tại: *${catRes.rows[0].name}*\n\nVui lòng nhập tên mới (hoặc gõ /skip để giữ nguyên):`, {
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: [[{ text: '❌ Hủy', callback_data: 'tools_cancel' }]] }
                });
            }
        } catch (err) {
            console.error('Error starting edit tool category:', err);
            bot.sendMessage(chatId, '❌ Có lỗi xảy ra.');
        }
        bot.answerCallbackQuery(query.id);
        return true;
    }

    if (data.startsWith('tools_edit_')) {
        const toolId = parseInt(data.replace('tools_edit_', ''));
        bot.deleteMessage(chatId, messageId).catch(() => { });
        try {
            const toolRes = await db.query('SELECT * FROM tools WHERE id = $1', [toolId]);
            if (toolRes.rows.length > 0) {
                const tool = toolRes.rows[0];
                if (userRole === 'admin' || tool.created_by === userId) {
                    updateSession(userId, { state: 'editing_tool_name', tempData: { toolId: tool.id, oldName: tool.name, oldDesc: tool.description, oldLink: tool.link, oldFileId: tool.file_id, oldFileType: tool.file_type } });
                    bot.sendMessage(chatId, `✏️ **SỬA CÔNG CỤ**\n\nTên hiện tại: *${tool.name}*\n\nVui lòng nhập tên mới (hoặc gõ /skip để giữ nguyên):`, {
                        parse_mode: 'Markdown',
                        reply_markup: { inline_keyboard: [[{ text: '❌ Hủy', callback_data: 'tools_cancel' }]] }
                    });
                } else {
                    bot.answerCallbackQuery(query.id, { text: '❌ Bạn không có quyền sửa công cụ này.', show_alert: true });
                    return true;
                }
            }
        } catch (err) {
            console.error('Error starting edit tool:', err);
            bot.sendMessage(chatId, '❌ Có lỗi xảy ra.');
        }
        bot.answerCallbackQuery(query.id);
        return true;
    }

    return false;
}

async function startAddingTool(bot: TelegramBot, chatId: number, userId: number, session: SessionData) {
    try {
        const cats = await db.query('SELECT id, name FROM tool_categories ORDER BY name ASC');
        if (cats.rows.length === 0) {
            bot.sendMessage(chatId, '⚠️ Hiện chưa có danh mục công cụ nào. Vui lòng liên hệ Admin để tạo danh mục trước.');
            return;
        }

        const keyboard: InlineKeyboardButton[][] = cats.rows.map(c => [{ text: `📁 ${c.name}`, callback_data: `tools_cat_add_tool_${c.id}` }]);
        keyboard.push([{ text: '❌ Hủy', callback_data: 'tools_cancel' }]);

        bot.sendMessage(chatId, '➕ **THÊM CÔNG CỤ MỚI**\n\nVui lòng chọn danh mục cho công cụ:', {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: keyboard }
        });
    } catch (err) {
        console.error('Error starting add tool:', err);
        bot.sendMessage(chatId, '❌ Có lỗi xảy ra.');
    }
}

async function sendToolsList(bot: TelegramBot, chatId: number, messageId?: number, replyOptions?: TelegramBot.SendMessageOptions) {
    try {
        const cats = await db.query('SELECT id, name FROM tool_categories ORDER BY name ASC');
        const text = '🛠 **DANH SÁCH CÔNG CỤ**\n\nChọn một danh mục để xem các công cụ:';
        const keyboard: InlineKeyboardButton[][] = cats.rows.map(c => [{ text: `📁 ${c.name}`, callback_data: `tools_cat_view_${c.id}` }]);

        if (chatId < 0) {
            keyboard.push([{ text: '❌ Đóng', callback_data: 'tools_close_msg' }]);
        } else {
            keyboard.push([{ text: '🔙 Quay lại Menu', callback_data: 'user_dashboard' }]);
        }

        let sentMsg: TelegramBot.Message | undefined;

        if (messageId) {
            bot.editMessageText(text, {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: keyboard }
            }).catch(console.error);
        } else {
            sentMsg = await bot.sendMessage(chatId, text, {
                ...replyOptions,
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: keyboard }
            });
        }

        if (chatId < 0) {
            const msgIdToDelete = messageId || sentMsg?.message_id;
            if (msgIdToDelete) {
                setTimeout(() => {
                    bot.deleteMessage(chatId, msgIdToDelete).catch(() => { });
                }, 60000);
            }
        }
    } catch (err) {
        console.error('Error sending tools list:', err);
    }
}

async function sendToolCategoriesList(bot: TelegramBot, chatId: number, messageId?: number) {
    try {
        const cats = await db.query('SELECT id, name, description FROM tool_categories ORDER BY name ASC');
        const text = '🛠 **QUẢN LÝ DANH MỤC CÔNG CỤ**\n\nDanh sách các danh mục hiện có:';
        const keyboard: InlineKeyboardButton[][] = cats.rows.map(c => [
            { text: `📁 ${c.name}`, callback_data: `tools_cat_view_${c.id}` },
            { text: '✏️ Sửa', callback_data: `tools_cat_edit_${c.id}` },
            { text: '🗑 Xóa', callback_data: `tools_cat_delete_${c.id}` }
        ]);
        keyboard.push([{ text: '🔙 Quay lại Menu Admin', callback_data: 'admin_dashboard' }]);

        if (messageId) {
            bot.editMessageText(text, {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: keyboard }
            }).catch(console.error);
        } else {
            bot.sendMessage(chatId, text, {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: keyboard }
            });
        }
    } catch (err) {
        console.error('Error sending tool categories list:', err);
    }
}

async function sendToolsInCategory(bot: TelegramBot, chatId: number, categoryId: number, messageId?: number, replyOptions?: TelegramBot.SendMessageOptions) {
    try {
        const catRes = await db.query('SELECT name FROM tool_categories WHERE id = $1', [categoryId]);
        if (catRes.rows.length === 0) return;
        const catName = catRes.rows[0].name;

        const toolsRes = await db.query('SELECT id, name FROM tools WHERE category_id = $1 ORDER BY name ASC', [categoryId]);

        const text = `📁 **DANH MỤC: ${catName}**\n\nDanh sách công cụ:`;
        const keyboard: InlineKeyboardButton[][] = toolsRes.rows.map(t => [{ text: `🔧 ${t.name}`, callback_data: `tools_view_${t.id}` }]);

        if (chatId > 0) {
            keyboard.push([{ text: '➕ Thêm công cụ vào mục này', callback_data: `tools_cat_add_tool_${categoryId}` }]);
            keyboard.push([{ text: '🔙 Quay lại Danh mục', callback_data: 'tools_list' }]);
        } else {
            keyboard.push([
                { text: '🔙 Quay lại Danh mục', callback_data: 'tools_list' },
                { text: '❌ Đóng', callback_data: 'tools_close_msg' }
            ]);
        }

        let sentMsg: TelegramBot.Message | undefined;

        if (messageId) {
            bot.editMessageText(text, {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: keyboard }
            }).catch(console.error);
        } else {
            sentMsg = await bot.sendMessage(chatId, text, {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: keyboard }
            });
        }

        if (chatId < 0) {
            const msgIdToDelete = messageId || sentMsg?.message_id;
            if (msgIdToDelete) {
                setTimeout(() => {
                    bot.deleteMessage(chatId, msgIdToDelete).catch(() => { });
                }, 60000);
            }
        }
    } catch (err) {
        console.error('Error sending tools in category:', err);
    }
}

async function sendToolDetails(bot: TelegramBot, chatId: number, toolId: number, userRole: string, userId: number, replyOptions?: TelegramBot.SendMessageOptions) {
    try {
        const toolRes = await db.query(`
      SELECT t.*, c.name as category_name, 
             COALESCE(NULLIF(u.full_name, ''), NULLIF(trim(concat(users.first_name, ' ', users.last_name)), ''), NULLIF(users.username, ''), 'Người dùng') as creator_name
      FROM tools t
      LEFT JOIN tool_categories c ON t.category_id = c.id
      LEFT JOIN users ON t.created_by = users.id
      LEFT JOIN user_profiles u ON users.id = u.user_id
      WHERE t.id = $1
    `, [toolId]);

        if (toolRes.rows.length === 0) {
            bot.sendMessage(chatId, '❌ Không tìm thấy công cụ.');
            return;
        }

        const tool = toolRes.rows[0];
        let text = `🔧 **${tool.name}**\n\n`;
        text += `📁 Danh mục: ${tool.category_name}\n`;
        if (tool.description) text += `📝 Mô tả: ${tool.description}\n`;
        if (tool.link) text += `🔗 Link: ${tool.link}\n`;

        const dateAdded = new Date(tool.created_at).toLocaleDateString('vi-VN');
        text += `\n👤 Thêm bởi: ${tool.creator_name || 'Người dùng'}\n`;
        text += `📅 Ngày thêm: ${dateAdded}`;

        const keyboard: InlineKeyboardButton[][] = [];

        if (userRole === 'admin' || tool.created_by === userId) {
            keyboard.push([
                { text: '✏️ Sửa', callback_data: `tools_edit_${tool.id}` },
                { text: '🗑 Xóa', callback_data: `tools_delete_${tool.id}` }
            ]);
        }
        if (chatId < 0) {
            keyboard.push([
                { text: '🔙 Quay lại Danh mục', callback_data: `tools_cat_view_${tool.category_id}` },
                { text: '❌ Đóng', callback_data: 'tools_close_msg' }
            ]);
        } else {
            keyboard.push([{ text: '🔙 Quay lại Danh mục', callback_data: `tools_cat_view_${tool.category_id}` }]);
        }

        let sentMsg: TelegramBot.Message;

        if (tool.file_id) {
            if (tool.file_type === 'document') {
                sentMsg = await bot.sendDocument(chatId, tool.file_id, {
                    ...replyOptions,
                    caption: text,
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: keyboard }
                });
            } else {
                sentMsg = await bot.sendPhoto(chatId, tool.file_id, {
                    ...replyOptions,
                    caption: text,
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: keyboard }
                });
            }
        } else {
            sentMsg = await bot.sendMessage(chatId, text, {
                ...replyOptions,
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: keyboard }
            });
        }

        // Auto-delete after 1 minute in group chats
        if (chatId < 0) {
            setTimeout(() => {
                bot.deleteMessage(chatId, sentMsg.message_id).catch(() => { });
            }, 60000);
        }

    } catch (err) {
        console.error('Error sending tool details:', err);
        bot.sendMessage(chatId, '❌ Có lỗi xảy ra khi tải thông tin công cụ.');
    }
}
