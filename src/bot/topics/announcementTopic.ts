import TelegramBot, { InlineKeyboardButton } from 'node-telegram-bot-api';
import { db } from '../../db';
import { updateSession, clearSession, getSession } from '../services/sessionManager';
import { botUsername } from '../botInstance';
import { sendAnnouncementDashboard } from './topicManager';

export async function handleAnnouncementDeepLink(
    bot: TelegramBot,
    msg: TelegramBot.Message,
    param: string,
    userRole: string,
    session: any
): Promise<boolean> {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;

    if (!userId) return false;

    if (param === 'create_announcement') {
        if (userRole !== 'admin') {
            bot.sendMessage(chatId, '❌ Chỉ Admin mới có quyền tạo thông báo.').then(m => setTimeout(() => bot.deleteMessage(chatId, m.message_id).catch(() => { }), 15000));
            return true;
        }

        const prompt = await bot.sendMessage(chatId, '📢 *TẠO THÔNG BÁO MỚI*\n\nBước 1: Nhập **Tiêu đề** của thông báo (ví dụ: Thông báo nghỉ lễ 30/4):\n\n_(Gõ /cancel để hủy)_', { parse_mode: 'Markdown' });
        updateSession(userId, { state: 'creating_announcement_step_1', tempData: { promptMessageId: prompt.message_id } });
        return true;
    }

    if (param.startsWith('edit_announcement_')) {
        if (userRole !== 'admin') {
            bot.sendMessage(chatId, '❌ Chỉ Admin mới có quyền sửa thông báo.').then(m => setTimeout(() => bot.deleteMessage(chatId, m.message_id).catch(() => { }), 15000));
            return true;
        }

        const id = param.split('_')[2];
        const res = await db.query('SELECT * FROM announcements WHERE id = $1', [id]);
        if (res.rows.length === 0) {
            bot.sendMessage(chatId, '❌ Không tìm thấy thông báo.').then(m => setTimeout(() => bot.deleteMessage(chatId, m.message_id).catch(() => { }), 15000));
            return true;
        }

        const ann = res.rows[0];
        const prompt = await bot.sendMessage(chatId, `📢 *SỬA THÔNG BÁO*\n\nĐang sửa thông báo: *${ann.title}*\n\nBước 1: Nhập **Tiêu đề mới** (hoặc gõ /skip để giữ nguyên):\n\n_(Gõ /cancel để hủy)_`, { parse_mode: 'Markdown' });
        updateSession(userId, { state: 'editing_announcement_step_1', tempData: { id, title: ann.title, content: ann.content, scheduledAt: ann.scheduled_at, promptMessageId: prompt.message_id } });
        return true;
    }

    return false;
}

async function saveNewAnnouncement(bot: TelegramBot, chatId: number, userId: number, session: any, scheduledAt: Date | null) {
    const { title, content, eventStartTime, eventEndTime } = session.tempData;

    try {
        await db.query(
            'INSERT INTO announcements (title, content, event_start_time, event_end_time, scheduled_at, created_by, status) VALUES ($1, $2, $3, $4, $5, $6, $7)',
            [title, content, eventStartTime, eventEndTime, scheduledAt, userId, scheduledAt ? 'scheduled' : 'published']
        );

        bot.sendMessage(chatId, `✅ Đã tạo thông báo thành công!\n\nTiêu đề: ${title}\nTrạng thái: ${scheduledAt ? `Đã lên lịch vào ${scheduledAt.toLocaleString('vi-VN')}` : 'Đã gửi ngay'}`);

        if (!scheduledAt) {
            const topicsRes = await db.query("SELECT chat_id, topic_id FROM topics WHERE feature_type = 'announcement'");

            let timeText = '';
            if (eventStartTime && eventEndTime) {
                timeText = `\n⏰ *Thời gian:* ${eventStartTime.toLocaleString('vi-VN')} - ${eventEndTime.toLocaleString('vi-VN')}\n`;
            } else if (eventStartTime) {
                timeText = `\n⏰ *Bắt đầu:* ${eventStartTime.toLocaleString('vi-VN')}\n`;
            } else if (eventEndTime) {
                timeText = `\n⏰ *Kết thúc:* ${eventEndTime.toLocaleString('vi-VN')}\n`;
            }

            const msgText = `📢 *THÔNG BÁO*\n\n*${title}*${timeText}\n${content}`;

            for (const topic of topicsRes.rows) {
                try {
                    await bot.sendMessage(topic.chat_id, msgText, {
                        message_thread_id: topic.topic_id || undefined,
                        parse_mode: 'Markdown'
                    });
                } catch (err) {
                    console.error(`Failed to broadcast announcement to ${topic.chat_id}/${topic.topic_id}:`, err);
                }
            }
        }
    } catch (err) {
        console.error('Error creating announcement:', err);
        bot.sendMessage(chatId, '❌ Có lỗi xảy ra khi lưu thông báo.');
    }

    clearSession(userId);
}

