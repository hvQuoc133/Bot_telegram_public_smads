import TelegramBot, { InlineKeyboardButton } from 'node-telegram-bot-api';
import { db } from '../../db';
import { SessionData, updateSession, clearSession, getSession } from '../services/sessionManager';
import { botUsername } from '../botInstance';
import { sendToolsDashboard } from './topicManager';

const activeTimeouts = new Map<number, NodeJS.Timeout>();

function setAutoBackTimeout(messageId: number, callback: () => void) {
    if (activeTimeouts.has(messageId)) {
        clearTimeout(activeTimeouts.get(messageId)!);
    }
    const timeout = setTimeout(() => {
        activeTimeouts.delete(messageId);
        callback();
    }, 60000);
    activeTimeouts.set(messageId, timeout);
}

function clearAutoBackTimeout(messageId: number) {
    if (activeTimeouts.has(messageId)) {
        clearTimeout(activeTimeouts.get(messageId)!);
        activeTimeouts.delete(messageId);
    }
}

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

    if (param.startsWith('edittool_')) {
        const toolId = parseInt(param.replace('edittool_', ''));
        try {
            const toolRes = await db.query('SELECT * FROM tools WHERE id = $1', [toolId]);
            if (toolRes.rows.length > 0) {
                const tool = toolRes.rows[0];
                if (userRole === 'admin' || tool.created_by === userId) {
                    updateSession(userId, { state: 'editing_tool_name', tempData: { toolId: tool.id, oldName: tool.name, oldDesc: tool.description, oldLink: tool.link, oldFileId: tool.file_id, oldFileType: tool.file_type } });

                    let currentLinkOrFile = 'Không có';
                    if (tool.link) currentLinkOrFile = `Link: ${tool.link}`;
                    else if (tool.file_id) currentLinkOrFile = `Tệp đính kèm (${tool.file_type})`;

                    const text = `✏️ **SỬA CÔNG CỤ**\n\n` +
                        `*Tên:* ${tool.name}\n` +
                        `*Mô tả:* ${tool.description || 'Không có'}\n` +
                        `*Đính kèm:* ${currentLinkOrFile}\n\n` +
                        `Vui lòng chọn phần muốn sửa:`;

                    const keyboard = {
                        inline_keyboard: [
                            [{ text: '✏️ Sửa Tên', callback_data: `tools_edit_field_name_${toolId}` }],
                            [{ text: '✏️ Sửa Mô tả', callback_data: `tools_edit_field_desc_${toolId}` }],
                            [{ text: '✏️ Sửa Link/Tệp', callback_data: `tools_edit_field_link_${toolId}` }],
                            [{ text: '❌ Hủy', callback_data: `tools_edit_cancel_${toolId}` }]
                        ]
                    };

                    bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: keyboard });
                } else {
                    bot.sendMessage(chatId, '❌ Bạn không có quyền sửa công cụ này.');
                }
            } else {
                bot.sendMessage(chatId, '❌ Không tìm thấy công cụ.');
            }
        } catch (err) {
            console.error('Error starting edit tool via deep link:', err);
            bot.sendMessage(chatId, '❌ Có lỗi xảy ra.');
        }
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
                bot.sendMessage(chatId, '⚠️ Vui lòng gửi link hoặc tệp hợp lệ, hoặc gõ /skip.', {
                    reply_markup: { inline_keyboard: [[{ text: '❌ Hủy', callback_data: 'tools_cancel' }]] }
                });
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

    if (session.state === 'editing_tool_category_name' || session.state === 'editing_tool_category_desc') {
        const { categoryId, promptMessageId, viewMessageId } = session.tempData;

        try {
            if (session.state === 'editing_tool_category_name') {
                await db.query('UPDATE tool_categories SET name = $1 WHERE id = $2', [text, categoryId]);
            } else {
                await db.query('UPDATE tool_categories SET description = $1 WHERE id = $2', [text, categoryId]);
            }

            bot.sendMessage(chatId, `✅ Đã cập nhật danh mục công cụ.`).then(m => {
                setTimeout(() => bot.deleteMessage(chatId, m.message_id).catch(() => { }), 3000);
            });

            if (promptMessageId) bot.deleteMessage(chatId, promptMessageId).catch(() => { });
            bot.deleteMessage(chatId, msg.message_id).catch(() => { });
            if (viewMessageId) bot.deleteMessage(chatId, viewMessageId).catch(() => { });

            const catRes = await db.query('SELECT name, description FROM tool_categories WHERE id = $1', [categoryId]);
            if (catRes.rows.length > 0) {
                const textMsg = `✏️ **SỬA DANH MỤC CÔNG CỤ**\n\n` +
                    `*Tên:* ${catRes.rows[0].name}\n` +
                    `*Mô tả:* ${catRes.rows[0].description || 'Không có'}\n\n` +
                    `Vui lòng chọn phần muốn sửa:`;

                const keyboard = {
                    inline_keyboard: [
                        [{ text: '✏️ Sửa Tên', callback_data: `tools_cat_edit_field_name_${categoryId}` }],
                        [{ text: '✏️ Sửa Mô tả', callback_data: `tools_cat_edit_field_desc_${categoryId}` }],
                        [{ text: '❌ Hủy', callback_data: `tools_cat_edit_cancel_${categoryId}` }]
                    ]
                };
                bot.sendMessage(chatId, textMsg, { parse_mode: 'Markdown', reply_markup: keyboard });
            }
        } catch (err) {
            console.error('Error updating tool category:', err);
            bot.sendMessage(chatId, '❌ Có lỗi xảy ra khi cập nhật danh mục.');
        }
        clearSession(userId);
        return true;
    }

    if (session.state === 'editing_tool_name' || session.state === 'editing_tool_desc' || session.state === 'editing_tool_link_or_file') {
        const { toolId, promptMessageId, viewMessageId } = session.tempData;

        try {
            if (session.state === 'editing_tool_name') {
                await db.query('UPDATE tools SET name = $1 WHERE id = $2', [text, toolId]);
            } else if (session.state === 'editing_tool_desc') {
                await db.query('UPDATE tools SET description = $1 WHERE id = $2', [text, toolId]);
            } else if (session.state === 'editing_tool_link_or_file') {
                let link = null;
                let fileId = null;
                let fileType = null;

                if (msg.document) {
                    fileId = msg.document.file_id;
                    fileType = 'document';
                } else if (msg.photo && msg.photo.length > 0) {
                    fileId = msg.photo[msg.photo.length - 1].file_id;
                    fileType = 'photo';
                } else if (text) {
                    link = text;
                } else {
                    bot.sendMessage(chatId, '⚠️ Vui lòng gửi link hoặc tệp hợp lệ.', {
                        reply_markup: { inline_keyboard: [[{ text: '❌ Hủy', callback_data: `tools_edit_cancel_${toolId}` }]] }
                    }).then(m => {
                        updateSession(userId, { state: session.state, tempData: { ...session.tempData, promptMessageId: m.message_id } });
                    });
                    return true;
                }
                await db.query('UPDATE tools SET link = $1, file_id = $2, file_type = $3 WHERE id = $4', [link, fileId, fileType, toolId]);
            }

            bot.sendMessage(chatId, `✅ Đã cập nhật công cụ.`).then(m => {
                setTimeout(() => bot.deleteMessage(chatId, m.message_id).catch(() => { }), 3000);
            });

            if (promptMessageId) bot.deleteMessage(chatId, promptMessageId).catch(() => { });
            bot.deleteMessage(chatId, msg.message_id).catch(() => { });
            if (viewMessageId) bot.deleteMessage(chatId, viewMessageId).catch(() => { });

            const toolRes = await db.query('SELECT * FROM tools WHERE id = $1', [toolId]);
            if (toolRes.rows.length > 0) {
                const tool = toolRes.rows[0];
                let currentLinkOrFile = 'Không có';
                if (tool.link) currentLinkOrFile = `Link: ${tool.link}`;
                else if (tool.file_id) currentLinkOrFile = `Tệp đính kèm (${tool.file_type})`;

                const textMsg = `✏️ **SỬA CÔNG CỤ**\n\n` +
                    `*Tên:* ${tool.name}\n` +
                    `*Mô tả:* ${tool.description || 'Không có'}\n` +
                    `*Đính kèm:* ${currentLinkOrFile}\n\n` +
                    `Vui lòng chọn phần muốn sửa:`;

                const keyboard = {
                    inline_keyboard: [
                        [{ text: '✏️ Sửa Tên', callback_data: `tools_edit_field_name_${toolId}` }],
                        [{ text: '✏️ Sửa Mô tả', callback_data: `tools_edit_field_desc_${toolId}` }],
                        [{ text: '✏️ Sửa Link/Tệp', callback_data: `tools_edit_field_link_${toolId}` }],
                        [{ text: '❌ Hủy', callback_data: `tools_edit_cancel_${toolId}` }]
                    ]
                };
                bot.sendMessage(chatId, textMsg, { parse_mode: 'Markdown', reply_markup: keyboard });
            }
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

    clearAutoBackTimeout(messageId);

    const replyOptions: TelegramBot.SendMessageOptions = {};
    if (topicId) replyOptions.message_thread_id = topicId;

    if (data === 'tools_cancel') {
        clearSession(userId);
        bot.editMessageText('✅ Đã hủy thao tác.', { chat_id: chatId, message_id: messageId }).catch(() => { });
        bot.answerCallbackQuery(query.id);
        return true;
    }

    if (data === 'tools_list_new') {
        await sendToolsList(bot, chatId, undefined, replyOptions);
        bot.answerCallbackQuery(query.id);
        return true;
    }

    if (data === 'tools_dashboard') {
        if (chatId < 0 && messageId) {
            bot.deleteMessage(chatId, messageId).catch(() => { });
        } else {
            await sendToolsDashboard(bot, chatId, topicId || 0, userRole, replyOptions, messageId);
        }
        bot.answerCallbackQuery(query.id);
        return true;
    }

    if (data === 'tools_list') {
        await sendToolsList(bot, chatId, messageId, replyOptions);
        bot.answerCallbackQuery(query.id);
        return true;
    }

    if (data === 'tools_cat_list') {
        if (userRole !== 'admin') {
            bot.answerCallbackQuery(query.id, { text: '❌ Chỉ Admin mới có quyền.', show_alert: true });
            return true;
        }
        await sendToolCategoriesList(bot, chatId, messageId, replyOptions);
        bot.answerCallbackQuery(query.id);
        return true;
    }

    if (data === 'tools_admin_list') {
        if (userRole !== 'admin') {
            bot.answerCallbackQuery(query.id, { text: '❌ Chỉ Admin mới có quyền.', show_alert: true });
            return true;
        }
        await sendToolsList(bot, chatId, messageId, replyOptions);
        bot.answerCallbackQuery(query.id);
        return true;
    }

    if (data.startsWith('tools_cat_view_')) {
        const catId = parseInt(data.replace('tools_cat_view_', ''));
        await sendToolsInCategory(bot, chatId, catId, messageId, replyOptions);
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
        await sendToolsList(bot, chatId, messageId, replyOptions);
        bot.answerCallbackQuery(query.id);
        return true;
    }

    if (data === 'tools_close_temp') {
        bot.deleteMessage(chatId, messageId).catch(() => { });
        bot.answerCallbackQuery(query.id);
        return true;
    }

    if (data.startsWith('tools_view_')) {
        const toolId = parseInt(data.replace('tools_view_', ''));
        await sendToolDetails(bot, chatId, toolId, userRole, userId, messageId, replyOptions);
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
                    await sendToolsInCategory(bot, chatId, tool.category_id, messageId, replyOptions);
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
            await sendToolCategoriesList(bot, chatId, messageId, replyOptions);
        } catch (err) {
            console.error('Error deleting tool category:', err);
            bot.answerCallbackQuery(query.id, { text: '❌ Có lỗi xảy ra.', show_alert: true });
        }
        return true;
    }

    if (data.startsWith('tools_cat_edit_') && !data.startsWith('tools_cat_edit_field_') && !data.startsWith('tools_cat_edit_cancel_')) {
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

                const text = `✏️ **SỬA DANH MỤC CÔNG CỤ**\n\n` +
                    `*Tên:* ${catRes.rows[0].name}\n` +
                    `*Mô tả:* ${catRes.rows[0].description || 'Không có'}\n\n` +
                    `Vui lòng chọn phần muốn sửa:`;

                const keyboard = {
                    inline_keyboard: [
                        [{ text: '✏️ Sửa Tên', callback_data: `tools_cat_edit_field_name_${catId}` }],
                        [{ text: '✏️ Sửa Mô tả', callback_data: `tools_cat_edit_field_desc_${catId}` }],
                        [{ text: '❌ Hủy', callback_data: `tools_cat_edit_cancel_${catId}` }]
                    ]
                };

                bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: keyboard });
            }
        } catch (err) {
            console.error('Error starting edit tool category:', err);
            bot.sendMessage(chatId, '❌ Có lỗi xảy ra.');
        }
        bot.answerCallbackQuery(query.id);
        return true;
    }

    if (data.startsWith('tools_cat_edit_field_')) {
        const parts = data.split('_');
        const field = parts[4];
        const id = parts[5];
        const session = getSession(userId);

        let promptText = '';
        if (field === 'name') promptText = '📝 Vui lòng nhập *Tên* mới cho Danh mục:';
        if (field === 'desc') promptText = '📄 Vui lòng nhập *Mô tả* mới cho Danh mục:';

        bot.sendMessage(chatId, promptText, { parse_mode: 'Markdown' }).then(m => {
            updateSession(userId, {
                state: `editing_tool_category_${field}` as any,
                tempData: { ...session.tempData, categoryId: parseInt(id), promptMessageId: m.message_id, viewMessageId: messageId }
            });
        });
        bot.answerCallbackQuery(query.id);
        return true;
    }

    if (data.startsWith('tools_cat_edit_cancel_')) {
        bot.deleteMessage(chatId, messageId).catch(() => { });
        bot.sendMessage(chatId, '✅ Đã hủy chỉnh sửa danh mục.', {
            reply_markup: { inline_keyboard: [[{ text: '🔙 Quay lại Menu', callback_data: 'tools_dashboard' }]] }
        });
        clearSession(userId);
        bot.answerCallbackQuery(query.id);
        return true;
    }

    if (data.startsWith('tools_edit_') && !data.startsWith('tools_edit_field_') && !data.startsWith('tools_edit_cancel_')) {
        const toolId = parseInt(data.replace('tools_edit_', ''));

        const isPrivate = query.message?.chat.type === 'private';
        if (!isPrivate) {
            const deepLink = botUsername ? `https://t.me/${botUsername}?start=edittool_${toolId}` : 'https://t.me/your_bot';
            bot.answerCallbackQuery(query.id, { text: '⚙️ Vui lòng chuyển sang Inbox bot để sửa.', show_alert: true, url: deepLink });
            return true;
        }

        bot.deleteMessage(chatId, messageId).catch(() => { });
        try {
            const toolRes = await db.query('SELECT * FROM tools WHERE id = $1', [toolId]);
            if (toolRes.rows.length > 0) {
                const tool = toolRes.rows[0];
                if (userRole === 'admin' || tool.created_by === userId) {
                    updateSession(userId, { state: 'editing_tool_name', tempData: { toolId: tool.id, oldName: tool.name, oldDesc: tool.description, oldLink: tool.link, oldFileId: tool.file_id, oldFileType: tool.file_type } });

                    let currentLinkOrFile = 'Không có';
                    if (tool.link) currentLinkOrFile = `Link: ${tool.link}`;
                    else if (tool.file_id) currentLinkOrFile = `Tệp đính kèm (${tool.file_type})`;

                    const text = `✏️ **SỬA CÔNG CỤ**\n\n` +
                        `*Tên:* ${tool.name}\n` +
                        `*Mô tả:* ${tool.description || 'Không có'}\n` +
                        `*Đính kèm:* ${currentLinkOrFile}\n\n` +
                        `Vui lòng chọn phần muốn sửa:`;

                    const keyboard = {
                        inline_keyboard: [
                            [{ text: '✏️ Sửa Tên', callback_data: `tools_edit_field_name_${toolId}` }],
                            [{ text: '✏️ Sửa Mô tả', callback_data: `tools_edit_field_desc_${toolId}` }],
                            [{ text: '✏️ Sửa Link/Tệp', callback_data: `tools_edit_field_link_${toolId}` }],
                            [{ text: '❌ Hủy', callback_data: `tools_edit_cancel_${toolId}` }]
                        ]
                    };

                    bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: keyboard });
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

    if (data.startsWith('tools_edit_field_')) {
        const parts = data.split('_');
        const field = parts[3];
        const id = parts[4];
        const session = getSession(userId);

        let promptText = '';
        let state = '';
        if (field === 'name') { promptText = '📝 Vui lòng nhập *Tên* mới cho Công cụ:'; state = 'editing_tool_name'; }
        if (field === 'desc') { promptText = '📄 Vui lòng nhập *Mô tả* mới cho Công cụ:'; state = 'editing_tool_desc'; }
        if (field === 'link') { promptText = '🔗 Vui lòng gửi *Link (URL)* hoặc đính kèm *Tệp* mới cho Công cụ:'; state = 'editing_tool_link_or_file'; }

        bot.sendMessage(chatId, promptText, { parse_mode: 'Markdown' }).then(m => {
            updateSession(userId, {
                state: state as any,
                tempData: { ...session.tempData, toolId: parseInt(id), promptMessageId: m.message_id, viewMessageId: messageId }
            });
        });
        bot.answerCallbackQuery(query.id);
        return true;
    }

    if (data.startsWith('tools_edit_cancel_')) {
        bot.deleteMessage(chatId, messageId).catch(() => { });
        bot.sendMessage(chatId, '✅ Đã hủy chỉnh sửa công cụ.').then(m => {
            setTimeout(() => bot.deleteMessage(chatId, m.message_id).catch(() => { }), 15000);
        });
        clearSession(userId);
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

        if (chatId > 0) {
            keyboard.push([{ text: 'Đóng', callback_data: 'user_dashboard' }]);
        } else {
            keyboard.push([{ text: 'Đóng', callback_data: 'tools_dashboard' }]);
        }

        let sentMsg: TelegramBot.Message | undefined;

        if (messageId) {
            try {
                await bot.editMessageText(text, {
                    chat_id: chatId,
                    message_id: messageId,
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: keyboard }
                });
            } catch (e) {
                bot.deleteMessage(chatId, messageId).catch(() => { });
                sentMsg = await bot.sendMessage(chatId, text, {
                    ...replyOptions,
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

        if (chatId < 0) {
            const msgId = sentMsg?.message_id || messageId;
            if (msgId) {
                setAutoBackTimeout(msgId, () => {
                    bot.deleteMessage(chatId, msgId).catch(() => { });
                });
            }
        }
    } catch (err) {
        console.error('Error sending tools list:', err);
    }
}

async function sendToolCategoriesList(bot: TelegramBot, chatId: number, messageId?: number, replyOptions?: TelegramBot.SendMessageOptions) {
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
            try {
                await bot.editMessageText(text, {
                    chat_id: chatId,
                    message_id: messageId,
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: keyboard }
                });
            } catch (e) {
                bot.deleteMessage(chatId, messageId).catch(() => { });
                bot.sendMessage(chatId, text, {
                    ...replyOptions,
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: keyboard }
                });
            }
        } else {
            bot.sendMessage(chatId, text, {
                ...replyOptions,
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
                { text: '🔙 Quay lại Danh mục', callback_data: 'tools_list' }
            ]);
        }

        let sentMsg: TelegramBot.Message | undefined;

        if (messageId) {
            try {
                await bot.editMessageText(text, {
                    chat_id: chatId,
                    message_id: messageId,
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: keyboard }
                });
            } catch (e) {
                bot.deleteMessage(chatId, messageId).catch(() => { });
                sentMsg = await bot.sendMessage(chatId, text, {
                    ...replyOptions,
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

        if (chatId < 0) {
            const msgId = sentMsg?.message_id || messageId;
            if (msgId) {
                setAutoBackTimeout(msgId, () => {
                    bot.deleteMessage(chatId, msgId).catch(() => { });
                });
            }
        }
    } catch (err) {
        console.error('Error sending tools in category:', err);
    }
}

async function sendToolDetails(bot: TelegramBot, chatId: number, toolId: number, userRole: string, userId: number, messageId?: number, replyOptions?: TelegramBot.SendMessageOptions) {
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
                { text: '🔙 Menu Chính', callback_data: 'tools_list' }
            ]);
            keyboard.push([{ text: '🗑 Đóng', callback_data: 'tools_close_temp' }]);
        } else {
            keyboard.push([{ text: '🔙 Quay lại Danh mục', callback_data: `tools_cat_view_${tool.category_id}` }]);
        }

        let sentMsg: TelegramBot.Message | undefined;

        if (tool.file_id) {
            if (messageId) {
                bot.deleteMessage(chatId, messageId).catch(() => { });
            }
            if (tool.file_type === 'document') {
                sentMsg = await bot.sendDocument(chatId, tool.file_id, {
                    ...replyOptions,
                    caption: text,
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: keyboard }
                });
            } else if (tool.file_type === 'video') {
                sentMsg = await bot.sendVideo(chatId, tool.file_id, {
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
            if (messageId) {
                try {
                    await bot.editMessageText(text, {
                        chat_id: chatId,
                        message_id: messageId,
                        parse_mode: 'Markdown',
                        reply_markup: { inline_keyboard: keyboard }
                    });
                } catch (e) {
                    bot.deleteMessage(chatId, messageId).catch(() => { });
                    sentMsg = await bot.sendMessage(chatId, text, {
                        ...replyOptions,
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
        }

        if (chatId < 0) {
            const msgId = sentMsg?.message_id || messageId;
            if (msgId) {
                setTimeout(() => {
                    bot.deleteMessage(chatId, msgId).catch(() => { });
                }, 15000);
            }
        }

    } catch (err) {
        console.error('Error sending tool details:', err);
        bot.sendMessage(chatId, '❌ Có lỗi xảy ra khi tải thông tin công cụ.', {
            ...replyOptions,
            reply_markup: {
                inline_keyboard: [[{ text: '🔙 Quay lại Menu', callback_data: 'tools_list' }]]
            }
        });
    }
}
