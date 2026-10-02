'use client';

import { useRef, useState, type FormEvent } from 'react';
import { apiErrorMessage, apiFetch } from '@/lib/api-client';
import { ExhibitorShell } from './shell';
import { useStallProfile } from './data';
import { progressText } from './format';

const services = [
  { id: 'ELECTRICAL', label: 'Electrical' },
  { id: 'HOUSE_HELP', label: 'House Help' },
  { id: 'HALL_MANAGER', label: 'Hall Manager' },
] as const;

export function ExhibitorRequestForm() {
  const { profile } = useStallProfile();
  const scope = profile?.scopes.find((item) => item.stall);
  const place = scope?.stall
    ? [scope.hall?.name, 'Zone ' + scope.stall.zone.code, 'Stall ' + scope.stall.stallCode].filter(Boolean).join(' / ')
    : 'Your stall';
  const [category, setCategory] = useState('');
  const [subtype, setSubtype] = useState('');
  const [description, setDescription] = useState('');
  const [urgent, setUrgent] = useState(false);
  const [fieldError, setFieldError] = useState('');
  const [submitError, setSubmitError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [created, setCreated] = useState<{ id: string; publicNo: string; status: string; progressLabel?: string } | null>(null);
  const idempotencyKey = useRef('');
  const submittingRef = useRef(false);
  if (!idempotencyKey.current) idempotencyKey.current = crypto.randomUUID();

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submittingRef.current) return;
    setFieldError('');
    setSubmitError('');
    if (!category) {
      setFieldError('Choose a service.');
      return;
    }
    if (category === 'ELECTRICAL' && !subtype) {
      setFieldError('Choose the electrical issue type.');
      return;
    }
    if (description.trim().length < 3) {
      setFieldError('Describe the issue in at least a few words.');
      return;
    }
    submittingRef.current = true;
    setSubmitting(true);
    try {
      const response = await apiFetch('/api/tickets', {
        method: 'POST',
        credentials: 'include',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          category,
          subtype: category === 'ELECTRICAL' ? subtype : 'General',
          description: description.trim(),
          priority: urgent ? 'URGENT' : 'NORMAL',
          idempotencyKey: idempotencyKey.current,
        }),
      });
      if (!response.ok) throw new Error(await apiErrorMessage(response, 'The request could not be sent'));
      const result = await response.json() as { id?: string; publicNo?: string; status?: string; progressLabel?: string };
      if (!result.id || !result.publicNo || !result.status) throw new Error('The request could not be confirmed');
      idempotencyKey.current = '';
      setCreated({ id: result.id, publicNo: result.publicNo, status: result.status, progressLabel: result.progressLabel });
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'The request could not be sent';
      const uncertain = cause instanceof TypeError || /failed to fetch|network/i.test(message);
      setSubmitError(uncertain
        ? 'We could not confirm whether this request was saved. Your details are still here. Try again to send the same request.'
        : message);
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }
  }

  if (created) {
    return (
      <ExhibitorShell>
        <section className="exhibitor-success" role="status">
          <h2>Request received.</h2>
          <p className="exhibitor-number">{created.publicNo}</p>
          <p>{progressText(created)}</p>
          <a className="primary" href={'/stall/ticket/' + created.id}>View request</a>
        </section>
      </ExhibitorShell>
    );
  }

  return (
    <ExhibitorShell>
      <form className="exhibitor-form" onSubmit={(event) => void submit(event)}>
        <h2>Request help</h2>
        <p className="exhibitor-place">Your stall · {place}</p>
        <fieldset className="service-grid">
          <legend>Service</legend>
          {services.map((service) => (
            <label key={service.id}>
              <input type="radio" name="service" value={service.id} checked={category === service.id} onChange={() => { setCategory(service.id); if (service.id !== 'ELECTRICAL') setSubtype(''); }} />
              {service.label}
            </label>
          ))}
        </fieldset>
        {category === 'ELECTRICAL' ? (
          <fieldset className="service-grid">
            <legend>Issue type</legend>
            {['NCP', 'Lighting'].map((option) => (
              <label key={option}>
                <input type="radio" name="issue-type" value={option} checked={subtype === option} onChange={() => setSubtype(option)} />
                {option}
              </label>
            ))}
          </fieldset>
        ) : null}
        <label className="field">What needs attention?
          <textarea value={description} onChange={(event) => setDescription(event.target.value)} required minLength={3} maxLength={500} placeholder="For example, a display light is out or the aisle needs clearing" />
        </label>
        <label className="urgent"><input type="checkbox" checked={urgent} onChange={(event) => setUrgent(event.target.checked)} /> Mark as urgent</label>
        {fieldError ? <p className="form-error" role="alert">{fieldError}</p> : null}
        {submitError ? <p className="form-error" role="alert">{submitError}</p> : null}
        <button className="primary full-width exhibitor-submit" type="submit" disabled={submitting}>{submitting ? 'Sending…' : 'Request help'}</button>
      </form>
    </ExhibitorShell>
  );
}
