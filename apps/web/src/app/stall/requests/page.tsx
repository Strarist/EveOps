import { Suspense } from 'react';
import { ExhibitorRequests } from '@/components/exhibitor/requests';

export default function StallRequestsPage() {
  return (
    <Suspense fallback={<p className="empty-state">Loading your requests…</p>}>
      <ExhibitorRequests />
    </Suspense>
  );
}
