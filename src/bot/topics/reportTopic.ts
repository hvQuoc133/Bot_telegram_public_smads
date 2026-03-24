import TelegramBot from 'node-telegram-bot-api';
import { db } from '../../db';
import { updateSession, clearSession, getSession } from '../services/sessionManager';
import { botUsername } from '../botInstance';
import { exportReportToZip, exportReportsToExcel } from '../utils/exportUtils';
import fs from 'fs';
import path from 'path';
import os from 'os';

export async function handleReportDeepLink(
    bot: TelegramBot,
    msg: TelegramBot.Message,
    param: string,
    userRole: string
): Promise<boolean> {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;

    if (!userId) return false;

    if (param.startsWith('create_report_')) {
        if (userRole === 'admin') {
            bot.sendMessage(chatId, '⚠️ Admin không thể gửi báo cáo cho chính mình. Vui lòng sử dụng tài khoản User để gửi báo cáo.');
            return true;
        }
        const parts = param.split('_');

        let reportType = 'daily';
        let targetChatId;
        let targetTopicId;

        if (parts[2] === 'daily' || parts[2] === 'project') {
            reportType = parts[2];
            targetChatId = parts[3];
            targetTopicId = parts[4];
        } else {
            // Fallback for old links
            targetChatId = parts[2];
            targetTopicId = parts[3];
        }

        if (!targetChatId) {
            bot.sendMessage(chatId, '❌ Lỗi: Không xác định được nhóm để gửi báo cáo. Vui lòng thử lại từ nhóm.');
            return true;
        }

        // Initialize report in DB
        const res = await db.query(
            'INSERT INTO reports (user_id, chat_id, topic_id, status, report_type) VALUES ($1, $2, $3, $4, $5) RETURNING id',
            [userId, targetChatId, targetTopicId, 'draft', reportType]
        );
        const reportId = res.rows[0].id;

        const typeText = reportType === 'project' ? 'DỰ ÁN' : 'CÔNG VIỆC HẰNG NGÀY';
        bot.sendMessage(chatId, `📝 *BẮT ĐẦU SOẠN BÁO CÁO ${typeText}*\n\nBước 1: Vui lòng nhập *Tiêu đề* ngắn gọn cho báo cáo của bạn (VD: Báo cáo tiến độ dự án A):`, { parse_mode: 'Markdown' })
            .then(m => {
                updateSession(userId, {
                    state: 'creating_report_step_title',
                    tempData: { reportId, targetChatId, targetTopicId, reportType, promptMessageId: m.message_id }
                });
            });
        return true;
    }

    if (param === 'my_reports') {
        if (userRole === 'admin') {
            bot.sendMessage(chatId, '⚠️ Admin không có lịch sử báo cáo cá nhân.');
            return true;
        }
        // Reuse the logic from rep_my_list callback
        const res = await db.query(
            'SELECT id, title, created_at FROM reports WHERE user_id = $1 AND status = $2 ORDER BY created_at DESC LIMIT 20',
            [userId, 'submitted']
        );

        if (res.rows.length === 0) {
            bot.sendMessage(chatId, '⚠️ Bạn chưa có báo cáo nào được gửi.');
            return true;
        }

        const keyboard = res.rows.map(r => [{
            text: `📄 ${r.title} (${new Date(r.created_at).toLocaleDateString('vi-VN')})`,
            callback_data: `rep_view_detail_${r.id}`
        }]);

        bot.sendMessage(chatId, '📋 *DANH SÁCH BÁO CÁO CỦA BẠN:*', {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: keyboard }
        }).then(m => setTimeout(() => bot.deleteMessage(chatId, m.message_id).catch(() => { }), 60000));
        return true;
    }

    return false;
}

