import LegalPage from '../LegalPage';
import { TERMS } from '@/lib/legal/terms';

export const metadata = { title: 'Terms of Service — Clarion' };

export default function TermsPage() {
  return <LegalPage body={TERMS} current="/legal/terms" />;
}
