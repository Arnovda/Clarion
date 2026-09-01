import LegalPage from '../LegalPage';
import { PRIVACY } from '@/lib/legal/privacy';

export const metadata = { title: 'Privacy Policy — Clarion' };

export default function PrivacyPage() {
  return <LegalPage body={PRIVACY} current="/legal/privacy" />;
}
