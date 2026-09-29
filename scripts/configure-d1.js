import fs from 'node:fs';
import path from 'node:path';

const databaseId = String(process.env.D1_DATABASE_ID || '').trim();
if (!databaseId) {
  throw new Error('D1_DATABASE_ID is required');
}

const configPath = path.resolve(process.cwd(), 'wrangler.jsonc');
const source = fs.readFileSync(configPath, 'utf8');
const pattern = /("database_id"\s*:\s*)"[^"]*"/;
if (!pattern.test(source)) {
  throw new Error('wrangler.jsonc has no database_id field');
}

const updated = source.replace(pattern, (_match, prefix) => `${prefix}${JSON.stringify(databaseId)}`);
fs.writeFileSync(configPath, updated);
console.log('Configured wrangler.jsonc with D1_DATABASE_ID');
