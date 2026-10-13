import { Suspense } from 'react';
import { SuperAdminWorkspace } from '@/components/role-views';

export default function SuperAdminPage() {
  return (
    <Suspense fallback={<p className="empty-state">Loading the organization workspace…</p>}>
      <SuperAdminWorkspace />
    </Suspense>
  );
}
