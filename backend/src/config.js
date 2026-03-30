import dotenv from 'dotenv';

dotenv.config();

function asNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export const PORT = asNumber(process.env.PORT, 4000);
export const DB_HOST = process.env.DB_HOST || '127.0.0.1';
export const DB_PORT = asNumber(process.env.DB_PORT, 3306);
export const DB_USER = process.env.DB_USER || 'root';
export const DB_PASSWORD = process.env.DB_PASSWORD || '';
export const DB_NAME = process.env.DB_NAME || 'bedrock_network';
export const NETWORK_SHARED_SECRET = process.env.NETWORK_SHARED_SECRET || 'troque-este-segredo';
export const SESSION_TTL_SECONDS = asNumber(process.env.SESSION_TTL_SECONDS, 60);

