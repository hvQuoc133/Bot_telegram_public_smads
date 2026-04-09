import TelegramBot from 'node-telegram-bot-api';
import { db } from '../../db';
import { updateSession, clearSession, roleCache, getSession } from '../services/sessionManager';
import { botUsername } from '../botInstance';
import { setAdminPrivateCommands, removeAdminPrivateCommands } from '../utils/setupCommands';

async function isUserInGroup(bot: TelegramBot, chatId: number, userId: number): Promise<boolean> {
    if (chatId > 0) return true; // Private chat
    try {
        const member = await bot.getChatMember(chatId, userId);
        return ['creator', 'administrator', 'member', 'restricted'].includes(member.status);
    } catch (err) {
        return false; // User not found or bot lacks permissions
    }
}

export async function processAdminAction(
    bot: TelegramBot,
    chatId: number,
    messageId: number,
    action: 'add' | 'remove',
    usernames: string[],
    replyOptions: TelegramBot.SendMessageOptions,
    currentUserId: number,
    replyToUserId?: number,
    replyToName?: string,
    replyToUsername?: string,
    promptMessageId?: number
) {
    let results: string[] = [];

    // Process reply first
    if (replyToUserId) {
        try {
            if (action === 'remove' && replyToUserId === currentUserId) {
                results.push(`⚠️ Bạn không thể tự xóa quyền Admin của chính mình.`);
            } else {
                const inGroup = await isUserInGroup(bot, chatId, replyToUserId);
                if (!inGroup && chatId < 0) {
                    results.push(`⚠️ ${replyToName} không có mặt trong nhóm này.`);
                } else {
                    const targetUserRes = await db.query('SELECT role FROM users WHERE id = $1', [replyToUserId]);
                    const currentRole = targetUserRes.rows.length > 0 ? targetUserRes.rows[0].role : 'user';

                    if (action === 'add') {
                        if (currentRole === 'admin') {
                            results.push(`⚠️ ${replyToName} đã là Admin từ trước rồi.`);
                        } else {
                            await db.query(`
                INSERT INTO users (id, username, role) 
                VALUES ($1, $2, 'admin') 
                ON CONFLICT (id) DO UPDATE SET role = 'admin', username = COALESCE(EXCLUDED.username, users.username)
              `, [replyToUserId, replyToUsername || null]);
                            roleCache.delete(replyToUserId);
                            await setAdminPrivateCommands(bot, replyToUserId);
                            results.push(`✅ Đã cấp quyền Admin Bot cho ${replyToName}!`);
                        }
                    } else {
                        if (currentRole !== 'admin') {
                            results.push(`⚠️ ${replyToName} hiện không phải là Admin.`);
                        } else {
                            await db.query("UPDATE users SET role = 'user' WHERE id = $1", [replyToUserId]);
                            roleCache.delete(replyToUserId);
                            await removeAdminPrivateCommands(bot, replyToUserId);
                            results.push(`✅ Đã hủy quyền Admin Bot của ${replyToName}.`);
                        }
                    }
                }
            }
        } catch (err: any) {
            results.push(`❌ Lỗi với ${replyToName}: ` + err.message);
        }
    }

    // Process usernames
    for (const uname of usernames) {
        try {
            const userRes = await db.query('SELECT id, role FROM users WHERE username = $1', [uname]);
            if (userRes.rows.length === 0) {
                results.push(`⚠️ Không tìm thấy @${uname} trong hệ thống bot.`);
                continue;
            }

            const targetId = userRes.rows[0].id;
            const currentRole = userRes.rows[0].role;

            if (action === 'remove' && targetId === currentUserId) {
                results.push(`⚠️ Bạn không thể tự xóa quyền Admin của chính mình (@${uname}).`);
                continue;
            }

            const inGroup = await isUserInGroup(bot, chatId, targetId);
            if (!inGroup && chatId < 0) {
                results.push(`⚠️ @${uname} không có mặt trong nhóm này.`);
                continue;
            }

            if (action === 'add') {
                if (currentRole === 'admin') {
                    results.push(`⚠️ @${uname} đã là Admin từ trước rồi.`);
                } else {
                    await db.query("UPDATE users SET role = 'admin' WHERE id = $1", [targetId]);
                    roleCache.delete(targetId);
                    await setAdminPrivateCommands(bot, targetId);
                    results.push(`✅ Đã cấp quyền Admin Bot cho @${uname}!`);
                }
            } else {
                if (currentRole !== 'admin') {
                    results.push(`⚠️ @${uname} hiện không phải là Admin.`);
                } else {
                    await db.query("UPDATE users SET role = 'user' WHERE id = $1", [targetId]);
                    roleCache.delete(targetId);
                    await removeAdminPrivateCommands(bot, targetId);
                    results.push(`✅ Đã hủy quyền Admin Bot của @${uname}.`);
                }
            }
        } catch (err: any) {
            results.push(`❌ Lỗi với @${uname}: ` + err.message);
        }
    }

    // Get current admin list
    const adminsRes = await db.query("SELECT username, first_name FROM users WHERE role = 'admin'");
    const adminList = adminsRes.rows.map(u => `- ${u.first_name || 'Admin'} ${u.username ? `(@${u.username})` : ''}`).join('\n');
    const finalMessage = `${results.join('\n')}\n\n👥 **Danh sách Admin hiện tại:**\n${adminList}`;

    if (chatId < 0) {
        // If in group, send result to DM and notify in group
        try {
            await bot.sendMessage(currentUserId, finalMessage, { parse_mode: 'Markdown' });
            const replyMsg = await bot.sendMessage(chatId, '✅ Đã xử lý. Vui lòng kiểm tra tin nhắn riêng với bot để xem kết quả.', replyOptions);
            setTimeout(() => {
                bot.deleteMessage(chatId, messageId).catch(() => { });
                if (promptMessageId) {
                    bot.deleteMessage(chatId, promptMessageId).catch(() => { });
                }
                bot.deleteMessage(chatId, replyMsg.message_id).catch(() => { });
            }, 5000);
        } catch (err) {
            // If DM fails (e.g. user blocked bot), send in group
            const replyMsg = await bot.sendMessage(chatId, finalMessage, { ...replyOptions, parse_mode: 'Markdown' });
            setTimeout(() => {
                bot.deleteMessage(chatId, messageId).catch(() => { });
                if (promptMessageId) {
                    bot.deleteMessage(chatId, promptMessageId).catch(() => { });
                }
                bot.deleteMessage(chatId, replyMsg.message_id).catch(() => { });
            }, 10000);
        }
    } else {
        // If already in DM
        if (results.length > 0) {
            await bot.sendMessage(currentUserId, finalMessage, { parse_mode: 'Markdown' });
        }
        bot.deleteMessage(chatId, messageId).catch(() => { });
        if (promptMessageId) {
            bot.deleteMessage(chatId, promptMessageId).catch(() => { });
        }
    }
}

