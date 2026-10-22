import Redis from 'ioredis';
import logger from './logger.js';

// Redis is opt-in: without REDIS_URL everything runs on in-memory fallbacks.
export const redisClient = process.env.REDIS_URL
  ? new Redis(process.env.REDIS_URL, { maxRetriesPerRequest: 1 })
  : null;

let ready = false;

if (redisClient) {
  redisClient.on('ready', () => {
    ready = true;
    logger.info('Redis ready');
  });
  redisClient.on('close', () => {
    if (ready) logger.warn('Redis connection lost, falling back to memory');
    ready = false;
  });
  redisClient.on('error', () => {}); // 'close' above already reports state changes
}

export const getRedis = () => (ready ? redisClient : null);
export const isRedisAvailable = () => ready;
export const closeRedis = () => redisClient?.quit();
