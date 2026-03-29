import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DB_PATH = path.resolve(__dirname, '../../data/hr.db');

if (fs.existsSync(DB_PATH)) {
  fs.unlinkSync(DB_PATH);
  console.log('Removed existing hr.db');
}

// Ensure data/ directory exists
const dataDir = path.dirname(DB_PATH);
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(DB_PATH);

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

db.exec(`
  CREATE TABLE departments (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    location    TEXT,
    cost_center TEXT,
    created_at  TEXT DEFAULT (date('now'))
  );

  CREATE TABLE employees (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    first_name       TEXT NOT NULL,
    last_name        TEXT NOT NULL,
    email            TEXT NOT NULL UNIQUE,
    department_id    INTEGER REFERENCES departments(id),
    job_title        TEXT NOT NULL,
    employment_type  TEXT NOT NULL,  -- 'full_time', 'part_time', 'contractor'
    hire_date        TEXT NOT NULL,
    termination_date TEXT,
    is_active        INTEGER DEFAULT 1,
    manager_id       INTEGER REFERENCES employees(id),
    fte              REAL DEFAULT 1.0,
    created_at       TEXT DEFAULT (date('now'))
  );

  CREATE TABLE contracts (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id     INTEGER REFERENCES employees(id),
    contract_type   TEXT NOT NULL,   -- 'permanent', 'fixed_term', 'interim'
    start_date      TEXT NOT NULL,
    end_date        TEXT,
    gross_monthly   REAL NOT NULL,
    hours_per_week  REAL NOT NULL,
    signed_at       TEXT
  );

  CREATE TABLE leave_requests (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id   INTEGER REFERENCES employees(id),
    leave_type    TEXT NOT NULL,   -- 'annual', 'sick', 'parental', 'unpaid', 'training'
    start_date    TEXT NOT NULL,
    end_date      TEXT NOT NULL,
    days          REAL NOT NULL,
    status        TEXT DEFAULT 'approved',  -- 'pending', 'approved', 'rejected'
    approved_by   INTEGER REFERENCES employees(id),
    requested_at  TEXT DEFAULT (date('now'))
  );

  CREATE TABLE payroll (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id     INTEGER REFERENCES employees(id),
    year            INTEGER NOT NULL,
    month           INTEGER NOT NULL,
    gross_salary    REAL NOT NULL,
    employer_social REAL NOT NULL,
    employee_social REAL NOT NULL,
    withholding_tax REAL NOT NULL,
    net_salary      REAL NOT NULL,
    bonus           REAL DEFAULT 0,
    processed_at    TEXT
  );

  CREATE TABLE performance_reviews (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    employee_id   INTEGER REFERENCES employees(id),
    reviewer_id   INTEGER REFERENCES employees(id),
    review_date   TEXT NOT NULL,
    period        TEXT NOT NULL,   -- e.g. '2025-H1', '2025-H2'
    rating        INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
    comments      TEXT,
    salary_raise  REAL DEFAULT 0
  );
`);

// ---------------------------------------------------------------------------
// Reference data
// ---------------------------------------------------------------------------

const DEPTS = [
  { name: 'Sales',              location: 'Brussel',   cost_center: 'CC-100' },
  { name: 'Marketing',          location: 'Brussel',   cost_center: 'CC-110' },
  { name: 'Engineering',        location: 'Gent',      cost_center: 'CC-200' },
  { name: 'Finance',            location: 'Brussel',   cost_center: 'CC-300' },
  { name: 'Human Resources',    location: 'Antwerpen', cost_center: 'CC-400' },
  { name: 'Customer Success',   location: 'Leuven',    cost_center: 'CC-500' },
  { name: 'Operations',         location: 'Gent',      cost_center: 'CC-600' },
];

const FIRST_NAMES = [
  'Jan', 'Pieter', 'Luc', 'Marc', 'Sofie', 'An', 'Nathalie', 'Thomas',
  'Julie', 'Kevin', 'Marie', 'Philippe', 'Nicolas', 'Laura', 'David',
  'Elien', 'Wout', 'Stef', 'Hanne', 'Bram', 'Sarah', 'Joris', 'Amber',
  'Mathias', 'Elisa', 'Dries', 'Silke', 'Jonas', 'Ines', 'Cedric',
];

const LAST_NAMES = [
  'Janssen', 'Peeters', 'Maes', 'Jacobs', 'Willems', 'Claes', 'Goossens',
  'Wouters', 'De Smet', 'Hermans', 'Leclercq', 'Dubois', 'Lambert', 'Simon',
  'Dumont', 'Declercq', 'Martens', 'Vermeersch', 'Bogaert', 'Desmet',
  'Van Acker', 'Pieters', 'De Backer', 'Nijs', 'Cools',
];

