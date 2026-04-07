/**
 * seed-postgres.ts — Populate Azure Postgres "sampledata" database
 * with the same Belgian SMB data as the SQLite seed script.
 *
 * Usage:
 *   SEED_PG_URL="postgresql://user:pass@host:5432/sampledata?sslmode=require" npx ts-node src/seed-postgres.ts
 *
 * Or set individual vars:
 *   SEED_PG_HOST, SEED_PG_PORT, SEED_PG_DATABASE, SEED_PG_USER, SEED_PG_PASSWORD
 */

import { Pool } from 'pg';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

const connectionString = process.env.SEED_PG_URL;

const pool = connectionString
  ? new Pool({ connectionString, ssl: { rejectUnauthorized: false } })
  : new Pool({
      host: process.env.SEED_PG_HOST ?? 'localhost',
      port: Number(process.env.SEED_PG_PORT ?? 5432),
      database: process.env.SEED_PG_DATABASE ?? 'sampledata',
      user: process.env.SEED_PG_USER ?? 'databridge',
      password: process.env.SEED_PG_PASSWORD ?? 'databridge',
      ssl: process.env.SEED_PG_HOST?.includes('azure.com')
        ? { rejectUnauthorized: false }
        : undefined,
    });

// ---------------------------------------------------------------------------
// Reference data (identical to seed.ts)
// ---------------------------------------------------------------------------

const LOCATIONS = [
  { city: 'Brussel',      postal: '1000' },
  { city: 'Antwerpen',    postal: '2000' },
  { city: 'Gent',         postal: '9000' },
  { city: 'Brugge',       postal: '8000' },
  { city: 'Luik',         postal: '4000' },
  { city: 'Namen',        postal: '5000' },
  { city: 'Leuven',       postal: '3000' },
  { city: 'Mechelen',     postal: '2800' },
  { city: 'Hasselt',      postal: '3500' },
  { city: 'Kortrijk',     postal: '8500' },
  { city: 'Aalst',        postal: '9300' },
  { city: 'Sint-Niklaas', postal: '9100' },
];

const SURNAMES = [
  'Janssen', 'Peeters', 'Maes', 'Jacobs', 'Willems',
  'Claes', 'Goossens', 'Wouters', 'De Smet', 'Hermans',
  'Leclercq', 'Dubois', 'Lambert', 'Simon', 'Dumont',
  'Declercq', 'Martens', 'Vermeersch', 'Bogaert', 'Desmet',
];

const FIRST_NAMES = [
  'Jan', 'Pieter', 'Luc', 'Marc', 'Sofie',
  'An', 'Nathalie', 'Thomas', 'Julie', 'Kevin',
  'Marie', 'Philippe', 'Nicolas', 'Laura', 'David',
  'Elien', 'Wout', 'Stef', 'Hanne', 'Bram',
];

const COMPANY_TYPES = [
  'Technics', 'Solutions', 'Services', 'Systems', 'Consult',
  'Logistics', 'Trading', 'Supplies', 'Industries', 'Partners',
];

const LEGAL_FORMS = ['NV', 'BV', 'SA', 'SPRL'];

const STREETS = [
  'Industrielaan', 'Handelsstraat', 'Nijverheidsweg',
  'Bedrijvenpark', 'Keizerslaan', 'Kerkstraat',
];

const ORDER_STATUSES = ['completed', 'completed', 'completed', 'shipped', 'pending', 'cancelled'];
const INVOICE_STATUSES = ['paid', 'paid', 'paid', 'pending', 'overdue'];

