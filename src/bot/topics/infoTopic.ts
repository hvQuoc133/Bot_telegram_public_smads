import { formatVNDate } from '../utils/dateUtils';
import TelegramBot from 'node-telegram-bot-api';
import { db } from '../../db';
import { getSession, updateSession, clearSession, topicCache, CACHE_TTL } from '../services/sessionManager';
import { handleAdminDashboard } from './adminTopic';
import { botUsername } from '../botInstance';
import { trackMessage, getTrackedMessages } from '../utils/messageTracker';

export async function broadcastPersonnelUpdate(bot: TelegramBot) {
    const tracked = getTrackedMessages('personnel_list');
    if (tracked.length === 0) return;

    const users = await db.query("SELECT id, full_name, position, email FROM user_profiles WHERE status = 'active' ORDER BY full_name ASC");
    const keyboard = users.rows.length > 0
        ? users.rows.map(u => [{ text: `👤 ${u.full_name} - ${u.position || 'Nhân viên'}`, callback_data: `info_view_${u.id}` }])
        : [];

    keyboard.push([{ text: '🔄 Làm mới', callback_data: 'info_refresh_personnel' }, { text: '❌ Đóng', callback_data: 'info_close_message' }]);

    const text = users.rows.length > 0 ? '📇 Danh sách Nhân sự công ty:' : 'Hiện tại chưa có thông tin nhân sự nào.';

    for (const msg of tracked) {
        try {
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

export async function refreshAllInfoTopics(bot: TelegramBot) {
    try {
        const topics = await db.query("SELECT chat_id, topic_id, pinned_message_id FROM topics WHERE feature_type = 'information' AND pinned_message_id IS NOT NULL");

        const users = await db.query("SELECT id, full_name, position, email FROM user_profiles WHERE status = 'active' ORDER BY full_name ASC");

        const keyboard: any[][] = users.rows.length > 0
            ? users.rows.map(u => [{ text: `👤 ${u.full_name} - ${u.position || 'Nhân viên'}`, callback_data: `info_view_${u.id}` }])
            : [];

        const now = new Date();
        const timeStr = now.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
        const dateStr = formatVNDate(now);
        const text = '📇 *DANH SÁCH NHÂN SỰ CÔNG TY*\n\n' +
            (users.rows.length > 0 ? 'Chọn một thành viên bên dưới để xem thông tin chi tiết:' : 'Hiện tại chưa có thông tin nhân sự nào.') +
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
                        console.log(`Pinned message not found in chat ${topic.chat_id} (topic: ${topic.topic_id}). Recreating...`);
                        try {
                            const sentMsg = await bot.sendMessage(topic.chat_id, text, {
                                message_thread_id: topic.topic_id || undefined,
                                parse_mode: 'Markdown',
                                reply_markup: { inline_keyboard: keyboard }
                            });
                            await bot.pinChatMessage(topic.chat_id, sentMsg.message_id).catch(console.error);
                            await db.query('UPDATE topics SET pinned_message_id = $1 WHERE chat_id = $2 AND topic_id = $3', [sentMsg.message_id, topic.chat_id, topic.topic_id]);
                            console.log(`Recreated and pinned info message in chat ${topic.chat_id} (topic: ${topic.topic_id})`);
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
        console.error('Error refreshing info topics:', err);
    }
}

export async function handleInfoCallback(
    bot: TelegramBot,
    query: TelegramBot.CallbackQuery,
    data: string,
    userRole: string
): Promise<boolean> {
    const chatId = query.message?.chat.id;
    const messageId = query.message?.message_id;
    const userId = query.from.id;

    if (!chatId || !messageId) return false;

    // Close message
    if (data === 'info_close_message') {
        bot.deleteMessage(chatId, messageId).catch(() => { });
        bot.answerCallbackQuery(query.id);
        return true;
    }

    // Refresh personnel
    if (data === 'info_refresh_personnel') {
        const users = await db.query("SELECT id, full_name, position, email FROM user_profiles WHERE status = 'active' ORDER BY full_name ASC");
        const keyboard = users.rows.length > 0
            ? users.rows.map(u => [{ text: `👤 ${u.full_name} - ${u.position || 'Nhân viên'}`, callback_data: `info_view_${u.id}` }])
            : [];

        keyboard.push([{ text: '🔄 Làm mới', callback_data: 'info_refresh_personnel' }, { text: '❌ Đóng', callback_data: 'info_close_message' }]);

        const text = users.rows.length > 0 ? '📇 Danh sách Nhân sự công ty:' : 'Hiện tại chưa có thông tin nhân sự nào.';

        bot.editMessageText(text, {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: keyboard }
        }).catch(() => { });

        bot.answerCallbackQuery(query.id, { text: 'Đã làm mới danh sách!' });
        return true;
    }

    // User Dashboard -> View Personnel List
    if (data === 'info_list') {
        const isPrivate = query.message?.chat.type === 'private';
        if (!isPrivate) return false;

        const users = await db.query("SELECT id, full_name, position, email FROM user_profiles WHERE status = 'active' ORDER BY full_name ASC");
        const keyboard = users.rows.map(u => [{ text: `👤 ${u.full_name} - ${u.position || 'Nhân viên'}`, callback_data: `info_view_${u.id}` }]);

        keyboard.push([{ text: '🔙 Quay lại Menu', callback_data: 'user_dashboard' }]);

        bot.editMessageText('📇 *DANH SÁCH NHÂN SỰ*\n\nChọn một thành viên để xem thông tin chi tiết:', {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: keyboard }
        });
        bot.answerCallbackQuery(query.id);
        return true;
    }

    // Admin Dashboard -> Manage Personnel
    if (data === 'admin_manage_personnel') {
        if (userRole !== 'admin') {
            bot.answerCallbackQuery(query.id, { text: '❌ Bạn không có quyền thực hiện thao tác này.', show_alert: true });
            return true;
        }

        const isPrivate = query.message?.chat.type === 'private';
        if (!isPrivate) {
            bot.answerCallbackQuery(query.id, { text: 'Vui lòng vào chat riêng với bot để quản lý nhân sự.', show_alert: true });
            return true;
        }

        const users = await db.query("SELECT id, full_name, position, email FROM user_profiles WHERE status = 'active' ORDER BY full_name ASC");
        const keyboard = users.rows.map(u => [{ text: `👤 ${u.full_name} - ${u.position || 'Nhân viên'}`, callback_data: `info_admin_view_${u.id}` }]);

        keyboard.push([{ text: '➕ Thêm Nhân sự mới', callback_data: 'info_add_new' }]);
        keyboard.push([{ text: '🔙 Quay lại Bảng điều khiển', callback_data: 'admin_dashboard' }]);

        bot.editMessageText('📇 *QUẢN LÝ NHÂN SỰ*\n\nChọn nhân sự để xem/sửa thông tin hoặc thêm mới:', {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: keyboard }
        });
        bot.answerCallbackQuery(query.id);
        return true;
    }

    // View Info (User & Admin)
    if (data.startsWith('info_view_') || data.startsWith('info_admin_view_')) {
        const isAdminView = data.startsWith('info_admin_view_');
        const profileId = data.split('_')[isAdminView ? 3 : 2];

        const res = await db.query('SELECT * FROM user_profiles WHERE id = $1', [profileId]);
        if (res.rows.length === 0) {
            bot.answerCallbackQuery(query.id, { text: '❌ Không tìm thấy thông tin nhân sự.', show_alert: true });
            return true;
        }

        const profile = res.rows[0];
        const text = `📇 *THÔNG TIN NHÂN SỰ*\n\n` +
            `👤 *Họ và tên:* ${profile.full_name}\n` +
            `🎂 *Sinh nhật:* ${profile.birthday || 'Chưa cập nhật'}\n` +
            `💼 *Vị trí:* ${profile.position || 'Chưa cập nhật'}\n` +
            `📱 *Số điện thoại:* ${profile.phone || 'Chưa cập nhật'}\n` +
            `📧 *Email:* ${profile.email || 'Chưa cập nhật'}`;

        const keyboard = [];

        const isPrivate = query.message?.chat.type === 'private';

        if (isAdminView && userRole === 'admin' && isPrivate) {
            keyboard.push([
                { text: '📝 Sửa thông tin', callback_data: `info_edit_${profile.id}` },
                { text: '❌ Xóa/Nghỉ việc', callback_data: `info_delete_${profile.id}` }
            ]);
            keyboard.push([{ text: '🔙 Quay lại', callback_data: 'admin_manage_personnel' }]);
        } else if (!isPrivate) {
            const row: any[] = [{ text: '🗑 Đóng', callback_data: 'reg_close_temp' }];
            if (userRole === 'admin') {
                row.push({ text: '📝 Sửa', url: `https://t.me/${botUsername}?start=editinfo_${profile.id}` });
            }
            keyboard.push(row);
        }

        if (isAdminView && isPrivate) {
            bot.editMessageText(text, {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: keyboard }
            });
        } else {
            bot.sendMessage(chatId, text, {
                message_thread_id: query.message?.message_thread_id,
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: keyboard }
            }).then(m => setTimeout(() => bot.deleteMessage(chatId, m.message_id).catch(() => { }), 60000));
        }
        bot.answerCallbackQuery(query.id);
        return true;
    }

    // Add New Personnel
    if (data === 'info_add_new') {
        if (userRole !== 'admin') { bot.answerCallbackQuery(query.id, { text: '❌ Bạn không có quyền.', show_alert: true }); return true; }

        bot.deleteMessage(chatId, messageId).catch(() => { });
        bot.sendMessage(chatId, '📇 *THÊM NHÂN SỰ MỚI*\n\nVui lòng nhập Họ và Tên của nhân sự:\n(/cancel để hủy)', { message_thread_id: query.message?.message_thread_id, parse_mode: 'Markdown' })
            .then(m => {
                updateSession(userId, { state: 'adding_personnel_name', tempData: { promptMessageId: m.message_id } });
            });
        bot.answerCallbackQuery(query.id);
        return true;
    }

    // Edit Personnel
    if (data.startsWith('info_edit_') && !data.startsWith('info_edit_field_') && !data.startsWith('info_edit_cancel_')) {
        if (userRole !== 'admin') { bot.answerCallbackQuery(query.id, { text: '❌ Bạn không có quyền.', show_alert: true }); return true; }
        const profileId = data.split('_')[2];

        const res = await db.query('SELECT * FROM user_profiles WHERE id = $1', [profileId]);
        if (res.rows.length === 0) return true;
        const profile = res.rows[0];

        bot.deleteMessage(chatId, messageId).catch(() => { });

        const textMsg = `📝 **SỬA THÔNG TIN NHÂN SỰ**\n\n` +
            `*Họ và Tên:* ${profile.full_name}\n` +
            `*Sinh nhật:* ${profile.birthday || 'Trống'}\n` +
            `*Vị trí:* ${profile.position || 'Trống'}\n` +
            `*Số điện thoại:* ${profile.phone || 'Trống'}\n` +
            `*Email:* ${profile.email || 'Trống'}\n\n` +
            `Vui lòng chọn phần muốn sửa:`;

        const keyboard = {
            inline_keyboard: [
                [{ text: '✏️ Sửa Họ và Tên', callback_data: `info_edit_field_name_${profileId}` }],
                [{ text: '✏️ Sửa Sinh nhật', callback_data: `info_edit_field_birthday_${profileId}` }],
                [{ text: '✏️ Sửa Vị trí', callback_data: `info_edit_field_position_${profileId}` }],
                [{ text: '✏️ Sửa Số điện thoại', callback_data: `info_edit_field_phone_${profileId}` }],
                [{ text: '✏️ Sửa Email', callback_data: `info_edit_field_email_${profileId}` }],
                [{ text: '❌ Hủy', callback_data: `info_edit_cancel_${profileId}` }]
            ]
        };

        bot.sendMessage(chatId, textMsg, { message_thread_id: query.message?.message_thread_id, parse_mode: 'Markdown', reply_markup: keyboard });
        bot.answerCallbackQuery(query.id);
        return true;
    }

    if (data.startsWith('info_edit_field_')) {
        const parts = data.split('_');
        const field = parts[3];
        const id = parts[4];
        const session = getSession(userId) || { state: 'idle', tempData: {} };

        let promptText = '';
        let state = '';
        if (field === 'name') { promptText = '📝 Vui lòng nhập *Họ và Tên* mới:'; state = 'editing_personnel_name'; }
        if (field === 'birthday') { promptText = '🎂 Vui lòng nhập *Sinh nhật* mới (VD: 01/01/1990):'; state = 'editing_personnel_birthday'; }
        if (field === 'position') { promptText = '💼 Vui lòng nhập *Vị trí/Chức vụ* mới:'; state = 'editing_personnel_position'; }
        if (field === 'phone') { promptText = '📞 Vui lòng nhập *Số điện thoại* mới:'; state = 'editing_personnel_phone'; }
        if (field === 'email') { promptText = '📧 Vui lòng nhập *Email* mới:'; state = 'editing_personnel_email'; }

        bot.sendMessage(chatId, promptText, { message_thread_id: query.message?.message_thread_id, parse_mode: 'Markdown' }).then(m => {
            updateSession(userId, {
                state: state as any,
                tempData: { ...(session.tempData || {}), profileId: parseInt(id), promptMessageId: m.message_id, viewMessageId: messageId }
            });
        });
        bot.answerCallbackQuery(query.id);
        return true;
    }

    if (data.startsWith('info_edit_cancel_')) {
        bot.deleteMessage(chatId, messageId).catch(() => { });
        bot.sendMessage(chatId, '✅ Đã hủy chỉnh sửa thông tin nhân sự.', {
            message_thread_id: query.message?.message_thread_id,
            reply_markup: { inline_keyboard: [[{ text: '🔙 Quay lại Quản lý Nhân sự', callback_data: 'admin_manage_personnel' }]] }
        });
        clearSession(userId);
        bot.answerCallbackQuery(query.id);
        return true;
    }

    // Delete Personnel
    if (data.startsWith('info_delete_')) {
        if (userRole !== 'admin') { bot.answerCallbackQuery(query.id, { text: '❌ Bạn không có quyền.', show_alert: true }); return true; }
        const profileId = data.split('_')[2];

        bot.editMessageText('⚠️ Bạn có chắc chắn muốn xóa/đánh dấu nghỉ việc nhân sự này không?', {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: {
                inline_keyboard: [
                    [{ text: '✅ Có, xóa', callback_data: `info_confirm_delete_${profileId}` }],
                    [{ text: '❌ Hủy', callback_data: `info_admin_view_${profileId}` }]
                ]
            }
        });
        bot.answerCallbackQuery(query.id);
        return true;
    }

    if (data.startsWith('info_confirm_delete_')) {
        if (userRole !== 'admin') { bot.answerCallbackQuery(query.id, { text: '❌ Bạn không có quyền.', show_alert: true }); return true; }
        const profileId = data.split('_')[3];

        await db.query("UPDATE user_profiles SET status = 'inactive' WHERE id = $1", [profileId]);
        bot.answerCallbackQuery(query.id, { text: '✅ Đã xóa nhân sự thành công.', show_alert: true });

        // Refresh topics
        refreshAllInfoTopics(bot);
        broadcastPersonnelUpdate(bot);

        // Go back to list
        const users = await db.query("SELECT id, full_name, position, email FROM user_profiles WHERE status = 'active' ORDER BY full_name ASC");
        const keyboard = users.rows.map(u => [{ text: `👤 ${u.full_name} - ${u.position || 'Nhân viên'}`, callback_data: `info_admin_view_${u.id}` }]);
        keyboard.push([{ text: '➕ Thêm Nhân sự mới', callback_data: 'info_add_new' }]);
        keyboard.push([{ text: '🔙 Quay lại Bảng điều khiển', callback_data: 'admin_dashboard' }]);

        bot.editMessageText('📇 *QUẢN LÝ NHÂN SỰ*\n\nChọn nhân sự để xem/sửa thông tin hoặc thêm mới:', {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: keyboard }
        });
        return true;
    }

    return false;
}

