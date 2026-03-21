import TelegramBot, { InlineKeyboardButton } from 'node-telegram-bot-api';
import { db } from '../../db';
import { topicCache, roleCache, CACHE_TTL } from '../services/sessionManager';
import { trackMessage } from '../utils/messageTracker';
import * as sessionManager from '../services/sessionManager';
import { botUsername } from '../botInstance';

export async function handleSetTopicCommand(
    bot: TelegramBot,
    msg: TelegramBot.Message,
    command: string,
    userRole: string,
    isGroupAdmin: boolean,
    replyOptions: TelegramBot.SendMessageOptions
): Promise<boolean> {
    const chatId = msg.chat.id;
    const topicId = msg.message_thread_id || 0;
    const targetId = topicId || chatId;
    const isPrivate = msg.chat.type === 'private';

    if (isPrivate && (command === '/menu' || command.startsWith('/set_topic_') || command.startsWith('/unset_topic'))) {
        if (command === '/unset_topic') {
            bot.sendMessage(chatId, '⚠️ Lệnh này dùng để hủy cài đặt Topic. Vui lòng sử dụng lệnh này trực tiếp trong Topic bạn muốn hủy nhé!');
        } else {
            bot.sendMessage(chatId, '⚠️ Lệnh này chỉ hoạt động trong Nhóm hoặc Topic của Nhóm. Vui lòng sử dụng trong Group nhé!');
        }
        return true;
    }

    if (command === '/menu' || (command === '/start' && !isPrivate)) {
        const topicRes = await db.query(
            'SELECT feature_type FROM topics WHERE chat_id = $1 AND topic_id = $2',
            [chatId, topicId]
        );
        const feature = topicRes.rows[0]?.feature_type;

        if (feature === 'regulation') {
            await sendRegulationDashboard(bot, chatId, topicId, userRole, replyOptions);
            bot.deleteMessage(chatId, msg.message_id).catch(() => { });
            return true;
        } else if (feature === 'report') {
            await sendReportDashboard(bot, chatId, topicId, userRole, replyOptions);
            bot.deleteMessage(chatId, msg.message_id).catch(() => { });
            return true;
        } else if (feature === 'information') {
            await sendInformationDashboard(bot, chatId, topicId, userRole, replyOptions);
            bot.deleteMessage(chatId, msg.message_id).catch(() => { });
            return true;
        } else if (feature === 'announcement') {
            await sendAnnouncementDashboard(bot, chatId, topicId, userRole, replyOptions);
            bot.deleteMessage(chatId, msg.message_id).catch(() => { });
            return true;
        } else if (userRole === 'admin' && command === '/menu') {
            // Topic is not set, show setup options for Admin
            const otherTopics = await db.query(
                'SELECT feature_type FROM topics WHERE chat_id = $1 AND feature_type IN (\'regulation\', \'report\', \'information\', \'announcement\')',
                [chatId]
            );
            const setFeatures = otherTopics.rows.map(r => r.feature_type);

            const keyboard: InlineKeyboardButton[][] = [];
            if (!setFeatures.includes('regulation')) {
                keyboard.push([{ text: '📜 Cài đặt làm nơi xem Nội quy', callback_data: 'topic_set_regulation' }]);
            }
            if (!setFeatures.includes('report')) {
                keyboard.push([{ text: '📊 Cài đặt làm nơi nhận Báo cáo', callback_data: 'topic_set_report' }]);
            }
            if (!setFeatures.includes('information')) {
                keyboard.push([{ text: '📇 Cài đặt làm nơi xem Thông tin', callback_data: 'topic_set_information' }]);
            }
            if (!setFeatures.includes('announcement')) {
                keyboard.push([{ text: '📢 Cài đặt làm nơi xem Thông báo', callback_data: 'topic_set_announcement' }]);
            }

            if (keyboard.length === 0) {
                bot.sendMessage(chatId, '⚠️ Tất cả các tính năng đã được cài đặt cho các topic khác trong nhóm này.', replyOptions)
                    .then(m => setTimeout(() => bot.deleteMessage(chatId, m.message_id).catch(() => { }), 15000));
            } else {
                bot.sendMessage(chatId, '⚙️ **CÀI ĐẶT TOPIC**\n\nTopic này chưa được cài đặt tính năng. Vui lòng chọn tính năng muốn thiết lập:', {
                    ...replyOptions,
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: keyboard }
                }).then(m => setTimeout(() => bot.deleteMessage(chatId, m.message_id).catch(() => { }), 30000));
            }
            bot.deleteMessage(chatId, msg.message_id).catch(() => { });
            return true;
        } else if (command === '/start' && !isPrivate) {
            // Fallback for /start in unconfigured group/topic
            bot.sendMessage(chatId, '👋 Xin chào bạn đến với Bot Quản lý Công ty. Admin hãy gõ lệnh /menu để cài đặt tính năng cho topic này nhé.', replyOptions)
                .then(m => setTimeout(() => bot.deleteMessage(chatId, m.message_id).catch(() => { }), 15000));
            bot.deleteMessage(chatId, msg.message_id).catch(() => { });
            return true;
        }
        return false;
    }

    if (command === '/set_topic_regulation' || command === '/set_topic_report' || command === '/set_topic_information' || command === '/set_topic_announcement') {
        const featureType = command === '/set_topic_regulation' ? 'regulation' : (command === '/set_topic_report' ? 'report' : (command === '/set_topic_information' ? 'information' : 'announcement'));
        const featureName = featureType === 'regulation' ? 'Nội quy' : (featureType === 'report' ? 'Báo cáo' : (featureType === 'information' ? 'Thông tin' : 'Thông báo'));

        if (userRole !== 'admin') {
            bot.sendMessage(chatId, `❌ Bạn không có quyền. Chỉ Admin của bot mới có quyền cài đặt topic ${featureName}.`, replyOptions)
                .then(m => setTimeout(() => bot.deleteMessage(chatId, m.message_id).catch(() => { }), 15000));
            return true;
        }

        try {
            // 1. Check if CURRENT topic already has a feature set
            const currentTopicRes = await db.query(
                "SELECT feature_type FROM topics WHERE chat_id = $1 AND topic_id = $2",
                [chatId, topicId]
            );
            const currentFeature = currentTopicRes.rows[0]?.feature_type;
            if (currentFeature && currentFeature !== 'discussion') {
                const currentFeatureName = currentFeature === 'regulation' ? 'Nội quy' : (currentFeature === 'report' ? 'Báo cáo' : (currentFeature === 'information' ? 'Thông tin' : 'Thông báo'));
                bot.sendMessage(chatId, `⚠️ Topic này đã được cài đặt tính năng *${currentFeatureName}*.\n\nBạn phải hủy cài đặt hiện tại trước khi thiết lập tính năng mới.`, { ...replyOptions, parse_mode: 'Markdown' })
                    .then(m => setTimeout(() => bot.deleteMessage(chatId, m.message_id).catch(() => { }), 15000));
                bot.deleteMessage(chatId, msg.message_id).catch(() => { });
                return true;
            }

            // 2. Check if the REQUESTED feature is already set in ANOTHER topic in this group
            const otherTopicRes = await db.query(
                "SELECT topic_id, name FROM topics WHERE chat_id = $1 AND feature_type = $2 AND topic_id != $3",
                [chatId, featureType, topicId]
            );
            if (otherTopicRes.rows.length > 0) {
                const otherTopic = otherTopicRes.rows[0];
                bot.sendMessage(chatId, `⚠️ Tính năng *${featureName}* đã được cài đặt tại topic khác: *${otherTopic.name}* (ID: ${otherTopic.topic_id}).\n\nMỗi nhóm chỉ được phép có 1 topic cho mỗi tính năng.`, { ...replyOptions, parse_mode: 'Markdown' })
                    .then(m => setTimeout(() => bot.deleteMessage(chatId, m.message_id).catch(() => { }), 15000));
                bot.deleteMessage(chatId, msg.message_id).catch(() => { });
                return true;
            }

            let text = '';
            let keyboard: InlineKeyboardButton[][] = [];

            if (featureType === 'regulation') {
                const regs = await db.query('SELECT id, title FROM regulations ORDER BY created_at DESC');
                keyboard = regs.rows.length > 0
                    ? regs.rows.map(r => [{ text: `📖 ${r.title}`, callback_data: `reg_view_${r.id}` }])
                    : [];

                const now = new Date();
                const timeStr = now.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                const dateStr = now.toLocaleDateString('vi-VN');
                text = '📜 *DANH SÁCH NỘI QUY CÔNG TY*\n\n' +
                    (regs.rows.length > 0 ? 'Chọn một mục bên dưới để xem chi tiết:' : 'Hiện tại chưa có nội quy nào.') +
                    `\n\n_(Cập nhật lúc: ${timeStr} - ${dateStr})_`;

                const sentMsg = await bot.sendMessage(chatId, text, {
                    ...replyOptions,
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: keyboard }
                });
                await bot.pinChatMessage(chatId, sentMsg.message_id).catch(console.error);

                await db.query(`
          INSERT INTO topics (chat_id, topic_id, name, feature_type, pinned_message_id) 
          VALUES ($1, $2, $3, $4, $5) 
          ON CONFLICT (chat_id, topic_id) 
          DO UPDATE SET feature_type = $4, pinned_message_id = $5, name = $3
        `, [chatId, topicId || 0, msg.chat.title || `${featureName} Topic`, featureType, sentMsg.message_id]);
            } else if (featureType === 'report') {
                const text = '📊 *TOPIC BÁO CÁO*\n\nĐây là nơi tiếp nhận và quản lý các báo cáo của thành viên. Vui lòng chọn chức năng bên dưới:';
                const keyboard: InlineKeyboardButton[][] = [
                    [{ text: '📝 Gửi báo cáo công việc hằng ngày', url: `https://t.me/${botUsername}?start=create_report_daily_${chatId}_${topicId || 0}` }],
                    [{ text: '📁 Gửi báo cáo dự án', url: `https://t.me/${botUsername}?start=create_report_project_${chatId}_${topicId || 0}` }],
                    [{ text: '📋 Lịch sử báo cáo của tôi', url: `https://t.me/${botUsername}?start=my_reports` }]
                ];

                const sentMsg = await bot.sendMessage(chatId, text, {
                    ...replyOptions,
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: keyboard }
                });
                await bot.pinChatMessage(chatId, sentMsg.message_id).catch(console.error);

                await db.query(`
          INSERT INTO topics (chat_id, topic_id, name, feature_type, pinned_message_id) 
          VALUES ($1, $2, $3, $4, $5) 
          ON CONFLICT (chat_id, topic_id) 
          DO UPDATE SET feature_type = $4, pinned_message_id = $5, name = $3
        `, [chatId, topicId || 0, msg.chat.title || `${featureName} Topic`, featureType, sentMsg.message_id]);
            } else if (featureType === 'information') {
                const users = await db.query("SELECT id, full_name, position FROM user_profiles WHERE status = 'active' ORDER BY full_name ASC");
                const keyboard = users.rows.length > 0
                    ? users.rows.map(u => [{ text: `👤 ${u.full_name} - ${u.position || 'Nhân viên'}`, callback_data: `info_view_${u.id}` }])
                    : [];

                const now = new Date();
                const timeStr = now.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                const dateStr = now.toLocaleDateString('vi-VN');
                const text = '📇 *DANH SÁCH NHÂN SỰ CÔNG TY*\n\n' +
                    (users.rows.length > 0 ? 'Chọn một thành viên bên dưới để xem thông tin chi tiết:' : 'Hiện tại chưa có thông tin nhân sự nào.') +
                    `\n\n_(Cập nhật lúc: ${timeStr} - ${dateStr})_`;

                const sentMsg = await bot.sendMessage(chatId, text, {
                    ...replyOptions,
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: keyboard }
                });
                await bot.pinChatMessage(chatId, sentMsg.message_id).catch(console.error);

                await db.query(`
          INSERT INTO topics (chat_id, topic_id, name, feature_type, pinned_message_id) 
          VALUES ($1, $2, $3, $4, $5) 
          ON CONFLICT (chat_id, topic_id) 
          DO UPDATE SET feature_type = $4, pinned_message_id = $5, name = $3
        `, [chatId, topicId || 0, msg.chat.title || `${featureName} Topic`, featureType, sentMsg.message_id]);
            } else if (featureType === 'announcement') {
                const text = '📢 *THÔNG BÁO CÔNG TY*\n\nChào mừng bạn đến với kênh thông báo. Các thông báo mới sẽ được tự động gửi vào đây.';
                const sentMsg = await bot.sendMessage(chatId, text, {
                    ...replyOptions,
                    parse_mode: 'Markdown'
                });
                await bot.pinChatMessage(chatId, sentMsg.message_id).catch(console.error);

                await db.query(`
          INSERT INTO topics (chat_id, topic_id, name, feature_type, pinned_message_id) 
          VALUES ($1, $2, $3, $4, $5) 
          ON CONFLICT (chat_id, topic_id) 
          DO UPDATE SET feature_type = $4, pinned_message_id = $5, name = $3
        `, [chatId, topicId || 0, msg.chat.title || `${featureName} Topic`, featureType, sentMsg.message_id]);
            }

            topicCache.delete(targetId);

            bot.sendMessage(chatId, `✅ Nhóm/Topic này đã được thiết lập làm nơi ${featureName}!`, replyOptions)
                .then(m => setTimeout(() => bot.deleteMessage(chatId, m.message_id).catch(() => { }), 30000))
                .catch(console.error);

            bot.deleteMessage(chatId, msg.message_id).catch(() => { });
        } catch (err: any) {
            console.error('Error setting topic:', err);
            bot.sendMessage(chatId, '❌ Lỗi database khi cài đặt topic: ' + err.message, replyOptions)
                .then(m => setTimeout(() => bot.deleteMessage(chatId, m.message_id).catch(() => { }), 30000))
                .catch(console.error);
        }
        return true;
    }

    if (command === '/unset_topic_regulation' || command === '/unset_topic_report' || command === '/unset_topic_information' || command === '/unset_topic_announcement' || command === '/unset_topic') {
        if (userRole !== 'admin') {
            bot.sendMessage(chatId, '❌ Bạn không có quyền thực hiện lệnh này.', replyOptions)
                .then(m => setTimeout(() => bot.deleteMessage(chatId, m.message_id).catch(() => { }), 15000));
            return true;
        }

        const topicRes = await db.query(
            'SELECT feature_type FROM topics WHERE chat_id = $1 AND topic_id = $2',
            [chatId, topicId]
        );
        const feature = topicRes.rows[0]?.feature_type;

        if (!feature || feature === 'discussion') {
            bot.sendMessage(chatId, '⚠️ Topic này chưa được cài đặt tính năng nào.', replyOptions)
                .then(m => setTimeout(() => bot.deleteMessage(chatId, m.message_id).catch(() => { }), 15000));
            bot.deleteMessage(chatId, msg.message_id).catch(() => { });
            return true;
        }

        // Check if the command matches the feature (for specific unset commands)
        if (command === '/unset_topic_regulation' && feature !== 'regulation') {
            bot.sendMessage(chatId, '⚠️ Topic này không được cài đặt tính năng Nội quy.', replyOptions)
                .then(m => setTimeout(() => bot.deleteMessage(chatId, m.message_id).catch(() => { }), 15000));
            bot.deleteMessage(chatId, msg.message_id).catch(() => { });
            return true;
        }
        if (command === '/unset_topic_report' && feature !== 'report') {
            bot.sendMessage(chatId, '⚠️ Topic này không được cài đặt tính năng Báo cáo.', replyOptions)
                .then(m => setTimeout(() => bot.deleteMessage(chatId, m.message_id).catch(() => { }), 15000));
            bot.deleteMessage(chatId, msg.message_id).catch(() => { });
            return true;
        }
        if (command === '/unset_topic_information' && feature !== 'information') {
            bot.sendMessage(chatId, '⚠️ Topic này không được cài đặt tính năng Thông tin.', replyOptions)
                .then(m => setTimeout(() => bot.deleteMessage(chatId, m.message_id).catch(() => { }), 15000));
            bot.deleteMessage(chatId, msg.message_id).catch(() => { });
            return true;
        }
        if (command === '/unset_topic_announcement' && feature !== 'announcement') {
            bot.sendMessage(chatId, '⚠️ Topic này không được cài đặt tính năng Thông báo.', replyOptions)
                .then(m => setTimeout(() => bot.deleteMessage(chatId, m.message_id).catch(() => { }), 15000));
            bot.deleteMessage(chatId, msg.message_id).catch(() => { });
            return true;
        }

        const keyboard = [
            [{ text: '✅ Xác nhận Hủy', callback_data: 'topic_unset_confirm' }],
            [{ text: '❌ Quay lại', callback_data: 'topic_unset_cancel' }]
        ];

        bot.sendMessage(chatId, `⚠️ Bạn có chắc chắn muốn hủy cài đặt tính năng cho topic này không?`, {
            ...replyOptions,
            reply_markup: { inline_keyboard: keyboard }
        }).then(m => setTimeout(() => bot.deleteMessage(chatId, m.message_id).catch(() => { }), 30000));
        bot.deleteMessage(chatId, msg.message_id).catch(() => { });
        return true;
    }

    return false;
}

