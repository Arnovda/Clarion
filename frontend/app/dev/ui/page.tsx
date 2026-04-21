'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Input } from '@/components/ui/Input';
import { Select } from '@/components/ui/Select';
import { Badge } from '@/components/ui/Badge';
import { Card, CardHeader, CardBody, CardFooter } from '@/components/ui/Card';
import { Table, THead, TBody, Tr, Th, Td } from '@/components/ui/Table';
import { Tabs } from '@/components/ui/Tabs';
import { Toast, ToastViewport } from '@/components/ui/Toast';
import { Modal } from '@/components/ui/Modal';
import { Skeleton, SkeletonText } from '@/components/ui/Skeleton';
import { KPITile } from '@/components/ui/KPITile';
import {
  ChartCard,
  CHART_COLORS,
  CHART_AXIS_PROPS,
  CHART_GRID_PROPS,
  CHART_TOOLTIP_STYLE,
} from '@/components/ui/ChartCard';
import { AIResponseBlock } from '@/components/ui/AIResponseBlock';
import { JobProgressBanner } from '@/components/ui/JobProgressBanner';
import { NotificationBell } from '@/components/ui/NotificationBell';
import { SourceCard } from '@/components/ui/SourceCard';
import { OutlineRail } from '@/components/ui/OutlineRail';
import { NotebookCell, AddCellMenu } from '@/components/ui/NotebookCell';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  BarChart,
  Bar,
  ResponsiveContainer,
  Legend,
} from 'recharts';

const CHART_SAMPLE = [
  { month: 'Jan', revenue: 124000, pipeline: 80000 },
  { month: 'Feb', revenue: 138000, pipeline: 95000 },
  { month: 'Mar', revenue: 152000, pipeline: 110000 },
  { month: 'Apr', revenue: 161000, pipeline: 118000 },
  { month: 'May', revenue: 174000, pipeline: 127000 },
  { month: 'Jun', revenue: 188000, pipeline: 139000 },
];

const BAR_SAMPLE = [
  { segment: 'SMB',        customers: 1284 },
  { segment: 'Mid-market', customers: 612  },
  { segment: 'Enterprise', customers: 188  },
];

