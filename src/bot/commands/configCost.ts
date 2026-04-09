import TelegramBot from 'node-telegram-bot-api';
import { db } from '../../db';
import { getSession, updateSession, clearSession } from '../services/sessionManager';

export function setupConfigCostCommand(bot: TelegramBot) {
    bot.onText(/^\/config_cost/, async (msg) => {
        const chatId = msg.chat.id;
        const userId = msg.from?.id;

        if (!userId) return;

        try {
            const userRes = await db.query('SELECT role FROM users WHERE id = $1', [userId]);
            if (userRes.rows.length === 0 || userRes.rows[0].role !== 'admin') {
                bot.sendMessage(chatId, '❌ Bạn không có quyền sử dụng lệnh này.');
                return;
            }

            bot.sendMessage(chatId, '⚙️ *CẤU HÌNH SHEET & FOLDER CHI PHÍ*\n\nVui lòng nhập Tháng và Năm (Định dạng: MM/YYYY, VD: 04/2026):', { parse_mode: 'Markdown' }).then(m => {
                updateSession(userId, {
                    state: 'config_cost_month',
                    tempData: { promptMessageId: m.message_id }
                });
            });
        } catch (error) {
            console.error('Error in /config_cost:', error);
        }
    });
}

export async function handleConfigCostMessage(bot: TelegramBot, msg: TelegramBot.Message): Promise<boolean> {
    const chatId = msg.chat.id;
    const userId = msg.from?.id;
    const text = msg.text || '';

    if (!userId) return false;

    const session = getSession(userId);
    if (!session || !session.state.startsWith('config_cost_')) return false;

    switch (session.state) {
        case 'config_cost_month': {
            if (session.tempData.promptMessageId) bot.deleteMessage(chatId, session.tempData.promptMessageId).catch(() => { });
            bot.deleteMessage(chatId, msg.message_id).catch(() => { });

            const match = text.match(/^(\d{1,2})\/(\d{4})$/);
            if (!match) {
                bot.sendMessage(chatId, '⚠️ Định dạng không hợp lệ. Vui lòng nhập lại (MM/YYYY):').then(m => {
                    updateSession(userId, { state: 'config_cost_month', tempData: { promptMessageId: m.message_id } });
                });
                return true;
            }

            const month = parseInt(match[1], 10);
            const year = parseInt(match[2], 10);

            bot.sendMessage(chatId, `Tháng ${month}/${year}\n\n🔗 Vui lòng nhập Link Google Sheet cho tháng này:`).then(m => {
                updateSession(userId, {
                    state: 'config_cost_sheet',
                    tempData: { month, year, promptMessageId: m.message_id }
                });
            });
            return true;
        }

        case 'config_cost_sheet': {
            if (session.tempData.promptMessageId) bot.deleteMessage(chatId, session.tempData.promptMessageId).catch(() => { });
            bot.deleteMessage(chatId, msg.message_id).catch(() => { });

            if (!text.includes('docs.google.com/spreadsheets')) {
                bot.sendMessage(chatId, '⚠️ Link Google Sheet không hợp lệ. Vui lòng nhập lại:').then(m => {
                    updateSession(userId, { state: 'config_cost_sheet', tempData: { ...session.tempData, promptMessageId: m.message_id } });
                });
                return true;
            }

            bot.sendMessage(chatId, `🔗 Vui lòng nhập Link Google Drive Folder chứa ảnh chứng từ cho tháng này:`).then(m => {
                updateSession(userId, {
                    state: 'config_cost_folder',
                    tempData: { ...session.tempData, sheetUrl: text, promptMessageId: m.message_id }
                });
            });
            return true;
        }

        case 'config_cost_folder': {
            if (session.tempData.promptMessageId) bot.deleteMessage(chatId, session.tempData.promptMessageId).catch(() => { });
            bot.deleteMessage(chatId, msg.message_id).catch(() => { });

            if (!text.includes('drive.google.com/drive/folders') && !text.includes('drive.google.com/open')) {
                bot.sendMessage(chatId, '⚠️ Link Folder không hợp lệ. Vui lòng nhập lại:').then(m => {
                    updateSession(userId, { state: 'config_cost_folder', tempData: { ...session.tempData, promptMessageId: m.message_id } });
                });
                return true;
            }

            const { month, year, sheetUrl } = session.tempData;
            const folderUrl = text;

            try {
                await db.query(
                    `INSERT INTO monthly_configs (month, year, sheet_url, folder_url, created_by)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (month, year) DO UPDATE 
           SET sheet_url = EXCLUDED.sheet_url, folder_url = EXCLUDED.folder_url, updated_at = CURRENT_TIMESTAMP`,
                    [month, year, sheetUrl, folderUrl, userId]
                );

                bot.sendMessage(chatId, `✅ *Cấu hình thành công!*\n\nTháng: ${month}/${year}\nSheet: ${sheetUrl}\nFolder: ${folderUrl}`, { parse_mode: 'Markdown' });
                clearSession(userId);
            } catch (err) {
                console.error('Error saving config:', err);
                bot.sendMessage(chatId, '❌ Có lỗi xảy ra khi lưu cấu hình.');
            }
            return true;
        }
    }

    return false;
}