export async function handleReportState(
    bot: TelegramBot,
    msg: TelegramBot.Message,
    session: any
): Promise<boolean> {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    const text = msg.text || '';

    if (!userId) return false;

    switch (session.state) {
        case 'creating_report_step_title':
            if (session.tempData.promptMessageId) bot.deleteMessage(chatId, session.tempData.promptMessageId).catch(() => { });
            bot.deleteMessage(chatId, msg.message_id).catch(() => { });
            await db.query('UPDATE reports SET title = $1 WHERE id = $2', [text, session.tempData.reportId]);
            bot.sendMessage(chatId, '✍️ *Bước 2: Nhập nội dung chi tiết*\n\nVui lòng nhập nội dung báo cáo của bạn:', { parse_mode: 'Markdown' })
                .then(m => {
                    updateSession(userId, { state: 'creating_report_step_content', tempData: { ...session.tempData, promptMessageId: m.message_id } });
                });
            return true;

        case 'creating_report_step_content':
            if (session.tempData.promptMessageId) bot.deleteMessage(chatId, session.tempData.promptMessageId).catch(() => { });
            bot.deleteMessage(chatId, msg.message_id).catch(() => { });
            await db.query('UPDATE reports SET content = $1 WHERE id = $2', [text, session.tempData.reportId]);
            const keyboard = [[{ text: '✅ Hoàn tất đính kèm & Xem trước', callback_data: `rep_preview_${session.tempData.reportId}` }]];
            bot.sendMessage(chatId, '📎 *Bước 3: Đính kèm (Tùy chọn)*\n\nBạn có thể gửi *Ảnh* hoặc *Tài liệu* đính kèm vào đây (gửi từng cái một).\n\nKhi nào xong, hãy bấm nút bên dưới để xem trước bản báo cáo.', {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: keyboard }
            }).then(m => {
                updateSession(userId, { state: 'creating_report_step_attachments', tempData: { ...session.tempData, promptMessageId: m.message_id } });
            });
            return true;

        case 'editing_report_announcement':
            if (session.tempData.promptMessageId) bot.deleteMessage(chatId, session.tempData.promptMessageId).catch(() => { });
            bot.deleteMessage(chatId, msg.message_id).catch(() => { });
            const topicId = session.tempData.topicId;
            await db.query('UPDATE topics SET custom_announcement = $1 WHERE id = $2', [text, topicId]);
            clearSession(userId);
            bot.sendMessage(chatId, '✅ Đã cập nhật thông báo ghim cho Topic Báo cáo thành công!').then(m => {
                setTimeout(() => bot.deleteMessage(chatId, m.message_id).catch(() => { }), 10000);
            });

            // Update the pinned message in the group
            const topicRes = await db.query('SELECT chat_id, topic_id, pinned_message_id FROM topics WHERE id = $1', [topicId]);
            if (topicRes.rows.length > 0) {
                const t = topicRes.rows[0];
                if (t.pinned_message_id) {
                    try {
                        // We need to re-render the dashboard message
                        // Since we don't have the full context here, we can just edit the text
                        // But it's better to call sendReportDashboard again, or just edit the text
                        const newText = `📊 *TOPIC BÁO CÁO*\n\n${text}\n\nVui lòng chọn chức năng bên dưới:`;

                        const keyboard = [
                            [{ text: '📝 Gửi báo cáo công việc hằng ngày', url: `https://t.me/${botUsername}?start=create_report_daily_${t.chat_id}_${t.topic_id || 0}` }],
                            [{ text: '📁 Gửi báo cáo dự án', url: `https://t.me/${botUsername}?start=create_report_project_${t.chat_id}_${t.topic_id || 0}` }],
                            [{ text: '📋 Lịch sử báo cáo của tôi', url: `https://t.me/${botUsername}?start=my_reports` }]
                        ];

                        // We don't know the exact user role of everyone seeing it, but the pinned message
                        // is usually just the base one. We can just update the text and keep the basic keyboard.
                        // Actually, sendReportDashboard sends a new message. Let's just edit the existing one.
                        await bot.editMessageText(newText, {
                            chat_id: t.chat_id,
                            message_id: t.pinned_message_id,
                            parse_mode: 'Markdown',
                            reply_markup: { inline_keyboard: keyboard }
                        });
                    } catch (e) {
                        console.error('Failed to update pinned message:', e);
                    }
                }
            }
            return true;

        case 'creating_report_step_attachments':
            // Do NOT delete the main prompt message with the "Complete" button here.
            // We only delete the user's message (the photo/document they sent) to keep the chat clean.
            bot.deleteMessage(chatId, msg.message_id).catch(() => { });

            if (msg.photo || msg.document) {
                const fileId = msg.photo ? msg.photo[msg.photo.length - 1].file_id : msg.document!.file_id;
                const fileType = msg.photo ? 'photo' : 'document';
                const fileUniqueId = msg.photo ? msg.photo[msg.photo.length - 1].file_unique_id : msg.document!.file_unique_id;

                await db.query(
                    'INSERT INTO report_attachments (report_id, file_id, file_type, file_unique_id) VALUES ($1, $2, $3, $4)',
                    [session.tempData.reportId, fileId, fileType, fileUniqueId]
                );

                // Send a temporary confirmation message that auto-deletes, instead of a new prompt
                bot.sendMessage(chatId, '✅ Đã nhận 1 đính kèm. Bạn có thể gửi thêm hoặc bấm nút "Hoàn tất" ở trên.')
                    .then(m => setTimeout(() => bot.deleteMessage(chatId, m.message_id).catch(() => { }), 5000));

                return true;
            }
            return false;
    }

    return false;
}

