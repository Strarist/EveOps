'use client';

import { Suspense } from 'react';
import { useParams } from 'next/navigation';
import { StaffWorkspace } from '@/components/role-views';

export default function StaffTaskPage() {
  const params = useParams<{ id: string }>();
  return (
    <Suspense fallback={<p className="empty-state">Loading task…</p>}>
      <StaffWorkspace focusId={params.id} />
    </Suspense>
  );
}