export async function sendRegulationDashboard(
    bot: TelegramBot,
    chatId: number,
    topicId: number,
    userRole: string,
    replyOptions: TelegramBot.SendMessageOptions
) {
    const regs = await db.query('SELECT id, title FROM regulations ORDER BY created_at DESC');
    let text = '';
    let keyboard: InlineKeyboardButton[][] = [];

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

    const deleteTime = userRole === 'admin' ? 60000 : 30000;

    return bot.sendMessage(chatId, text, {
        ...replyOptions,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboard }
    }).then(m => {
        trackMessage(chatId, m.message_id, 'regulation_list');
        setTimeout(() => bot.deleteMessage(chatId, m.message_id).catch(() => { }), deleteTime);
    });
}

export async function sendInformationDashboard(
    bot: TelegramBot,
    chatId: number,
    topicId: number,
    userRole: string,
    replyOptions: TelegramBot.SendMessageOptions
) {
    const users = await db.query("SELECT id, full_name, position FROM user_profiles WHERE status = 'active' ORDER BY full_name ASC");
    let text = '';
    let keyboard: InlineKeyboardButton[][] = [];

    if (userRole === 'admin') {
        text = '📇 *QUẢN LÝ NHÂN SỰ*\n\nChào Admin, vui lòng chọn chức năng quản lý bên dưới:';
        keyboard = users.rows.length > 0
            ? users.rows.map(u => [{ text: `👤 ${u.full_name} - ${u.position || 'Nhân viên'}`, callback_data: `info_view_${u.id}` }])
            : [];
        keyboard.push([
            { text: '➕ Thêm Nhân sự', url: `https://t.me/${botUsername}?start=admin_dashboard` },
            { text: '⚙️ Hủy cài đặt Topic', callback_data: 'topic_unset_request' }
        ]);
    } else {
        text = '📇 *DANH SÁCH NHÂN SỰ CÔNG TY*\n\nVui lòng chọn một thành viên bên dưới để xem chi tiết:';
        keyboard = users.rows.length > 0
            ? users.rows.map(u => [{ text: `👤 ${u.full_name} - ${u.position || 'Nhân viên'}`, callback_data: `info_view_${u.id}` }])
            : [];
    }

    keyboard.push([{ text: '🔄 Làm mới', callback_data: 'info_refresh_personnel' }, { text: '❌ Đóng', callback_data: 'info_close_message' }]);

    const deleteTime = userRole === 'admin' ? 60000 : 30000;

    bot.sendMessage(chatId, text, {
        ...replyOptions,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboard }
    }).then(m => {
        trackMessage(chatId, m.message_id, 'personnel_list');
        setTimeout(() => bot.deleteMessage(chatId, m.message_id).catch(() => { }), deleteTime);
    });
}

