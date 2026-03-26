import TelegramBot, { InlineKeyboardButton } from 'node-telegram-bot-api';
import { db } from '../../db';
import { updateSession, clearSession, getSession } from '../services/sessionManager';
import { botUsername } from '../botInstance';

export async function handleProposalDeepLink(
    bot: TelegramBot,
    msg: TelegramBot.Message,
    param: string,
    userRole: string
): Promise<boolean> {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;

    if (!userId) return false;

    if (param === 'create_proposal') {
        const keyboard: InlineKeyboardButton[][] = [
            [{ text: '💰 Đề xuất chi phí', callback_data: 'prop_type_cost' }],
            [{ text: '📝 Đề xuất công việc', callback_data: 'prop_type_work' }],
            [{ text: '⚖️ Đề xuất nội quy - chính sách', callback_data: 'prop_type_policy' }],
            [{ text: '🛠 Đề xuất công cụ - thiết bị', callback_data: 'prop_type_tool' }]
        ];

        bot.sendMessage(chatId, '📝 *TẠO ĐỀ XUẤT MỚI*\n\nBước 1: Vui lòng chọn loại đề xuất bạn muốn tạo:', {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: keyboard }
        }).then(m => {
            updateSession(userId, {
                state: 'creating_proposal_type',
                tempData: { promptMessageId: m.message_id }
            });
        });
        return true;
    }

    if (param === 'my_proposals') {
        const res = await db.query(
            'SELECT id, proposal_code, type, status, created_at FROM proposals WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10',
            [userId]
        );

        if (res.rows.length === 0) {
            bot.sendMessage(chatId, '⚠️ Bạn chưa có đề xuất nào.');
            return true;
        }

        const keyboard = res.rows.map(r => {
            let statusEmoji = '⏳';
            if (r.status === 'APPROVED') statusEmoji = '✅';
            if (r.status === 'REJECTED') statusEmoji = '❌';

            let typeName = '';
            if (r.type === 'cost') typeName = 'Chi phí';
            if (r.type === 'work') typeName = 'Công việc';
            if (r.type === 'policy') typeName = 'Nội quy';
            if (r.type === 'tool') typeName = 'Công cụ';

            return [{
                text: `${statusEmoji} [${r.proposal_code}] ${typeName} (${new Date(r.created_at).toLocaleDateString('vi-VN')})`,
                callback_data: `prop_view_${r.id}`
            }];
        });

        keyboard.push([{ text: '🔙 Quay lại Menu', callback_data: 'user_dashboard' }]);

        bot.sendMessage(chatId, '📋 *LỊCH SỬ ĐỀ XUẤT CỦA BẠN:*', {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: keyboard }
        });
        return true;
    }

    if (param === 'admin_proposals') {
        if (userRole !== 'admin') {
            bot.sendMessage(chatId, '❌ Bạn không có quyền xem danh sách này.');
            return true;
        }

        const keyboard: InlineKeyboardButton[][] = [
            [{ text: '⏳ Chờ duyệt', callback_data: 'prop_admin_filter_PENDING' }],
            [{ text: '✅ Đã duyệt', callback_data: 'prop_admin_filter_APPROVED' }],
            [{ text: '❌ Từ chối', callback_data: 'prop_admin_filter_REJECTED' }],
            [{ text: '👤 Lọc theo User', callback_data: 'prop_admin_filter_user' }],
            [{ text: '🔙 Quay lại Menu Admin', callback_data: 'admin_dashboard' }]
        ];

        bot.sendMessage(chatId, '📋 *QUẢN LÝ ĐỀ XUẤT*\n\nChọn bộ lọc để xem danh sách đề xuất:', {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: keyboard }
        });
        return true;
    }

    return false;
}