export async function handleInfoDeepLink(
    bot: TelegramBot,
    msg: TelegramBot.Message,
    param: string,
    userRole: string,
    session: any
): Promise<boolean> {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;

    if (!userId) return false;

    if (param.startsWith('editinfo_') && userRole === 'admin') {
        const profileId = param.split('_')[1];
        const res = await db.query('SELECT * FROM user_profiles WHERE id = $1', [profileId]);
        if (res.rows.length > 0) {
            const profile = res.rows[0];
            const textMsg = `📝 **SỬA THÔNG TIN NHÂN SỰ**\n\n` +
                `*Họ và Tên:* ${profile.full_name}\n` +
                `*Sinh nhật:* ${profile.birthday || 'Trống'}\n` +
                `*Vị trí:* ${profile.position || 'Trống'}\n` +
                `*Số điện thoại:* ${profile.phone || 'Trống'}\n` +
                `*Email:* ${profile.email || 'Trống'}\n\n` +
                `Vui lòng chọn phần muốn sửa:`;

            const keyboard = {
                inline_keyboard: [
                    [{ text: '✏️ Sửa Họ và Tên', callback_data: `info_edit_field_name_${profileId}` }],
                    [{ text: '✏️ Sửa Sinh nhật', callback_data: `info_edit_field_birthday_${profileId}` }],
                    [{ text: '✏️ Sửa Vị trí', callback_data: `info_edit_field_position_${profileId}` }],
                    [{ text: '✏️ Sửa Số điện thoại', callback_data: `info_edit_field_phone_${profileId}` }],
                    [{ text: '✏️ Sửa Email', callback_data: `info_edit_field_email_${profileId}` }],
                    [{ text: '❌ Hủy', callback_data: `info_edit_cancel_${profileId}` }]
                ]
            };

            bot.sendMessage(chatId, textMsg, { message_thread_id: msg.message_thread_id, parse_mode: 'Markdown', reply_markup: keyboard });
        } else {
            bot.sendMessage(chatId, '❌ Không tìm thấy thông tin nhân sự.', { message_thread_id: msg.message_thread_id });
        }
        return true;
    }

    return false;
}

