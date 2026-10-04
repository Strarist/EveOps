import { Suspense } from 'react';
import { ManagementWorkspace } from '@/components/role-views';

export default function HallManagerPage() {
  return (
    <Suspense fallback={<p className="empty-state">Loading hall operations…</p>}>
      <ManagementWorkspace role="HALL_MANAGER" />
    </Suspense>
  );
}