export async function handleProposalState(
    bot: TelegramBot,
    msg: TelegramBot.Message,
    session: any
): Promise<boolean> {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    const text = msg.text || '';

    if (!userId) return false;

    switch (session.state) {
        case 'creating_proposal_content':
            if (session.tempData.promptMessageId) bot.deleteMessage(chatId, session.tempData.promptMessageId).catch(() => { });
            bot.deleteMessage(chatId, msg.message_id).catch(() => { });

            const keyboardTime = [[{ text: '⏭ Bỏ qua', callback_data: 'prop_skip_time' }]];
            bot.sendMessage(chatId, '🕒 *Bước 3: Thời gian áp dụng*\n\nNhập thời gian áp dụng (Định dạng: DD/MM/YYYY, ví dụ: 30/04/2024) hoặc bấm Bỏ qua:', {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: keyboardTime }
            }).then(m => {
                updateSession(userId, {
                    state: 'creating_proposal_time',
                    tempData: { ...session.tempData, content: text, promptMessageId: m.message_id }
                });
            });
            return true;

        case 'creating_proposal_time':
            if (session.tempData.promptMessageId) bot.deleteMessage(chatId, session.tempData.promptMessageId).catch(() => { });
            bot.deleteMessage(chatId, msg.message_id).catch(() => { });

            let applyTimeDate: Date | null = null;
            let formattedDate = text;
            const parts = text.split(/[\s/:-]+/);

            if (parts.length >= 3) {
                const day = parseInt(parts[0]);
                const month = parseInt(parts[1]) - 1;
                const year = parseInt(parts[2]);
                applyTimeDate = new Date(year, month, day);

                // Strict date validation (e.g., prevent 30/02/2024)
                if (applyTimeDate.getDate() !== day || applyTimeDate.getMonth() !== month || applyTimeDate.getFullYear() !== year) {
                    applyTimeDate = null; // Invalid date
                }
            }

            if (!applyTimeDate || isNaN(applyTimeDate.getTime())) {
                const keyboardTime = [[{ text: '⏭ Bỏ qua', callback_data: 'prop_skip_time' }]];
                bot.sendMessage(chatId, '⚠️ Lỗi: Thời gian không hợp lệ. Vui lòng nhập lại (DD/MM/YYYY) hoặc bấm Bỏ qua:', {
                    reply_markup: { inline_keyboard: keyboardTime }
                }).then(m => {
                    updateSession(userId, {
                        state: 'creating_proposal_time',
                        tempData: { ...session.tempData, promptMessageId: m.message_id }
                    });
                });
                return true;
            }

            const today = new Date();
            today.setHours(0, 0, 0, 0);
            if (applyTimeDate < today) {
                const keyboardTime = [[{ text: '⏭ Bỏ qua', callback_data: 'prop_skip_time' }]];
                bot.sendMessage(chatId, '⚠️ Lỗi: Không thể chọn ngày trong quá khứ. Vui lòng nhập lại (DD/MM/YYYY) hoặc bấm Bỏ qua:', {
                    reply_markup: { inline_keyboard: keyboardTime }
                }).then(m => {
                    updateSession(userId, {
                        state: 'creating_proposal_time',
                        tempData: { ...session.tempData, promptMessageId: m.message_id }
                    });
                });
                return true;
            }

            formattedDate = `${parts[0].padStart(2, '0')}/${parts[1].padStart(2, '0')}/${parts[2]}`;

            const keyboardCost = [[{ text: '⏭ Bỏ qua', callback_data: 'prop_skip_cost' }]];
            bot.sendMessage(chatId, '💰 *Bước 4: Dự trù chi phí*\n\nNhập dự trù chi phí (nếu có) hoặc bấm Bỏ qua (ví dụ: 1.500.000 vnd hoặc $77):', {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: keyboardCost }
            }).then(m => {
                updateSession(userId, {
                    state: 'creating_proposal_cost',
                    tempData: { ...session.tempData, apply_time: formattedDate, promptMessageId: m.message_id }
                });
            });
            return true;

        case 'creating_proposal_cost':
            if (session.tempData.promptMessageId) bot.deleteMessage(chatId, session.tempData.promptMessageId).catch(() => { });
            bot.deleteMessage(chatId, msg.message_id).catch(() => { });

            const keyboardFile = [[{ text: '⏭ Bỏ qua', callback_data: 'prop_skip_file' }]];
            bot.sendMessage(chatId, '📎 *Bước 5: File đính kèm*\n\nGửi 1 file/ảnh đính kèm (báo giá, tài liệu...) hoặc bấm Bỏ qua:', {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: keyboardFile }
            }).then(m => {
                updateSession(userId, {
                    state: 'creating_proposal_file',
                    tempData: { ...session.tempData, cost: text, promptMessageId: m.message_id }
                });
            });
            return true;

        case 'creating_proposal_file':
            if (session.tempData.promptMessageId) bot.deleteMessage(chatId, session.tempData.promptMessageId).catch(() => { });
            bot.deleteMessage(chatId, msg.message_id).catch(() => { });

            let fileId = null;
            let fileType = null;

            if (msg.photo) {
                fileId = msg.photo[msg.photo.length - 1].file_id;
                fileType = 'photo';
            } else if (msg.document) {
                fileId = msg.document.file_id;
                fileType = 'document';
            } else {
                bot.sendMessage(chatId, '⚠️ Vui lòng gửi file/ảnh hoặc bấm Bỏ qua.');
                return true;
            }

            await showProposalPreview(bot, chatId, userId, { ...session.tempData, file_id: fileId, file_type: fileType }, msg.from);
            return true;

        case 'editing_proposal_content':
        case 'editing_proposal_time':
        case 'editing_proposal_cost':
        case 'editing_proposal_file': {
            if (session.tempData.promptMessageId) bot.deleteMessage(chatId, session.tempData.promptMessageId).catch(() => { });
            bot.deleteMessage(chatId, msg.message_id).catch(() => { });

            const propId = session.tempData.proposalId;
            const field = session.state.replace('editing_proposal_', '');

            try {
                const checkRes = await db.query('SELECT * FROM proposals WHERE id = $1 AND user_id = $2', [propId, userId]);
                if (checkRes.rows.length === 0 || checkRes.rows[0].status !== 'PENDING') {
                    bot.sendMessage(chatId, '⚠️ Đề xuất này đã được xử lý, không thể chỉnh sửa nữa.').then(m => setTimeout(() => bot.deleteMessage(chatId, m.message_id).catch(() => { }), 5000));
                    clearSession(userId);
                    return true;
                }

                const prop = checkRes.rows[0];
                let updateQuery = '';
                let updateParams: any[] = [];

                if (field === 'content') {
                    updateQuery = 'UPDATE proposals SET content = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2';
                    updateParams = [text, propId];
                    prop.content = text;
                } else if (field === 'time') {
                    let applyTimeDate: Date | null = null;
                    let formattedDate = text;
                    const parts = text.split(/[\s/:-]+/);
                    if (parts.length >= 3) {
                        const day = parseInt(parts[0]);
                        const month = parseInt(parts[1]) - 1;
                        const year = parseInt(parts[2]);
                        applyTimeDate = new Date(year, month, day);
                        if (applyTimeDate.getDate() !== day || applyTimeDate.getMonth() !== month || applyTimeDate.getFullYear() !== year) {
                            applyTimeDate = null;
                        }
                    }
                    if (!applyTimeDate || isNaN(applyTimeDate.getTime())) {
                        bot.sendMessage(chatId, '⚠️ Lỗi: Thời gian không hợp lệ. Vui lòng nhập lại (DD/MM/YYYY):', {
                            reply_markup: { inline_keyboard: [[{ text: '❌ Hủy', callback_data: `prop_edit_cancel_${propId}` }]] }
                        }).then(m => {
                            updateSession(userId, { state: session.state, tempData: { ...session.tempData, promptMessageId: m.message_id } });
                        });
                        return true;
                    }
                    formattedDate = `${parts[0].padStart(2, '0')}/${parts[1].padStart(2, '0')}/${parts[2]}`;
                    updateQuery = 'UPDATE proposals SET apply_time = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2';
                    updateParams = [formattedDate, propId];
                    prop.apply_time = formattedDate;
                } else if (field === 'cost') {
                    updateQuery = 'UPDATE proposals SET cost = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2';
                    updateParams = [text, propId];
                    prop.cost = text;
                } else if (field === 'file') {
                    let newFileId = null;
                    let newFileType = null;
                    if (msg.photo) {
                        newFileId = msg.photo[msg.photo.length - 1].file_id;
                        newFileType = 'photo';
                    } else if (msg.document) {
                        newFileId = msg.document.file_id;
                        newFileType = 'document';
                    } else {
                        bot.sendMessage(chatId, '⚠️ Vui lòng gửi file/ảnh hợp lệ:').then(m => {
                            updateSession(userId, { state: session.state, tempData: { ...session.tempData, promptMessageId: m.message_id } });
                        });
                        return true;
                    }
                    updateQuery = 'UPDATE proposals SET file_id = $1, file_type = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3';
                    updateParams = [newFileId, newFileType, propId];
                    prop.file_id = newFileId;
                    prop.file_type = newFileType;
                }

                await db.query(updateQuery, updateParams);

                if (prop.message_id && prop.chat_id) {
                    const userRes = await db.query('SELECT first_name, last_name, username FROM users WHERE id = $1', [prop.user_id]);
                    const u = userRes.rows[0];
                    const fullName = [u.first_name, u.last_name].filter(Boolean).join(' ') || u.username || 'Unknown';
                    const typeName = getProposalTypeName(prop.type);

                    let reportText = `📝 *ĐỀ XUẤT MỚI: ${prop.proposal_code}*\n\n`;
                    reportText += `👤 *Người đề xuất:* ${fullName} ${u.username ? `(@${u.username})` : ''}\n`;
                    reportText += `🏷 *Loại:* ${typeName}\n`;
                    reportText += `📅 *Ngày tạo:* ${new Date(prop.created_at).toLocaleString('vi-VN')}\n`;
                    reportText += `*(Đã chỉnh sửa)*\n\n`;
                    reportText += `📄 *Nội dung:*\n${prop.content}\n\n`;
                    if (prop.apply_time) reportText += `🕒 *Thời gian áp dụng:* ${prop.apply_time}\n`;
                    if (prop.cost) reportText += `💰 *Dự trù chi phí:* ${prop.cost}\n`;

                    const keyboard: InlineKeyboardButton[][] = [
                        [
                            { text: '✅ Duyệt', callback_data: `prop_approve_${prop.id}` },
                            { text: '❌ Từ chối', callback_data: `prop_reject_${prop.id}` }
                        ]
                    ];

                    if (field === 'file') {
                        bot.deleteMessage(prop.chat_id, prop.message_id).catch(() => { });
                        let sentMsg;
                        if (prop.file_type === 'photo') {
                            sentMsg = await bot.sendPhoto(prop.chat_id, prop.file_id, { caption: reportText, parse_mode: 'Markdown', message_thread_id: prop.topic_id || undefined, reply_markup: { inline_keyboard: keyboard } });
                        } else {
                            sentMsg = await bot.sendDocument(prop.chat_id, prop.file_id, { caption: reportText, parse_mode: 'Markdown', message_thread_id: prop.topic_id || undefined, reply_markup: { inline_keyboard: keyboard } });
                        }
                        await db.query('UPDATE proposals SET message_id = $1 WHERE id = $2', [sentMsg.message_id, prop.id]);
                    } else {
                        if (prop.file_id) {
                            bot.editMessageCaption(reportText, { chat_id: prop.chat_id, message_id: prop.message_id, parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } }).catch(console.error);
                        } else {
                            bot.editMessageText(reportText, { chat_id: prop.chat_id, message_id: prop.message_id, parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } }).catch(console.error);
                        }
                    }
                }

                bot.sendMessage(chatId, '✅ Đã cập nhật đề xuất thành công!').then(m => setTimeout(() => bot.deleteMessage(chatId, m.message_id).catch(() => { }), 5000));

                if (session.tempData.viewMessageId) {
                    bot.deleteMessage(chatId, session.tempData.viewMessageId).catch(() => { });
                    const fakeQuery = {
                        id: 'fake',
                        from: msg.from,
                        message: { chat: { id: chatId }, message_id: session.tempData.viewMessageId }
                    } as TelegramBot.CallbackQuery;
                    await handleProposalCallback(bot, fakeQuery, `prop_view_${propId}`, 'user', session);
                }

            } catch (err) {
                console.error('Error updating proposal:', err);
                bot.sendMessage(chatId, '❌ Có lỗi xảy ra khi cập nhật đề xuất.');
            }

            clearSession(userId);
            return true;
        }

        case 'rejecting_proposal': {
            if (session.tempData.promptMessageId) bot.deleteMessage(chatId, session.tempData.promptMessageId).catch(() => { });
            bot.deleteMessage(chatId, msg.message_id).catch(() => { });

            const propId = session.tempData.proposalId;
            const rejectReason = text;

            try {
                await db.query(
                    "UPDATE proposals SET status = 'REJECTED', admin_id = $1, reject_reason = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3",
                    [userId, rejectReason, propId]
                );

                const propRes = await db.query('SELECT p.*, u.first_name, u.last_name, u.username FROM proposals p JOIN users u ON p.user_id = u.id WHERE p.id = $1', [propId]);
                const prop = propRes.rows[0];

                // Notify user
                const typeName = getProposalTypeName(prop.type);
                bot.sendMessage(prop.user_id, `❌ *ĐỀ XUẤT BỊ TỪ CHỐI*\n\nĐề xuất [${prop.proposal_code}] - ${typeName} của bạn đã bị từ chối.\n\n*Lý do:* ${rejectReason}`, { parse_mode: 'Markdown' });

                // Update group message
                if (prop.message_id && prop.chat_id) {
                    const adminName = [msg.from?.first_name, msg.from?.last_name].filter(Boolean).join(' ') || msg.from?.username || 'Admin';
                    const timeStr = new Date().toLocaleString('vi-VN');

                    const fullName = [prop.first_name, prop.last_name].filter(Boolean).join(' ') || prop.username || 'Nhân viên';

                    let updatedText = `📝 *ĐỀ XUẤT MỚI: ${prop.proposal_code}*\n\n`;
                    updatedText += `👤 *Người đề xuất:* ${fullName}\n`;
                    updatedText += `🏷 *Loại:* ${typeName}\n`;
                    updatedText += `📅 *Ngày tạo:* ${new Date(prop.created_at).toLocaleString('vi-VN')}\n\n`;
                    updatedText += `📄 *Nội dung:*\n${prop.content}\n\n`;
                    if (prop.apply_time) updatedText += `🕒 *Thời gian áp dụng:* ${prop.apply_time}\n`;
                    if (prop.cost) updatedText += `💰 *Dự trù chi phí:* ${prop.cost}\n\n`;

                    updatedText += `➖➖➖➖➖➖➖➖➖➖\n`;
                    updatedText += `Trạng thái: ❌ *ĐÃ TỪ CHỐI*\n`;
                    updatedText += `Người duyệt: ${adminName} lúc ${timeStr}\n`;
                    updatedText += `Lý do: ${rejectReason}`;

                    if (prop.file_id) {
                        bot.editMessageCaption(updatedText, {
                            chat_id: prop.chat_id,
                            message_id: prop.message_id,
                            parse_mode: 'Markdown'
                        }).catch(console.error);
                    } else {
                        bot.editMessageText(updatedText, {
                            chat_id: prop.chat_id,
                            message_id: prop.message_id,
                            parse_mode: 'Markdown'
                        }).catch(console.error);
                    }
                }

                bot.sendMessage(chatId, `✅ Đã từ chối đề xuất ${prop.proposal_code}.`);
            } catch (err) {
                console.error('Error rejecting proposal:', err);
                bot.sendMessage(chatId, '❌ Có lỗi xảy ra khi từ chối đề xuất.');
            }

            clearSession(userId);
            return true;
        }
    }

    return false;
}