function CompositeSections() {
  const [selectedCell, setSelectedCell] = useState<number | null>(1);
  const [outlineId, setOutlineId] = useState('revenue');

  return (
    <>
      <Section eyebrow="11 · KPITile" title="KPITile">
        <div className="grid grid-cols-3 gap-4">
          <KPITile label="Revenue MTD"     value="€1.24M" delta={8.2}  subtitle="vs. prior month" />
          <KPITile label="Active accounts" value="1,284"  delta={-2.1} subtitle="12-week rolling" />
          <KPITile label="Pipeline"        value="€3.1M"  delta={0}    subtitle="flat" />
        </div>
        <div>
          <div className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-muted-2 mb-2">
            States
          </div>
          <div className="grid grid-cols-3 gap-4">
            <KPITile label="Loading" loading />
            <KPITile label="No sync yet" empty emptyLabel="—" />
            <KPITile label="Fetch failed" error="timeout after 8s" />
          </div>
        </div>
      </Section>

      <Section eyebrow="12 · ChartCard" title="ChartCard">
        <div className="grid grid-cols-2 gap-4">
          <ChartCard title="Revenue vs. pipeline" subtitle="Monthly · last 6" height={240}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={CHART_SAMPLE} margin={{ top: 10, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid {...CHART_GRID_PROPS} />
                <XAxis dataKey="month" {...CHART_AXIS_PROPS} />
                <YAxis {...CHART_AXIS_PROPS} tickFormatter={(v) => `€${v / 1000}k`} />
                <Tooltip contentStyle={CHART_TOOLTIP_STYLE} />
                <Legend wrapperStyle={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--muted)', textTransform: 'uppercase', letterSpacing: '0.08em' }} />
                <Line type="monotone" dataKey="revenue"  stroke={CHART_COLORS[0]} strokeWidth={1.5} dot={false} />
                <Line type="monotone" dataKey="pipeline" stroke={CHART_COLORS[2]} strokeWidth={1.5} strokeDasharray="4 3" dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </ChartCard>

          <ChartCard title="Customers by segment" subtitle="Q2 2026" height={240}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={BAR_SAMPLE} margin={{ top: 10, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid {...CHART_GRID_PROPS} vertical={false} />
                <XAxis dataKey="segment" {...CHART_AXIS_PROPS} />
                <YAxis {...CHART_AXIS_PROPS} />
                <Tooltip contentStyle={CHART_TOOLTIP_STYLE} cursor={{ fill: 'var(--softer)' }} />
                <Bar dataKey="customers" fill={CHART_COLORS[1]} radius={[2, 2, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>
        </div>

        <div className="grid grid-cols-3 gap-4">
          <ChartCard title="Loading state" subtitle="Shimmer" height={160} loading />
          <ChartCard title="Empty state"   subtitle="No data" height={160} empty />
          <ChartCard title="Error state"   subtitle="Failed"  height={160} error="Query timeout" />
        </div>
      </Section>

      <Section eyebrow="13 · AIResponseBlock" title="AIResponseBlock">
        <AIResponseBlock
          body={
            <>
              Revenue grew <b>8.2%</b> month-over-month, driven by a surge in{' '}
              <em>Enterprise</em> renewals. Churn held steady at <b>1.4%</b>.
            </>
          }
          confidence={0.92}
          sources={['orders', 'customers', 'subscriptions']}
          onShowSQL={() => {}}
          onPin={() => {}}
        />
        <div className="grid grid-cols-3 gap-4">
          <AIResponseBlock loading />
          <AIResponseBlock empty />
          <AIResponseBlock error="confidence too low (0.41)" />
        </div>
      </Section>

      <Section eyebrow="14 · JobProgressBanner" title="JobProgressBanner">
        <div className="bg-raised border border-line rounded-md overflow-hidden">
          <JobProgressBanner
            title="Profiling source"
            progress={62}
            steps={[
              { label: 'Connect',   status: 'done'    },
              { label: 'Introspect', status: 'done'   },
              { label: 'Profile',   status: 'running' },
              { label: 'Draft defs', status: 'pending' },
              { label: 'Finalize',  status: 'pending' },
            ]}
            onCancel={() => {}}
          />
        </div>
        <div className="bg-raised border border-line rounded-md overflow-hidden">
          <JobProgressBanner
            title="Ingestion"
            progress={40}
            error="Source timed out on table orders"
            steps={[
              { label: 'Plan',      status: 'done'    },
              { label: 'Extract',   status: 'error'   },
              { label: 'Transform', status: 'pending' },
              { label: 'Load',      status: 'pending' },
            ]}
          />
        </div>
      </Section>

      <Section eyebrow="15 · NotificationBell" title="NotificationBell">
        <Row>
          <div className="flex items-center gap-3">
            <span className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-muted">With items</span>
            <NotificationBell
              items={[
                { id: 1, title: 'Ingestion finished',   body: 'orders · 1.28M rows',  time: '2 min ago' },
                { id: 2, title: 'Quality alert: nulls', body: 'customers.email @ 4%', time: '1h ago'    },
                { id: 3, title: 'Jan joined the team',  body: 'Now invited as Analyst', time: 'Yesterday', read: true },
              ]}
              onMarkAllRead={() => {}}
            />
          </div>
          <div className="flex items-center gap-3">
            <span className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-muted">Empty</span>
            <NotificationBell items={[]} />
          </div>
          <div className="flex items-center gap-3">
            <span className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-muted">Loading</span>
            <NotificationBell loading items={[]} />
          </div>
          <div className="flex items-center gap-3">
            <span className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-muted">Error</span>
            <NotificationBell error="network unreachable" items={[]} />
          </div>
        </Row>
      </Section>

      <Section eyebrow="16 · SourceCard" title="SourceCard">
        <div className="grid grid-cols-2 gap-4">
          <SourceCard abbr="PG" name="prod-pg-main"   rows={1284910} syncedAt="2 min ago" status="live" />
          <SourceCard abbr="MY" name="hr.mysql"       rows={742}     syncedAt="3h ago"    status="stale" />
          <SourceCard abbr="MS" name="finance.mssql"  rows={58203}   syncedAt="Yesterday" status="idle" />
          <SourceCard abbr="PG" name="broken-source"  error="auth failed" />
          <SourceCard loading abbr="" name="" />
        </div>
      </Section>

      <Section eyebrow="17 · OutlineRail" title="OutlineRail">
        <div className="grid grid-cols-[1fr_260px] gap-6">
          <div className="font-display text-[17px] leading-[1.55] text-ink-2 space-y-3">
            <p>
              <em>An outline rail</em> anchors a long editorial document. It stays
              sticky on the right, reads as a table of contents, and highlights
              the reader’s current position.
            </p>
            <p>It pairs with reports and notebooks — not dashboards.</p>
          </div>
          <OutlineRail
            activeId={outlineId}
            onItemClick={setOutlineId}
            groups={[
              {
                eyebrow: 'Summary',
                items: [
                  { id: 'revenue',  label: 'Revenue'  },
                  { id: 'pipeline', label: 'Pipeline' },
                ],
              },
              {
                eyebrow: 'Detail',
                items: [
                  { id: 'segments', label: 'Segments' },
                  { id: 'churn',    label: 'Churn'    },
                  { id: 'appendix', label: 'Appendix' },
                ],
              },
            ]}
          />
        </div>
        <div className="grid grid-cols-3 gap-4">
          <OutlineRail groups={[]} loading />
          <OutlineRail groups={[]} empty />
          <OutlineRail groups={[]} error="couldn’t parse headings" />
        </div>
      </Section>

      <Section eyebrow="18 · NotebookCell" title="NotebookCell">
        <div className="bg-raised border border-line rounded-md p-6 pl-10">
          <NotebookCell
            index={0}
            cellType="ask"
            active={selectedCell === 0}
            onRerun={() => {}}
            onMenu={() => {}}
          >
            <div
              className="cursor-pointer font-display text-[20px] leading-[1.4] text-ink tracking-[-0.01em]"
              onClick={() => setSelectedCell(0)}
            >
              How did revenue trend by segment last quarter?
            </div>
            <AIResponseBlock
              className="mt-3"
              body={
                <>Enterprise grew <b>+14%</b>, Mid-market grew <b>+6%</b>, SMB held flat.</>
              }
              confidence={0.88}
              sources={['orders', 'segments']}
            />
          </NotebookCell>

          <NotebookCell
            index={1}
            cellType="sql"
            runtime="Postgres"
            active={selectedCell === 1}
            onRerun={() => {}}
          >
            <div
              className="cursor-pointer"
              onClick={() => setSelectedCell(1)}
            >
              <pre className="bg-[#0f1a22] text-[#e3e6ea] font-mono text-[12px] leading-[1.55] rounded-sm p-4 overflow-x-auto">
{`SELECT segment, SUM(amount) AS revenue
FROM orders
WHERE created_at >= date_trunc('quarter', now())
GROUP BY 1
ORDER BY 2 DESC;`}
              </pre>
            </div>
          </NotebookCell>

          <NotebookCell
            index={2}
            cellType="chart"
            active={selectedCell === 2}
            onRerun={() => {}}
          >
            <div onClick={() => setSelectedCell(2)} className="cursor-pointer">
              <ChartCard title="Segment revenue" subtitle="Quarterly" height={220}>
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={BAR_SAMPLE}>
                    <CartesianGrid {...CHART_GRID_PROPS} vertical={false} />
                    <XAxis dataKey="segment" {...CHART_AXIS_PROPS} />
                    <YAxis {...CHART_AXIS_PROPS} />
                    <Tooltip contentStyle={CHART_TOOLTIP_STYLE} cursor={{ fill: 'var(--softer)' }} />
                    <Bar dataKey="customers" fill={CHART_COLORS[0]} radius={[2, 2, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </ChartCard>
            </div>
          </NotebookCell>

          <NotebookCell
            index={3}
            cellType="kpi"
            active={selectedCell === 3}
          >
            <div onClick={() => setSelectedCell(3)} className="cursor-pointer grid grid-cols-3 gap-4">
              <KPITile label="Revenue"   value="€1.24M" delta={8.2}  />
              <KPITile label="Accounts"  value="1,284"  delta={-2.1} />
              <KPITile label="Churn"     value="1.4%"   delta={-0.2} />
            </div>
          </NotebookCell>

          <NotebookCell
            index={4}
            cellType="md"
            active={selectedCell === 4}
          >
            <div
              onClick={() => setSelectedCell(4)}
              className="cursor-pointer font-display text-[17px] leading-[1.55] text-ink-2"
            >
              <em>Note:</em> the mid-market expansion is driven by two recent renewals.
              The long-term trend is more muted.
            </div>
          </NotebookCell>

          <AddCellMenu onAdd={() => {}} />
        </div>
      </Section>
    </>
  );
}

function Section({ title, eyebrow, children }: { title: string; eyebrow: string; children: React.ReactNode }) {
  return (
    <section className="mb-12">
      <div className="font-mono text-[10.5px] uppercase tracking-[0.1em] text-muted mb-1">{eyebrow}</div>
      <h2 className="font-display font-medium text-[28px] leading-[1.15] tracking-[-0.02em] text-ink mb-5">
        {title}
      </h2>
      <div className="space-y-5">{children}</div>
    </section>
  );
}

function Row({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-wrap items-start gap-3">{children}</div>;
}

export default function DevUIPage() {
  const [tab, setTab] = useState('overview');
  const [modalOpen, setModalOpen] = useState(false);
  const [toasts, setToasts] = useState<Array<{ id: number; variant: 'success' | 'error' | 'info'; title: string }>>([]);

  const fire = (variant: 'success' | 'error' | 'info') => {
    const id = Date.now();
    const title =
      variant === 'success' ? 'Saved successfully'
      : variant === 'error' ? 'Something went wrong'
      : 'Job started';
    setToasts((t) => [...t, { id, variant, title }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3500);
  };

  return (
    <main className="min-h-screen bg-bg text-ink">
      <div className="max-w-[980px] mx-auto px-6 py-12">
        <header className="mb-12">
          <div className="font-mono text-[10.5px] uppercase tracking-[0.1em] text-muted mb-2">
            Observatory · /dev/ui
          </div>
          <h1 className="font-display font-medium text-[52px] leading-[1.05] tracking-[-0.03em] text-ink">
            Primitive components
          </h1>
          <p className="mt-3 text-[14.5px] text-ink-2 max-w-[620px]">
            Contact sheet for Phase 1 primitives. Every variant and size renders here.
          </p>
        </header>

        <Section eyebrow="01 · Button" title="Button">
          <div>
            <div className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-muted-2 mb-2">Variants</div>
            <Row>
              <Button variant="primary">Primary</Button>
              <Button variant="secondary">Secondary</Button>
              <Button variant="ghost">Ghost</Button>
              <Button variant="danger">Danger</Button>
            </Row>
          </div>
          <div>
            <div className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-muted-2 mb-2">Sizes</div>
            <Row>
              <Button size="sm">Small</Button>
              <Button size="md">Medium</Button>
              <Button size="lg">Large</Button>
            </Row>
          </div>
          <div>
            <div className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-muted-2 mb-2">States</div>
            <Row>
              <Button>Default</Button>
              <Button disabled>Disabled</Button>
              <Button loading>Loading</Button>
              <Button variant="secondary" disabled>Disabled</Button>
            </Row>
          </div>
        </Section>

        <Section eyebrow="02 · Input" title="Input">
          <div className="grid grid-cols-2 gap-5 max-w-[620px]">
            <Input label="Email" placeholder="you@company.com" />
            <Input label="Password" type="password" placeholder="••••••••" />
            <Input label="Search" type="search" placeholder="Find tables" hint="Press ⏎ to search" />
            <Input label="Invalid" defaultValue="not-an-email" error="Enter a valid email" />
            <Input label="Disabled" defaultValue="readonly@co" disabled />
            <Input label="With hint" placeholder="slug" hint="Lowercase only, no spaces" />
          </div>
        </Section>

        <Section eyebrow="03 · Select" title="Select">
          <div className="grid grid-cols-2 gap-5 max-w-[620px]">
            <Select label="Data source" defaultValue="postgres">
              <option value="postgres">PostgreSQL</option>
              <option value="mysql">MySQL</option>
              <option value="mssql">SQL Server</option>
              <option value="sqlite">SQLite</option>
            </Select>
            <Select label="Role" disabled defaultValue="viewer">
              <option value="viewer">Viewer</option>
            </Select>
            <Select label="Error state" error="Pick one">
              <option value="">Choose…</option>
              <option>A</option>
              <option>B</option>
            </Select>
          </div>
        </Section>

        <Section eyebrow="04 · Badge" title="Badge">
          <Row>
            <Badge variant="ai">AI Draft</Badge>
            <Badge variant="ocean">Ocean</Badge>
            <Badge variant="ok">OK</Badge>
            <Badge variant="warn">Warn</Badge>
            <Badge variant="err">Error</Badge>
            <Badge variant="neu">Neutral</Badge>
          </Row>
          <div>
            <div className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-muted-2 mb-2">With status dot</div>
            <Row>
              <Badge variant="ok" dot>Live</Badge>
              <Badge variant="warn" dot>Stale</Badge>
              <Badge variant="err" dot>Failed</Badge>
              <Badge variant="neu" dot>Idle</Badge>
            </Row>
          </div>
        </Section>

        <Section eyebrow="05 · Card" title="Card">
          <div className="grid grid-cols-3 gap-4">
            <Card variant="default">
              <div className="font-mono text-[10.5px] uppercase tracking-[0.1em] text-muted mb-2">Default</div>
              <div className="font-display text-[20px] text-ink">Bordered with shadow-1</div>
            </Card>
            <Card variant="raised">
              <div className="font-mono text-[10.5px] uppercase tracking-[0.1em] text-muted mb-2">Raised</div>
              <div className="font-display text-[20px] text-ink">No border, shadow-2</div>
            </Card>
            <Card variant="outlined">
              <div className="font-mono text-[10.5px] uppercase tracking-[0.1em] text-muted mb-2">Outlined</div>
              <div className="font-display text-[20px] text-ink">Border only, no shadow</div>
            </Card>
          </div>
          <Card padded={false} className="max-w-[520px]">
            <CardHeader>
              <div className="font-mono text-[10.5px] uppercase tracking-[0.1em] text-muted">Composed</div>
              <div className="font-display text-[20px] text-ink mt-1">With header, body, footer</div>
            </CardHeader>
            <CardBody>
              <p className="text-[14px] text-ink-2">
                A composed card using <code className="font-mono text-[12px]">CardHeader</code>,{' '}
                <code className="font-mono text-[12px]">CardBody</code>, and{' '}
                <code className="font-mono text-[12px]">CardFooter</code>.
              </p>
            </CardBody>
            <CardFooter>
              <div className="flex gap-2 justify-end w-full">
                <Button variant="ghost" size="sm">Cancel</Button>
                <Button variant="primary" size="sm">Confirm</Button>
              </div>
            </CardFooter>
          </Card>
        </Section>

        <Section eyebrow="06 · Table" title="Table">
          <Card padded={false}>
            <Table>
              <THead>
                <tr>
                  <Th>Source</Th>
                  <Th>Table</Th>
                  <Th numeric>Rows</Th>
                  <Th numeric>Synced</Th>
                </tr>
              </THead>
              <TBody>
                <Tr>
                  <Td>PostgreSQL</Td>
                  <Td>orders</Td>
                  <Td numeric>1,284,910</Td>
                  <Td numeric>02:14</Td>
                </Tr>
                <Tr>
                  <Td>PostgreSQL</Td>
                  <Td>customers</Td>
                  <Td numeric>58,203</Td>
                  <Td numeric>02:14</Td>
                </Tr>
                <Tr>
                  <Td>MySQL</Td>
                  <Td>hr.employees</Td>
                  <Td numeric>742</Td>
                  <Td numeric>06:00</Td>
                </Tr>
              </TBody>
            </Table>
          </Card>
        </Section>

        <Section eyebrow="07 · Tabs" title="Tabs">
          <Tabs
            value={tab}
            onChange={setTab}
            items={[
              { value: 'overview', label: 'Overview' },
              { value: 'rules',    label: 'Rules' },
              { value: 'history',  label: 'History' },
              { value: 'archived', label: 'Archived', disabled: true },
            ]}
          />
          <div className="text-[13.5px] text-ink-3">Active tab: <span className="font-mono">{tab}</span></div>
        </Section>

        <Section eyebrow="08 · Toast" title="Toast">
          <Row>
            <Button variant="secondary" onClick={() => fire('success')}>Fire success</Button>
            <Button variant="secondary" onClick={() => fire('error')}>Fire error</Button>
            <Button variant="secondary" onClick={() => fire('info')}>Fire info</Button>
          </Row>
          <div className="max-w-[440px] space-y-2">
            <Toast variant="success" title="Saved successfully" body="Your changes are live." />
            <Toast variant="error" title="Connection failed" body="Check credentials and retry." />
            <Toast variant="info" title="Job started" body="Ingestion queued." />
          </div>
        </Section>

        <Section eyebrow="09 · Modal" title="Modal">
          <Row>
            <Button onClick={() => setModalOpen(true)}>Open modal</Button>
          </Row>
          <Modal
            open={modalOpen}
            onClose={() => setModalOpen(false)}
            eyebrow="Confirm"
            title="Delete connection"
            footer={
              <>
                <Button variant="ghost" size="sm" onClick={() => setModalOpen(false)}>Cancel</Button>
                <Button variant="danger" size="sm" onClick={() => setModalOpen(false)}>Delete</Button>
              </>
            }
          >
            <p className="font-display text-[17px] leading-[1.55] text-ink">
              This will remove the data source and all of its cached metadata. You can re-add it later.
            </p>
          </Modal>
        </Section>

        <Section eyebrow="10 · Skeleton" title="Skeleton">
          <div className="grid grid-cols-2 gap-6 max-w-[620px]">
            <Card>
              <div className="font-mono text-[10.5px] uppercase tracking-[0.1em] text-muted mb-2">Text block</div>
              <SkeletonText lines={3} />
            </Card>
            <Card>
              <div className="font-mono text-[10.5px] uppercase tracking-[0.1em] text-muted mb-2">Chart</div>
              <Skeleton height={160} />
            </Card>
          </div>
        </Section>

        <div className="mb-8 mt-16 border-t border-line pt-8">
          <div className="font-mono text-[10.5px] uppercase tracking-[0.1em] text-muted mb-2">
            Phase 2
          </div>
          <h2 className="font-display font-medium text-[38px] leading-[1.1] tracking-[-0.025em] text-ink">
            Composite components
          </h2>
        </div>

        <CompositeSections />
      </div>

      <ToastViewport>
        {toasts.map((t) => (
          <Toast
            key={t.id}
            variant={t.variant}
            title={t.title}
            body="Toast will auto-dismiss in 3.5s."
            onClose={() => setToasts((xs) => xs.filter((x) => x.id !== t.id))}
          />
        ))}
      </ToastViewport>
    </main>
  );
}
