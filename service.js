require('dotenv').config();
const { createClient } = require('redis');

const redis = createClient({
  url: process.env.REDIS_URL || `redis://${process.env.REDIS_HOST || 'localhost'}:${process.env.REDIS_PORT || 6379}`
});
redis.on('error', err => console.error('Redis error:', err.message));

async function connect() {
  if (!redis.isOpen) await redis.connect();
}

/** Atomically reserve stock. Returns success and the remaining stock count. */
async function decreaseStock(sku, quantityToBuy) {
  if (!sku || !Number.isInteger(Number(quantityToBuy)) || Number(quantityToBuy) <= 0) {
    throw new TypeError('sku and a positive integer quantity are required');
  }
  await connect();
  const result = Number(await redis.eval(`
    local current = tonumber(redis.call('GET', KEYS[1]) or '-1')
    local qty = tonumber(ARGV[1])
    if current < 0 then return -1 end
    if current < qty then return -2 end
    return redis.call('DECRBY', KEYS[1], qty)
  `, {
    keys: [`product:${sku}:stock`],
    arguments: [String(quantityToBuy)]
  }));
  if (result === -1) return { success: false, message: 'ไม่พบสินค้าชิ้นนี้ในระบบคลัง' };
  if (result === -2) return { success: false, message: 'สินค้าในสต็อกมีจำนวนไม่เพียงพอ' };
  return { success: true, message: 'ตัดสต็อกสำเร็จ', remainingStock: result };
}

module.exports = { redis, connect, decreaseStock };
