import axios from 'axios';
import TelegramBot from 'node-telegram-bot-api';

export async function getFileBase64(bot: TelegramBot, fileId: string): Promise<string> {
    try {
        const file = await bot.getFile(fileId);
        const token = process.env.TELEGRAM_BOT_TOKEN;
        const fileUrl = `https://api.telegram.org/file/bot${token}/${file.file_path}`;

        const response = await axios.get(fileUrl, { responseType: 'arraybuffer' });
        const buffer = Buffer.from(response.data, 'binary');
        return buffer.toString('base64');
    } catch (error) {
        console.error(`Error downloading file ${fileId}:`, error);
        throw error;
    }
}