export async function handleAdminDeepLink(
    bot: TelegramBot,
    msg: TelegramBot.Message,
    param: string,
    userRole: string
): Promise<boolean> {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;

    if (!userId) return false;

    if (param === 'admin_dashboard') {
        await handleAdminDashboard(bot, chatId, userRole);
        return true;
    }

    if (param === 'admin_regulations') {
        if (userRole !== 'admin') {
            bot.sendMessage(chatId, '❌ Bạn không có quyền truy cập mục này.').catch(console.error);
            return true;
        }
        // Directly show the manage regulations menu
        const text = `📜 **QUẢN LÝ NỘI QUY**\n\nChọn thao tác bạn muốn thực hiện:`;
        const keyboard = [
            [{ text: '➕ Thêm Nội quy mới', url: `https://t.me/${botUsername}?start=create_regulation` }],
            [{ text: '✏️ Sửa Nội quy', callback_data: 'reg_edit_list' }],
            [{ text: '🗑 Xóa Nội quy', callback_data: 'reg_delete_list' }],
            [{ text: '🔙 Quay lại Dashboard', callback_data: 'admin_dashboard' }]
        ];
        bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } });
        return true;
    }

    if (param === 'admin_reports') {
        if (userRole !== 'admin') {
            bot.sendMessage(chatId, '❌ Bạn không có quyền truy cập mục này.').catch(console.error);
            return true;
        }
        const res = await db.query('SELECT COUNT(*) FROM reports WHERE status = $1', ['submitted']);
        const count = res.rows[0].count;
        const text = `📊 **QUẢN LÝ BÁO CÁO**\n\nTổng số báo cáo đã nộp: ${count}\n\nChọn thao tác:`;
        const keyboard = [
            [{ text: '📋 Xem Thống kê Team', callback_data: 'rep_team_stats' }],
            [{ text: '📢 Chỉnh sửa Thông báo Ghim', callback_data: 'rep_admin_edit_announcement' }],
            [{ text: '🔙 Quay lại Dashboard', callback_data: 'admin_dashboard' }]
        ];
        bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: { inline_keyboard: keyboard } });
        return true;
    }

    if (param.startsWith('addadmin_')) {
        if (userRole !== 'admin') {
            bot.sendMessage(chatId, '❌ Bạn không có quyền thêm Admin.').catch(console.error);
            return true;
        }
        const usernames = param.replace('addadmin_', '').split('_');
        await processAdminAction(bot, chatId, msg.message_id, 'add', usernames, {}, userId);
        return true;
    }

    return false;
}

