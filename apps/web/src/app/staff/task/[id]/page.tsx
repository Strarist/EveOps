'use client';

import { useParams } from 'next/navigation';
import { StaffWorkspace } from '@/components/role-views';

export default function StaffTaskPage() {
  const params = useParams<{ id: string }>();
  return <StaffWorkspace focusId={params.id} />;
}