const JOB_TITLES: Record<string, string[]> = {
  'Sales':            ['Account Executive', 'Sales Manager', 'Business Development Rep', 'Sales Director'],
  'Marketing':        ['Marketing Specialist', 'Content Manager', 'Brand Manager', 'CMO'],
  'Engineering':      ['Software Engineer', 'Senior Engineer', 'Tech Lead', 'CTO', 'DevOps Engineer'],
  'Finance':          ['Financial Analyst', 'Accountant', 'CFO', 'Controller'],
  'Human Resources':  ['HR Business Partner', 'Recruiter', 'HR Manager', 'CHRO', 'Payroll Specialist'],
  'Customer Success': ['Customer Success Manager', 'Support Specialist', 'Team Lead CS'],
  'Operations':       ['Operations Manager', 'Logistics Coordinator', 'COO', 'Process Analyst'],
};

const EMP_TYPES = ['full_time', 'full_time', 'full_time', 'part_time', 'contractor'];
const CONTRACT_TYPES = ['permanent', 'permanent', 'permanent', 'fixed_term', 'interim'];
const LEAVE_TYPES = ['annual', 'annual', 'annual', 'sick', 'sick', 'training', 'parental', 'unpaid'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pick<T>(arr: T[], seed: number): T {
  return arr[Math.abs(seed) % arr.length];
}

function daysAgo(n: number): string {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}

function addDays(date: string, n: number): string {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d.toISOString().split('T')[0];
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

// ---------------------------------------------------------------------------
// Insert departments
// ---------------------------------------------------------------------------

const insertDept = db.prepare(`INSERT INTO departments (name, location, cost_center) VALUES (?, ?, ?)`);
for (const d of DEPTS) insertDept.run(d.name, d.location, d.cost_center);

// ---------------------------------------------------------------------------
// Insert employees (60 rows)
// ---------------------------------------------------------------------------

const insertEmployee = db.prepare(`
  INSERT INTO employees (first_name, last_name, email, department_id, job_title, employment_type, hire_date, is_active, manager_id, fte)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

// First pass: insert all employees without managers
const employeeIds: number[] = [];
for (let i = 0; i < 60; i++) {
  const deptId   = (i % DEPTS.length) + 1;
  const deptName = DEPTS[deptId - 1].name;
  const title    = pick(JOB_TITLES[deptName], i);
  const empType  = pick(EMP_TYPES, i);
  const fte      = empType === 'part_time' ? 0.5 + (i % 3) * 0.1 : 1.0;
  const hireDate = daysAgo(Math.round(30 + (i * 47 + 180) % 1800));
  const isActive = i < 54 ? 1 : 0; // last 6 are terminated

  const fn = pick(FIRST_NAMES, i);
  const ln = pick(LAST_NAMES, i + 5);
  const email = `${fn.toLowerCase().replace(/\s/g, '.')}.${ln.toLowerCase().replace(/[\s-]/g, '')}${i > 0 && i % 10 === 0 ? i : ''}@company.be`;

  const { lastInsertRowid } = insertEmployee.run(fn, ln, email, deptId, title, empType, hireDate, isActive, null, fte);
  employeeIds.push(Number(lastInsertRowid));
}

// Second pass: assign managers (first employee per dept is the manager)
const updateManager = db.prepare(`UPDATE employees SET manager_id = ? WHERE id = ?`);
for (let i = 1; i < 60; i++) {
  const managerId = employeeIds[Math.floor(i / 8)]; // every 8 employees share a manager
  updateManager.run(managerId, employeeIds[i]);
}

// ---------------------------------------------------------------------------
// Insert contracts
// ---------------------------------------------------------------------------

const insertContract = db.prepare(`
  INSERT INTO contracts (employee_id, contract_type, start_date, end_date, gross_monthly, hours_per_week, signed_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const BASE_SALARIES: Record<string, number> = {
  'Sales': 3200, 'Marketing': 3100, 'Engineering': 4200,
  'Finance': 3600, 'Human Resources': 3000, 'Customer Success': 2900, 'Operations': 3100,
};

for (let i = 0; i < 60; i++) {
  const empId    = employeeIds[i];
  const deptName = DEPTS[(i % DEPTS.length)].name;
  const base     = BASE_SALARIES[deptName] + (i % 10) * 150 + (i > 30 ? 400 : 0);
  const type     = pick(CONTRACT_TYPES, i);
  const startDate = daysAgo(Math.round(30 + (i * 47 + 180) % 1800));
  const endDate   = type === 'fixed_term' ? addDays(startDate, 365) : null;
  const hours     = pick(EMP_TYPES, i) === 'part_time' ? 20 + (i % 3) * 4 : 38;

  insertContract.run(empId, type, startDate, endDate, round2(base), hours, startDate);
}

// ---------------------------------------------------------------------------
// Insert payroll (last 6 months per active employee)
// ---------------------------------------------------------------------------

const insertPayroll = db.prepare(`
  INSERT INTO payroll (employee_id, year, month, gross_salary, employer_social, employee_social, withholding_tax, net_salary, bonus, processed_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const now = new Date();

db.transaction(() => {
  for (let i = 0; i < 54; i++) { // active employees only
    const empId  = employeeIds[i];
    const deptName = DEPTS[(i % DEPTS.length)].name;
    const gross  = round2(BASE_SALARIES[deptName] + (i % 10) * 150 + (i > 30 ? 400 : 0));

    for (let m = 5; m >= 0; m--) {
      const d = new Date(now.getFullYear(), now.getMonth() - m, 1);
      const year  = d.getFullYear();
      const month = d.getMonth() + 1;

      const employerSocial = round2(gross * 0.27);
      const employeeSocial = round2(gross * 0.1307);
      const taxable        = round2(gross - employeeSocial);
      const withholdingTax = round2(taxable * 0.26);
      const net            = round2(gross - employeeSocial - withholdingTax);
      const bonus          = (month === 6 || month === 12) ? round2(gross * 0.92) : 0; // vacation + year-end bonus
      const processedAt    = `${year}-${String(month).padStart(2, '0')}-25`;

      insertPayroll.run(empId, year, month, gross, employerSocial, employeeSocial, withholdingTax, net, bonus, processedAt);
    }
  }
})();

// ---------------------------------------------------------------------------
// Insert leave requests
// ---------------------------------------------------------------------------

const insertLeave = db.prepare(`
  INSERT INTO leave_requests (employee_id, leave_type, start_date, end_date, days, status, approved_by)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

db.transaction(() => {
  for (let i = 0; i < 54; i++) {
    const empId    = employeeIds[i];
    const managerId = employeeIds[Math.max(0, Math.floor(i / 8))];
    const numLeaves = 2 + (i % 3);

    for (let l = 0; l < numLeaves; l++) {
      const type      = pick(LEAVE_TYPES, i + l * 7);
      const startDate = daysAgo(Math.round(10 + (i * 11 + l * 43) % 300));
      const days      = type === 'sick' ? 1 + (l % 4) : 2 + (l % 8);
      const endDate   = addDays(startDate, days - 1);
      const status    = pick(['approved', 'approved', 'approved', 'pending', 'rejected'], i + l);

      insertLeave.run(empId, type, startDate, endDate, days, status, managerId);
    }
  }
})();

// ---------------------------------------------------------------------------
// Insert performance reviews
// ---------------------------------------------------------------------------

const insertReview = db.prepare(`
  INSERT INTO performance_reviews (employee_id, reviewer_id, review_date, period, rating, comments, salary_raise)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const COMMENTS = [
  'Exceeds expectations consistently.',
  'Good performance, meets all targets.',
  'Solid contributor to the team.',
  'Some areas for improvement identified.',
  'Strong technical skills, needs to work on communication.',
  'Outstanding results this period.',
  'Below expectations, improvement plan started.',
];

db.transaction(() => {
  for (let i = 0; i < 54; i++) {
    const empId     = employeeIds[i];
    const reviewerId = employeeIds[Math.max(0, Math.floor(i / 8))];

    for (const period of ['2024-H2', '2025-H1', '2025-H2']) {
      const rating     = 2 + (i + period.length) % 4; // ratings 2–5
      const raiseRate  = rating >= 4 ? 0.03 + (rating - 4) * 0.015 : 0;
      const gross      = BASE_SALARIES[DEPTS[(i % DEPTS.length)].name] + (i % 10) * 150;
      const raise      = round2(gross * raiseRate);
      const reviewDate = period.endsWith('H1') ? `${period.slice(0, 4)}-06-30` : `${period.slice(0, 4)}-12-15`;

      insertReview.run(empId, reviewerId, reviewDate, period, rating, pick(COMMENTS, i + rating), raise);
    }
  }
})();

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------

const counts = {
  departments:         (db.prepare('SELECT COUNT(*) as n FROM departments').get()         as { n: number }).n,
  employees:           (db.prepare('SELECT COUNT(*) as n FROM employees').get()           as { n: number }).n,
  contracts:           (db.prepare('SELECT COUNT(*) as n FROM contracts').get()           as { n: number }).n,
  leave_requests:      (db.prepare('SELECT COUNT(*) as n FROM leave_requests').get()      as { n: number }).n,
  payroll:             (db.prepare('SELECT COUNT(*) as n FROM payroll').get()             as { n: number }).n,
  performance_reviews: (db.prepare('SELECT COUNT(*) as n FROM performance_reviews').get() as { n: number }).n,
};

const total = Object.values(counts).reduce((a, b) => a + b, 0);

console.log('\nHR seed complete:');
Object.entries(counts).forEach(([k, v]) => console.log(`  ${k.padEnd(22)} ${v}`));
console.log(`  ${'total rows'.padEnd(22)} ${total}`);
console.log(`\nDatabase written to: ${DB_PATH}`);

db.close();
