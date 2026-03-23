import { db } from '../../db';

export type UserState =
  | 'idle'
  | 'selecting_edit_regulation'
  | 'selecting_delete_regulation'
  | 'confirming_delete'
  | 'creating_regulation_step_1'
  | 'creating_regulation_step_2'
  | 'editing_regulation_step_1'
  | 'editing_regulation_step_2'
  | 'creating_report_step_title'
  | 'creating_report_step_content'
  | 'creating_report_step_attachments'
  | 'report_title'
  | 'report_content'
  | 'report_media'
  | 'adding_admin'
  | 'removing_admin'
  | 'adding_admin_group_prompt'
  | 'editing_report_announcement'
  | 'adding_personnel_name'
  | 'adding_personnel_birthday'
  | 'adding_personnel_position'
  | 'adding_personnel_phone'
  | 'editing_personnel_name'
  | 'editing_personnel_birthday'
  | 'editing_personnel_position'
  | 'editing_personnel_phone'
  | 'creating_announcement_step_1'
  | 'creating_announcement_step_2'
  | 'creating_announcement_step_3'
  | 'creating_announcement_step_4'
  | 'creating_announcement_step_5_options'
  | 'creating_announcement_step_5'
  | 'editing_announcement_step_1'
  | 'editing_announcement_step_2'
  | 'editing_announcement_step_3'
  | 'editing_announcement_step_4'
  | 'editing_announcement_step_5_options'
  | 'editing_announcement_step_5'
  | 'adding_tool_category_name'
  | 'adding_tool_category_desc'
  | 'editing_tool_category_name'
  | 'editing_tool_category_desc'
  | 'adding_tool_name'
  | 'adding_tool_desc'
  | 'adding_tool_link_or_file'
  | 'editing_tool_name'
  | 'editing_tool_desc'
  | 'editing_tool_link_or_file';

export interface SessionData {
  state: UserState;
  lastActive: number;
  tempData?: any;
  activeMessageId?: number;
  navigationStack?: string[];
}

const sessions = new Map<number, SessionData>();

const SESSION_TIMEOUT = 10 * 60 * 1000; // 10 minutes

export const roleCache = new Map<number, { role: string, expire: number }>();
export const topicCache = new Map<number, { feature: string, expire: number }>();
export const CACHE_TTL = 60000; // 1 minute

export function getSession(userId: number): SessionData {
  const now = Date.now();
  let session = sessions.get(userId);

  if (!session || (now - session.lastActive > SESSION_TIMEOUT)) {
    if (session && session.state.startsWith('editing_regulation_step_')) {
      const regId = session.tempData?.regId;
      if (regId) {
        db.query('UPDATE regulations SET locked_by = NULL, locked_at = NULL WHERE id = $1 AND locked_by = $2', [regId, userId]).catch(console.error);
      }
    }
    session = {
      state: 'idle',
      lastActive: now,
      tempData: {},
      navigationStack: [],
    };
    sessions.set(userId, session);
  } else {
    session.lastActive = now;
  }

  return session;
}

export function updateSession(userId: number, data: Partial<SessionData>) {
  const session = getSession(userId);
  Object.assign(session, data);
  session.lastActive = Date.now();
  sessions.set(userId, session);
}

export function clearSession(userId: number) {
  const session = sessions.get(userId);
  if (session && session.state.startsWith('editing_regulation_step_')) {
    const regId = session.tempData?.regId;
    if (regId) {
      db.query('UPDATE regulations SET locked_by = NULL, locked_at = NULL WHERE id = $1 AND locked_by = $2', [regId, userId]).catch(console.error);
    }
  }
  sessions.set(userId, {
    state: 'idle',
    lastActive: Date.now(),
    tempData: {},
    navigationStack: [],
  });
}

// Cleanup inactive sessions periodically
setInterval(() => {
  const now = Date.now();
  for (const [userId, session] of sessions.entries()) {
    if (now - session.lastActive > SESSION_TIMEOUT) {
      if (session.state.startsWith('editing_regulation_step_')) {
        const regId = session.tempData?.regId;
        if (regId) {
          db.query('UPDATE regulations SET locked_by = NULL, locked_at = NULL WHERE id = $1 AND locked_by = $2', [regId, userId]).catch(console.error);
        }
      }
      sessions.delete(userId);
    }
  }
}, 60 * 1000); // Run every minute