async function updateAnnouncement(bot: TelegramBot, chatId: number, userId: number, session: any, scheduledAt: Date | null) {
    const { id, title, content, eventStartTime, eventEndTime } = session.tempData;

    try {
        await db.query(
            'UPDATE announcements SET title = $1, content = $2, event_start_time = $3, event_end_time = $4, scheduled_at = $5, status = $6 WHERE id = $7',
            [title, content, eventStartTime, eventEndTime, scheduledAt, scheduledAt ? 'scheduled' : 'published', id]
        );

        bot.sendMessage(chatId, `✅ Đã cập nhật thông báo thành công!\n\nTiêu đề: ${title}\nTrạng thái: ${scheduledAt ? `Đã lên lịch vào ${scheduledAt.toLocaleString('vi-VN')}` : 'Đã gửi ngay'}`);

        if (!scheduledAt) {
            const topicsRes = await db.query("SELECT chat_id, topic_id FROM topics WHERE feature_type = 'announcement'");

            let timeText = '';
            if (eventStartTime && eventEndTime) {
                timeText = `\n⏰ *Thời gian:* ${eventStartTime.toLocaleString('vi-VN')} - ${eventEndTime.toLocaleString('vi-VN')}\n`;
            } else if (eventStartTime) {
                timeText = `\n⏰ *Bắt đầu:* ${eventStartTime.toLocaleString('vi-VN')}\n`;
            } else if (eventEndTime) {
                timeText = `\n⏰ *Kết thúc:* ${eventEndTime.toLocaleString('vi-VN')}\n`;
            }

            const msgText = `📢 *THÔNG BÁO CẬP NHẬT*\n\n*${title}*${timeText}\n${content}`;

            for (const topic of topicsRes.rows) {
                try {
                    await bot.sendMessage(topic.chat_id, msgText, {
                        message_thread_id: topic.topic_id || undefined,
                        parse_mode: 'Markdown'
                    });
                } catch (err) {
                    console.error(`Failed to broadcast updated announcement to ${topic.chat_id}/${topic.topic_id}:`, err);
                }
            }
        }
    } catch (err) {
        console.error('Error updating announcement:', err);
        bot.sendMessage(chatId, '❌ Có lỗi xảy ra khi cập nhật thông báo.');
    }

    clearSession(userId);
}

