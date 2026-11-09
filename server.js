require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { createClient } = require('redis');
const path = require('path');

// ==========================================
// 1. Safe Import for MeiliSearch Constructor
// ==========================================
const meiliImport = require('meilisearch');
const Meilisearch = meiliImport.Meilisearch;
if (!Meilisearch) {
    throw new Error('Unsupported meilisearch package export: Meilisearch constructor not found');
}

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname)));

// ==========================================
// 2. Database & Cache Clients Configuration
// ==========================================
const pool = new Pool({
    host: process.env.POSTGRES_HOST || 'localhost',
    port: process.env.POSTGRES_PORT || 5432,
    user: process.env.POSTGRES_USER || 'postgres',
    password: process.env.POSTGRES_PASSWORD || 'mysecretpassword',
    database: process.env.POSTGRES_DB || 'ecommerce_db',
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 2000,
});

const redisClient = createClient({
    url: process.env.REDIS_URL || 'redis://localhost:6379'
});

redisClient.on('error', (err) => console.error('Redis Client Error:', err));

const meiliClient = new Meilisearch({
    host: process.env.MEILI_HOST || 'http://localhost:7700',
    apiKey: process.env.MEILI_MASTER_KEY || 'a_very_strong_master_key_change_me',
});

const getStockKey = (sku) => `stock:${sku}`;
const validSkuPattern = /^[A-Za-z0-9_-]+$/;

async function waitForMeiliTask(taskPromise) {
    const task = await taskPromise;
    return meiliClient.tasks.waitForTask(task.taskUid);
}

// ==========================================
// 3. Cache & Index Synchronization
// ==========================================
async function initRedisStockCache() {
    try {
        const { rows } = await pool.query('SELECT sku, stock FROM products');
        for (const product of rows) {
            const key = getStockKey(product.sku);
            await redisClient.setNX(key, product.stock.toString());
        }
        console.log('✅ Synchronized stock cache to Redis.');
    } catch (err) {
        console.error('❌ Failed to sync Redis stock cache:', err.message);
    }
}

async function autoSyncMeilisearch() {
    try {
        const { rows } = await pool.query('SELECT sku, name, price, stock, category FROM products');
        const products = rows.filter(product => validSkuPattern.test(product.sku));
        if (products.length === 0) return;

        const index = meiliClient.index('products');

        await waitForMeiliTask(index.updateSettings({
            filterableAttributes: ['category', 'sku'],
            sortableAttributes: ['price', 'created_at']
        }));

        await waitForMeiliTask(index.addDocuments(products, { primaryKey: 'sku' }));
        console.log(`✅ Meilisearch indexed ${products.length} products.`);
    } catch (err) {
        console.warn('⚠️ Auto-sync Meilisearch warning:', err.message);
    }
}

// ==========================================
// 4. API Routes
// ==========================================
app.get('/api/health', async (req, res) => {
    try {
        await pool.query('SELECT 1');
        const redisPing = await redisClient.ping();
        res.json({ status: 'ok', postgres: 'connected', redis: redisPing });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

app.get('/api/search', async (req, res) => {
    const { q = '', sort } = req.query;
    try {
        const index = meiliClient.index('products');
        const searchParams = { limit: 50 };

        if (sort) {
            const allowedSorts = ['price:asc', 'price:desc', 'created_at:desc'];
            if (allowedSorts.includes(sort)) {
                searchParams.sort = [sort];
            }
        }

        const searchResults = await index.search(q, searchParams);
        res.json({
            success: true,
            query: q,
            hits: searchResults.hits,
            data: searchResults.hits,
            total: searchResults.estimatedTotalHits
        });
    } catch (err) {
        console.warn('Meilisearch fallback to PostgreSQL:', err.message);
        try {
            const { rows } = await pool.query(
                `SELECT sku, name, price, stock, category 
         FROM products 
         WHERE name ILIKE $1 OR sku ILIKE $1 
         ORDER BY created_at DESC LIMIT 50`,
                [`%${q}%`]
            );
            res.json({
                success: true,
                query: q,
                hits: rows,
                data: rows,
                total: rows.length,
                fallback: true
            });
        } catch (dbErr) {
            res.status(500).json({ error: 'Search failed', details: dbErr.message });
        }
    }
});

app.post('/api/orders', async (req, res) => {
    const { sku, quantity = 1 } = req.body;

    if (!sku || quantity <= 0) {
        return res.status(400).json({ error: 'Invalid SKU or quantity' });
    }

    const stockKey = getStockKey(sku);

    try {
        const remainingStock = await redisClient.decrBy(stockKey, quantity);

        if (remainingStock < 0) {
            await redisClient.incrBy(stockKey, quantity);
            return res.status(400).json({ error: 'Out of stock' });
        }

        const dbClient = await pool.connect();
        try {
            await dbClient.query('BEGIN');

            const updateResult = await dbClient.query(
                `UPDATE products SET stock = stock - $1 WHERE sku = $2 AND stock >= $1 RETURNING price`,
                [quantity, sku]
            );

            if (updateResult.rowCount === 0) {
                throw new Error('Insufficient stock in database or product not found');
            }

            const itemPrice = parseFloat(updateResult.rows[0].price);
            const totalAmount = itemPrice * quantity;

            const orderRes = await dbClient.query(
                `INSERT INTO orders (total_amount, status) VALUES ($1, 'SUCCESS') RETURNING id`,
                [totalAmount]
            );
            const orderId = orderRes.rows[0].id;

            await dbClient.query(
                `INSERT INTO order_items (order_id, sku, quantity, price) VALUES ($1, $2, $3, $4)`,
                [orderId, sku, quantity, itemPrice]
            );

            await dbClient.query('COMMIT');

            res.status(201).json({
                message: 'Order created successfully',
                orderId,
                totalAmount,
                remainingStock,
            });
        } catch (dbErr) {
            await dbClient.query('ROLLBACK');
            await redisClient.incrBy(stockKey, quantity);
            res.status(500).json({ error: 'Order transaction failed, stock restored.' });
        } finally {
            dbClient.release();
        }
    } catch (err) {
        res.status(500).json({ error: 'Server error', details: err.message });
    }
});

app.get('/api/sync-meili', async (req, res) => {
    try {
        await autoSyncMeilisearch();
        res.json({ message: 'Meilisearch sync triggered successfully' });
    } catch (err) {
        res.status(500).json({ error: 'Sync failed', details: err.message });
    }
});

// ==========================================
// 5. Start Server
// ==========================================
const DEFAULT_PORT = process.env.PORT || 3000;

async function startServer(port) {
    try {
        if (!redisClient.isOpen) {
            await redisClient.connect();
            await initRedisStockCache();
        }

        await autoSyncMeilisearch();

        const server = app.listen(port, () => {
            console.log(`🚀 NexusStore API server running on http://localhost:${port}`);
        });

        server.on('error', (err) => {
            if (err.code === 'EADDRINUSE') {
                console.warn(`⚠️ Port ${port} is currently in use. Retrying on port ${port + 1}...`);
                setTimeout(() => {
                    startServer(port + 1);
                }, 1000);
            } else {
                console.error('❌ Server start error:', err);
            }
        });

    } catch (err) {
        console.error('❌ Failed to start server environment:', err);
    }
}

startServer(Number(DEFAULT_PORT));