export async function handleAdminCommand(
    bot: TelegramBot,
    msg: TelegramBot.Message,
    command: string,
    userRole: string,
    session: any,
    replyOptions: TelegramBot.SendMessageOptions
): Promise<boolean> {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    const text = msg.text || '';

    if (!userId) return false;

    if (command === '/admin' || command === '/menuadmin') {
        if (userRole !== 'admin') {
            bot.sendMessage(chatId, '❌ Chỉ Admin của bot mới có thể dùng lệnh này.', replyOptions)
                .then(m => setTimeout(() => bot.deleteMessage(chatId, m.message_id).catch(() => { }), 10000));
            bot.deleteMessage(chatId, msg.message_id).catch(() => { });
            return true;
        }

        if (chatId < 0) {
            // In group chat
            const keyboard = [
                [{ text: '🛠 Mở Bảng điều khiển Admin', url: `https://t.me/${botUsername}?start=admin_dashboard` }]
            ];
            bot.sendMessage(chatId, '🛠 **BẢNG ĐIỀU KHIỂN ADMIN**\n\nVui lòng bấm vào nút bên dưới để mở bảng điều khiển trong chat riêng với bot:', {
                ...replyOptions,
                parse_mode: 'Markdown',
                reply_markup: { inline_keyboard: keyboard }
            }).then(m => setTimeout(() => bot.deleteMessage(chatId, m.message_id).catch(() => { }), 30000));
            bot.deleteMessage(chatId, msg.message_id).catch(() => { });
            return true;
        } else {
            // In private chat
            await handleAdminDashboard(bot, chatId, userRole);
            bot.deleteMessage(chatId, msg.message_id).catch(() => { });
            return true;
        }
    }

    if (command === '/add_admin' || command === '/remove_admin') {
        if (userRole !== 'admin') {
            bot.sendMessage(chatId, '❌ Chỉ Admin của bot mới có thể dùng lệnh này.', replyOptions).catch(console.error);
            return true;
        }

        const args = text.split(/\s+/);

        if (args.length === 1 && !msg.reply_to_message) {
            if (chatId > 0) { // Private chat
                if (command === '/add_admin') {
                    const usersRes = await db.query("SELECT id, username, first_name FROM users WHERE role != 'admin' LIMIT 50");
                    if (usersRes.rows.length === 0) {
                        bot.sendMessage(chatId, '⚠️ Không có người dùng nào (chưa là admin) trong hệ thống để thêm.', replyOptions);
                        return true;
                    }
                    const keyboard = usersRes.rows.map(u => [{
                        text: `${u.first_name || 'User'} ${u.username ? `(@${u.username})` : ''}`,
                        callback_data: `admin_add_${u.id}`
                    }]);
                    bot.sendMessage(chatId, 'Vui lòng chọn người dùng để cấp quyền Admin:', { ...replyOptions, reply_markup: { inline_keyboard: keyboard } });
                } else {
                    const adminsRes = await db.query("SELECT id, username, first_name FROM users WHERE role = 'admin'");
                    const keyboard = adminsRes.rows.map(u => [{
                        text: `${u.first_name || 'Admin'} ${u.username ? `(@${u.username})` : ''}`,
                        callback_data: `admin_remove_${u.id}`
                    }]);
                    bot.sendMessage(chatId, 'Vui lòng chọn Admin để xóa quyền:', { ...replyOptions, reply_markup: { inline_keyboard: keyboard } });
                }
                bot.deleteMessage(chatId, msg.message_id).catch(() => { });
                return true;
            } else {
                // Enter conversational state for group
                const newState = command === '/add_admin' ? 'adding_admin_group_prompt' : 'removing_admin';
                const actionText = command === '/add_admin' ? 'cấp quyền Admin' : 'xóa quyền Admin';
                const promptText = command === '/add_admin'
                    ? 'Vui lòng nhập tên admin @user (Ví dụ: @nguyenvana). Nếu nhập sai, bot sẽ yêu cầu nhập lại. Lệnh sẽ tự động hủy sau 60s nếu không có phản hồi:'
                    : `Vui lòng nhập @username của những người bạn muốn ${actionText} (có thể nhập nhiều người, cách nhau bằng dấu cách):`;

                const promptMsg = await bot.sendMessage(chatId, promptText, replyOptions);
                updateSession(userId, { state: newState, tempData: { topicId: replyOptions.message_thread_id, promptMessageId: promptMsg.message_id } });

                if (command === '/add_admin') {
                    // Auto cancel after 60s for group add admin
                    setTimeout(() => {
                        const currentSession = getSession(userId);
                        if (currentSession.state === 'adding_admin_group_prompt') {
                            clearSession(userId);
                            bot.deleteMessage(chatId, promptMsg.message_id).catch(() => { });
                        }
                    }, 60000);
                }

                bot.deleteMessage(chatId, msg.message_id).catch(() => { });
                return true;
            }
        }

        let targetUsernames: string[] = [];
        let replyToUserId: number | undefined;
        let replyToName = '';
        let replyToUsername = '';

        if (msg.reply_to_message?.from) {
            replyToUserId = msg.reply_to_message.from.id;
            replyToName = msg.reply_to_message.from.first_name || msg.reply_to_message.from.username || 'người dùng này';
            replyToUsername = msg.reply_to_message.from.username || '';
        }

        targetUsernames = args.slice(1).filter(u => u.startsWith('@')).map(u => u.replace('@', ''));

        if (!replyToUserId && targetUsernames.length === 0) {
            bot.sendMessage(chatId, `⚠️ Hãy reply tin nhắn của người đó hoặc gõ: ${command} @username1 @username2`, replyOptions).catch(console.error);
            return true;
        }

        const action = command === '/add_admin' ? 'add' : 'remove';
        await processAdminAction(bot, chatId, msg.message_id, action, targetUsernames, replyOptions, userId, replyToUserId, replyToName, replyToUsername);
        return true;
    }

    return false;
}