export async function handleAnnouncementState(
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

    if (session.state === 'creating_announcement_step_1') {
        if (session.tempData.promptMessageId) bot.deleteMessage(chatId, session.tempData.promptMessageId).catch(() => { });
        bot.deleteMessage(chatId, msg.message_id).catch(() => { });

        const title = text;
        const prompt = await bot.sendMessage(chatId, `📢 *TẠO THÔNG BÁO MỚI*\n\nTiêu đề: *${title}*\n\nBước 2: Nhập **Nội dung chi tiết** của thông báo:\n\n_(Gõ /cancel để hủy)_`, { parse_mode: 'Markdown' });
        updateSession(userId, { state: 'creating_announcement_step_2', tempData: { ...session.tempData, title, promptMessageId: prompt.message_id } });
        return true;
    }

    if (session.state === 'creating_announcement_step_2') {
        if (session.tempData.promptMessageId) bot.deleteMessage(chatId, session.tempData.promptMessageId).catch(() => { });
        bot.deleteMessage(chatId, msg.message_id).catch(() => { });

        const content = text;
        const title = session.tempData.title;

        const prompt = await bot.sendMessage(chatId, `📢 *TẠO THÔNG BÁO MỚI*\n\nTiêu đề: *${title}*\n\nBước 3: Nhập **Thời gian bắt đầu sự kiện** (Định dạng: DD/MM/YYYY HH:mm, ví dụ: 30/04/2024 08:00):\n\n_(Gõ /skip nếu không có, hoặc /cancel để hủy)_`, { parse_mode: 'Markdown' });
        updateSession(userId, { state: 'creating_announcement_step_3', tempData: { ...session.tempData, content, promptMessageId: prompt.message_id } });
        return true;
    }

    if (session.state === 'creating_announcement_step_3') {
        if (session.tempData.promptMessageId) bot.deleteMessage(chatId, session.tempData.promptMessageId).catch(() => { });
        bot.deleteMessage(chatId, msg.message_id).catch(() => { });

        let eventStartTime: Date | null = null;
        if (command !== '/skip') {
            const parts = text.split(/[\s/:-]+/);
            if (parts.length >= 5) {
                eventStartTime = new Date(parseInt(parts[2]), parseInt(parts[1]) - 1, parseInt(parts[0]), parseInt(parts[3]), parseInt(parts[4]));
            }
            if (!eventStartTime || isNaN(eventStartTime.getTime())) {
                const prompt = await bot.sendMessage(chatId, '⚠️ Lỗi: Thời gian không hợp lệ. Vui lòng nhập lại (DD/MM/YYYY HH:mm) hoặc /skip:');
                updateSession(userId, { state: 'creating_announcement_step_3', tempData: { ...session.tempData, promptMessageId: prompt.message_id } });
                return true;
            }
        }

        const prompt = await bot.sendMessage(chatId, `📢 *TẠO THÔNG BÁO MỚI*\n\nBước 4: Nhập **Thời gian kết thúc sự kiện** (Định dạng: DD/MM/YYYY HH:mm):\n\n_(Gõ /skip nếu không có, hoặc /cancel để hủy)_`, { parse_mode: 'Markdown' });
        updateSession(userId, { state: 'creating_announcement_step_4', tempData: { ...session.tempData, eventStartTime, promptMessageId: prompt.message_id } });
        return true;
    }

    if (session.state === 'creating_announcement_step_4') {
        if (session.tempData.promptMessageId) bot.deleteMessage(chatId, session.tempData.promptMessageId).catch(() => { });
        bot.deleteMessage(chatId, msg.message_id).catch(() => { });

        let eventEndTime: Date | null = null;
        if (command !== '/skip') {
            const parts = text.split(/[\s/:-]+/);
            if (parts.length >= 5) {
                eventEndTime = new Date(parseInt(parts[2]), parseInt(parts[1]) - 1, parseInt(parts[0]), parseInt(parts[3]), parseInt(parts[4]));
            }
            if (!eventEndTime || isNaN(eventEndTime.getTime())) {
                const prompt = await bot.sendMessage(chatId, '⚠️ Lỗi: Thời gian không hợp lệ. Vui lòng nhập lại (DD/MM/YYYY HH:mm) hoặc /skip:');
                updateSession(userId, { state: 'creating_announcement_step_4', tempData: { ...session.tempData, promptMessageId: prompt.message_id } });
                return true;
            }
        }

        const keyboard = [
            [{ text: '🚀 Gửi ngay', callback_data: 'ann_create_send_now' }],
            [{ text: '📅 Đặt lịch hẹn', callback_data: 'ann_create_schedule' }],
            [{ text: '❌ Hủy', callback_data: 'ann_create_cancel' }]
        ];
        const prompt = await bot.sendMessage(chatId, `📢 *TẠO THÔNG BÁO MỚI*\n\nBước 5: Chọn phương thức gửi thông báo:`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } });
        updateSession(userId, { state: 'creating_announcement_step_5_options', tempData: { ...session.tempData, eventEndTime, promptMessageId: prompt.message_id } });
        return true;
    }

    if (session.state === 'creating_announcement_step_5') {
        if (session.tempData.promptMessageId) bot.deleteMessage(chatId, session.tempData.promptMessageId).catch(() => { });
        bot.deleteMessage(chatId, msg.message_id).catch(() => { });

        let scheduledAt: Date | null = null;
        const parts = text.split(/[\s/:-]+/);
        if (parts.length >= 5) {
            scheduledAt = new Date(parseInt(parts[2]), parseInt(parts[1]) - 1, parseInt(parts[0]), parseInt(parts[3]), parseInt(parts[4]));
        }
        if (!scheduledAt || isNaN(scheduledAt.getTime()) || scheduledAt <= new Date()) {
            const prompt = await bot.sendMessage(chatId, '⚠️ Lỗi: Thời gian không hợp lệ hoặc đã qua. Vui lòng nhập lại (DD/MM/YYYY HH:mm):');
            updateSession(userId, { state: 'creating_announcement_step_5', tempData: { ...session.tempData, promptMessageId: prompt.message_id } });
            return true;
        }

        await saveNewAnnouncement(bot, chatId, userId, session, scheduledAt);
        return true;
    }

    if (session.state === 'editing_announcement_step_1') {
        if (session.tempData.promptMessageId) bot.deleteMessage(chatId, session.tempData.promptMessageId).catch(() => { });
        bot.deleteMessage(chatId, msg.message_id).catch(() => { });

        const title = command === '/skip' ? session.tempData.title : text;
        const prompt = await bot.sendMessage(chatId, `📢 *SỬA THÔNG BÁO*\n\nTiêu đề: *${title}*\n\nBước 2: Nhập **Nội dung mới** (hoặc gõ /skip để giữ nguyên):\n\n_(Gõ /cancel để hủy)_`, { parse_mode: 'Markdown' });
        updateSession(userId, { state: 'editing_announcement_step_2', tempData: { ...session.tempData, title, promptMessageId: prompt.message_id } });
        return true;
    }

    if (session.state === 'editing_announcement_step_2') {
        if (session.tempData.promptMessageId) bot.deleteMessage(chatId, session.tempData.promptMessageId).catch(() => { });
        bot.deleteMessage(chatId, msg.message_id).catch(() => { });

        const content = command === '/skip' ? session.tempData.content : text;
        const title = session.tempData.title;

        const prompt = await bot.sendMessage(chatId, `📢 *SỬA THÔNG BÁO*\n\nTiêu đề: *${title}*\n\nBước 3: Nhập **Thời gian bắt đầu sự kiện mới** (Định dạng: DD/MM/YYYY HH:mm, ví dụ: 30/04/2024 08:00):\n\n_(Gõ /skip để giữ nguyên, /cancel để hủy)_`, { parse_mode: 'Markdown' });
        updateSession(userId, { state: 'editing_announcement_step_3', tempData: { ...session.tempData, content, promptMessageId: prompt.message_id } });
        return true;
    }

    if (session.state === 'editing_announcement_step_3') {
        if (session.tempData.promptMessageId) bot.deleteMessage(chatId, session.tempData.promptMessageId).catch(() => { });
        bot.deleteMessage(chatId, msg.message_id).catch(() => { });

        let eventStartTime: Date | null = session.tempData.eventStartTime;
        if (command !== '/skip') {
            const parts = text.split(/[\s/:-]+/);
            if (parts.length >= 5) {
                eventStartTime = new Date(parseInt(parts[2]), parseInt(parts[1]) - 1, parseInt(parts[0]), parseInt(parts[3]), parseInt(parts[4]));
            } else {
                eventStartTime = null;
            }
            if (eventStartTime && isNaN(eventStartTime.getTime())) {
                const prompt = await bot.sendMessage(chatId, '⚠️ Lỗi: Thời gian không hợp lệ. Vui lòng nhập lại (DD/MM/YYYY HH:mm) hoặc /skip:');
                updateSession(userId, { state: 'editing_announcement_step_3', tempData: { ...session.tempData, promptMessageId: prompt.message_id } });
                return true;
            }
        }

        const prompt = await bot.sendMessage(chatId, `📢 *SỬA THÔNG BÁO*\n\nBước 4: Nhập **Thời gian kết thúc sự kiện mới** (Định dạng: DD/MM/YYYY HH:mm):\n\n_(Gõ /skip để giữ nguyên, /cancel để hủy)_`, { parse_mode: 'Markdown' });
        updateSession(userId, { state: 'editing_announcement_step_4', tempData: { ...session.tempData, eventStartTime, promptMessageId: prompt.message_id } });
        return true;
    }

    if (session.state === 'editing_announcement_step_4') {
        if (session.tempData.promptMessageId) bot.deleteMessage(chatId, session.tempData.promptMessageId).catch(() => { });
        bot.deleteMessage(chatId, msg.message_id).catch(() => { });

        let eventEndTime: Date | null = session.tempData.eventEndTime;
        if (command !== '/skip') {
            const parts = text.split(/[\s/:-]+/);
            if (parts.length >= 5) {
                eventEndTime = new Date(parseInt(parts[2]), parseInt(parts[1]) - 1, parseInt(parts[0]), parseInt(parts[3]), parseInt(parts[4]));
            } else {
                eventEndTime = null;
            }
            if (eventEndTime && isNaN(eventEndTime.getTime())) {
                const prompt = await bot.sendMessage(chatId, '⚠️ Lỗi: Thời gian không hợp lệ. Vui lòng nhập lại (DD/MM/YYYY HH:mm) hoặc /skip:');
                updateSession(userId, { state: 'editing_announcement_step_4', tempData: { ...session.tempData, promptMessageId: prompt.message_id } });
                return true;
            }
        }

        const keyboard = [
            [{ text: '🚀 Gửi ngay', callback_data: 'ann_edit_send_now' }],
            [{ text: '📅 Đặt lịch hẹn', callback_data: 'ann_edit_schedule' }],
            [{ text: '⏭️ Giữ nguyên', callback_data: 'ann_edit_skip' }],
            [{ text: '❌ Hủy', callback_data: 'ann_edit_cancel' }]
        ];
        const prompt = await bot.sendMessage(chatId, `📢 *SỬA THÔNG BÁO*\n\nBước 5: Chọn phương thức gửi thông báo mới:`, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } });
        updateSession(userId, { state: 'editing_announcement_step_5_options', tempData: { ...session.tempData, eventEndTime, promptMessageId: prompt.message_id } });
        return true;
    }

    if (session.state === 'editing_announcement_step_5') {
        if (session.tempData.promptMessageId) bot.deleteMessage(chatId, session.tempData.promptMessageId).catch(() => { });
        bot.deleteMessage(chatId, msg.message_id).catch(() => { });

        let scheduledAt: Date | null = null;
        const parts = text.split(/[\s/:-]+/);
        if (parts.length >= 5) {
            scheduledAt = new Date(parseInt(parts[2]), parseInt(parts[1]) - 1, parseInt(parts[0]), parseInt(parts[3]), parseInt(parts[4]));
        }
        if (!scheduledAt || isNaN(scheduledAt.getTime()) || scheduledAt <= new Date()) {
            const prompt = await bot.sendMessage(chatId, '⚠️ Lỗi: Thời gian không hợp lệ hoặc đã qua. Vui lòng nhập lại (DD/MM/YYYY HH:mm):');
            updateSession(userId, { state: 'editing_announcement_step_5', tempData: { ...session.tempData, promptMessageId: prompt.message_id } });
            return true;
        }

        await updateAnnouncement(bot, chatId, userId, session, scheduledAt);
        return true;
    }

    return false;
}

