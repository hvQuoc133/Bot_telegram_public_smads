import { bot } from '../botInstance';
import { db } from '../../db';

const HOLIDAYS = [
    { date: '01-01', name: 'Tết Dương Lịch' },
    { date: '04-30', name: 'Ngày Giải phóng miền Nam' },
    { date: '05-01', name: 'Ngày Quốc tế Lao động' },
    { date: '09-02', name: 'Quốc khánh' },
];

async function getAnnouncementTopics() {
    const res = await db.query("SELECT chat_id, topic_id FROM topics WHERE feature_type = 'announcement'");
    return res.rows;
}

export async function checkScheduledAnnouncements() {
    try {
        const now = new Date();
        const res = await db.query(
            "SELECT id, title, content, event_start_time, event_end_time FROM announcements WHERE status = 'scheduled' AND scheduled_at <= $1",
            [now]
        );

        if (res.rows.length === 0) return;

        const topics = await getAnnouncementTopics();

        for (const ann of res.rows) {
            let timeText = '';
            if (ann.event_start_time && ann.event_end_time) {
                timeText = `\n⏰ *Thời gian:* ${new Date(ann.event_start_time).toLocaleString('vi-VN')} - ${new Date(ann.event_end_time).toLocaleString('vi-VN')}\n`;
            } else if (ann.event_start_time) {
                timeText = `\n⏰ *Bắt đầu:* ${new Date(ann.event_start_time).toLocaleString('vi-VN')}\n`;
            } else if (ann.event_end_time) {
                timeText = `\n⏰ *Kết thúc:* ${new Date(ann.event_end_time).toLocaleString('vi-VN')}\n`;
            }

            const text = `📢 *THÔNG BÁO*\n\n*${ann.title}*${timeText}\n${ann.content}`;

            for (const topic of topics) {
                try {
                    await bot.sendMessage(topic.chat_id, text, {
                        message_thread_id: topic.topic_id || undefined,
                        parse_mode: 'Markdown'
                    });
                } catch (err) {
                    console.error(`Failed to send announcement to ${topic.chat_id}/${topic.topic_id}:`, err);
                }
            }

            await db.query("UPDATE announcements SET status = 'published' WHERE id = $1", [ann.id]);
        }
    } catch (err) {
        console.error('Error checking scheduled announcements:', err);
    }
}

export async function checkUpcomingHolidays() {
    try {
        const now = new Date();
        const nextWeek = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

        const month = String(nextWeek.getMonth() + 1).padStart(2, '0');
        const day = String(nextWeek.getDate()).padStart(2, '0');
        const dateStr = `${month}-${day}`;

        const holiday = HOLIDAYS.find(h => h.date === dateStr);

        if (holiday) {
            // Check if we already created an announcement for this holiday this year
            const year = nextWeek.getFullYear();
            const title = `Thông báo sắp đến ${holiday.name} ${year}`;

            const existing = await db.query(
                "SELECT id FROM announcements WHERE title = $1 AND is_holiday = true",
                [title]
            );

            if (existing.rows.length === 0) {
                const content = `Chỉ còn 1 tuần nữa là đến ${holiday.name}! Chúc mọi người chuẩn bị kỳ nghỉ vui vẻ.`;

                // Create and publish immediately
                await db.query(
                    "INSERT INTO announcements (title, content, is_holiday, status, created_by) VALUES ($1, $2, true, 'published', NULL)",
                    [title, content]
                );

                const topics = await getAnnouncementTopics();
                const text = `📢 *THÔNG BÁO LỄ*\n\n*${title}*\n\n${content}`;

                for (const topic of topics) {
                    try {
                        await bot.sendMessage(topic.chat_id, text, {
                            message_thread_id: topic.topic_id || undefined,
                            parse_mode: 'Markdown'
                        });
                    } catch (err) {
                        console.error(`Failed to send holiday announcement to ${topic.chat_id}/${topic.topic_id}:`, err);
                    }
                }
            }
        }
    } catch (err) {
        console.error('Error checking upcoming holidays:', err);
    }
}

export function startScheduler() {
    // Check every minute
    setInterval(() => {
        checkScheduledAnnouncements();
    }, 60 * 1000);

    // Check holidays every day at a specific time, or just every hour
    setInterval(() => {
        checkUpcomingHolidays();
    }, 60 * 60 * 1000);

    // Run once on startup
    checkScheduledAnnouncements();
    checkUpcomingHolidays();
}
