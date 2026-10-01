'use client';

import { Suspense } from 'react';
import { StaffWorkspace } from '@/components/role-views';

export default function StaffPage() {
  return (
    <Suspense fallback={<p className="empty-state">Loading tasks…</p>}>
      <StaffWorkspace />
    </Suspense>
  );
}