export async function handleAnnouncementCallback(
    bot: TelegramBot,
    query: TelegramBot.CallbackQuery,
    data: string,
    userRole: string
): Promise<boolean> {
    const chatId = query.message?.chat.id;
    const messageId = query.message?.message_id;
    const userId = query.from.id;
    const topicId = query.message?.message_thread_id || 0;

    if (!chatId || !messageId) return false;

    if (data === 'ann_create_send_now') {
        const session = getSession(userId);
        if (session.state !== 'creating_announcement_step_5_options') return true;
        bot.deleteMessage(chatId, messageId).catch(() => { });
        await saveNewAnnouncement(bot, chatId, userId, session, null);
        bot.answerCallbackQuery(query.id);
        return true;
    }

    if (data === 'ann_create_schedule') {
        const session = getSession(userId);
        if (session.state !== 'creating_announcement_step_5_options') return true;
        const prompt = await bot.sendMessage(chatId, `📢 *TẠO THÔNG BÁO MỚI*\n\nNhập **Thời gian gửi thông báo** (Định dạng: DD/MM/YYYY HH:mm):\n\n_(Gõ /cancel để hủy)_`, { parse_mode: 'Markdown' });
        updateSession(userId, { state: 'creating_announcement_step_5', tempData: { ...session.tempData, promptMessageId: prompt.message_id } });
        bot.deleteMessage(chatId, messageId).catch(() => { });
        bot.answerCallbackQuery(query.id);
        return true;
    }

    if (data === 'ann_create_cancel') {
        const session = getSession(userId);
        if (session.state !== 'creating_announcement_step_5_options') return true;
        bot.deleteMessage(chatId, messageId).catch(() => { });
        bot.sendMessage(chatId, '❌ Đã hủy tạo thông báo.');
        clearSession(userId);
        bot.answerCallbackQuery(query.id);
        return true;
    }

    if (data === 'ann_edit_send_now') {
        const session = getSession(userId);
        if (session.state !== 'editing_announcement_step_5_options') return true;
        bot.deleteMessage(chatId, messageId).catch(() => { });
        await updateAnnouncement(bot, chatId, userId, session, null);
        bot.answerCallbackQuery(query.id);
        return true;
    }

    if (data === 'ann_edit_schedule') {
        const session = getSession(userId);
        if (session.state !== 'editing_announcement_step_5_options') return true;
        const prompt = await bot.sendMessage(chatId, `📢 *SỬA THÔNG BÁO*\n\nNhập **Thời gian gửi thông báo mới** (Định dạng: DD/MM/YYYY HH:mm):\n\n_(Gõ /cancel để hủy)_`, { parse_mode: 'Markdown' });
        updateSession(userId, { state: 'editing_announcement_step_5', tempData: { ...session.tempData, promptMessageId: prompt.message_id } });
        bot.deleteMessage(chatId, messageId).catch(() => { });
        bot.answerCallbackQuery(query.id);
        return true;
    }

    if (data === 'ann_edit_skip') {
        const session = getSession(userId);
        if (session.state !== 'editing_announcement_step_5_options') return true;
        bot.deleteMessage(chatId, messageId).catch(() => { });
        await updateAnnouncement(bot, chatId, userId, session, session.tempData.scheduledAt);
        bot.answerCallbackQuery(query.id);
        return true;
    }

    if (data === 'ann_edit_cancel') {
        const session = getSession(userId);
        if (session.state !== 'editing_announcement_step_5_options') return true;
        bot.deleteMessage(chatId, messageId).catch(() => { });
        bot.sendMessage(chatId, '❌ Đã hủy sửa thông báo.');
        clearSession(userId);
        bot.answerCallbackQuery(query.id);
        return true;
    }

    if (data === 'ann_reload') {
        const options = { message_thread_id: topicId || undefined };
        await sendAnnouncementDashboard(bot, chatId, topicId, userRole, options);
        bot.deleteMessage(chatId, messageId).catch(() => { });
        bot.answerCallbackQuery(query.id, { text: '🔄 Đã làm mới Thông báo.' });
        return true;
    }

    if (data === 'ann_admin_list') {
        if (userRole !== 'admin') return true;

        const res = await db.query('SELECT id, title, status, scheduled_at FROM announcements WHERE is_holiday = false ORDER BY created_at DESC LIMIT 10');

        let text = '📋 *DANH SÁCH THÔNG BÁO*\n\n';
        const keyboard: InlineKeyboardButton[][] = [];

        if (res.rows.length === 0) {
            text += 'Chưa có thông báo nào.';
        } else {
            res.rows.forEach(row => {
                const status = row.status === 'published' ? '✅' : (row.status === 'scheduled' ? '⏳' : '❌');
                const date = row.scheduled_at ? new Date(row.scheduled_at).toLocaleString('vi-VN') : 'Ngay lập tức';
                keyboard.push([{ text: `${status} ${row.title} (${date})`, callback_data: `ann_admin_view_${row.id}` }]);
            });
        }

        keyboard.push([{ text: '🔙 Quay lại Menu', callback_data: 'admin_manage_announcements' }]);

        bot.editMessageText(text, {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: keyboard }
        }).catch(console.error);
        bot.answerCallbackQuery(query.id);
        return true;
    }

    if (data === 'ann_admin_holiday_list') {
        if (userRole !== 'admin') return true;

        const res = await db.query('SELECT id, title, status, created_at FROM announcements WHERE is_holiday = true ORDER BY created_at DESC LIMIT 10');

        let text = '📅 *DANH SÁCH THÔNG BÁO LỄ TỰ ĐỘNG*\n\n';
        const keyboard: InlineKeyboardButton[][] = [];

        if (res.rows.length === 0) {
            text += 'Chưa có thông báo lễ nào được tự động tạo.';
        } else {
            res.rows.forEach(row => {
                const status = row.status === 'published' ? '✅' : '⏳';
                const date = new Date(row.created_at).toLocaleString('vi-VN');
                keyboard.push([{ text: `${status} ${row.title} (${date})`, callback_data: `ann_admin_view_${row.id}` }]);
            });
        }

        keyboard.push([{ text: '🔙 Quay lại Menu', callback_data: 'admin_manage_announcements' }]);

        bot.editMessageText(text, {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: keyboard }
        }).catch(console.error);
        bot.answerCallbackQuery(query.id);
        return true;
    }

    if (data.startsWith('ann_admin_view_')) {
        if (userRole !== 'admin') return true;
        const id = data.split('_')[3];

        const res = await db.query('SELECT * FROM announcements WHERE id = $1', [id]);
        if (res.rows.length === 0) {
            bot.answerCallbackQuery(query.id, { text: '❌ Không tìm thấy thông báo.', show_alert: true });
            return true;
        }

        const ann = res.rows[0];
        const status = ann.status === 'published' ? 'Đã gửi' : (ann.status === 'scheduled' ? 'Đã lên lịch' : 'Đã hủy');
        const date = ann.scheduled_at ? new Date(ann.scheduled_at).toLocaleString('vi-VN') : 'Ngay lập tức';

        let timeText = '';
        if (ann.event_start_time && ann.event_end_time) {
            timeText = `\n*Thời gian sự kiện:* ${new Date(ann.event_start_time).toLocaleString('vi-VN')} - ${new Date(ann.event_end_time).toLocaleString('vi-VN')}`;
        } else if (ann.event_start_time) {
            timeText = `\n*Bắt đầu sự kiện:* ${new Date(ann.event_start_time).toLocaleString('vi-VN')}`;
        } else if (ann.event_end_time) {
            timeText = `\n*Kết thúc sự kiện:* ${new Date(ann.event_end_time).toLocaleString('vi-VN')}`;
        }

        const text = `📢 *CHI TIẾT THÔNG BÁO*\n\n*Tiêu đề:* ${ann.title}\n*Trạng thái:* ${status}\n*Thời gian gửi:* ${date}${timeText}\n\n*Nội dung:*\n${ann.content}`;

        const isPrivate = query.message?.chat.type === 'private';
        const backCallback = isPrivate ? (ann.is_holiday ? 'ann_admin_holiday_list' : 'ann_admin_list') : 'ann_reload';

        const keyboard = [];
        if (!ann.is_holiday) {
            keyboard.push([{ text: '✏️ Sửa', url: `https://t.me/${botUsername}?start=edit_announcement_${id}` }, { text: '🗑 Xóa', callback_data: `ann_admin_delete_${id}` }]);
        }
        keyboard.push([{ text: '🔙 Quay lại', callback_data: backCallback }, { text: '❌ Đóng', callback_data: 'info_close_message' }]);

        bot.editMessageText(text, {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: keyboard }
        }).catch(console.error);
        bot.answerCallbackQuery(query.id);
        return true;
    }

    if (data === 'ann_user_list') {
        const res = await db.query("SELECT id, title, scheduled_at FROM announcements WHERE status = 'published' ORDER BY created_at DESC LIMIT 10");

        let text = '📢 *DANH SÁCH THÔNG BÁO*\n\n';
        const keyboard: InlineKeyboardButton[][] = [];

        if (res.rows.length === 0) {
            text += 'Hiện tại chưa có thông báo nào.';
        } else {
            res.rows.forEach(row => {
                const date = row.scheduled_at ? new Date(row.scheduled_at).toLocaleString('vi-VN') : 'Ngay lập tức';
                keyboard.push([{ text: `📌 ${row.title}`, callback_data: `ann_user_view_${row.id}` }]);
            });
        }

        keyboard.push([{ text: '🔙 Quay lại Menu', callback_data: 'user_dashboard' }]);

        bot.editMessageText(text, {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: keyboard }
        }).catch(console.error);
        bot.answerCallbackQuery(query.id);
        return true;
    }

    if (data.startsWith('ann_user_view_')) {
        const id = data.split('_')[3];

        const res = await db.query('SELECT * FROM announcements WHERE id = $1', [id]);
        if (res.rows.length === 0) {
            bot.answerCallbackQuery(query.id, { text: '❌ Không tìm thấy thông báo.', show_alert: true });
            return true;
        }

        const ann = res.rows[0];

        let timeText = '';
        if (ann.event_start_time && ann.event_end_time) {
            timeText = `\n*Thời gian:* ${new Date(ann.event_start_time).toLocaleString('vi-VN')} - ${new Date(ann.event_end_time).toLocaleString('vi-VN')}`;
        } else if (ann.event_start_time) {
            timeText = `\n*Bắt đầu:* ${new Date(ann.event_start_time).toLocaleString('vi-VN')}`;
        } else if (ann.event_end_time) {
            timeText = `\n*Kết thúc:* ${new Date(ann.event_end_time).toLocaleString('vi-VN')}`;
        }

        const text = `📢 *CHI TIẾT THÔNG BÁO*\n\n*Tiêu đề:* ${ann.title}${timeText}\n\n*Nội dung:*\n${ann.content}`;

        const keyboard = [
            [{ text: '🔙 Quay lại', callback_data: 'ann_user_list' }, { text: '❌ Đóng', callback_data: 'info_close_message' }]
        ];

        bot.editMessageText(text, {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: keyboard }
        }).catch(console.error);
        bot.answerCallbackQuery(query.id);
        return true;
    }

    if (data.startsWith('ann_admin_delete_')) {
        if (userRole !== 'admin') return true;
        const id = data.split('_')[3];

        await db.query('DELETE FROM announcements WHERE id = $1', [id]);

        bot.answerCallbackQuery(query.id, { text: '✅ Đã xóa thông báo.', show_alert: true });

        const isPrivate = query.message?.chat.type === 'private';
        if (isPrivate) {
            handleAnnouncementCallback(bot, query, 'ann_admin_list', userRole);
        } else {
            handleAnnouncementCallback(bot, query, 'ann_reload', userRole);
        }
        return true;
    }

    return false;
}