export async function handleReportCallback(
    bot: TelegramBot,
    query: TelegramBot.CallbackQuery,
    data: string,
    userRole: string,
    session: any
): Promise<boolean> {
    const chatId = query.message?.chat.id;
    const userId = query.from.id;
    const isPrivate = query.message?.chat.type === 'private';
    const messageId = query.message?.message_id;

    if (!chatId) return false;

    if (data === 'rep_team_stats') {
        if (userRole !== 'admin') {
            bot.answerCallbackQuery(query.id, { text: '❌ Chỉ Admin mới có quyền xem.', show_alert: true });
            return true;
        }

        const res = await db.query("SELECT COUNT(*) FROM reports WHERE status = 'submitted'");
        const count = res.rows[0].count;
        const text = `📊 *THỐNG KÊ TEAM*\n\nTổng số báo cáo đã nộp: ${count}\n\nChọn loại thống kê bạn muốn xem:`;

        const keyboard = [
            [{ text: '📅 Báo cáo hôm nay', callback_data: 'rep_admin_today' }],
            [{ text: '👤 Báo cáo theo tên', callback_data: 'rep_admin_by_user' }],
            [{ text: '📆 Báo cáo theo tháng', callback_data: 'rep_admin_by_month' }],
            [{ text: '🔙 Quay lại', callback_data: 'rep_admin_back_to_dashboard' }]
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

    if (data === 'rep_admin_back_to_dashboard') {
        if (userRole !== 'admin') {
            bot.answerCallbackQuery(query.id, { text: '❌ Chỉ Admin mới có quyền xem.', show_alert: true });
            return true;
        }
        const text = '📊 *QUẢN LÝ TOPIC BÁO CÁO*\n\nChào Admin, vui lòng chọn chức năng quản lý bên dưới:';
        const keyboard = [
            [{ text: '📋 Xem Thống kê Team', callback_data: 'rep_team_stats' }],
            [{ text: '📢 Chỉnh sửa Thông báo Ghim', callback_data: 'rep_admin_edit_announcement' }],
            [{ text: '⚙️ Hủy cài đặt Topic', callback_data: 'topic_unset_request' }]
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

    if (data === 'rep_create') {
        if (userRole === 'admin') {
            bot.answerCallbackQuery(query.id, { text: '⚠️ Admin không thể gửi báo cáo.', show_alert: true });
            return true;
        }
        // Find a chat where the user is a member and has a report topic
        const topicRes = await db.query(
            'SELECT chat_id, topic_id FROM topics WHERE feature_type = $1 LIMIT 1',
            ['report']
        );

        if (topicRes.rows.length === 0) {
            bot.answerCallbackQuery(query.id, { text: '❌ Hệ thống chưa cài đặt Topic Báo cáo nào.', show_alert: true });
            return true;
        }

        const targetChatId = topicRes.rows[0].chat_id;
        const targetTopicId = topicRes.rows[0].topic_id;

        const keyboard = [
            [{ text: '📝 Gửi báo cáo công việc hằng ngày', callback_data: `rep_create_type_daily_${targetChatId}_${targetTopicId}` }],
            [{ text: '📁 Gửi báo cáo dự án', callback_data: `rep_create_type_project_${targetChatId}_${targetTopicId}` }]
        ];

        bot.sendMessage(chatId, 'Vui lòng chọn loại báo cáo:', {
            reply_markup: { inline_keyboard: keyboard }
        });
        bot.answerCallbackQuery(query.id);
        return true;
    }

    if (data.startsWith('rep_create_type_')) {
        const parts = data.split('_');
        const reportType = parts[3];
        const targetChatId = parts[4];
        const targetTopicId = parts[5];

        // Initialize report in DB
        const res = await db.query(
            'INSERT INTO reports (user_id, chat_id, topic_id, status, report_type) VALUES ($1, $2, $3, $4, $5) RETURNING id',
            [userId, targetChatId, targetTopicId, 'draft', reportType]
        );
        const reportId = res.rows[0].id;

        updateSession(userId, {
            state: 'creating_report_step_title',
            tempData: { reportId, targetChatId, targetTopicId, reportType }
        });

        const typeText = reportType === 'project' ? 'DỰ ÁN' : 'CÔNG VIỆC HẰNG NGÀY';
        bot.sendMessage(chatId, `📝 *BẮT ĐẦU SOẠN BÁO CÁO ${typeText}*\n\nBước 1: Vui lòng nhập *Tiêu đề* ngắn gọn cho báo cáo của bạn (VD: Báo cáo tiến độ dự án A):`, { parse_mode: 'Markdown' });
        bot.answerCallbackQuery(query.id);
        return true;
    }

    if (data.startsWith('rep_preview_')) {
        const session = getSession(userId);
        if (session?.tempData?.promptMessageId) {
            bot.deleteMessage(chatId, session.tempData.promptMessageId).catch(() => { });
        }
        bot.deleteMessage(chatId, messageId).catch(() => { });

        const reportId = data.split('_')[2];
        const reportRes = await db.query('SELECT * FROM reports WHERE id = $1', [reportId]);
        if (reportRes.rows.length === 0) return false;
        const report = reportRes.rows[0];

        const attachmentsRes = await db.query('SELECT * FROM report_attachments WHERE report_id = $1', [reportId]);
        const attachments = attachmentsRes.rows;

        const fullName = [query.from.first_name, query.from.last_name].filter(Boolean).join(' ');
        const typeText = report.report_type === 'project' ? 'DỰ ÁN' : 'CÔNG VIỆC HẰNG NGÀY';

        let previewText = `📑 *XEM TRƯỚC BÁO CÁO ${typeText}*\n\n`;
        previewText += `👤 *Người báo cáo:* ${fullName}\n`;
        previewText += `📅 *Thời gian:* ${new Date(report.created_at).toLocaleString('vi-VN')}\n`;
        previewText += `📌 *Tiêu đề:* ${report.title}\n\n`;
        previewText += `📝 *Nội dung:* \n${report.content}\n\n`;
        previewText += `📎 *Đính kèm:* ${attachments.length} file`;

        const keyboard = [
            [
                { text: '🚀 Gửi lên Group', callback_data: `rep_confirm_send_${reportId}` },
                { text: '❌ Hủy bỏ', callback_data: `rep_cancel_${reportId}` }
            ]
        ];

        await bot.sendMessage(chatId, previewText, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: keyboard }
        });
        bot.answerCallbackQuery(query.id);
        return true;
    }

    if (data.startsWith('rep_confirm_send_')) {
        const reportId = data.split('_')[3];
        const reportRes = await db.query('SELECT * FROM reports WHERE id = $1', [reportId]);
        if (reportRes.rows.length === 0) return false;
        const report = reportRes.rows[0];

        if (!report.chat_id) {
            bot.answerCallbackQuery(query.id, { text: '❌ Lỗi: Không tìm thấy Chat ID để gửi báo cáo.', show_alert: true });
            return true;
        }

        const attachmentsRes = await db.query('SELECT * FROM report_attachments WHERE report_id = $1', [reportId]);
        const attachments = attachmentsRes.rows;

        const fullName = [query.from.first_name, query.from.last_name].filter(Boolean).join(' ');
        const typeText = report.report_type === 'project' ? 'DỰ ÁN' : 'CÔNG VIỆC HẰNG NGÀY';

        let reportText = `📢 *BÁO CÁO ${typeText} MỚI*\n\n`;
        reportText += `👤 *Người báo cáo:* ${fullName}\n`;
        reportText += `📅 *Thời gian:* ${new Date(report.created_at).toLocaleString('vi-VN')}\n`;
        reportText += `📌 *Tiêu đề:* ${report.title}\n\n`;
        reportText += `📝 *Nội dung:* \n${report.content}`;

        // Send to group
        try {
            if (attachments.length > 0) {
                const photos = attachments.filter(a => a.file_type === 'photo');
                const documents = attachments.filter(a => a.file_type === 'document');
                let captionSent = false;

                const sendGroup = async (items: any[], type: string) => {
                    if (items.length === 0) return;

                    for (let i = 0; i < items.length; i += 10) {
                        const chunk = items.slice(i, i + 10);
                        const media = chunk.map((att, index) => ({
                            type: type,
                            media: att.file_id,
                            caption: (!captionSent && index === 0) ? reportText : undefined,
                            parse_mode: 'Markdown'
                        }));

                        if (media.length === 1) {
                            if (type === 'photo') {
                                await bot.sendPhoto(report.chat_id, media[0].media, { caption: media[0].caption, parse_mode: 'Markdown', message_thread_id: report.topic_id });
                            } else {
                                await bot.sendDocument(report.chat_id, media[0].media, { caption: media[0].caption, parse_mode: 'Markdown', message_thread_id: report.topic_id });
                            }
                        } else {
                            // @ts-ignore
                            await bot.sendMediaGroup(report.chat_id, media, { message_thread_id: report.topic_id });
                        }
                        captionSent = true;
                    }
                };

                await sendGroup(photos, 'photo');
                await sendGroup(documents, 'document');
            } else {
                await bot.sendMessage(report.chat_id, reportText, { parse_mode: 'Markdown', message_thread_id: report.topic_id });
            }

            await db.query('UPDATE reports SET status = $1 WHERE id = $2', ['submitted', reportId]);
            bot.editMessageText('✅ *Báo cáo đã được gửi thành công lên Group!*', {
                chat_id: chatId,
                message_id: query.message?.message_id,
                parse_mode: 'Markdown'
            });
            setTimeout(() => {
                if (query.message?.message_id) {
                    bot.deleteMessage(chatId, query.message.message_id).catch(() => { });
                }
            }, 120000);
            clearSession(userId);
        } catch (err) {
            console.error('Error sending report to group:', err);
            bot.answerCallbackQuery(query.id, { text: '❌ Lỗi khi gửi báo cáo lên Group. Vui lòng thử lại.', show_alert: true });
        }
        bot.answerCallbackQuery(query.id);
        return true;
    }

    if (data.startsWith('rep_cancel_')) {
        const reportId = data.split('_')[2];
        await db.query('DELETE FROM reports WHERE id = $1', [reportId]);
        bot.editMessageText('❌ *Đã hủy soạn thảo báo cáo.*', {
            chat_id: chatId,
            message_id: query.message?.message_id,
            parse_mode: 'Markdown'
        });
        setTimeout(() => {
            if (query.message?.message_id) {
                bot.deleteMessage(chatId, query.message.message_id).catch(() => { });
            }
        }, 120000);
        clearSession(userId);
        bot.answerCallbackQuery(query.id);
        return true;
    }

    if (data === 'rep_my_stats') {
        const res = await db.query(
            'SELECT COUNT(*) FROM reports WHERE user_id = $1 AND status = $2',
            [userId, 'submitted']
        );
        const count = res.rows[0].count;

        const isPrivate = query.message?.chat.type === 'private';
        const text = `📊 Bạn đã nộp tổng cộng ${count} báo cáo.`;
        const keyboard = [
            [{ text: '📋 Xem danh sách báo cáo của tôi', callback_data: 'rep_my_list' }],
            ([{ text: '🔙 Quay lại', callback_data: 'user_dashboard' }])
        ];

        if (!isPrivate) {
            keyboard.push([{ text: '🗑 Đóng', callback_data: 'reg_close_temp' }]);
        }

        bot.editMessageText(text, {
            chat_id: chatId,
            message_id: query.message?.message_id,
            reply_markup: { inline_keyboard: keyboard }
        }).catch(() => { });

        bot.answerCallbackQuery(query.id);
        return true;
    }

    if (data === 'rep_my_list') {
        if (userRole === 'admin') {
            bot.answerCallbackQuery(query.id, { text: '⚠️ Admin không có lịch sử báo cáo.', show_alert: true });
            return true;
        }
        const res = await db.query(
            'SELECT id, title, created_at FROM reports WHERE user_id = $1 AND status = $2 ORDER BY created_at DESC LIMIT 20',
            [userId, 'submitted']
        );

        if (res.rows.length === 0) {
            bot.answerCallbackQuery(query.id, { text: '⚠️ Bạn chưa có báo cáo nào được gửi.', show_alert: true });
            return true;
        }

        const isPrivate = query.message?.chat.type === 'private';
        const keyboard = res.rows.map(r => [{
            text: `📄 ${r.title} (${new Date(r.created_at).toLocaleDateString('vi-VN')})`,
            callback_data: `rep_view_detail_${r.id}`
        }]);

        if (isPrivate) {
            keyboard.push([{ text: '🔙 Quay lại', callback_data: 'rep_my_stats' }]);
        } else {
            keyboard.push([{ text: '🔙 Quay lại', callback_data: 'rep_my_stats' }]);
            keyboard.push([{ text: '🗑 Đóng', callback_data: 'reg_close_temp' }]);
        }

        bot.editMessageText('📋 *DANH SÁCH BÁO CÁO CỦA BẠN:*', {
            chat_id: chatId,
            message_id: query.message?.message_id,
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: keyboard }
        }).catch(() => { });

        bot.answerCallbackQuery(query.id);
        return true;
    }

    if (data === 'rep_admin_today') {
        if (userRole !== 'admin') {
            bot.answerCallbackQuery(query.id, { text: '❌ Chỉ Admin mới có quyền xem.', show_alert: true });
            return true;
        }

        // Get start and end of today
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const tomorrow = new Date(today);
        tomorrow.setDate(tomorrow.getDate() + 1);

        const res = await db.query(`
      SELECT r.id, r.title, r.created_at, u.first_name, u.username
      FROM reports r
      JOIN users u ON r.user_id = u.id
      WHERE r.status = 'submitted' AND r.created_at >= $1 AND r.created_at < $2
      ORDER BY r.created_at DESC
    `, [today.toISOString(), tomorrow.toISOString()]);

        const isPrivate = query.message?.chat.type === 'private';
        const text = `📅 *BÁO CÁO HÔM NAY*\n\nTổng số: ${res.rows.length} báo cáo`;
        const keyboard = res.rows.map(r => [{
            text: `📄 ${r.first_name || r.username} - ${r.title}`,
            callback_data: `rep_view_detail_${r.id}`
        }]);

        keyboard.push([{ text: '🔙 Quay lại', callback_data: 'admin_manage_reports' }]);
        if (!isPrivate) {
            keyboard.push([{ text: '🗑 Đóng', callback_data: 'reg_close_temp' }]);
        }

        bot.editMessageText(text, {
            chat_id: chatId,
            message_id: query.message?.message_id,
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: keyboard }
        }).catch(() => { });

        bot.answerCallbackQuery(query.id);
        return true;
    }

    if (data === 'rep_admin_by_user') {
        if (userRole !== 'admin') {
            bot.answerCallbackQuery(query.id, { text: '❌ Bạn không có quyền thực hiện thao tác này.', show_alert: true });
            return true;
        }

        const res = await db.query(`
      SELECT u.id, u.first_name, u.username, COUNT(r.id) as report_count 
      FROM users u 
      JOIN reports r ON u.id = r.user_id 
      WHERE r.status = 'submitted' 
      GROUP BY u.id, u.first_name, u.username 
      ORDER BY u.first_name ASC
    `);

        if (res.rows.length === 0) {
            bot.answerCallbackQuery(query.id, { text: '⚠️ Chưa có thành viên nào nộp báo cáo.', show_alert: true });
            return true;
        }

        const keyboard = res.rows.map(u => [{
            text: `👤 ${u.first_name} ${u.username ? `(@${u.username})` : ''} - ${u.report_count} BC`,
            callback_data: `rep_admin_list_by_user_${u.id}`
        }]);

        const isPrivate = query.message?.chat.type === 'private';
        keyboard.push([{ text: '🔙 Quay lại', callback_data: 'admin_manage_reports' }]);

        if (!isPrivate) {
            keyboard.push([{ text: '🗑 Đóng', callback_data: 'reg_close_temp' }]);
        }

        bot.editMessageText('👤 *BÁO CÁO THEO TÊN*\n\nChọn nhân viên để xem:', {
            chat_id: chatId,
            message_id: query.message?.message_id,
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: keyboard }
        }).catch(() => { });

        bot.answerCallbackQuery(query.id);
        return true;
    }

    if (data.startsWith('rep_admin_list_by_user_')) {
        if (userRole !== 'admin') {
            bot.answerCallbackQuery(query.id, { text: '❌ Bạn không có quyền thực hiện thao tác này.', show_alert: true });
            return true;
        }
        const targetUserId = data.split('_')[5];

        const userRes = await db.query('SELECT first_name FROM users WHERE id = $1', [targetUserId]);
        const userName = userRes.rows[0]?.first_name || 'Thành viên';

        const res = await db.query(
            'SELECT id, title, created_at FROM reports WHERE user_id = $1 AND status = $2 ORDER BY created_at DESC',
            [targetUserId, 'submitted']
        );

        const keyboard = res.rows.map(r => [{
            text: `📄 ${r.title} (${new Date(r.created_at).toLocaleDateString('vi-VN')})`,
            callback_data: `rep_view_detail_${r.id}`
        }]);

        const isPrivate = query.message?.chat.type === 'private';
        keyboard.push([{ text: '🔙 Quay lại', callback_data: 'rep_admin_by_user' }]);

        if (!isPrivate) {
            keyboard.push([{ text: '🗑 Đóng', callback_data: 'reg_close_temp' }]);
        }

        bot.editMessageText(`📋 *BÁO CÁO CỦA ${userName.toUpperCase()}:*`, {
            chat_id: chatId,
            message_id: query.message?.message_id,
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: keyboard }
        }).catch(() => { });

        bot.answerCallbackQuery(query.id);
        return true;
    }

    if (data === 'rep_admin_by_month') {
        if (userRole !== 'admin') {
            bot.answerCallbackQuery(query.id, { text: '❌ Bạn không có quyền thực hiện thao tác này.', show_alert: true });
            return true;
        }

        // Get distinct months from reports
        const res = await db.query(`
      SELECT DISTINCT TO_CHAR(created_at, 'MM/YYYY') as month_year, 
             EXTRACT(MONTH FROM created_at) as month, 
             EXTRACT(YEAR FROM created_at) as year
      FROM reports 
      WHERE status = 'submitted'
      ORDER BY year DESC, month DESC
    `);

        if (res.rows.length === 0) {
            bot.answerCallbackQuery(query.id, { text: '⚠️ Chưa có báo cáo nào.', show_alert: true });
            return true;
        }

        const keyboard = res.rows.map(r => [{
            text: `📆 Tháng ${r.month_year}`,
            callback_data: `rep_admin_month_${r.month}_${r.year}`
        }]);

        const isPrivate = query.message?.chat.type === 'private';
        keyboard.push([{ text: '🔙 Quay lại', callback_data: 'admin_manage_reports' }]);

        if (!isPrivate) {
            keyboard.push([{ text: '🗑 Đóng', callback_data: 'reg_close_temp' }]);
        }

        bot.editMessageText('📆 *BÁO CÁO THEO THÁNG*\n\nChọn tháng để xem:', {
            chat_id: chatId,
            message_id: query.message?.message_id,
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: keyboard }
        }).catch(() => { });

        bot.answerCallbackQuery(query.id);
        return true;
    }

    if (data.startsWith('rep_admin_month_')) {
        if (userRole !== 'admin') {
            bot.answerCallbackQuery(query.id, { text: '❌ Bạn không có quyền thực hiện thao tác này.', show_alert: true });
            return true;
        }
        const parts = data.split('_');
        const month = parts[3];
        const year = parts[4];

        const startDate = `${year}-${month.padStart(2, '0')}-01 00:00:00`;
        const endDate = new Date(parseInt(year), parseInt(month), 0, 23, 59, 59).toISOString();

        const res = await db.query(`
      SELECT r.id, r.title, r.created_at, u.first_name, u.username
      FROM reports r
      JOIN users u ON r.user_id = u.id
      WHERE r.status = 'submitted' AND r.created_at >= $1 AND r.created_at <= $2
      ORDER BY r.created_at DESC
    `, [startDate, endDate]);

        const keyboard = res.rows.map(r => [{
            text: `📄 ${r.first_name || r.username} - ${r.title}`,
            callback_data: `rep_view_detail_${r.id}`
        }]);

        // Add export button
        keyboard.unshift([{ text: '📥 Xuất Excel tháng này', callback_data: `rep_admin_export_${month}_${year}` }]);

        const isPrivate = query.message?.chat.type === 'private';
        keyboard.push([{ text: '🔙 Quay lại', callback_data: 'rep_admin_by_month' }]);

        if (!isPrivate) {
            keyboard.push([{ text: '🗑 Đóng', callback_data: 'reg_close_temp' }]);
        }

        bot.editMessageText(`📆 *BÁO CÁO THÁNG ${month}/${year}*\n\nTổng số: ${res.rows.length} báo cáo`, {
            chat_id: chatId,
            message_id: query.message?.message_id,
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: keyboard }
        }).catch(() => { });

        bot.answerCallbackQuery(query.id);
        return true;
    }

    if (data.startsWith('rep_view_detail_')) {
        const reportId = data.split('_')[3];
        const reportRes = await db.query(`
      SELECT r.*, u.first_name, u.last_name, u.username 
      FROM reports r 
      JOIN users u ON r.user_id = u.id 
      WHERE r.id = $1
    `, [reportId]);

        if (reportRes.rows.length === 0) return false;
        const report = reportRes.rows[0];

        const attachmentsRes = await db.query('SELECT * FROM report_attachments WHERE report_id = $1', [reportId]);
        const attachments = attachmentsRes.rows;

        const fullName = [report.first_name, report.last_name].filter(Boolean).join(' ');
        const typeText = report.report_type === 'project' ? 'DỰ ÁN' : 'CÔNG VIỆC HẰNG NGÀY';

        let detailText = `📄 *CHI TIẾT BÁO CÁO ${typeText}*\n\n`;
        detailText += `👤 *Người báo cáo:* ${fullName} ${report.username ? `(@${report.username})` : ''}\n`;
        detailText += `📅 *Thời gian:* ${new Date(report.created_at).toLocaleString('vi-VN')}\n`;
        detailText += `📌 *Tiêu đề:* ${report.title}\n\n`;
        detailText += `📝 *Nội dung:* \n${report.content}\n\n`;
        detailText += `📎 *Đính kèm:* ${attachments.length} file`;

        const isPrivate = query.message?.chat.type === 'private';
        const topicId = query.message?.message_thread_id;

        const keyboard = [];
        if (userRole === 'admin' && isPrivate) {
            keyboard.push([{ text: '📥 Tải báo cáo (ZIP)', callback_data: `rep_export_zip_${reportId}` }]);
        }
        if (!isPrivate) {
            keyboard.push([{ text: '🗑 Đóng', callback_data: 'reg_close_temp' }]);
        }

        // Send the text first
        const sentMsg = await bot.sendMessage(chatId, detailText, {
            message_thread_id: topicId,
            parse_mode: 'Markdown',
            reply_markup: keyboard.length > 0 ? { inline_keyboard: keyboard } : undefined
        });

        // Send attachments if any
        const attachmentMsgIds: number[] = [];
        if (attachments.length > 0) {
            for (const att of attachments) {
                let attMsg;
                if (att.file_type === 'photo') {
                    attMsg = await bot.sendPhoto(chatId, att.file_id, { message_thread_id: topicId });
                } else {
                    attMsg = await bot.sendDocument(chatId, att.file_id, { message_thread_id: topicId });
                }
                if (attMsg) attachmentMsgIds.push(attMsg.message_id);
            }
        }

        if (!isPrivate) {
            setTimeout(() => {
                bot.deleteMessage(chatId, sentMsg.message_id).catch(() => { });
                for (const id of attachmentMsgIds) {
                    bot.deleteMessage(chatId, id).catch(() => { });
                }
            }, 120000);
        }

        bot.answerCallbackQuery(query.id);
        return true;
    }

    if (data.startsWith('rep_export_zip_')) {
        if (userRole !== 'admin') {
            bot.answerCallbackQuery(query.id, { text: '❌ Bạn không có quyền thực hiện thao tác này.', show_alert: true });
            return true;
        }
        const reportId = parseInt(data.replace('rep_export_zip_', ''));
        bot.answerCallbackQuery(query.id, { text: '⏳ Đang tạo file ZIP, vui lòng đợi...' });

        try {
            const zipFilePath = await exportReportToZip(bot, reportId);
            if (zipFilePath) {
                await bot.sendDocument(chatId, fs.createReadStream(zipFilePath), {}, {
                    filename: `report_${reportId}.zip`,
                    contentType: 'application/zip'
                });
                fs.unlinkSync(zipFilePath);
            } else {
                bot.sendMessage(chatId, '❌ Không tìm thấy báo cáo.');
            }
        } catch (error) {
            console.error('Error exporting ZIP:', error);
            bot.sendMessage(chatId, '❌ Có lỗi xảy ra khi xuất file ZIP.');
        }
        return true;
    }

    if (data.startsWith('rep_admin_export_')) {
        if (userRole !== 'admin') {
            bot.answerCallbackQuery(query.id, { text: '❌ Bạn không có quyền thực hiện thao tác này.', show_alert: true });
            return true;
        }
        const parts = data.split('_');
        const month = parseInt(parts[3]);
        const year = parseInt(parts[4]);

        bot.answerCallbackQuery(query.id, { text: '⏳ Đang tạo file Excel, vui lòng đợi...' });

        try {
            const excelFilePath = await exportReportsToExcel(month.toString(), year.toString());
            await bot.sendDocument(chatId, fs.createReadStream(excelFilePath), {}, {
                filename: `reports_${month}_${year}.xlsx`,
                contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            });
            fs.unlinkSync(excelFilePath);
        } catch (error) {
            console.error('Error exporting Excel:', error);
            bot.sendMessage(chatId, '❌ Có lỗi xảy ra khi xuất file Excel.');
        }
        return true;
    }

    if (data === 'rep_admin_edit_announcement') {
        if (userRole !== 'admin') {
            bot.answerCallbackQuery(query.id, { text: '❌ Bạn không có quyền thực hiện thao tác này.', show_alert: true });
            return true;
        }

        if (!isPrivate) {
            bot.answerCallbackQuery(query.id, { text: '⚠️ Vui lòng chuyển sang Inbox riêng với Bot để chỉnh sửa thông báo.', show_alert: true });
            return true;
        }

        const res = await db.query("SELECT id, name, custom_announcement FROM topics WHERE feature_type = 'report'");
        if (res.rows.length === 0) {
            bot.answerCallbackQuery(query.id, { text: '⚠️ Chưa có Topic Báo cáo nào được thiết lập.', show_alert: true });
            return true;
        }

        if (res.rows.length === 1) {
            const topic = res.rows[0];
            const text = `📢 **Chỉnh sửa Thông báo Ghim** cho Topic: ${topic.name}\n\n` +
                `Thông báo hiện tại:\n_${topic.custom_announcement || 'Chưa có thông báo tùy chỉnh'}_\n\n` +
                `Vui lòng nhập nội dung thông báo mới (hoặc gửi /cancel để hủy):`;

            bot.sendMessage(chatId, text, {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: [[{ text: '❌ Hủy', callback_data: 'rep_admin_edit_ann_cancel' }]] }
            }).then(m => {
                updateSession(userId, { state: 'editing_report_announcement', tempData: { topicId: topic.id, promptMessageId: m.message_id } });
            });
            bot.answerCallbackQuery(query.id);
        } else {
            const keyboard = res.rows.map(t => [{ text: t.name || `Topic ${t.id}`, callback_data: `rep_admin_edit_ann_${t.id}` }]);
            keyboard.push([{ text: '🔙 Quay lại', callback_data: 'admin_reports' }]);
            bot.editMessageText('Vui lòng chọn Topic Báo cáo muốn chỉnh sửa thông báo:', {
                chat_id: chatId,
                message_id: messageId,
                reply_markup: { inline_keyboard: keyboard }
            });
            bot.answerCallbackQuery(query.id);
        }
        return true;
    }

    if (data.startsWith('rep_admin_edit_ann_')) {
        if (userRole !== 'admin') {
            bot.answerCallbackQuery(query.id, { text: '❌ Bạn không có quyền thực hiện thao tác này.', show_alert: true });
            return true;
        }

        if (!isPrivate) {
            bot.answerCallbackQuery(query.id, { text: '⚠️ Vui lòng chuyển sang Inbox riêng với Bot để chỉnh sửa thông báo.', show_alert: true });
            return true;
        }

        const topicId = parseInt(data.replace('rep_admin_edit_ann_', ''));
        const res = await db.query("SELECT name, custom_announcement FROM topics WHERE id = $1", [topicId]);
        if (res.rows.length > 0) {
            const topic = res.rows[0];
            const text = `📢 **Chỉnh sửa Thông báo Ghim** cho Topic: ${topic.name}\n\n` +
                `Thông báo hiện tại:\n_${topic.custom_announcement || 'Chưa có thông báo tùy chỉnh'}_\n\n` +
                `Vui lòng nhập nội dung thông báo mới (hoặc gửi /cancel để hủy):`;

            bot.sendMessage(chatId, text, {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: [[{ text: '❌ Hủy', callback_data: 'rep_admin_edit_ann_cancel' }]] }
            }).then(m => {
                updateSession(userId, { state: 'editing_report_announcement', tempData: { topicId: topicId, promptMessageId: m.message_id } });
            });
            bot.answerCallbackQuery(query.id);
        }
        return true;
    }

    if (data === 'rep_admin_edit_ann_cancel') {
        bot.deleteMessage(chatId, messageId).catch(() => { });
        bot.sendMessage(chatId, '✅ Đã hủy chỉnh sửa thông báo.', {
            reply_markup: { inline_keyboard: [[{ text: '🔙 Quay lại Menu', callback_data: 'admin_reports' }]] }
        });
        clearSession(userId);
        bot.answerCallbackQuery(query.id);
        return true;
    }

    return false;
}
