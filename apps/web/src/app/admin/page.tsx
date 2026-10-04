import { Suspense } from 'react';
import { ManagementWorkspace } from '@/components/role-views';

export default function AdminPage() {
  return (
    <Suspense fallback={<p className="empty-state">Loading the event workspace…</p>}>
      <ManagementWorkspace role="ADMIN" />
    </Suspense>
  );
}