export async function handleProposalCallback(
    bot: TelegramBot,
    query: TelegramBot.CallbackQuery,
    data: string,
    userRole: string,
    session: any
): Promise<boolean> {
    const chatId = query.message?.chat.id;
    const userId = query.from.id;
    const messageId = query.message?.message_id;

    if (!chatId) return false;

    if (data.startsWith('prop_type_')) {
        const type = data.replace('prop_type_', '');
        bot.deleteMessage(chatId, messageId!).catch(() => { });

        bot.sendMessage(chatId, '✍️ *Bước 2: Nội dung chi tiết*\n\nVui lòng nhập nội dung đề xuất của bạn:', { parse_mode: 'Markdown' })
            .then(m => {
                updateSession(userId, {
                    state: 'creating_proposal_content',
                    tempData: { type, promptMessageId: m.message_id }
                });
            });
        bot.answerCallbackQuery(query.id);
        return true;
    }

    if (data === 'prop_skip_time') {
        bot.deleteMessage(chatId, messageId!).catch(() => { });
        const keyboardCost = [[{ text: '⏭ Bỏ qua', callback_data: 'prop_skip_cost' }]];
        bot.sendMessage(chatId, '💰 *Bước 4: Dự trù chi phí*\n\nNhập dự trù chi phí (nếu có) hoặc bấm Bỏ qua (ví dụ: 1.500.000 vnd hoặc $77):', {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: keyboardCost }
        }).then(m => {
            updateSession(userId, {
                state: 'creating_proposal_cost',
                tempData: { ...session.tempData, apply_time: null, promptMessageId: m.message_id }
            });
        });
        bot.answerCallbackQuery(query.id);
        return true;
    }

    if (data === 'prop_skip_cost') {
        bot.deleteMessage(chatId, messageId!).catch(() => { });
        const keyboardFile = [[{ text: '⏭ Bỏ qua', callback_data: 'prop_skip_file' }]];
        bot.sendMessage(chatId, '📎 *Bước 5: File đính kèm*\n\nGửi 1 file/ảnh đính kèm (báo giá, tài liệu...) hoặc bấm Bỏ qua:', {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: keyboardFile }
        }).then(m => {
            updateSession(userId, {
                state: 'creating_proposal_file',
                tempData: { ...session.tempData, cost: null, promptMessageId: m.message_id }
            });
        });
        bot.answerCallbackQuery(query.id);
        return true;
    }

    if (data === 'prop_skip_file') {
        bot.deleteMessage(chatId, messageId!).catch(() => { });
        await showProposalPreview(bot, chatId, userId, { ...session.tempData, file_id: null, file_type: null }, query.from);
        bot.answerCallbackQuery(query.id);
        return true;
    }

    if (data === 'prop_confirm_send') {
        bot.deleteMessage(chatId, messageId!).catch(() => { });

        try {
            // Find admin group (topic discussion or main group)
            // First look for a proposal topic, then fallback to report or discussion
            let groupRes = await db.query("SELECT chat_id, topic_id FROM topics WHERE feature_type = 'proposal' LIMIT 1");

            if (groupRes.rows.length === 0) {
                groupRes = await db.query("SELECT chat_id, topic_id FROM topics WHERE feature_type = 'report' OR feature_type = 'discussion' LIMIT 1");
            }

            if (groupRes.rows.length === 0) {
                bot.sendMessage(chatId, '❌ Không tìm thấy nhóm Admin để gửi đề xuất. Vui lòng liên hệ Admin cấu hình bot.');
                return true;
            }

            const targetChatId = groupRes.rows[0].chat_id;
            const targetTopicId = groupRes.rows[0].topic_id;

            // Generate Proposal Code
            const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
            const countRes = await db.query("SELECT COUNT(*) FROM proposals WHERE created_at::date = CURRENT_DATE");
            const count = parseInt(countRes.rows[0].count) + 1;
            const proposalCode = `DX-${dateStr}-${count.toString().padStart(3, '0')}`;

            const { type, content, apply_time, cost, file_id, file_type } = session.tempData;
            const fullName = [query.from.first_name, query.from.last_name].filter(Boolean).join(' ') || query.from.username || 'Unknown';

            // Insert to DB
            const insertRes = await db.query(`
        INSERT INTO proposals (proposal_code, user_id, chat_id, topic_id, type, content, apply_time, cost, file_id, file_type)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id
      `, [proposalCode, userId, targetChatId, targetTopicId, type, content, apply_time, cost, file_id, file_type]);

            const propId = insertRes.rows[0].id;
            const typeName = getProposalTypeName(type);

            let reportText = `📝 *ĐỀ XUẤT MỚI: ${proposalCode}*\n\n`;
            reportText += `👤 *Người đề xuất:* ${fullName} ${query.from.username ? `(@${query.from.username})` : ''}\n`;
            reportText += `🏷 *Loại:* ${typeName}\n`;
            reportText += `📅 *Ngày tạo:* ${new Date().toLocaleString('vi-VN')}\n\n`;
            reportText += `📄 *Nội dung:*\n${content}\n\n`;
            if (apply_time) reportText += `🕒 *Thời gian áp dụng:* ${apply_time}\n`;
            if (cost) reportText += `💰 *Dự trù chi phí:* ${cost}\n`;

            const keyboard: InlineKeyboardButton[][] = [
                [
                    { text: '✅ Duyệt', callback_data: `prop_approve_${propId}` },
                    { text: '❌ Từ chối', callback_data: `prop_reject_${propId}` }
                ]
            ];

            let sentMsg;
            if (file_id) {
                if (file_type === 'photo') {
                    sentMsg = await bot.sendPhoto(targetChatId, file_id, { caption: reportText, parse_mode: 'Markdown', message_thread_id: targetTopicId || undefined, reply_markup: { inline_keyboard: keyboard } });
                } else {
                    sentMsg = await bot.sendDocument(targetChatId, file_id, { caption: reportText, parse_mode: 'Markdown', message_thread_id: targetTopicId || undefined, reply_markup: { inline_keyboard: keyboard } });
                }
            } else {
                sentMsg = await bot.sendMessage(targetChatId, reportText, { parse_mode: 'Markdown', message_thread_id: targetTopicId || undefined, reply_markup: { inline_keyboard: keyboard } });
            }

            // Update message_id in DB
            await db.query('UPDATE proposals SET message_id = $1 WHERE id = $2', [sentMsg.message_id, propId]);

            bot.sendMessage(chatId, `✅ *Gửi đề xuất thành công!*\n\nMã đề xuất của bạn là: *${proposalCode}*. Bot sẽ thông báo cho bạn khi có kết quả duyệt.`, { parse_mode: 'Markdown' });
            clearSession(userId);

        } catch (err) {
            console.error('Error saving proposal:', err);
            bot.sendMessage(chatId, '❌ Có lỗi xảy ra khi lưu đề xuất. Vui lòng thử lại sau.');
        }

        bot.answerCallbackQuery(query.id);
        return true;
    }

    if (data === 'prop_cancel_send') {
        bot.deleteMessage(chatId, messageId!).catch(() => { });
        bot.sendMessage(chatId, '❌ Đã hủy tạo đề xuất.');
        clearSession(userId);
        bot.answerCallbackQuery(query.id);
        return true;
    }

    if (data.startsWith('prop_approve_')) {
        if (userRole !== 'admin') {
            bot.answerCallbackQuery(query.id, { text: '❌ Chỉ Admin mới có quyền duyệt đề xuất.', show_alert: true });
            return true;
        }

        const propId = data.replace('prop_approve_', '');

        try {
            const checkRes = await db.query('SELECT status FROM proposals WHERE id = $1', [propId]);
            if (checkRes.rows.length === 0 || checkRes.rows[0].status !== 'PENDING') {
                bot.answerCallbackQuery(query.id, { text: '⚠️ Đề xuất này đã được xử lý hoặc không tồn tại.', show_alert: true });
                return true;
            }

            await db.query(
                "UPDATE proposals SET status = 'APPROVED', admin_id = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2",
                [userId, propId]
            );

            const propRes = await db.query('SELECT p.*, u.first_name, u.last_name, u.username FROM proposals p JOIN users u ON p.user_id = u.id WHERE p.id = $1', [propId]);
            const prop = propRes.rows[0];

            // Notify user
            const typeName = getProposalTypeName(prop.type);
            bot.sendMessage(prop.user_id, `🎉 *ĐỀ XUẤT ĐÃ ĐƯỢC DUYỆT*\n\nĐề xuất [${prop.proposal_code}] - ${typeName} của bạn đã được duyệt!`, { parse_mode: 'Markdown' });

            // Update group message
            const adminName = [query.from.first_name, query.from.last_name].filter(Boolean).join(' ') || query.from.username || 'Admin';
            const timeStr = new Date().toLocaleString('vi-VN');
            const fullName = [prop.first_name, prop.last_name].filter(Boolean).join(' ') || prop.username || 'Nhân viên';

            let updatedText = `📝 *ĐỀ XUẤT MỚI: ${prop.proposal_code}*\n\n`;
            updatedText += `👤 *Người đề xuất:* ${fullName}\n`;
            updatedText += `🏷 *Loại:* ${typeName}\n`;
            updatedText += `📅 *Ngày tạo:* ${new Date(prop.created_at).toLocaleString('vi-VN')}\n\n`;
            updatedText += `📄 *Nội dung:*\n${prop.content}\n\n`;
            if (prop.apply_time) updatedText += `🕒 *Thời gian áp dụng:* ${prop.apply_time}\n`;
            if (prop.cost) updatedText += `💰 *Dự trù chi phí:* ${prop.cost}\n\n`;

            updatedText += `➖➖➖➖➖➖➖➖➖➖\n`;
            updatedText += `Trạng thái: ✅ *ĐÃ DUYỆT*\n`;
            updatedText += `Người duyệt: ${adminName} lúc ${timeStr}`;

            // Update the group message
            if (prop.message_id && prop.chat_id) {
                if (prop.file_id) {
                    bot.editMessageCaption(updatedText, {
                        chat_id: prop.chat_id,
                        message_id: prop.message_id,
                        parse_mode: 'Markdown'
                    }).catch(console.error);
                } else {
                    bot.editMessageText(updatedText, {
                        chat_id: prop.chat_id,
                        message_id: prop.message_id,
                        parse_mode: 'Markdown'
                    }).catch(console.error);
                }
            }

            // If the action was taken from private chat (e.g., admin dashboard), update that message too
            if (chatId.toString() !== prop.chat_id.toString()) {
                if (query.message?.caption) {
                    bot.editMessageCaption(updatedText, {
                        chat_id: chatId,
                        message_id: messageId,
                        parse_mode: 'Markdown'
                    }).catch(console.error);
                } else {
                    bot.editMessageText(updatedText, {
                        chat_id: chatId,
                        message_id: messageId,
                        parse_mode: 'Markdown'
                    }).catch(console.error);
                }
            }

            bot.answerCallbackQuery(query.id, { text: '✅ Đã duyệt đề xuất!' });
        } catch (err) {
            console.error('Error approving proposal:', err);
            bot.answerCallbackQuery(query.id, { text: '❌ Có lỗi xảy ra.', show_alert: true });
        }
        return true;
    }

    if (data.startsWith('prop_reject_')) {
        if (userRole !== 'admin') {
            bot.answerCallbackQuery(query.id, { text: '❌ Chỉ Admin mới có quyền từ chối đề xuất.', show_alert: true });
            return true;
        }

        const propId = data.replace('prop_reject_', '');

        try {
            const checkRes = await db.query('SELECT status, proposal_code FROM proposals WHERE id = $1', [propId]);
            if (checkRes.rows.length === 0 || checkRes.rows[0].status !== 'PENDING') {
                bot.answerCallbackQuery(query.id, { text: '⚠️ Đề xuất này đã được xử lý hoặc không tồn tại.', show_alert: true });
                return true;
            }

            const proposalCode = checkRes.rows[0].proposal_code;

            // Delete the message with the approve/reject buttons if it's in private chat
            if (chatId.toString() === userId.toString()) {
                bot.deleteMessage(chatId, messageId!).catch(() => { });
            }

            bot.sendMessage(userId, `✍️ Vui lòng nhập lý do từ chối cho đề xuất **${proposalCode}**:`, { parse_mode: 'Markdown' }).then(m => {
                updateSession(userId, {
                    state: 'rejecting_proposal',
                    tempData: { proposalId: propId, promptMessageId: m.message_id }
                });
            }).catch(() => {
                bot.answerCallbackQuery(query.id, { text: '❌ Không thể gửi tin nhắn riêng cho bạn. Vui lòng chat với bot trước.', show_alert: true });
            });

            bot.answerCallbackQuery(query.id, { text: 'Vui lòng kiểm tra tin nhắn riêng với bot để nhập lý do.' });
        } catch (err) {
            console.error(err);
            bot.answerCallbackQuery(query.id, { text: '❌ Có lỗi xảy ra.', show_alert: true });
        }

        return true;
    }

    if (data.startsWith('prop_view_')) {
        const propId = data.replace('prop_view_', '');
        const propRes = await db.query('SELECT * FROM proposals WHERE id = $1', [propId]);

        if (propRes.rows.length === 0) {
            bot.answerCallbackQuery(query.id, { text: '❌ Không tìm thấy đề xuất.', show_alert: true });
            return true;
        }

        const prop = propRes.rows[0];
        const typeName = getProposalTypeName(prop.type);

        let statusStr = '⏳ Chờ duyệt';
        if (prop.status === 'APPROVED') statusStr = '✅ Đã duyệt';
        if (prop.status === 'REJECTED') statusStr = '❌ Từ chối';

        let text = `📄 *CHI TIẾT ĐỀ XUẤT: ${prop.proposal_code}*\n\n`;
        text += `🏷 *Loại:* ${typeName}\n`;
        text += `📅 *Ngày tạo:* ${new Date(prop.created_at).toLocaleString('vi-VN')}\n`;
        text += `📊 *Trạng thái:* ${statusStr}\n\n`;
        text += `📝 *Nội dung:*\n${prop.content}\n\n`;
        if (prop.apply_time) text += `🕒 *Thời gian áp dụng:* ${prop.apply_time}\n`;
        if (prop.cost) text += `💰 *Dự trù chi phí:* ${prop.cost}\n`;

        if (prop.status === 'REJECTED' && prop.reject_reason) {
            text += `\n⚠️ *Lý do từ chối:* ${prop.reject_reason}\n`;
        }

        const keyboard: InlineKeyboardButton[][] = [];

        if (userRole === 'admin' && prop.status === 'PENDING') {
            keyboard.push([
                { text: '✅ Duyệt', callback_data: `prop_approve_${prop.id}` },
                { text: '❌ Từ chối', callback_data: `prop_reject_${prop.id}` }
            ]);
        }

        if (userId.toString() === prop.user_id.toString() && prop.status === 'PENDING') {
            keyboard.push([
                { text: '✏️ Chỉnh sửa', callback_data: `prop_edit_menu_${prop.id}` },
                { text: '↩️ Thu hồi', callback_data: `prop_recall_${prop.id}` }
            ]);
        }

        keyboard.push([{ text: '🔙 Quay lại danh sách', callback_data: 'prop_close_temp' }]);

        if (prop.file_id) {
            if (prop.file_type === 'photo') {
                bot.sendPhoto(chatId, prop.file_id, { caption: text, parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } });
            } else {
                bot.sendDocument(chatId, prop.file_id, { caption: text, parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } });
            }
        } else {
            bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } });
        }

        bot.answerCallbackQuery(query.id);
        return true;
    }

    if (data.startsWith('prop_recall_')) {
        const propId = data.replace('prop_recall_', '');
        try {
            const checkRes = await db.query('SELECT status, message_id, chat_id FROM proposals WHERE id = $1 AND user_id = $2', [propId, userId]);
            if (checkRes.rows.length === 0 || checkRes.rows[0].status !== 'PENDING') {
                bot.answerCallbackQuery(query.id, { text: '⚠️ Đề xuất này đã được xử lý hoặc không thể thu hồi.', show_alert: true });
                return true;
            }

            const prop = checkRes.rows[0];
            await db.query("UPDATE proposals SET status = 'RECALLED', updated_at = CURRENT_TIMESTAMP WHERE id = $1", [propId]);

            if (prop.message_id && prop.chat_id) {
                const text = '❌ *Đề xuất đã được người gửi thu hồi.*';
                bot.editMessageText(text, { chat_id: prop.chat_id, message_id: prop.message_id, parse_mode: 'Markdown' }).catch(() => {
                    bot.editMessageCaption(text, { chat_id: prop.chat_id, message_id: prop.message_id, parse_mode: 'Markdown' }).catch(() => { });
                });
            }

            bot.editMessageText('✅ Đã thu hồi đề xuất thành công.', { chat_id: chatId, message_id: messageId }).catch(() => { });
            bot.answerCallbackQuery(query.id, { text: '✅ Đã thu hồi đề xuất!' });
        } catch (err) {
            console.error(err);
            bot.answerCallbackQuery(query.id, { text: '❌ Có lỗi xảy ra.', show_alert: true });
        }
        return true;
    }

    if (data.startsWith('prop_edit_back_')) {
        const propId = data.replace('prop_edit_back_', '');
        const propRes = await db.query('SELECT * FROM proposals WHERE id = $1', [propId]);
        if (propRes.rows.length > 0) {
            const prop = propRes.rows[0];
            const keyboard: InlineKeyboardButton[][] = [];
            if (userRole === 'admin' && prop.status === 'PENDING') {
                keyboard.push([
                    { text: '✅ Duyệt', callback_data: `prop_approve_${prop.id}` },
                    { text: '❌ Từ chối', callback_data: `prop_reject_${prop.id}` }
                ]);
            }
            if (userId.toString() === prop.user_id.toString() && prop.status === 'PENDING') {
                keyboard.push([
                    { text: '✏️ Chỉnh sửa', callback_data: `prop_edit_menu_${prop.id}` },
                    { text: '↩️ Thu hồi', callback_data: `prop_recall_${prop.id}` }
                ]);
            }
            keyboard.push([{ text: '🔙 Quay lại danh sách', callback_data: 'prop_close_temp' }]);
            bot.editMessageReplyMarkup({ inline_keyboard: keyboard }, { chat_id: chatId, message_id: messageId }).catch(() => { });
        }
        bot.answerCallbackQuery(query.id);
        return true;
    }

    if (data.startsWith('prop_edit_menu_')) {
        const propId = data.replace('prop_edit_menu_', '');
        const keyboard: InlineKeyboardButton[][] = [
            [{ text: '📝 Sửa Nội dung', callback_data: `prop_edit_field_content_${propId}` }],
            [{ text: '🕒 Sửa Thời gian', callback_data: `prop_edit_field_time_${propId}` }],
            [{ text: '💰 Sửa Chi phí', callback_data: `prop_edit_field_cost_${propId}` }],
            [{ text: '📎 Sửa File đính kèm', callback_data: `prop_edit_field_file_${propId}` }],
            [{ text: '🔙 Quay lại', callback_data: `prop_edit_back_${propId}` }]
        ];
        bot.editMessageReplyMarkup({ inline_keyboard: keyboard }, { chat_id: chatId, message_id: messageId }).catch(() => { });
        bot.answerCallbackQuery(query.id);
        return true;
    }

    if (data.startsWith('prop_edit_field_')) {
        const parts = data.split('_');
        const field = parts[3];
        const propId = parts[4];

        let promptText = '';
        if (field === 'content') promptText = '📝 Vui lòng nhập *Nội dung* mới cho đề xuất:';
        if (field === 'time') promptText = '🕒 Vui lòng nhập *Thời gian áp dụng* mới (DD/MM/YYYY):';
        if (field === 'cost') promptText = '💰 Vui lòng nhập *Dự trù chi phí* mới:';
        if (field === 'file') promptText = '📎 Vui lòng gửi *File/Ảnh đính kèm* mới:';

        bot.sendMessage(chatId, promptText, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: [[{ text: '❌ Hủy', callback_data: `prop_edit_cancel_${propId}` }]] }
        }).then(m => {
            updateSession(userId, {
                state: `editing_proposal_${field}` as any,
                tempData: { proposalId: propId, promptMessageId: m.message_id, viewMessageId: messageId }
            });
        });
        bot.answerCallbackQuery(query.id);
        return true;
    }

    if (data.startsWith('prop_edit_cancel_')) {
        const propId = data.split('_')[3];
        bot.deleteMessage(chatId, messageId).catch(() => { });
        const viewMessageId = session.tempData?.viewMessageId;
        if (viewMessageId) {
            const propRes = await db.query('SELECT * FROM proposals WHERE id = $1', [propId]);
            if (propRes.rows.length > 0) {
                const prop = propRes.rows[0];
                const keyboard: InlineKeyboardButton[][] = [];
                if (userRole === 'admin' && prop.status === 'PENDING') {
                    keyboard.push([
                        { text: '✅ Duyệt', callback_data: `prop_approve_${prop.id}` },
                        { text: '❌ Từ chối', callback_data: `prop_reject_${prop.id}` }
                    ]);
                }
                if (userId.toString() === prop.user_id.toString() && prop.status === 'PENDING') {
                    keyboard.push([
                        { text: '✏️ Chỉnh sửa', callback_data: `prop_edit_menu_${prop.id}` },
                        { text: '↩️ Thu hồi', callback_data: `prop_recall_${prop.id}` }
                    ]);
                }
                keyboard.push([{ text: '🔙 Quay lại danh sách', callback_data: 'prop_close_temp' }]);
                bot.editMessageReplyMarkup({ inline_keyboard: keyboard }, { chat_id: chatId, message_id: viewMessageId }).catch(() => { });
            }
        }
        clearSession(userId);
        bot.answerCallbackQuery(query.id, { text: '✅ Đã hủy chỉnh sửa.' });
        return true;
    }

    if (data === 'prop_close_temp') {
        bot.deleteMessage(chatId, messageId!).catch(() => { });

        // Send the proposal list again to ensure they see it
        if (userRole === 'admin') {
            const keyboard: InlineKeyboardButton[][] = [
                [{ text: '⏳ Chờ duyệt', callback_data: 'prop_admin_filter_PENDING' }],
                [{ text: '✅ Đã duyệt', callback_data: 'prop_admin_filter_APPROVED' }],
                [{ text: '❌ Từ chối', callback_data: 'prop_admin_filter_REJECTED' }],
                [{ text: '👤 Lọc theo User', callback_data: 'prop_admin_filter_user' }],
                [{ text: '🔙 Quay lại Menu Admin', callback_data: 'admin_dashboard' }]
            ];
            bot.sendMessage(chatId, '📋 *QUẢN LÝ ĐỀ XUẤT*\n\nChọn bộ lọc để xem danh sách đề xuất:', {
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: keyboard }
            });
        } else {
            const res = await db.query(
                'SELECT id, proposal_code, type, status, created_at FROM proposals WHERE user_id = $1 ORDER BY created_at DESC LIMIT 10',
                [userId]
            );
            if (res.rows.length > 0) {
                const keyboard = res.rows.map(r => {
                    let statusEmoji = '⏳';
                    if (r.status === 'APPROVED') statusEmoji = '✅';
                    if (r.status === 'REJECTED') statusEmoji = '❌';
                    let typeName = '';
                    if (r.type === 'cost') typeName = 'Chi phí';
                    if (r.type === 'work') typeName = 'Công việc';
                    if (r.type === 'policy') typeName = 'Nội quy';
                    if (r.type === 'tool') typeName = 'Công cụ';
                    return [{
                        text: `${statusEmoji} [${r.proposal_code}] ${typeName} (${new Date(r.created_at).toLocaleDateString('vi-VN')})`,
                        callback_data: `prop_view_${r.id}`
                    }];
                });
                keyboard.push([{ text: '🔙 Quay lại Menu', callback_data: 'user_dashboard' }]);
                bot.sendMessage(chatId, '📋 *LỊCH SỬ ĐỀ XUẤT CỦA BẠN:*', {
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: keyboard }
                });
            }
        }

        bot.answerCallbackQuery(query.id);
        return true;
    }

    if (data.startsWith('prop_admin_filter_')) {
        if (userRole !== 'admin') return true;

        const filter = data.replace('prop_admin_filter_', '');
        let queryStr = '';
        let params: any[] = [];
        let title = '';

        if (filter === 'user') {
            // For simplicity, just list users who have proposals
            const usersRes = await db.query('SELECT DISTINCT u.id, u.first_name, u.username FROM users u JOIN proposals p ON u.id = p.user_id');
            if (usersRes.rows.length === 0) {
                bot.answerCallbackQuery(query.id, { text: '⚠️ Chưa có ai tạo đề xuất.', show_alert: true });
                return true;
            }

            const keyboard = usersRes.rows.map(u => [{
                text: `👤 ${u.first_name || u.username}`,
                callback_data: `prop_admin_user_${u.id}`
            }]);
            keyboard.push([{ text: '🔙 Quay lại', callback_data: 'prop_admin_back' }]);

            bot.editMessageText('👤 *LỌC THEO NGƯỜI DÙNG*\n\nChọn người dùng để xem đề xuất:', {
                chat_id: chatId,
                message_id: messageId,
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: keyboard }
            }).catch(() => { });
            bot.answerCallbackQuery(query.id);
            return true;
        } else {
            queryStr = 'SELECT id, proposal_code, type, created_at FROM proposals WHERE status = $1 ORDER BY created_at DESC LIMIT 20';
            params = [filter];
            if (filter === 'PENDING') title = '⏳ ĐỀ XUẤT CHỜ DUYỆT';
            if (filter === 'APPROVED') title = '✅ ĐỀ XUẤT ĐÃ DUYỆT';
            if (filter === 'REJECTED') title = '❌ ĐỀ XUẤT TỪ CHỐI';
        }

        const res = await db.query(queryStr, params);

        if (res.rows.length === 0) {
            bot.answerCallbackQuery(query.id, { text: '⚠️ Không có đề xuất nào trong mục này.', show_alert: true });
            return true;
        }

        const keyboard = res.rows.map(r => [{
            text: `[${r.proposal_code}] ${getProposalTypeName(r.type)} (${new Date(r.created_at).toLocaleDateString('vi-VN')})`,
            callback_data: `prop_view_${r.id}`
        }]);
        keyboard.push([{ text: '🔙 Quay lại', callback_data: 'prop_admin_back' }]);

        bot.editMessageText(`📋 *${title}*`, {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: keyboard }
        }).catch(() => { });

        bot.answerCallbackQuery(query.id);
        return true;
    }

    if (data.startsWith('prop_admin_user_')) {
        if (userRole !== 'admin') return true;
        const targetUserId = data.replace('prop_admin_user_', '');

        const res = await db.query('SELECT id, proposal_code, type, status, created_at FROM proposals WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20', [targetUserId]);

        if (res.rows.length === 0) {
            bot.answerCallbackQuery(query.id, { text: '⚠️ Người dùng này chưa có đề xuất nào.', show_alert: true });
            return true;
        }

        const keyboard = res.rows.map(r => {
            let statusEmoji = '⏳';
            if (r.status === 'APPROVED') statusEmoji = '✅';
            if (r.status === 'REJECTED') statusEmoji = '❌';
            return [{
                text: `${statusEmoji} [${r.proposal_code}] ${getProposalTypeName(r.type)}`,
                callback_data: `prop_view_${r.id}`
            }];
        });
        keyboard.push([{ text: '🔙 Quay lại', callback_data: 'prop_admin_filter_user' }]);

        bot.editMessageText(`📋 *ĐỀ XUẤT CỦA NGƯỜI DÙNG*`, {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: keyboard }
        }).catch(() => { });

        bot.answerCallbackQuery(query.id);
        return true;
    }

    if (data === 'prop_admin_back') {
        const keyboard: InlineKeyboardButton[][] = [
            [{ text: '⏳ Chờ duyệt', callback_data: 'prop_admin_filter_PENDING' }],
            [{ text: '✅ Đã duyệt', callback_data: 'prop_admin_filter_APPROVED' }],
            [{ text: '❌ Từ chối', callback_data: 'prop_admin_filter_REJECTED' }],
            [{ text: '👤 Lọc theo User', callback_data: 'prop_admin_filter_user' }],
            [{ text: '🔙 Quay lại Menu Admin', callback_data: 'admin_dashboard' }]
        ];

        bot.editMessageText('📋 *QUẢN LÝ ĐỀ XUẤT*\n\nChọn bộ lọc để xem danh sách đề xuất:', {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: keyboard }
        }).catch(() => { });
        bot.answerCallbackQuery(query.id);
        return true;
    }

    return false;
}