const PRODUCTS = [
  { name: 'A4 Printpapier 80g (500 vel)',        category: 'Kantoorbenodigdheden', unit_price: 4.95,   unit: 'ream'  },
  { name: 'Ballpoint Pennen (doos 50)',           category: 'Kantoorbenodigdheden', unit_price: 8.50,   unit: 'doos'  },
  { name: 'Post-it Notes 76x76mm (12 blokken)',  category: 'Kantoorbenodigdheden', unit_price: 12.75,  unit: 'pak'   },
  { name: 'Ordner A4 8cm Blauw',                 category: 'Archivering',          unit_price: 3.20,   unit: 'stuk'  },
  { name: 'Ordner A4 8cm Zwart',                 category: 'Archivering',          unit_price: 3.20,   unit: 'stuk'  },
  { name: 'Hangmappenbox met 25 mappen',         category: 'Archivering',          unit_price: 24.99,  unit: 'set'   },
  { name: 'Bureaulamp LED',                      category: 'Kantoormeubelen',      unit_price: 49.95,  unit: 'stuk'  },
  { name: 'Ergonomische Bureaustoel',            category: 'Kantoormeubelen',      unit_price: 289.00, unit: 'stuk'  },
  { name: 'Vergadertafel 180x90cm',              category: 'Kantoormeubelen',      unit_price: 445.00, unit: 'stuk'  },
  { name: 'Whiteboard 120x90cm',                 category: 'Presentatie',          unit_price: 89.95,  unit: 'stuk'  },
  { name: 'Flipchart Staander + 5 blokken',      category: 'Presentatie',          unit_price: 65.00,  unit: 'set'   },
  { name: 'HDMI Kabel 2m',                       category: 'IT Accessoires',       unit_price: 9.95,   unit: 'stuk'  },
  { name: 'USB-C Hub 7-in-1',                    category: 'IT Accessoires',       unit_price: 39.99,  unit: 'stuk'  },
  { name: 'Draadloos Toetsenbord + Muis',        category: 'IT Accessoires',       unit_price: 59.95,  unit: 'set'   },
  { name: 'Externe SSD 1TB',                     category: 'IT Accessoires',       unit_price: 89.99,  unit: 'stuk'  },
  { name: 'Monitorarm Enkelvoudig',              category: 'IT Accessoires',       unit_price: 44.95,  unit: 'stuk'  },
  { name: 'Toner HP LaserJet 26A',               category: 'Printer & Scan',       unit_price: 68.50,  unit: 'stuk'  },
  { name: 'Inktpatronen Canon PGI-580 (5-pack)', category: 'Printer & Scan',       unit_price: 34.99,  unit: 'pak'   },
  { name: 'Koffie Arabica Bonen 1kg',            category: 'Keuken & Catering',    unit_price: 12.95,  unit: 'zak'   },
  { name: 'Koffiebekers Papier (100 st)',        category: 'Keuken & Catering',    unit_price: 6.50,   unit: 'pak'   },
  { name: 'Mineraalwater 1,5L (pak 6)',          category: 'Keuken & Catering',    unit_price: 4.20,   unit: 'pak'   },
  { name: 'Handgel Desinfecterend 500ml',        category: 'Hygiëne',              unit_price: 5.95,   unit: 'fles'  },
  { name: 'Papieren Handdoeken (20 rollen)',     category: 'Hygiëne',              unit_price: 18.50,  unit: 'pak'   },
  { name: 'Vuilniszakken 120L (pak 25)',         category: 'Hygiëne',              unit_price: 8.75,   unit: 'pak'   },
  { name: 'Verlengsnoer 4-voudig 3m',            category: 'Elektriciteit',        unit_price: 22.95,  unit: 'stuk'  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pick<T>(arr: T[], seed: number): T {
  return arr[Math.abs(seed) % arr.length];
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

function daysAgoDate(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString().split('T')[0];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const client = await pool.connect();
  console.log('Connected to Postgres');

  try {
    await client.query('BEGIN');

    // Drop tables in reverse dependency order (idempotent)
    await client.query(`
      DROP TABLE IF EXISTS invoices CASCADE;
      DROP TABLE IF EXISTS order_lines CASCADE;
      DROP TABLE IF EXISTS orders CASCADE;
      DROP TABLE IF EXISTS products CASCADE;
      DROP TABLE IF EXISTS customers CASCADE;
      DROP TABLE IF EXISTS users CASCADE;
    `);

    // Create tables with Postgres DDL
    await client.query(`
      CREATE TABLE users (
        id         INTEGER PRIMARY KEY,
        first_name TEXT NOT NULL,
        last_name  TEXT NOT NULL,
        email      TEXT NOT NULL UNIQUE,
        role       TEXT NOT NULL DEFAULT 'sales_rep'
      );

      CREATE TABLE customers (
        id            SERIAL PRIMARY KEY,
        company_name  TEXT NOT NULL,
        contact_name  TEXT NOT NULL,
        email         TEXT,
        phone         TEXT,
        address       TEXT,
        city          TEXT,
        postal_code   TEXT,
        vat_number    TEXT,
        created_at    DATE DEFAULT CURRENT_DATE
      );

      CREATE TABLE products (
        id          SERIAL PRIMARY KEY,
        name        TEXT NOT NULL,
        description TEXT,
        category    TEXT,
        unit_price  NUMERIC(12,2) NOT NULL,
        unit        TEXT DEFAULT 'stuk',
        is_active   BOOLEAN DEFAULT TRUE,
        created_at  DATE DEFAULT CURRENT_DATE
      );

      CREATE TABLE orders (
        id               SERIAL PRIMARY KEY,
        customer_id      INTEGER REFERENCES customers(id),
        order_date       DATE NOT NULL,
        status           TEXT DEFAULT 'pending',
        shipping_address TEXT,
        notes            TEXT,
        created_at       DATE DEFAULT CURRENT_DATE
      );

      CREATE TABLE order_lines (
        id           SERIAL PRIMARY KEY,
        order_id     INTEGER REFERENCES orders(id),
        product_id   INTEGER REFERENCES products(id),
        quantity     NUMERIC(10,2) NOT NULL,
        unit_price   NUMERIC(12,2) NOT NULL,
        discount_pct NUMERIC(5,2) DEFAULT 0,
        line_total   NUMERIC(12,2) NOT NULL,
        created_by   INTEGER REFERENCES users(id)
      );

      CREATE TABLE invoices (
        id              SERIAL PRIMARY KEY,
        order_id        INTEGER REFERENCES orders(id),
        customer_id     INTEGER REFERENCES customers(id),
        invoice_number  TEXT NOT NULL,
        invoice_date    DATE NOT NULL,
        due_date        DATE NOT NULL,
        total_excl_vat  NUMERIC(12,2) NOT NULL,
        vat_amount      NUMERIC(12,2) NOT NULL,
        total_incl_vat  NUMERIC(12,2) NOT NULL,
        status          TEXT DEFAULT 'pending',
        paid_at         DATE,
        created_by      INTEGER REFERENCES users(id)
      );
    `);

    console.log('Tables created');

    // -----------------------------------------------------------------------
    // Insert users (12 rows)
    // -----------------------------------------------------------------------
    const HR_USERS = [
      { id: 1,  first_name: 'Jan',      last_name: 'Claes',    email: 'jan.claes@company.be',       role: 'sales_rep' },
      { id: 2,  first_name: 'Pieter',   last_name: 'Goossens', email: 'pieter.goossens@company.be', role: 'sales_rep' },
      { id: 3,  first_name: 'Luc',      last_name: 'Wouters',  email: 'luc.wouters@company.be',     role: 'sales_rep' },
      { id: 4,  first_name: 'Marc',     last_name: 'De Smet',  email: 'marc.desmet@company.be',     role: 'finance'   },
      { id: 5,  first_name: 'Sofie',    last_name: 'Hermans',  email: 'sofie.hermans@company.be',   role: 'sales_rep' },
      { id: 6,  first_name: 'An',       last_name: 'Leclercq', email: 'an.leclercq@company.be',     role: 'sales_rep' },
      { id: 7,  first_name: 'Nathalie', last_name: 'Dubois',   email: 'nathalie.dubois@company.be', role: 'manager'   },
      { id: 8,  first_name: 'Thomas',   last_name: 'Lambert',  email: 'thomas.lambert@company.be',  role: 'sales_rep' },
      { id: 9,  first_name: 'Julie',    last_name: 'Simon',    email: 'julie.simon@company.be',     role: 'sales_rep' },
      { id: 10, first_name: 'Kevin',    last_name: 'Dumont',   email: 'kevin.dumont@company.be',    role: 'sales_rep' },
      { id: 11, first_name: 'Marie',    last_name: 'Declercq', email: 'marie.declercq10@company.be',role: 'finance'   },
      { id: 12, first_name: 'Philippe', last_name: 'Martens',  email: 'philippe.martens@company.be',role: 'manager'   },
    ];

    for (const u of HR_USERS) {
      await client.query(
        'INSERT INTO users (id, first_name, last_name, email, role) VALUES ($1, $2, $3, $4, $5)',
        [u.id, u.first_name, u.last_name, u.email, u.role],
      );
    }
    console.log('  users: 12');

    // -----------------------------------------------------------------------
    // Insert customers (40 rows)
    // -----------------------------------------------------------------------
    for (let i = 0; i < 40; i++) {
      const loc      = pick(LOCATIONS, i);
      const surname  = pick(SURNAMES, i);
      const type     = pick(COMPANY_TYPES, i + 5);
      const legal    = pick(LEGAL_FORMS, i);
      const first    = pick(FIRST_NAMES, i);
      const cSurname = pick(SURNAMES, i + 7);
      const street   = pick(STREETS, i + 2);
      const vatNum   = `BE${String(400000000 + i * 12347).slice(0, 9)}${i % 10}`;

      await client.query(
        `INSERT INTO customers (company_name, contact_name, email, phone, address, city, postal_code, vat_number)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          `${surname} ${type} ${legal}`,
          `${first} ${cSurname}`,
          `contact@${surname.toLowerCase().replace(/[\s-]/g, '')}.be`,
          `+32 ${2 + (i % 8)} ${String(1000000 + i * 9973).slice(0, 7)}`,
          `${street} ${(i + 1) * 3}`,
          loc.city,
          loc.postal,
          vatNum,
        ],
      );
    }
    console.log('  customers: 40');

    // -----------------------------------------------------------------------
    // Insert products (25 rows)
    // -----------------------------------------------------------------------
    for (const p of PRODUCTS) {
      await client.query(
        'INSERT INTO products (name, description, category, unit_price, unit) VALUES ($1, $2, $3, $4, $5)',
        [p.name, p.name, p.category, p.unit_price, p.unit],
      );
    }
    console.log('  products: 25');

    // -----------------------------------------------------------------------
    // Insert orders, order_lines, invoices
    // -----------------------------------------------------------------------
    const SALES_USER_IDS = [1, 2, 3, 5, 6, 8, 9, 10];
    const FINANCE_USER_IDS = [4, 7, 11, 12];
    let invoiceSeq = 1;
    let orderCount = 0;
    let lineCount = 0;
    let invoiceCount = 0;

    for (let customerId = 1; customerId <= 40; customerId++) {
      const numOrders = 2 + (customerId % 3);

      for (let o = 0; o < numOrders; o++) {
        const daysBack  = Math.round(((customerId * 3 + o * 29) % 360) + 5);
        const orderDate = daysAgoDate(daysBack);
        const status    = pick(ORDER_STATUSES, customerId + o);

        const orderResult = await client.query(
          `INSERT INTO orders (customer_id, order_date, status, shipping_address)
           VALUES ($1, $2, $3, $4) RETURNING id`,
          [customerId, orderDate, status, `Leveringsadres klant ${customerId}, ${pick(LOCATIONS, customerId).city}`],
        );
        const orderId = orderResult.rows[0].id;
        orderCount++;

        const numLines = 2 + ((customerId + o) % 3);
        let orderTotal = 0;

        for (let l = 0; l < numLines; l++) {
          const productIdx = (customerId * 7 + o * 13 + l * 5) % PRODUCTS.length;
          const product    = PRODUCTS[productIdx];
          const quantity   = 1 + ((customerId + l) % 8);
          const discount   = [0, 0, 0, 5, 10, 15][(customerId + o + l) % 6];
          const lineTotal  = round2(quantity * product.unit_price * (1 - discount / 100));
          orderTotal += lineTotal;

          const lineCreatedBy = pick(SALES_USER_IDS, customerId * 7 + o * 13 + l);
          await client.query(
            `INSERT INTO order_lines (order_id, product_id, quantity, unit_price, discount_pct, line_total, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [orderId, productIdx + 1, quantity, product.unit_price, discount, lineTotal, lineCreatedBy],
          );
          lineCount++;
        }

        if (status !== 'cancelled') {
          const invoiceDate  = addDays(orderDate, 1);
          const dueDate      = addDays(invoiceDate, 30);
          const vatAmount    = round2(orderTotal * 0.21);
          const totalInclVat = round2(orderTotal + vatAmount);
          const invStatus    = pick(INVOICE_STATUSES, invoiceSeq);
          const paidAt       = invStatus === 'paid' ? dueDate : null;
          const invCreatedBy = pick(FINANCE_USER_IDS, invoiceSeq);

          await client.query(
            `INSERT INTO invoices (order_id, customer_id, invoice_number, invoice_date, due_date,
                                   total_excl_vat, vat_amount, total_incl_vat, status, paid_at, created_by)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [orderId, customerId,
             `INV-2026-${String(invoiceSeq).padStart(4, '0')}`,
             invoiceDate, dueDate, round2(orderTotal), vatAmount, totalInclVat,
             invStatus, paidAt, invCreatedBy],
          );
          invoiceSeq++;
          invoiceCount++;
        }
      }
    }

    await client.query('COMMIT');

    console.log(`  orders: ${orderCount}`);
    console.log(`  order_lines: ${lineCount}`);
    console.log(`  invoices: ${invoiceCount}`);
    const total = 12 + 40 + 25 + orderCount + lineCount + invoiceCount;
    console.log(`\nSeed complete: ${total} total rows`);

  } catch (err) {
    await client.query('ROLLBACK');
    console.error('Seed failed, rolled back:', err);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