export async function sendReportDashboard(
    bot: TelegramBot,
    chatId: number,
    topicId: number,
    userRole: string,
    replyOptions: TelegramBot.SendMessageOptions
) {
    let text = '';
    let keyboard: InlineKeyboardButton[][] = [];

    if (userRole === 'admin') {
        text = '📊 *QUẢN LÝ TOPIC BÁO CÁO*\n\nChào Admin, vui lòng chọn chức năng quản lý bên dưới:';
        keyboard = [
            [{ text: '📋 Xem Thống kê Team', callback_data: 'rep_team_stats' }],
            [{ text: '📢 Chỉnh sửa Thông báo Ghim', callback_data: 'rep_admin_edit_announcement' }],
            [{ text: '⚙️ Hủy cài đặt Topic', callback_data: 'topic_unset_request' }]
        ];
    } else {
        text = '📊 *TOPIC BÁO CÁO*\n\nĐây là nơi tiếp nhận và quản lý các báo cáo của thành viên. Vui lòng chọn chức năng bên dưới:';
        keyboard = [
            [{ text: '📝 Gửi báo cáo công việc hằng ngày', url: `https://t.me/${botUsername}?start=create_report_daily_${chatId}_${topicId || 0}` }],
            [{ text: '📁 Gửi báo cáo dự án', url: `https://t.me/${botUsername}?start=create_report_project_${chatId}_${topicId || 0}` }],
            [{ text: '📋 Lịch sử báo cáo của tôi', url: `https://t.me/${botUsername}?start=my_reports` }]
        ];
    }

    keyboard.push([{ text: '❌ Đóng', callback_data: 'info_close_message' }]);

    const deleteTime = userRole === 'admin' ? 60000 : 30000;

    return bot.sendMessage(chatId, text, {
        ...replyOptions,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboard }
    }).then(m => setTimeout(() => bot.deleteMessage(chatId, m.message_id).catch(() => { }), deleteTime));
}

