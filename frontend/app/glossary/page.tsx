import { redirect } from 'next/navigation';

/**
 * The glossary is one section of the Definitions pane now — terms, metrics
 * and verified answers in one place, documented once and read by the AI.
 * This route redirects so old links keep working: one door, not two.
 */
export default function GlossaryPage() {
  redirect('/definitions');
}