export async function handleAdminDashboard(
    bot: TelegramBot,
    chatId: number,
    userRole: string,
    messageId?: number,
    messageThreadId?: number
) {
    if (userRole !== 'admin') {
        bot.sendMessage(chatId, '❌ Bạn không có quyền truy cập Bảng điều khiển Admin.', { message_thread_id: messageThreadId }).catch(console.error);
        return;
    }

    const text = `🛠 **BẢNG ĐIỀU KHIỂN ADMIN**\n\nChào Admin, đây là trung tâm quản lý Nội quy và hệ thống của bạn:`;
    const keyboard = [
        [
            { text: '📜 Quản lý Nội quy', callback_data: 'admin_manage_regs' },
            { text: '📊 Quản lý Báo cáo', callback_data: 'admin_manage_reports' }
        ],
        [
            { text: '👥 Quản lý Admin', callback_data: 'admin_manage_admins' },
            { text: '⚙️ Cài đặt Topic', callback_data: 'admin_manage_topics' }
        ],
        [
            { text: '📇 Quản lý Nhân sự', callback_data: 'admin_manage_personnel' },
            { text: '📢 Quản lý Thông báo', callback_data: 'admin_manage_announcements' }
        ],
        [
            { text: '🛠 Quản lý Công cụ', callback_data: 'admin_manage_tools' },
            { text: '💡 Quản lý Đề xuất', callback_data: 'admin_manage_proposals' }
        ],
        [
            { text: '📁 Quản lý Tài liệu', callback_data: 'admin_manage_documents' }
        ],
        [{ text: '❌ Đóng Menu', callback_data: 'admin_close_dashboard' }]
    ];

    if (messageId) {
        bot.editMessageText(text, {
            chat_id: chatId,
            message_id: messageId,
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: keyboard }
        }).catch(console.error);
    } else {
        bot.sendMessage(chatId, text, {
            message_thread_id: messageThreadId,
            parse_mode: 'Markdown',
            reply_markup: { inline_keyboard: keyboard }
        }).then(m => setTimeout(() => bot.deleteMessage(chatId, m.message_id).catch(() => { }), 60000))
            .catch(console.error);
    }
}