export async function sendAnnouncementDashboard(
    bot: TelegramBot,
    chatId: number,
    topicId: number,
    userRole: string,
    replyOptions: TelegramBot.SendMessageOptions
) {
    let text = '';
    let keyboard: InlineKeyboardButton[][] = [];

    if (userRole === 'admin') {
        const anns = await db.query("SELECT id, title FROM announcements WHERE is_holiday = false ORDER BY scheduled_at DESC LIMIT 10");
        text = '📢 *QUẢN LÝ THÔNG BÁO*\n\nChào Admin, vui lòng chọn chức năng quản lý bên dưới:';
        keyboard = anns.rows.length > 0
            ? anns.rows.map(a => [{ text: `📌 ${a.title}`, callback_data: `ann_admin_view_${a.id}` }])
            : [];
        keyboard.push([
            { text: '➕ Thêm Thông báo', url: `https://t.me/${botUsername}?start=create_announcement` },
            { text: '⚙️ Hủy cài đặt Topic', callback_data: 'topic_unset_request' }
        ]);
    } else {
        text = '📢 *THÔNG BÁO CÔNG TY*\n\nChào mừng bạn đến với kênh thông báo. Các thông báo mới sẽ được tự động gửi vào đây.';
    }

    keyboard.push([{ text: '🔄 Làm mới', callback_data: 'ann_reload' }, { text: '❌ Đóng', callback_data: 'info_close_message' }]);

    const deleteTime = userRole === 'admin' ? 60000 : 30000;

    return bot.sendMessage(chatId, text, {
        ...replyOptions,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: keyboard }
    }).then(m => setTimeout(() => bot.deleteMessage(chatId, m.message_id).catch(() => { }), deleteTime));
}