export async function handleInfoMessage(
    bot: TelegramBot,
    msg: TelegramBot.Message,
    state: string,
    userId: number
): Promise<boolean> {
    const chatId = msg.chat.id;
    const text = msg.text || '';
    const session = getSession(userId);
    if (!session || !session.tempData) return false;

    const { tempData } = session;

    if (text === '/cancel') {
        if (tempData.promptMessageId) bot.deleteMessage(chatId, tempData.promptMessageId).catch(() => { });
        bot.deleteMessage(chatId, msg.message_id).catch(() => { });
        bot.sendMessage(chatId, '✅ Đã hủy thao tác.', {
            message_thread_id: msg.message_thread_id,
            reply_markup: { inline_keyboard: [[{ text: '🔙 Quay lại Quản lý Nhân sự', callback_data: 'admin_manage_personnel' }]] }
        });
        clearSession(userId);
        return true;
    }

    // ADDING FLOW
    if (state === 'adding_personnel_name') {
        if (tempData.promptMessageId) bot.deleteMessage(chatId, tempData.promptMessageId).catch(() => { });
        bot.deleteMessage(chatId, msg.message_id).catch(() => { });

        if (text.length < 2 || text.length > 100) {
            bot.sendMessage(chatId, '⚠️ Họ và Tên phải từ 2 đến 100 ký tự. Vui lòng nhập lại:', { message_thread_id: msg.message_thread_id, parse_mode: 'Markdown' })
                .then(m => {
                    updateSession(userId, { state: 'adding_personnel_name', tempData: { ...tempData, promptMessageId: m.message_id } });
                });
            return true;
        }

        tempData.full_name = text;
        bot.sendMessage(chatId, `Họ và Tên: *${text}*\n\nVui lòng nhập Sinh nhật (VD: 01/01/1990):\n(/cancel để hủy)`, { message_thread_id: msg.message_thread_id, parse_mode: 'Markdown' })
            .then(m => {
                updateSession(userId, { state: 'adding_personnel_birthday', tempData: { ...tempData, promptMessageId: m.message_id } });
            });
        return true;
    }

    if (state === 'adding_personnel_birthday') {
        if (tempData.promptMessageId) bot.deleteMessage(chatId, tempData.promptMessageId).catch(() => { });
        bot.deleteMessage(chatId, msg.message_id).catch(() => { });

        if (!/^(\d{2}\/\d{2}\/\d{4})$/.test(text)) {
            bot.sendMessage(chatId, '⚠️ Sinh nhật không đúng định dạng. Vui lòng nhập lại (VD: 01/01/1990):\n(/cancel để hủy)', { message_thread_id: msg.message_thread_id, parse_mode: 'Markdown' })
                .then(m => {
                    updateSession(userId, { state: 'adding_personnel_birthday', tempData: { ...tempData, promptMessageId: m.message_id } });
                });
            return true;
        }

        tempData.birthday = text;
        bot.sendMessage(chatId, `Sinh nhật: *${tempData.birthday}*\n\nVui lòng nhập Vị trí/Chức vụ:\n(/cancel để hủy)`, { message_thread_id: msg.message_thread_id, parse_mode: 'Markdown' })
            .then(m => {
                updateSession(userId, { state: 'adding_personnel_position', tempData: { ...tempData, promptMessageId: m.message_id } });
            });
        return true;
    }

    if (state === 'adding_personnel_position') {
        if (tempData.promptMessageId) bot.deleteMessage(chatId, tempData.promptMessageId).catch(() => { });
        bot.deleteMessage(chatId, msg.message_id).catch(() => { });

        if (text.length > 100 || text.length < 2) {
            bot.sendMessage(chatId, '⚠️ Vị trí/Chức vụ phải từ 2 đến 100 ký tự. Vui lòng nhập lại:\n(/cancel để hủy)', { message_thread_id: msg.message_thread_id, parse_mode: 'Markdown' })
                .then(m => {
                    updateSession(userId, { state: 'adding_personnel_position', tempData: { ...tempData, promptMessageId: m.message_id } });
                });
            return true;
        }

        tempData.position = text;
        bot.sendMessage(chatId, `Vị trí: *${tempData.position}*\n\nVui lòng nhập Số điện thoại:\n(/cancel để hủy)`, { message_thread_id: msg.message_thread_id, parse_mode: 'Markdown' })
            .then(m => {
                updateSession(userId, { state: 'adding_personnel_phone', tempData: { ...tempData, promptMessageId: m.message_id } });
            });
        return true;
    }

    if (state === 'adding_personnel_phone') {
        if (tempData.promptMessageId) bot.deleteMessage(chatId, tempData.promptMessageId).catch(() => { });
        bot.deleteMessage(chatId, msg.message_id).catch(() => { });

        if (!/^(\+?\d{9,15})$/.test(text.replace(/\s+/g, ''))) {
            bot.sendMessage(chatId, '⚠️ Số điện thoại không hợp lệ. Vui lòng nhập lại:\n(/cancel để hủy)', { message_thread_id: msg.message_thread_id, parse_mode: 'Markdown' })
                .then(m => {
                    updateSession(userId, { state: 'adding_personnel_phone', tempData: { ...tempData, promptMessageId: m.message_id } });
                });
            return true;
        }

        tempData.phone = text;
        bot.sendMessage(chatId, `Số điện thoại: *${tempData.phone}*\n\nVui lòng nhập Email:\n(/cancel để hủy, /skip để bỏ qua)`, { message_thread_id: msg.message_thread_id, parse_mode: 'Markdown' })
            .then(m => {
                updateSession(userId, { state: 'adding_personnel_email', tempData: { ...tempData, promptMessageId: m.message_id } });
            });
        return true;
    }

    if (state === 'adding_personnel_email') {
        if (tempData.promptMessageId) bot.deleteMessage(chatId, tempData.promptMessageId).catch(() => { });
        bot.deleteMessage(chatId, msg.message_id).catch(() => { });

        if (text !== '/skip') {
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) {
                bot.sendMessage(chatId, '⚠️ Email không hợp lệ. Vui lòng nhập lại:\n(/cancel để hủy, /skip để bỏ qua)', { message_thread_id: msg.message_thread_id, parse_mode: 'Markdown' })
                    .then(m => {
                        updateSession(userId, { state: 'adding_personnel_email', tempData: { ...tempData, promptMessageId: m.message_id } });
                    });
                return true;
            }
            tempData.email = text;
        } else {
            tempData.email = null;
        }

        // Save to DB
        try {
            await db.query(
                'INSERT INTO user_profiles (full_name, birthday, position, phone, email, status) VALUES ($1, $2, $3, $4, $5, $6)',
                [tempData.full_name, tempData.birthday, tempData.position, tempData.phone, tempData.email, 'active']
            );

            bot.sendMessage(chatId, '✅ Đã thêm nhân sự thành công!', {
                message_thread_id: msg.message_thread_id,
                reply_markup: { inline_keyboard: [[{ text: '🔙 Quay lại Quản lý Nhân sự', callback_data: 'admin_manage_personnel' }]] }
            });
            clearSession(userId);
            refreshAllInfoTopics(bot);
            broadcastPersonnelUpdate(bot);
        } catch (err) {
            console.error(err);
            bot.sendMessage(chatId, '❌ Có lỗi xảy ra khi lưu dữ liệu.', { message_thread_id: msg.message_thread_id });
            clearSession(userId);
        }
        return true;
    }

    // EDITING FLOW
    if (state.startsWith('editing_personnel_')) {
        if (!tempData.profileId) {
            bot.sendMessage(chatId, '❌ Phiên làm việc đã hết hạn hoặc bị lỗi. Vui lòng thử lại.', { message_thread_id: msg.message_thread_id });
            clearSession(userId);
            return true;
        }
    }

    if (state === 'editing_personnel_name' || state === 'editing_personnel_birthday' || state === 'editing_personnel_position' || state === 'editing_personnel_phone' || state === 'editing_personnel_email') {
        if (tempData.promptMessageId) bot.deleteMessage(chatId, tempData.promptMessageId).catch(() => { });
        bot.deleteMessage(chatId, msg.message_id).catch(() => { });

        let updateQuery = '';
        let updateValue = text;

        if (state === 'editing_personnel_name') {
            if (text.length < 2 || text.length > 100) {
                bot.sendMessage(chatId, '⚠️ Họ và Tên phải từ 2 đến 100 ký tự. Vui lòng nhập lại:', { message_thread_id: msg.message_thread_id }).then(m => {
                    updateSession(userId, { state: 'editing_personnel_name', tempData: { ...tempData, promptMessageId: m.message_id } });
                });
                return true;
            }
            updateQuery = 'UPDATE user_profiles SET full_name = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2';
        } else if (state === 'editing_personnel_birthday') {
            if (!/^(\d{2}\/\d{2}\/\d{4})$/.test(text)) {
                bot.sendMessage(chatId, '⚠️ Sinh nhật không đúng định dạng. Vui lòng nhập lại (VD: 01/01/1990):', { message_thread_id: msg.message_thread_id }).then(m => {
                    updateSession(userId, { state: 'editing_personnel_birthday', tempData: { ...tempData, promptMessageId: m.message_id } });
                });
                return true;
            }
            updateQuery = 'UPDATE user_profiles SET birthday = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2';
        } else if (state === 'editing_personnel_position') {
            if (text.length > 100) {
                bot.sendMessage(chatId, '⚠️ Vị trí/Chức vụ không được vượt quá 100 ký tự. Vui lòng nhập lại:', { message_thread_id: msg.message_thread_id }).then(m => {
                    updateSession(userId, { state: 'editing_personnel_position', tempData: { ...tempData, promptMessageId: m.message_id } });
                });
                return true;
            }
            updateQuery = 'UPDATE user_profiles SET position = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2';
        } else if (state === 'editing_personnel_phone') {
            if (!/^(\+?\d{9,15})$/.test(text.replace(/\s+/g, ''))) {
                bot.sendMessage(chatId, '⚠️ Số điện thoại không hợp lệ. Vui lòng nhập lại:', {
                    message_thread_id: msg.message_thread_id,
                    reply_markup: { inline_keyboard: [[{ text: '❌ Hủy', callback_data: `info_edit_cancel_${tempData.profileId}` }]] }
                }).then(m => {
                    updateSession(userId, { state: 'editing_personnel_phone', tempData: { ...tempData, promptMessageId: m.message_id } });
                });
                return true;
            }
            updateQuery = 'UPDATE user_profiles SET phone = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2';
        } else if (state === 'editing_personnel_email') {
            if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(text)) {
                bot.sendMessage(chatId, '⚠️ Email không hợp lệ. Vui lòng nhập lại:', {
                    message_thread_id: msg.message_thread_id,
                    reply_markup: { inline_keyboard: [[{ text: '❌ Hủy', callback_data: `info_edit_cancel_${tempData.profileId}` }]] }
                }).then(m => {
                    updateSession(userId, { state: 'editing_personnel_email', tempData: { ...tempData, promptMessageId: m.message_id } });
                });
                return true;
            }
            updateQuery = 'UPDATE user_profiles SET email = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2';
        }

        try {
            await db.query(updateQuery, [updateValue, tempData.profileId]);

            bot.sendMessage(chatId, '✅ Đã cập nhật thông tin nhân sự thành công!', { message_thread_id: msg.message_thread_id }).then(m => {
                setTimeout(() => bot.deleteMessage(chatId, m.message_id).catch(() => { }), 3000);
            });

            if (tempData.viewMessageId) bot.deleteMessage(chatId, tempData.viewMessageId).catch(() => { });

            const res = await db.query('SELECT * FROM user_profiles WHERE id = $1', [tempData.profileId]);
            if (res.rows.length > 0) {
                const profile = res.rows[0];
                const textMsg = `📝 **SỬA THÔNG TIN NHÂN SỰ**\n\n` +
                    `*Họ và Tên:* ${profile.full_name}\n` +
                    `*Sinh nhật:* ${profile.birthday || 'Trống'}\n` +
                    `*Vị trí:* ${profile.position || 'Trống'}\n` +
                    `*Số điện thoại:* ${profile.phone || 'Trống'}\n` +
                    `*Email:* ${profile.email || 'Trống'}\n\n` +
                    `Vui lòng chọn phần muốn sửa:`;

                const keyboard = {
                    inline_keyboard: [
                        [{ text: '✏️ Sửa Họ và Tên', callback_data: `info_edit_field_name_${profile.id}` }],
                        [{ text: '✏️ Sửa Sinh nhật', callback_data: `info_edit_field_birthday_${profile.id}` }],
                        [{ text: '✏️ Sửa Vị trí', callback_data: `info_edit_field_position_${profile.id}` }],
                        [{ text: '✏️ Sửa Số điện thoại', callback_data: `info_edit_field_phone_${profile.id}` }],
                        [{ text: '✏️ Sửa Email', callback_data: `info_edit_field_email_${profile.id}` }],
                        [{ text: '❌ Đóng', callback_data: `info_close_message` }]
                    ]
                };

                bot.sendMessage(chatId, textMsg, { message_thread_id: msg.message_thread_id, parse_mode: 'Markdown', reply_markup: keyboard }).then(m => {
                    setTimeout(() => bot.deleteMessage(chatId, m.message_id).catch(() => { }), 15000);
                });
            }

            refreshAllInfoTopics(bot);
            broadcastPersonnelUpdate(bot);
        } catch (err) {
            console.error(err);
            bot.sendMessage(chatId, '❌ Có lỗi xảy ra khi lưu dữ liệu.', { message_thread_id: msg.message_thread_id });
        }
        clearSession(userId);
        return true;
    }

    return false;
}
