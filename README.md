# NexusStore

## Requirements
- Node.js 18+
- Docker Desktop (for PostgreSQL, Redis and Meilisearch)

## Run
1. Copy `.env.example` to `.env`.
2. Start dependencies: `docker compose up -d`.
3. Install Node dependencies: `npm install`.
4. Start the API and static web page: `npm start`.
5. Open `http://localhost:3000`.

The first PostgreSQL initialization runs `db.sql` and inserts three demo products.
If you already have an old PostgreSQL volume, the init script will not run again; apply the schema manually with:
`docker exec -i app_postgres psql -U postgres -d ecommerce_db < db.sql`

## API
- `GET /api/health`
- `GET /api/search?q=iphone&sort=price:asc`
- `POST /api/products` JSON: `{ "sku": "SKU-001", "name": "Product", "price": 100, "stock": 5 }`
  - SKU must contain only letters, numbers, hyphens, and underscores.
- `GET /api/orders`
- `POST /api/orders` JSON: `{ "sku": "SKU-001", "quantity": 1 }`
- `GET /api/sync-meili`

Stock is reserved atomically in Redis before an order is committed to PostgreSQL. On a database failure, the reserved quantity is returned to Redis.
On startup, missing Redis stock keys are initialized from PostgreSQL. Existing records with unsupported SKU characters are skipped during Meilisearch sync.

## Notes
- Do not commit `.env` or production credentials.
- Tailwind CSS, Font Awesome and Google Fonts are loaded from CDNs by the existing frontend, so an internet connection is needed for those visual assets.
- To reset demo data, run `docker compose down -v` (this deletes local database/cache/search data).