export async function handleTopicCallback(
    bot: TelegramBot,
    query: TelegramBot.CallbackQuery,
    data: string,
    userRole: string
): Promise<boolean> {
    const chatId = query.message?.chat.id;
    const messageId = query.message?.message_id;
    const topicId = query.message?.message_thread_id || 0;
    const userId = query.from.id;

    if (!chatId || !messageId) {
        console.warn('[TopicCallback] Missing chatId or messageId');
        return false;
    }

    console.log(`[TopicCallback] Data: ${data}, Role: ${userRole}, Topic: ${topicId}, Chat: ${chatId}`);

    if (data === 'topic_set_regulation' || data === 'topic_set_report' || data === 'topic_set_information' || data === 'topic_set_announcement') {
        if (userRole !== 'admin') {
            bot.answerCallbackQuery(query.id, { text: '❌ Chỉ Admin mới có quyền cài đặt.', show_alert: true });
            return true;
        }

        const featureType = data === 'topic_set_regulation' ? 'regulation' : (data === 'topic_set_report' ? 'report' : (data === 'topic_set_information' ? 'information' : 'announcement'));
        const featureName = featureType === 'regulation' ? 'Nội quy' : (featureType === 'report' ? 'Báo cáo' : (featureType === 'information' ? 'Thông tin' : 'Thông báo'));

        try {
            // Check if already set in another topic
            const otherTopicRes = await db.query(
                "SELECT topic_id, name FROM topics WHERE chat_id = $1 AND feature_type = $2 AND topic_id != $3",
                [chatId, featureType, topicId]
            );
            if (otherTopicRes.rows.length > 0) {
                const otherTopic = otherTopicRes.rows[0];
                bot.answerCallbackQuery(query.id, {
                    text: `⚠️ Tính năng ${featureName} đã được cài đặt tại topic khác: ${otherTopic.name} (ID: ${otherTopic.topic_id}).`,
                    show_alert: true
                });
                bot.deleteMessage(chatId, messageId).catch(() => { });
                return true;
            }

            let text = '';
            let keyboard: InlineKeyboardButton[][] = [];

            if (featureType === 'regulation') {
                const regs = await db.query('SELECT id, title FROM regulations ORDER BY created_at DESC');
                keyboard = regs.rows.length > 0
                    ? regs.rows.map(r => [{ text: `📖 ${r.title}`, callback_data: `reg_view_${r.id}` }])
                    : [];

                const now = new Date();
                const timeStr = now.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                const dateStr = now.toLocaleDateString('vi-VN');
                text = '📜 *DANH SÁCH NỘI QUY CÔNG TY*\n\n' +
                    (regs.rows.length > 0 ? 'Chọn một mục bên dưới để xem chi tiết:' : 'Hiện tại chưa có nội quy nào.') +
                    `\n\n_(Cập nhật lúc: ${timeStr} - ${dateStr})_`;

                const sentMsg = await bot.sendMessage(chatId, text, {
                    message_thread_id: topicId || undefined,
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: keyboard }
                });
                await bot.pinChatMessage(chatId, sentMsg.message_id).catch(console.error);

                await db.query(`
          INSERT INTO topics (chat_id, topic_id, name, feature_type, pinned_message_id) 
          VALUES ($1, $2, $3, $4, $5) 
          ON CONFLICT (chat_id, topic_id) 
          DO UPDATE SET feature_type = $4, pinned_message_id = $5, name = $3
        `, [chatId, topicId || 0, query.message?.chat.title || `${featureName} Topic`, featureType, sentMsg.message_id]);
            } else if (featureType === 'report') {
                const text = '📊 *TOPIC BÁO CÁO*\n\nĐây là nơi tiếp nhận và quản lý các báo cáo của thành viên. Vui lòng chọn chức năng bên dưới:';
                const keyboard: InlineKeyboardButton[][] = [
                    [{ text: '📝 Gửi báo cáo công việc hằng ngày', url: `https://t.me/${botUsername}?start=create_report_daily_${chatId}_${topicId || 0}` }],
                    [{ text: '📁 Gửi báo cáo dự án', url: `https://t.me/${botUsername}?start=create_report_project_${chatId}_${topicId || 0}` }],
                    [{ text: '📋 Lịch sử báo cáo của tôi', url: `https://t.me/${botUsername}?start=my_reports` }]
                ];

                const sentMsg = await bot.sendMessage(chatId, text, {
                    message_thread_id: topicId || undefined,
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: keyboard }
                });
                await bot.pinChatMessage(chatId, sentMsg.message_id).catch(console.error);

                await db.query(`
          INSERT INTO topics (chat_id, topic_id, name, feature_type, pinned_message_id) 
          VALUES ($1, $2, $3, $4, $5) 
          ON CONFLICT (chat_id, topic_id) 
          DO UPDATE SET feature_type = $4, pinned_message_id = $5, name = $3
        `, [chatId, topicId || 0, query.message?.chat.title || `${featureName} Topic`, featureType, sentMsg.message_id]);
            } else if (featureType === 'information') {
                const users = await db.query("SELECT id, full_name, position FROM user_profiles WHERE status = 'active' ORDER BY full_name ASC");
                const keyboard = users.rows.length > 0
                    ? users.rows.map(u => [{ text: `👤 ${u.full_name} - ${u.position || 'Nhân viên'}`, callback_data: `info_view_${u.id}` }])
                    : [];

                const now = new Date();
                const timeStr = now.toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
                const dateStr = now.toLocaleDateString('vi-VN');
                const text = '📇 *DANH SÁCH NHÂN SỰ CÔNG TY*\n\n' +
                    (users.rows.length > 0 ? 'Chọn một thành viên bên dưới để xem thông tin chi tiết:' : 'Hiện tại chưa có thông tin nhân sự nào.') +
                    `\n\n_(Cập nhật lúc: ${timeStr} - ${dateStr})_`;

                const sentMsg = await bot.sendMessage(chatId, text, {
                    message_thread_id: topicId || undefined,
                    parse_mode: 'Markdown',
                    reply_markup: { inline_keyboard: keyboard }
                });
                await bot.pinChatMessage(chatId, sentMsg.message_id).catch(console.error);

                await db.query(`
          INSERT INTO topics (chat_id, topic_id, name, feature_type, pinned_message_id) 
          VALUES ($1, $2, $3, $4, $5) 
          ON CONFLICT (chat_id, topic_id) 
          DO UPDATE SET feature_type = $4, pinned_message_id = $5, name = $3
        `, [chatId, topicId || 0, query.message?.chat.title || `${featureName} Topic`, featureType, sentMsg.message_id]);
            } else if (featureType === 'announcement') {
                const text = '📢 *THÔNG BÁO CÔNG TY*\n\nChào mừng bạn đến với kênh thông báo. Các thông báo mới sẽ được tự động gửi vào đây.';
                const sentMsg = await bot.sendMessage(chatId, text, {
                    message_thread_id: topicId || undefined,
                    parse_mode: 'Markdown'
                });
                await bot.pinChatMessage(chatId, sentMsg.message_id).catch(console.error);

                await db.query(`
          INSERT INTO topics (chat_id, topic_id, name, feature_type, pinned_message_id) 
          VALUES ($1, $2, $3, $4, $5) 
          ON CONFLICT (chat_id, topic_id) 
          DO UPDATE SET feature_type = $4, pinned_message_id = $5, name = $3
        `, [chatId, topicId || 0, query.message?.chat.title || `${featureName} Topic`, featureType, sentMsg.message_id]);
            }

            topicCache.delete(topicId || chatId);

            bot.answerCallbackQuery(query.id, { text: `✅ Đã thiết lập tính năng ${featureName}!` });
            bot.editMessageText(`✅ Nhóm/Topic này đã được thiết lập làm nơi ${featureName}!`, {
                chat_id: chatId,
                message_id: messageId
            });
            setTimeout(() => bot.deleteMessage(chatId, messageId).catch(() => { }), 15000);
        } catch (err: any) {
            console.error('Error setting topic via callback:', err);
            bot.answerCallbackQuery(query.id, { text: '❌ Lỗi database: ' + err.message, show_alert: true });
        }
        return true;
    }

    if (data === 'topic_unset_request') {
        if (userRole !== 'admin') {
            bot.answerCallbackQuery(query.id, { text: '❌ Chỉ Admin mới có quyền.', show_alert: true });
            return true;
        }
        const keyboard = [
            [{ text: '✅ Xác nhận Hủy', callback_data: 'topic_unset_confirm' }],
            [{ text: '❌ Quay lại', callback_data: 'topic_unset_cancel' }]
        ];
        bot.editMessageText('⚠️ Bạn có chắc chắn muốn hủy cài đặt tính năng cho topic này không?', {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: { inline_keyboard: keyboard }
        }).catch(console.error);
        bot.answerCallbackQuery(query.id);
        return true;
    }

    if (data === 'topic_unset_confirm') {
        console.log(`[TopicCallback] Processing unset confirm for chat ${chatId}, topic ${topicId}`);
        if (userRole !== 'admin') {
            bot.answerCallbackQuery(query.id, { text: '❌ Chỉ Admin mới có quyền hủy cài đặt.', show_alert: true });
            return true;
        }

        try {
            const existingTopic = await db.query(
                "SELECT pinned_message_id FROM topics WHERE chat_id = $1 AND topic_id = $2",
                [chatId, topicId]
            );

            if (existingTopic.rows.length > 0) {
                const oldMessageId = existingTopic.rows[0].pinned_message_id;
                console.log(`[TopicCallback] Found existing topic, pinned message: ${oldMessageId}`);
                if (oldMessageId) {
                    bot.unpinChatMessage(chatId, { message_id: oldMessageId }).catch(err => console.warn('[TopicCallback] Unpin failed:', err.message));
                    bot.deleteMessage(chatId, oldMessageId).catch(err => console.warn('[TopicCallback] Delete pinned failed:', err.message));
                }

                await db.query(
                    "UPDATE topics SET feature_type = 'discussion', pinned_message_id = NULL WHERE chat_id = $1 AND topic_id = $2",
                    [chatId, topicId]
                );
                topicCache.delete(topicId || chatId);

                await bot.editMessageText('✅ Đã hủy cài đặt tính năng cho topic này thành công.', {
                    chat_id: chatId,
                    message_id: messageId
                }).catch(err => console.warn('[TopicCallback] Edit message failed:', err.message));

                setTimeout(() => bot.deleteMessage(chatId, messageId).catch(() => { }), 10000);
            } else {
                console.log(`[TopicCallback] No existing topic found for chat ${chatId}, topic ${topicId}`);
                bot.answerCallbackQuery(query.id, { text: '⚠️ Topic này chưa được cài đặt tính năng nào.', show_alert: true });
                bot.deleteMessage(chatId, messageId).catch(() => { });
                return true;
            }
            bot.answerCallbackQuery(query.id);
            return true;
        } catch (err) {
            console.error('[TopicCallback] Error unsetting topic:', err);
            bot.answerCallbackQuery(query.id, { text: '❌ Lỗi khi hủy cài đặt.', show_alert: true });
            return true;
        }
    }

    if (data === 'topic_unset_cancel') {
        const topicRes = await db.query(
            'SELECT feature_type FROM topics WHERE chat_id = $1 AND topic_id = $2',
            [chatId, topicId]
        );
        const feature = topicRes.rows[0]?.feature_type;
        const options = { message_thread_id: topicId || undefined };

        if (feature === 'regulation') {
            await sendRegulationDashboard(bot, chatId, topicId, userRole, options);
        } else if (feature === 'report') {
            await sendReportDashboard(bot, chatId, topicId, userRole, options);
        } else if (feature === 'information') {
            await sendInformationDashboard(bot, chatId, topicId, userRole, options);
        } else if (feature === 'announcement') {
            await sendAnnouncementDashboard(bot, chatId, topicId, userRole, options);
        } else {
            // If no feature, just show the setup menu
            handleSetTopicCommand(bot, {
                chat: { id: chatId, type: 'supergroup' },
                message_thread_id: topicId,
                from: query.from
            } as any, '/menu', userRole, true, options);
        }

        bot.deleteMessage(chatId, messageId).catch(() => { });
        bot.answerCallbackQuery(query.id);
        return true;
    }

    return false;
}

export async function getTopicFeature(chatId: number, topicId: number): Promise<{ feature: string, targetId: number }> {
    const targetId = topicId || chatId;
    const now = Date.now();
    const cached = topicCache.get(targetId);

    if (cached && now < cached.expire) {
        return { feature: cached.feature, targetId };
    }

    try {
        const res = await db.query(
            'SELECT feature_type FROM topics WHERE chat_id = $1 AND topic_id = $2',
            [chatId, topicId || 0]
        );
        const feature = res.rows[0]?.feature_type || 'discussion';
        topicCache.set(targetId, { feature, expire: now + CACHE_TTL });
        return { feature, targetId };
    } catch (err) {
        console.error('Error getting topic feature:', err);
        return { feature: 'discussion', targetId };
    }
}
