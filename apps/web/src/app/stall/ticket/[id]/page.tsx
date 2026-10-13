'use client';

import { useParams } from 'next/navigation';
import { ExhibitorDetail } from '@/components/exhibitor/detail';

export default function StallTicketPage() {
  const params = useParams<{ id: string }>();
  return <ExhibitorDetail ticketId={params.id} />;
}
