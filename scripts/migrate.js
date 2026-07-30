import { readFile } from 'node:fs/promises';
import postgres from 'postgres';

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL manquant');
const sql = postgres(process.env.DATABASE_URL, { max: 1 });
try {
  await sql.unsafe(await readFile(new URL('../db/migrations/001_initial.sql', import.meta.url), 'utf8'));
  console.log('Migration Neon appliquée.');
} finally {
  await sql.end();
}
