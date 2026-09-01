import LegalPage from '../LegalPage';
import { DPA } from '@/lib/legal/dpa';

export const metadata = { title: 'Data Processing Agreement — Clarion' };

export default function DpaPage() {
  return <LegalPage body={DPA} current="/legal/dpa" />;
}