function getProposalTypeName(type: string): string {
    if (type === 'cost') return 'Chi phí';
    if (type === 'work') return 'Công việc';
    if (type === 'policy') return 'Nội quy - Chính sách';
    if (type === 'tool') return 'Công cụ - Thiết bị';
    return 'Khác';
}

async function showProposalPreview(bot: TelegramBot, chatId: number, userId: number, data: any, user: TelegramBot.User) {
    const typeName = getProposalTypeName(data.type);
    const fullName = [user.first_name, user.last_name].filter(Boolean).join(' ') || user.username || 'Unknown';

    let previewText = `📑 *XEM TRƯỚC ĐỀ XUẤT*\n\n`;
    previewText += `👤 *Người đề xuất:* ${fullName}\n`;
    previewText += `🏷 *Loại:* ${typeName}\n\n`;
    previewText += `📝 *Nội dung:*\n${data.content}\n\n`;
    if (data.apply_time) previewText += `🕒 *Thời gian áp dụng:* ${data.apply_time}\n`;
    if (data.cost) previewText += `💰 *Dự trù chi phí:* ${data.cost}\n`;
    if (data.file_id) previewText += `📎 *Đính kèm:* 1 file\n`;

    const keyboard = [
        [
            { text: '🚀 Gửi đề xuất', callback_data: 'prop_confirm_send' },
            { text: '❌ Hủy bỏ', callback_data: 'prop_cancel_send' }
        ]
    ];

    updateSession(userId, {
        state: 'idle',
        tempData: data
    });

    if (data.file_id) {
        if (data.file_type === 'photo') {
            await bot.sendPhoto(chatId, data.file_id, { caption: previewText, parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } });
        } else {
            await bot.sendDocument(chatId, data.file_id, { caption: previewText, parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } });
        }
    } else {
        await bot.sendMessage(chatId, previewText, {
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: keyboard }
        });
    }
}
