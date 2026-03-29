import type { Knex } from 'knex';
import dotenv from 'dotenv';
import path from 'path';

// .env lives at the project root, one level above backend/
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const config: Knex.Config = {
  client: 'pg',
  connection: process.env.DATABASE_URL,
  migrations: {
    directory: './src/db/migrations',
    extension: 'ts',
  },
};

export default config;
