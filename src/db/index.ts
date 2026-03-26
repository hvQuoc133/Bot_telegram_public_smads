import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

export const db = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export async function initDb() {
  const client = await db.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id BIGINT PRIMARY KEY,
        username VARCHAR(255),
        first_name VARCHAR(255),
        role VARCHAR(50) DEFAULT 'user',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      
      -- Add first_name and last_name columns if they don't exist
      ALTER TABLE users ADD COLUMN IF NOT EXISTS first_name VARCHAR(255);
      ALTER TABLE users ADD COLUMN IF NOT EXISTS last_name VARCHAR(255);

      CREATE TABLE IF NOT EXISTS topics (
        id SERIAL PRIMARY KEY,
        chat_id BIGINT NOT NULL,
        topic_id BIGINT,
        name VARCHAR(255) NOT NULL,
        feature_type VARCHAR(50) NOT NULL,
        pinned_message_id BIGINT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(chat_id, topic_id)
      );

      CREATE TABLE IF NOT EXISTS regulations (
        id SERIAL PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        content TEXT NOT NULL,
        created_by BIGINT REFERENCES users(id),
        locked_by BIGINT REFERENCES users(id),
        locked_at TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Ensure columns exist if table was already created
      ALTER TABLE topics ADD COLUMN IF NOT EXISTS id SERIAL;
      ALTER TABLE topics ADD COLUMN IF NOT EXISTS chat_id BIGINT;
      ALTER TABLE topics ADD COLUMN IF NOT EXISTS topic_id BIGINT DEFAULT 0;
      ALTER TABLE topics ADD COLUMN IF NOT EXISTS name VARCHAR(255);
      ALTER TABLE topics ADD COLUMN IF NOT EXISTS feature_type VARCHAR(50);
      ALTER TABLE topics ADD COLUMN IF NOT EXISTS pinned_message_id BIGINT;
      ALTER TABLE topics ADD COLUMN IF NOT EXISTS custom_announcement TEXT;

      -- Fix for 'id' column not being auto-incrementing if it was created manually
      DO $$
      BEGIN
        -- Ensure id exists
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'topics' AND column_name = 'id') THEN
          ALTER TABLE topics ADD COLUMN id SERIAL;
        END IF;

        -- Ensure id is NOT NULL
        ALTER TABLE topics ALTER COLUMN id SET NOT NULL;

        -- Ensure id has a sequence if it doesn't have a default
        IF NOT EXISTS (SELECT 1 FROM pg_attrdef WHERE adrelid = 'topics'::regclass AND adnum = (SELECT attnum FROM pg_attribute WHERE attrelid = 'topics'::regclass AND attname = 'id')) THEN
          CREATE SEQUENCE IF NOT EXISTS topics_id_seq;
          ALTER TABLE topics ALTER COLUMN id SET DEFAULT nextval('topics_id_seq');
          PERFORM setval('topics_id_seq', COALESCE((SELECT MAX(id) FROM topics), 0) + 1);
        END IF;
      END
      $$;

      -- Update existing rows to have 0 instead of NULL for topic_id
      UPDATE topics SET topic_id = 0 WHERE topic_id IS NULL;
      ALTER TABLE topics ALTER COLUMN topic_id SET DEFAULT 0;
      ALTER TABLE topics ALTER COLUMN topic_id SET NOT NULL;

      CREATE TABLE IF NOT EXISTS user_profiles (
        id SERIAL PRIMARY KEY,
        user_id BIGINT UNIQUE REFERENCES users(id),
        full_name VARCHAR(255) NOT NULL,
        birthday VARCHAR(50),
        position VARCHAR(255),
        phone VARCHAR(50),
        email VARCHAR(255),
        status VARCHAR(50) DEFAULT 'active',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      ALTER TABLE user_profiles ADD COLUMN IF NOT EXISTS email VARCHAR(255);

      CREATE TABLE IF NOT EXISTS reports (
        id SERIAL PRIMARY KEY,
        user_id BIGINT NOT NULL,
        chat_id BIGINT NOT NULL,
        topic_id BIGINT DEFAULT 0,
        title TEXT,
        content TEXT,
        status VARCHAR(20) DEFAULT 'draft',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Ensure columns exist if table was already created with old schema
      ALTER TABLE reports ADD COLUMN IF NOT EXISTS chat_id BIGINT;
      ALTER TABLE reports ADD COLUMN IF NOT EXISTS topic_id BIGINT DEFAULT 0;
      ALTER TABLE reports ADD COLUMN IF NOT EXISTS status VARCHAR(20) DEFAULT 'draft';
      ALTER TABLE reports ADD COLUMN IF NOT EXISTS report_type VARCHAR(50) DEFAULT 'daily';
      ALTER TABLE reports ALTER COLUMN title TYPE TEXT;
      ALTER TABLE reports ALTER COLUMN title DROP NOT NULL;
      ALTER TABLE reports ALTER COLUMN user_id SET NOT NULL;
      
      -- Handle legacy columns from previous schema versions
      DO $$
      BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'reports' AND column_name = 'report_date') THEN
          ALTER TABLE reports ALTER COLUMN report_date DROP NOT NULL;
        END IF;
        IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name = 'reports' AND column_name = 'file_url') THEN
          ALTER TABLE reports ALTER COLUMN file_url DROP NOT NULL;
        END IF;
      END
      $$;

      CREATE TABLE IF NOT EXISTS report_attachments (
        id SERIAL PRIMARY KEY,
        report_id INTEGER REFERENCES reports(id) ON DELETE CASCADE,
        file_id TEXT NOT NULL,
        file_type VARCHAR(20) NOT NULL,
        file_unique_id TEXT
      );

      CREATE TABLE IF NOT EXISTS announcements (
        id SERIAL PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        content TEXT NOT NULL,
        scheduled_at TIMESTAMP,
        is_holiday BOOLEAN DEFAULT FALSE,
        status VARCHAR(50) DEFAULT 'pending',
        created_by BIGINT REFERENCES users(id),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      ALTER TABLE announcements ALTER COLUMN scheduled_at DROP NOT NULL;
      ALTER TABLE announcements ADD COLUMN IF NOT EXISTS event_start_time TIMESTAMP;
      ALTER TABLE announcements ADD COLUMN IF NOT EXISTS event_end_time TIMESTAMP;

      -- Add unique constraint if it doesn't exist
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'topics_chat_id_topic_id_key') THEN
          ALTER TABLE topics ADD CONSTRAINT topics_chat_id_topic_id_key UNIQUE (chat_id, topic_id);
        END IF;
      END
      $$;
      CREATE TABLE IF NOT EXISTS proposals (
        id SERIAL PRIMARY KEY,
        proposal_code VARCHAR(50) UNIQUE NOT NULL,
        user_id BIGINT NOT NULL REFERENCES users(id),
        chat_id BIGINT NOT NULL,
        topic_id BIGINT DEFAULT 0,
        type VARCHAR(50) NOT NULL,
        content TEXT NOT NULL,
        apply_time TEXT,
        cost TEXT,
        file_id TEXT,
        file_type VARCHAR(20),
        status VARCHAR(20) DEFAULT 'PENDING',
        admin_id BIGINT REFERENCES users(id),
        reject_reason TEXT,
        message_id BIGINT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS tool_categories (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        created_by BIGINT REFERENCES users(id),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS tools (
        id SERIAL PRIMARY KEY,
        category_id INTEGER REFERENCES tool_categories(id) ON DELETE CASCADE,
        name VARCHAR(255) NOT NULL,
        description TEXT,
        link TEXT,
        file_id VARCHAR(255),
        file_type VARCHAR(50),
        created_by BIGINT REFERENCES users(id),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);
    console.log('Database tables initialized');
  } finally {
    client.release();
  }
}
