'use client';

import { useParams } from 'next/navigation';
import { StallWorkspace } from '@/components/role-views';

export default function StallTicketPage() {
  const params = useParams<{ id: string }>();
  return <StallWorkspace focusId={params.id} />;
}
