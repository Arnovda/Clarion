import LegalPage from '../LegalPage';
import { SUBPROCESSORS } from '@/lib/legal/subprocessors';

export const metadata = { title: 'Subprocessors — Clarion' };

export default function SubprocessorsPage() {
  return <LegalPage body={SUBPROCESSORS} current="/legal/subprocessors" />;
}