export async function handleAdminCallback(
    bot: TelegramBot,
    query: TelegramBot.CallbackQuery,
    data: string,
    userRole: string
): Promise<boolean> {
    const chatId = query.message?.chat.id;
    const messageId = query.message?.message_id;
    const userId = query.from.id;

    if (!chatId || !messageId) return false;

    if (userRole !== 'admin') {
        bot.answerCallbackQuery(query.id, { text: '❌ Bạn không có quyền.', show_alert: true });
        return true;
    }

    if (data === 'admin_dashboard') {
        await handleAdminDashboard(bot, chatId, userRole, messageId);
        bot.answerCallbackQuery(query.id);
        return true;
    }

    if (data === 'admin_close_dashboard') {
        bot.deleteMessage(chatId, messageId).catch(() => { });
        bot.answerCallbackQuery(query.id);
        return true;
    }

    if (data === 'admin_manage_regs') {
        const text = `📜 **QUẢN LÝ NỘI QUY**\n\nChọn thao tác bạn muốn thực hiện:`;
        const keyboard = [
            [{ text: '➕ Thêm Nội quy mới', url: `https://t.me/${botUsername}?start=create_regulation` }],
            [{ text: '✏️ Sửa Nội quy', callback_data: 'reg_edit_list' }],
            [{ text: '🗑 Xóa Nội quy', callback_data: 'reg_delete_list' }],
            [{ text: '🔙 Quay lại', callback_data: 'admin_dashboard' }]
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

    if (data === 'admin_manage_tools') {
        const text = `🛠 **QUẢN LÝ CÔNG CỤ**\n\nChọn thao tác bạn muốn thực hiện:`;
        const keyboard = [
            [{ text: '➕ Thêm Danh mục Công cụ', url: `https://t.me/${botUsername}?start=tools_cat_add` }],
            [{ text: '📋 Danh sách Danh mục', callback_data: 'tools_cat_list' }],
            [{ text: '➕ Thêm Công cụ mới', url: `https://t.me/${botUsername}?start=tools_add` }],
            [{ text: '📋 Danh sách Công cụ', callback_data: 'tools_admin_list' }],
            [{ text: '🔙 Quay lại', callback_data: 'admin_dashboard' }]
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

    if (data === 'admin_manage_proposals') {
        const text = `💡 **QUẢN LÝ ĐỀ XUẤT**\n\nChọn thao tác bạn muốn thực hiện:`;
        const keyboard = [
            [{ text: '⏳ Đề xuất chờ duyệt', callback_data: 'prop_admin_filter_PENDING' }],
            [{ text: '✅ Đề xuất đã duyệt', callback_data: 'prop_admin_filter_APPROVED' }],
            [{ text: '❌ Đề xuất đã từ chối', callback_data: 'prop_admin_filter_REJECTED' }],
            [{ text: '👤 Lịch sử theo người dùng', callback_data: 'prop_admin_filter_user' }],
            [{ text: '📂 Quản lý Danh mục Đề xuất', callback_data: 'prop_admin_manage_cats' }],
            [{ text: '⚙️ Cấu hình Sheet & Folder Chi phí', callback_data: 'admin_config_cost' }],
            [{ text: '🔙 Quay lại', callback_data: 'admin_dashboard' }]
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

    if (data === 'admin_config_cost') {
        bot.deleteMessage(chatId, messageId).catch(() => { });
        bot.sendMessage(chatId, '⚙️ *CẤU HÌNH SHEET & FOLDER CHI PHÍ*\n\nVui lòng nhập Tháng và Năm (Định dạng: MM/YYYY, VD: 04/2026):', { parse_mode: 'Markdown' }).then(m => {
            updateSession(userId, {
                state: 'config_cost_month',
                tempData: { promptMessageId: m.message_id }
            });
        });
        bot.answerCallbackQuery(query.id);
        return true;
    }

    if (data === 'admin_manage_documents') {
        const text = `📁 **QUẢN LÝ TÀI LIỆU BIỂU MẪU**\n\nChọn thao tác bạn muốn thực hiện:`;
        const keyboard = [
            [{ text: '➕ Thêm Tài liệu mới', url: `https://t.me/${botUsername}?start=docs_add` }],
            [{ text: '📋 Danh sách Tài liệu', callback_data: 'docs_admin_list' }],
            [{ text: '🔙 Quay lại', callback_data: 'admin_dashboard' }]
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

    if (data === 'admin_manage_announcements') {
        const text = `📢 **QUẢN LÝ THÔNG BÁO**\n\nChọn thao tác bạn muốn thực hiện:`;
        const keyboard = [
            [{ text: '➕ Thêm Thông báo mới', url: `https://t.me/${botUsername}?start=create_announcement` }],
            [{ text: '📋 Danh sách Thông báo', callback_data: 'ann_admin_list' }],
            [{ text: '📅 Thông báo Lễ Tự động', callback_data: 'ann_admin_holiday_list' }],
            [{ text: '🔙 Quay lại', callback_data: 'admin_dashboard' }]
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

    if (data === 'admin_manage_reports') {
        const res = await db.query('SELECT COUNT(*) FROM reports WHERE status = $1', ['submitted']);
        const count = res.rows[0].count;
        const text = `📊 **QUẢN LÝ BÁO CÁO**\n\nTổng số báo cáo đã nộp: ${count}\n\nChọn thao tác:`;
        const keyboard = [
            [{ text: '📅 Báo cáo hôm nay', callback_data: 'rep_admin_today' }],
            [{ text: '👤 Báo cáo theo tên', callback_data: 'rep_admin_by_user' }],
            [{ text: '📆 Báo cáo theo tháng', callback_data: 'rep_admin_by_month' }],
            [{ text: '📢 Chỉnh sửa Thông báo Ghim', callback_data: 'rep_admin_edit_announcement' }],
            [{ text: '🔙 Quay lại', callback_data: 'admin_dashboard' }]
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

    if (data === 'admin_manage_admins') {
        const text = `👥 **QUẢN LÝ ADMIN**\n\nChọn thao tác:`;
        const keyboard = [
            [{ text: '➕ Thêm Admin mới', callback_data: 'admin_add_list' }],
            [{ text: '🗑 Xóa Admin', callback_data: 'admin_remove_list' }],
            [{ text: '🔙 Quay lại', callback_data: 'admin_dashboard' }]
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

    if (data === 'admin_manage_topics') {
        const text = `⚙️ **CÀI ĐẶT TOPIC**\n\nĐể cài đặt Topic, bạn cần vào Topic đó trong Group và gõ lệnh:\n\n` +
            `• \`/menu\`: Mở menu cài đặt cho Topic hiện tại\n\n` +
            `Sau khi gõ \`/menu\`, bot sẽ hiển thị các tính năng có sẵn để bạn thiết lập cho Topic đó.`;
        const keyboard = [
            [{ text: '🔙 Quay lại', callback_data: 'admin_dashboard' }]
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

    if (data === 'admin_add_list') {
        const usersRes = await db.query("SELECT id, username, first_name FROM users WHERE role != 'admin' LIMIT 50");
        if (usersRes.rows.length === 0) {
            bot.answerCallbackQuery(query.id, { text: '⚠️ Không có người dùng nào để thêm.', show_alert: true });
            return true;
        }
        const keyboard = usersRes.rows.map(u => [{
            text: `${u.first_name || 'User'} ${u.username ? `(@${u.username})` : ''}`,
            callback_data: `admin_add_${u.id}`
        }]);
        keyboard.push([{ text: '🔙 Quay lại', callback_data: 'admin_manage_admins' }]);
        bot.editMessageText('Vui lòng chọn người dùng để cấp quyền Admin:', {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: { inline_keyboard: keyboard }
        }).catch(console.error);
        bot.answerCallbackQuery(query.id);
        return true;
    }

    if (data === 'admin_remove_list') {
        const adminsRes = await db.query("SELECT id, username, first_name FROM users WHERE role = 'admin'");
        const keyboard = adminsRes.rows.map(u => [{
            text: `${u.first_name || 'Admin'} ${u.username ? `(@${u.username})` : ''}`,
            callback_data: `admin_remove_${u.id}`
        }]);
        keyboard.push([{ text: '🔙 Quay lại', callback_data: 'admin_manage_admins' }]);
        bot.editMessageText('Vui lòng chọn Admin để xóa quyền:', {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: { inline_keyboard: keyboard }
        }).catch(console.error);
        bot.answerCallbackQuery(query.id);
        return true;
    }

    if (data === 'admin_group_add') {
        updateSession(userId, { state: 'adding_admin_group_prompt' });
        const promptMsg = await bot.sendMessage(chatId, 'Vui lòng nhập tên admin @user (Ví dụ: @nguyenvana). Nếu nhập sai, bot sẽ yêu cầu nhập lại. Lệnh sẽ tự động hủy sau 60s nếu không có phản hồi:');

        // Auto cancel after 60s
        setTimeout(() => {
            const currentSession = getSession(userId);
            if (currentSession.state === 'adding_admin_group_prompt') {
                clearSession(userId);
                bot.deleteMessage(chatId, promptMsg.message_id).catch(() => { });
            }
        }, 60000);

        bot.answerCallbackQuery(query.id);
        return true;
    }

    if (data.startsWith('admin_add_')) {
        const targetId = parseInt(data.split('_')[2]);
        try {
            const userRes = await db.query('SELECT username, first_name, role FROM users WHERE id = $1', [targetId]);
            if (userRes.rows.length === 0) {
                bot.answerCallbackQuery(query.id, { text: '⚠️ Không tìm thấy người dùng.', show_alert: true });
                return true;
            }
            const targetUser = userRes.rows[0];
            if (targetUser.role === 'admin') {
                bot.answerCallbackQuery(query.id, { text: '⚠️ Người dùng này đã là Admin.', show_alert: true });
            } else {
                await db.query("UPDATE users SET role = 'admin' WHERE id = $1", [targetId]);
                roleCache.delete(targetId);
                await setAdminPrivateCommands(bot, targetId);
                bot.answerCallbackQuery(query.id, { text: `✅ Đã cấp quyền Admin cho ${targetUser.first_name || 'User'}` });

                const adminsRes = await db.query("SELECT username, first_name FROM users WHERE role = 'admin'");
                const adminList = adminsRes.rows.map(u => `- ${u.first_name || 'Admin'} ${u.username ? `(@${u.username})` : ''}`).join('\n');
                bot.sendMessage(chatId, `✅ Đã cấp quyền Admin cho ${targetUser.first_name || 'User'}\n\n👥 **Danh sách Admin hiện tại:**\n${adminList}`, { parse_mode: 'Markdown' });
                bot.deleteMessage(chatId, messageId).catch(() => { });
            }
        } catch (err: any) {
            bot.answerCallbackQuery(query.id, { text: `❌ Lỗi: ${err.message}`, show_alert: true });
        }
        return true;
    }

    if (data.startsWith('admin_remove_')) {
        const targetId = parseInt(data.split('_')[2]);
        if (targetId === userId) {
            bot.answerCallbackQuery(query.id, { text: '⚠️ Bạn không thể tự xóa quyền Admin của chính mình.', show_alert: true });
            return true;
        }
        try {
            const userRes = await db.query('SELECT username, first_name, role FROM users WHERE id = $1', [targetId]);
            if (userRes.rows.length === 0) {
                bot.answerCallbackQuery(query.id, { text: '⚠️ Không tìm thấy người dùng.', show_alert: true });
                return true;
            }
            const targetUser = userRes.rows[0];
            if (targetUser.role !== 'admin') {
                bot.answerCallbackQuery(query.id, { text: '⚠️ Người dùng này hiện không phải là Admin.', show_alert: true });
            } else {
                await db.query("UPDATE users SET role = 'user' WHERE id = $1", [targetId]);
                roleCache.delete(targetId);
                await removeAdminPrivateCommands(bot, targetId);
                bot.answerCallbackQuery(query.id, { text: `✅ Đã hủy quyền Admin của ${targetUser.first_name || 'User'}` });

                const adminsRes = await db.query("SELECT username, first_name FROM users WHERE role = 'admin'");
                const adminList = adminsRes.rows.map(u => `- ${u.first_name || 'Admin'} ${u.username ? `(@${u.username})` : ''}`).join('\n');
                bot.sendMessage(chatId, `✅ Đã hủy quyền Admin của ${targetUser.first_name || 'User'}\n\n👥 **Danh sách Admin hiện tại:**\n${adminList}`, { parse_mode: 'Markdown' });
                bot.deleteMessage(chatId, messageId).catch(() => { });
            }
        } catch (err: any) {
            bot.answerCallbackQuery(query.id, { text: `❌ Lỗi: ${err.message}`, show_alert: true });
        }
        return true;
    }

    return false;
}

export async function handleAdminState(
    bot: TelegramBot,
    msg: TelegramBot.Message,
    command: string,
    session: any,
    replyOptions: TelegramBot.SendMessageOptions
): Promise<boolean> {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    const text = msg.text || '';

    if (!userId) return false;

    if (session.state === 'adding_admin' || session.state === 'removing_admin' || session.state === 'adding_admin_group_prompt') {
        if (command === '/cancel') {
            clearSession(userId);
            bot.sendMessage(chatId, '✅ Đã hủy thao tác.', replyOptions).catch(console.error);
            if (session.tempData?.promptMessageId) {
                bot.deleteMessage(chatId, session.tempData.promptMessageId).catch(() => { });
            }
            bot.deleteMessage(chatId, msg.message_id).catch(() => { });
            return true;
        }

        const action = (session.state === 'adding_admin' || session.state === 'adding_admin_group_prompt') ? 'add' : 'remove';
        const promptMessageId = session.tempData?.promptMessageId;

        const usernames = text.split(/\s+/).filter(u => u.startsWith('@')).map(u => u.replace('@', ''));
        if (usernames.length === 0) {
            const errorMsg = await bot.sendMessage(chatId, `⚠️ Không tìm thấy @username nào hợp lệ. Vui lòng nhập lại hoặc gõ /cancel để hủy.\n*(Tin nhắn này sẽ tự xóa sau 10s)*`, { ...replyOptions, parse_mode: 'Markdown' });
            setTimeout(() => {
                bot.deleteMessage(chatId, msg.message_id).catch(() => { });
                bot.deleteMessage(chatId, errorMsg.message_id).catch(() => { });
            }, 10000);
            return true;
        }

        // Check if at least one username exists
        let validCount = 0;
        for (const uname of usernames) {
            const res = await db.query('SELECT id FROM users WHERE username = $1', [uname]);
            if (res.rows.length > 0) validCount++;
        }

        if (validCount === 0) {
            const errorMsg = await bot.sendMessage(chatId, `⚠️ Không tìm thấy người dùng nào trong hệ thống khớp với tên bạn nhập.\n\nVui lòng kiểm tra lại tên chính xác và nhập lại, hoặc gõ /cancel để hủy.\n*(Tin nhắn này sẽ tự xóa sau 10s)*`, { ...replyOptions, parse_mode: 'Markdown' });
            setTimeout(() => {
                bot.deleteMessage(chatId, msg.message_id).catch(() => { });
                bot.deleteMessage(chatId, errorMsg.message_id).catch(() => { });
            }, 10000);
            return true; // Keep session active
        }

        if (session.state === 'adding_admin_group_prompt') {
            const promptMessageId = session.tempData?.promptMessageId;
            const usernames = text.split(/\s+/).filter(u => u.startsWith('@')).map(u => u.replace('@', ''));

            if (usernames.length === 0) {
                const errorMsg = await bot.sendMessage(chatId, `⚠️ Vui lòng nhập đúng định dạng @username (Ví dụ: @nguyenvana).`, { ...replyOptions });
                setTimeout(() => {
                    bot.deleteMessage(chatId, msg.message_id).catch(() => { });
                    bot.deleteMessage(chatId, errorMsg.message_id).catch(() => { });
                }, 5000);
                return true;
            }

            // Check if at least one username exists in our DB
            let validUsernames: string[] = [];
            for (const uname of usernames) {
                const res = await db.query('SELECT id FROM users WHERE username = $1', [uname]);
                if (res.rows.length > 0) validUsernames.push(uname);
            }

            if (validUsernames.length === 0) {
                const errorMsg = await bot.sendMessage(chatId, `⚠️ Không tìm thấy người dùng @${usernames[0]} trong hệ thống.\n\nNgười này cần phải nhắn tin cho bot ít nhất 1 lần trước khi được thêm làm Admin. Vui lòng kiểm tra lại hoặc gõ /cancel để hủy.`, { ...replyOptions });
                setTimeout(() => {
                    bot.deleteMessage(chatId, msg.message_id).catch(() => { });
                    bot.deleteMessage(chatId, errorMsg.message_id).catch(() => { });
                }, 10000);
                return true; // Keep session active for re-entry
            }

            // Success: Send deep link to private chat
            if (promptMessageId) bot.deleteMessage(chatId, promptMessageId).catch(() => { });

            const deepLink = `https://t.me/${botUsername}?start=addadmin_${validUsernames.join('_')}`;
            const replyMsg = await bot.sendMessage(chatId, `✅ Đã tìm thấy người dùng. Vui lòng bấm vào nút bên dưới để chuyển sang chat riêng và xác nhận cấp quyền Admin:`, {
                ...replyOptions,
                reply_markup: {
                    inline_keyboard: [[{ text: '👉 Xác nhận tại Inbox Bot', url: deepLink }]]
                }
            });

            setTimeout(() => {
                bot.deleteMessage(chatId, msg.message_id).catch(() => { });
                bot.deleteMessage(chatId, replyMsg.message_id).catch(() => { });
            }, 30000);

            clearSession(userId);
            return true;
        }

        await processAdminAction(bot, chatId, msg.message_id, action, usernames, replyOptions, userId, undefined, undefined, undefined, promptMessageId);
        clearSession(userId);
        return true;
    }

    return false;
}
